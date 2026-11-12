/**
 * Run worker — Shell 命令执行
 * 统一走 PermissionGuard 判定 + 用户授权，超时/取消都会杀掉子进程。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fail, num, ok, str, truncateMiddle } from './types';
import type { ToolDefinition, ToolResult } from './types';

const MAX_STREAM = 512 * 1024;
const RETURN_LIMIT = 12_000;

export interface ProcResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 启动子进程并收集输出；超过上限只保留头部，防止内存爆掉 */
export function runProcess(opts: RunProcessOptions): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, aborted, spawnError });
    };

    /** 终止整棵进程树：Windows 下 child.kill 常杀不掉 shell 及其孙进程，用 taskkill 兜底 */
    const killTree = () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            /* taskkill 不可用时静默降级，不能抛 */
          });
        } catch {
          /* 静默降级，不能抛 */
        }
      }
    };

    /** kill 后 close 可能永远不来，2 秒后强制结束 Promise，防止整个 run 永久挂起 */
    const terminate = () => {
      killTree();
      if (!forceTimer) forceTimer = setTimeout(() => finish(null), 2000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1000, opts.timeoutMs));

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STREAM) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STREAM) stderr += chunk;
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/** 根据设置选择 shell 并组装参数 */
export function shellInvocation(shell: 'powershell' | 'cmd' | 'bash', command: string): { command: string; args: string[] } {
  if (shell === 'cmd') return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  if (shell === 'bash') return { command: 'bash', args: ['-lc', command] };
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] };
}

function formatResult(res: ProcResult, cwd: string, command: string): ToolResult {
  const parts: string[] = [`命令：${command}`, `工作目录：${cwd}`];
  if (res.spawnError) return fail(`无法启动 shell：${res.spawnError}`);
  if (res.aborted) parts.push('状态：被用户取消');
  else if (res.timedOut) parts.push('状态：超时被终止');
  else parts.push(`退出码：${res.exitCode ?? '未知'}`);
  if (res.stdout.trim()) parts.push(`\n--- stdout ---\n${truncateMiddle(res.stdout.trim(), RETURN_LIMIT)}`);
  if (res.stderr.trim()) parts.push(`\n--- stderr ---\n${truncateMiddle(res.stderr.trim(), RETURN_LIMIT / 2)}`);
  if (!res.stdout.trim() && !res.stderr.trim()) parts.push('（没有输出）');

  const success = !res.spawnError && !res.timedOut && !res.aborted && res.exitCode === 0;
  const content = parts.join('\n');
  if (success) return ok(content);
  return {
    ok: false,
    content: `${content}\n\n命令执行未成功。${res.timedOut ? '可以拆小步骤或提高超时时间。' : ''}`,
    error: res.timedOut ? '执行超时' : res.aborted ? '已取消' : `退出码 ${res.exitCode}`,
  };
}

export const shellTools: ToolDefinition[] = [
  {
    name: 'shell.exec',
    description:
      '执行系统命令（PowerShell/cmd/bash）。装依赖、跑构建、查进程端口、查看目录都可用。危险命令会先向用户申请授权。',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令，如 "npm run build" 或 "Get-Process node"' },
        cwd: { type: 'string', description: '工作目录，默认使用当前工作目录' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认取设置里的命令超时' },
      },
      required: ['command'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const settings = rt.settings();
      const command = str(args, 'command').trim();
      if (!command) return fail('命令不能为空。');

      const verdict = rt.permissions.inspectCommand(command);
      if (!verdict.allowed) return fail(`命令被安全策略拒绝：${verdict.reason}`);

      const mode = settings.agent.approvalMode;
      const needAsk = mode === 'always' || (mode === 'safe-only' && verdict.requiresApproval);
      if (needAsk) {
        const approved = await rt.askApproval({
          toolName: 'shell.exec',
          command,
          risk: verdict.risk,
          reason: verdict.reason || '该命令可能修改系统状态',
        });
        if (!approved) return fail('用户拒绝了该命令的执行。');
      }

      const cwd = str(args, 'cwd') ? path.resolve(rt.workspace(), str(args, 'cwd')) : rt.workspace();
      const timeoutMs = Math.min(600_000, Math.max(1000, Math.round(num(args, 'timeoutMs', settings.agent.commandTimeout))));
      const inv = shellInvocation(settings.agent.shell, command);
      rt.log.info('[shell.exec]', command, 'cwd=', cwd);
      const res = await runProcess({ command: inv.command, args: inv.args, cwd, timeoutMs, signal: tc.signal });
      return formatResult(res, cwd, command);
    },
  },
];

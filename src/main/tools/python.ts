/**
 * Run worker — Python 执行
 * 把代码写成临时 .py 落到工作目录再执行，便于报错定位与产物保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './shell';
import { fail, num, ok, str, truncateMiddle } from './types';
import type { ToolDefinition, ToolResult } from './types';

const RETURN_LIMIT = 12_000;

export const pythonTools: ToolDefinition[] = [
  {
    name: 'python.exec',
    description:
      '执行 Python 代码或脚本文件。数据处理、批量改文件、画图表、调用 Python 库时使用。pandas/matplotlib 需用户环境已安装。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Python 代码（与 path 二选一）' },
        path: { type: 'string', description: '已存在的 .py 文件路径（与 code 二选一）' },
        cwd: { type: 'string', description: '工作目录，默认使用当前工作目录' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认取设置里的命令超时' },
      },
      required: [],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const settings = rt.settings();
      const code = str(args, 'code');
      const fileArg = str(args, 'path');
      if (!code.trim() && !fileArg.trim()) return fail('需要提供 code 或 path。');

      const cwd = str(args, 'cwd') ? path.resolve(rt.workspace(), str(args, 'cwd')) : rt.workspace();
      let scriptPath: string;
      let temp = false;

      if (fileArg.trim()) {
        scriptPath = path.isAbsolute(fileArg) ? fileArg : path.resolve(cwd, fileArg);
        if (!fs.existsSync(scriptPath)) return fail(`脚本不存在：${scriptPath}`);
      } else {
        const tmpDir = path.join(cwd, '.runworker-tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        scriptPath = path.join(tmpDir, `run_${Date.now().toString(36)}.py`);
        fs.writeFileSync(scriptPath, code, 'utf8');
        temp = true;
      }

      const python = settings.agent.pythonPath.trim() || 'python';
      const timeoutMs = Math.min(600_000, Math.max(1000, Math.round(num(args, 'timeoutMs', settings.agent.commandTimeout))));
      rt.log.info('[python.exec]', python, scriptPath);
      const res = await runProcess({ command: python, args: [scriptPath], cwd, timeoutMs, signal: tc.signal });

      const parts: string[] = [`脚本：${scriptPath}`, `解释器：${python}`, `工作目录：${cwd}`];
      if (res.spawnError) {
        return fail(
          `无法启动 Python（${python}）：${res.spawnError}。请在设置里填写正确的 Python 路径，或确认已加入 PATH。`,
        );
      }
      if (res.aborted) parts.push('状态：已取消');
      else if (res.timedOut) parts.push('状态：超时被终止');
      else parts.push(`退出码：${res.exitCode ?? '未知'}`);
      if (res.stdout.trim()) parts.push(`\n--- stdout ---\n${truncateMiddle(res.stdout.trim(), RETURN_LIMIT)}`);
      if (res.stderr.trim()) parts.push(`\n--- stderr ---\n${truncateMiddle(res.stderr.trim(), RETURN_LIMIT / 2)}`);
      if (!res.stdout.trim() && !res.stderr.trim()) parts.push('（没有输出）');
      if (temp) parts.push(`\n（临时脚本已保留在 ${scriptPath}）`);

      const success = !res.timedOut && !res.aborted && res.exitCode === 0;
      if (success) return ok(parts.join('\n'));
      return {
        ok: false,
        content: `${parts.join('\n')}\n\nPython 执行失败，请根据 stderr 修正后重试。`,
        error: res.timedOut ? '执行超时' : res.aborted ? '已取消' : `退出码 ${res.exitCode}`,
      };
    },
  },
];

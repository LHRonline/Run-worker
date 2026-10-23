/**
 * MCP 连接器（McpManager）
 *
 * 支持两种传输：
 *  - stdio：spawn 子进程，按行（\n）收发 JSON-RPC 2.0 消息；
 *  - http ：Streamable HTTP / SSE，POST JSON-RPC，解析 `text/event-stream` 帧。
 * 握手流程：initialize → notifications/initialized → tools/list。
 * 单个服务器失败只把该服务器置为 error，绝不阻塞其它服务器或应用启动。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EVT } from '../../shared/ipc';
import type { McpManager, PlatformDeps } from '../../shared/platform';
import type {
  McpCallResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
} from '../../shared/types';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_NAME = 'run-worker';
const CLIENT_VERSION = '0.0.1';
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 2000;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type SessionState = 'stopped' | 'starting' | 'ready' | 'error';

interface Session {
  cfg: McpServerConfig;
  state: SessionState;
  message?: string;
  tools: McpToolInfo[];
  proc?: ChildProcessWithoutNullStreams;
  buffer: string;
  stderr: string;
  pending: Map<number, PendingRequest>;
  nextId: number;
  /** Streamable HTTP 会话标识（服务端可能返回） */
  sessionId?: string;
  /** 主动关闭标记，用于区分「用户关闭」与「进程崩溃」 */
  closing: boolean;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

function getFetch(): FetchLike | null {
  const fn = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  return typeof fn === 'function' ? fn : null;
}

/** 解析 SSE 帧，收集其中的 JSON-RPC 消息 */
function parseSse(text: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  const frames = text.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;

    // 多个 data 行可能是同一段 JSON 的换行拼接，也可能各自是完整 JSON
    const joined = dataLines.join('\n').trim();
    if (!joined || joined === '[DONE]') continue;
    try {
      out.push(JSON.parse(joined) as JsonRpcResponse);
      continue;
    } catch {
      /* 继续尝试逐行解析 */
    }
    for (const line of dataLines) {
      const single = line.trim();
      if (!single || single === '[DONE]') continue;
      try {
        out.push(JSON.parse(single) as JsonRpcResponse);
      } catch {
        /* 忽略无法解析的帧 */
      }
    }
  }
  return out;
}

/** 选择 id 匹配的响应，否则取最后一个带 result 的消息 */
function pickResponse(messages: JsonRpcResponse[], id: number): JsonRpcResponse | null {
  const matched = messages.find((m) => String(m.id) === String(id));
  if (matched) return matched;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].result !== undefined || messages[i].error) return messages[i];
  }
  return null;
}

export function createMcpManager(deps: PlatformDeps): McpManager {
  const sessions = new Map<string, Session>();

  function createSession(cfg: McpServerConfig): Session {
    return {
      cfg,
      state: 'stopped',
      tools: [],
      buffer: '',
      stderr: '',
      pending: new Map(),
      nextId: 0,
      closing: false,
    };
  }

  function statusOf(session: Session | undefined, cfg: McpServerConfig): McpServerStatus {
    if (!session) {
      return { id: cfg.id, name: cfg.name, state: 'stopped', toolCount: 0, message: '未连接' };
    }
    return {
      id: cfg.id,
      name: session.cfg.name || cfg.name,
      state: session.state,
      toolCount: session.tools.length,
      message: session.message,
    };
  }

  function statuses(): McpServerStatus[] {
    const cfgs = deps.settings().mcpServers ?? [];
    return cfgs.map((cfg) => statusOf(sessions.get(cfg.id), cfg));
  }

  function emitChanged(): void {
    deps.emit(EVT.mcpChanged, statuses());
  }

  function allTools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const session of sessions.values()) {
      if (session.state !== 'ready') continue;
      out.push(...session.tools);
    }
    return out;
  }

  /** 回收一个会话：拒绝挂起请求、杀掉子进程 */
  function teardown(session: Session, reason?: string): void {
    session.closing = true;
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason ?? `连接已关闭（${pending.method}）`));
      session.pending.delete(id);
    }
    if (session.proc) {
      try {
        session.proc.stdin.end();
      } catch {
        /* 忽略 */
      }
      try {
        session.proc.kill();
      } catch {
        /* 忽略 */
      }
      session.proc = undefined;
    }
    session.tools = [];
    session.buffer = '';
    session.sessionId = undefined;
  }

  async function dispatchStdio(session: Session, message: JsonRpcResponse): Promise<void> {
    if (message.id === undefined || message.id === null) return; // 服务端通知，忽略
    const id = Number(message.id);
    const pending = session.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP 调用失败（${pending.method}）`));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  function attachStdio(session: Session): void {
    const cfg = session.cfg;
    if (!cfg.command) throw new Error('stdio 服务器缺少 command 配置');

    const proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    session.proc = proc;
    session.buffer = '';
    session.stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      session.buffer += chunk;
      let index = session.buffer.indexOf('\n');
      while (index >= 0) {
        const line = session.buffer.slice(0, index).trim();
        session.buffer = session.buffer.slice(index + 1);
        index = session.buffer.indexOf('\n');
        if (!line) continue;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // 非 JSON 输出（日志等）忽略
        }
        void dispatchStdio(session, parsed);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL);
    });

    proc.on('error', (err: Error) => {
      session.state = 'error';
      session.message = `启动失败：${err.message}`;
      teardown(session, `进程启动失败：${err.message}`);
      session.state = 'error';
      emitChanged();
    });

    proc.on('exit', (code, signal) => {
      if (session.closing) {
        session.state = 'stopped';
        session.message = '已断开';
        emitChanged();
        return;
      }
      const tail = session.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      session.state = 'error';
      session.message = `进程已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）${tail ? `：${tail}` : ''}`;
      teardown(session, session.message);
      session.state = 'error';
      emitChanged();
    });
  }

  async function httpRequest(
    session: Session,
    method: string,
    params: unknown,
    isNotification: boolean,
  ): Promise<JsonRpcResponse | null> {
    const doFetch = getFetch();
    if (!doFetch) throw new Error('当前运行环境不支持 fetch，无法使用 HTTP 传输');
    const cfg = session.cfg;
    if (!cfg.url) throw new Error('HTTP 服务器缺少 url 配置');

    const id = isNotification ? undefined : (session.nextId += 1);
    const body = JSON.stringify(
      isNotification
        ? { jsonrpc: '2.0', method, params }
        : { jsonrpc: '2.0', id, method, params },
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(cfg.headers ?? {}),
    };
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await doFetch(cfg.url, { method: 'POST', headers, body, signal: controller.signal });
      const sessionId = res.headers.get('mcp-session-id');
      if (sessionId) session.sessionId = sessionId;

      const text = await res.text();
      const contentType = res.headers.get('content-type') ?? '';
      const messages = contentType.includes('text/event-stream')
        ? parseSse(text)
        : (() => {
            try {
              const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
              return Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              return text.includes('data:') ? parseSse(text) : [];
            }
          })();

      if (!res.ok && messages.length === 0) {
        throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
      }
      if (isNotification) return null;

      const picked = pickResponse(messages, id as number);
      if (!picked) throw new Error(`服务端未返回有效响应（${method}）`);
      if (picked.error) throw new Error(picked.error.message || `MCP 调用失败（${method}）`);
      return picked;
    } finally {
      clearTimeout(timer);
    }
  }

  /** JSON-RPC 请求（带 30s 超时） */
  function request(session: Session, method: string, params: unknown): Promise<unknown> {
    if (session.state === 'error' && session.cfg.transport === 'stdio' && !session.proc) {
      return Promise.reject(new Error(session.message || '连接已断开'));
    }

    if (session.cfg.transport === 'http') {
      return httpRequest(session, method, params, false).then((r) => (r?.result ?? null));
    }

    return new Promise<unknown>((resolve, reject) => {
      const proc = session.proc;
      if (!proc || !proc.stdin.writable) {
        reject(new Error('stdio 进程不可用'));
        return;
      }

      const id = (session.nextId += 1);
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`请求超时：${method}（${REQUEST_TIMEOUT_MS / 1000}s）`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      session.pending.set(id, { resolve, reject, timer, method });

      try {
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** JSON-RPC 通知（无 id，不等待响应） */
  function notify(session: Session, method: string, params: unknown): Promise<void> {
    if (session.cfg.transport === 'http') {
      return httpRequest(session, method, params, true).then(() => undefined);
    }
    const proc = session.proc;
    if (!proc || !proc.stdin.writable) return Promise.resolve();
    try {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch (err) {
      deps.log.warn('[mcp] 发送通知失败', err);
    }
    return Promise.resolve();
  }

  async function fetchTools(session: Session): Promise<McpToolInfo[]> {
    const result = (await request(session, 'tools/list', {})) as
      | { tools?: { name?: string; description?: string; inputSchema?: unknown }[] }
      | null;
    const list = result?.tools ?? [];
    const out: McpToolInfo[] = [];
    for (const tool of list) {
      const name = String(tool?.name ?? '').trim();
      if (!name) continue;
      out.push({
        serverId: session.cfg.id,
        serverName: session.cfg.name,
        name,
        description: String(tool.description ?? ''),
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      });
    }
    return out;
  }

  /** 建立连接并握手 */
  async function connectSession(session: Session): Promise<void> {
    if (session.state === 'ready') return;
    if (session.state === 'starting') return;

    const cfg = session.cfg;
    session.state = 'starting';
    session.message = undefined;
    session.closing = false;
    emitChanged();

    try {
      if (cfg.transport === 'stdio') {
        attachStdio(session);
      } else if (!cfg.url) {
        throw new Error('HTTP 服务器缺少 url 配置');
      }

      await request(session, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });

      await notify(session, 'notifications/initialized', {});

      session.tools = await fetchTools(session);
      session.state = 'ready';
      session.message = undefined;
      deps.log.info(`[mcp] 「${cfg.name}」已连接，共 ${session.tools.length} 个工具`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      teardown(session, message);
      session.state = 'error';
      session.message = message || '连接失败';
      deps.log.warn(`[mcp] 「${cfg.name}」连接失败：${session.message}`);
    } finally {
      emitChanged();
    }
  }

  /** 与 settings.mcpServers 对齐会话表 */
  function syncSessions(): void {
    const cfgs = deps.settings().mcpServers ?? [];
    const ids = new Set(cfgs.map((c) => c.id));
    for (const [id, session] of sessions) {
      if (!ids.has(id)) {
        teardown(session, '服务器已删除');
        sessions.delete(id);
      }
    }
    for (const cfg of cfgs) {
      const exists = sessions.get(cfg.id);
      if (!exists) {
        sessions.set(cfg.id, createSession(cfg));
      } else {
        exists.cfg = cfg;
      }
    }
  }

  function persistServers(list: McpServerConfig[]): void {
    try {
      deps.saveSettings({ mcpServers: list });
    } catch (err) {
      deps.log.error('[mcp] 保存服务器配置失败', err);
    }
  }

  return {
    async init(): Promise<void> {
      syncSessions();
      const autoStart = (deps.settings().mcpServers ?? []).filter((c) => c.enabled && c.autoStart);

      // 逐个后台连接：任何单个失败都不影响其它服务器与应用启动
      for (const cfg of autoStart) {
        const session = sessions.get(cfg.id);
        if (!session) continue;
        void connectSession(session).catch((err) => {
          deps.log.warn(`[mcp] 「${cfg.name}」自动启动异常`, err);
        });
      }
      emitChanged();
    },

    async shutdown(): Promise<void> {
      for (const session of sessions.values()) {
        teardown(session, '应用正在退出');
        session.state = 'stopped';
      }
      sessions.clear();
    },

    statuses,

    tools(): McpToolInfo[] {
      return allTools();
    },

    async add(cfg: McpServerConfig): Promise<McpServerStatus[]> {
      const name = String(cfg?.name ?? '').trim();
      const id = String(cfg?.id ?? '').trim() || `mcp-${Date.now().toString(36)}`;
      const normalized: McpServerConfig = {
        ...cfg,
        id,
        name: name || id,
        transport: cfg.transport === 'http' ? 'http' : 'stdio',
        args: cfg.args ?? [],
        env: cfg.env ?? {},
        enabled: cfg.enabled !== false,
        autoStart: !!cfg.autoStart,
      };

      const list = [...(deps.settings().mcpServers ?? [])];
      const index = list.findIndex((c) => c.id === id);
      if (index >= 0) list[index] = normalized;
      else list.push(normalized);
      persistServers(list);
      syncSessions();

      if (normalized.enabled && normalized.autoStart) {
        const session = sessions.get(id);
        if (session) await connectSession(session);
      }
      emitChanged();
      return statuses();
    },

    async remove(id: string): Promise<McpServerStatus[]> {
      const session = sessions.get(id);
      if (session) {
        teardown(session, '服务器已删除');
        sessions.delete(id);
      }
      persistServers((deps.settings().mcpServers ?? []).filter((c) => c.id !== id));
      emitChanged();
      return statuses();
    },

    async toggle(id: string, enabled: boolean): Promise<McpServerStatus[]> {
      const list = (deps.settings().mcpServers ?? []).map((c) =>
        c.id === id ? { ...c, enabled: !!enabled } : c,
      );
      persistServers(list);
      syncSessions();

      const session = sessions.get(id);
      if (session) {
        if (enabled) {
          await connectSession(session);
        } else {
          teardown(session, '已禁用');
          session.state = 'stopped';
          session.message = '已禁用';
        }
      }
      emitChanged();
      return statuses();
    },

    async connect(id: string): Promise<McpServerStatus[]> {
      syncSessions();
      const session = sessions.get(id);
      if (session) {
        if (session.state === 'error' || session.state === 'stopped') {
          teardown(session, '重新连接');
          session.state = 'stopped';
        }
        await connectSession(session);
      }
      emitChanged();
      return statuses();
    },

    async call(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
      const session = sessions.get(serverId);
      if (!session) {
        return { ok: false, content: 'MCP 服务器不存在或已被移除', isError: true };
      }

      if (session.state !== 'ready') {
        await connectSession(session);
      }
      if (session.state !== 'ready') {
        return { ok: false, content: `MCP 服务器未连接：${session.message ?? '状态异常'}`, isError: true };
      }

      const toolName = String(tool ?? '').trim();
      if (!toolName) return { ok: false, content: '未指定工具名称', isError: true };

      try {
        const result = (await request(session, 'tools/call', {
          name: toolName,
          arguments: args ?? {},
        })) as { content?: unknown; isError?: boolean } | null;

        const parts: string[] = [];
        const content = result?.content;
        if (Array.isArray(content)) {
          for (const item of content as Record<string, unknown>[]) {
            const type = String(item?.type ?? '');
            if (type === 'text') {
              parts.push(String(item.text ?? ''));
            } else if (type === 'image') {
              parts.push(`[图片 ${String(item.mimeType ?? 'image')}]`);
            } else if (item && typeof item === 'object') {
              try {
                parts.push(JSON.stringify(item));
              } catch {
                parts.push('[无法序列化的内容]');
              }
            }
          }
        } else if (typeof content === 'string') {
          parts.push(content);
        } else if (result) {
          try {
            parts.push(JSON.stringify(result));
          } catch {
            parts.push('');
          }
        }

        const text = parts.filter(Boolean).join('\n').trim();
        const isError = !!result?.isError;
        return {
          ok: !isError,
          content: text || (isError ? '工具执行失败（无输出）' : '（无输出）'),
          isError: isError || undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, content: message || 'MCP 调用失败', isError: true };
      }
    },
  };
}

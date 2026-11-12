/**
 * Run worker — OpenAI 兼容大模型客户端
 * 只用 fetch + ReadableStream 解析 SSE，不引第三方 SDK；兼容 DeepSeek 的 reasoning_content。
 */
import type { ProviderConfig, ProviderTestResult } from '../../shared/types';
import { PROVIDER_PRESETS } from '../../shared/presets';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface LlmTarget {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  kind?: string;
  /** 服务商展示名，用于错误提示中标注渠道 */
  label?: string;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmTextPart {
  type: 'text';
  text: string;
}
export interface LlmImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type LlmContentPart = LlmTextPart | LlmImagePart;

export interface LlmToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: LlmRole;
  content: string | LlmContentPart[];
  name?: string;
  tool_calls?: LlmToolCallPayload[];
  tool_call_id?: string;
}

export interface LlmToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface StreamChatOptions {
  target: LlmTarget;
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: RawUsage) => void;
}

export interface StreamChatResult {
  text: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
  usage: RawUsage;
  finishReason: string;
}

/** 统一的模型调用错误：message 已经是可直接展示的中文 */
export class LlmError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT = 180_000;

/** baseUrl 可能带或不带 /v1，统一补全到「根地址」 */
export function normalizeBaseUrl(baseUrl: string): string {
  let base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('未配置接口地址（Base URL），请到设置中填写。', 0, false);
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  // 去掉用户误填的完整路径
  base = base.replace(/\/chat\/completions$/i, '');
  // 已经带版本段（/v1、/v1beta、/openai/v1 等）就不再追加
  if (!/\/v\d+[a-z0-9]*$/i.test(base)) base = `${base}/v1`;
  return base;
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 对本地地址（ollama 等）追加到 NO_PROXY，避免被系统/环境变量中的代理拦截。
 *  Node fetch 的连接代理在每次请求时读取环境变量，因此动态设置即可生效。 */
function ensureLocalNoProxy(baseUrl: string): void {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')) {
      const cur = process.env.NO_PROXY || process.env.no_proxy || '';
      const parts = cur ? cur.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!parts.includes(host)) {
        parts.push(host);
        process.env.NO_PROXY = parts.join(',');
        process.env.no_proxy = parts.join(',');
      }
    }
  } catch {
    /* 非法 URL 忽略 */
  }
}

export function friendlyStatus(status: number, detail: string, label?: string): LlmError {
  const who = label ? `（渠道：${label}）` : '';
  const extra = detail ? `（服务端信息：${detail.slice(0, 200)}）` : '';
  switch (status) {
    case 400:
      return new LlmError(`请求被拒绝，可能是模型名或参数不被支持${extra}`, status, false);
    case 401:
      return new LlmError('API Key 无效或已过期，请到「设置 → 模型服务」重新填写。', status, false);
    case 402:
      return new LlmError('账户余额不足，请为当前服务商充值或切换到免费模型。', status, false);
    case 403:
      return new LlmError(`没有访问权限，请检查 Key 的权限范围或模型是否白名单${extra}`, status, false);
    case 404:
      return new LlmError('接口或模型不存在，请检查 Base URL 是否包含 /v1，以及模型名是否正确。', status, false);
    case 413:
      return new LlmError('上下文过长，请开启「Token 节省」或新建对话。', status, false);
    case 429:
      return new LlmError(`触发频率限制（429）${who}，已自动重试仍失败，请稍后再试或更换服务商。`, status, true);
    case 503:
      return new LlmError('服务端繁忙（503），请稍后重试。', status, true);
    default:
      if (status >= 500) return new LlmError(`服务端异常（${status}）${extra}`, status, true);
      return new LlmError(`请求失败（${status}）${extra}`, status, false);
  }
}

interface Combined {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): Combined {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));

  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

function buildHeaders(target: LlmTarget): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  if (target.kind === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/LHRonline/run-worker';
    headers['X-Title'] = 'Run worker';
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* SSE 流解析                                                          */
/* ------------------------------------------------------------------ */

interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: DeltaToolCall[] };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: RawUsage | null;
  error?: { message?: string; type?: string };
}

function parseToolCalls(acc: Map<number, ParsedToolCall>): ParsedToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name);
}

/** 流式对话：逐块回调增量，返回完整结果 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  let includeUsage = true;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let emitted = 0;
    try {
      const result = await runOnce({ ...opts, timeoutMs }, includeUsage, () => emitted);
      return result.value;
    } catch (err) {
      lastError = err;
      emitted = (err as { emitted?: number }).emitted ?? 0;
      if (err instanceof LlmError && err.message.includes('stream_options')) includeUsage = false;
      const aborted = opts.signal?.aborted === true;
      const retryable = err instanceof LlmError ? err.retryable : !aborted;
      if (aborted || !retryable || attempt >= retries || emitted > 0) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  if (opts.signal?.aborted) throw new LlmError('已取消本次生成。', 0, false);
  if (lastError instanceof LlmError) throw lastError;
  if (lastError instanceof Error) throw new LlmError(`网络请求失败：${lastError.message}`, 0, true);
  throw new LlmError('模型调用失败，未知错误。', 0, false);
}

async function runOnce(
  opts: StreamChatOptions,
  includeUsage: boolean,
  emittedSoFar: () => number,
): Promise<{ value: StreamChatResult }> {
  const base = normalizeBaseUrl(opts.target.baseUrl);
  const url = joinUrl(base, '/chat/completions');
  ensureLocalNoProxy(opts.target.baseUrl);

  const body: Record<string, unknown> = {
    model: opts.target.model,
    messages: opts.messages,
    stream: true,
  };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }
  if (includeUsage) body.stream_options = { include_usage: true };

  const combined = combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  let reader: Reader | null = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts.target),
      body: JSON.stringify(body),
      signal: combined.signal,
    });

    if (!res.ok) {
      const detail = await safeText(res);
      if (res.status === 400 && includeUsage && /stream_options/i.test(detail)) {
        throw new LlmError('stream_options 不被支持，正在降级重试。', 400, true);
      }
      throw friendlyStatus(res.status, detail, opts.target.label);
    }

    const contentType = res.headers.get('content-type') || '';
    let text = '';
    let reasoning = '';
    let finishReason = '';
    let usage: RawUsage = {};
    const toolAcc = new Map<number, ParsedToolCall>();

    // 少数服务在 stream:true 时仍返回整包 JSON
    if (contentType.includes('application/json')) {
      const raw = (await res.json()) as StreamChunk;
      const choice = raw.choices?.[0];
      const content = choice?.message?.content ?? '';
      const think = choice?.message?.reasoning_content ?? '';
      if (content) {
        text += content;
        opts.onDelta?.(content);
      }
      if (think) opts.onReasoning?.(think);
      if (raw.usage) {
        usage = raw.usage;
        opts.onUsage?.(usage);
      }
      return { value: { text, reasoning: think, toolCalls: [], usage, finishReason: choice?.finish_reason ?? 'stop' } };
    }

    const bodyStream = res.body;
    if (!bodyStream) throw new LlmError('服务端未返回数据流，请稍后重试。', 0, true);
    reader = (bodyStream as unknown as { getReader(): Reader }).getReader();

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line.trim()) continue;
        if (!line.startsWith('data:')) continue; // 忽略注释/心跳
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        let json: StreamChunk;
        try {
          json = JSON.parse(payload) as StreamChunk;
        } catch {
          continue; // 跨块截断的残片直接丢弃
        }
        if (json.error?.message) throw new LlmError(`模型返回错误：${json.error.message}`, 0, false);

        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          const think = delta.reasoning_content ?? delta.reasoning;
          if (think) {
            reasoning += think;
            opts.onReasoning?.(think);
          }
          if (delta.content) {
            text += delta.content;
            opts.onDelta?.(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = typeof tc.index === 'number' ? tc.index : toolAcc.size;
            const prev = toolAcc.get(index) ?? { id: '', name: '', arguments: '' };
            toolAcc.set(index, {
              id: tc.id || prev.id || `call_${index}`,
              name: prev.name + (tc.function?.name ?? ''),
              arguments: prev.arguments + (tc.function?.arguments ?? ''),
            });
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (json.usage) {
          usage = json.usage;
          opts.onUsage?.(usage);
        }
      }
    }

    if (!text && !reasoning && toolAcc.size === 0) {
      throw new LlmError('模型没有返回任何内容，请检查模型名或稍后重试。', 0, true);
    }
    return { value: { text, reasoning, toolCalls: parseToolCalls(toolAcc), usage, finishReason: finishReason || 'stop' } };
  } catch (err) {
    const wrapped = wrapError(err, combined.timedOut(), opts.signal, opts.target.kind);
    (wrapped as { emitted?: number }).emitted = emittedSoFar();
    throw wrapped;
  } finally {
    combined.cleanup();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* 流已结束 */
      }
    }
  }
}

export function wrapError(err: unknown, timedOut: boolean, signal?: AbortSignal, kind?: string): LlmError {
  if (err instanceof LlmError) return err;
  if (signal?.aborted) return new LlmError('已取消本次生成。', 0, false);
  if (timedOut) return new LlmError('请求超时，请检查网络或改用更快的服务商。', 0, true);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError') return new LlmError('已取消本次生成。', 0, false);
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(msg)) {
    const hint = kind === 'ollama' ? '。本地模型请先运行 `ollama serve` 并确保已拉取所需模型。' : '';
    return new LlmError(`无法连接服务商：${msg}。请检查网络、代理或本地服务是否已启动${hint}`, 0, true);
  }
  return new LlmError(`请求出错：${msg}`, 0, true);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 非流式补全（路由、摘要、记忆抽取等轻量调用）                          */
/* ------------------------------------------------------------------ */

export interface CompleteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  json?: boolean;
}

/** 一次性取回完整文本，内部仍走 chat/completions（stream:false） */
export async function completeText(target: LlmTarget, user: string, opts: CompleteOptions = {}): Promise<string> {
  const base = normalizeBaseUrl(target.baseUrl);
  const url = joinUrl(base, '/chat/completions');
  const messages: LlmMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: user });

  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) body.response_format = { type: 'json_object' };

  const combined = combineSignals(opts.signal, opts.timeoutMs ?? 60_000);
  ensureLocalNoProxy(target.baseUrl);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(target),
      body: JSON.stringify(body),
      signal: combined.signal,
    });
    if (!res.ok) throw friendlyStatus(res.status, await safeText(res), target.label);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    throw wrapError(err, combined.timedOut(), opts.signal, target.kind);
  } finally {
    combined.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* 模型与连通性                                                        */
/* ------------------------------------------------------------------ */

function presetModelsFor(kindOrId: string): string[] {
  const preset = PROVIDER_PRESETS.find((p) => p.kind === kindOrId || p.id === kindOrId);
  return preset ? [...preset.models] : [];
}

/** 拉取服务商模型列表；失败则回退内置预设 */
export async function listModels(cfg: { providerId?: string; kind?: string; baseUrl: string; apiKey: string }): Promise<string[]> {
  const fallback = presetModelsFor(cfg.kind ?? cfg.providerId ?? '');
  try {
    const base = normalizeBaseUrl(cfg.baseUrl);
    ensureLocalNoProxy(cfg.baseUrl);
    const res = await fetch(joinUrl(base, '/models'), {
      method: 'GET',
      headers: buildHeaders({ providerId: cfg.providerId ?? '', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: '', kind: cfg.kind }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? m.name).filter((m): m is string => !!m);
    return models.length > 0 ? models.sort() : fallback;
  } catch {
    return fallback;
  }
}

/** 用一条极短请求测延迟，顺带验证 Key 与模型是否可用 */
export async function testProvider(cfg: ProviderConfig): Promise<ProviderTestResult> {
  const model = cfg.models[0] ?? '';
  if (!model) {
    return { ok: false, latencyMs: 0, message: '该服务商还没有可用模型，请先拉取模型列表或手动填写模型名。' };
  }
  if (!cfg.baseUrl) return { ok: false, latencyMs: 0, message: '缺少接口地址（Base URL）。' };
  if (!cfg.apiKey && cfg.kind !== 'ollama') {
    return { ok: false, latencyMs: 0, message: '缺少 API Key。' };
  }
  const started = Date.now();
  try {
    await completeText(
      { providerId: cfg.id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model, kind: cfg.kind },
      'ping',
      { maxTokens: 8, timeoutMs: 20_000 },
    );
    const latencyMs = Date.now() - started;
    const models = await listModels({ providerId: cfg.id, kind: cfg.kind, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    return { ok: true, latencyMs, message: `连接正常，延迟 ${latencyMs} ms。`, models };
  } catch (err) {
    const message = err instanceof LlmError ? err.message : `连接失败：${String(err)}`;
    return { ok: false, latencyMs: Date.now() - started, message };
  }
}

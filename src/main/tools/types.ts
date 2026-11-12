/**
 * Run worker — 工具定义与运行时契约
 */
import type { AgentId, Citation, RunEvent, Settings } from '../../shared/types';
import type { KnowledgeBase, Logger, McpManager, MemoryStore, PermissionGuard, TaskScheduler } from '../../shared/platform';

export interface ToolResult {
  ok: boolean;
  /** 回填给模型的内容（已截断） */
  content: string;
  error?: string;
  citations?: Citation[];
}

export interface ApprovalAsk {
  toolName: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

/** 工具能拿到的最小运行时能力集 */
export interface ToolRuntime {
  settings(): Settings;
  permissions: PermissionGuard;
  memory: MemoryStore;
  kb: KnowledgeBase;
  scheduler: TaskScheduler;
  mcp: McpManager;
  log: Logger;
  /** 工作目录（绝对路径，保证存在） */
  workspace(): string;
  artifactsDir: string;
  /** 申请用户授权，超时视为拒绝 */
  askApproval(req: ApprovalAsk): Promise<boolean>;
  /** 推送提示信息给界面 */
  notify(level: 'info' | 'warn' | 'error', text: string): void;
}

export interface ToolContext {
  runId: string;
  agentId: AgentId;
  /** 所属会话；用于把产物与记忆按会话隔离，删除会话时可一并清理 */
  conversationId?: string;
  signal: AbortSignal;
  rt: ToolRuntime;
  emitRun(event: RunEvent): void;
}

export interface ToolDefinition {
  name: string;
  /** 给模型看的中文说明，写清什么时候该用 */
  description: string;
  /** JSON Schema（object） */
  parameters: Record<string, unknown>;
  /** 需要授权的工具（内部仍会经 PermissionGuard 判定） */
  dangerous?: boolean;
  run(args: Record<string, unknown>, tc: ToolContext): Promise<ToolResult>;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return fallback;
}

/** 头尾保留、中间省略，控制回填模型的体积 */
export function truncateMiddle(text: string, limit: number): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit * 0.6));
  const tail = Math.max(1, limit - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…（中间省略 ${omitted} 字）…\n\n${text.slice(-tail)}`;
}

export function ok(content: string, citations?: Citation[]): ToolResult {
  return { ok: true, content, citations };
}

export function fail(error: string): ToolResult {
  return { ok: false, content: `工具执行失败：${error}`, error };
}

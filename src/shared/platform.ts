/**
 * Run worker — 平台模块接口（主进程内部契约）
 * 各模块由独立文件实现，通过工厂函数注入依赖，便于替换与单测。
 */
import type {
  KnowledgeHit,
  KnowledgeSource,
  KnowledgeStats,
  McpCallResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  MemoryFact,
  ScheduledTask,
  Settings,
  TaskRun,
  UpdateInfo,
  UpdateProgress,
} from './types';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 供定时任务/工作流调用主 Agent */
export interface AgentRunner {
  run(prompt: string, opts?: { agentId?: ScheduledTask['agentId']; title?: string; source?: string }): Promise<{ text: string; conversationId: string }>;
}

/** 文本向量化（可选）；返回 null 表示不可用，知识库退回词法检索 */
export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

export interface PlatformDeps {
  /** 应用数据目录，各模块在其中建立子目录 */
  dataDir: string;
  settings(): Settings;
  saveSettings(patch: Partial<Settings>): Settings;
  emit(channel: string, payload: unknown): void;
  log: Logger;
}

/* ---------------------------- MCP ---------------------------- */

export interface McpManager {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  statuses(): McpServerStatus[];
  tools(): McpToolInfo[];
  add(cfg: McpServerConfig): Promise<McpServerStatus[]>;
  remove(id: string): Promise<McpServerStatus[]>;
  toggle(id: string, enabled: boolean): Promise<McpServerStatus[]>;
  connect(id: string): Promise<McpServerStatus[]>;
  call(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/* -------------------------- 定时任务 -------------------------- */

export interface TaskScheduler {
  start(): void;
  stop(): void;
  list(): ScheduledTask[];
  save(task: ScheduledTask): ScheduledTask[];
  remove(id: string): ScheduledTask[];
  runNow(id: string): Promise<TaskRun>;
  history(): TaskRun[];
}

/* --------------------------- 知识库 --------------------------- */

export interface KnowledgeBase {
  init(): Promise<void>;
  list(): KnowledgeSource[];
  addSource(path: string, watch?: boolean): Promise<KnowledgeSource[]>;
  remove(id: string): Promise<KnowledgeSource[]>;
  reindex(sourceId?: string): Promise<KnowledgeStats>;
  search(query: string, topK?: number): Promise<KnowledgeHit[]>;
  stats(): KnowledgeStats;
  /** 供工具调用：把命中结果拼成上下文 */
  contextFor(query: string, topK?: number): Promise<{ text: string; citations: KnowledgeHit[] }>;
}

/* -------------------------- 长期记忆 -------------------------- */

export interface MemoryStore {
  list(): MemoryFact[];
  add(fact: Partial<MemoryFact> & { text: string }): MemoryFact[];
  forget(id: string): MemoryFact[];
  /** 按来源批量删除（如删除某个对话时清掉它派生出的记忆） */
  forgetBySource(source: string | string[]): MemoryFact[];
  clear(): MemoryFact[];
  recall(query: string, topK?: number): MemoryFact[];
  /** 生成注入提示词的紧凑摘要 */
  digest(maxChars?: number): string;
}

/* ---------------------------- 更新 ---------------------------- */

export interface Updater {
  check(force?: boolean): Promise<UpdateInfo>;
  current(): UpdateInfo | null;
  /** 应用内一键升级：下载 → SHA-256 校验 → 拉起静默安装器；进度走 EVT.updateProgress */
  install(): Promise<UpdateProgress>;
}

/* --------------------------- 安全策略 -------------------------- */

export interface CommandVerdict {
  allowed: boolean;
  requiresApproval: boolean;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

export interface PermissionGuard {
  inspectCommand(command: string): CommandVerdict;
  inspectFileWrite(path: string): CommandVerdict;
}

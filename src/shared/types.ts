/**
 * Run worker — 全局共享类型契约
 * 主进程 / 预加载 / 渲染进程三方共用，任何字段变更必须同步两端。
 */

export const APP_NAME = 'Run worker';
export const APP_ID = 'com.runworker.desktop';

/* ------------------------------------------------------------------ */
/* 主题与外观                                                          */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppearanceSettings {
  theme: ThemeMode;
  /** 主题色（十六进制），用于按钮/高亮/流光 */
  accent: string;
  /** 界面缩放 0.85 ~ 1.2 */
  zoom: number;
  /** 思考过程默认折叠 */
  collapseThinking: boolean;
  /** 消息区等宽字体 */
  monoFont: boolean;
  /** 背景装饰（网格/光晕） */
  decorations: boolean;
}

/* ------------------------------------------------------------------ */
/* 模型提供方                                                          */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'deepseek' | 'openai-compatible' | 'openrouter' | 'groq' | 'siliconflow' | 'ollama' | 'custom';

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 默认模型列表 */
  models: string[];
  /** 免费可用（含免费额度/免费模型） */
  free: boolean;
  /** 是否本地部署（无需 Key） */
  local?: boolean;
  keyUrl?: string;
  note: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** 是否免费渠道 */
  free: boolean;
  enabled: boolean;
  /** 连通性检测结果 */
  status?: 'unknown' | 'ok' | 'error';
  statusMessage?: string;
  checkedAt?: number;
}

export interface ModelRef {
  providerId: string;
  model: string;
}

/* ------------------------------------------------------------------ */
/* 人格 / 办事风格                                                     */
/* ------------------------------------------------------------------ */

export type PersonaPreset = 'direct' | 'balanced' | 'teaching' | 'cold' | 'custom';

export interface PersonaSettings {
  preset: PersonaPreset;
  /** 自定义风格描述（preset=custom 时生效） */
  customPrompt: string;
  /** 输出冗长度 1（极简）~ 5（详尽） */
  verbosity: number;
  temperature: number;
  /** 禁止寒暄/免责声明/重复问题，直接给结果 */
  noFiller: boolean;
  /** 优先给可执行结论与代码，而非解释 */
  resultFirst: boolean;
  /** 像人一样协作：自然语气、记住上下文约定、被纠正时直接改 */
  humanize: boolean;
}

/* ------------------------------------------------------------------ */
/* Token / 成本控制                                                    */
/* ------------------------------------------------------------------ */

export interface TokenSaveSettings {
  enabled: boolean;
  /** 携带的历史消息上限 */
  maxHistoryMessages: number;
  /** 超过多少字符触发滚动摘要压缩 */
  compressThreshold: number;
  /** 工具输出截断长度 */
  toolOutputLimit: number;
  /** 不把 reasoning 内容回传模型（DeepSeek 官方建议） */
  skipReasoningResend: boolean;
  /** 单次回复最大 token */
  maxOutputTokens: number;
  /** 相同系统提示前缀稳定化，命中缓存 */
  cacheFriendlyPrefix: boolean;
  /** 预算告警（元），0 表示不限制 */
  budgetAlertCny: number;
}

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costCny: number;
  /**
   * token 数值的来源。api = 服务商 usage 字段（精确）；estimated = 本地字符估算（近似）；
   * mixed = 多轮里既有精确值也有估算值。缺省视为 api，兼容旧数据。
   */
  tokenSource?: 'api' | 'estimated' | 'mixed';
  /** 精确统计到的请求轮数 / 总请求轮数，用于解释 mixed */
  exactRequests?: number;
  totalRequests?: number;
}

/* ------------------------------------------------------------------ */
/* 思考过程                                                            */
/* ------------------------------------------------------------------ */

export interface ThinkingSettings {
  enabled: boolean;
  /** 强制思考内容为中文 */
  forceChinese: boolean;
  /** 非中文占比超过阈值时触发重述 */
  chineseRatioThreshold: number;
  showTokens: boolean;
}

/* ------------------------------------------------------------------ */
/* Agent / 工具                                                        */
/* ------------------------------------------------------------------ */

export type AgentId = 'orchestrator' | 'code' | 'image' | 'model' | 'video' | 'computer' | 'research' | 'data';

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  /** 一句话能力描述 */
  tagline: string;
  description: string;
  icon: string;
  color: string;
  capabilities: string[];
  tools: string[];
  /** 推荐用于哪些模型能力 */
  requiresVision?: boolean;
  requiresImageGen?: boolean;
}

export type ApprovalMode = 'always' | 'safe-only' | 'never';

export interface AgentSettings {
  approvalMode: ApprovalMode;
  maxSteps: number;
  /** 工具/命令的工作目录 */
  workspaceDir: string;
  pythonPath: string;
  shell: 'powershell' | 'cmd' | 'bash';
  /** 命令超时（毫秒） */
  commandTimeout: number;
  /** 自动调度子 Agent */
  autoDelegate: boolean;
  /** 危险操作黑名单（正则） */
  denyPatterns: string[];
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'running' | 'done' | 'error' | 'denied';
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** 是否需要用户确认 */
  requiresApproval?: boolean;
}

/* ------------------------------------------------------------------ */
/* 对话                                                                */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'summary';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  createdAt: number;
  agentId?: AgentId;
  model?: string;
  providerId?: string;
  usage?: UsageStats;
  toolCalls?: ToolCallRecord[];
  /** 附件（图片路径 / 文件路径） */
  attachments?: Attachment[];
  /** 知识库引用 */
  citations?: Citation[];
  status?: 'streaming' | 'done' | 'error' | 'aborted';
  error?: string;
  /** 是否为压缩摘要节点 */
  isSummary?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
  size?: number;
  mime?: string;
}

export interface Citation {
  title: string;
  sourcePath: string;
  snippet: string;
  score: number;
}

/** 工作区：磁盘上一个真实文件夹；parentId 指向父工作区，可层层嵌套 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  createdAt: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  messageCount: number;
  agentId: AgentId;
  usage: UsageStats;
  preview: string;
  /** 绑定的工作区；为空表示未归入任何工作区 */
  workspaceId?: string;
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[];
  /** 滚动摘要（长上下文压缩结果） */
  summary?: string;
  /** 本轮使用过的 Agent 轨迹 */
  trace?: AgentTraceStep[];
}

export interface AgentTraceStep {
  id: string;
  agentId: AgentId;
  action: string;
  detail?: string;
  at: number;
  tokens?: number;
}

/* ------------------------------------------------------------------ */
/* 运行事件（主 → 渲染 流式推送）                                       */
/* ------------------------------------------------------------------ */

export type RunEvent =
  | { type: 'run:start'; runId: string; conversationId: string; agentId: AgentId; model: string; at: number }
  | { type: 'run:routing'; runId: string; from: AgentId; to: AgentId; reason: string }
  | { type: 'run:thinking'; runId: string; delta: string }
  | { type: 'run:thinking-lang'; runId: string; ratio: number; rewritten: boolean }
  | { type: 'run:content'; runId: string; delta: string }
  /** 多步工具调用进入下一轮：界面应清掉上一轮的过渡文本，与最终落库内容保持一致 */
  | { type: 'run:step'; runId: string; step: number }
  | { type: 'run:tool'; runId: string; call: ToolCallRecord }
  | { type: 'run:citation'; runId: string; citations: Citation[] }
  | { type: 'run:usage'; runId: string; usage: UsageStats; conversationUsage: UsageStats }
  | { type: 'run:end'; runId: string; status: 'done' | 'error' | 'aborted'; messageId?: string; error?: string }
  | { type: 'run:notice'; runId: string; level: 'info' | 'warn' | 'error'; text: string };

export interface ChatSendRequest {
  conversationId?: string;
  text: string;
  agentId?: AgentId;
  attachments?: Attachment[];
  /** 覆盖人格/节省模式（临时） */
  overrides?: {
    personaPreset?: PersonaPreset;
    tokenSave?: boolean;
    model?: ModelRef;
  };
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  autoStart: boolean;
  description?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  state: 'stopped' | 'starting' | 'ready' | 'error';
  toolCount: number;
  message?: string;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  ok: boolean;
  content: string;
  isError?: boolean;
}

/* ------------------------------------------------------------------ */
/* 定时任务                                                            */
/* ------------------------------------------------------------------ */

export type ScheduleKind = 'cron' | 'interval' | 'once';

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  agentId: AgentId;
  kind: ScheduleKind;
  /** 5 段 cron（kind=cron） */
  cron?: string;
  /** 间隔分钟（kind=interval） */
  intervalMinutes?: number;
  /** 单次执行时间戳（kind=once） */
  runAt?: number;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: 'success' | 'error' | 'running';
  lastResult?: string;
  nextRunAt?: number;
  /** 调度提示（如 cron 日字段在当月不存在，顺延到下月） */
  nextNote?: string;
  /** 结果写入知识库 */
  indexResult: boolean;
}

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'success' | 'error';
  output?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 知识库                                                              */
/* ------------------------------------------------------------------ */

export interface KnowledgeSource {
  id: string;
  path: string;
  name: string;
  kind: 'dir' | 'file';
  files: number;
  chunks: number;
  addedAt: number;
  updatedAt: number;
  /** 是否监听变更 */
  watch: boolean;
  status: 'pending' | 'indexing' | 'ready' | 'error';
  message?: string;
}

export interface KnowledgeHit {
  id: string;
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface KnowledgeStats {
  sources: number;
  documents: number;
  chunks: number;
  updatedAt: number;
  vectorReady: boolean;
}

/* ------------------------------------------------------------------ */
/* 长期记忆                                                            */
/* ------------------------------------------------------------------ */

export type MemoryKind = 'preference' | 'fact' | 'project' | 'instruction';

export interface MemoryFact {
  id: string;
  kind: MemoryKind;
  text: string;
  /** 0~1，越高越容易被召回 */
  weight: number;
  createdAt: number;
  updatedAt: number;
  hits: number;
  source?: string;
}

/* ------------------------------------------------------------------ */
/* 更新                                                                */
/* ------------------------------------------------------------------ */

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateSettings {
  autoCheck: boolean;
  channel: UpdateChannel;
  /** 自定义更新源（GitHub owner/repo 或 JSON 地址） */
  feed: string;
  lastCheckAt?: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  prerelease: boolean;
  notes: string;
  publishedAt?: string;
  downloadUrl?: string;
  /** 安装包 SHA-256（GitHub API 资产 digest 字段，格式 sha256:hex；自定义源可给 hex） */
  assetSha256?: string;
  releaseUrl?: string;
  checkedAt: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 设置总表                                                            */
/* ------------------------------------------------------------------ */

export interface Settings {
  version: number;
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModel: string;
  /** 免费优先：自动挑选可用免费渠道 */
  freeMode: boolean;
  appearance: AppearanceSettings;
  persona: PersonaSettings;
  tokenSave: TokenSaveSettings;
  thinking: ThinkingSettings;
  memory: {
    enabled: boolean;
    longTerm: boolean;
    maxFacts: number;
    /** 每轮自动抽取记忆 */
    autoExtract: boolean;
  };
  agent: AgentSettings;
  mcpServers: McpServerConfig[];
  update: UpdateSettings;
  onboardingDone: boolean;
  /** 匿名使用统计，默认关闭 */
  telemetry: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  userData: string;
  installDir: string;
  /** 环境变量是否就绪 */
  env: { RUN_WORKER_HOME: string | null; pathHasInstall: boolean };
  repoUrl: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  models?: string[];
}

export interface ToastPayload {
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface BootstrapPayload {
  settings: Settings;
  providers: ProviderPreset[];
  agents: AgentDescriptor[];
  conversations: ConversationMeta[];
  workspaces: Workspace[];
  mcp: McpServerStatus[];
  tasks: ScheduledTask[];
  knowledge: KnowledgeSource[];
  memory: MemoryFact[];
  update: UpdateInfo | null;
  app: AppInfo;
}

/** 彻底删除会话后的擦除报告：告诉用户到底清掉了什么 */
export interface ConversationPurgeReport {
  /** 删除的会话文件与残留文件数 */
  files: number;
  /** 删除的产物文件数（图片 / 生成物等） */
  artifacts: number;
  /** 删除的长期记忆条数（由该会话派生） */
  memories: number;
  /** 被中止的在途任务数（防止删完又被写回） */
  runs: number;
  /** 未能删除的路径（一般是文件被占用） */
  failed: string[];
}

/** 可重新引用的文件：会话里出现过的附件，或该会话产生的产物 */
export interface ConversationFileRef {
  name: string;
  path: string;
  kind: 'image' | 'file';
  size?: number;
  mime?: string;
  /** attachment = 用户添加过的文件；artifact = 本会话生成的文件 */
  origin: 'attachment' | 'artifact';
  /** 是否已不存在于磁盘 */
  missing?: boolean;
}

/** 应用内一键升级的实时进度（主进程 → 渲染进程） */
export interface UpdateProgress {
  stage: 'idle' | 'downloading' | 'verifying' | 'installing' | 'done' | 'error';
  /** 0~100 */
  percent: number;
  text: string;
  /** 已下载字节 / 总字节 */
  received?: number;
  total?: number;
  localPath?: string;
  error?: string;
}

export const DEFAULT_USAGE: UsageStats = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  costCny: 0,
  tokenSource: 'api',
  exactRequests: 0,
  totalRequests: 0,
};

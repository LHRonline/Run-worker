/**
 * Run worker — IPC 通道与桥接 API 契约
 * 渲染进程只能通过 preload 暴露的 window.runworker 访问主进程能力。
 */
import type {
  AgentDescriptor,
  AppInfo,
  ApprovalRequest,
  Attachment,
  BootstrapPayload,
  ChatSendRequest,
  Conversation,
  ConversationMeta,
  KnowledgeHit,
  KnowledgeSource,
  KnowledgeStats,
  McpCallResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  MemoryFact,
  ModelRef,
  ProviderConfig,
  ProviderPreset,
  ProviderTestResult,
  RunEvent,
  ScheduledTask,
  Settings,
  TaskRun,
  ToastPayload,
  UpdateInfo,
} from './types';

/** 主进程处理器：invoke/handle */
export const IPC = {
  bootstrap: 'app:bootstrap',
  appInfo: 'app:info',
  openExternal: 'app:open-external',
  openPath: 'app:open-path',
  pickFiles: 'app:pick-files',
  pickDirectory: 'app:pick-directory',
  windowMinimize: 'win:minimize',
  windowMaximize: 'win:maximize',
  windowClose: 'win:close',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  providersPresets: 'providers:presets',
  providerTest: 'providers:test',
  providerModels: 'providers:models',

  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatApprove: 'chat:approve',

  convList: 'conv:list',
  convGet: 'conv:get',
  convCreate: 'conv:create',
  convRename: 'conv:rename',
  convRemove: 'conv:remove',
  convClear: 'conv:clear',
  convPin: 'conv:pin',
  convExport: 'conv:export',

  agentsList: 'agents:list',

  mcpList: 'mcp:list',
  mcpTools: 'mcp:tools',
  mcpAdd: 'mcp:add',
  mcpRemove: 'mcp:remove',
  mcpToggle: 'mcp:toggle',
  mcpConnect: 'mcp:connect',
  mcpCall: 'mcp:call',

  taskList: 'task:list',
  taskSave: 'task:save',
  taskRemove: 'task:remove',
  taskRun: 'task:run',
  taskHistory: 'task:history',

  kbList: 'kb:list',
  kbAddSource: 'kb:add-source',
  kbRemove: 'kb:remove',
  kbReindex: 'kb:reindex',
  kbSearch: 'kb:search',
  kbStats: 'kb:stats',

  memoryList: 'memory:list',
  memoryAdd: 'memory:add',
  memoryForget: 'memory:forget',
  memoryClear: 'memory:clear',

  updateCheck: 'update:check',
  updateOpen: 'update:open',
} as const;

/** 主进程 → 渲染进程 主动推送 */
export const EVT = {
  run: 'evt:run',
  toast: 'evt:toast',
  approval: 'evt:approval',
  tasksChanged: 'evt:tasks-changed',
  mcpChanged: 'evt:mcp-changed',
  kbChanged: 'evt:kb-changed',
  updateAvailable: 'evt:update-available',
  settingsChanged: 'evt:settings-changed',
  systemTheme: 'evt:system-theme',
} as const;

export interface RunWorkerApi {
  bootstrap(): Promise<BootstrapPayload>;
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    pickFiles(opts?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }): Promise<Attachment[]>;
    pickDirectory(): Promise<string | null>;
  };
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: DeepPartial<Settings>): Promise<Settings>;
    reset(): Promise<Settings>;
    presets(): Promise<ProviderPreset[]>;
    testProvider(cfg: ProviderConfig): Promise<ProviderTestResult>;
    models(cfg: { providerId: string; baseUrl: string; apiKey: string }): Promise<string[]>;
  };
  chat: {
    send(req: ChatSendRequest): Promise<{ runId: string; conversationId: string }>;
    abort(runId?: string): Promise<void>;
    approve(requestId: string, approved: boolean, remember?: boolean): Promise<void>;
  };
  conversations: {
    list(): Promise<ConversationMeta[]>;
    get(id: string): Promise<Conversation | null>;
    create(title?: string): Promise<Conversation>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    pin(id: string, pinned: boolean): Promise<void>;
    exportMarkdown(id: string): Promise<string>;
  };
  agents: {
    list(): Promise<AgentDescriptor[]>;
  };
  mcp: {
    list(): Promise<McpServerStatus[]>;
    tools(): Promise<McpToolInfo[]>;
    add(cfg: McpServerConfig): Promise<McpServerStatus[]>;
    remove(id: string): Promise<McpServerStatus[]>;
    toggle(id: string, enabled: boolean): Promise<McpServerStatus[]>;
    connect(id: string): Promise<McpServerStatus[]>;
    call(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  };
  tasks: {
    list(): Promise<ScheduledTask[]>;
    save(task: ScheduledTask): Promise<ScheduledTask[]>;
    remove(id: string): Promise<ScheduledTask[]>;
    run(id: string): Promise<TaskRun>;
    history(): Promise<TaskRun[]>;
  };
  knowledge: {
    list(): Promise<KnowledgeSource[]>;
    addSource(path: string, watch?: boolean): Promise<KnowledgeSource[]>;
    remove(id: string): Promise<KnowledgeSource[]>;
    reindex(id?: string): Promise<KnowledgeStats>;
    search(query: string, topK?: number): Promise<KnowledgeHit[]>;
    stats(): Promise<KnowledgeStats>;
  };
  memory: {
    list(): Promise<MemoryFact[]>;
    add(fact: Partial<MemoryFact> & { text: string }): Promise<MemoryFact[]>;
    forget(id: string): Promise<MemoryFact[]>;
    clear(): Promise<MemoryFact[]>;
  };
  update: {
    check(force?: boolean): Promise<UpdateInfo>;
    open(): Promise<void>;
  };
  events: {
    onRun(cb: (e: RunEvent) => void): () => void;
    onApproval(cb: (req: ApprovalRequest) => void): () => void;
    onToast(cb: (t: ToastPayload) => void): () => void;
    onTasksChanged(cb: (tasks: ScheduledTask[]) => void): () => void;
    onMcpChanged(cb: (servers: McpServerStatus[]) => void): () => void;
    onKnowledgeChanged(cb: (sources: KnowledgeSource[]) => void): () => void;
    onUpdateAvailable(cb: (info: UpdateInfo) => void): () => void;
    onSettingsChanged(cb: (s: Settings) => void): () => void;
    onSystemTheme(cb: (mode: 'dark' | 'light') => void): () => void;
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

export type ModelRefLike = ModelRef;

declare global {
  interface Window {
    runworker?: RunWorkerApi;
  }
}

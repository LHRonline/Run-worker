/**
 * Run worker — 主进程运行时上下文
 * 集中装配存储、平台模块与对话服务，供 IPC 层直接使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo, Settings } from '../../shared/types';
import { EVT } from '../../shared/ipc';
import type { AgentRunner, KnowledgeBase, Logger, McpManager, MemoryStore, PermissionGuard, PlatformDeps, TaskScheduler, Updater } from '../../shared/platform';
import { createMcpManager } from '../platform/mcp';
import { createScheduler } from '../platform/scheduler';
import { createKnowledgeBase } from '../platform/knowledge';
import { createMemoryStore } from '../platform/memory';
import { createUpdater } from '../platform/updater';
import { createPermissionGuard } from '../platform/permissions';
import { createLogger, Store } from '../store';
import { resolveWorkspaceDir } from '../env';
import { ApprovalBroker } from './approval';
import { ChatService } from './service';
import type { ToolRuntime } from '../tools/types';

export interface MainContext {
  dataDir: string;
  logsDir: string;
  artifactsDir: string;
  /** 兜底工作目录（userData/workspace） */
  workspaceFallback: string;
  log: Logger;
  store: Store;
  appInfo: AppInfo;
  emit: (channel: string, payload: unknown) => void;

  settings(): Settings;
  saveSettings(patch: Partial<Settings>): Settings;
  /** 解析并创建工作目录 */
  workspace(): string;

  mcp: McpManager;
  scheduler: TaskScheduler;
  kb: KnowledgeBase;
  memory: MemoryStore;
  /** 解析工作区 id → 该工作区文件夹的记忆 store；空/未知退回全局 */
  memoryForWorkspace(wsId: string | null | undefined): MemoryStore;
  /** 按会话解析它所属工作区的记忆 store（移出工作区则退回全局） */
  memoryForConversation(convId: string): MemoryStore;
  /** 按会话解析它所属工作区的真实文件夹（产物读写用）；未绑定/失效退回全局工作目录 */
  workspaceDirForConversation(convId: string): string;
  /** 跨「全局 + 所有工作区」兜底清理：会话记忆可能落在任意 store，逐份 forget 确保清干净 */
  forgetMemoryEverywhere(source: string | string[]): number;
  updater: Updater;
  permissions: PermissionGuard;
  approval: ApprovalBroker;
  chat: ChatService;
}

export interface ContextOptions {
  dataDir: string;
  appInfo: AppInfo;
  emit: (channel: string, payload: unknown) => void;
}

export function createContext(opts: ContextOptions): MainContext {
  const store = new Store(opts.dataDir);
  const log = createLogger(store.paths.logsDir);

  const emit = (channel: string, payload: unknown) => {
    try {
      opts.emit(channel, payload);
    } catch (err) {
      log.warn('推送事件失败', channel, err);
    }
  };

  const deps: PlatformDeps = {
    dataDir: opts.dataDir,
    settings: () => store.getSettings(),
    saveSettings: (patch) => {
      const next = store.updateSettings(patch);
      emit(EVT.settingsChanged, next);
      return next;
    },
    emit,
    log,
  };

  // 长期记忆按「工作区文件夹」隔离：每个工作区各存一份 <folder>/.runworker/memory/facts.json，
  // 未绑定工作区的对话（最近对话）共用全局/兜底的那份（dataDir/memory）。
  const memoryStores = new Map<string, MemoryStore>();
  const memoryDirKey = (dir: string | null): string => (dir ? path.resolve(dir) : '');
  const memoryForDir = (dir: string | null): MemoryStore => {
    const key = memoryDirKey(dir);
    const cached = memoryStores.get(key);
    if (cached) return cached;
    const store = createMemoryStore({ ...deps, dataDir: dir ? path.join(path.resolve(dir), '.runworker') : opts.dataDir });
    memoryStores.set(key, store);
    return store;
  };
  /** 解析工作区 id → 该工作区文件夹的记忆 store；wsId 为空/未知时退回全局 */
  const memoryForWorkspace = (wsId: string | null | undefined): MemoryStore => {
    if (wsId) {
      const ws = store.getWorkspace(wsId);
      if (ws?.path) return memoryForDir(ws.path);
    }
    return memoryForDir(null);
  };
  /** 按会话解析它所属工作区的记忆 store（会话被移出工作区则退回全局） */
  const memoryForConversation = (convId: string): MemoryStore => {
    const conv = store.getConversation(convId);
    return memoryForWorkspace(conv?.workspaceId ?? null);
  };
  /** 会话产物落盘目录：与 makeToolRuntime 的 artifactsDir 用同一套解析规则，
   *  保证「写入 → 引用 → 删除」指向同一个文件夹，不会删错或漏删。 */
  const workspaceDirForConversation = (convId: string): string => {
    const conv = store.getConversation(convId);
    const ws = conv?.workspaceId ? store.getWorkspace(conv.workspaceId) : null;
    if (ws?.path) {
      try {
        fs.mkdirSync(ws.path, { recursive: true });
        return path.resolve(ws.path);
      } catch {
        /* 目录不可用，回退 */
      }
    }
    return resolveWorkspaceDir(store.getSettings().agent.workspaceDir, store.paths.workspaceDir);
  };
  /** 跨「全局 + 所有工作区」兜底清理：删除/移动过的会话记忆可能落在任意 store，逐份 forget 确保清干净 */
  const forgetMemoryEverywhere = (source: string | string[]): number => {
    const keys = (Array.isArray(source) ? source : [source]).map((s) => String(s ?? '').trim()).filter(Boolean);
    if (keys.length === 0) return 0;
    const dirs = new Set<string>([memoryDirKey(null)]);
    // 当前仍登记的工作区
    for (const ws of store.listWorkspaces()) if (ws.path) dirs.add(memoryDirKey(ws.path));
    // 本次进程已创建过的记忆目录：工作区被「移除」后文件夹仍在磁盘、也不再出现在
    // listWorkspaces 里，只遍历当前工作区会漏删遗留在那里的派生记忆。
    // memoryStores 的 key 已是 memoryDirKey 归一化的结果，可直接并入。
    for (const key of memoryStores.keys()) dirs.add(key);
    let removed = 0;
    for (const key of dirs) {
      const ms = memoryForDir(key === '' ? null : key);
      const before = ms.list().length;
      ms.forgetBySource(keys);
      removed += before - ms.list().length;
    }
    return removed;
  };

  const ctx: MainContext = {
    dataDir: opts.dataDir,
    logsDir: store.paths.logsDir,
    artifactsDir: store.paths.artifactsDir,
    workspaceFallback: store.paths.workspaceDir,
    log,
    store,
    appInfo: opts.appInfo,
    emit,
    settings: () => store.getSettings(),
    saveSettings: deps.saveSettings,
    workspace: () => resolveWorkspaceDir(store.getSettings().agent.workspaceDir, store.paths.workspaceDir),
    mcp: createMcpManager(deps),
    scheduler: undefined as unknown as TaskScheduler,
    kb: createKnowledgeBase(deps),
    memory: memoryForDir(null),
    memoryForWorkspace,
    memoryForConversation,
    workspaceDirForConversation,
    forgetMemoryEverywhere,
    updater: createUpdater({ ...deps, appVersion: opts.appInfo.version, repoUrl: opts.appInfo.repoUrl }),
    permissions: createPermissionGuard(
      () => store.getSettings(),
      () => store.listWorkspaces().map((w) => w.path),
    ),
    approval: new ApprovalBroker(emit),
    chat: undefined as unknown as ChatService,
  };

  // 定时任务需要回调主 Agent，用惰性代理打破循环依赖
  const runner: AgentRunner = {
    run: (prompt, o) => ctx.chat.runForScheduler(prompt, o),
  };
  ctx.scheduler = createScheduler({ ...deps, runner });
  ctx.chat = new ChatService(ctx);

  return ctx;
}

/** 构造单次 run 的工具运行时 */
export function makeToolRuntime(
  ctx: MainContext,
  runId: string,
  notify: (level: 'info' | 'warn' | 'error', text: string) => void,
  conversationId?: string,
  workspaceDir?: string,
): ToolRuntime {
  // 会话绑定了工作区就用它的文件夹，工具读写、shell cwd、产物都落在这里
  const base = workspaceDir || ctx.workspace();
  return {
    settings: () => ctx.settings(),
    permissions: ctx.permissions,
    memory: conversationId ? ctx.memoryForConversation(conversationId) : ctx.memory,
    kb: ctx.kb,
    scheduler: ctx.scheduler,
    mcp: ctx.mcp,
    log: ctx.log,
    workspace: () => base,
    // 产物落到工作目录下的隐藏文件夹，既方便用户找到，又不污染项目根；
    // 按会话分目录，删除会话时可以连同产物一起彻底清掉。
    artifactsDir: path.join(base, '.runworker-artifacts', conversationId ?? '_shared'),
    async askApproval(req) {
      return ctx.approval.request({
        runId,
        toolName: req.toolName,
        command: req.command,
        risk: req.risk,
        reason: req.reason,
      });
    },
    notify,
  };
}

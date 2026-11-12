/**
 * Run worker — 主进程运行时上下文
 * 集中装配存储、平台模块与对话服务，供 IPC 层直接使用。
 */
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
    memory: createMemoryStore(deps),
    updater: createUpdater({ ...deps, appVersion: opts.appInfo.version, repoUrl: opts.appInfo.repoUrl }),
    permissions: createPermissionGuard(() => store.getSettings()),
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
): ToolRuntime {
  return {
    settings: () => ctx.settings(),
    permissions: ctx.permissions,
    memory: ctx.memory,
    kb: ctx.kb,
    scheduler: ctx.scheduler,
    mcp: ctx.mcp,
    log: ctx.log,
    workspace: () => ctx.workspace(),
    // 产物落到工作目录下的隐藏文件夹，既方便用户找到，又不污染项目根；
    // 按会话分目录，删除会话时可以连同产物一起彻底清掉。
    artifactsDir: path.join(ctx.workspace(), '.runworker-artifacts', conversationId ?? '_shared'),
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

/**
 * Run worker — Preload 桥接层
 * 仅暴露白名单方法，渲染进程不能直接触碰 Node/Electron。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { EVT, IPC } from '../shared/ipc';
import type { RunWorkerApi } from '../shared/ipc';
import type {
  ApprovalRequest,
  Attachment,
  ChatSendRequest,
  KnowledgeSource,
  McpServerConfig,
  ProviderConfig,
  RunEvent,
  ScheduledTask,
  Settings,
  ToastPayload,
  UpdateInfo,
} from '../shared/types';
import type { DeepPartial } from '../shared/ipc';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RunWorkerApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
    openPath: (path: string) => ipcRenderer.invoke(IPC.openPath, path),
    pickFiles: (opts) => ipcRenderer.invoke(IPC.pickFiles, opts) as Promise<Attachment[]>,
    pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    maximize: () => ipcRenderer.send(IPC.windowMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: DeepPartial<Settings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    reset: () => ipcRenderer.invoke(IPC.settingsReset),
    presets: () => ipcRenderer.invoke(IPC.providersPresets),
    testProvider: (cfg: ProviderConfig) => ipcRenderer.invoke(IPC.providerTest, cfg),
    models: (cfg) => ipcRenderer.invoke(IPC.providerModels, cfg),
  },
  chat: {
    send: (req: ChatSendRequest) => ipcRenderer.invoke(IPC.chatSend, req),
    abort: (runId?: string) => ipcRenderer.invoke(IPC.chatAbort, runId),
    approve: (requestId: string, approved: boolean, remember?: boolean) =>
      ipcRenderer.invoke(IPC.chatApprove, { requestId, approved, remember }),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC.convList),
    get: (id: string) => ipcRenderer.invoke(IPC.convGet, id),
    create: (title?: string) => ipcRenderer.invoke(IPC.convCreate, title),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.convRename, { id, title }),
    remove: (id: string) => ipcRenderer.invoke(IPC.convRemove, id),
    clear: () => ipcRenderer.invoke(IPC.convClear),
    pin: (id: string, pinned: boolean) => ipcRenderer.invoke(IPC.convPin, { id, pinned }),
    exportMarkdown: (id: string) => ipcRenderer.invoke(IPC.convExport, id),
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList),
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.mcpList),
    tools: () => ipcRenderer.invoke(IPC.mcpTools),
    add: (cfg: McpServerConfig) => ipcRenderer.invoke(IPC.mcpAdd, cfg),
    remove: (id: string) => ipcRenderer.invoke(IPC.mcpRemove, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.mcpToggle, { id, enabled }),
    connect: (id: string) => ipcRenderer.invoke(IPC.mcpConnect, id),
    call: (serverId, tool, args) => ipcRenderer.invoke(IPC.mcpCall, { serverId, tool, args }),
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.taskList),
    save: (task: ScheduledTask) => ipcRenderer.invoke(IPC.taskSave, task),
    remove: (id: string) => ipcRenderer.invoke(IPC.taskRemove, id),
    run: (id: string) => ipcRenderer.invoke(IPC.taskRun, id),
    history: () => ipcRenderer.invoke(IPC.taskHistory),
  },
  knowledge: {
    list: () => ipcRenderer.invoke(IPC.kbList),
    addSource: (path: string, watch = true) => ipcRenderer.invoke(IPC.kbAddSource, { path, watch }),
    remove: (id: string) => ipcRenderer.invoke(IPC.kbRemove, id),
    reindex: (id?: string) => ipcRenderer.invoke(IPC.kbReindex, id),
    search: (query: string, topK?: number) => ipcRenderer.invoke(IPC.kbSearch, { query, topK }),
    stats: () => ipcRenderer.invoke(IPC.kbStats),
  },
  memory: {
    list: () => ipcRenderer.invoke(IPC.memoryList),
    add: (fact) => ipcRenderer.invoke(IPC.memoryAdd, fact),
    forget: (id: string) => ipcRenderer.invoke(IPC.memoryForget, id),
    clear: () => ipcRenderer.invoke(IPC.memoryClear),
  },
  update: {
    check: (force?: boolean) => ipcRenderer.invoke(IPC.updateCheck, force),
    open: () => ipcRenderer.invoke(IPC.updateOpen),
  },
  events: {
    onRun: (cb) => on<RunEvent>(EVT.run, cb),
    onApproval: (cb) => on<ApprovalRequest>(EVT.approval, cb),
    onToast: (cb) => on<ToastPayload>(EVT.toast, cb),
    onTasksChanged: (cb) => on<ScheduledTask[]>(EVT.tasksChanged, cb),
    onMcpChanged: (cb) => on(EVT.mcpChanged, cb),
    onKnowledgeChanged: (cb) => on<KnowledgeSource[]>(EVT.kbChanged, cb),
    onUpdateAvailable: (cb) => on<UpdateInfo>(EVT.updateAvailable, cb),
    onSettingsChanged: (cb) => on<Settings>(EVT.settingsChanged, cb),
    onSystemTheme: (cb) => on<'dark' | 'light'>(EVT.systemTheme, cb),
  },
};

contextBridge.exposeInMainWorld('runworker', api);

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { DeepPartial } from '@shared/ipc';
import type {
  AgentDescriptor,
  AgentId,
  AppInfo,
  ApprovalRequest,
  Attachment,
  ChatMessage,
  Citation,
  Conversation,
  ConversationMeta,
  KnowledgeHit,
  KnowledgeSource,
  McpServerStatus,
  McpToolInfo,
  MemoryFact,
  ProviderPreset,
  RunEvent,
  ScheduledTask,
  Settings,
  TaskRun,
  ToastPayload,
  UpdateInfo,
  UpdateProgress,
  UsageStats,
  Workspace,
} from '@shared/types';
import { createDefaultSettings } from '@shared/presets';
import { api } from '../lib/bridge';
import { shortTitle, uid } from '../lib/format';

export type View = 'chat' | 'agents' | 'tasks' | 'kb' | 'mcp' | 'memory';

export interface RunInfo {
  runId: string;
  conversationId: string;
  messageId: string;
  startedAt: number;
  endedAt?: number;
  agentId: AgentId;
  model: string;
  status: 'running' | 'done' | 'error' | 'aborted';
  routing?: { from: AgentId; to: AgentId; reason: string };
  langNote?: { ratio: number; rewritten: boolean };
}

export interface ToastItem extends ToastPayload {
  id: string;
}

export interface UiState {
  sidebarCollapsed: boolean;
  railOpen: boolean;
}

export interface AppState {
  ready: boolean;
  settings: Settings;
  app: AppInfo | null;
  agents: AgentDescriptor[];
  presets: ProviderPreset[];
  metas: ConversationMeta[];
  conversations: Record<string, Conversation>;
  activeId: string | null;
  workspaces: Workspace[];
  /** 新对话默认固定到的工作区；null 表示不固定 */
  activeWorkspaceId: string | null;
  view: View;
  ui: UiState;
  runs: Record<string, RunInfo>;
  approvals: ApprovalRequest[];
  tasks: ScheduledTask[];
  taskHistory: TaskRun[];
  knowledge: KnowledgeSource[];
  memory: MemoryFact[];
  mcp: McpServerStatus[];
  mcpTools: McpToolInfo[];
  updateInfo: UpdateInfo | null;
  /** 应用内一键升级进度 */
  updateProgress: UpdateProgress | null;
  /** 启动失败原因（空表示正常） */
  bootError: string | null;
  /** 「本次更新」面板 */
  releaseNotesOpen: boolean;
  toasts: ToastItem[];
  settingsOpen: boolean;
  query: string;
  systemTheme: 'dark' | 'light';
  loadingConversation: boolean;
}

const initialState: AppState = {
  ready: false,
  settings: createDefaultSettings(),
  app: null,
  agents: [],
  presets: [],
  metas: [],
  conversations: {},
  activeId: null,
  workspaces: [],
  activeWorkspaceId: null,
  view: 'chat',
  ui: { sidebarCollapsed: false, railOpen: true },
  runs: {},
  approvals: [],
  tasks: [],
  taskHistory: [],
  knowledge: [],
  memory: [],
  mcp: [],
  mcpTools: [],
  updateInfo: null,
  updateProgress: null,
  bootError: null,
  releaseNotesOpen: false,
  toasts: [],
  settingsOpen: false,
  query: '',
  systemTheme: 'dark',
  loadingConversation: false,
};

type Action =
  | { type: 'BOOTSTRAP'; payload: Awaited<ReturnType<typeof api.bootstrap>>; ui: UiState; systemTheme: 'dark' | 'light' }
  | { type: 'BOOTSTRAP_ERROR'; message: string }
  | { type: 'SET_SETTINGS'; settings: Settings }
  | { type: 'SET_VIEW'; view: View }
  | { type: 'SET_UI'; patch: Partial<UiState> }
  | { type: 'SET_ACTIVE'; id: string | null }
  | { type: 'SET_LOADING_CONV'; loading: boolean }
  | { type: 'LOAD_CONV'; conversation: Conversation }
  | { type: 'UPSERT_CONV'; conversation: Conversation }
  | { type: 'PATCH_CONV'; id: string; patch: Partial<Conversation> }
  | { type: 'REMOVE_CONV'; id: string }
  | { type: 'CLEAR_CONVS' }
  | { type: 'SET_METAS'; metas: ConversationMeta[]; conversations?: Record<string, Conversation> }
  | { type: 'ADD_MESSAGE'; convId: string; message: ChatMessage }
  | { type: 'PATCH_MESSAGE'; convId: string; messageId: string; patch: Partial<ChatMessage> }
  | { type: 'SET_RUN'; run: RunInfo }
  | { type: 'RUN_EVENT'; event: RunEvent }
  | { type: 'END_RUN'; runId: string; status: RunInfo['status'] }
  | { type: 'APPROVAL_ADD'; request: ApprovalRequest }
  | { type: 'APPROVAL_REMOVE'; id: string }
  | { type: 'SET_TASKS'; tasks: ScheduledTask[] }
  | { type: 'SET_TASK_HISTORY'; runs: TaskRun[] }
  | { type: 'SET_KB'; sources: KnowledgeSource[] }
  | { type: 'SET_MEMORY'; facts: MemoryFact[] }
  | { type: 'SET_MCP'; servers: McpServerStatus[] }
  | { type: 'SET_MCP_TOOLS'; tools: McpToolInfo[] }
  | { type: 'SET_UPDATE'; info: UpdateInfo | null }
  | { type: 'SET_UPDATE_PROGRESS'; progress: UpdateProgress | null }
  | { type: 'SET_RELEASE_NOTES_OPEN'; open: boolean }
  | { type: 'TOAST_ADD'; toast: ToastItem }
  | { type: 'TOAST_REMOVE'; id: string }
  | { type: 'SET_SETTINGS_OPEN'; open: boolean }
  | { type: 'SET_SYSTEM_THEME'; theme: 'dark' | 'light' }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_WORKSPACES'; workspaces: Workspace[] }
  | { type: 'SET_ACTIVE_WORKSPACE'; id: string | null };

function withMessage(conv: Conversation, messageId: string, fn: (m: ChatMessage) => ChatMessage): Conversation {
  let changed = false;
  const messages = conv.messages.map((m) => {
    if (m.id !== messageId) return m;
    changed = true;
    return fn(m);
  });
  return changed ? { ...conv, messages } : conv;
}

function syncMeta(metas: ConversationMeta[], conv: Conversation): ConversationMeta[] {
  const last = [...conv.messages].reverse().find((m) => m.role === 'assistant' || m.role === 'user');
  const meta: ConversationMeta = {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pinned: conv.pinned,
    messageCount: conv.messages.length,
    agentId: conv.agentId,
    usage: conv.usage,
    preview: last?.content.replace(/\s+/g, ' ').slice(0, 80) ?? conv.preview,
    workspaceId: conv.workspaceId,
  };
  const idx = metas.findIndex((m) => m.id === conv.id);
  const next = idx >= 0 ? metas.map((m) => (m.id === conv.id ? meta : m)) : [meta, ...metas];
  return [...next].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function resolveRun(state: AppState, runId: string, conversationId?: string): { info?: RunInfo; convId?: string; messageId?: string } {
  const info = state.runs[runId];
  if (info) return { info, convId: info.conversationId, messageId: info.messageId };
  // SET_RUN 可能晚于首批 SSE 事件到达，此时才回退到 streaming 占位消息。
  // 必须全局唯一才认，否则两条并发 run 的内容会串到同一条消息上。
  const candidates: Array<{ convId: string; messageId: string }> = [];
  for (const [id, conv] of Object.entries(state.conversations)) {
    if (conversationId && id !== conversationId) continue;
    if (!conv) continue;
    const streaming = [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming');
    if (streaming) candidates.push({ convId: id, messageId: streaming.id });
  }
  return candidates.length === 1 ? candidates[0] : {};
}

function applyRunEvent(state: AppState, e: RunEvent): AppState {
  if (e.type === 'run:notice') {
    const kind: ToastItem['kind'] = e.level === 'warn' ? 'warn' : e.level;
    return {
      ...state,
      toasts: [...state.toasts, { id: uid('toast'), kind, text: e.text }].slice(-4),
    };
  }
  if (e.type === 'run:start') {
    const found = resolveRun(state, e.runId, e.conversationId);
    const conv = state.conversations[e.conversationId];
    if (!conv || !found.messageId) {
      // 定时任务/后台 run 的目标会话尚未加载：不要写 messageId:'' 的孤儿 run，
      // 否则后续事件全被守卫丢弃，界面会永久卡在「执行中」。用户点开该会话时会读到落库正文。
      return state;
    }
    const nextConv = withMessage(conv, found.messageId, (m) => ({
      ...m,
      agentId: e.agentId,
      model: e.model,
      status: 'streaming',
      createdAt: m.createdAt,
    }));
    const conversations = { ...state.conversations, [conv.id]: nextConv };
    return {
      ...state,
      conversations,
      metas: syncMeta(state.metas, nextConv),
      runs: {
        ...state.runs,
        [e.runId]: {
          runId: e.runId,
          conversationId: e.conversationId,
          messageId: found.messageId,
          startedAt: e.at,
          agentId: e.agentId,
          model: e.model,
          status: 'running',
          routing: found.info?.routing,
        },
      },
    };
  }

  const found = resolveRun(state, e.runId);
  if (e.type === 'run:end' && (!found.convId || !found.messageId || !state.conversations[found.convId])) {
    // 即使找不到占位消息，也要把该 run 残留的授权请求清掉
    return { ...state, approvals: state.approvals.filter((a) => a.runId !== e.runId) };
  }
  if (!found.convId || !found.messageId) return state;
  const conv = state.conversations[found.convId];
  if (!conv) return state;

  const patchRun = (patch: Partial<RunInfo>): Record<string, RunInfo> => {
    const current = state.runs[e.runId] ?? {
      runId: e.runId,
      conversationId: found.convId as string,
      messageId: found.messageId as string,
      startedAt: Date.now(),
      agentId: conv.agentId,
      model: conv.messages.find((m) => m.id === found.messageId)?.model ?? '',
      status: 'running' as const,
    };
    return { ...state.runs, [e.runId]: { ...current, ...patch } };
  };

  let nextConv = conv;
  let runs = state.runs;

  switch (e.type) {
    case 'run:routing': {
      nextConv = withMessage(conv, found.messageId, (m) => ({ ...m, agentId: e.to }));
      runs = patchRun({ routing: { from: e.from, to: e.to, reason: e.reason }, agentId: e.to });
      break;
    }
    case 'run:thinking': {
      nextConv = withMessage(conv, found.messageId, (m) => ({ ...m, thinking: `${m.thinking ?? ''}${e.delta}` }));
      break;
    }
    case 'run:thinking-lang': {
      runs = patchRun({ langNote: { ratio: e.ratio, rewritten: e.rewritten } });
      break;
    }
    case 'run:content': {
      nextConv = withMessage(conv, found.messageId, (m) => ({ ...m, content: `${m.content}${e.delta}` }));
      break;
    }
    case 'run:tool': {
      nextConv = withMessage(conv, found.messageId, (m) => {
        const list = m.toolCalls ? [...m.toolCalls] : [];
        const idx = list.findIndex((c) => c.id === e.call.id);
        if (idx >= 0) list[idx] = e.call;
        else list.push(e.call);
        return { ...m, toolCalls: list };
      });
      break;
    }
    case 'run:citation': {
      nextConv = withMessage(conv, found.messageId, (m) => {
        const existing = m.citations ?? [];
        const merged: Citation[] = [...existing];
        for (const c of e.citations) {
          const key = `${c.sourcePath}#${c.title}`;
          if (!merged.some((x) => `${x.sourcePath}#${x.title}` === key)) merged.push(c);
        }
        return { ...m, citations: merged };
      });
      break;
    }
    case 'run:usage': {
      nextConv = withMessage(conv, found.messageId, (m) => ({ ...m, usage: e.usage }));
      nextConv = { ...nextConv, usage: e.conversationUsage };
      break;
    }
    case 'run:step': {
      // 多步工具调用进入下一轮：清掉上一轮的过渡文本，避免界面把中间轮和最终答案拼在一起
      nextConv = withMessage(conv, found.messageId, (m) => ({ ...m, content: '', thinking: '' }));
      break;
    }
    case 'run:end': {
      const status: ChatMessage['status'] = e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : 'aborted';
      // 保持本地消息 id 不变：替换 id 会让整棵子树按新 key 重挂载，用户展开的参数/思考面板会突然收起
      nextConv = withMessage(conv, found.messageId, (m) => ({
        ...m,
        status,
        error: e.error ?? m.error,
      }));
      runs = patchRun({ status: e.status, endedAt: Date.now() });
      break;
    }
    default:
      return state;
  }

  nextConv = { ...nextConv, updatedAt: Date.now() };
  return {
    ...state,
    conversations: { ...state.conversations, [nextConv.id]: nextConv },
    metas: syncMeta(state.metas, nextConv),
    runs,
    approvals: e.type === 'run:end' ? state.approvals.filter((a) => a.runId !== e.runId) : state.approvals,
  };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'BOOTSTRAP': {
      const p = action.payload;
      const conversations: Record<string, Conversation> = {};
      return {
        ...state,
        ready: true,
        settings: p.settings,
        app: p.app,
        agents: p.agents,
        presets: p.providers,
        metas: p.conversations,
        workspaces: p.workspaces ?? [],
        tasks: p.tasks,
        knowledge: p.knowledge,
        memory: p.memory,
        mcp: p.mcp,
        updateInfo: p.update,
        conversations,
        ui: action.ui,
        systemTheme: action.systemTheme,
      };
    }
    case 'BOOTSTRAP_ERROR':
      return { ...state, ready: true, bootError: action.message };
    case 'SET_SETTINGS':
      return { ...state, settings: action.settings };
    case 'SET_VIEW':
      return { ...state, view: action.view, settingsOpen: false };
    case 'SET_UI':
      return { ...state, ui: { ...state.ui, ...action.patch } };
    case 'SET_ACTIVE':
      return { ...state, activeId: action.id, view: 'chat', query: '' };
    case 'SET_LOADING_CONV':
      return { ...state, loadingConversation: action.loading };
    case 'LOAD_CONV': {
      const conversation = action.conversation;
      return {
        ...state,
        conversations: { ...state.conversations, [conversation.id]: conversation },
        metas: syncMeta(state.metas, conversation),
        loadingConversation: false,
      };
    }
    case 'UPSERT_CONV': {
      const conversation = action.conversation;
      return {
        ...state,
        conversations: { ...state.conversations, [conversation.id]: conversation },
        metas: syncMeta(state.metas, conversation),
        activeId: conversation.id,
        view: 'chat',
        query: '',
      };
    }
    case 'PATCH_CONV': {
      const conv = state.conversations[action.id];
      if (!conv) return state;
      const nextConv = { ...conv, ...action.patch };
      return {
        ...state,
        conversations: { ...state.conversations, [nextConv.id]: nextConv },
        metas: syncMeta(state.metas, nextConv),
      };
    }
    case 'REMOVE_CONV': {
      const conversations = { ...state.conversations };
      delete conversations[action.id];
      // 连同该会话的在途 run 与授权请求一起清掉，避免留下永久 running 的孤儿
      const runIds = Object.values(state.runs)
        .filter((r) => r.conversationId === action.id)
        .map((r) => r.runId);
      const runs = { ...state.runs };
      for (const id of runIds) delete runs[id];
      return {
        ...state,
        conversations,
        metas: state.metas.filter((m) => m.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
        runs,
        approvals: state.approvals.filter((a) => !runIds.includes(a.runId)),
      };
    }
    case 'CLEAR_CONVS':
      return {
        ...state,
        conversations: {},
        metas: [],
        activeId: null,
        runs: {},
        approvals: [],
      };
    case 'SET_METAS': {
      const conversations = { ...state.conversations };
      for (const meta of action.metas) {
        const existing = conversations[meta.id];
        if (existing) conversations[meta.id] = { ...existing, ...meta };
      }
      return { ...state, metas: action.metas, conversations: { ...conversations, ...(action.conversations ?? {}) } };
    }
    case 'ADD_MESSAGE': {
      const conv = state.conversations[action.convId];
      if (!conv) return state;
      const nextConv: Conversation = {
        ...conv,
        messages: [...conv.messages, action.message],
        messageCount: conv.messages.length + 1,
        updatedAt: Date.now(),
        agentId: action.message.agentId ?? conv.agentId,
      };
      return {
        ...state,
        conversations: { ...state.conversations, [conv.id]: nextConv },
        metas: syncMeta(state.metas, nextConv),
      };
    }
    case 'PATCH_MESSAGE': {
      const conv = state.conversations[action.convId];
      if (!conv) return state;
      const nextConv = withMessage(conv, action.messageId, (m) => ({ ...m, ...action.patch }));
      return {
        ...state,
        conversations: { ...state.conversations, [conv.id]: nextConv },
        metas: syncMeta(state.metas, nextConv),
      };
    }
    case 'SET_RUN':
      return { ...state, runs: { ...state.runs, [action.run.runId]: action.run } };
    case 'RUN_EVENT':
      return applyRunEvent(state, action.event);
    case 'END_RUN': {
      const info = state.runs[action.runId];
      if (!info) return state;
      return { ...state, runs: { ...state.runs, [action.runId]: { ...info, status: action.status } } };
    }
    case 'APPROVAL_ADD':
      return { ...state, approvals: [...state.approvals.filter((a) => a.id !== action.request.id), action.request] };
    case 'APPROVAL_REMOVE':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case 'SET_TASKS':
      return { ...state, tasks: action.tasks };
    case 'SET_TASK_HISTORY':
      return { ...state, taskHistory: action.runs };
    case 'SET_KB':
      return { ...state, knowledge: action.sources };
    case 'SET_MEMORY':
      return { ...state, memory: action.facts };
    case 'SET_MCP':
      return { ...state, mcp: action.servers };
    case 'SET_MCP_TOOLS':
      return { ...state, mcpTools: action.tools };
    case 'SET_UPDATE':
      return { ...state, updateInfo: action.info };
    case 'SET_UPDATE_PROGRESS':
      return { ...state, updateProgress: action.progress };
    case 'SET_RELEASE_NOTES_OPEN':
      return { ...state, releaseNotesOpen: action.open };
    case 'TOAST_ADD':
      return { ...state, toasts: [...state.toasts.slice(-3), action.toast] };
    case 'TOAST_REMOVE':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'SET_SETTINGS_OPEN':
      return { ...state, settingsOpen: action.open };
    case 'SET_SYSTEM_THEME':
      return { ...state, systemTheme: action.theme };
    case 'SET_QUERY':
      return { ...state, query: action.query };
    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces };
    case 'SET_ACTIVE_WORKSPACE':
      return { ...state, activeWorkspaceId: action.id };
    default:
      return state;
  }
}

export interface StoreActions {
  setView(view: View): void;
  selectConversation(id: string): Promise<void>;
  newConversation(agentId?: AgentId, title?: string, workspaceId?: string): Promise<Conversation | null>;
  setActiveWorkspace(id: string | null): void;
  addWorkspace(input: { name: string; path?: string; parentId?: string }): Promise<void>;
  renameWorkspace(id: string, name: string): Promise<void>;
  removeWorkspace(id: string): Promise<void>;
  /** 把会话归入 / 移出工作区 */
  moveConversation(id: string, workspaceId: string | null): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  togglePin(id: string): Promise<void>;
  removeConversation(id: string): Promise<void>;
  /** 清空全部对话（含文件、索引、记忆、产物） */
  clearConversations(): Promise<void>;
  /** 用户纠正某条回复 → 写入长期记忆，后续提示词自动生效 */
  correctMessage(text: string, conversationId: string): Promise<void>;
  send(text: string, agentId: AgentId, attachments: Attachment[]): Promise<void>;
  stop(): Promise<void>;
  approve(requestId: string, approved: boolean, remember: boolean): void;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings | null>;
  applySettings(next: Settings): Promise<Settings | null>;
  openSettings(open: boolean): void;
  setUi(patch: Partial<UiState>): void;
  setQuery(q: string): void;
  setSystemTheme(theme: 'dark' | 'light'): void;
  toast(kind: ToastPayload['kind'], text: string): void;
  dismissToast(id: string): void;
  refreshTasks(): Promise<void>;
  saveTask(task: ScheduledTask): Promise<void>;
  removeTask(id: string): Promise<void>;
  runTask(id: string): Promise<TaskRun | null>;
  loadTaskHistory(): Promise<void>;
  addKnowledge(path: string, watch: boolean): Promise<void>;
  removeKnowledge(id: string): Promise<void>;
  reindexKnowledge(id?: string): Promise<void>;
  searchKnowledge(query: string): Promise<KnowledgeHitList>;
  addMemory(text: string, kind: MemoryFact['kind']): Promise<void>;
  forgetMemory(id: string): Promise<void>;
  clearMemory(): Promise<void>;
  addMcp(cfg: Parameters<typeof api.mcp.add>[0]): Promise<void>;
  removeMcp(id: string): Promise<void>;
  toggleMcp(id: string, enabled: boolean): Promise<void>;
  connectMcp(id: string): Promise<void>;
  refreshMcp(): Promise<void>;
  checkUpdate(force: boolean): Promise<UpdateInfo | null>;
  /** 应用内一键升级 */
  installUpdate(): Promise<void>;
  setReleaseNotesOpen(open: boolean): void;
  saveSettingsDraft(next: Settings): Promise<void>;
}

type KnowledgeHitList = KnowledgeHit[];

const StoreContext = createContext<{ state: AppState; actions: StoreActions } | null>(null);

const LS_UI = 'runworker.ui.v1';

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(LS_UI);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>;
      return { sidebarCollapsed: Boolean(parsed.sidebarCollapsed), railOpen: parsed.railOpen !== false };
    }
  } catch {
    /* ignore */
  }
  return { sidebarCollapsed: false, railOpen: true };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  /* 首次加载：拉取引导数据 + 读取本地界面偏好 */
  useEffect(() => {
    let alive = true;
    const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const systemTheme = mq?.matches ? 'dark' : 'light';
    api
      .bootstrap()
      .then((payload) => {
        if (!alive) return;
        dispatch({ type: 'BOOTSTRAP', payload, ui: loadUi(), systemTheme });
        api.mcp.tools().then((tools) => dispatch({ type: 'SET_MCP_TOOLS', tools })).catch(() => undefined);
        api.tasks
          .history()
          .then((runs) => dispatch({ type: 'SET_TASK_HISTORY', runs }))
          .catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const message = `初始化失败：${err instanceof Error ? err.message : String(err)}`;
        // ready 必须置 true，否则应用会永久停在启动画面且错误 toast 根本不渲染
        dispatch({ type: 'BOOTSTRAP_ERROR', message });
        dispatch({ type: 'TOAST_ADD', toast: { id: uid('toast'), kind: 'error', text: message } });
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 主进程事件订阅 */
  useEffect(() => {
    const offs = [
      api.events.onRun((event) => {
        dispatch({ type: 'RUN_EVENT', event });
        if (event.type === 'run:end') {
          // 定时任务/后台 run 的消息落在主进程，已打开的会话要重新读一次正文
          const convId = stateRef.current.runs[event.runId]?.conversationId;
          if (convId && stateRef.current.conversations[convId]) {
            api.conversations
              .get(convId)
              .then((conv) => {
                if (conv) dispatch({ type: 'LOAD_CONV', conversation: conv });
              })
              .catch(() => undefined);
          }
          api.conversations
            .list()
            .then((metas) => dispatch({ type: 'SET_METAS', metas }))
            .catch(() => undefined);
          api.tasks
            .list()
            .then((tasks) => dispatch({ type: 'SET_TASKS', tasks }))
            .catch(() => undefined);
        }
      }),
      api.events.onApproval((request) => dispatch({ type: 'APPROVAL_ADD', request })),
      api.events.onToast((t) => dispatch({ type: 'TOAST_ADD', toast: { id: uid('toast'), kind: t.kind, text: t.text } })),
      api.events.onTasksChanged((tasks) => dispatch({ type: 'SET_TASKS', tasks })),
      api.events.onMcpChanged((servers) => {
        dispatch({ type: 'SET_MCP', servers });
        api.mcp.tools().then((tools) => dispatch({ type: 'SET_MCP_TOOLS', tools })).catch(() => undefined);
      }),
      api.events.onKnowledgeChanged((sources) => dispatch({ type: 'SET_KB', sources })),
      api.events.onUpdateAvailable((info) => dispatch({ type: 'SET_UPDATE', info })),
      api.events.onUpdateProgress((progress) => {
        dispatch({ type: 'SET_UPDATE_PROGRESS', progress });
        if (progress.stage === 'error' || progress.stage === 'installing' || progress.stage === 'done') {
          dispatch({
            type: 'TOAST_ADD',
            toast: { id: uid('toast'), kind: progress.stage === 'error' ? 'error' : 'info', text: progress.text },
          });
        }
      }),
      api.events.onSettingsChanged((settings) => dispatch({ type: 'SET_SETTINGS', settings })),
      api.events.onSystemTheme((mode) => {
        dispatch({ type: 'SET_SYSTEM_THEME', theme: mode });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  /* 界面偏好持久化 */
  useEffect(() => {
    try {
      localStorage.setItem(LS_UI, JSON.stringify(state.ui));
    } catch {
      /* ignore */
    }
  }, [state.ui]);

  const actions = useMemo<StoreActions>(() => {
    const toast = (kind: ToastPayload['kind'], text: string): void => {
      dispatch({ type: 'TOAST_ADD', toast: { id: uid('toast'), kind, text } });
    };

    return {
      setView: (view) => dispatch({ type: 'SET_VIEW', view }),
      setUi: (patch) => dispatch({ type: 'SET_UI', patch }),
      setQuery: (query) => dispatch({ type: 'SET_QUERY', query }),
      setSystemTheme: (theme) => dispatch({ type: 'SET_SYSTEM_THEME', theme }),
      openSettings: (open) => dispatch({ type: 'SET_SETTINGS_OPEN', open }),
      setReleaseNotesOpen: (open) => dispatch({ type: 'SET_RELEASE_NOTES_OPEN', open }),
      toast,
      dismissToast: (id) => dispatch({ type: 'TOAST_REMOVE', id }),

      selectConversation: async (id) => {
        const prev = stateRef.current;
        if (prev.activeId && prev.activeId !== id) {
          const running = Object.values(prev.runs).find((r) => r.status === 'running' && r.conversationId === prev.activeId);
          if (running) {
            api.chat.abort(running.runId).catch(() => {});
            // 乐观回滚：主进程的 run:end 可能延迟或丢失，不能让输入框一直锁在「停止」
            dispatch({ type: 'END_RUN', runId: running.runId, status: 'aborted' });
            if (running.messageId) {
              dispatch({
                type: 'PATCH_MESSAGE',
                convId: running.conversationId,
                messageId: running.messageId,
                patch: { status: 'aborted' },
              });
            }
          }
        }
        dispatch({ type: 'SET_ACTIVE', id });
        if (stateRef.current.conversations[id]) return;
        dispatch({ type: 'SET_LOADING_CONV', loading: true });
        try {
          const conv = await api.conversations.get(id);
          if (conv) dispatch({ type: 'LOAD_CONV', conversation: conv });
          else dispatch({ type: 'SET_LOADING_CONV', loading: false });
        } catch (err) {
          dispatch({ type: 'SET_LOADING_CONV', loading: false });
          toast('error', `读取对话失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      newConversation: async (agentId, title, workspaceId) => {
        try {
          const bind = workspaceId ?? stateRef.current.activeWorkspaceId ?? undefined;
          const conv = await api.conversations.create(title, bind);
          const next = agentId ? { ...conv, agentId } : conv;
          dispatch({ type: 'UPSERT_CONV', conversation: next });
          if (agentId) {
            const agent = stateRef.current.agents.find((a) => a.id === agentId);
            if (agent) toast('info', `已切换到 ${agent.name}`);
          }
          return next;
        } catch (err) {
          toast('error', `新建对话失败：${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },

      setActiveWorkspace: (id) => dispatch({ type: 'SET_ACTIVE_WORKSPACE', id }),

      addWorkspace: async (input) => {
        try {
          const workspaces = await api.workspaces.add(input);
          dispatch({ type: 'SET_WORKSPACES', workspaces });
          toast('success', `工作区「${input.name}」已添加`);
        } catch (err) {
          toast('error', `添加工作区失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      renameWorkspace: async (id, name) => {
        try {
          const workspaces = await api.workspaces.rename(id, name);
          dispatch({ type: 'SET_WORKSPACES', workspaces });
        } catch (err) {
          toast('error', `重命名失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      removeWorkspace: async (id) => {
        try {
          const workspaces = await api.workspaces.remove(id);
          dispatch({ type: 'SET_WORKSPACES', workspaces });
          const metas = await api.conversations.list();
          dispatch({ type: 'SET_METAS', metas });
          if (stateRef.current.activeWorkspaceId === id) dispatch({ type: 'SET_ACTIVE_WORKSPACE', id: null });
          toast('success', '工作区已移除，文件夹本身保留在磁盘上');
        } catch (err) {
          toast('error', `移除工作区失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      moveConversation: async (id, workspaceId) => {
        try {
          await api.conversations.move(id, workspaceId);
          const metas = await api.conversations.list();
          dispatch({ type: 'SET_METAS', metas });
          const conv = await api.conversations.get(id);
          if (conv) dispatch({ type: 'LOAD_CONV', conversation: conv });
          toast('success', workspaceId ? '已移入工作区' : '已移出工作区');
        } catch (err) {
          toast('error', `移动对话失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      renameConversation: async (id, title) => {
        const clean = title.trim();
        if (!clean) return;
        await api.conversations.rename(id, clean);
        dispatch({ type: 'PATCH_CONV', id, patch: { title: clean } });
      },

      togglePin: async (id) => {
        const conv = stateRef.current.conversations[id];
        const meta = stateRef.current.metas.find((m) => m.id === id);
        const next = !(conv?.pinned ?? meta?.pinned ?? false);
        await api.conversations.pin(id, next);
        const metas = await api.conversations.list();
        dispatch({ type: 'SET_METAS', metas });
        if (conv) dispatch({ type: 'PATCH_CONV', id, patch: { pinned: next } });
        toast('success', next ? '已置顶对话' : '已取消置顶');
      },

      removeConversation: async (id) => {
        try {
          // 先停掉在途 run，避免删除后还有事件涌向已不存在的会话
          const running = Object.values(stateRef.current.runs).filter(
            (r) => r.status === 'running' && r.conversationId === id,
          );
          for (const r of running) api.chat.abort(r.runId).catch(() => {});
          const report = await api.conversations.remove(id);
          dispatch({ type: 'REMOVE_CONV', id });
          const parts: string[] = [];
          if (report?.files) parts.push(`${report.files} 个会话文件`);
          if (report?.artifacts) parts.push(`${report.artifacts} 个产物文件`);
          if (report?.memories) parts.push(`${report.memories} 条派生记忆`);
          if (report?.runs) parts.push(`${report.runs} 个在途任务`);
          const detail = parts.length ? `（已擦除 ${parts.join('、')}）` : '';
          toast('success', `对话已彻底删除${detail}`);
          if (report?.failed?.length) {
            toast('warn', `有 ${report.failed.length} 个文件被占用未能删除，请关闭相关程序后重试。`);
          }
        } catch (err) {
          toast('error', `删除失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      clearConversations: async () => {
        try {
          const report = await api.conversations.clear();
          dispatch({ type: 'CLEAR_CONVS' });
          const parts: string[] = [];
          if (report?.files) parts.push(`${report.files} 个会话文件`);
          if (report?.artifacts) parts.push(`${report.artifacts} 个产物文件`);
          if (report?.memories) parts.push(`${report.memories} 条派生记忆`);
          if (report?.runs) parts.push(`${report.runs} 个在途任务`);
          toast('success', `全部对话已彻底清空${parts.length ? `（${parts.join('、')}）` : ''}`);
          if (report?.failed?.length) {
            toast('warn', `有 ${report.failed.length} 个文件被占用未能删除，请关闭相关程序后重试。`);
          }
        } catch (err) {
          toast('error', `清空失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      correctMessage: async (text, conversationId) => {
        const clean = text.trim();
        if (!clean) return;
        try {
          // 纠正写成「要求」类强指令，并在系统提示里获得最高优先级；
          // 带会话来源，彻底删除该对话时会一并清掉。
          const facts = await api.memory.add({
            text: clean,
            kind: 'instruction',
            weight: 0.9,
            source: `feedback:${conversationId}`,
          });
          dispatch({ type: 'SET_MEMORY', facts });
          toast('success', '已记住这条纠正，之后的回复会按它执行');
        } catch (err) {
          toast('error', `保存纠正失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      send: async (text, agentId, attachments) => {
        const clean = text.trim();
        if (!clean) return;
        const snapshot = stateRef.current;
        // store 层统一守卫：Composer 的组件级 running 挡不住建议卡/重试等入口的连点
        if (Object.values(snapshot.runs).some((r) => r.status === 'running' && r.conversationId === snapshot.activeId)) {
          toast('warn', '当前对话正在执行，请等待完成或点击停止');
          return;
        }
        let convId = snapshot.activeId;
        if (!convId || !snapshot.conversations[convId]) {
          try {
            const conv = await api.conversations.create(shortTitle(clean), stateRef.current.activeWorkspaceId ?? undefined);
            dispatch({ type: 'UPSERT_CONV', conversation: conv });
            convId = conv.id;
          } catch (err) {
            toast('error', `新建对话失败：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
        const now = Date.now();
        const snapshotConv = stateRef.current.conversations[convId];
        if (snapshotConv && (!snapshotConv.title || snapshotConv.title === '新对话')) {
          dispatch({ type: 'PATCH_CONV', id: convId, patch: { title: shortTitle(clean) } });
        }
        const userMessage: ChatMessage = {
          id: uid('u'),
          role: 'user',
          content: clean,
          createdAt: now,
          attachments: attachments.length ? attachments : undefined,
        };
        const placeholderId = uid('a');
        const placeholder: ChatMessage = {
          id: placeholderId,
          role: 'assistant',
          content: '',
          thinking: '',
          createdAt: now + 1,
          agentId,
          model: snapshot.settings.activeModel,
          providerId: snapshot.settings.activeProviderId,
          status: 'streaming',
          toolCalls: [],
        };
        dispatch({ type: 'ADD_MESSAGE', convId, message: userMessage });
        dispatch({ type: 'ADD_MESSAGE', convId, message: placeholder });
        try {
          const res = await api.chat.send({
            conversationId: convId,
            text: clean,
            agentId,
            attachments: attachments.length ? attachments : undefined,
          });
          dispatch({
            type: 'SET_RUN',
            run: {
              runId: res.runId,
              conversationId: res.conversationId,
              messageId: placeholderId,
              startedAt: Date.now(),
              agentId,
              model: snapshot.settings.activeModel,
              status: 'running',
            },
          });
        } catch (err) {
          dispatch({
            type: 'PATCH_MESSAGE',
            convId,
            messageId: placeholderId,
            patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
          });
          toast('error', '发送失败，请检查模型配置');
        }
      },

      stop: async () => {
        const snapshot = stateRef.current;
        const run = Object.values(snapshot.runs).find((r) => r.status === 'running' && r.conversationId === snapshot.activeId);
        // 找不到本会话的 run 时绝不调用 abort(undefined)：主进程会把它当成「中止全部任务」
        if (!run) return;
        dispatch({ type: 'END_RUN', runId: run.runId, status: 'aborted' });
        if (run.messageId) {
          dispatch({
            type: 'PATCH_MESSAGE',
            convId: run.conversationId,
            messageId: run.messageId,
            patch: { status: 'aborted' },
          });
        }
        try {
          await api.chat.abort(run.runId);
        } catch {
          toast('warn', '停止请求未送达，界面已先停止接收输出');
        }
      },

      approve: (requestId, approved, remember) => {
        dispatch({ type: 'APPROVAL_REMOVE', id: requestId });
        api.chat.approve(requestId, approved, remember).catch(() => {
          toast('error', '授权结果回传失败');
        });
        toast(approved ? 'success' : 'info', approved ? (remember ? '已允许，并记住同类操作' : '已允许本次调用') : '已拒绝本次调用');
      },

      updateSettings: async (patch) => {
        try {
          const settings = await api.settings.update(patch);
          dispatch({ type: 'SET_SETTINGS', settings });
          return settings;
        } catch (err) {
          toast('error', `保存设置失败：${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },

      applySettings: async (next) => {
        try {
          const settings = await api.settings.update(next);
          dispatch({ type: 'SET_SETTINGS', settings });
          return settings;
        } catch (err) {
          toast('error', `保存设置失败：${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },

      saveSettingsDraft: async (next) => {
        try {
          const settings = await api.settings.update(next);
          dispatch({ type: 'SET_SETTINGS', settings });
          dispatch({ type: 'SET_SETTINGS_OPEN', open: false });
          toast('success', '设置已保存并应用');
        } catch (err) {
          toast('error', `保存设置失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },

      refreshTasks: async () => {
        const tasks = await api.tasks.list();
        dispatch({ type: 'SET_TASKS', tasks });
      },
      saveTask: async (task) => {
        const tasks = await api.tasks.save(task);
        dispatch({ type: 'SET_TASKS', tasks });
        toast('success', '定时任务已保存');
      },
      removeTask: async (id) => {
        const tasks = await api.tasks.remove(id);
        dispatch({ type: 'SET_TASKS', tasks });
        toast('success', '定时任务已删除');
      },
      runTask: async (id) => {
        try {
          const run = await api.tasks.run(id);
          dispatch({ type: 'SET_TASK_HISTORY', runs: await api.tasks.history() });
          toast(run.status === 'success' ? 'success' : 'error', run.status === 'success' ? '任务执行完成' : '任务执行失败');
          return run;
        } catch (err) {
          toast('error', `执行失败：${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
      loadTaskHistory: async () => {
        const runs = await api.tasks.history();
        dispatch({ type: 'SET_TASK_HISTORY', runs });
      },

      addKnowledge: async (path, watch) => {
        try {
          const sources = await api.knowledge.addSource(path, watch);
          dispatch({ type: 'SET_KB', sources });
          toast('info', '已加入索引队列，正在解析分块');
        } catch (err) {
          toast('error', `添加失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      removeKnowledge: async (id) => {
        const sources = await api.knowledge.remove(id);
        dispatch({ type: 'SET_KB', sources });
        toast('success', '来源已移除');
      },
      reindexKnowledge: async (id) => {
        toast('info', '正在重建索引');
        await api.knowledge.reindex(id);
        dispatch({ type: 'SET_KB', sources: await api.knowledge.list() });
        toast('success', '索引已更新');
      },
      searchKnowledge: (query) => api.knowledge.search(query, 6).catch(() => []),

      addMemory: async (text, kind) => {
        const facts = await api.memory.add({ text, kind, weight: 0.7 });
        dispatch({ type: 'SET_MEMORY', facts });
        toast('success', '已加入长期记忆');
      },
      forgetMemory: async (id) => {
        const facts = await api.memory.forget(id);
        dispatch({ type: 'SET_MEMORY', facts });
        toast('info', '记忆已删除');
      },
      clearMemory: async () => {
        const facts = await api.memory.clear();
        dispatch({ type: 'SET_MEMORY', facts });
        toast('success', '长期记忆已清空');
      },

      addMcp: async (cfg) => {
        const servers = await api.mcp.add(cfg);
        dispatch({ type: 'SET_MCP', servers });
        dispatch({ type: 'SET_MCP_TOOLS', tools: await api.mcp.tools() });
      },
      removeMcp: async (id) => {
        const servers = await api.mcp.remove(id);
        dispatch({ type: 'SET_MCP', servers });
        dispatch({ type: 'SET_MCP_TOOLS', tools: await api.mcp.tools() });
        toast('success', '连接器已删除');
      },
      toggleMcp: async (id, enabled) => {
        const servers = await api.mcp.toggle(id, enabled);
        dispatch({ type: 'SET_MCP', servers });
        dispatch({ type: 'SET_MCP_TOOLS', tools: await api.mcp.tools() });
      },
      connectMcp: async (id) => {
        const servers = await api.mcp.connect(id);
        dispatch({ type: 'SET_MCP', servers });
        dispatch({ type: 'SET_MCP_TOOLS', tools: await api.mcp.tools() });
      },
      refreshMcp: async () => {
        dispatch({ type: 'SET_MCP', servers: await api.mcp.list() });
        dispatch({ type: 'SET_MCP_TOOLS', tools: await api.mcp.tools() });
      },

      checkUpdate: async (force) => {
        try {
          const info = await api.update.check(force);
          dispatch({ type: 'SET_UPDATE', info });
          return info;
        } catch (err) {
          toast('error', `检查更新失败：${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },

      installUpdate: async () => {
        dispatch({
          type: 'SET_UPDATE_PROGRESS',
          progress: { stage: 'downloading', percent: 0, text: '正在准备下载安装包…' },
        });
        try {
          const progress = await api.update.install();
          dispatch({ type: 'SET_UPDATE_PROGRESS', progress });
          if (progress.stage === 'error') toast('error', progress.text);
        } catch (err) {
          const message = `升级失败：${err instanceof Error ? err.message : String(err)}`;
          dispatch({
            type: 'SET_UPDATE_PROGRESS',
            progress: { stage: 'error', percent: 0, text: message, error: message },
          });
          toast('error', message);
        }
      },
    };
  }, []);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): { state: AppState; actions: StoreActions } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}


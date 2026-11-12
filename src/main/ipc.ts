/**
 * Run worker — IPC 注册
 * 所有 handler 统一 try/catch，错误转成中文可读提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { EVT, IPC } from '../shared/ipc';
import type { DeepPartial } from '../shared/ipc';
import { AGENTS } from '../shared/agents';
import { PROVIDER_PRESETS } from '../shared/presets';
import type {
  Attachment,
  BootstrapPayload,
  ChatSendRequest,
  McpServerConfig,
  MemoryFact,
  ProviderConfig,
  ScheduledTask,
  Settings,
} from '../shared/types';
import type { MainContext } from './chat/context';
import { testProvider, listModels } from './llm/client';

export interface IpcOptions {
  getWindow: () => BrowserWindow | null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || '';
    if (msg.includes('ENOENT')) return '文件或目录不存在，请检查路径。';
    if (msg.includes('EACCES') || msg.includes('EPERM')) return '没有权限访问该路径，请换一个目录或用管理员身份运行。';
    return msg;
  }
  return String(err);
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...(args as A));
    } catch (err) {
      throw new Error(describeError(err));
    }
  });
}

function mimeOf(file: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.csv': 'text/csv',
  };
  return map[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function pickWithDialog(win: BrowserWindow | null, options: OpenDialogOptions) {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

function toAttachment(file: string): Attachment {  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  const ext = path.extname(file).toLowerCase();
  return {
    id: `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: path.basename(file),
    path: file,
    kind: /\.(png|jpe?g|webp|gif|bmp)$/i.test(ext) ? 'image' : 'file',
    size,
    mime: mimeOf(file),
  };
}

export function registerIpc(ctx: MainContext, opts: IpcOptions): void {
  /* ------------------------------ 应用 ------------------------------ */

  handle(IPC.bootstrap, (): BootstrapPayload => {
    return {
      settings: ctx.settings(),
      providers: PROVIDER_PRESETS,
      agents: AGENTS,
      conversations: ctx.store.listConversations(),
      workspaces: ctx.store.listWorkspaces(),
      mcp: ctx.mcp.statuses(),
      tasks: ctx.scheduler.list(),
      knowledge: ctx.kb.list(),
      memory: ctx.memory.list(),
      update: ctx.updater.current(),
      app: ctx.appInfo,
    };
  });

  handle(IPC.appInfo, () => ctx.appInfo);

  handle(IPC.openExternal, async (url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('只允许打开 http/https 链接。');
    }
    await shell.openExternal(url);
  });

  handle(IPC.openPath, async (target: string) => {
    if (typeof target !== 'string' || !target.trim()) throw new Error('路径不能为空。');
    if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
    const err = await shell.openPath(target);
    if (err) throw new Error(`打不开该路径：${err}`);
  });

  handle(IPC.pickFiles, async (o?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) => {
    const win = opts.getWindow();
    const result = await pickWithDialog(win, {
      title: '选择文件',
      properties: o?.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: o?.filters && o.filters.length > 0 ? o.filters : undefined,
    });
    if (result.canceled) return [];
    return result.filePaths.map(toAttachment);
  });

  handle(IPC.pickDirectory, async () => {
    const win = opts.getWindow();
    const result = await pickWithDialog(win, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  /* ------------------------------ 窗口 ------------------------------ */

  ipcMain.on(IPC.windowMinimize, () => {
    opts.getWindow()?.minimize();
  });
  ipcMain.on(IPC.windowMaximize, () => {
    const win = opts.getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(IPC.windowClose, () => {
    opts.getWindow()?.close();
  });

  /* ------------------------------ 设置 ------------------------------ */

  handle(IPC.settingsGet, () => ctx.settings());

  handle(IPC.settingsUpdate, (patch: DeepPartial<Settings>) => {
    const next = ctx.store.updateSettings(patch);
    ctx.emit(EVT.settingsChanged, next);
    return next;
  });

  handle(IPC.settingsReset, () => {
    const next = ctx.store.resetSettings();
    ctx.emit(EVT.settingsChanged, next);
    return next;
  });

  handle(IPC.providersPresets, () => PROVIDER_PRESETS);

  handle(IPC.providerTest, async (cfg: ProviderConfig) => {
    if (!cfg || typeof cfg.baseUrl !== 'string') throw new Error('服务商配置不完整。');
    const result = await testProvider(cfg);
    // 把检测结果写回设置，方便界面展示状态点
    const next = ctx.store.updateSettings({
      providers: ctx.settings().providers.map((p) =>
        p.id === cfg.id
          ? { ...p, status: result.ok ? 'ok' : 'error', statusMessage: result.message, checkedAt: Date.now() }
          : p,
      ),
    });
    ctx.emit(EVT.settingsChanged, next);
    return result;
  });

  handle(IPC.providerModels, async (cfg: { providerId: string; baseUrl: string; apiKey: string }) => {
    if (!cfg || !cfg.baseUrl) throw new Error('请先填写接口地址（Base URL）。');
    const provider = ctx.settings().providers.find((p) => p.id === cfg.providerId);
    return listModels({
      providerId: cfg.providerId,
      kind: provider?.kind,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
    });
  });

  /* ------------------------------ 对话 ------------------------------ */

  handle(IPC.chatSend, (req: ChatSendRequest) => {
    if (!req || typeof req.text !== 'string' || !req.text.trim()) {
      throw new Error('消息不能为空。');
    }
    return ctx.chat.send(req);
  });

  handle(IPC.chatAbort, (runId?: string) => {
    ctx.chat.abort(runId);
  });

  handle(IPC.chatApprove, (payload: { requestId: string; approved: boolean; remember?: boolean }) => {
    if (!payload?.requestId) throw new Error('授权请求 id 缺失。');
    ctx.chat.approve(payload.requestId, !!payload.approved, payload.remember);
  });

  /* ------------------------------ 会话 ------------------------------ */

  handle(IPC.convList, () => ctx.store.listConversations());

  handle(IPC.convGet, (id: string) => ctx.store.getConversation(id));

  handle(IPC.convCreate, (payload?: { title?: string; workspaceId?: string }) =>
    ctx.store.createConversation(payload?.title, 'orchestrator', payload?.workspaceId));

  handle(IPC.convMove, (payload: { id: string; workspaceId: string | null }) => {
    if (!payload?.id) throw new Error('缺少会话 id。');
    ctx.store.moveConversation(payload.id, payload.workspaceId ?? null);
  });

  handle(IPC.workspaceList, () => ctx.store.listWorkspaces());

  handle(IPC.workspaceAdd, (input: { name: string; path?: string; parentId?: string }) => {
    if (!input?.name?.trim()) throw new Error('请填写工作区名称。');
    return ctx.store.addWorkspace(input);
  });

  handle(IPC.workspaceRename, (payload: { id: string; name: string }) => {
    if (!payload?.id) throw new Error('缺少工作区 id。');
    return ctx.store.renameWorkspace(payload.id, payload.name ?? '');
  });

  handle(IPC.workspaceRemove, (id: string) => {
    if (!id) throw new Error('缺少工作区 id。');
    return ctx.store.removeWorkspace(id);
  });

  handle(IPC.convRename, (payload: { id: string; title: string }) => {
    if (!payload?.id) throw new Error('缺少会话 id。');
    ctx.store.renameConversation(payload.id, payload.title ?? '');
  });

  handle(IPC.convRemove, (id: string) => {
    if (!id) throw new Error('缺少会话 id。');
    // 1) 先中止在途 run 并打删除屏障：否则 execute 的落库/记忆抽取会把刚删掉的会话整体写回
    const runs = ctx.chat.abortByConversation(id);
    ctx.chat.markDeleted(id);
    // 2) 该会话派生的长期记忆（自动抽取、工具写入、用户纠正）
    const before = ctx.memory.list().length;
    ctx.memory.forgetBySource([`auto:${id}`, `tool:${id}`, `feedback:${id}`]);
    const memories = before - ctx.memory.list().length;
    // 3) 会话文件 + 索引 + 产物（含旧版散落文件）
    const conv = ctx.store.deleteConversation(id);
    const artifacts = ctx.store.purgeConversationArtifacts(id, ctx.workspace());
    return {
      files: conv.files,
      artifacts: artifacts.files,
      memories,
      runs,
      failed: [...conv.failed, ...artifacts.failed],
    };
  });

  handle(IPC.convClear, () => {
    const runs = ctx.chat.abortAll();
    ctx.chat.markAllDeleted();
    const before = ctx.memory.list().length;
    ctx.memory.forgetBySource(['auto', 'tool', 'feedback']);
    const memories = before - ctx.memory.list().length;
    const conv = ctx.store.clearConversations(ctx.workspace());
    return {
      files: conv.files,
      artifacts: conv.artifacts,
      memories,
      runs,
      failed: conv.failed,
    };
  });

  handle(IPC.convFiles, (id: string) => {
    if (!id) throw new Error('缺少会话 id。');
    return ctx.store.listConversationFiles(id, ctx.workspace());
  });

  handle(IPC.convPin, (payload: { id: string; pinned: boolean }) => {
    if (!payload?.id) throw new Error('缺少会话 id。');
    ctx.store.pinConversation(payload.id, !!payload.pinned);
  });

  handle(IPC.convExport, (id: string) => {
    const md = ctx.store.exportMarkdown(id);
    if (!md) throw new Error('会话不存在或没有内容可导出。');
    return md;
  });

  /* ------------------------------ Agent ------------------------------ */

  handle(IPC.agentsList, () => AGENTS);

  /* ------------------------------- MCP ------------------------------ */

  handle(IPC.mcpList, () => ctx.mcp.statuses());

  handle(IPC.mcpTools, () => ctx.mcp.tools());

  // 平台侧在 add/remove/toggle/connect 内部都会广播 mcpChanged，IPC 层不重复推送
  handle(IPC.mcpAdd, async (cfg: McpServerConfig) => {
    if (!cfg || !cfg.id || !cfg.name) throw new Error('MCP 配置缺少 id 或名称。');
    return ctx.mcp.add(cfg);
  });

  handle(IPC.mcpRemove, async (id: string) => ctx.mcp.remove(id));

  handle(IPC.mcpToggle, async (payload: { id: string; enabled: boolean }) =>
    ctx.mcp.toggle(payload.id, !!payload.enabled));

  handle(IPC.mcpConnect, async (id: string) => ctx.mcp.connect(id));

  handle(IPC.mcpCall, async (payload: { serverId: string; tool: string; args: Record<string, unknown> }) => {
    if (!payload?.tool) throw new Error('缺少工具名。');
    return ctx.mcp.call(payload.serverId ?? '', payload.tool, payload.args ?? {});
  });

  /* ----------------------------- 定时任务 ---------------------------- */

  handle(IPC.taskList, () => ctx.scheduler.list());

  handle(IPC.taskSave, (task: ScheduledTask) => {
    if (!task || !task.prompt?.trim()) throw new Error('任务指令不能为空。');
    const list = ctx.scheduler.save(task);
    ctx.emit(EVT.tasksChanged, list);
    return list;
  });

  handle(IPC.taskRemove, (id: string) => {
    const list = ctx.scheduler.remove(id);
    ctx.emit(EVT.tasksChanged, list);
    return list;
  });

  handle(IPC.taskRun, (id: string) => ctx.scheduler.runNow(id));

  handle(IPC.taskHistory, () => ctx.scheduler.history());

  /* ------------------------------ 知识库 ----------------------------- */

  handle(IPC.kbList, () => ctx.kb.list());

  // 知识库在索引开始/结束时自行广播 kbChanged，这里只返回结果
  handle(IPC.kbAddSource, async (payload: { path: string; watch?: boolean }) => {
    if (!payload?.path) throw new Error('请选择要添加的文件或目录。');
    if (!fs.existsSync(payload.path)) throw new Error(`路径不存在：${payload.path}`);
    return ctx.kb.addSource(payload.path, payload.watch !== false);
  });

  handle(IPC.kbRemove, async (id: string) => ctx.kb.remove(id));

  handle(IPC.kbReindex, async (id?: string) => ctx.kb.reindex(id));

  handle(IPC.kbSearch, async (payload: { query: string; topK?: number }) => {
    if (!payload?.query?.trim()) throw new Error('检索内容不能为空。');
    return ctx.kb.search(payload.query, payload.topK ?? 8);
  });

  handle(IPC.kbStats, () => ctx.kb.stats());

  /* ------------------------------ 记忆 ------------------------------ */

  handle(IPC.memoryList, () => ctx.memory.list());

  handle(IPC.memoryAdd, (fact: Partial<MemoryFact> & { text: string }) => {
    if (!fact?.text?.trim()) throw new Error('记忆内容不能为空。');
    return ctx.memory.add(fact);
  });

  handle(IPC.memoryForget, (id: string) => ctx.memory.forget(id));

  handle(IPC.memoryClear, () => ctx.memory.clear());

  /* ------------------------------ 更新 ------------------------------ */

  handle(IPC.updateCheck, async (force?: boolean) => {
    // 新版本广播由 updater 内部统一发出，这里只返回结果，避免重复推送
    return ctx.updater.check(force !== false);
  });

  handle(IPC.updateOpen, async () => {
    const info = ctx.updater.current();
    const url = info?.releaseUrl || info?.downloadUrl || ctx.appInfo.repoUrl;
    if (!/^https?:\/\//i.test(url)) throw new Error('没有可打开的更新地址。');
    await shell.openExternal(url);
  });

  handle(IPC.updateInstall, async () => {
    const progress = await ctx.updater.install();
    if (progress.stage === 'installing') {
      // 安装器已独立启动；主程序退出后它才能覆盖被占用的 exe / app.asar
      setTimeout(() => app.quit(), 1500);
    }
    return progress;
  });
}

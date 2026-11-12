import { useEffect, useMemo, useState } from 'react';
import type { ConversationMeta, ThemeMode, Workspace } from '@shared/types';
import { api } from '../lib/bridge';
import { formatRelative } from '../lib/format';
import { useStore, type View } from '../state/store';
import { Icon, type IconName } from './Icon';
import { Confirm } from './Modal';

const NAV: { key: View; label: string; icon: IconName }[] = [
  { key: 'agents', label: 'Agent 广场', icon: 'agents' },
  { key: 'tasks', label: '定时任务', icon: 'tasks' },
  { key: 'kb', label: '知识库', icon: 'kb' },
  { key: 'mcp', label: 'MCP 连接器', icon: 'mcp' },
  { key: 'memory', label: '记忆', icon: 'memory' },
];

const THEME_NEXT: Record<ThemeMode, ThemeMode> = { dark: 'light', light: 'system', system: 'dark' };
const THEME_LABEL: Record<ThemeMode, { icon: IconName; text: string }> = {
  dark: { icon: 'moon', text: '深色' },
  light: { icon: 'sun', text: '浅色' },
  system: { icon: 'system', text: '跟随系统' },
};

interface MenuState {
  meta: ConversationMeta;
  x: number;
  y: number;
  /** 是否显示「移动到工作区」子菜单 */
  move?: boolean;
}

export function Sidebar() {
  const { state, actions } = useStore();
  const { metas, ui, view, activeId, query, settings, workspaces, activeWorkspaceId } = state;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [removing, setRemoving] = useState<ConversationMeta | null>(null);
  const [clearing, setClearing] = useState(false);
  const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({});
  const [wsMenu, setWsMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** child:<父id> 或 rename:<id> */
  const [wsDraftFor, setWsDraftFor] = useState<string | null>(null);
  const [wsDraft, setWsDraft] = useState('');
  const [removingWs, setRemovingWs] = useState<Workspace | null>(null);

  const collapsed = ui.sidebarCollapsed;

  useEffect(() => {
    if (!menu && !wsMenu) return;
    const close = () => {
      setMenu(null);
      setWsMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu, wsMenu]);

  const filtered = useMemo(() => {
    if (!query.trim()) return metas;
    const q = query.trim().toLowerCase();
    return metas.filter((m) => m.title.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q));
  }, [metas, query]);

  const pinned = filtered.filter((m) => m.pinned);
  const recent = filtered.filter((m) => !m.pinned);

  const startRename = (meta: ConversationMeta) => {
    setMenu(null);
    setEditingId(meta.id);
    setDraft(meta.title);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const id = editingId;
    setEditingId(null);
    if (draft.trim()) await actions.renameConversation(id, draft);
  };

  const exportMarkdown = async (meta: ConversationMeta) => {
    setMenu(null);
    const md = await api.conversations.exportMarkdown(meta.id);
    try {
      await navigator.clipboard.writeText(md);
      actions.toast('success', '对话已导出为 Markdown 并复制到剪贴板');
    } catch {
      actions.toast('warn', '剪贴板不可用，导出未完成');
    }
  };

  const addTopWorkspace = async () => {
    const dir = await api.app.pickDirectory();
    if (!dir) return;
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工作区';
    await actions.addWorkspace({ name, path: dir });
  };

  const commitWsDraft = async () => {
    const key = wsDraftFor;
    const name = wsDraft.trim();
    setWsDraftFor(null);
    setWsDraft('');
    if (!key || !name) return;
    if (key.startsWith('child:')) await actions.addWorkspace({ name, parentId: key.slice(6) });
    else if (key.startsWith('rename:')) await actions.renameWorkspace(key.slice(7), name);
  };

  const newChatIn = (wsId: string) => {
    actions.setActiveWorkspace(wsId);
    void actions.newConversation(undefined, undefined, wsId);
  };

  const renderWsConversations = (wsId: string) => (
    <ConversationList
      list={filtered.filter((m) => m.workspaceId === wsId)}
      collapsed={collapsed}
      activeId={activeId}
      editingId={editingId}
      draft={draft}
      onDraft={setDraft}
      onCommit={commitRename}
      onCancel={() => setEditingId(null)}
      onSelect={(id) => void actions.selectConversation(id)}
      onRename={startRename}
      onMenu={(meta, e) => setMenu({ meta, x: e.clientX, y: e.clientY })}
      onPin={(meta) => void actions.togglePin(meta.id)}
    />
  );

  const wsMenuWorkspace = wsMenu ? workspaces.find((w) => w.id === wsMenu.id) ?? null : null;
  const activeWsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name;

  const providerName = settings.providers.find((p) => p.id === settings.activeProviderId)?.name ?? '未配置渠道';
  const theme = settings.appearance.theme;

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        className="collapse-btn"
        title={collapsed ? '展开侧栏' : '收起侧栏'}
        onClick={() => actions.setUi({ sidebarCollapsed: !collapsed })}
      >
        {collapsed ? '›' : '‹'}
      </button>

      <div className="sidebar-top">
        <button type="button" className="new-chat" onClick={() => void actions.newConversation()}>
          <span className="plus">
            <Icon name="plus" size={14} />
          </span>
          <span className="label">新建对话</span>
        </button>
        {activeWorkspaceId ? (
          <button
            type="button"
            className="ws-pinned"
            title="接下来的新对话会固定到这个文件夹，点击取消固定"
            onClick={() => actions.setActiveWorkspace(null)}
          >
            <span className="ws-pinned-name">固定在：{activeWsName ?? '工作区'}</span>
            <span className="ws-pinned-x">✕</span>
          </button>
        ) : null}
        <div className="search-box">
          <Icon name="search" size={13} className="search-ic" />
          <input
            value={query}
            onChange={(e) => actions.setQuery(e.target.value)}
            placeholder="搜索对话"
            aria-label="搜索对话"
          />
          {query ? (
            <button type="button" className="conv-act" onClick={() => actions.setQuery('')} title="清空搜索">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {state.updateInfo?.available ? (
        <button
          type="button"
          className="update-banner"
          title="打开设置 → 更新，在应用内下载并安装"
          onClick={() => actions.openSettings(true)}
        >
          <span className="ub-dot" />
          <span className="ub-text">发现新版本 v{state.updateInfo.latestVersion}</span>
          <span className="ub-arrow">↗</span>
        </button>
      ) : null}

      <div className="sidebar-scroll">
        {query ? (
          <>
            <div className="section-label">
              搜索结果<span className="count">{filtered.length}</span>
            </div>
            <ConversationList
              list={filtered}
              collapsed={collapsed}
              activeId={activeId}
              editingId={editingId}
              draft={draft}
              onDraft={setDraft}
              onCommit={commitRename}
              onCancel={() => setEditingId(null)}
              onSelect={(id) => void actions.selectConversation(id)}
              onRename={startRename}
              onMenu={(meta, e) => setMenu({ meta, x: e.clientX, y: e.clientY })}
              onPin={(meta) => void actions.togglePin(meta.id)}
            />
          </>
        ) : (
          <>
            {pinned.length > 0 ? (
              <>
                <div className="section-label">
                  置顶<span className="count">{pinned.length}</span>
                </div>
                <ConversationList
                  list={pinned}
                  collapsed={collapsed}
                  activeId={activeId}
                  editingId={editingId}
                  draft={draft}
                  onDraft={setDraft}
                  onCommit={commitRename}
                  onCancel={() => setEditingId(null)}
                  onSelect={(id) => void actions.selectConversation(id)}
                  onRename={startRename}
                  onMenu={(meta, e) => setMenu({ meta, x: e.clientX, y: e.clientY })}
                  onPin={(meta) => void actions.togglePin(meta.id)}
                />
              </>
            ) : null}

            <div className="section-label">
              最近对话<span className="count">{recent.length}</span>
              {metas.length > 0 ? (
                <button
                  type="button"
                  className="section-act"
                  title="彻底清空全部对话：文件、索引、派生记忆与产物一起删除"
                  onClick={() => setClearing(true)}
                >
                  清空全部
                </button>
              ) : null}
            </div>
            {recent.length === 0 ? (
              <div className="sidebar-empty">
                还没有对话记录
                <br />
                点上方「新建对话」开始
              </div>
            ) : (
              <ConversationList
                list={recent}
                collapsed={collapsed}
                activeId={activeId}
                editingId={editingId}
                draft={draft}
                onDraft={setDraft}
                onCommit={commitRename}
                onCancel={() => setEditingId(null)}
                onSelect={(id) => void actions.selectConversation(id)}
                onRename={startRename}
                onMenu={(meta, e) => setMenu({ meta, x: e.clientX, y: e.clientY })}
                onPin={(meta) => void actions.togglePin(meta.id)}
              />
            )}

            <div className="section-label" style={{ marginTop: 8 }}>
              工作区<span className="count">{workspaces.length}</span>
              <button
                type="button"
                className="section-act"
                title="选一个文件夹作为工作区，之后的新对话都固定在这里"
                onClick={() => void addTopWorkspace()}
              >
                ＋ 添加
              </button>
            </div>
            {workspaces.length === 0 ? (
              <div className="sidebar-empty ws-hint">选一个文件夹，就能在里面一层层建工作区</div>
            ) : (
              <WorkspaceTree
                parentId={null}
                depth={0}
                ctx={{
                  workspaces,
                  metas: filtered,
                  activeWorkspaceId,
                  openMap: wsOpen,
                  toggleOpen: (id) => setWsOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? true) })),
                  pick: (id) => actions.setActiveWorkspace(id),
                  newChat: newChatIn,
                  openMenu: (ws, e) => {
                    setWsOpen((prev) => ({ ...prev, [ws.id]: true }));
                    setWsMenu({ id: ws.id, x: e.clientX, y: e.clientY });
                  },
                  draftFor: wsDraftFor,
                  draft: wsDraft,
                  onDraft: setWsDraft,
                  commitDraft: () => void commitWsDraft(),
                  cancelDraft: () => {
                    setWsDraftFor(null);
                    setWsDraft('');
                  },
                  renderConversations: renderWsConversations,
                }}
              />
            )}

            <div className="section-label" style={{ marginTop: 8 }}>
              功能
            </div>
            <nav className="nav-group">
              {NAV.map((item) => {
                const badge =
                  item.key === 'tasks'
                    ? state.tasks.filter((t) => t.enabled).length
                    : item.key === 'kb'
                      ? state.knowledge.length
                      : item.key === 'mcp'
                        ? state.mcp.filter((m) => m.state === 'ready').length
                        : item.key === 'memory'
                          ? state.memory.length
                          : item.key === 'agents'
                            ? state.agents.length
                            : 0;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`nav-item${view === item.key ? ' active' : ''}`}
                    title={item.label}
                    onClick={() => actions.setView(item.key)}
                  >
                    <span className="nav-glyph">
                      <Icon name={item.icon} size={17} />
                    </span>
                    <span className="nav-icon">
                      <Icon name={item.icon} size={16} />
                    </span>
                    <span className="nav-text">{item.label}</span>
                    {badge > 0 ? <span className="nav-badge">{badge}</span> : null}
                  </button>
                );
              })}
            </nav>
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <div className="model-chip" title={`${providerName} · ${settings.activeModel}`}>
          <span className="dot" />
          <div className="meta">
            <div className="m-name">{settings.activeModel}</div>
            <div className="m-sub">
              {providerName}
              {settings.freeMode ? ' · 免费优先' : ''}
            </div>
          </div>
        </div>
        <div className="foot-actions">
          <button
            type="button"
            className="foot-btn"
            title={`主题：${THEME_LABEL[theme].text}，点击切换`}
            onClick={() => void actions.updateSettings({ appearance: { theme: THEME_NEXT[theme] } })}
          >
            <span>
              <Icon name={THEME_LABEL[theme].icon} size={14} />
            </span>
            <span className="label">{THEME_LABEL[theme].text}</span>
          </button>
          <button
            type="button"
            className="foot-btn"
            title="设置"
            onClick={() => actions.openSettings(true)}
          >
            <span>
              <Icon name="settings" size={14} />
            </span>
            <span className="label">设置</span>
          </button>
        </div>
      </div>

      {menu ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 190 }} onMouseDown={() => setMenu(null)} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.move ? (
              <>
                <div className="ctx-head">移动到工作区</div>
                {workspaces.length === 0 ? <div className="ctx-empty">还没有工作区</div> : null}
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    className="ctx-item"
                    onClick={() => {
                      void actions.moveConversation(menu.meta.id, ws.id);
                      setMenu(null);
                    }}
                  >
                    <span>▤</span>
                    {ws.name}
                  </button>
                ))}
                <div className="ctx-sep" />
                <button
                  type="button"
                  className="ctx-item"
                  onClick={() => {
                    void actions.moveConversation(menu.meta.id, null);
                    setMenu(null);
                  }}
                >
                  <span>↩</span>移出工作区
                </button>
              </>
            ) : (
              <>
                <button type="button" className="ctx-item" onClick={() => void actions.togglePin(menu.meta.id)}>
                  <span>{menu.meta.pinned ? '⇩' : '⇧'}</span>
                  {menu.meta.pinned ? '取消置顶' : '置顶对话'}
                </button>
                <button type="button" className="ctx-item" onClick={() => startRename(menu.meta)}>
                  <span>✎</span>重命名
                </button>
                <button type="button" className="ctx-item" onClick={() => void exportMarkdown(menu.meta)}>
                  <span>⇪</span>导出 Markdown
                </button>
                <button type="button" className="ctx-item" onClick={() => setMenu({ ...menu, move: true })}>
                  <span>▤</span>移动到工作区
                </button>
                <div className="ctx-sep" />
                <button
                  type="button"
                  className="ctx-item danger"
                  onClick={() => {
                    setRemoving(menu.meta);
                    setMenu(null);
                  }}
                >
                  <span>⌫</span>删除对话
                </button>
              </>
            )}
          </div>
        </>
      ) : null}

      {wsMenu && wsMenuWorkspace ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 190 }} onMouseDown={() => setWsMenu(null)} />
          <div className="ctx-menu" style={{ left: wsMenu.x, top: wsMenu.y }}>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                setWsDraftFor(`child:${wsMenuWorkspace.id}`);
                setWsDraft('');
                setWsMenu(null);
              }}
            >
              <span>＋</span>新建子工作区
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                setWsDraftFor(`rename:${wsMenuWorkspace.id}`);
                setWsDraft(wsMenuWorkspace.name);
                setWsMenu(null);
              }}
            >
              <span>✎</span>重命名
            </button>
            <button
              type="button"
              className="ctx-item"
              onClick={() => {
                void api.app.openPath(wsMenuWorkspace.path);
                setWsMenu(null);
              }}
            >
              <span>↗</span>打开文件夹
            </button>
            <div className="ctx-sep" />
            <button
              type="button"
              className="ctx-item danger"
              onClick={() => {
                setRemovingWs(wsMenuWorkspace);
                setWsMenu(null);
              }}
            >
              <span>⌫</span>移除工作区
            </button>
          </div>
        </>
      ) : null}

      {removing ? (
        <Confirm
          title="彻底删除对话"
          text={`「${removing.title}」将被永久擦除，包括：会话文件与索引条目、全部消息与工具记录、该会话派生出的长期记忆（含你的纠正）、以及该会话产生的产物文件（图片 / 生成物）。正在执行的任务会一并中止。此操作不可恢复。`}
          confirmLabel="彻底删除"
          onClose={() => setRemoving(null)}
          onConfirm={() => void actions.removeConversation(removing.id)}
        />
      ) : null}

      {clearing ? (
        <Confirm
          title="彻底清空全部对话"
          text={`共 ${metas.length} 个对话将被永久擦除：所有会话文件与索引、全部消息与工具记录、由对话派生的长期记忆、以及所有产物文件（含旧版本遗留的散落文件）。正在执行的任务会全部中止。此操作不可恢复。`}
          confirmLabel="全部清空"
          onClose={() => setClearing(false)}
          onConfirm={() => void actions.clearConversations()}
        />
      ) : null}

      {removingWs ? (
        <Confirm
          title="移除工作区"
          text={`「${removingWs.name}」和它下面的子工作区会从列表里移除，这些工作区里的对话变成未分组。磁盘上的文件夹和文件不会删除。`}
          confirmLabel="移除"
          onClose={() => setRemovingWs(null)}
          onConfirm={() => {
            void actions.removeWorkspace(removingWs.id);
            setRemovingWs(null);
          }}
        />
      ) : null}
    </aside>
  );
}

function ConversationList({
  list,
  collapsed,
  activeId,
  editingId,
  draft,
  onDraft,
  onCommit,
  onCancel,
  onSelect,
  onRename,
  onMenu,
  onPin,
}: {
  list: ConversationMeta[];
  collapsed: boolean;
  activeId: string | null;
  editingId: string | null;
  draft: string;
  onDraft(v: string): void;
  onCommit(): void;
  onCancel(): void;
  onSelect(id: string): void;
  onRename(meta: ConversationMeta): void;
  onMenu(meta: ConversationMeta, e: React.MouseEvent): void;
  onPin(meta: ConversationMeta): void;
}) {
  return (
    <div className="conv-list">
      {list.map((meta) => {
        const active = meta.id === activeId;
        const editing = meta.id === editingId;
        return (
          <div
            key={meta.id}
            className={`conv-item${active ? ' active' : ''}`}
            title={collapsed ? meta.title : `${meta.title}\n${formatRelative(meta.updatedAt)}`}
            onClick={() => !editing && onSelect(meta.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu(meta, e);
            }}
          >
            <span className="conv-dot" />
            <span className="conv-glyph">{meta.title.slice(0, 1)}</span>
            {editing ? (
              <input
                className="conv-title-input"
                value={draft}
                autoFocus
                onChange={(e) => onDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={onCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommit();
                  if (e.key === 'Escape') onCancel();
                }}
              />
            ) : (
              <span className="conv-title">{meta.title}</span>
            )}
            {!editing ? (
              <span className="conv-actions">
                <button
                  type="button"
                  className={`conv-act${meta.pinned ? ' on' : ''}`}
                  title={meta.pinned ? '取消置顶' : '置顶'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPin(meta);
                  }}
                >
                  ⇧
                </button>
                <button
                  type="button"
                  className="conv-act"
                  title="更多操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMenu(meta, e);
                  }}
                >
                  ⋯
                </button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 工作区树：一层套一层，每层下面挂着绑定到此工作区的对话              */
/* ------------------------------------------------------------------ */

interface WsTreeCtx {
  workspaces: Workspace[];
  metas: ConversationMeta[];
  activeWorkspaceId: string | null;
  openMap: Record<string, boolean>;
  toggleOpen(id: string): void;
  pick(id: string): void;
  newChat(id: string): void;
  openMenu(ws: Workspace, e: React.MouseEvent): void;
  draftFor: string | null;
  draft: string;
  onDraft(v: string): void;
  commitDraft(): void;
  cancelDraft(): void;
  renderConversations(wsId: string): React.ReactNode;
}

function WorkspaceTree({ parentId, depth, ctx }: { parentId: string | null; depth: number; ctx: WsTreeCtx }) {
  const nodes = ctx.workspaces.filter((w) => (w.parentId ?? null) === parentId);
  if (nodes.length === 0) return null;
  return (
    <div className={`ws-tree${depth > 0 ? ' nested' : ''}`}>
      {nodes.map((ws) => {
        const children = ctx.workspaces.filter((w) => w.parentId === ws.id);
        const convs = ctx.metas.filter((m) => m.workspaceId === ws.id);
        const open = ctx.openMap[ws.id] ?? true;
        const renaming = ctx.draftFor === `rename:${ws.id}`;
        const draftingChild = ctx.draftFor === `child:${ws.id}`;
        const hasContent = children.length > 0 || convs.length > 0 || draftingChild;
        return (
          <div className="ws-node" key={ws.id}>
            <div
              className={`ws-row${ctx.activeWorkspaceId === ws.id ? ' active' : ''}`}
              title={ws.path}
              onClick={() => ctx.pick(ws.id)}
            >
              <button
                type="button"
                className="ws-caret"
                title={open ? '收起' : '展开'}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.toggleOpen(ws.id);
                }}
              >
                {hasContent ? (open ? '▾' : '▸') : '·'}
              </button>
              <svg
                className="ws-folder"
                width="14"
                height="14"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M2.5 5.5a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
              </svg>
              {renaming ? (
                <input
                  className="conv-title-input ws-input"
                  value={ctx.draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => ctx.onDraft(e.target.value)}
                  onBlur={ctx.commitDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') ctx.commitDraft();
                    if (e.key === 'Escape') ctx.cancelDraft();
                  }}
                />
              ) : (
                <span className="ws-name">{ws.name}</span>
              )}
              <span className="ws-row-actions">
                <button
                  type="button"
                  className="conv-act"
                  title="在这个工作区新建对话"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.newChat(ws.id);
                  }}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="conv-act"
                  title="工作区操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.openMenu(ws, e);
                  }}
                >
                  ⋯
                </button>
              </span>
            </div>
            {open && hasContent ? (
              <div className="ws-children">
                {draftingChild ? (
                  <div className="ws-draft-row">
                    <input
                      className="conv-title-input ws-input"
                      value={ctx.draft}
                      autoFocus
                      placeholder="子文件夹名称"
                      onChange={(e) => ctx.onDraft(e.target.value)}
                      onBlur={ctx.commitDraft}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') ctx.commitDraft();
                        if (e.key === 'Escape') ctx.cancelDraft();
                      }}
                    />
                  </div>
                ) : null}
                {children.length > 0 ? <WorkspaceTree parentId={ws.id} depth={depth + 1} ctx={ctx} /> : null}
                {convs.length > 0 ? <div className="ws-conv">{ctx.renderConversations(ws.id)}</div> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

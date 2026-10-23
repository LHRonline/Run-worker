import { useEffect, useMemo, useState } from 'react';
import type { ConversationMeta, ThemeMode } from '@shared/types';
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
}

export function Sidebar() {
  const { state, actions } = useStore();
  const { metas, ui, view, activeId, query, settings } = state;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [removing, setRemoving] = useState<ConversationMeta | null>(null);

  const collapsed = ui.sidebarCollapsed;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
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
  }, [menu]);

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
              工作区
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
          </div>
        </>
      ) : null}

      {removing ? (
        <Confirm
          title="删除对话"
          text={`「${removing.title}」及其全部消息、工具记录会被永久删除，无法恢复。`}
          onClose={() => setRemoving(null)}
          onConfirm={() => void actions.removeConversation(removing.id)}
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

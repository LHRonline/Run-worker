import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentId, Attachment, ConversationFileRef } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { COMPOSER_SKILLS, PERSONA_PRESET_META } from '@shared/presets';
import type { ComposerSkill } from '@shared/presets';
import { api } from '../lib/bridge';
import { estimateTokens, formatCny, formatTokens, formatTokensExact, usageSource } from '../lib/format';
import { useStore } from '../state/store';
import { useClickOutside } from './ui';

type MenuPage = 'root' | 'files' | 'modes' | 'experts' | 'skills' | 'connectors';

const MENU_TITLE: Record<MenuPage, string> = {
  root: '添加到对话',
  files: '引用对话文件',
  modes: '回答模式',
  experts: '选择专家',
  skills: '快捷技能',
  connectors: '连接器',
};

export function Composer() {
  const { state, actions } = useStore();
  const { activeId, conversations, settings, runs, agents, mcp } = state;
  const conversation = activeId ? conversations[activeId] : undefined;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [agentMenu, setAgentMenu] = useState(false);
  const [agentId, setAgentId] = useState<AgentId>('orchestrator');
  const [addOpen, setAddOpen] = useState(false);
  const [menuPage, setMenuPage] = useState<MenuPage>('root');
  const [convFiles, setConvFiles] = useState<ConversationFileRef[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  const activeRun = Object.values(runs).find((r) => r.conversationId === activeId && r.status === 'running');
  const running = Boolean(activeRun);
  const direct = settings.persona.preset === 'direct';
  const readyConnectors = mcp.filter((m) => m.state === 'ready').length;

  const closeAgentMenu = useCallback(() => setAgentMenu(false), []);
  const closeAddMenu = useCallback(() => setAddOpen(false), []);
  useClickOutside(menuRef, closeAgentMenu, agentMenu);
  useClickOutside(addMenuRef, closeAddMenu, addOpen);

  useEffect(() => {
    setAgentId(conversation?.agentId ?? 'orchestrator');
  }, [activeId, conversation?.agentId]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const lastAssistant = conversation ? [...conversation.messages].reverse().find((m) => m.role === 'assistant') : undefined;

  const submit = async () => {
    const clean = text.trim();
    if (!clean || running) return;
    const files = attachments;
    setText('');
    setAttachments([]);
    if (areaRef.current) areaRef.current.style.height = 'auto';
    await actions.send(clean, agentId, files);
  };

  const pickFiles = async () => {
    try {
      const files = await api.app.pickFiles({ multiple: true });
      if (files.length) setAttachments((prev) => [...prev, ...files.filter((f) => !prev.some((p) => p.path === f.path))]);
    } catch {
      actions.toast('warn', '无法打开文件选择器');
    }
  };

  const openConvFiles = async () => {
    setMenuPage('files');
    setConvFiles([]);
    if (!activeId) return;
    setFilesLoading(true);
    try {
      setConvFiles(await api.conversations.files(activeId));
    } catch {
      actions.toast('warn', '读取对话文件失败');
    } finally {
      setFilesLoading(false);
    }
  };

  const addConvFile = (f: ConversationFileRef) => {
    setAttachments((prev) =>
      prev.some((p) => p.path === f.path)
        ? prev
        : [
            ...prev,
            {
              id: `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: f.name,
              path: f.path,
              kind: f.kind,
              size: f.size,
              mime: f.mime,
            },
          ],
    );
    setAddOpen(false);
  };

  const applySkill = (skill: ComposerSkill) => {
    setText(skill.template.replace('{text}', text.trim()));
    setAddOpen(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const applyMode = (meta: (typeof PERSONA_PRESET_META)[number]) => {
    void actions.updateSettings({ persona: { preset: meta.id, ...meta.patch } });
    setAddOpen(false);
  };

  const agent = AGENT_MAP[agentId] ?? AGENT_MAP.orchestrator;
  const tokenEstimate = estimateTokens(text);
  const lastSource = usageSource(lastAssistant?.usage);
  const convSource = usageSource(conversation?.usage);

  const renderMenuPage = () => {
    if (menuPage === 'files') {
      if (filesLoading) return <div className="add-menu-hint">正在读取本对话的文件…</div>;
      if (convFiles.length === 0) {
        return (
          <div className="add-menu-hint">
            这个对话还没有可引用的文件。发送带附件的消息，或让 Agent 生成文件后，就能在这里重新带上它们。
          </div>
        );
      }
      return convFiles.map((f) => {
        const already = attachments.some((a) => a.path === f.path);
        return (
          <button
            key={f.path}
            type="button"
            className="add-menu-item"
            disabled={f.missing || already}
            title={f.path}
            onClick={() => addConvFile(f)}
          >
            <span className="ami">{f.kind === 'image' ? '▧' : '▤'}</span>
            <span className="amt">
              <b>{f.name}</b>
              <small>
                {f.origin === 'artifact' ? '本会话生成' : '历史附件'}
                {f.missing ? ' · 文件已不存在' : already ? ' · 已添加' : ''}
              </small>
            </span>
          </button>
        );
      });
    }
    if (menuPage === 'modes') {
      return (
        <>
          {PERSONA_PRESET_META.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`add-menu-item${settings.persona.preset === p.id ? ' active' : ''}`}
              onClick={() => applyMode(p)}
            >
              <span className="ami">{p.icon}</span>
              <span className="amt">
                <b>{p.label}</b>
                <small>{p.hint}</small>
              </span>
              {settings.persona.preset === p.id ? <span className="am-check">✓</span> : null}
            </button>
          ))}
          <div className="add-menu-sep" />
          <button
            type="button"
            className={`add-menu-item${settings.persona.humanize ? ' active' : ''}`}
            onClick={() => void actions.updateSettings({ persona: { humanize: !settings.persona.humanize } })}
          >
            <span className="ami">☺</span>
            <span className="amt">
              <b>更像人</b>
              <small>自然协作、记住约定、被纠正时直接改</small>
            </span>
            <span className="am-switch">{settings.persona.humanize ? '开' : '关'}</span>
          </button>
        </>
      );
    }
    if (menuPage === 'experts') {
      return agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`add-menu-item${a.id === agentId ? ' active' : ''}`}
          onClick={() => {
            setAgentId(a.id);
            setAddOpen(false);
          }}
        >
          <span className="ami" style={{ color: a.color }}>{a.icon}</span>
          <span className="amt">
            <b>{a.name}</b>
            <small>{a.tagline}</small>
          </span>
          {a.id === agentId ? <span className="am-check">✓</span> : null}
        </button>
      ));
    }
    if (menuPage === 'skills') {
      return COMPOSER_SKILLS.map((s) => (
        <button key={s.id} type="button" className="add-menu-item" onClick={() => applySkill(s)}>
          <span className="ami">{s.icon}</span>
          <span className="amt">
            <b>{s.label}</b>
            <small>{s.hint}</small>
          </span>
        </button>
      ));
    }
    if (menuPage === 'connectors') {
      return (
        <>
          {mcp.length === 0 ? (
            <div className="add-menu-hint">还没有配置连接器。添加 MCP 服务后，Agent 就能调用它的工具。</div>
          ) : (
            mcp.map((m) => (
              <div key={m.id} className="add-menu-item static">
                <span className={`ami${m.state === 'ready' ? ' ok' : ''}`}>{m.state === 'ready' ? '●' : '○'}</span>
                <span className="amt">
                  <b>{m.name}</b>
                  <small>{m.state === 'ready' ? `已连接 · ${m.toolCount} 个工具` : m.message || m.state}</small>
                </span>
              </div>
            ))
          )}
          <div className="add-menu-sep" />
          <button
            type="button"
            className="add-menu-item"
            onClick={() => {
              actions.setView('mcp');
              setAddOpen(false);
            }}
          >
            <span className="ami">⚙</span>
            <span className="amt">
              <b>管理连接器</b>
              <small>添加、启停或重新连接 MCP 服务</small>
            </span>
            <span className="chev">›</span>
          </button>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          className="add-menu-item"
          onClick={() => {
            void pickFiles();
            setAddOpen(false);
          }}
        >
          <span className="ami">⌇</span>
          <span className="amt"><b>添加文件</b><small>从电脑选择文件加入本次对话</small></span>
        </button>
        <button type="button" className="add-menu-item" onClick={() => void openConvFiles()}>
          <span className="ami">⧉</span>
          <span className="amt"><b>引用对话文件</b><small>重新带上本对话的附件与生成物</small></span>
          <span className="chev">›</span>
        </button>
        <div className="add-menu-sep" />
        <button type="button" className="add-menu-item" onClick={() => setMenuPage('modes')}>
          <span className="ami">◐</span>
          <span className="amt"><b>模式</b><small>当前：{PERSONA_PRESET_META.find((p) => p.id === settings.persona.preset)?.label ?? '自定义'}</small></span>
          <span className="chev">›</span>
        </button>
        <button type="button" className="add-menu-item" onClick={() => setMenuPage('experts')}>
          <span className="ami" style={{ color: agent.color }}>{agent.icon}</span>
          <span className="amt"><b>专家</b><small>当前：{agent.name}</small></span>
          <span className="chev">›</span>
        </button>
        <button type="button" className="add-menu-item" onClick={() => setMenuPage('skills')}>
          <span className="ami">✦</span>
          <span className="amt"><b>技能</b><small>总结、改写、解释、拆解、审查、翻译</small></span>
          <span className="chev">›</span>
        </button>
        <button type="button" className="add-menu-item" onClick={() => setMenuPage('connectors')}>
          <span className="ami">⚯</span>
          <span className="amt"><b>连接器</b><small>{readyConnectors} 个已连接 · 管理 MCP 服务</small></span>
          <span className="chev">›</span>
        </button>
      </>
    );
  };

  return (
    <div className="composer-wrap">
      <div className={`composer${focused ? ' focused' : ''}${attachments.length ? ' attachments' : ''}`}>
        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span className="attach-chip" key={a.id} title={a.path}>
                <span>{a.kind === 'image' ? '▧' : '▤'}</span>
                <span className="nm">{a.name}</span>
                <button
                  type="button"
                  className="rm"
                  aria-label={`移除 ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="composer-main">
          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            placeholder={running ? '本轮正在执行，可随时停止…' : '描述你要完成的事，Run worker 会选对 Agent 并直接执行…'}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {running ? (
            <button type="button" className="send-btn stop" title="停止本轮执行" onClick={() => void actions.stop()}>
              <svg viewBox="0 0 12 12" fill="none">
                <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className={`send-btn${text.trim() ? ' ready' : ''}`}
              title="发送（Enter）"
              disabled={!text.trim()}
              onClick={() => void submit()}
            >
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M3 13l10-5L3 3v3.6L9.6 8 3 9.4V13z" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>

        <div className="composer-tools">
          <div className="add-menu-anchor" ref={addMenuRef}>
            <button
              type="button"
              className={`tool-btn add-btn${addOpen ? ' on' : ''}`}
              title="添加文件、引用、模式、专家、技能与连接器"
              onClick={() => {
                setAddOpen((v) => !v);
                setMenuPage('root');
              }}
            >
              <span>＋</span>
            </button>
            {addOpen ? (
              <div className="menu-pop add-menu">
                <div className="add-menu-head">
                  {menuPage !== 'root' ? (
                    <button type="button" className="add-menu-back" onClick={() => setMenuPage('root')}>‹</button>
                  ) : null}
                  <span>{MENU_TITLE[menuPage]}</span>
                </div>
                <div className="add-menu-body">{renderMenuPage()}</div>
              </div>
            ) : null}
          </div>

          <div className="agent-select" ref={menuRef}>
            <button
              type="button"
              className="agent-select-btn"
              style={{ ['--agent-color' as string]: agent.color }}
              onClick={() => setAgentMenu((v) => !v)}
              title="手动指定 Agent，或交给总调度自动选择"
            >
              <span className="dot" />
              {agent.name}
              <span style={{ fontSize: 8, color: 'var(--faint)' }}>▴</span>
            </button>
            {agentMenu ? (
              <div className="menu-pop">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`menu-item${a.id === agentId ? ' active' : ''}`}
                    onClick={() => {
                      setAgentId(a.id);
                      setAgentMenu(false);
                    }}
                  >
                    <span className="mi" style={{ color: a.color }}>
                      {a.icon}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12 }}>{a.name}</span>
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--faint)' }}>{a.tagline}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button type="button" className="tool-btn" onClick={() => void pickFiles()} title="添加附件">
            <span>⌇</span>附件
          </button>

          <button
            type="button"
            className={`tool-btn${direct ? ' on' : ''}`}
            title="直给模式：不寒暄、不复述，直接给结论与操作"
            onClick={() =>
              void actions.updateSettings({
                persona: direct
                  ? { preset: 'balanced', noFiller: false, resultFirst: true }
                  : { preset: 'direct', noFiller: true, resultFirst: true },
              })
            }
          >
            <span>⚡</span>
            直给
          </button>

          <span className="grow" />

          <span className="composer-meta">
            {text ? `预计输入 ≈ ${formatTokens(tokenEstimate)} tok（本地估算） · ` : ''}
            {settings.activeModel}
          </span>
        </div>
      </div>

      {conversation ? (
        <div className="usage-bar">
          <span className="u">
            <b>本轮</b>
            {formatTokensExact(lastAssistant?.usage?.totalTokens ?? 0)} tok
            {lastAssistant?.usage ? (
              <em className={`tok-src${lastSource.estimated ? ' est' : ''}`} title={lastSource.title}>{lastSource.label}</em>
            ) : null}
          </span>
          <span className="u">
            <b>累计</b>
            {formatTokensExact(conversation.usage.totalTokens)} tok
            <em className={`tok-src${convSource.estimated ? ' est' : ''}`} title={convSource.title}>{convSource.label}</em>
          </span>
          <span className="u">
            <b>估算费用</b>
            {formatCny(conversation.usage.costCny)}
          </span>
          <span className="grow" />
          <span className="u" style={{ color: 'var(--faint)' }}>
            Enter 发送 · Shift+Enter 换行
          </span>
        </div>
      ) : null}
    </div>
  );
}

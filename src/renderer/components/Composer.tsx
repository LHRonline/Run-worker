import { useEffect, useRef, useState } from 'react';
import type { AgentId, Attachment } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { api } from '../lib/bridge';
import { estimateTokens, formatCny, formatTokens } from '../lib/format';
import { useStore } from '../state/store';
import { useClickOutside } from './ui';

export function Composer() {
  const { state, actions } = useStore();
  const { activeId, conversations, settings, runs, agents } = state;
  const conversation = activeId ? conversations[activeId] : undefined;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [agentMenu, setAgentMenu] = useState(false);
  const [agentId, setAgentId] = useState<AgentId>('orchestrator');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeRun = Object.values(runs).find((r) => r.conversationId === activeId && r.status === 'running');
  const running = Boolean(activeRun);
  const direct = settings.persona.preset === 'direct';

  useClickOutside(menuRef, () => setAgentMenu(false), agentMenu);

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

  const agent = AGENT_MAP[agentId] ?? AGENT_MAP.orchestrator;
  const tokenEstimate = estimateTokens(text);

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
            {text ? `≈ ${formatTokens(tokenEstimate)} tok · ` : ''}
            {settings.activeModel}
          </span>
        </div>
      </div>

      <div className="usage-bar">
        <span className="u">
          <b>本轮</b>
          {formatTokens(lastAssistant?.usage?.totalTokens ?? 0)} tok
        </span>
        <span className="u">
          <b>累计</b>
          {formatTokens(conversation?.usage.totalTokens ?? 0)} tok
        </span>
        <span className="u">
          <b>估算费用</b>
          {formatCny(conversation?.usage.costCny ?? 0)}
        </span>
        <span className="grow" />
        <span className="u" style={{ color: 'var(--faint)' }}>
          Enter 发送 · Shift+Enter 换行
        </span>
      </div>
    </div>
  );
}

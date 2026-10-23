import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { api } from '../lib/bridge';
import { useStore } from '../state/store';
import { Composer } from './Composer';
import { Message } from './Message';
import { RightRail } from './RightRail';

const SUGGESTIONS: { icon: string; title: string; desc: string; prompt: string; agent: AgentId }[] = [
  {
    icon: '⌁',
    title: '帮我整理下载文件夹',
    desc: '按类型归档，先出清单再执行',
    prompt: '帮我整理下载文件夹，按类型归档，先列出清单再执行。',
    agent: 'computer',
  },
  {
    icon: '⌘',
    title: '写一个 Python 脚本批量重命名图片',
    desc: '带预览模式，绝不覆盖原图',
    prompt: '写一个 Python 脚本批量重命名图片，默认预览、加 --apply 才执行。',
    agent: 'code',
  },
  {
    icon: '❖',
    title: '根据我的资料写一份周报',
    desc: '从知识库取本周进展与风险',
    prompt: '根据我的资料写一份本周周报，包含进展、关键数据、下周计划与需要协助的事项。',
    agent: 'research',
  },
  {
    icon: '◈',
    title: '生成一张产品封面图',
    desc: '深色科技风，16:10 主视觉',
    prompt: '生成一张产品封面图，深色科技风、蓝青渐变，16:10 比例。',
    agent: 'image',
  },
];

export function EmptyHome() {
  const { actions } = useStore();
  const [busy, setBusy] = useState(false);

  return (
    <div className="chat-empty">
      <div className="empty-inner">
        <div className="cover-mini">
          <img src="./cover.png" alt="Run worker" />
        </div>
        <h1 className="empty-title">今天想让 Run worker 做什么？</h1>
        <p className="empty-sub">
          直接说目标就行。主 Agent 会判断任务类型、自动挑选子 Agent，
          需要动手的操作会先征求你的授权。
        </p>

        <div className="suggest-grid">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="suggest-card"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await actions.send(s.prompt, s.agent, []);
                setBusy(false);
              }}
            >
              <span className="sic">{s.icon}</span>
              <span style={{ minWidth: 0 }}>
                <span className="st">{s.title}</span>
                <span className="sd">{s.desc}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="foot-hint">
          <span>
            <kbd>Enter</kbd> 发送
          </span>
          <span>
            <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
          </span>
          <span>8 个子 Agent 自动调度</span>
        </div>
      </div>
    </div>
  );
}

export function ChatView() {
  const { state, actions } = useStore();
  const { activeId, conversations, loadingConversation, approvals, runs, ui, metas, settings } = state;
  const conversation = activeId ? conversations[activeId] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastId = activeId ?? 'none';

  const last = conversation?.messages[conversation.messages.length - 1];
  const streamLen = last ? last.content.length + (last.thinking?.length ?? 0) + (last.toolCalls?.length ?? 0) : 0;

  useEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [streamLen, conversation?.messages.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stickRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const agent = conversation?.agentId ? AGENT_MAP[conversation.agentId] : AGENT_MAP.orchestrator;
  const activeRun = Object.values(runs).find((r) => r.conversationId === activeId && r.status === 'running');

  const showEmpty = !conversation || conversation.messages.length === 0;
  const title = conversation?.title ?? '新对话';
  const subtitle = conversation
    ? `${agent.name} · ${conversation.messages.length} 条消息 · ${settings.activeModel}`
    : `${agent.name} · ${settings.activeModel} · 等待指令`;

  const exportChat = async () => {
    if (!conversation) return;
    const md = await api.conversations.exportMarkdown(conversation.id);
    try {
      await navigator.clipboard.writeText(md);
      actions.toast('success', '对话已导出为 Markdown 并复制');
    } catch {
      actions.toast('warn', '剪贴板不可用，导出未完成');
    }
  };

  const retry = async (index: number) => {
    if (!conversation) return;
    const previous = [...conversation.messages.slice(0, index)].reverse().find((m) => m.role === 'user');
    if (!previous) return;
    await actions.send(previous.content, conversation.agentId, previous.attachments ?? []);
  };

  return (
    <div className="main">
      <div className="main-head">
        <div className="titles">
          <div className="t1">{title}</div>
          <div className="t2">{subtitle}</div>
        </div>
        <div className="head-actions">
          {activeRun ? (
            <span className="pill" style={{ color: 'var(--accent-2)', borderColor: 'var(--accent-line)', background: 'var(--accent-softer)' }}>
              <span
                className="dot"
                style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: 'rw-pulse 1.2s infinite' }}
              />
              执行中
            </span>
          ) : null}
          {conversation ? (
            <button type="button" className="icon-btn" title="导出 Markdown" onClick={() => void exportChat()}>
              ⇪
            </button>
          ) : null}
          <button
            type="button"
            className={`icon-btn${ui.railOpen ? ' on' : ''}`}
            title={ui.railOpen ? '收起运行轨迹' : '展开运行轨迹'}
            onClick={() => actions.setUi({ railOpen: !ui.railOpen })}
          >
            ▤
          </button>
        </div>
      </div>

      <div className="shell" style={{ minHeight: 0 }}>
        <div className="chat">
          {loadingConversation ? (
            <div className="loading-line">
              <span className="spin" />
              正在载入对话…
            </div>
          ) : showEmpty ? (
            <EmptyHome />
          ) : (
            <>
              <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
                <div className="chat-inner">
                  {conversation.messages.map((m, i) => {
                    const run = Object.values(runs).find((r) => r.messageId === m.id);
                    return (
                      <Message
                        key={m.id}
                        message={m}
                        conversation={conversation}
                        run={run}
                        approvals={approvals}
                        onApprove={actions.approve}
                        onRetry={() => void retry(i)}
                        allowRetry={m.role === 'assistant' && m.status === 'error'}
                        collapseThinking={settings.appearance.collapseThinking}
                      />
                    );
                  })}
                </div>
              </div>
              {showJump ? (
                <button
                  type="button"
                  className="scroll-bottom"
                  onClick={() => {
                    const el = scrollRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                    stickRef.current = true;
                    setShowJump(false);
                  }}
                  title="回到最新"
                >
                  ↓
                </button>
              ) : null}
              <Composer />
            </>
          )}
        </div>

        {ui.railOpen ? (
          <RightRail conversation={conversation ?? null} runs={runs} onClose={() => actions.setUi({ railOpen: false })} />
        ) : null}
      </div>

      {showEmpty ? (
        <div style={{ flex: '0 0 auto' }}>
          <Composer />
        </div>
      ) : null}

      <span className="sr-only">{metas.length} 个会话</span>
    </div>
  );
}

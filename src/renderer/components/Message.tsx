import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, ChatMessage, Conversation } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { api } from '../lib/bridge';
import { formatClock, formatDuration, formatTokens } from '../lib/format';
import type { RunInfo } from '../state/store';
import { Markdown } from './Markdown';
import { ThinkingPanel } from './ThinkingPanel';
import { ToolCard } from './ToolCard';
import { CopyButton } from './ui';

export function Message({
  message,
  conversation,
  run,
  approvals,
  onApprove,
  onRetry,
  allowRetry,
  collapseThinking = false,
}: {
  message: ChatMessage;
  conversation: Conversation;
  run?: RunInfo;
  approvals: ApprovalRequest[];
  onApprove(requestId: string, approved: boolean, remember: boolean): void;
  onRetry(): void;
  allowRetry: boolean;
  collapseThinking?: boolean;
}) {
  const [showCite, setShowCite] = useState(false);
  const citeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCite) return;
    const timer = setTimeout(() => citeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
    return () => clearTimeout(timer);
  }, [showCite]);

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-avatar" aria-hidden>
          我
        </div>
        <div className="msg-body">
          <div className="msg-user-bubble">{message.content}</div>
          {message.attachments && message.attachments.length > 0 ? (
            <div className="msg-attachments">
              {message.attachments.map((a) => (
                <span className="attach-chip" key={a.id} title={a.path}>
                  <span>{a.kind === 'image' ? '▧' : '▤'}</span>
                  <span className="nm">{a.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="msg-time" style={{ marginTop: 4 }}>
            {formatClock(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  if (message.role !== 'assistant') return null;

  const agent = message.agentId ? AGENT_MAP[message.agentId] : undefined;
  const streaming = message.status === 'streaming';
  const usage = message.usage;
  const duration = run ? (run.endedAt ? formatDuration(run.endedAt - run.startedAt) : streaming ? '' : '') : '';
  const pendingApproval = approvals.find((a) => a.runId === run?.runId);
  const conversationName = conversation.title;

  return (
    <div className="msg assistant">
      <div className="msg-avatar" aria-hidden>
        <img src="./icon.png" alt="" />
      </div>
      <div className="msg-body">
        <div className="msg-meta">
          <span
            className="agent-badge"
            style={{ ['--agent-color' as string]: agent?.color ?? '#3b82f6' }}
            title={agent?.tagline ?? conversationName}
          >
            <span className="ab-ico">{agent?.icon ?? '◎'}</span>
            {agent?.name ?? '总调度'}
          </span>
          <span className="meta-dim">{message.model ?? '未指定模型'}</span>
          {duration ? (
            <>
              <span className="sep" />
              <span className="meta-dim">耗时 {duration}</span>
            </>
          ) : null}
          {usage ? (
            <>
              <span className="sep" />
              <span className="meta-dim">
                {formatTokens(usage.totalTokens)} tok · ¥{usage.costCny.toFixed(4)}
              </span>
            </>
          ) : null}
          {streaming ? (
            <>
              <span className="sep" />
              <span className="meta-dim" style={{ color: 'var(--accent-2)' }}>
                <span className="dot" style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor', animation: 'rw-pulse 1.2s infinite' }} />
                生成中
              </span>
            </>
          ) : null}
          <span style={{ marginLeft: 'auto' }}>
            <CopyButton text={message.content} label="复制回复" />
          </span>
        </div>

        {run?.routing ? (
          <div className="routing-pill">
            <span>{AGENT_MAP[run.routing.from]?.name ?? '总调度'}</span>
            <span className="arrow">→</span>
            <span className="to">{AGENT_MAP[run.routing.to]?.name ?? run.routing.to}</span>
            <span className="arrow">·</span>
            <span style={{ opacity: 0.75 }}>{run.routing.reason}</span>
          </div>
        ) : null}

        {message.thinking ? (
          <ThinkingPanel
            text={message.thinking}
            streaming={streaming && !message.content}
            startedAt={run?.startedAt ?? message.createdAt}
            durationMs={run?.endedAt ? run.endedAt - run.startedAt : 0}
            langNote={run?.langNote}
            showTokens
            defaultCollapsed={collapseThinking}
          />
        ) : null}

        {message.toolCalls?.map((call) => (
          <ToolCard
            key={call.id}
            call={call}
            approval={pendingApproval?.toolName === call.name ? pendingApproval : undefined}
            onApprove={(approved, remember) => {
              if (pendingApproval?.toolName === call.name) {
                onApprove(pendingApproval.id, approved, remember);
              } else {
                onApprove(call.id, approved, remember);
              }
            }}
          />
        ))}

        {message.content ? <Markdown text={message.content} /> : null}

        {streaming && message.content ? (
          <span className="thinking-caret" style={{ marginTop: 6, verticalAlign: 'middle' }} />
        ) : null}

        {!message.content && !message.thinking && streaming ? (
          <div className="msg-status-note">
            <span className="dot" />
            正在连接模型，准备本轮执行…
          </div>
        ) : null}

        {message.status === 'error' ? (
          <div className="error-card">
            <div className="t">
              <span>⚠</span>本轮执行失败
            </div>
            <div className="d">{message.error ?? '模型返回了异常响应，请检查渠道配置或稍后重试。'}</div>
            {allowRetry ? (
              <div className="a">
                <button type="button" className="btn sm" onClick={onRetry}>
                  重试这一轮
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {message.status === 'aborted' ? (
          <div className="msg-status-note">
            <span style={{ color: 'var(--warn)' }}>■</span>已停止生成，本轮内容保留在对话中
          </div>
        ) : null}

        {message.citations && message.citations.length > 0 ? (
          <div className="citations" ref={citeRef}>
            <button type="button" className="citation-toggle" onClick={() => setShowCite((v) => !v)}>
              <span>{showCite ? '▾' : '▸'}</span>
              引用<span className="n">{message.citations.length}</span>
              来自知识库
            </button>
            {showCite ? (
              <div className="citation-list">
                {message.citations.map((c, i) => (
                  <button
                    type="button"
                    className="citation-item"
                    key={`${c.sourcePath}-${i}`}
                    onClick={() => void api.app.openPath(c.sourcePath)}
                    title="在系统中打开来源文件"
                  >
                    <span className="idx">{i + 1}</span>
                    <span className="body">
                      <span className="ct">{c.title}</span>
                      <span className="cs">{c.snippet}</span>
                      <span className="cp">{c.sourcePath}</span>
                    </span>
                    <span className="score">{c.score.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

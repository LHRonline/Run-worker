import { useEffect, useRef, useState } from 'react';
import { estimateTokens, formatDuration, formatTokens } from '../lib/format';

export function ThinkingPanel({
  text,
  streaming,
  startedAt,
  durationMs,
  langNote,
  showTokens,
  defaultCollapsed,
}: {
  text: string;
  streaming: boolean;
  startedAt: number;
  durationMs?: number;
  langNote?: { ratio: number; rewritten: boolean };
  showTokens: boolean;
  defaultCollapsed: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const [now, setNow] = useState(Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 设置里改「默认折叠」时，已渲染的面板也要跟着变化
  useEffect(() => {
    setOpen(!defaultCollapsed);
  }, [defaultCollapsed]);

  // 折叠状态下不必每 200ms 重渲染一次
  useEffect(() => {
    if (!streaming || !open) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [streaming, open]);

  /* 思考内容增长时始终跟随到底部，除非用户主动向上翻看 */
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, open, streaming]);

  const elapsed = Math.max(0, (streaming ? now : startedAt + (durationMs ?? 0)) - startedAt);
  const tokens = estimateTokens(text);

  return (
    <section className={`thinking${open ? ' open' : ' collapsed'}${streaming ? ' streaming' : ''}`}>
      <div className="thinking-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v);
        }}
      >
        <span className="thinking-toggle">▸</span>
        <span className="thinking-title">
          <span className="ic">✳</span>
          {open ? '思考过程' : '已思考'}
          <span className="thinking-zh">中文</span>
        </span>
        <span className="thinking-live">
          {streaming ? <span className="pd" /> : null}
          {formatDuration(elapsed)}
          {showTokens ? <span title="思考内容为本地字符估算，非服务商精确值">· 约 {formatTokens(tokens)} tok</span> : null}
        </span>
        <span className="right">
          <span style={{ fontSize: 10, color: 'var(--faint)' }}>{open ? '收起' : '展开'}</span>
        </span>
      </div>
      {langNote && open ? (
        <div className="lang-note">
          <span>✓</span>
          思考已转中文 · 中文占比 {Math.round(langNote.ratio * 100)}%
          {langNote.rewritten ? '（已重述一次）' : ''}
        </div>
      ) : null}
      <div
        className="thinking-body"
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text}
        {streaming ? <span className="thinking-caret" /> : null}
      </div>
    </section>
  );
}

import { useState } from 'react';
import type { ApprovalRequest, ToolCallRecord } from '@shared/types';
import { formatDuration } from '../lib/format';
import { CopyButton } from './ui';

const STATUS_LABEL: Record<ToolCallRecord['status'], { text: string; cls: string }> = {
  pending: { text: '等待授权', cls: 'wait' },
  approved: { text: '已批准', cls: 'run' },
  running: { text: '运行中', cls: 'run' },
  done: { text: '完成', cls: 'ok' },
  error: { text: '失败', cls: 'err' },
  denied: { text: '已拒绝', cls: 'err' },
};

function riskOf(name: string): 'low' | 'medium' | 'high' {
  if (/delete|remove|shell\.exec|kill|format|shutdown/i.test(name)) return 'high';
  if (/python|write|move|rename|mcp\.call|exec/i.test(name)) return 'medium';
  return 'low';
}

function summarize(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '无参数';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
}

export function ToolCard({
  call,
  approval,
  onApprove,
}: {
  call: ToolCallRecord;
  approval?: ApprovalRequest;
  onApprove?(approved: boolean, remember: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const risk = riskOf(call.name);
  const status = STATUS_LABEL[call.status] ?? STATUS_LABEL.pending;
  const needsApproval = Boolean(call.requiresApproval) && (call.status === 'pending' || call.status === 'approved');
  const duration =
    call.startedAt && call.endedAt ? formatDuration(call.endedAt - call.startedAt) : call.startedAt ? '执行中' : '';

  return (
    <div className={`tool-card ${risk}`}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v);
        }}
      >
        <span className="tool-glyph">⌘</span>
        <span className="tool-name">{call.name}</span>
        <span className={`tool-status ${status.cls}`}>
          {call.status === 'running' ? <span className="dot" style={{ width: 4, height: 4, borderRadius: '50%', background: 'currentColor', animation: 'rw-pulse 1.2s infinite' }} /> : null}
          {status.text}
        </span>
        <span className="right">
          {duration ? <span>{duration}</span> : null}
          <span className={`risk-tag ${risk}`}>{risk === 'high' ? '高风险' : risk === 'medium' ? '需留意' : '低风险'}</span>
          <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s' }}>▸</span>
        </span>
      </div>
      {!open ? <div className="tool-summary">{summarize(call.args)}</div> : null}
      {open ? (
        <div className="tool-expand">
          <div className="tiny-label" style={{ justifyContent: 'space-between' }}>
            <span>调用参数</span>
            <CopyButton text={JSON.stringify(call.args, null, 2)} label="复制参数" />
          </div>
          <pre className="tool-code">{JSON.stringify(call.args, null, 2)}</pre>
          {call.result ? (
            <>
              <div className="tiny-label">返回结果</div>
              <div className="tool-result">{call.result}</div>
            </>
          ) : null}
          {call.error ? <div className="tool-error">{call.error}</div> : null}
        </div>
      ) : null}
      {needsApproval ? (
        <div className="tool-approve">
          <span className="txt">
            此操作会修改本地状态，需要你确认后才会执行{approval ? `：${approval.reason}` : '。'}
          </span>
          <button type="button" className="btn sm" onClick={() => onApprove?.(true, false)}>
            允许一次
          </button>
          <button type="button" className="btn sm" onClick={() => onApprove?.(true, true)}>
            始终允许
          </button>
          <button type="button" className="btn sm danger" onClick={() => onApprove?.(false, false)}>
            拒绝
          </button>
        </div>
      ) : null}
    </div>
  );
}

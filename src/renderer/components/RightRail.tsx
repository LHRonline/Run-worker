import type { Conversation } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { estimateTokens, formatCny, formatDuration, formatTokens, formatClock } from '../lib/format';
import type { RunInfo } from '../state/store';

const STATUS_TEXT: Record<string, string> = {
  pending: '等待授权',
  approved: '已批准',
  running: '运行中',
  done: '完成',
  error: '失败',
  denied: '已拒绝',
};

export function RightRail({
  conversation,
  runs,
  onClose,
}: {
  conversation: Conversation | null;
  runs: Record<string, RunInfo>;
  onClose(): void;
}) {
  const last = conversation ? [...conversation.messages].reverse().find((m) => m.role === 'assistant') : undefined;
  const run = last ? Object.values(runs).find((r) => r.messageId === last.id) : undefined;
  const agent = last?.agentId ? AGENT_MAP[last.agentId] : undefined;
  const usage = last?.usage;
  const liveTokens = last
    ? estimateTokens(`${last.thinking ?? ''}${last.content}`)
    : 0;
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? (last?.status === 'streaming' ? Math.round(liveTokens * 0.7) : 0);
  const reasoningTokens = usage?.reasoningTokens ?? (last?.thinking ? estimateTokens(last.thinking) : 0);
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens + reasoningTokens;
  const tools = last?.toolCalls ?? [];

  const steps: { title: string; sub?: string; state: 'done' | 'running' | 'idle' }[] = [];
  if (last) {
    steps.push({
      title: '接收任务',
      sub: `${agent?.name ?? '总调度'} · ${last.model ?? '默认模型'}`,
      state: 'done',
    });
    if (run?.routing) {
      steps.push({
        title: `调度到 ${AGENT_MAP[run.routing.to]?.name ?? run.routing.to}`,
        sub: run.routing.reason,
        state: 'done',
      });
    }
    if (last.thinking) {
      steps.push({
        title: '推理与规划',
        sub: run?.endedAt ? formatDuration(run.endedAt - run.startedAt) : '进行中',
        state: 'done',
      });
    }
    tools.forEach((t) => {
      steps.push({
        title: `调用 ${t.name}`,
        sub: STATUS_TEXT[t.status] ?? t.status,
        state: t.status === 'done' || t.status === 'error' || t.status === 'denied' ? 'done' : 'running',
      });
    });
    if (last.citations?.length) {
      steps.push({ title: '检索知识库', sub: `${last.citations.length} 条引用`, state: 'done' });
    }
    steps.push({
      title: last.status === 'error' ? '执行失败' : last.status === 'aborted' ? '已停止' : '输出结果',
      sub: last.status === 'streaming' ? '正在生成' : formatClock(last.createdAt),
      state: last.status === 'streaming' ? 'running' : 'done',
    });
  }

  return (
    <aside className="rail">
      <div className="rail-head">
        <span>运行轨迹</span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} onClick={onClose} title="收起轨迹栏">
            ›
          </button>
        </span>
      </div>
      <div className="rail-scroll">
        {!last ? (
          <div className="empty-hint" style={{ marginTop: 8 }}>
            发送第一条消息后，这里会实时显示 Agent 调度、工具调用与 token 计量。
          </div>
        ) : (
          <>
            <div className="rail-block">
              <div className="rail-block-title">本轮概览</div>
              <div className="rail-kv">
                <span className="k">执行 Agent</span>
                <span className="v" style={{ color: agent?.color }}>
                  {agent?.name ?? '总调度'}
                </span>
              </div>
              <div className="rail-kv">
                <span className="k">模型</span>
                <span className="v">{last.model ?? '—'}</span>
              </div>
              <div className="rail-kv">
                <span className="k">状态</span>
                <span className="v" style={{ color: last.status === 'error' ? 'var(--err)' : last.status === 'streaming' ? 'var(--accent-2)' : 'var(--ok)' }}>
                  {last.status === 'streaming' ? '运行中' : last.status === 'error' ? '失败' : last.status === 'aborted' ? '已停止' : '已完成'}
                </span>
              </div>
              <div className="rail-kv">
                <span className="k">工具调用</span>
                <span className="v">{tools.length} 次</span>
              </div>
            </div>

            <div className="rail-block">
              <div className="rail-block-title">Token 计量</div>
              <div className="rail-kv">
                <span className="k">输入</span>
                <span className="v">{formatTokens(promptTokens)}</span>
              </div>
              <div className="rail-kv">
                <span className="k">输出</span>
                <span className="v">{formatTokens(completionTokens)}</span>
              </div>
              <div className="rail-kv">
                <span className="k">思考</span>
                <span className="v">{formatTokens(reasoningTokens)}</span>
              </div>
              <div className="rail-kv">
                <span className="k">本轮合计</span>
                <span className="v" style={{ color: 'var(--accent-text)' }}>{formatTokens(totalTokens)} tok</span>
              </div>
              <div className="rail-kv">
                <span className="k">本轮费用</span>
                <span className="v">{formatCny(usage?.costCny ?? 0)}</span>
              </div>
              <div className="rail-kv">
                <span className="k">会话累计</span>
                <span className="v">{formatTokens(conversation?.usage.totalTokens ?? 0)} tok</span>
              </div>
            </div>

            <div className="rail-block">
              <div className="rail-block-title">执行步骤</div>
              {steps.map((s, i) => (
                <div className={`rail-step ${s.state}`} key={i}>
                  <span className="line" />
                  <span className="node" />
                  <span className="body">
                    <span className="title">{s.title}</span>
                    {s.sub ? <span className="sub">{s.sub}</span> : null}
                  </span>
                </div>
              ))}
            </div>

            {tools.length ? (
              <div className="rail-block">
                <div className="rail-block-title">工具明细</div>
                {tools.map((t) => (
                  <div className="rail-kv" key={t.id}>
                    <span className="k mono-text" style={{ fontSize: 10.5 }}>
                      {t.name}
                    </span>
                    <span className="v" style={{ color: t.status === 'error' || t.status === 'denied' ? 'var(--err)' : t.status === 'done' ? 'var(--ok)' : 'var(--warn)' }}>
                      {STATUS_TEXT[t.status] ?? t.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {last.error ? (
              <div className="note-card" style={{ borderColor: 'var(--err)', background: 'var(--err-soft)' }}>
                <span className="ni" style={{ color: 'var(--err)' }}>
                  ⚠
                </span>
                <span>{last.error}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

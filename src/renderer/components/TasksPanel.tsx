import { useEffect, useMemo, useState } from 'react';
import type { AgentId, ScheduleKind, ScheduledTask } from '@shared/types';
import { AGENT_MAP } from '@shared/agents';
import { cronToHuman, nextRunAt } from '../lib/cron';
import { formatDateTime, formatDuration, formatFuture, formatRelative, uid } from '../lib/format';
import { useStore } from '../state/store';
import { Confirm, Modal } from './Modal';
import { Field, Seg, Switch } from './ui';

const QUICK_CRON = [
  { label: '每天 9:00', expr: '0 9 * * *' },
  { label: '每小时', expr: '0 * * * *' },
  { label: '每周一 10:00', expr: '0 10 * * 1' },
  { label: '每 30 分钟', expr: '*/30 * * * *' },
];

function toLocalInput(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyTask(): ScheduledTask {
  return {
    id: uid('task'),
    name: '',
    prompt: '',
    agentId: 'orchestrator',
    kind: 'cron',
    cron: '0 9 * * *',
    enabled: true,
    createdAt: Date.now(),
    indexResult: true,
  };
}

export function TasksPanel() {
  const { state, actions } = useStore();
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [removing, setRemoving] = useState<ScheduledTask | null>(null);
  const [historyFor, setHistoryFor] = useState<ScheduledTask | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    void actions.loadTaskHistory();
  }, [actions]);

  const enabledCount = state.tasks.filter((t) => t.enabled).length;

  const history = useMemo(
    () => (historyFor ? state.taskHistory.filter((r) => r.taskId === historyFor.id) : state.taskHistory),
    [historyFor, state.taskHistory],
  );

  return (
    <div className="main">
      <div className="page">
        <div className="page-scroll">
          <div className="page-inner">
            <div className="page-head">
              <div className="lead">
                <h2 className="page-title">
                  定时任务
                  <span className="badge info">{enabledCount} 个运行中</span>
                </h2>
                <p className="page-sub">
                  让 Run worker 按计划自动干活：整理文件、生成周报、巡检项目。执行结果可写入知识库供后续检索。
                </p>
              </div>
              <div className="page-actions">
                <button type="button" className="btn" onClick={() => setHistoryFor({ ...emptyTask(), name: '' })}>
                  全部运行历史
                </button>
                <button type="button" className="btn primary" onClick={() => setEditing(emptyTask())}>
                  ＋ 新建任务
                </button>
              </div>
            </div>

            {state.tasks.length === 0 ? (
              <div className="empty-hint">
                还没有定时任务。新建一个，例如「每天 9:00 汇总昨日文档要点」。
              </div>
            ) : (
              <div className="task-list">
                {state.tasks.map((task) => {
                  const agent = AGENT_MAP[task.agentId] ?? AGENT_MAP.orchestrator;
                  const next = task.nextRunAt ?? (task.kind === 'cron' && task.cron ? nextRunAt(task.cron) : task.runAt);
                  return (
                    <div className={`task-card${task.enabled ? '' : ' disabled'}`} key={task.id}>
                      <span className="status-dot" style={{ background: agent.color, boxShadow: `0 0 8px ${agent.color}66` }} />
                      <div className="task-main">
                        <div className="task-name">
                          {task.name || '未命名任务'}
                          <span className="badge" style={{ color: agent.color }}>
                            {agent.name}
                          </span>
                          {task.indexResult ? <span className="badge info">写入知识库</span> : null}
                        </div>
                        <div className="task-prompt">{task.prompt}</div>
                        <div className="task-meta">
                          <span className="m">
                            <span className="k">计划</span>
                            {task.kind === 'cron'
                              ? `${cronToHuman(task.cron ?? '')}（${task.cron}）`
                              : task.kind === 'interval'
                                ? `每 ${task.intervalMinutes ?? 60} 分钟`
                                : `单次 ${formatDateTime(task.runAt ?? Date.now())}`}
                          </span>
                          <span className="m">
                            <span className="k">下次</span>
                            {task.enabled ? formatFuture(next) : '已停用'}
                          </span>
                          {task.nextNote ? (
                            <span className="m note" title={task.nextNote}>
                              <span className="k">顺延</span>
                              {task.nextNote}
                            </span>
                          ) : null}
                          <span className="m">
                            <span className="k">上次</span>
                            {task.lastRunAt ? formatRelative(task.lastRunAt) : '尚未执行'}
                            {task.lastStatus ? (
                              <span className={`badge ${task.lastStatus === 'success' ? 'ok' : task.lastStatus === 'running' ? 'info' : 'err'}`}>
                                {task.lastStatus === 'success' ? '成功' : task.lastStatus === 'running' ? '执行中' : '失败'}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </div>
                      <div className="task-actions">
                        <Switch
                          checked={task.enabled}
                          title={task.enabled ? '停用任务' : '启用任务'}
                          onChange={(v) => void actions.saveTask({ ...task, enabled: v })}
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          title="立即运行"
                          disabled={runningId === task.id}
                          onClick={async () => {
                            setRunningId(task.id);
                            await actions.runTask(task.id);
                            setRunningId(null);
                          }}
                        >
                          {runningId === task.id ? <span className="spin" /> : '▶'}
                        </button>
                        <button type="button" className="icon-btn" title="运行历史" onClick={() => setHistoryFor(task)}>
                          ◷
                        </button>
                        <button type="button" className="icon-btn" title="编辑" onClick={() => setEditing({ ...task })}>
                          ✎
                        </button>
                        <button type="button" className="icon-btn" title="删除" onClick={() => setRemoving(task)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="note-card" style={{ marginTop: 18 }}>
              <span className="ni">◷</span>
              <span>
                定时任务使用本机时间。应用退出后不会执行；开启结果索引后，每次输出会作为知识库来源参与后续检索。
              </span>
            </div>
          </div>
        </div>
      </div>

      {editing ? (
        <TaskEditor
          task={editing}
          onClose={() => setEditing(null)}
          onSave={async (task) => {
            await actions.saveTask(task);
            setEditing(null);
          }}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="删除定时任务"
          text={`「${removing.name || '未命名任务'}」将被删除，已产生的运行历史仍会保留。`}
          onClose={() => setRemoving(null)}
          onConfirm={() => void actions.removeTask(removing.id)}
        />
      ) : null}

      {historyFor ? (
        <Modal
          title={historyFor.name ? `运行历史 · ${historyFor.name}` : '全部运行历史'}
          subtitle={`共 ${history.length} 条记录`}
          onClose={() => setHistoryFor(null)}
          footer={
            <button type="button" className="btn" onClick={() => setHistoryFor(null)}>
              关闭
            </button>
          }
        >
          {history.length === 0 ? (
            <div className="empty-hint">还没有运行记录，点任务卡上的 ▶ 立即执行一次。</div>
          ) : (
            <div>
              {history.map((run) => {
                const task = state.tasks.find((t) => t.id === run.taskId);
                return (
                  <div className="history-row" key={run.id}>
                    <span className="time">{formatDateTime(run.startedAt)}</span>
                    <span className={`badge ${run.status === 'success' ? 'ok' : run.status === 'running' ? 'info' : 'err'}`}>
                      {run.status === 'success' ? '成功' : run.status === 'running' ? '执行中' : '失败'}
                    </span>
                    <span className="out" title={run.output ?? run.error}>
                      {historyFor.name ? run.output ?? run.error ?? '—' : `${task?.name ?? '已删除任务'} · ${run.output ?? run.error ?? '—'}`}
                    </span>
                    <span className="dur">{run.endedAt ? formatDuration(run.endedAt - run.startedAt) : '—'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}

function TaskEditor({
  task,
  onClose,
  onSave,
}: {
  task: ScheduledTask;
  onClose(): void;
  onSave(task: ScheduledTask): Promise<void>;
}) {
  const { state } = useStore();
  const [draft, setDraft] = useState<ScheduledTask>(task);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<ScheduledTask>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return;
    setSaving(true);
    const next: ScheduledTask = {
      ...draft,
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      nextRunAt:
        draft.kind === 'cron'
          ? nextRunAt(draft.cron ?? '')
          : draft.kind === 'once'
            ? draft.runAt
            : Date.now() + (draft.intervalMinutes ?? 60) * 60_000,
    };
    await onSave(next);
    setSaving(false);
  };

  return (
    <Modal
      title={task.name ? '编辑定时任务' : '新建定时任务'}
      subtitle="任务在应用运行时按本机时间触发"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`btn primary${saving ? ' loading' : ''}`}
            disabled={!draft.name.trim() || !draft.prompt.trim()}
            onClick={() => void save()}
          >
            {saving ? <span className="spin" /> : null}
            保存任务
          </button>
        </>
      }
    >
      <Field label="任务名称" required>
        <input
          className="input"
          value={draft.name}
          placeholder="例如：每日工作晨报"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>
      <Field label="提示词" hint="用自然语言写清楚要做什么、输出什么格式，Agent 会按此执行。" required>
        <textarea
          className="textarea"
          rows={4}
          value={draft.prompt}
          placeholder="例如：汇总昨天新增的文档要点，输出 5 条待办并标注优先级。"
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </Field>
      <Field label="执行 Agent">
        <select className="select" value={draft.agentId} onChange={(e) => patch({ agentId: e.target.value as AgentId })}>
          {state.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.tagline}
            </option>
          ))}
        </select>
      </Field>

      <Field label="触发方式">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Seg<ScheduleKind>
            value={draft.kind}
            onChange={(kind) => patch({ kind })}
            options={[
              { value: 'cron', label: '按 cron' },
              { value: 'interval', label: '固定间隔' },
              { value: 'once', label: '单次执行' },
            ]}
          />
          {draft.kind === 'cron' ? (
            <span className="field-hint" style={{ margin: 0 }}>
              {cronToHuman(draft.cron ?? '')}
            </span>
          ) : null}
        </div>
      </Field>

      {draft.kind === 'cron' ? (
        <>
          <Field label="cron 表达式" hint="5 段格式：分 时 日 月 周。例如 0 9 * * * 表示每天 9:00。">
            <input
              className="input mono-text"
              value={draft.cron ?? ''}
              placeholder="0 9 * * *"
              onChange={(e) => patch({ cron: e.target.value })}
            />
          </Field>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -8, marginBottom: 16 }}>
            {QUICK_CRON.map((q) => (
              <button
                type="button"
                key={q.expr}
                className={`btn sm${draft.cron === q.expr ? ' primary' : ''}`}
                onClick={() => patch({ cron: q.expr })}
              >
                {q.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {draft.kind === 'interval' ? (
        <Field label="间隔分钟" hint="最短 5 分钟。应用需保持运行。">
          <input
            className="input"
            type="number"
            min={5}
            value={draft.intervalMinutes ?? 60}
            onChange={(e) => patch({ intervalMinutes: Math.max(5, Number(e.target.value) || 5) })}
          />
        </Field>
      ) : null}

      {draft.kind === 'once' ? (
        <Field label="执行时间">
          <input
            className="input"
            type="datetime-local"
            value={toLocalInput(draft.runAt)}
            onChange={(e) => {
              const v = e.target.value;
              patch({ runAt: v ? new Date(v).getTime() : undefined });
            }}
          />
        </Field>
      ) : null}

      <div className="set-row" style={{ borderBottom: 'none' }}>
        <div className="set-row-main">
          <div className="set-row-title">结果写入知识库</div>
          <div className="set-row-desc">每次执行的输出会作为知识库来源参与后续检索与引用。</div>
        </div>
        <div className="set-row-ctrl">
          <Switch checked={draft.indexResult} onChange={(v) => patch({ indexResult: v })} />
        </div>
      </div>
    </Modal>
  );
}

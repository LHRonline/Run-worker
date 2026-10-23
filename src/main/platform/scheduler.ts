/**
 * 定时任务调度器（TaskScheduler）
 *
 * 持久化：<dataDir>/tasks/tasks.json（任务）、tasks/history.json（执行历史，上限 100 条）
 * 调度：30 秒 ticker 扫描 nextRunAt <= now 的启用任务
 * cron：自实现 5 段解析（分 时 日 月 周），支持星号、步进（n 分之步）、区间 a-b、枚举 a,b、问号，本地时区
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EVT } from '../../shared/ipc';
import type { AgentRunner, PlatformDeps, TaskScheduler } from '../../shared/platform';
import type { AgentId, ScheduledTask, TaskRun } from '../../shared/types';

const TICK_MS = 30_000;
const HISTORY_LIMIT = 100;
/** nextRunAt 最大向前搜索范围：1 年 */
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

/* ----------------------------- cron 解析 ----------------------------- */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  /** 0=周日 ... 6=周六 */
  weekdays: Set<number>;
  /** 日 / 周字段是否都被限制（用于标准 cron 的 OR 语义） */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
  /** 周字段允许 7 表示周日 */
  allowSeven?: boolean;
}

function parseField(raw: string, spec: FieldSpec): Set<number> | null {
  const text = raw.trim();
  if (!text) return null;
  if (text === '*' || text === '?') {
    const all = new Set<number>();
    for (let i = spec.min; i <= spec.max; i += 1) all.add(i);
    return all;
  }

  const out = new Set<number>();
  for (const part of text.split(',')) {
    const seg = part.trim();
    if (!seg) return null;

    if (seg === '*' || seg === '?') {
      for (let i = spec.min; i <= spec.max; i += 1) out.add(i);
      continue;
    }

    // */n 或 a-b/n 或 a/n
    const stepMatch = seg.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2]);
      if (!Number.isInteger(step) || step <= 0) return null;
      let lo = spec.min;
      let hi = spec.max;
      const range = stepMatch[1];
      if (range !== '*') {
        const bounds = range.split('-').map(Number);
        lo = bounds[0];
        hi = bounds.length > 1 ? bounds[1] : spec.max;
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return null;
      for (let v = lo; v <= hi; v += step) if (v >= spec.min && v <= spec.max) out.add(v);
      continue;
    }

    // a-b
    const rangeMatch = seg.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return null;
      for (let v = lo; v <= hi; v += 1) if (v >= spec.min && v <= spec.max) out.add(v);
      continue;
    }

    // 单值
    if (/^\d+$/.test(seg)) {
      const v = Number(seg);
      if (!Number.isInteger(v) || v < spec.min || v > spec.max) return null;
      out.add(v);
      continue;
    }

    return null;
  }

  return out.size > 0 ? out : null;
}

function parseCron(expr: string): CronFields | null {
  const parts = String(expr ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0], { min: 0, max: 59 });
  const hours = parseField(parts[1], { min: 0, max: 23 });
  const days = parseField(parts[2], { min: 1, max: 31 });
  const months = parseField(parts[3], { min: 1, max: 12 });
  const rawWeekdays = parseField(parts[4], { min: 0, max: 7 });
  if (!minutes || !hours || !days || !months || !rawWeekdays) return null;

  // 7 与 0 都表示周日
  const weekdays = new Set<number>();
  for (const d of rawWeekdays) weekdays.add(d === 7 ? 0 : d);

  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayRestricted: !/^[\s?*]+$/.test(parts[2]),
    weekdayRestricted: !/^[\s?*]+$/.test(parts[4]),
  };
}

function dayMatches(f: CronFields, date: Date): boolean {
  const dom = f.days.has(date.getDate());
  const dow = f.weekdays.has(date.getDay());
  // 标准 cron：日与周都被限制时取 OR，否则取被限制的那个
  if (f.dayRestricted && f.weekdayRestricted) return dom || dow;
  if (f.dayRestricted) return dom;
  if (f.weekdayRestricted) return dow;
  return true;
}

/** 计算下一次执行时间（分钟对齐，逐分钟向前找，最多 1 年） */
function nextCronTime(fields: CronFields, from: number): number | undefined {
  const start = new Date(from);
  start.setSeconds(0, 0);
  const cursor = new Date(start.getTime() + 60_000);

  for (let i = 0; i < MAX_SEARCH_MINUTES; i += 1) {
    if (
      fields.months.has(cursor.getMonth() + 1) &&
      dayMatches(fields, cursor) &&
      fields.hours.has(cursor.getHours()) &&
      fields.minutes.has(cursor.getMinutes())
    ) {
      return cursor.getTime();
    }
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return undefined;
}

/* ----------------------------- 工具函数 ----------------------------- */

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T, log: PlatformDeps['log']): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text) as T;
  } catch (err) {
    log.warn(`[scheduler] 读取 ${path.basename(file)} 失败，使用空数据`, err);
    return fallback;
  }
}

/** 计算任务的下一次执行时间 */
function computeNextRun(task: ScheduledTask, from = Date.now()): number | undefined {
  if (!task.enabled) return undefined;

  if (task.kind === 'cron') {
    const fields = parseCron(task.cron ?? '');
    if (!fields) return undefined;
    return nextCronTime(fields, from);
  }

  if (task.kind === 'interval') {
    const minutes = Math.max(1, Math.round(Number(task.intervalMinutes) || 0));
    const base = task.lastRunAt ?? from;
    const next = base + minutes * 60_000;
    return next > from ? next : from + minutes * 60_000;
  }

  // once：已执行过则不再排期；错过时间点但还没执行过的任务立即补跑
  const runAt = Number(task.runAt) || 0;
  if (!runAt) return undefined;
  if (task.lastRunAt && task.lastRunAt >= runAt) return undefined;
  return runAt > from ? runAt : from;
}

/* ----------------------------- 工厂实现 ----------------------------- */

export function createScheduler(deps: PlatformDeps & { runner: AgentRunner }): TaskScheduler {
  const dir = path.join(deps.dataDir, 'tasks');
  const tasksFile = path.join(dir, 'tasks.json');
  const historyFile = path.join(dir, 'history.json');
  const outputDir = path.join(deps.dataDir, 'task-output');

  let tasks: ScheduledTask[] = [];
  let runs: TaskRun[] = [];
  let timer: NodeJS.Timeout | null = null;
  /** 正在执行的任务 id，防止重入 */
  const running = new Set<string>();

  fs.mkdirSync(dir, { recursive: true });

  function loadAll(): void {
    const rawTasks = readJson<unknown>(tasksFile, [], deps.log);
    const list = Array.isArray(rawTasks) ? rawTasks : [];
    tasks = list
      .filter((t): t is ScheduledTask => !!t && typeof (t as ScheduledTask).id === 'string' && typeof (t as ScheduledTask).prompt === 'string')
      .map((t) => ({
        ...t,
        kind: t.kind ?? 'cron',
        enabled: !!t.enabled,
        indexResult: !!t.indexResult,
        createdAt: Number(t.createdAt) || Date.now(),
      }));

    const rawRuns = readJson<unknown>(historyFile, [], deps.log);
    const runList = Array.isArray(rawRuns) ? rawRuns : [];
    runs = runList
      .filter((r): r is TaskRun => !!r && typeof (r as TaskRun).id === 'string')
      .slice(0, HISTORY_LIMIT);
  }

  function persistTasks(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(tasksFile, tasks);
    } catch (err) {
      deps.log.error('[scheduler] 保存任务失败', err);
    }
  }

  function persistHistory(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      runs = runs.slice(0, HISTORY_LIMIT);
      writeJsonAtomic(historyFile, runs);
    } catch (err) {
      deps.log.error('[scheduler] 保存执行历史失败', err);
    }
  }

  function emitChanged(): void {
    deps.emit(EVT.tasksChanged, tasks);
  }

  /** 执行任务并返回本次运行记录 */
  async function execute(task: ScheduledTask): Promise<TaskRun> {
    const run: TaskRun = {
      id: newId('run'),
      taskId: task.id,
      startedAt: Date.now(),
      status: 'running',
    };

    running.add(task.id);
    runs = [run, ...runs].slice(0, HISTORY_LIMIT);
    task.lastStatus = 'running';
    emitChanged();

    try {
      const result = await deps.runner.run(task.prompt, {
        agentId: task.agentId,
        title: task.name,
        source: 'scheduler',
      });
      const text = String(result?.text ?? '');
      run.status = 'success';
      run.output = text;
      run.endedAt = Date.now();
      task.lastStatus = 'success';
      task.lastResult = text.slice(0, 4000);
      deps.log.info(`[scheduler] 任务「${task.name}」执行成功`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.status = 'error';
      run.error = message || '执行失败';
      run.endedAt = Date.now();
      task.lastStatus = 'error';
      task.lastResult = run.error;
      deps.log.error(`[scheduler] 任务「${task.name}」执行失败`, err);
    } finally {
      running.delete(task.id);
    }

    const now = Date.now();
    task.lastRunAt = now;

    // 结果落盘（indexResult 为 true 时），供知识库后续收录
    if (task.indexResult && run.status === 'success' && run.output) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
        const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
        const file = path.join(outputDir, `${task.id}-${stamp}.md`);
        const body = `# ${task.name}\n\n- 任务 ID：${task.id}\n- 执行时间：${new Date(now).toLocaleString('zh-CN')}\n\n---\n\n${run.output}\n`;
        fs.writeFileSync(file, body, 'utf8');
      } catch (err) {
        deps.log.warn('[scheduler] 写入任务输出文件失败', err);
      }
    }

    if (task.kind === 'once') {
      task.enabled = false;
      task.nextRunAt = undefined;
    } else {
      task.nextRunAt = computeNextRun(task, now);
    }

    persistTasks();
    persistHistory();
    emitChanged();
    return run;
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    const due = tasks.filter(
      (t) => t.enabled && typeof t.nextRunAt === 'number' && t.nextRunAt <= now && !running.has(t.id),
    );

    for (const task of due) {
      // 逐个串行执行，避免同时打满模型配额
      try {
        await execute(task);
      } catch (err) {
        deps.log.error('[scheduler] 任务调度异常', err);
      }
    }
  }

  loadAll();

  // 启动时校准 nextRunAt：
  // - 上次排期已过期且此后未执行 → 保留该时间，ticker 会补跑最近一次；
  // - 其余情况按当前时间重算，避免把错过的历史窗口密集补跑一遍。
  let recalculated = false;
  const bootNow = Date.now();
  for (const t of tasks) {
    if (!t.enabled) continue;
    const stored = t.nextRunAt;
    const missed = typeof stored === 'number' && stored <= bootNow && !(t.lastRunAt && t.lastRunAt >= stored);
    if (missed) continue;
    const next = computeNextRun(t, bootNow);
    if (next !== stored) {
      t.nextRunAt = next;
      recalculated = true;
    }
  }
  if (recalculated) persistTasks();

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      if (typeof timer.unref === 'function') timer.unref();
      // 启动时立即检查一次
      setTimeout(() => void tick(), 3_000).unref?.();
      deps.log.info(`[scheduler] 已启动，共 ${tasks.length} 个任务`);
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      deps.log.info('[scheduler] 已停止');
    },

    list(): ScheduledTask[] {
      return [...tasks].sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER);
      });
    },

    save(input: ScheduledTask): ScheduledTask[] {
      const now = Date.now();
      const source = input ?? ({} as ScheduledTask);
      const existing = tasks.find((t) => t.id === source.id);

      const task: ScheduledTask = {
        id: source.id || newId('task'),
        name: (source.name ?? '').trim() || '未命名任务',
        prompt: source.prompt ?? '',
        agentId: (source.agentId ?? 'orchestrator') as AgentId,
        kind: source.kind ?? 'cron',
        cron: source.cron,
        intervalMinutes:
          source.kind === 'interval' ? Math.max(1, Math.round(Number(source.intervalMinutes) || 60)) : source.intervalMinutes,
        runAt: source.kind === 'once' ? Number(source.runAt) || now + 60_000 : source.runAt,
        enabled: source.enabled !== false,
        createdAt: existing?.createdAt ?? (Number(source.createdAt) || now),
        lastRunAt: existing?.lastRunAt ?? source.lastRunAt,
        lastStatus: existing?.lastStatus ?? source.lastStatus,
        lastResult: existing?.lastResult ?? source.lastResult,
        indexResult: !!source.indexResult,
        nextRunAt: undefined,
      };

      task.nextRunAt = computeNextRun(task, now);

      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) tasks[idx] = task;
      else tasks.push(task);

      persistTasks();
      emitChanged();
      return this.list();
    },

    remove(id: string): ScheduledTask[] {
      tasks = tasks.filter((t) => t.id !== id);
      running.delete(id);
      persistTasks();
      emitChanged();
      return this.list();
    },

    async runNow(id: string): Promise<TaskRun> {
      const task = tasks.find((t) => t.id === id);
      if (!task) {
        return {
          id: newId('run'),
          taskId: id,
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: 'error',
          error: '任务不存在',
        };
      }
      if (running.has(id)) {
        return {
          id: newId('run'),
          taskId: id,
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: 'error',
          error: '该任务正在执行中，请稍后再试',
        };
      }
      return execute(task);
    },

    history(): TaskRun[] {
      return [...runs].sort((a, b) => b.startedAt - a.startedAt);
    },
  };
}

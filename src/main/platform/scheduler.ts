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
// 复用 store.ts 的原子写（含 Windows 占用回退与 tmp 清理）。
// store.ts 顶层只依赖 shared 层的 presets / types / ipc / platform，
// shared 层不反向 import main，故此处单向依赖不会形成循环。
import { writeJsonAtomic } from '../store';

const TICK_MS = 30_000;
const HISTORY_LIMIT = 100;
/** task-output/*.md 滚动清理后保留的最近文件数 */
const OUTPUT_KEEP = 100;
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

/** 集合中严格大于 cur 的最小值 */
function nextAllowed(set: Set<number>, cur: number): number | undefined {
  let best: number | undefined;
  for (const v of set) {
    if (v > cur && (best === undefined || v < best)) best = v;
  }
  return best;
}

/** 集合中的最小值 */
function minAllowed(set: Set<number>): number {
  let best = Infinity;
  for (const v of set) if (v < best) best = v;
  return best;
}

/** 计算下一次执行时间：按 月 / 日 / 时 / 分 逐级跳进，取代逐分钟暴力搜索。
 *  语义与原逐分钟扫描完全一致：从 from 的下一分钟起，找第一个同时满足
 *  月份、dom/dow（OR 规则）、小时、分钟 的时刻；超过 1 年仍未命中返回 undefined。 */
function nextCronTime(fields: CronFields, from: number): number | undefined {
  const aligned = new Date(from);
  aligned.setSeconds(0, 0);
  const deadline = aligned.getTime() + MAX_SEARCH_MINUTES * 60_000;
  const cursor = new Date(aligned.getTime() + 60_000);

  const minHour = minAllowed(fields.hours);
  const minMinute = minAllowed(fields.minutes);
  const minMonth = minAllowed(fields.months);

  while (cursor.getTime() <= deadline) {
    // 每次跳进都必须让游标前进；本地时区 DST 回退时退化为绝对时间 +1 分钟兜底
    const before = cursor.getTime();
    const month = cursor.getMonth() + 1;

    if (!fields.months.has(month)) {
      // 月：不在允许月份时跳到下个允许月的 1 号（无更大月份则跨年到最小月份）
      const next = nextAllowed(fields.months, month);
      if (next === undefined) cursor.setFullYear(cursor.getFullYear() + 1, minMonth - 1, 1);
      else cursor.setMonth(next - 1, 1);
      cursor.setHours(minHour, minMinute, 0, 0);
    } else if (!dayMatches(fields, cursor)) {
      // 日：dom/dow 不匹配时整日跳过（跨月时由下一轮的月份判断继续校正）
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(minHour, minMinute, 0, 0);
    } else if (!fields.hours.has(cursor.getHours())) {
      // 时：跳到当天下一个允许小时，没有则顺延到次日
      const next = nextAllowed(fields.hours, cursor.getHours());
      if (next === undefined) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(minHour, minMinute, 0, 0);
      } else {
        cursor.setHours(next, minMinute, 0, 0);
      }
    } else if (!fields.minutes.has(cursor.getMinutes())) {
      // 分：跳到当前小时下一个允许分钟，没有则进位到下一个允许小时 / 次日
      const next = nextAllowed(fields.minutes, cursor.getMinutes());
      if (next === undefined) {
        const nextHour = nextAllowed(fields.hours, cursor.getHours());
        if (nextHour === undefined) {
          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(minHour, minMinute, 0, 0);
        } else {
          cursor.setHours(nextHour, minMinute, 0, 0);
        }
      } else {
        cursor.setMinutes(next, 0, 0);
      }
    } else {
      return cursor.getTime();
    }

    if (cursor.getTime() <= before) cursor.setTime(before + 60_000);
  }
  return undefined;
}

/* ----------------------------- 工具函数 ----------------------------- */

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

/** 计算任务的下一次执行时间（导出供测试断言跨月顺延行为） */
export function computeNextRun(task: ScheduledTask, from = Date.now()): number | undefined {
  if (!task.enabled) return undefined;
  // 非 cron 任务或重新计算时清除上一次的顺延提示，避免残留
  task.nextNote = undefined;

  if (task.kind === 'cron') {
    const fields = parseCron(task.cron ?? '');
    if (!fields) return undefined;
    const next = nextCronTime(fields, from);
    // 日字段被显式限制（如每月 31 号）时，若当月不存在该日期会顺延到后续月份
    if (next && fields.dayRestricted) {
      const fromD = new Date(from);
      const nextD = new Date(next);
      if (nextD.getFullYear() !== fromD.getFullYear() || nextD.getMonth() !== fromD.getMonth()) {
        const days = [...fields.days].sort((a, b) => a - b).join('/');
        task.nextNote = `设定的「每月 ${days} 号」在 ${fromD.getFullYear()}年${fromD.getMonth() + 1}月没有符合条件的日期，已顺延到 ${nextD.getFullYear()}年${nextD.getMonth() + 1}月${nextD.getDate()}日`;
      }
    }
    return next;
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
  /** tick 互斥：setInterval 不等待上次 tick 完成，需防止多个 tick 重叠并发 */
  let ticking = false;

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

  /** task-output/*.md 滚动清理：按 mtime 保留最近 OUTPUT_KEEP 个，忽略一切异常 */
  function pruneOutputs(): void {
    try {
      if (!fs.existsSync(outputDir)) return;
      const files = fs
        .readdirSync(outputDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => {
          const full = path.join(outputDir, e.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* 单个文件状态读取失败按最旧处理 */
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(OUTPUT_KEEP)) {
        try {
          fs.rmSync(f.full, { force: true });
        } catch {
          /* 忽略删除失败 */
        }
      }
    } catch {
      /* 忽略清理整体异常 */
    }
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
      // 写盘后滚动清理旧输出（异常已在内部忽略）
      pruneOutputs();
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
    if (ticking) return;
    ticking = true;
    try {
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
    } finally {
      ticking = false;
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

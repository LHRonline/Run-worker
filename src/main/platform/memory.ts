/**
 * 长期记忆（MemoryStore）
 *
 * 存储：<dataDir>/memory/facts.json（原子写）
 * 去重：归一化后字符级 Jaccard 相似度 > 0.82 视为同一条记忆，合并并提升权重
 * 召回：关键词覆盖 + 权重 + 时间新鲜度的轻量打分（不引第三方分词库）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore, PlatformDeps } from '../../shared/platform';
import type { MemoryFact, MemoryKind } from '../../shared/types';

const MAX_WEIGHT = 1;
const MIN_WEIGHT = 0.05;
const DUP_THRESHOLD = 0.82;
/** 记忆权重的时间半衰期（天） */
const HALF_LIFE_DAYS = 45;

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  project: '项目',
  instruction: '要求',
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'my', 'me', 'i', 'you', 'your', 'we',
  '的', '了', '是', '在', '和', '与', '及', '也', '都', '就', '要', '我', '你', '他',
]);

interface FactsFile {
  version: number;
  facts: MemoryFact[];
}

/** 归一化：小写，仅保留文字/数字，去掉标点与空白 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 字符集合 Jaccard 相似度 */
function jaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 轻量分词：英文/数字按词，中文按 2-gram */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  const latin = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const w of latin) if (!STOPWORDS.has(w)) tokens.push(w);

  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (STOPWORDS.has(gram)) continue;
      tokens.push(gram);
    }
  }
  return tokens;
}

function clampWeight(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, v));
}

/** 时间衰减系数（0.5 ~ 1） */
function decayFactor(updatedAt: number, now: number): number {
  const days = Math.max(0, (now - updatedAt) / 86400000);
  return 0.5 + 0.5 * Math.pow(0.5, days / HALF_LIFE_DAYS);
}

export function createMemoryStore(deps: PlatformDeps): MemoryStore {
  const dir = path.join(deps.dataDir, 'memory');
  const file = path.join(dir, 'facts.json');

  // 目录在模块创建时即就绪，避免首次写入才建目录（文档承诺 memory/ 固定存在）
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    deps.log.warn('[memory] 创建记忆目录失败', err);
  }

  let facts: MemoryFact[] = [];
  let seq = 0;

  function nextId(): string {
    seq += 1;
    return `mem-${Date.now().toString(36)}-${seq.toString(36)}`;
  }

  function sortFacts(list: MemoryFact[]): MemoryFact[] {
    const now = Date.now();
    return [...list].sort((a, b) => {
      const sa = a.weight * decayFactor(a.updatedAt, now);
      const sb = b.weight * decayFactor(b.updatedAt, now);
      if (sb !== sa) return sb - sa;
      return b.updatedAt - a.updatedAt;
    });
  }

  function persist(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const payload: FactsFile = { version: 1, facts };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      deps.log.error('[memory] 写入记忆文件失败', err);
    }
  }

  function load(): void {
    try {
      if (!fs.existsSync(file)) return;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return;
      const parsed = JSON.parse(text) as Partial<FactsFile> | MemoryFact[];
      const raw = Array.isArray(parsed) ? parsed : parsed.facts ?? [];
      if (!Array.isArray(raw)) return;
      facts = raw
        .filter((f): f is MemoryFact => !!f && typeof f.text === 'string' && f.text.trim().length > 0)
        .map((f) => ({
          id: typeof f.id === 'string' && f.id ? f.id : nextId(),
          kind: (f.kind ?? 'fact') as MemoryKind,
          text: f.text.trim(),
          weight: clampWeight(Number(f.weight ?? 0.6)),
          createdAt: Number(f.createdAt) || Date.now(),
          updatedAt: Number(f.updatedAt) || Number(f.createdAt) || Date.now(),
          hits: Number(f.hits) || 0,
          source: f.source,
        }));
    } catch (err) {
      deps.log.warn('[memory] 记忆文件损坏，已重建为空记忆', err);
      facts = [];
    }
  }

  /** 超出上限时按 weight × 时间衰减淘汰最低分的条目 */
  function enforceLimit(): void {
    const maxFacts = Math.max(1, Number(deps.settings().memory?.maxFacts) || 200);
    if (facts.length <= maxFacts) return;
    const sorted = sortFacts(facts);
    facts = sorted.slice(0, maxFacts);
  }

  load();

  return {
    list(): MemoryFact[] {
      return sortFacts(facts);
    },

    add(input: Partial<MemoryFact> & { text: string }): MemoryFact[] {
      const text = String(input?.text ?? '').trim();
      if (!text) {
        deps.log.warn('[memory] 忽略空记忆');
        return sortFacts(facts);
      }
      const now = Date.now();
      const weight = clampWeight(Number(input.weight ?? 0.6));
      const norm = normalizeText(text);

      // 与已有记忆做相似度比较，命中则合并
      let best: MemoryFact | null = null;
      let bestScore = 0;
      for (const f of facts) {
        const score = jaccard(norm, normalizeText(f.text));
        if (score > bestScore) {
          bestScore = score;
          best = f;
        }
      }

      if (best && bestScore > DUP_THRESHOLD) {
        best.text = text.length > best.text.length ? text : best.text;
        best.weight = clampWeight(Math.max(best.weight, weight) + 0.08);
        best.updatedAt = now;
        best.hits += 1;
        if (input.kind) best.kind = input.kind;
        deps.log.info(`[memory] 合并相似记忆（相似度 ${bestScore.toFixed(2)}）`);
      } else {
        facts.push({
          id: typeof input.id === 'string' && input.id ? input.id : nextId(),
          kind: (input.kind ?? 'fact') as MemoryKind,
          text,
          weight,
          createdAt: now,
          updatedAt: now,
          hits: 0,
          source: input.source,
        });
      }

      enforceLimit();
      persist();
      return sortFacts(facts);
    },

    forget(id: string): MemoryFact[] {
      const before = facts.length;
      facts = facts.filter((f) => f.id !== id);
      if (facts.length !== before) persist();
      return sortFacts(facts);
    },

    clear(): MemoryFact[] {
      facts = [];
      persist();
      return [];
    },

    recall(query: string, topK = 6): MemoryFact[] {
      const q = String(query ?? '').trim();
      const limit = Math.max(1, Math.min(50, topK));
      if (!q) return sortFacts(facts).slice(0, limit);

      const qTokens = tokenize(q);
      if (qTokens.length === 0) return sortFacts(facts).slice(0, limit);

      const now = Date.now();
      const scored: { fact: MemoryFact; score: number }[] = [];

      for (const f of facts) {
        const tokens = tokenize(f.text);
        const set = new Set(tokens);
        let hit = 0;
        for (const t of qTokens) if (set.has(t)) hit += 1;
        const coverage = hit / qTokens.length;
        if (coverage <= 0) continue;
        const score = coverage * (0.55 + 0.45 * f.weight) * decayFactor(f.updatedAt, now);
        scored.push({ fact: f, score });
      }

      if (scored.length === 0) return sortFacts(facts).slice(0, limit);

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.fact);
    },

    digest(maxChars = 800): string {
      if (facts.length === 0) return '';
      const budget = Math.max(10, maxChars);
      const lines: string[] = [];
      let used = 0;
      for (const f of sortFacts(facts)) {
        const label = KIND_LABEL[f.kind] ?? '事实';
        const oneLine = f.text.replace(/\s+/g, ' ').trim();
        let line = `- [${label}] ${oneLine}`;
        const room = budget - used - 1;
        if (room <= 12) break;
        if (line.length > room) line = line.slice(0, Math.max(0, room - 1)) + '…';
        lines.push(line);
        used += line.length + 1;
        if (used >= budget) break;
      }
      return lines.join('\n').slice(0, budget);
    },
  };
}

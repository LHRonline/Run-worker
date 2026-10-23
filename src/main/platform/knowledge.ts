/**
 * 本地知识库（KnowledgeBase）
 *
 * 存储：<dataDir>/kb/index.json（sources + chunks + 词频），原子写
 * 分块：按段落聚合 ~900 字符、重叠 120 字符，id 形如 `path#3`
 * 检索：内置 BM25（中文 2-gram + 英文词），返回命中片段窗口
 * 监听：fs.watch 防抖 3s 后对单个 source 增量重建
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { EVT } from '../../shared/ipc';
import type { KnowledgeBase, PlatformDeps } from '../../shared/platform';
import type { KnowledgeHit, KnowledgeSource, KnowledgeStats } from '../../shared/types';

const INDEX_VERSION = 1;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_CHUNKS_PER_FILE = 400;
const MAX_FILES_PER_SOURCE = 8000;
const WATCH_DEBOUNCE_MS = 3000;

const SUPPORTED_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs',
  '.sql', '.html', '.yml', '.yaml',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'release', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', '.idea', '.vscode', '__pycache__',
  '.venv', 'venv', 'target', 'bin', 'obj', '.gradle', '.DS_Store',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'or', 'in', 'on',
  'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'not', 'but', 'if', 'then', 'than',
  '的', '了', '是', '在', '和', '与', '及', '也', '都', '就', '要', '有', '我', '你', '他', '它',
  '这', '那', '个', '们', '为', '以', '被', '把', '对', '中', '上', '下',
]);

/** 单个词块 */
interface StoredChunk {
  id: string;
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  text: string;
  /** 词 → 词频 */
  tf: Record<string, number>;
  len: number;
}

interface IndexFile {
  version: number;
  updatedAt: number;
  sources: KnowledgeSource[];
  chunks: StoredChunk[];
}

/* --------------------------- 文本处理工具 --------------------------- */

/** 分词：英文/数字按词，中文按 2-gram */
function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
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

function termFreq(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** 提取标题：首个 Markdown 标题，否则文件名 */
function pickTitle(text: string, filePath: string): string {
  const heading = text.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/m);
  if (heading) {
    const t = heading[1].replace(/[#*`]/g, '').trim();
    if (t) return t.slice(0, 80);
  }
  return path.basename(filePath);
}

/** 按段落聚合为 ~900 字符块，块间重叠 120 字符 */
function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units = paragraphs.length > 0 ? paragraphs : [normalized.trim()].filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    const body = buffer.trim();
    if (body) chunks.push(body);
    buffer = body.length > CHUNK_OVERLAP ? body.slice(-CHUNK_OVERLAP) : body;
  };

  for (const unit of units) {
    if (!unit) continue;
    if (unit.length >= CHUNK_SIZE) {
      // 超长段落直接按长度硬切
      if (buffer.trim()) flush();
      let rest = unit;
      while (rest.length > 0) {
        chunks.push(rest.slice(0, CHUNK_SIZE));
        rest = rest.slice(CHUNK_SIZE - CHUNK_OVERLAP);
        if (chunks.length > MAX_CHUNKS_PER_FILE) return chunks;
      }
      buffer = chunks.length > 0 ? chunks[chunks.length - 1].slice(-CHUNK_OVERLAP) : '';
      continue;
    }
    if (buffer.length + unit.length + 2 > CHUNK_SIZE) flush();
    buffer = buffer ? `${buffer}\n\n${unit}` : unit;
    if (chunks.length > MAX_CHUNKS_PER_FILE) return chunks;
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

/** 判断是否为二进制内容 */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(8192, buf.length));
  for (let i = 0; i < probe.length; i += 1) if (probe[i] === 0) return true;
  return false;
}

function isSupported(file: string): boolean {
  return SUPPORTED_EXT.has(path.extname(file).toLowerCase());
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/** 递归收集文件（异步，避免长时间阻塞事件循环） */
async function collectFiles(root: string, isDir: boolean): Promise<string[]> {
  const out: string[] = [];

  if (!isDir) {
    out.push(root);
    return out;
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 16 || out.length >= MAX_FILES_PER_SOURCE) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SOURCE) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (!isSupported(full)) continue;
        out.push(full);
      }
    }
  }

  await walk(root, 0);
  return out;
}

/** 生成命中片段：命中词附近的 180 字窗口 */
function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();

  let pos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (pos === -1 || idx < pos)) pos = idx;
  }

  const windowSize = 180;
  if (pos === -1) {
    return flat.length > windowSize ? `${flat.slice(0, windowSize)}…` : flat;
  }

  const start = Math.max(0, pos - 60);
  const end = Math.min(flat.length, start + windowSize);
  const body = flat.slice(start, end);
  return `${start > 0 ? '…' : ''}${body}${end < flat.length ? '…' : ''}`;
}

/* ----------------------------- 工厂实现 ----------------------------- */

export function createKnowledgeBase(deps: PlatformDeps): KnowledgeBase {
  const dir = path.join(deps.dataDir, 'kb');
  const indexFile = path.join(dir, 'index.json');

  // 目录在模块创建时即就绪，避免首次写入才建目录（文档承诺 kb/ 固定存在）
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    deps.log.warn('[kb] 创建索引目录失败', err);
  }

  let sources: KnowledgeSource[] = [];
  let chunks: StoredChunk[] = [];
  let updatedAt = Date.now();

  /** 倒排：词 → 文档下标集合（用于 BM25 候选筛选） */
  let postings = new Map<string, Set<number>>();
  let totalLen = 0;

  const watchers = new Map<string, fs.FSWatcher[]>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  /** 正在进行的索引任务，避免重复构建；reindex 会复用同一次任务 */
  const inflight = new Map<string, Promise<void>>();

  function rebuildPostings(): void {
    postings = new Map();
    totalLen = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      totalLen += c.len;
      for (const term of Object.keys(c.tf)) {
        let set = postings.get(term);
        if (!set) {
          set = new Set();
          postings.set(term, set);
        }
        set.add(i);
      }
    }
  }

  function persist(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      updatedAt = Date.now();
      const payload: IndexFile = { version: INDEX_VERSION, updatedAt, sources, chunks };
      writeJsonAtomic(indexFile, payload);
    } catch (err) {
      deps.log.error('[kb] 写入索引失败', err);
    }
  }

  function emitChanged(): void {
    deps.emit(EVT.kbChanged, sources);
  }

  function load(): void {
    try {
      if (!fs.existsSync(indexFile)) return;
      const text = fs.readFileSync(indexFile, 'utf8');
      if (!text.trim()) return;
      const data = JSON.parse(text) as Partial<IndexFile>;
      sources = Array.isArray(data.sources) ? data.sources : [];
      chunks = Array.isArray(data.chunks) ? data.chunks : [];
      updatedAt = Number(data.updatedAt) || Date.now();

      // 校验路径是否还存在，缺失的标记 error（不崩溃）
      for (const s of sources) {
        if (!fs.existsSync(s.path)) {
          s.status = 'error';
          s.message = '源路径已不存在或无法访问';
          s.files = 0;
          s.chunks = 0;
        } else if (s.status === 'indexing') {
          s.status = 'ready';
        }
      }
      rebuildPostings();
    } catch (err) {
      deps.log.warn('[kb] 索引文件损坏，已重建为空索引', err);
      sources = [];
      chunks = [];
      rebuildPostings();
    }
  }

  /* --------------------------- 索引构建 --------------------------- */

  async function runIndexSource(source: KnowledgeSource): Promise<void> {
    source.status = 'indexing';
    source.message = undefined;
    emitChanged();

    try {
      if (!fs.existsSync(source.path)) {
        throw new Error('路径不存在或无法访问');
      }

      const files = await collectFiles(source.path, source.kind === 'dir');
      const nextChunks: StoredChunk[] = [];
      let indexedFiles = 0;

      for (const file of files) {
        let buf: Buffer;
        try {
          const stat = await fsp.stat(file);
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) continue;
          buf = await fsp.readFile(file);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;

        const text = buf.toString('utf8');
        if (!text.trim()) continue;

        const title = pickTitle(text, file);
        const parts = chunkText(text);
        if (parts.length === 0) continue;

        indexedFiles += 1;
        parts.forEach((part, i) => {
          const tokens = tokenize(part);
          nextChunks.push({
            id: `${file}#${i}`,
            sourceId: source.id,
            sourceName: source.name,
            path: file,
            title,
            text: part,
            tf: termFreq(tokens),
            len: Math.max(1, tokens.length),
          });
        });
      }

      // 索引过程中源可能被移除，此时丢弃结果
      if (!sources.some((s) => s.id === source.id)) {
        deps.log.info(`[kb] 「${source.name}」已被移除，丢弃本次索引结果`);
        return;
      }

      chunks = [...chunks.filter((c) => c.sourceId !== source.id), ...nextChunks];
      rebuildPostings();

      source.files = indexedFiles;
      source.chunks = nextChunks.length;
      source.status = 'ready';
      source.message = undefined;
      source.updatedAt = Date.now();

      persist();
      emitChanged();
      deps.log.info(`[kb] 「${source.name}」索引完成：${indexedFiles} 个文件 / ${nextChunks.length} 个块`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      source.status = 'error';
      source.message = message || '索引失败';
      source.updatedAt = Date.now();
      persist();
      emitChanged();
      deps.log.error(`[kb] 「${source.name}」索引失败`, err);
    }
  }

  /** 单次索引任务（重复调用复用同一 Promise） */
  function indexSource(source: KnowledgeSource): Promise<void> {
    const existing = inflight.get(source.id);
    if (existing) return existing;
    const task = runIndexSource(source).finally(() => {
      inflight.delete(source.id);
    });
    inflight.set(source.id, task);
    return task;
  }

  /* --------------------------- 目录监听 --------------------------- */

  function stopWatch(sourceId: string): void {
    const list = watchers.get(sourceId);
    if (list) {
      for (const w of list) {
        try {
          w.close();
        } catch {
          /* 忽略关闭异常 */
        }
      }
      watchers.delete(sourceId);
    }
    const timer = debounceTimers.get(sourceId);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(sourceId);
    }
  }

  function scheduleReindex(sourceId: string): void {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;
    const existing = debounceTimers.get(sourceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(sourceId);
      void indexSource(source);
    }, WATCH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    debounceTimers.set(sourceId, timer);
  }

  function startWatch(source: KnowledgeSource): void {
    stopWatch(source.id);
    if (!source.watch || source.kind !== 'dir') return;
    if (!fs.existsSync(source.path)) return;

    const created: fs.FSWatcher[] = [];
    const onChange = () => scheduleReindex(source.id);

    try {
      created.push(fs.watch(source.path, { recursive: true }, onChange));
    } catch {
      // 平台不支持 recursive，退化为逐目录监听（仅两层，避免过多句柄）
      try {
        const entries = fs.readdirSync(source.path, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          try {
            created.push(fs.watch(path.join(source.path, entry.name), onChange));
          } catch {
            /* 单目录监听失败可忽略 */
          }
        }
        created.push(fs.watch(source.path, onChange));
      } catch (err) {
        deps.log.warn(`[kb] 无法监听「${source.name}」`, err);
        return;
      }
    }

    for (const w of created) {
      w.on('error', () => {
        /* 监听器异常不应影响主流程 */
      });
    }
    watchers.set(source.id, created);
  }

  /* ----------------------------- BM25 ----------------------------- */

  function searchSync(query: string, topK: number): KnowledgeHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || chunks.length === 0) return [];

    // 去重查询词并统计权重
    const queryTerms = [...new Set(terms)];
    const candidates = new Set<number>();
    for (const term of queryTerms) {
      const set = postings.get(term);
      if (set) for (const idx of set) candidates.add(idx);
    }
    if (candidates.size === 0) return [];

    const N = chunks.length;
    const avgdl = totalLen > 0 ? totalLen / N : 1;
    const k1 = 1.4;
    const b = 0.75;

    const scored: { idx: number; score: number }[] = [];
    for (const idx of candidates) {
      const c = chunks[idx];
      let score = 0;
      for (const term of queryTerms) {
        const f = c.tf[term];
        if (!f) continue;
        const df = postings.get(term)?.size ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + k1 * (1 - b + b * (c.len / avgdl));
        score += idf * ((f * (k1 + 1)) / (denom || 1));
      }
      if (score > 0) scored.push({ idx, score });
    }

    scored.sort((a, b2) => b2.score - a.score);

    return scored.slice(0, topK).map(({ idx, score }) => {
      const c = chunks[idx];
      return {
        id: c.id,
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        path: c.path,
        title: c.title,
        snippet: makeSnippet(c.text, queryTerms),
        score: Math.round(score * 1000) / 1000,
      } satisfies KnowledgeHit;
    });
  }

  function statsSync(): KnowledgeStats {
    return {
      sources: sources.length,
      documents: sources.reduce((sum, s) => sum + (s.files || 0), 0),
      chunks: chunks.length,
      updatedAt,
      vectorReady: false,
    };
  }

  /* ----------------------------- 对外接口 ----------------------------- */

  load();

  return {
    async init(): Promise<void> {
      load();
      const broken = sources.filter((s) => s.status === 'error');
      if (broken.length > 0) {
        deps.log.warn(`[kb] ${broken.length} 个知识源路径失效，已标记异常`);
      }
      for (const s of sources) {
        if (s.watch && s.status === 'ready') startWatch(s);
      }
      emitChanged();
      deps.log.info(`[kb] 已加载 ${sources.length} 个知识源 / ${chunks.length} 个块`);
    },

    list(): KnowledgeSource[] {
      return [...sources];
    },

    async addSource(p: string, watch = true): Promise<KnowledgeSource[]> {
      const target = String(p ?? '').trim();
      if (!target) return [...sources];

      let resolved: string;
      try {
        resolved = path.resolve(target);
      } catch {
        resolved = target;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error('路径不存在或无法访问');
      }

      const existed = sources.find((s) => path.resolve(s.path) === resolved);
      if (existed) {
        deps.log.info(`[kb] 知识源已存在：${resolved}`);
        return [...sources];
      }

      const now = Date.now();
      const source: KnowledgeSource = {
        id: `kb-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        path: resolved,
        name: path.basename(resolved) || resolved,
        kind: stat.isDirectory() ? 'dir' : 'file',
        files: 0,
        chunks: 0,
        addedAt: now,
        updatedAt: now,
        watch: !!watch,
        status: 'indexing',
        message: undefined,
      };

      sources.push(source);
      persist();
      emitChanged();

      // 后台索引：UI 立刻能看到 indexing 状态
      void indexSource(source).then(() => {
        if (source.watch) startWatch(source);
      });

      return [...sources];
    },

    async remove(id: string): Promise<KnowledgeSource[]> {
      const source = sources.find((s) => s.id === id);
      if (!source) return [...sources];
      stopWatch(id);
      sources = sources.filter((s) => s.id !== id);
      chunks = chunks.filter((c) => c.sourceId !== id);
      rebuildPostings();
      persist();
      emitChanged();
      return [...sources];
    },

    async reindex(sourceId?: string): Promise<KnowledgeStats> {
      const targets = sourceId ? sources.filter((s) => s.id === sourceId) : [...sources];
      if (targets.length === 0) return statsSync();

      for (const source of targets) {
        // 串行重建，避免同时读满磁盘
        await indexSource(source);
      }
      return statsSync();
    },

    async search(query: string, topK = 6): Promise<KnowledgeHit[]> {
      const limit = Math.max(1, Math.min(30, Math.floor(topK) || 6));
      return searchSync(String(query ?? ''), limit);
    },

    stats(): KnowledgeStats {
      return statsSync();
    },

    async contextFor(query: string, topK = 6): Promise<{ text: string; citations: KnowledgeHit[] }> {
      const hits = searchSync(String(query ?? ''), Math.max(1, Math.min(10, Math.floor(topK) || 5)));
      if (hits.length === 0) return { text: '', citations: [] };

      const blocks = hits.map((h, i) => `【资料 ${i + 1}】${h.title}（${h.path}）\n${h.snippet}`);
      return { text: blocks.join('\n\n'), citations: hits };
    },
  };
}

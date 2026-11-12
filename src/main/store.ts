/**
 * Run worker — 本地持久化
 * 纯 JSON 文件存储：设置、会话索引、单个会话。全部原子写 + 损坏容错，不依赖第三方库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultSettings } from '../shared/presets';
import { DEFAULT_USAGE } from '../shared/types';
import type { AgentId, ChatMessage, Conversation, ConversationFileRef, ConversationMeta, Settings } from '../shared/types';
import type { DeepPartial } from '../shared/ipc';
import type { Logger } from '../shared/platform';

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

export interface StorePaths {
  root: string;
  settingsFile: string;
  convDir: string;
  convIndexFile: string;
  logsDir: string;
  workspaceDir: string;
  artifactsDir: string;
}

export function resolvePaths(root: string): StorePaths {
  const convDir = path.join(root, 'conversations');
  return {
    root,
    settingsFile: path.join(root, 'settings.json'),
    convDir,
    convIndexFile: path.join(convDir, 'index.json'),
    logsDir: path.join(root, 'logs'),
    workspaceDir: path.join(root, 'workspace'),
    artifactsDir: path.join(root, 'artifacts'),
  };
}

export function ensureDirSync(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或不可创建，交给后续写入报错处理 */
  }
}

/* ------------------------------------------------------------------ */
/* 原子读写                                                            */
/* ------------------------------------------------------------------ */

function readJsonRaw(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 文件损坏：备份一份供人工排查，返回 null 走默认值
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* 备份失败忽略 */
    }
    return null;
  }
}

/** 先写临时文件再 rename，避免断电/崩溃留下半截 JSON */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 下目标被占用时 rename 会失败，退化为覆盖写
    fs.writeFileSync(file, text, 'utf8');
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 深合并                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 对象递归合并，数组整体替换；undefined 不覆盖已有值 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out as T;
}

/* ------------------------------------------------------------------ */
/* 设置规范化                                                          */
/* ------------------------------------------------------------------ */

const CURRENT_SETTINGS_VERSION = 1;

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

/** 迁移 + 兜底：任何缺失/越界字段都回落到安全值 */
export function migrateSettings(raw: unknown): Settings {
  const defaults = createDefaultSettings();
  const merged = isPlainObject(raw) ? deepMerge<Settings>(defaults, raw) : defaults;

  merged.version = CURRENT_SETTINGS_VERSION;
  merged.providers = Array.isArray(merged.providers) ? merged.providers : defaults.providers;
  // 只保留结构合法的服务商
  merged.providers = merged.providers.filter(
    (p) => p && typeof p.id === 'string' && typeof p.baseUrl === 'string',
  );
  if (merged.providers.length === 0) merged.providers = defaults.providers;

  if (!merged.providers.some((p) => p.id === merged.activeProviderId)) {
    merged.activeProviderId = merged.providers[0].id;
  }
  const active = merged.providers.find((p) => p.id === merged.activeProviderId);
  if (!merged.activeModel) merged.activeModel = active?.models[0] ?? '';
  if (active && active.models.length > 0 && !active.models.includes(merged.activeModel)) {
    // 模型被移除时自动回落到该服务商第一个模型
    merged.activeModel = active.models[0];
  }

  merged.persona.verbosity = Math.round(clamp(merged.persona.verbosity, 1, 5, 2));
  merged.persona.temperature = clamp(merged.persona.temperature, 0, 2, 0.6);
  merged.appearance.zoom = clamp(merged.appearance.zoom, 0.85, 1.2, 1);

  merged.tokenSave.maxHistoryMessages = Math.round(clamp(merged.tokenSave.maxHistoryMessages, 2, 100, 16));
  merged.tokenSave.compressThreshold = Math.round(clamp(merged.tokenSave.compressThreshold, 4000, 400000, 24000));
  merged.tokenSave.toolOutputLimit = Math.round(clamp(merged.tokenSave.toolOutputLimit, 500, 60000, 4000));
  merged.tokenSave.maxOutputTokens = Math.round(clamp(merged.tokenSave.maxOutputTokens, 128, 32000, 4096));
  merged.tokenSave.budgetAlertCny = clamp(merged.tokenSave.budgetAlertCny, 0, 10000, 20);

  merged.thinking.chineseRatioThreshold = clamp(merged.thinking.chineseRatioThreshold, 0, 1, 0.55);

  merged.memory.maxFacts = Math.round(clamp(merged.memory.maxFacts, 10, 2000, 200));

  merged.agent.maxSteps = Math.round(clamp(merged.agent.maxSteps, 1, 40, 12));
  merged.agent.commandTimeout = Math.round(clamp(merged.agent.commandTimeout, 5000, 600000, 120000));
  merged.agent.denyPatterns = Array.isArray(merged.agent.denyPatterns) ? merged.agent.denyPatterns : defaults.agent.denyPatterns;
  merged.mcpServers = Array.isArray(merged.mcpServers) ? merged.mcpServers : [];

  if (!merged.update || typeof merged.update !== 'object') merged.update = defaults.update;
  return merged;
}

/* ------------------------------------------------------------------ */
/* 会话工具函数                                                        */
/* ------------------------------------------------------------------ */

/** 汇总会话 token；同时标注「精确 / 估算」，避免把估算值当成 API 精确值展示 */
export function sumUsage(list: ChatMessage[]) {
  const total = { ...DEFAULT_USAGE };
  let exact = 0;
  let estimated = 0;
  for (const m of list) {
    if (!m.usage) continue;
    total.promptTokens += m.usage.promptTokens || 0;
    total.completionTokens += m.usage.completionTokens || 0;
    total.reasoningTokens += m.usage.reasoningTokens || 0;
    total.cachedTokens += m.usage.cachedTokens || 0;
    total.totalTokens += m.usage.totalTokens || 0;
    total.costCny += m.usage.costCny || 0;
    const reqs = m.usage.totalRequests ?? 1;
    total.totalRequests = (total.totalRequests ?? 0) + reqs;
    if (m.usage.tokenSource === 'estimated') {
      estimated += reqs;
    } else if (m.usage.tokenSource === 'mixed') {
      const e = m.usage.exactRequests ?? 0;
      exact += e;
      estimated += Math.max(0, reqs - e);
    } else {
      exact += reqs;
    }
  }
  total.exactRequests = exact;
  total.tokenSource = estimated === 0 ? 'api' : exact === 0 ? 'estimated' : 'mixed';
  return total;
}

const TITLE_MAX = 40;

/** 从首条用户消息生成标题 */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '新对话';
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean;
}

function previewOf(list: ChatMessage[]): string {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.role !== 'assistant' && m.role !== 'user') continue;
    const text = (m.content || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return '';
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 供「引用对话文件」展示图标/类型，不读取文件内容 */
function mimeOfExt(file: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.csv': 'text/csv',
  };
  return map[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function createEmptyConversation(title?: string, agentId: AgentId = 'orchestrator'): Conversation {
  const now = Date.now();
  return {
    id: newId('conv'),
    title: title?.trim() || '新对话',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messageCount: 0,
    agentId,
    usage: { ...DEFAULT_USAGE },
    preview: '',
    messages: [],
  };
}

function toMeta(conv: Conversation): ConversationMeta {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pinned: !!conv.pinned,
    messageCount: conv.messages.length,
    agentId: conv.agentId,
    usage: conv.usage ?? sumUsage(conv.messages),
    preview: previewOf(conv.messages),
  };
}

/* ------------------------------------------------------------------ */
/* API Key 加密存储（safeStorage 编解码）                                */
/* ------------------------------------------------------------------ */

/** settings.json 中加密 Key 的前缀（v1 = safeStorage 原始密文 + base64） */
export const ENC_PREFIX = 'enc:v1:';

export interface SecretsCodec {
  /** 明文 → 带 ENC_PREFIX 的密文（仅用于写盘） */
  encrypt(plain: string): string;
  /** ENC_PREFIX 密文 → 明文（仅用于读盘/内存态） */
  decrypt(stored: string): string;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export class Store {
  readonly paths: StorePaths;
  private settings: Settings;
  private index: ConversationMeta[] = [];
  /** 会话正文缓存，避免频繁磁盘读 */
  private cache = new Map<string, Conversation>();
  /** API Key 编解码器（app ready 后注入 safeStorage 实现；单测/无加密环境为 null） */
  private codec: SecretsCodec | null = null;

  constructor(userDataDir: string) {
    this.paths = resolvePaths(userDataDir);
    for (const dir of [this.paths.root, this.paths.convDir, this.paths.logsDir, this.paths.workspaceDir, this.paths.artifactsDir]) {
      ensureDirSync(dir);
    }
    this.settings = this.loadSettings();
    this.loadIndex();
  }

  /* -------------------------- 设置 -------------------------- */

  /**
   * 注入 API Key 编解码器（app ready 后调用一次）。
   * 会把内存中已解密的 Key 重新持久化，完成「明文存量 → 密文」迁移。
   */
  setSecretsCodec(codec: SecretsCodec): void {
    this.codec = codec;
    this.decryptApiKeysInPlace(this.settings);
    this.persistSettings(this.settings);
  }

  /** 密文 Key 解回明文（仅内存态；解密失败的 Key 置空，避免把密文当 Key 发出去） */
  private decryptApiKeysInPlace(settings: Settings): void {
    if (!this.codec) return;
    for (const p of settings.providers) {
      if (typeof p.apiKey === 'string' && p.apiKey.startsWith(ENC_PREFIX)) {
        try {
          p.apiKey = this.codec.decrypt(p.apiKey);
        } catch {
          p.apiKey = '';
        }
      }
    }
  }

  private loadSettings(): Settings {
    const raw = readJsonRaw(this.paths.settingsFile);
    const settings = migrateSettings(raw);
    this.decryptApiKeysInPlace(settings);
    if (raw === null) {
      this.persistSettings(settings);
    } else if (JSON.stringify(raw) !== JSON.stringify(settings)) {
      // 补齐/校正过字段，回写一次
      this.persistSettings(settings);
    }
    return settings;
  }

  private persistSettings(settings: Settings): void {
    try {
      // 写盘前把明文 Key 加密；内存态保持明文，IPC / LLM 调用方无感知
      let payload: unknown = settings;
      if (this.codec) {
        const clone = JSON.parse(JSON.stringify(settings)) as Settings;
        for (const p of clone.providers) {
          if (p.apiKey && !p.apiKey.startsWith(ENC_PREFIX)) p.apiKey = this.codec.encrypt(p.apiKey);
        }
        payload = clone;
      }
      writeJsonAtomic(this.paths.settingsFile, payload);
    } catch {
      /* 设置写失败不应阻塞运行 */
    }
  }

  getSettings(): Settings {
    return this.settings;
  }

  updateSettings(patch: DeepPartial<Settings> | Partial<Settings>): Settings {
    const next = migrateSettings(deepMerge<Settings>(this.settings, patch));
    next.updatedAt = Date.now();
    this.settings = next;
    this.persistSettings(next);
    return next;
  }

  resetSettings(): Settings {
    const next = createDefaultSettings();
    next.createdAt = this.settings.createdAt || next.createdAt;
    next.updatedAt = Date.now();
    this.settings = next;
    this.persistSettings(next);
    return next;
  }

  /* ------------------------- 会话索引 ------------------------- */

  private loadIndex(): void {
    const raw = readJsonRaw(this.paths.convIndexFile);
    if (Array.isArray(raw)) {
      const metas = raw.filter((m): m is ConversationMeta => !!m && typeof (m as ConversationMeta).id === 'string');
      // 剔除指向已丢失文件的孤儿条目（异常退出后偶发），并写回干净索引
      this.index = metas.filter((m) => fs.existsSync(this.convFile(m.id)));
      if (this.index.length !== metas.length) this.persistIndex();
      return;
    }
    // 索引缺失时按目录重建，保证老数据可用
    this.index = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.paths.convDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    } catch {
      files = [];
    }
    for (const file of files) {
      const conv = this.readConversationFile(path.join(this.paths.convDir, file));
      if (conv) this.index.push(toMeta(conv));
    }
    this.persistIndex();
  }

  private persistIndex(): void {
    try {
      writeJsonAtomic(this.paths.convIndexFile, this.index);
    } catch {
      /* 忽略 */
    }
  }

  private convFile(id: string): string {
    return path.join(this.paths.convDir, `${id}.json`);
  }

  private readConversationFile(file: string): Conversation | null {
    const raw = readJsonRaw(file);
    if (!isPlainObject(raw) || typeof raw.id !== 'string') return null;
    const conv = raw as unknown as Conversation;
    conv.messages = Array.isArray(conv.messages) ? conv.messages : [];
    // 始终按消息重算，兼容旧版本或残缺字段
    conv.usage = sumUsage(conv.messages);
    conv.pinned = !!conv.pinned;
    conv.agentId = conv.agentId ?? 'orchestrator';
    return conv;
  }

  private upsertIndex(meta: ConversationMeta): void {
    const i = this.index.findIndex((m) => m.id === meta.id);
    if (i >= 0) this.index[i] = meta;
    else this.index.push(meta);
  }

  listConversations(): ConversationMeta[] {
    return [...this.index].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  getConversation(id: string): Conversation | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const conv = this.readConversationFile(this.convFile(id));
    if (!conv) return null;
    this.cache.set(id, conv);
    return conv;
  }

  createConversation(title?: string, agentId: AgentId = 'orchestrator'): Conversation {
    const conv = createEmptyConversation(title, agentId);
    this.saveConversation(conv);
    return conv;
  }

  saveConversation(conv: Conversation): Conversation {
    const messages = conv.messages ?? [];
    conv.messageCount = messages.length;
    conv.usage = sumUsage(messages);
    conv.updatedAt = Date.now();
    this.cache.set(conv.id, conv);
    try {
      writeJsonAtomic(this.convFile(conv.id), conv);
    } catch {
      /* 忽略写入失败，内存态仍可用 */
    }
    this.upsertIndex(toMeta(conv));
    this.persistIndex();
    return conv;
  }

  renameConversation(id: string, title: string): void {
    const conv = this.getConversation(id);
    const nextTitle = title.trim().slice(0, 120) || '未命名对话';
    if (!conv) {
      const meta = this.index.find((m) => m.id === id);
      if (meta) {
        meta.title = nextTitle;
        meta.updatedAt = Date.now();
        this.persistIndex();
      }
      return;
    }
    conv.title = nextTitle;
    this.saveConversation(conv);
  }

  /* ----------------------- 彻底删除 / 产物清理 ----------------------- */

  /** 删除单个路径；不存在视为成功。返回是否真的清干净了 */
  private removePath(full: string): boolean {
    try {
      fs.rmSync(full, { force: true, recursive: true });
      return !fs.existsSync(full);
    } catch {
      return false;
    }
  }

  /** 递归统计目录内文件数（用于给出真实的「已擦除 N 个文件」） */
  private countFiles(dir: string): number {
    let n = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) n += this.countFiles(full);
        else n += 1;
      }
    } catch {
      /* 目录不可读 */
    }
    return n;
  }

  private artifactsRoot(workspaceDir: string): string {
    return path.join(workspaceDir, '.runworker-artifacts');
  }

  /**
   * 彻底删除一个会话：先删文件，成功后再改索引。
   * 删除失败的路径会如实返回，界面提示用户关闭占用程序后重试，避免「显示已删除、其实还在」。
   */
  deleteConversation(id: string): { files: number; failed: string[] } {
    const failed: string[] = [];
    let files = 0;
    this.cache.delete(id);

    // 主文件 + 同名前缀的辅助文件（<id>.json、<id>.trace.json、<id>.lock …）
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.paths.convDir);
    } catch {
      entries = [];
    }
    for (const f of entries) {
      if (f !== `${id}.json` && !f.startsWith(`${id}.`)) continue;
      const full = path.join(this.paths.convDir, f);
      if (!fs.existsSync(full)) continue;
      if (this.removePath(full)) files += 1;
      else failed.push(full);
    }

    // 主文件仍在（被占用）时保留索引条目，否则会产生永远找不回的孤儿文件
    const mainGone = !fs.existsSync(this.convFile(id));
    if (mainGone) {
      this.index = this.index.filter((m) => m.id !== id);
      this.persistIndex();
    }
    return { files, failed };
  }

  /**
   * 清理某个会话产生的产物。除 <root>/<id>/ 外，还兼容 0.0.3a 及更早版本
   * 直接散落在 <root>/ 下、以会话 id 命名的文件。
   */
  purgeConversationArtifacts(id: string, workspaceDir: string): { files: number; failed: string[] } {
    const root = this.artifactsRoot(workspaceDir);
    const failed: string[] = [];
    const targets: string[] = [];
    const dir = path.join(root, id);
    if (fs.existsSync(dir)) targets.push(dir);
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || !entry.name.startsWith(id)) continue;
        const full = path.join(root, entry.name);
        if (!targets.includes(full)) targets.push(full);
      }
    } catch {
      /* 产物根目录不存在 */
    }

    let files = 0;
    for (const target of targets) {
      const before = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? this.countFiles(target) : 1;
      const leftAfter = () => {
        try {
          return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? this.countFiles(target) : (fs.existsSync(target) ? 1 : 0);
        } catch {
          return 0;
        }
      };
      let ok = this.removePath(target);
      let left = leftAfter();
      if (!ok && left === 0) ok = true;
      files += Math.max(0, before - left);
      if (!ok || left > 0) failed.push(target);
    }
    return { files, failed };
  }

  /** 清空全部会话：会话文件 + 索引 + 整个产物根目录（含旧版散落文件与 _shared） */
  clearConversations(workspaceDir?: string): { files: number; artifacts: number; failed: string[] } {
    const failed: string[] = [];
    let files = 0;
    let artifacts = 0;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.paths.convDir);
    } catch {
      entries = [];
    }
    for (const f of entries) {
      if (f === 'index.json') continue;
      const full = path.join(this.paths.convDir, f);
      if (this.removePath(full)) files += 1;
      else failed.push(full);
    }

    if (workspaceDir) {
      const root = this.artifactsRoot(workspaceDir);
      const before = this.countFiles(root);
      const ok = this.removePath(root);
      const left = this.countFiles(root);
      artifacts = Math.max(0, before - left);
      if (!ok && left > 0) failed.push(root);
    }

    // 文件清完再落盘索引，避免出现「索引为空但文件还在」的永久孤儿
    this.cache.clear();
    this.index = [];
    this.persistIndex();
    return { files, artifacts, failed };
  }

  /** 该会话可重新引用的文件：历史附件 + 会话产物（供 Composer「引用对话文件」） */
  listConversationFiles(id: string, workspaceDir: string): ConversationFileRef[] {
    const out: ConversationFileRef[] = [];
    const seen = new Set<string>();
    const push = (file: string, origin: 'attachment' | 'artifact'): void => {
      const key = path.resolve(file);
      if (seen.has(key)) return;
      seen.add(key);
      const name = path.basename(file);
      let size: number | undefined;
      const exists = fs.existsSync(file);
      if (exists) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = undefined;
        }
      }
      out.push({
        name,
        path: file,
        kind: /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) ? 'image' : 'file',
        size,
        mime: mimeOfExt(name),
        origin,
        missing: !exists,
      });
    };

    const conv = this.getConversation(id);
    if (conv) {
      for (const m of conv.messages) {
        for (const a of m.attachments ?? []) {
          if (a?.path) push(a.path, 'attachment');
        }
      }
    }

    const root = this.artifactsRoot(workspaceDir);
    const scan = (dir: string, depth: number): void => {
      if (depth > 3 || out.length >= 80) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(full, depth + 1);
          else push(full, 'artifact');
        }
      } catch {
        /* 目录不可读 */
      }
    };
    const convDir = path.join(root, id);
    if (fs.existsSync(convDir)) scan(convDir, 0);
    // 0.0.3a 之前的产物直接散落在根目录，只挑文件名带本会话 id 的
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || !entry.name.includes(id)) continue;
        push(path.join(root, entry.name), 'artifact');
      }
    } catch {
      /* 目录不存在 */
    }
    return out;
  }

  pinConversation(id: string, pinned: boolean): void {
    const conv = this.getConversation(id);
    if (conv) {
      conv.pinned = pinned;
      this.saveConversation(conv);
      return;
    }
    const meta = this.index.find((m) => m.id === id);
    if (meta) {
      meta.pinned = pinned;
      this.persistIndex();
    }
  }

  /** 导出为 Markdown 文本（由渲染进程负责保存/复制） */
  exportMarkdown(id: string): string {
    const conv = this.getConversation(id);
    if (!conv) return '';
    const lines: string[] = [];
    const stamp = (n: number) => new Date(n).toLocaleString('zh-CN', { hour12: false });
    lines.push(`# ${conv.title}`);
    lines.push('');
    lines.push(`> 创建于 ${stamp(conv.createdAt)} · 共 ${conv.messages.length} 条消息`);
    if (conv.usage && conv.usage.totalTokens > 0) {
      lines.push(`> 累计 token ${conv.usage.totalTokens}（缓存命中 ${conv.usage.cachedTokens}），估算成本 ¥${conv.usage.costCny.toFixed(4)}`);
    }
    lines.push('');
    for (const m of conv.messages) {
      if (m.role === 'user') {
        lines.push(`## 我 · ${stamp(m.createdAt)}`);
        lines.push('');
        lines.push(m.content.trim() || '（空）');
        lines.push('');
      } else if (m.role === 'assistant') {
        lines.push(`## 助手${m.agentId ? `（${m.agentId}）` : ''} · ${stamp(m.createdAt)}`);
        lines.push('');
        if (m.thinking) {
          lines.push('<details><summary>思考过程</summary>');
          lines.push('');
          lines.push(m.thinking.trim());
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
        lines.push(m.content.trim() || '（空）');
        lines.push('');
        if (m.toolCalls && m.toolCalls.length) {
          lines.push('**工具调用**');
          lines.push('');
          for (const t of m.toolCalls) {
            lines.push(`- \`${t.name}\` → ${t.status}${t.error ? `（${t.error}）` : ''}`);
          }
          lines.push('');
        }
        if (m.citations && m.citations.length) {
          lines.push('**引用**');
          lines.push('');
          for (const c of m.citations) lines.push(`- ${c.title} — \`${c.sourcePath}\``);
          lines.push('');
        }
      } else if (m.role === 'summary') {
        lines.push('## 历史摘要');
        lines.push('');
        lines.push(m.content.trim());
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');
    lines.push('由 Run worker 导出');
    return lines.join('\n');
  }
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function fmtArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const SECRET_RULES: Array<[RegExp, string]> = [
  // apiKey / api_key / token / authorization 的键值写法（先于 Bearer 处理，避免残留关键字）
  [/(["']?(?:api[_-]?key|apikey|token|authorization|secret)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"'\s,}]{5,})/gi, '$1***'],
  // Authorization: Bearer xxx
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 sk-***'],
  // sk-xxx / sk-proj-xxx / 各类带 sk- 前缀的 Key
  [/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-***'],
];

/** 日志脱敏：任何 Key、Bearer 值都替换成 ***，避免写进磁盘 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  return out;
}

/** 简单文件日志：按天切分，追加写入，失败静默；输出前统一脱敏 */
export function createLogger(logDir: string): Logger {
  ensureDirSync(logDir);
  const write = (level: string, args: unknown[]) => {
    const body = args.map(fmtArg).join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${redactSecrets(body)}\n`;
    const file = path.join(logDir, `main-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* 忽略日志写入失败 */
    }
    // 开发环境同时输出到控制台
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${level}]`, redactSecrets(body));
  };
  return {
    info: (...args: unknown[]) => write('info', args),
    warn: (...args: unknown[]) => write('warn', args),
    error: (...args: unknown[]) => write('error', args),
  };
}

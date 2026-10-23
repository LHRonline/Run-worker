/**
 * 更新检测（Updater）
 *
 * 只做「检查」，不下载安装：
 *  - feed 是 owner/repo → GitHub Releases API；
 *  - feed 是 http(s) 地址 → 直接取该 JSON，兼容 { version, notes, url } 结构；
 *  - 结果缓存 30 分钟（<dataDir>/update/cache.json），force 忽略缓存；
 *  - 任何网络异常都转成中文 error 字段，绝不抛给调用方。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EVT } from '../../shared/ipc';
import type { PlatformDeps, Updater } from '../../shared/platform';
import type { UpdateInfo } from '../../shared/types';

const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

interface CacheFile {
  info: UpdateInfo;
  at: number;
}

interface ReleaseItem {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string }[];
  /** 自定义 JSON 源兼容字段 */
  version?: string;
  notes?: string;
  url?: string;
  downloadUrl?: string;
}

function getFetch(): FetchLike | null {
  const fn = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  return typeof fn === 'function' ? fn : null;
}

/** 解析版本号：v1.2.3-beta.1 → { nums:[1,2,3], pre:['beta',1] } */
function parseVersion(raw: string): { nums: number[]; pre: (string | number)[] } | null {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  if (!text) return null;
  const [core, ...rest] = text.split('+')[0].split('-');
  const nums = core.split('.').map((n) => Number.parseInt(n, 10));
  if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return null;
  const pre: (string | number)[] = [];
  if (rest.length > 0) {
    for (const part of rest.join('-').split('.')) {
      const num = Number.parseInt(part, 10);
      pre.push(Number.isNaN(num) ? part.toLowerCase() : num);
    }
  }
  return { nums, pre };
}

/** semver 比较：a > b 返回 1，相等 0，小于 -1 */
function compareVersion(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;

  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const na = va.nums[i] ?? 0;
    const nb = vb.nums[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  // 有预发布标识的版本更小
  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;

  const plen = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < plen; i += 1) {
    const pa = va.pre[i];
    const pb = vb.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa > pb) return 1;
      if (pa < pb) return -1;
    } else if (typeof pa === 'number') {
      return -1; // 数字标识优先级低于字符串
    } else if (typeof pb === 'number') {
      return 1;
    } else {
      if (pa > pb) return 1;
      if (pa < pb) return -1;
    }
  }
  return 0;
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** HTTP 错误转中文文案：区分仓库不存在 / 无权限 / 限流 / 服务不可用 */
function httpErrorMessage(
  status: number,
  headers: { get(name: string): string | null },
  github: boolean,
): string {
  if (status === 404) return '更新源仓库不存在或无权访问（HTTP 404），请检查设置中的更新源';
  if (status === 401) return '更新源需要授权（HTTP 401），请确认仓库是否私有';
  if (status === 403) {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? new Date(reset).toLocaleTimeString('zh-CN') : '';
      return `GitHub 接口调用次数已超限（HTTP 403）${when ? `，约 ${when} 后恢复` : '，请稍后重试'}`;
    }
    return '无权访问更新源（HTTP 403），请检查仓库可见性';
  }
  if (status === 429) return '请求过于频繁（HTTP 429），请稍后重试';
  if (status >= 500) return `更新服务暂时不可用（HTTP ${status}），请稍后再试`;
  return `${github ? 'GitHub 更新接口' : '更新源'}返回 HTTP ${status}，请稍后再试`;
}

export function createUpdater(deps: PlatformDeps & { appVersion: string; repoUrl: string }): Updater {
  const dir = path.join(deps.dataDir, 'update');
  const cacheFile = path.join(dir, 'cache.json');

  // 目录在模块创建时即就绪，避免首次写入才建目录（文档承诺 update/ 固定存在）
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    deps.log.warn('[updater] 创建更新缓存目录失败', err);
  }

  let last: UpdateInfo | null = null;
  let running: Promise<UpdateInfo> | null = null;

  /** 读取缓存（同步，构造时执行一次） */
  function readCache(): CacheFile | null {
    try {
      if (!fs.existsSync(cacheFile)) return null;
      const text = fs.readFileSync(cacheFile, 'utf8');
      if (!text.trim()) return null;
      const data = JSON.parse(text) as Partial<CacheFile>;
      if (!data || typeof data !== 'object' || !data.info) return null;
      const info = data.info as UpdateInfo;
      if (typeof info.latestVersion !== 'string' || typeof info.available !== 'boolean') return null;
      return { info, at: Number(data.at) || Number(info.checkedAt) || 0 };
    } catch (err) {
      deps.log.warn('[updater] 读取更新缓存失败，忽略缓存', err);
      return null;
    }
  }

  function writeCache(info: UpdateInfo): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(cacheFile, { info, at: Date.now() });
    } catch (err) {
      deps.log.warn('[updater] 写入更新缓存失败', err);
    }
  }

  /** 拼装请求地址：owner/repo 走 GitHub API，http(s) 直连 */
  function resolveFeed(): { url: string; github: boolean } {
    const settings = deps.settings();
    const raw = String(settings.update?.feed ?? '').trim();

    if (/^https?:\/\//i.test(raw)) return { url: raw, github: false };

    let repo = raw;
    if (!repo) {
      // 回退到 package.json 的 repository 地址
      const m = String(deps.repoUrl ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/i);
      repo = m ? m[1] : '';
    }
    repo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    if (!repo.includes('/')) {
      throw new Error('未配置更新源（请在设置中填写 owner/repo）');
    }
    return { url: `https://api.github.com/repos/${repo}/releases`, github: true };
  }

  function emptyInfo(checkedAt: number, error?: string, latest = deps.appVersion): UpdateInfo {
    return {
      currentVersion: deps.appVersion,
      latestVersion: latest,
      available: false,
      prerelease: false,
      notes: '',
      checkedAt,
      error,
    };
  }

  /** 把一条 release 记录规整成统一结构 */
  function pickDownloadUrl(item: ReleaseItem): string | undefined {
    if (item.downloadUrl) return item.downloadUrl;
    if (item.url && /^https?:\/\//i.test(item.url) && /\.(exe|msi|dmg|zip|appimage|deb|rpm|tar\.gz|7z)$/i.test(item.url)) {
      return item.url;
    }
    const assets = item.assets ?? [];
    const preferred = assets.find((a) => /\.(exe|msi)$/i.test(a.name ?? '')) ?? assets[0];
    if (preferred?.browser_download_url) return preferred.browser_download_url;
    return item.html_url ?? item.url;
  }

  async function doCheck(): Promise<UpdateInfo> {
    const settings = deps.settings();
    const channel = settings.update?.channel === 'beta' ? 'beta' : 'stable';
    const now = Date.now();

    let feed: { url: string; github: boolean };
    try {
      feed = resolveFeed();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      last = emptyInfo(now, message);
      return last;
    }

    const doFetch = getFetch();
    if (!doFetch) {
      last = emptyInfo(now, '当前运行环境不支持网络请求，无法检查更新');
      return last;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let text = '';
    try {
      const res = await doFetch(feed.url, {
        method: 'GET',
        headers: {
          'User-Agent': `Run-worker/${deps.appVersion}`,
          Accept: feed.github ? 'application/vnd.github+json' : 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        last = emptyInfo(now, httpErrorMessage(res.status, res.headers, feed.github));
        deps.log.warn(`[updater] ${last.error}`);
        return last;
      }
      text = await res.text();
    } catch (err) {
      const aborted = err instanceof Error && /abort/i.test(err.name + err.message);
      const message = aborted ? '检查更新超时，请检查网络后重试' : `网络请求失败：${err instanceof Error ? err.message : String(err)}`;
      last = emptyInfo(now, message);
      deps.log.warn(`[updater] ${message}`);
      return last;
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      last = emptyInfo(now, '更新源返回的内容不是合法 JSON');
      return last;
    }

    // 自定义 JSON 源：{ version, notes, url }
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      const obj = parsed as ReleaseItem & { version?: string };
      if (typeof obj.version === 'string') {
        const latest = obj.version.replace(/^v/i, '');
        const available = compareVersion(latest, deps.appVersion) > 0;
        last = {
          currentVersion: deps.appVersion,
          latestVersion: latest,
          available,
          prerelease: /-/.test(latest),
          notes: String(obj.notes ?? obj.body ?? ''),
          publishedAt: obj.published_at,
          downloadUrl: pickDownloadUrl(obj),
          releaseUrl: obj.html_url ?? obj.url,
          checkedAt: now,
        };
        writeCache(last);
        if (available) deps.emit(EVT.updateAvailable, last);
        return last;
      }
      // GitHub 单条 release
      if (typeof obj.tag_name === 'string') {
        parsed = [obj];
      }
    }

    const releases = (Array.isArray(parsed) ? parsed : []) as ReleaseItem[];
    if (releases.length === 0) {
      last = emptyInfo(now, '更新源暂无发布版本');
      writeCache(last);
      return last;
    }

    const usable = releases.filter((r) => {
      if (!r || r.draft) return false;
      const tag = String(r.tag_name ?? r.version ?? '').trim();
      if (!tag) return false;
      if (!parseVersion(tag)) return false;
      if (channel === 'stable' && r.prerelease) return false;
      return true;
    });

    if (usable.length === 0) {
      last = emptyInfo(now, channel === 'stable' ? '暂无正式版本可用' : '暂无可用版本');
      writeCache(last);
      return last;
    }

    const latestRelease = usable.reduce((best, cur) => {
      const bv = String(best.tag_name ?? best.version ?? '');
      const cv = String(cur.tag_name ?? cur.version ?? '');
      return compareVersion(cv, bv) > 0 ? cur : best;
    }, usable[0]);

    const latestVersion = String(latestRelease.tag_name ?? latestRelease.version ?? '').replace(/^v/i, '');
    const available = compareVersion(latestVersion, deps.appVersion) > 0;

    last = {
      currentVersion: deps.appVersion,
      latestVersion,
      available,
      prerelease: !!latestRelease.prerelease,
      notes: String(latestRelease.body ?? latestRelease.notes ?? '').slice(0, 8000),
      publishedAt: latestRelease.published_at,
      downloadUrl: pickDownloadUrl(latestRelease),
      releaseUrl: latestRelease.html_url ?? latestRelease.url,
      checkedAt: now,
    };

    writeCache(last);

    try {
      deps.saveSettings({ update: { ...deps.settings().update, lastCheckAt: now } });
    } catch (err) {
      deps.log.warn('[updater] 记录检查时间失败', err);
    }

    if (available) {
      deps.log.info(`[updater] 发现新版本 ${latestVersion}（当前 ${deps.appVersion}）`);
      deps.emit(EVT.updateAvailable, last);
    }
    return last;
  }

  const cached = readCache();
  if (cached) last = cached.info;

  return {
    async check(force = false): Promise<UpdateInfo> {
      // 并发调用共享同一次请求
      if (running) return running;

      const cache = readCache();
      if (!force && cache && cache.info.available !== undefined && Date.now() - cache.at < CACHE_TTL_MS) {
        last = cache.info;
        return cache.info;
      }

      running = doCheck()
        .catch((err): UpdateInfo => {
          const message = err instanceof Error ? err.message : String(err);
          deps.log.error('[updater] 检查更新异常', err);
          const info = emptyInfo(Date.now(), `检查更新失败：${message}`);
          last = info;
          return info;
        })
        .finally(() => {
          running = null;
        });

      return running;
    },

    current(): UpdateInfo | null {
      return last;
    },
  };
}

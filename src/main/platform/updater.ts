/**
 * 更新检测 + 应用内一键升级（Updater）
 *
 *  - feed 是 owner/repo → GitHub Releases API；
 *  - feed 是 http(s) 地址 → 直接取该 JSON，兼容 { version, notes, url } 结构；
 *  - 结果缓存 30 分钟（<dataDir>/update/cache.json），force 忽略缓存；
 *  - install() 下载安装包 → SHA-256 校验 → 拉起静默安装器，进度用 EVT.updateProgress 推送；
 *  - 任何网络异常都转成中文 error 字段，绝不抛给调用方。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EVT } from '../../shared/ipc';
import type { PlatformDeps, Updater } from '../../shared/platform';
import type { UpdateInfo, UpdateProgress } from '../../shared/types';
import { writeJsonAtomic } from '../store';

const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;

interface WebReadableStream {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: WebReadableStream | null;
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
  assets?: { name?: string; browser_download_url?: string; digest?: string }[];
  /** 自定义 JSON 源兼容字段 */
  version?: string;
  notes?: string;
  url?: string;
  downloadUrl?: string;
  sha256?: string;
}

function getFetch(): FetchLike | null {
  const fn = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  return typeof fn === 'function' ? fn : null;
}

/** 解析版本号：v1.2.3-beta.1 → { nums:[1,2,3], pre:['beta',1] } */
interface ParsedVersion {
  nums: number[];
  /** 字母后缀等级（热修复级别）：0.0.3 → 0，0.0.3a → 1，0.0.3b → 2 */
  letter: number;
  pre: (string | number)[];
}

/** 末段可能带字母后缀（0.0.3a），拆出数字部分与字母等级 */
function parseVersion(raw: string): ParsedVersion | null {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  if (!text) return null;
  const [core, ...rest] = text.split('+')[0].split('-');
  const segments = core.split('.');
  let letter = 0;
  const last = segments[segments.length - 1] ?? '';
  const letterMatch = /^(.*?)([a-z]+)$/i.exec(last);
  if (letterMatch) {
    // a=1 … z=26，aa=27（按 26 进制累加，可稳定排序 a < b < … < z < aa）
    letter = letterMatch[2]
      .toLowerCase()
      .split('')
      .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 96), 0);
    segments[segments.length - 1] = letterMatch[1] || '0';
  }
  const nums = segments.map((n) => Number.parseInt(n, 10));
  if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return null;
  const pre: (string | number)[] = [];
  if (rest.length > 0) {
    for (const part of rest.join('-').split('.')) {
      const num = Number.parseInt(part, 10);
      pre.push(Number.isNaN(num) ? part.toLowerCase() : num);
    }
  }
  return { nums, letter, pre };
}

/** semver 比较：a > b 返回 1，相等 0，小于 -1 */
export function compareVersion(a: string, b: string): number {
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

  // 字母后缀是「热修复级别」，高于同数字版本（0.0.3a > 0.0.3 > 0.0.2）
  if (va.letter !== vb.letter) return va.letter > vb.letter ? 1 : -1;

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

  /** 取安装包资产的 SHA-256（GitHub API digest 字段；没有则回落到自定义源给的散列字段） */
  function pickSha256(item: ReleaseItem): string | undefined {
    const assets = item.assets ?? [];
    const preferred = assets.find((a) => /\.(exe|msi)$/i.test(a.name ?? '')) ?? assets[0];
    const digest = preferred?.digest ?? item.sha256;
    if (typeof digest !== 'string' || !digest.trim()) return undefined;
    return digest.trim().toLowerCase().replace(/^sha256[:=]/, '');
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
          assetSha256: pickSha256(obj),
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
      assetSha256: pickSha256(latestRelease),
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

  /* ----------------------- 应用内一键升级 ----------------------- */

  let installing: Promise<UpdateProgress> | null = null;

  function pushProgress(p: UpdateProgress): UpdateProgress {
    try {
      deps.emit(EVT.updateProgress, p);
    } catch (err) {
      deps.log.warn('[updater] 推送升级进度失败', err);
    }
    return p;
  }

  function fail(text: string, localPath?: string): UpdateProgress {
    return pushProgress({ stage: 'error', percent: 0, text, error: text, localPath });
  }

  /** 流式下载 + SHA-256 边下边算，返回摘要 hex */
  async function downloadInstaller(url: string, dest: string, info: UpdateInfo): Promise<string> {
    const doFetch = getFetch();
    if (!doFetch) throw new Error('当前运行环境不支持网络请求，无法下载更新');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': `Run-worker/${deps.appVersion}`, Accept: 'application/octet-stream' },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new Error(`下载失败：安装包地址返回 HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MAX_INSTALLER_BYTES) {
      clearTimeout(timer);
      throw new Error('安装包体积异常（超过 300 MB），已中止下载');
    }
    if (!res.body) {
      clearTimeout(timer);
      throw new Error('下载源未返回数据流，请改用「打开下载页」手动下载');
    }

    pushProgress({
      stage: 'downloading', percent: 0, text: '正在连接下载源…',
      received: 0, total: total || undefined,
    });

    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastPct = -1;
    let lastEmit = 0;
    const progressStream = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        hash.update(chunk);
        if (received > MAX_INSTALLER_BYTES) {
          cb(new Error('安装包体积异常（超过 300 MB），已中止下载'));
          return;
        }
        const now = Date.now();
        const pct = total ? Math.min(99, Math.floor((received / total) * 100)) : -1;
        if (now - lastEmit > 120 && pct !== lastPct) {
          lastEmit = now;
          lastPct = pct;
          pushProgress({
            stage: 'downloading',
            percent: pct,
            text: total
              ? `正在下载安装包 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
              : `正在下载安装包 ${(received / 1048576).toFixed(1)} MB`,
            received,
            total: total || undefined,
          });
        }
        cb(null, chunk);
      },
    });

    const tmp = `${dest}.part`;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.rmSync(tmp, { force: true }); } catch { /* 无残留 */ }
      const web = res.body as unknown as import('node:stream/web').ReadableStream;
      await pipeline(Readable.fromWeb(web), progressStream, fs.createWriteStream(tmp));
    } finally {
      clearTimeout(timer);
    }

    pushProgress({
      stage: 'verifying', percent: 100, text: '正在校验安装包完整性…',
      received, total: total || undefined,
    });
    const digest = hash.digest('hex');
    const expected = String(info.assetSha256 ?? '').trim().toLowerCase().replace(/^sha256[:=]/, '');
    if (expected) {
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('更新源提供的 SHA-256 格式不正确，已中止安装');
      if (digest !== expected) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
        throw new Error('安装包 SHA-256 校验不通过，已删除下载文件。请重试或手动从发布页下载。');
      }
    } else {
      deps.log.warn('[updater] 更新源未提供 SHA-256，已跳过散列校验');
    }
    try { fs.rmSync(dest, { force: true }); } catch { /* 忽略 */ }
    fs.renameSync(tmp, dest);
    return digest;
  }

  async function doInstall(): Promise<UpdateProgress> {
    const info = last ?? (await doCheck());
    if (!info?.available) return fail('当前已是最新版本，无需升级。');
    const url = info.downloadUrl;
    if (!url || !/^https?:\/\//i.test(url)) {
      return fail('该版本没有可用的安装包下载地址，请点击「打开下载页」手动升级。');
    }
    const dest = path.join(dir, `Run-worker-${info.latestVersion}-setup.exe`);
    try {
      await downloadInstaller(url, dest, info);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), dest);
    }
    if (process.platform !== 'win32') {
      return pushProgress({ stage: 'done', percent: 100, text: `安装包已下载：${dest}`, localPath: dest });
    }
    try {
      // 独立进程、忽略 stdio；主程序随后退出，安装器才能覆盖被占用的文件。
      // 关键：把 /D 指向“当前可执行文件所在目录”，确保就地升级而非回退到默认目录
      // （否则装在非默认路径的用户点击「一键升级」会装出第二份 Run worker）。
      const installDir = path.dirname(process.execPath);
      const child = spawn(dest, ['/S', `/D="${installDir}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => deps.log.warn('[updater] 启动安装器失败', err));
      child.unref();
    } catch (err) {
      return fail(`无法启动安装器：${err instanceof Error ? err.message : String(err)}`, dest);
    }
    return pushProgress({
      stage: 'installing',
      percent: 100,
      text: `已启动 ${info.latestVersion} 安装程序，Run worker 即将退出以完成升级。`,
      localPath: dest,
    });
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

    install(): Promise<UpdateProgress> {
      if (installing) return installing;
      installing = doInstall()
        .catch((err): UpdateProgress => {
          const text = err instanceof Error ? err.message : String(err);
          deps.log.error('[updater] 一键升级异常', err);
          return fail(`升级失败：${text}`);
        })
        .finally(() => {
          installing = null;
        });
      return installing;
    },
  };
}

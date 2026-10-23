/**
 * Run worker — 运行环境探测
 * 安装目录、环境变量、PATH 可见性、版本信息。主进程启动时调用一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { APP_NAME } from '../shared/types';
import type { AppInfo } from '../shared/types';

export const REPO_URL = 'https://github.com/LHRonline/run-worker';
export const APP_HOME_ENV = 'RUN_WORKER_HOME';

export interface EnvSnapshot {
  isPackaged: boolean;
  installDir: string;
  appPath: string;
  userData: string;
  homeEnv: string | null;
  pathHasInstall: boolean;
  version: string;
}

/** 安装目录：打包后取 exe 所在目录，开发态取项目根目录 */
export function resolveInstallDir(): string {
  if (app.isPackaged) return path.dirname(process.execPath);
  return app.getAppPath();
}

function splitPath(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function pathHasDir(dir: string): boolean {
  return splitPath(process.env.PATH).some((p) => sameDir(p, dir));
}

/** 包装 Python/ffmpeg 等自带工具时，让它们能被 shell 直接找到 */
export function applyEnvToPath(): void {
  const dirs: string[] = [];
  const home = process.env[APP_HOME_ENV];
  if (home && fs.existsSync(home)) dirs.push(home);
  const installDir = resolveInstallDir();
  dirs.push(installDir);
  const toolsDir = path.join(installDir, 'tools');
  if (fs.existsSync(toolsDir)) dirs.push(toolsDir);
  const binDir = path.join(installDir, 'bin');
  if (fs.existsSync(binDir)) dirs.push(binDir);

  const current = process.env.PATH || '';
  const missing = dirs.filter((d) => d && !pathHasDir(d));
  if (missing.length > 0) process.env.PATH = [...missing, current].filter(Boolean).join(path.delimiter);
}

export function readEnv(): EnvSnapshot {
  const installDir = resolveInstallDir();
  const homeEnv = process.env[APP_HOME_ENV] || null;
  return {
    isPackaged: app.isPackaged,
    installDir,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    homeEnv,
    pathHasInstall: pathHasDir(installDir),
    version: app.getVersion(),
  };
}

export function createAppInfo(): AppInfo {
  const env = readEnv();
  return {
    name: APP_NAME,
    version: env.version,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    userData: env.userData,
    installDir: env.installDir,
    env: { RUN_WORKER_HOME: env.homeEnv, pathHasInstall: env.pathHasInstall },
    repoUrl: REPO_URL,
  };
}

/** 工作目录：用户配置优先，否则用 userData/workspace */
export function resolveWorkspaceDir(configured: string, fallback: string): string {
  const dir = (configured || '').trim() || fallback;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      /* 兜底目录也不可用时由调用方处理 */
    }
    return fs.existsSync(fallback) ? fallback : dir;
  }
  return dir;
}

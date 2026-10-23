/**
 * Run worker — 主进程入口
 * 单实例、无边框窗口、主题跟随系统、平台模块启动与退出清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, safeStorage, shell } from 'electron';
import { APP_ID, APP_NAME } from '../shared/types';
import { EVT } from '../shared/ipc';
import { applyEnvToPath, createAppInfo } from './env';
import { ENC_PREFIX } from './store';
import { createContext } from './chat/context';
import type { MainContext } from './chat/context';
import { registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;
let ctx: MainContext | null = null;
let shuttingDown = false;

const isDev = !app.isPackaged;

/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  bootstrap();
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function bootstrap(): void {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  applyEnvToPath();

  // 单实例竞争期间不创建窗口
  app.whenReady().then(onReady).catch((err) => {
    // 启动阶段失败也要留下痕迹
    console.error('[runworker] 启动失败', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', () => {
    void shutdown();
  });
}

async function onReady(): Promise<void> {
  const appInfo = createAppInfo();
  const dataDir = appInfo.userData;

  ctx = createContext({
    dataDir,
    appInfo,
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    },
  });

  installGlobalErrorHandlers(ctx);
  initSecretsCodec(ctx);
  registerIpc(ctx, { getWindow: () => mainWindow });
  registerThemeEvents(ctx);

  createWindow();

  // 平台模块在窗口创建后异步启动，避免拖慢首屏
  void startPlatform(ctx);
}

function createWindow(): void {
  const accentBg = nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#f7f8fa';
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: accentBg,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
    if (isDev && process.env.RUNWORKER_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 外链一律交给系统浏览器，且只允许 http/https
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const indexFile = path.join(__dirname, '../../dist/renderer/index.html');
    if (fs.existsSync(indexFile)) void win.loadFile(indexFile);
    else {
      void win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<body style="font-family:system-ui;background:#0b0f17;color:#e5e7eb;padding:48px">
             <h2>渲染进程尚未构建</h2>
             <p>请先执行 <code>npm run build:renderer</code>，或使用 <code>npm run dev</code> 启动开发环境。</p>
             <p style="color:#6b7280">预期文件：${indexFile}</p>
           </body>`,
        )}`,
      );
    }
  }
}

/** 启动平台模块：MCP、定时任务、知识库、更新检查 */
async function startPlatform(context: MainContext): Promise<void> {
  const log = context.log;
  try {
    await context.mcp.init();
    log.info('[startup] MCP 已初始化');
  } catch (err) {
    log.error('[startup] MCP 初始化失败', err);
  }

  try {
    await context.kb.init();
    log.info('[startup] 知识库已就绪');
  } catch (err) {
    log.error('[startup] 知识库初始化失败', err);
  }

  try {
    context.scheduler.start();
    log.info('[startup] 定时任务已启动');
  } catch (err) {
    log.error('[startup] 定时任务启动失败', err);
  }

  const settings = context.settings();
  if (settings.update.autoCheck) {
    // 延迟 8 秒，错开首屏渲染与网络请求
    setTimeout(() => {
      if (shuttingDown) return;
      void context.updater
        .check(false)
        .then((info) => {
          if (info.available) log.info(`[startup] 发现新版本 ${info.latestVersion}（广播由 updater 发出）`);
        })
        .catch((err) => log.warn('[startup] 检查更新失败（忽略）', err));
    }, 8000);
  }
}

/**
 * API Key 加密存储：用系统凭据机制（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 可用时把 settings.json 里的明文 Key 迁移为密文；不可用时保持明文并记录日志。
 */
function initSecretsCodec(context: MainContext): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      context.log.warn('[startup] 系统不支持凭据加密，API Key 仍为明文存储（仅写入本机 settings.json）');
      return;
    }
    context.store.setSecretsCodec({
      encrypt: (plain) => ENC_PREFIX + safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
    });
    context.log.info('[startup] API Key 已启用系统级加密存储（safeStorage）');
  } catch (err) {
    context.log.warn('[startup] 初始化 Key 加密失败，回退明文存储', err);
  }
}

/** 系统主题变化推送给渲染层 */
function registerThemeEvents(context: MainContext): void {
  // 用户选「跟随系统」时才能真正跟随；选了 dark/light 就固定
  const mode = context.settings().appearance.theme;
  nativeTheme.themeSource = mode === 'dark' || mode === 'light' ? mode : 'system';
  const push = () => {
    context.emit(EVT.systemTheme, nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  };
  nativeTheme.on('updated', push);
  app.on('browser-window-focus', push);
}

/* ------------------------------------------------------------------ */
/* 崩溃与未捕获异常                                                    */
/* ------------------------------------------------------------------ */

function installGlobalErrorHandlers(context: MainContext): void {
  process.on('uncaughtException', (err) => {
    context.log.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    context.log.error('[unhandledRejection]', reason);
  });
  app.on('render-process-gone', (_event, _contents, details) => {
    context.log.error('[render-process-gone]', details.reason, details.exitCode);
  });
  app.on('child-process-gone', (_event, details) => {
    context.log.error('[child-process-gone]', details.type, details.reason);
  });
}

/* ------------------------------------------------------------------ */
/* 退出清理                                                            */
/* ------------------------------------------------------------------ */

async function shutdown(): Promise<void> {
  if (shuttingDown || !ctx) return;
  shuttingDown = true;
  const context = ctx;
  try {
    context.approval.cancelAll();
    context.chat.abort();
  } catch {
    /* 忽略 */
  }
  try {
    context.scheduler.stop();
  } catch (err) {
    context.log.warn('[shutdown] 停止定时任务失败', err);
  }
  try {
    await context.mcp.shutdown();
  } catch (err) {
    context.log.warn('[shutdown] 关闭 MCP 失败', err);
  }
  context.log.info('[shutdown] 已退出');
}

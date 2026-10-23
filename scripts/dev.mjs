/**
 * 开发模式：编译主进程 → 启动 Vite dev server → 启动 Electron
 * 用法：npm run dev
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const PORT = 5173;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, env, ...opts });
}

function waitPort(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const socket = createServer()
        .once('error', () => {
          socket.close();
          resolve(true);
        })
        .once('listening', () => {
          socket.close();
          if (Date.now() - started > timeoutMs) reject(new Error('等待 Vite 超时'));
          else setTimeout(tick, 300);
        })
        .listen(port, '127.0.0.1');
    };
    tick();
  });
}

console.log('[Run worker] 编译主进程与预加载脚本...');
const tsc = run(npx, ['tsc', '-p', 'tsconfig.main.json']);
await new Promise((resolve, reject) => {
  tsc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('主进程编译失败'))));
});

if (!existsSync(path.join(root, 'dist-electron/main/index.js'))) {
  console.error('[Run worker] dist-electron/main/index.js 缺失，请检查 tsconfig.main.json');
  process.exit(1);
}

console.log('[Run worker] 启动渲染进程开发服务器...');
const vite = run(npx, ['vite', '--port', String(PORT), '--strictPort']);
await waitPort(PORT);

console.log('[Run worker] 启动 Electron 窗口...');
const electron = run(npx, ['electron', '.'], {
  env: { ...env, VITE_DEV_SERVER_URL: `http://localhost:${PORT}` },
});

const shutdown = () => {
  vite.kill();
  electron.kill();
  process.exit(0);
};

electron.on('exit', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Run worker — E2E 启动器
 *
 * 作用：清除 ELECTRON_RUN_AS_NODE（本机全局设置，会让 require('electron') 变成路径字符串），
 * 用项目自带的 electron 二进制拉起 tests/e2e/harness.cjs，并原样转发退出码。
 *
 * 用法：node scripts/run-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const harness = path.join(root, 'tests', 'e2e', 'harness.cjs');
const mainEntry = path.join(root, 'dist-electron', 'main', 'index.js');
const preloadEntry = path.join(root, 'dist-electron', 'preload', 'index.js');

for (const [label, file] of [
  ['主进程产物', mainEntry],
  ['预加载产物', preloadEntry],
]) {
  if (!fs.existsSync(file)) {
    console.error(`[e2e] 缺少${label}：${file}\n       请先执行 npx tsc -p tsconfig.main.json`);
    process.exit(2);
  }
}

const electronBin = require('electron');

const env = { ...process.env };
// 关键：本机全局设置了 ELECTRON_RUN_AS_NODE=1，必须删掉，否则 electron 会以 Node 模式运行
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
// 保证 E2E 不读取开发服务器的地址
delete env.VITE_DEV_SERVER_URL;
env.RUNWORKER_E2E = '1';

console.log(`[e2e] electron: ${electronBin}`);
console.log(`[e2e] harness : ${harness}`);

const child = spawn(electronBin, [harness], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(`[e2e] 启动 electron 失败：${err.message}`);
  process.exit(2);
});

const killer = setTimeout(() => {
  console.error('[e2e] 120s 总超时，强制结束');
  try {
    child.kill();
  } catch {
    /* 忽略 */
  }
}, 120_000);

child.on('exit', (code, signal) => {
  clearTimeout(killer);
  if (signal) {
    console.error(`[e2e] electron 被信号 ${signal} 结束`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

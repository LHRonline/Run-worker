/**
 * Run worker — 打包产物验证（真实 exe，非开发态）
 *
 * 目的：证明 asar 打包后 preload 仍能注入、IPC 仍能握手、渲染进程不白屏。
 * 做法：spawn `win-unpacked/Run worker.exe` + `--remote-debugging-port`，
 *      走 CDP（Runtime.evaluate）在真实页面上下文里断言，全程不依赖 dev server。
 *
 * 用法：npm run test:packaged
 * 全部通过输出 `PACKAGED PASS (n/n)`；失败会打印页面错误、进程输出与日志尾部。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const OVERALL_TIMEOUT_MS = 100_000;
const STARTUP_TIMEOUT_MS = 45_000;
/** 启动后白屏观察时长 */
const BLANK_WATCH_MS = 8_000;

const results = [];
let finished = false;
let child = null;
let ws = null;

function log(line = '') {
  console.log(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(name, hint, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    log(`PASS  ${name}${detail ? `  —  ${detail}` : ''}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, message, hint });
    log(`FAIL  ${name}\n      实际：${message}${hint ? `\n      疑似根因：${hint}` : ''}`);
  }
}

/* ------------------------------ 定位产物 ------------------------------ */

const EXE_CANDIDATES = [
  process.env.RUNWORKER_E2E_EXE || '',
  `release-${pkg.version}/win-unpacked/Run worker.exe`,
  'release/win-unpacked/Run worker.exe',
  'dist/win-unpacked/Run worker.exe',
].filter(Boolean);

/**
 * 产物定位：显式指定的优先；其余按「app.asar 修改时间」取最新。
 * 不能用固定顺序——electron-builder.yml 的 output 是 `release`，而手工构建可能产出
 * `release-<版本>`，两份并存时固定顺序会拿旧的那份，导致「验证旧代码却报 PASS」。
 */
function listCandidates() {
  const seen = new Set();
  const out = [];
  for (const rel of EXE_CANDIDATES) {
    const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (seen.has(full) || !fs.existsSync(full)) continue;
    seen.add(full);
    const dir = path.dirname(full);
    const asar = path.join(dir, 'resources', 'app.asar');
    let mtime = 0;
    try {
      mtime = fs.statSync(fs.existsSync(asar) ? asar : full).mtimeMs;
    } catch {
      mtime = 0;
    }
    out.push({ full, asar: fs.existsSync(asar) ? asar : null, mtime, explicit: rel === process.env.RUNWORKER_E2E_EXE });
  }
  return out;
}

const candidates = listCandidates();
const explicit = candidates.find((c) => c.explicit);
const chosen = explicit ?? [...candidates].sort((a, b) => b.mtime - a.mtime)[0] ?? null;

const exePath = chosen ? chosen.full : null;
const exeDir = exePath ? path.dirname(exePath) : null;
const asarPath = exeDir ? path.join(exeDir, 'resources', 'app.asar') : null;

/* ------------------------------ 工具函数 ------------------------------ */

function findFreePort(start = 9333) {
  return new Promise((resolve) => {
    let port = start;
    const tryPort = () => {
      const srv = net.createServer();
      srv.once('error', () => {
        port += 1;
        if (port > start + 20) resolve(start);
        else tryPort();
      });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
}

/** 读取日志目录里最新的 .log 尾部 */
function tailLatestLog(logDir, lines = 40) {
  try {
    if (!fs.existsSync(logDir)) return `（日志目录不存在：${logDir}）`;
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files.length === 0) return `（日志目录为空：${logDir}）`;
    const text = fs.readFileSync(path.join(logDir, files[0].f), 'utf8');
    const arr = text.split(/\r?\n/).filter(Boolean);
    return `${files[0].f}（共 ${arr.length} 行）：\n${arr.slice(-lines).join('\n')}`;
  } catch (err) {
    return `（读取日志失败：${err.message}）`;
  }
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ CDP 客户端 ------------------------------ */

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error(`连接 CDP 超时：${wsUrl}`)), 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`连接 CDP 失败：${e && e.message ? e.message : wsUrl}`));
    });
  });
}

function createSender(socket) {
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // 事件消息忽略
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`CDP 错误：${msg.error.message}`));
    else slot.resolve(msg.result ?? {});
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (seq += 1);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时（20s）：${method}`));
        }
      }, 20_000);
    });
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  log('=== Run worker 打包产物验证 ===');
  log(`· 项目根目录：${ROOT}`);
  log(`· 应用版本：${pkg.version}`);
  if (candidates.length > 1) {
    log('· 候选产物（按 app.asar 时间取最新，可用 RUNWORKER_E2E_EXE 覆盖）：');
    for (const c of [...candidates].sort((a, b) => b.mtime - a.mtime)) {
      const mark = c.full === exePath ? '← 本次使用' : '';
      const time = c.mtime ? new Date(c.mtime).toLocaleTimeString('zh-CN', { hour12: false }) : '时间未知';
      log(`    ${c.asar ? '✓' : '✗'} ${path.relative(ROOT, c.full)}  ${time}  ${mark}`);
    }
  }

  const guard = setTimeout(() => {
    if (finished) return;
    log(`\n!! 整体超时（${OVERALL_TIMEOUT_MS / 1000}s）`);
    finish(1);
  }, OVERALL_TIMEOUT_MS);

  let sender = null;
  let pageUrl = '';
  /** 启动前的产物指纹，用于识别「运行期间产物被重建」这类环境竞态 */
  const artifactMark = exeDir
    ? ['Run worker.exe', 'resources/app.asar']
        .map((rel) => {
          const p = path.join(exeDir, rel);
          try {
            const st = fs.statSync(p);
            return { rel, size: st.size, mtimeMs: st.mtimeMs };
          } catch {
            return { rel, size: -1, mtimeMs: -1 };
          }
        })
    : [];

  function artifactChangedDuringRun() {
    const changed = [];
    for (const mark of artifactMark) {
      try {
        const st = fs.statSync(path.join(exeDir, mark.rel));
        if (st.size !== mark.size || Math.abs(st.mtimeMs - mark.mtimeMs) > 1000) changed.push(mark.rel);
      } catch {
        changed.push(`${mark.rel}（已消失）`);
      }
    }
    return changed;
  }

  /** 进程提前退出时给出可操作的解释，避免把环境竞态误判成产品缺陷 */
  function exitHint() {
    const changed = artifactChangedDuringRun();
    if (changed.length > 0) {
      return `\n      注意：本轮运行期间打包产物被改动（${changed.join('、')}），很可能是同时存在 electron-builder 构建，请等打包结束后重跑`;
    }
    const last = artifactMark[1];
    if (last && last.mtimeMs > 0 && Date.now() - last.mtimeMs < 20_000) {
      return '\n      注意：app.asar 刚刚被写入（<20s），可能仍在打包中，建议等打包完成后再跑';
    }
    return '';
  }

  /* A. 产物完整性 */
  await step('A1 win-unpacked 可执行文件存在', '请先执行 npm run pack / npm run dist', async () => {
    assert(exePath, `未找到 Run worker.exe，已查找：${EXE_CANDIDATES.join(' | ')}`);
    const size = fs.statSync(exePath).size;
    assert(size > 10 * 1024 * 1024, `exe 仅 ${(size / 1024 / 1024).toFixed(1)}MB，疑似产物不完整`);
    return `${path.relative(ROOT, exePath)}（${(size / 1024 / 1024).toFixed(1)}MB）`;
  });

  await step('A2 resources/app.asar 存在且 > 1MB', 'electron-builder 配置 files/asar 打包', async () => {
    assert(asarPath, '未定位到 app.asar（exe 不存在时无法推导）');
    assert(fs.existsSync(asarPath), `app.asar 不存在：${asarPath}`);
    const size = fs.statSync(asarPath).size;
    assert(size > 1024 * 1024, `app.asar 仅 ${(size / 1024).toFixed(0)}KB（期望 >1MB，可能没把 dist 打进 asar）`);
    return `${(size / 1024 / 1024).toFixed(2)}MB`;
  });

  if (!exePath) {
    log('\n产物缺失，跳过启动验证');
    clearTimeout(guard);
    finish(1);
    return;
  }

  /* B. 启动真实 exe */
  const port = await findFreePort(9333);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'runworker-packaged-'));
  // 跳过首次引导，直接进入主界面（否则 Onboarding 会盖住底部设置按钮，I1 步骤无法点击设置）
  try {
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingDone: true }));
    // 工作区分组回归种子：一个真实文件夹 + 一个绑定到它的会话
    const wsDir = path.join(userData, '演示工作区');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(userData, 'workspaces.json'), JSON.stringify([
      { id: 'ws-e2e', name: '演示工作区', path: wsDir, createdAt: Date.now() },
    ]));
    const convDir = path.join(userData, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const usage = {
      promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0,
      totalTokens: 0, costCny: 0, tokenSource: 'estimated', exactRequests: 0, totalRequests: 0,
    };
    const conv = {
      id: 'conv-e2e', title: '分组里的对话', createdAt: 1, updatedAt: Date.now(),
      pinned: false, messageCount: 0, agentId: 'orchestrator', usage,
      preview: '', workspaceId: 'ws-e2e', messages: [],
    };
    fs.writeFileSync(path.join(convDir, 'conv-e2e.json'), JSON.stringify(conv));
    const { messages, ...meta } = conv;
    void messages;
    fs.writeFileSync(path.join(convDir, 'index.json'), JSON.stringify([meta]));
  } catch {
    /* 忽略：种子文件缺失只会影响 I1/I2，不影响前面的断言 */
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  // 打包应用不支持多数 NODE_OPTIONS，去掉避免 Electron 启动时报 ERROR 噪音
  delete env.NODE_OPTIONS;

  log(`· 调试端口：${port}`);
  log(`· 临时 userData：${userData}`);

  child = spawn(exePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--no-first-run'], {
    cwd: exeDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const procOut = [];
  child.stdout.on('data', (d) => procOut.push(String(d).trimEnd()));
  child.stderr.on('data', (d) => procOut.push(String(d).trimEnd()));

  const spawnAt = Date.now();

  let target = null;
  await step('B1 打包 exe 可启动并暴露 CDP 调试端口', 'main/index.ts 窗口创建 / electron-builder 产物完整性', async () => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(list)) {
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          target = page;
          pageUrl = page.url || '';
          return `${Math.round((Date.now() - spawnAt) / 100) / 10}s 内出现页面：${pageUrl.slice(0, 80)}`;
        }
      }
      if (child.exitCode !== null) {
        throw new Error(
          `进程提前退出（code=${child.exitCode}）。输出：${procOut.join(' ').slice(-400) || '（无）'}${exitHint()}`,
        );
      }
      await sleep(300);
    }
    throw new Error(`${STARTUP_TIMEOUT_MS / 1000}s 内未出现可调试页面；进程输出：${procOut.join(' ').slice(-500) || '（无）'}`);
  });

  if (!target) {
    clearTimeout(guard);
    log('\n无法连接调试端口，打印进程输出：');
    log(procOut.join('\n').slice(-2000) || '（无输出）');
    finish(1);
    return;
  }

  /* C. 页面断言 */
  await step('C1 CDP WebSocket 可连接并可执行 JS', 'Chromium 远程调试', async () => {
    ws = await connectCdp(target.webSocketDebuggerUrl);
    sender = createSender(ws);
    const r = await sender('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    assert(r && r.result && r.result.value === 2, `Runtime.evaluate 返回异常：${JSON.stringify(r)}`);
    return 'Runtime.evaluate 正常';
  });

  if (!sender) {
    clearTimeout(guard);
    finish(1);
    return;
  }

  async function evaluate(expr, { awaitPromise = false, timeout = 20_000 } = {}) {
    const r = await Promise.race([
      sender('Runtime.evaluate', {
        expression: expr,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
        timeout,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`页面执行超时（${timeout}ms）：${expr.slice(0, 60)}`)), timeout + 2_000)),
    ]);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
      throw new Error(`页面抛出异常：${String(desc).split('\n')[0]}`);
    }
    return r.result?.value;
  }

  await step('C2 页面地址为打包内的 index.html（未落到错误页/空白页）', 'dist/renderer/index.html 是否打进 asar', async () => {
    const href = await evaluate('location.href');
    assert(typeof href === 'string' && href.startsWith('file://'), `location.href=${href}`);
    assert(!/chrome-error|about:blank/i.test(href), `页面停在错误页：${href}`);
    assert(/index\.html$/i.test(href), `页面地址不是 index.html：${href}`);
    return href.slice(0, 110);
  });

  await step('D1 asar 环境下 preload 注入成功（typeof window.runworker === "object"）', 'src/preload/index.ts + webPreferences.preload 相对路径是否指向 asar 内 dist-electron/preload', async () => {
    const t = await evaluate('typeof window.runworker');
    assert(t === 'object', `window.runworker 类型为 ${t}（期望 object）：preload 未注入或 contextBridge 失败`);
    return t;
  });

  await step('D2 bootstrap() 在打包环境可返回，agents.length === 8', 'src/main/ipc.ts bootstrap / src/shared/agents.ts', async () => {
    const summary = await evaluate(
      'window.runworker.bootstrap().then((b) => ({ agents: b.agents.length, version: b.app.version, hasSettings: !!b.settings, providers: b.settings.providers.length }))',
      { awaitPromise: true, timeout: 25_000 },
    );
    assert(summary && typeof summary === 'object', `bootstrap 返回非对象：${JSON.stringify(summary)}`);
    assert(summary.agents === 8, `agents.length=${summary.agents}（期望 8）`);
    assert(summary.hasSettings === true, 'bootstrap().settings 缺失');
    return `agents=${summary.agents} providers=${summary.providers} version=${summary.version}`;
  });

  await step('D3 渲染进程非白屏（有 app 容器且正文 > 200 字）', 'src/renderer 入口挂载 / dist/renderer 资源加载', async () => {
    // 页面 target 出现时 React 可能还没挂载，这里轮询到 10s 上限，E1 再做 8s 后的终态复核
    const startedAt = Date.now();
    const deadline = startedAt + 10_000;
    let dom = null;
    while (Date.now() < deadline) {
      dom = await evaluate(`(() => {
        const containers = document.querySelectorAll('.app, #root, [class*="app"]').length;
        const text = document.body ? document.body.innerText || '' : '';
        return { containers, len: text.length, ready: document.readyState };
      })()`);
      if (dom && dom.ready === 'complete' && dom.containers > 0 && dom.len > 200) {
        return `容器 ${dom.containers} 个，正文 ${dom.len} 字（${Date.now() - startedAt}ms 内完成首屏）`;
      }
      if (child.exitCode !== null) throw new Error(`进程已退出（code=${child.exitCode}）${exitHint()}`);
      await sleep(250);
    }
    assert(dom && dom.ready === 'complete', `document.readyState=${dom && dom.ready}`);
    assert(dom.containers > 0, `未找到 app 容器（.app/#root/[class*=app] 命中 0 个）`);
    throw new Error(`10s 内正文仍只有 ${dom.len} 字（期望 >200，疑似白屏）`);
  });

  await step('D4 页面正文包含 "Run worker"（品牌渲染正确）', 'src/renderer 文案 / APP_NAME', async () => {
    const text = await evaluate('document.body ? document.body.innerText : ""');
    assert(typeof text === 'string' && text.includes('Run worker'), `正文未包含 "Run worker"，前 120 字：${String(text).slice(0, 120).replace(/\n/g, ' ')}`);
    return '含品牌名';
  });

  await step('D5 启动日志三行齐全（MCP / 知识库 / 定时任务）', 'src/main/index.ts startPlatform 的启动日志', async () => {
    const logDir = path.join(userData, 'logs');
    let text = '';
    for (let i = 0; i < 20; i += 1) {
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
        if (files.length > 0) {
          const latest = files
            .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)[0].f;
          text = fs.readFileSync(path.join(logDir, latest), 'utf8');
          if (/\[startup\] 定时任务已启动/.test(text)) break;
        }
      }
      await sleep(250);
    }
    const expected = ['[startup] MCP 已初始化', '[startup] 知识库已就绪', '[startup] 定时任务已启动'];
    const missing = expected.filter((line) => !text.includes(line));
    assert(missing.length === 0, `启动日志缺少：${missing.join('、')}（日志目录 ${logDir}）`);
    return `3 行齐全（日志目录：${path.relative(userData, logDir) || 'logs'}）`;
  });

  await step(`E1 启动 ${BLANK_WATCH_MS / 1000}s 后仍无白屏/加载失败（回归防护）`, '窗口加载失败时 location 会变成 chrome-error，正文会骤降', async () => {
    const wait = Math.max(0, spawnAt + BLANK_WATCH_MS - Date.now());
    if (wait > 0) await sleep(wait);

    assert(child.exitCode === null, `进程在 ${BLANK_WATCH_MS / 1000}s 内退出（code=${child.exitCode}），说明启动后自行关闭或崩溃${exitHint()}`);

    const state = await evaluate(`(() => {
      const text = document.body ? document.body.innerText || '' : '';
      return { href: location.href, ready: document.readyState, len: text.length, runworker: typeof window.runworker };
    })()`);
    assert(!/chrome-error/i.test(state.href), `页面加载失败（chrome-error）：${state.href}`);
    assert(state.ready === 'complete', `readyState=${state.ready}`);
    assert(state.len >= 100, `正文仅 ${state.len} 字（<100，判定白屏/未渲染）`);
    assert(state.runworker === 'object', 'window.runworker 在 8s 后消失（preload 崩溃？）');
    return `ready=${state.ready} 正文 ${state.len} 字`;
  });

  /* I. 工作区分组：侧栏按文件夹分组，绑定的会话缩进显示在工作区下面 */
  await step(
    'I2 侧栏按工作区文件夹分组展示会话（工作区回归）',
    'workspaces.json + ConversationMeta.workspaceId → Sidebar.tsx WorkspaceTree',
    async () => {
      const result = await evaluate(
        `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let tries = 0;
        while (tries++ < 50 && !document.querySelector('.ws-tree .ws-row')) await sleep(100);
        const row = document.querySelector('.ws-tree .ws-row');
        if (!row) throw new Error('侧栏没有渲染工作区分组');
        const name = row.querySelector('.ws-name');
        if (!name || !name.textContent.includes('演示工作区')) {
          throw new Error('工作区名称不对：' + (name && name.textContent));
        }
        const conv = document.querySelector('.ws-conv .conv-item .conv-title');
        if (!conv || !conv.textContent.includes('分组里的对话')) {
          throw new Error('工作区下没有缩进显示绑定的对话');
        }
        return '分组=' + name.textContent.trim() + '，子会话=' + conv.textContent.trim();
      })()`,
        { awaitPromise: true, timeout: 20000 },
      );
      return result;
    },
  );

  /* I. 0.0.3c 回归：设置页内点击「查看本次更新内容」弹窗必须盖在设置页之上 */
  await step(
    'I1 设置页内「查看本次更新内容」弹窗层级高于设置页（0.0.3c 回归）',
    'src/renderer/styles/layout.css .overlay z-index 必须 > .settings-overlay',
    async () => {
      const result = await evaluate(
        `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (s) => document.querySelector(s);
        const qa = (s) => [...document.querySelectorAll(s)];
        const click = (el) => { if (el) el.click(); };
        const setBtn = qa('.foot-btn').find((b) => (b.getAttribute('title') || '') === '设置') || qa('[title="设置"]')[0];
        if (!setBtn) throw new Error('未找到设置按钮（可能仍在引导页）');
        click(setBtn);
        let tries = 0;
        while (tries++ < 50 && !q('.settings-overlay')) await sleep(100);
        if (!q('.settings-overlay')) throw new Error('设置页未打开');
        const navBtns = qa('.settings-nav-btn');
        const upd = navBtns.find((b) => (b.textContent || '').includes('更新'));
        if (!upd) throw new Error('未找到「更新」分组按钮');
        click(upd);
        await sleep(250);
        const link = qa('button, a').find((e) => (e.textContent || '').includes('查看本次更新内容'));
        if (!link) throw new Error('未找到「查看本次更新内容」按钮');
        click(link);
        tries = 0;
        while (tries++ < 50 && !q('.overlay')) await sleep(100);
        const ov = q('.overlay');
        if (!ov) throw new Error('点击后未出现 .overlay 弹窗（被设置页遮挡）');
        const settings = q('.settings-overlay');
        const zOv = parseInt(getComputedStyle(ov).zIndex || '0', 10);
        const zSet = parseInt(getComputedStyle(settings).zIndex || '0', 10);
        if (!(zOv > zSet)) throw new Error('弹窗 z-index(' + zOv + ') 未高于设置页(' + zSet + ')，仍会被遮挡');
        const r = ov.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        if (!ov.contains(hit)) throw new Error('屏幕中心命中元素不在弹窗内（被设置页遮挡），命中=' + (hit && (hit.className || hit.tagName)));
        return 'overlay z=' + zOv + ' > settings z=' + zSet + '，中心命中属于弹窗';
      })()`,
        { awaitPromise: true, timeout: 25000 },
      );
      return result;
    },
  );

  clearTimeout(guard);
  const okBeforeExit = results.every((r) => r.ok);

  /* 失败时补打诊断信息 */
  if (!okBeforeExit) {
    log('\n--- 诊断信息 ---');
    log(`进程输出（尾部）：\n${procOut.join('\n').slice(-1500) || '（无）'}`);
    log(`应用日志（--user-data-dir 内）：\n${tailLatestLog(path.join(userData, 'logs'))}`);
    const appData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Run worker', 'logs') : '';
    if (appData) log(`应用日志（%APPDATA%）：\n${tailLatestLog(appData)}`);
  }

  finish(okBeforeExit ? 0 : 1);
}

function finish(code) {
  if (finished) return;
  finished = true;

  try {
    if (ws) ws.close();
  } catch {
    /* 忽略 */
  }
  killTree(child && child.pid);

  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  log('');
  log('---------------------------------------------');
  if (bad.length === 0) {
    log(`PACKAGED PASS (${ok}/${results.length})`);
  } else {
    log(`PACKAGED FAILED  ${bad.length}/${results.length}`);
    for (const f of bad) {
      log(`  - ${f.name}`);
      log(`    实际：${f.message}`);
      if (f.hint) log(`    疑似根因：${f.hint}`);
    }
  }
  log('---------------------------------------------');

  setTimeout(() => process.exit(code), 300);
}

process.on('uncaughtException', (err) => {
  log(`!! 未捕获异常：${err && err.stack ? err.stack : err}`);
  results.push({ name: '脚本未捕获异常', ok: false, message: String(err && err.message ? err.message : err) });
  finish(1);
});
process.on('unhandledRejection', (reason) => {
  log(`!! 未处理拒绝：${reason && reason.stack ? reason.stack : reason}`);
});

main().catch((err) => {
  log(`!! 主流程异常：${err && err.stack ? err.stack : err}`);
  results.push({ name: '主流程', ok: false, message: String(err && err.message ? err.message : err) });
  finish(1);
});

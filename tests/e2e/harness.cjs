/**
 * Run worker — 真实 Electron 端到端验证（harness）
 *
 * 启动方式（不要直接 `node` 跑）：`node scripts/run-e2e.mjs`
 * 它负责清掉 ELECTRON_RUN_AS_NODE 后拉起 electron 执行本文件。
 *
 * 做的事：用真实主进程（dist-electron/main）+ 真实 preload + 构建产物 dist/renderer，
 * 通过 `executeJavaScript` 调 window.runworker.* 跑 A~H 断言，逐项打印 PASS/FAIL。
 * 只读不写 src/**；任何失败都保留临时 userData 目录便于取证。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { app, BrowserWindow } = require('electron');

/* ------------------------------------------------------------------ */
/* 隔离运行环境                                                        */
/* ------------------------------------------------------------------ */

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const userData = path.join(os.tmpdir(), `runworker-e2e-${stamp}`);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

// F4 预置：在 userData 里放一个已到期的 once 任务，验证调度器 ticker 补跑路径。
// 必须在 require 主进程之前落盘，调度器构造时才会加载到。
const seedTasksDir = path.join(userData, 'tasks');
fs.mkdirSync(seedTasksDir, { recursive: true });
fs.writeFileSync(
  path.join(seedTasksDir, 'tasks.json'),
  JSON.stringify([
    {
      id: 'e2e-task-ticker',
      name: 'E2E ticker 补跑',
      prompt: '回复一个字：好',
      agentId: 'orchestrator',
      kind: 'once',
      runAt: Date.now() - 60_000,
      enabled: true,
      createdAt: Date.now() - 120_000,
      indexResult: false,
    },
  ]),
  'utf8',
);

// 以「脚本」方式启动时 appPath=脚本目录、version=Electron 版本，
// 这里还原 `electron .` 的真实取值，避免 A 断言读到 Electron 版本号。
Object.defineProperty(app, 'getAppPath', { configurable: true, value: () => ROOT });
Object.defineProperty(app, 'getVersion', { configurable: true, value: () => pkg.version });

/* ------------------------------------------------------------------ */
/* 断言框架                                                            */
/* ------------------------------------------------------------------ */

const TOTAL_TIMEOUT_MS = 90_000;
const logs = [];
const results = [];
let finished = false;

function log(line) {
  logs.push(line);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 单条断言：失败不中断，记录后继续 */
async function step(name, hint, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    log(`PASS  ${name}${detail ? `  —  ${detail}` : ''}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, message, hint });
    log(`FAIL  ${name}\n      实际：${message}${hint ? `\n      疑似根因：${hint}` : ''}`);
    return false;
  }
}

function finish(code) {
  if (finished) return;
  finished = true;

  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  log('');
  log('---------------------------------------------');
  if (bad.length === 0) {
    log(`ALL PASS (${ok}/${results.length})`);
  } else {
    log(`FAILED  ${bad.length}/${results.length}`);
    for (const f of bad) {
      log(`  - ${f.name}`);
      log(`    实际：${f.message}`);
      if (f.hint) log(`    疑似根因：${f.hint}`);
    }
  }
  log(`临时数据目录（保留取证）：${userData}`);
  log('---------------------------------------------');

  setTimeout(() => app.exit(code), 120);
}

function timeoutGuard() {
  setTimeout(() => {
    if (finished) return;
    log('');
    log(`!! 整体超时（${TOTAL_TIMEOUT_MS / 1000}s），已完成的断言如下，未执行项记为超时失败`);
    results.push({ name: '整体 90s 超时保护', ok: false, message: '未在 90s 内跑完', hint: '查看上一条 PASS 之后的步骤，通常是 IPC 未返回或窗口未加载' });
    finish(1);
  }, TOTAL_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ */
/* 窗口与渲染进程观测                                                  */
/* ------------------------------------------------------------------ */

let win = null;
const rendererErrors = [];

function watchWindow(w) {
  win = w;
  const wc = w.webContents;

  wc.on('preload-error', (_event, preloadPath, error) => {
    rendererErrors.push({ kind: 'preload-error', text: `${preloadPath}: ${error && error.message ? error.message : error}` });
    log(`!! preload 加载失败：${preloadPath}\n   ${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n   ') : String(error)}`);
  });

  wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    rendererErrors.push({ kind: 'did-fail-load', text: `${code} ${desc} ${url}` });
  });

  wc.on('render-process-gone', (_event, details) => {
    rendererErrors.push({ kind: 'render-process-gone', text: `${details.reason} exit=${details.exitCode}` });
  });

  wc.on('console-message', (event, level, message, line, sourceId) => {
    const lv = typeof level === 'number' ? level : event && event.level;
    if (typeof lv === 'number' && lv < 3) return; // 0=verbose 1=info 2=warning 3=error
    const text = String(message || '');
    rendererErrors.push({ kind: 'console', level: lv, text: `${text} (${sourceId}:${line})` });
  });

  wc.on('did-finish-load', () => log(`· 渲染进程加载完成：${wc.getURL()}`));
}

/** 等窗口出现（主进程 onReady 是异步的） */
async function waitForWindow(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const all = BrowserWindow.getAllWindows();
    if (all.length > 0) return all[0];
    await sleep(100);
  }
  throw new Error('主进程未在超时内创建任何 BrowserWindow（检查 dist-electron/main/index.js 是否启动）');
}

async function waitLoaded(w, ms = 30_000) {
  if (!w.webContents.isLoadingMainFrame() && w.webContents.getURL()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`窗口在 ${ms}ms 内没有 did-finish-load`));
    }, ms);
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e, code, desc, url, isMain) => {
      if (!isMain) return;
      cleanup();
      reject(new Error(`页面加载失败 ${code} ${desc} ${url}`));
    };
    function cleanup() {
      clearTimeout(timer);
      w.webContents.removeListener('did-finish-load', onLoad);
      w.webContents.removeListener('did-fail-load', onFail);
    }
    w.webContents.once('did-finish-load', onLoad);
    w.webContents.on('did-fail-load', onFail);
  });
}

/** 等 contextBridge 就绪 */
async function waitBridge(w, ms = 8_000) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    last = await js(w, 'typeof window.runworker');
    if (last === 'object') return;
    await sleep(150);
  }
  throw new Error(`window.runworker 未注入（typeof=${last}），检查 dist-electron/preload/index.js 与 webPreferences.preload`);
}

/** 在渲染进程执行代码（结果必须可序列化） */
async function js(w, code) {
  return w.webContents.executeJavaScript(code, true);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

app.on('browser-window-created', (_event, w) => {
  if (!win) watchWindow(w);
});

process.on('uncaughtException', (err) => {
  log(`!! harness 未捕获异常：${err && err.stack ? err.stack : err}`);
  results.push({ name: 'harness 未捕获异常', ok: false, message: String(err && err.message ? err.message : err) });
  finish(1);
});
process.on('unhandledRejection', (reason) => {
  log(`!! harness 未处理 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`);
});

async function main() {
  timeoutGuard();

  log(`· 项目根目录：${ROOT}`);
  log(`· 应用版本（模拟）：${pkg.version}`);
  log(`· 临时 userData：${userData}`);

  const preloadPath = path.join(ROOT, 'dist-electron', 'preload', 'index.js');
  const mainPath = path.join(ROOT, 'dist-electron', 'main', 'index.js');
  const htmlPath = path.join(ROOT, 'dist', 'renderer', 'index.html');
  log(`· 主进程：${fs.existsSync(mainPath) ? 'OK' : '缺失'} ${mainPath}`);
  log(`· 预加载：${fs.existsSync(preloadPath) ? 'OK' : '缺失'} ${preloadPath}`);
  log(`· 渲染产物：${fs.existsSync(htmlPath) ? 'OK' : '缺失（界面会显示「渲染进程尚未构建」，IPC 仍可测）'} ${htmlPath}`);

  // 1) 启动真实主进程
  require(mainPath);

  // 2) 等窗口 + 加载 + 桥接
  win = await waitForWindow(30_000);
  await waitLoaded(win);
  await waitBridge(win);

  /* ------------------------------ A. bootstrap ------------------------------ */
  let boot = null;
  await step('A1 window.runworker 存在且 bootstrap() 可返回', 'src/preload/index.ts / src/main/ipc.ts:104', async () => {
    const deadline = Date.now() + 3_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        boot = await js(win, 'window.runworker.bootstrap()');
        if (boot && Array.isArray(boot.agents)) return `keys=${Object.keys(boot).length}`;
      } catch (err) {
        lastErr = err;
      }
      await sleep(200);
    }
    throw new Error(lastErr ? lastErr.message : 'bootstrap() 1s 内未返回有效 BootstrapPayload');
  });

  if (boot) {
    await step('A2 agents.length === 8', 'src/shared/agents.ts（AGENTS 数量应为 8）', async () => {
      assert(boot.agents.length === 8, `期望 8，实际 ${boot.agents.length}（${boot.agents.map((a) => a.id).join(',')}）`);
      return boot.agents.map((a) => a.id).join(',');
    });

    await step('A3 settings.providers.length >= 2', 'src/shared/presets.ts:86 createDefaultSettings().providers', async () => {
      assert(Array.isArray(boot.settings.providers), 'providers 不是数组');
      assert(boot.settings.providers.length >= 2, `期望 >=2，实际 ${boot.settings.providers.length}`);
      return boot.settings.providers.map((p) => p.id).join(',');
    });

    await step("A4 app.version 与 package.json 一致", 'src/main/env.ts:75 createAppInfo / src/main/index.ts:67', async () => {
      assert(boot.app && boot.app.version === pkg.version, `期望 ${pkg.version}，实际 ${boot.app && boot.app.version}`);
      assert(typeof boot.app.electron === 'string' && boot.app.electron.length > 0, 'app.electron 为空');
      assert(typeof boot.app.userData === 'string' && boot.app.userData.length > 0, 'app.userData 为空');
      return `electron=${boot.app.electron} userData=${path.basename(boot.app.userData)}`;
    });

    await step('A5 app.env 含 RUN_WORKER_HOME 字段', 'src/main/env.ts:87 createAppInfo().env', async () => {
      assert(boot.app.env && Object.prototype.hasOwnProperty.call(boot.app.env, 'RUN_WORKER_HOME'), 'app.env.RUN_WORKER_HOME 字段缺失');
      assert(typeof boot.app.env.pathHasInstall === 'boolean', 'app.env.pathHasInstall 不是布尔值');
      return `RUN_WORKER_HOME=${boot.app.env.RUN_WORKER_HOME}`;
    });

    await step('A6 平台模块初始载荷齐全（mcp/tasks/knowledge/memory 均为数组）', 'src/main/ipc.ts:104 bootstrap / src/main/chat/context.ts', async () => {
      for (const key of ['mcp', 'tasks', 'knowledge', 'memory']) {
        assert(Array.isArray(boot[key]), `bootstrap().${key} 不是数组（实际 ${typeof boot[key]}）`);
      }
      assert('update' in boot, 'bootstrap().update 字段缺失');
      return `mcp=${boot.mcp.length} tasks=${boot.tasks.length} kb=${boot.knowledge.length} memory=${boot.memory.length}`;
    });

    await step('A7 界面标题栏版本号与 package.json 一致', 'src/renderer/components/TitleBar.tsx（版本号取自 app.getVersion()）', async () => {
      const chip = await js(
        win,
        `(() => {
           const el = document.querySelector('.version-chip');
           return el ? String(el.textContent || '').trim() : '';
         })()`,
      );
      assert(chip, '标题栏未渲染 .version-chip 版本标识');
      assert(chip === pkg.version, `标题栏版本号=${chip}，期望 ${pkg.version}`);
      return `titlebar version-chip=${chip}`;
    });
  }

  /* ------------------------------ B. 设置读写与持久化 ------------------------------ */
  await step('B1 settings.update 深合并并保留未传字段', 'src/main/store.ts:288 updateSettings / deepMerge', async () => {
    const before = await js(win, 'window.runworker.settings.get()');
    const returned = await js(win, 'window.runworker.settings.update({ appearance: { theme: "light" } })');
    const after = await js(win, 'window.runworker.settings.get()');
    assert(returned && returned.appearance.theme === 'light', `update 返回值 theme=${returned && returned.appearance && returned.appearance.theme}`);
    assert(after.appearance.theme === 'light', `get() 读到 theme=${after.appearance.theme}`);
    assert(after.persona.preset === before.persona.preset, `未传字段被破坏：persona.preset ${before.persona.preset} → ${after.persona.preset}`);
    assert(typeof after.appearance.accent === 'string' && after.appearance.accent.length > 0, 'appearance.accent 被清空');
    return `theme=${after.appearance.theme} persona=${after.persona.preset}`;
  });

  await step('B2 重载窗口后设置仍为 light（落盘持久化生效）', 'src/main/store.ts（settings.json 写盘）/ src/main/index.ts:116', async () => {
    win.webContents.reload();
    await sleep(300);
    await waitLoaded(win);
    await waitBridge(win);
    const reloaded = await js(win, 'window.runworker.settings.get()');
    assert(reloaded.appearance.theme === 'light', `重载后 theme=${reloaded.appearance.theme}（期望 light）`);
    return `theme=${reloaded.appearance.theme}`;
  });

  await step('B3 API Key 落盘为密文（safeStorage），内存态保持明文', 'src/main/store.ts setSecretsCodec / src/main/index.ts initSecretsCodec', async () => {
    const testKey = 'sk-e2e-encryption-check-001';
    // 给第一个服务商临时填一个 Key（providers 整体替换）
    const patched = await js(
      win,
      `window.runworker.settings.get().then((s) => {
         const providers = s.providers.map((p, i) => (i === 0 ? { ...p, apiKey: ${JSON.stringify(testKey)} } : p));
         return window.runworker.settings.update({ providers });
       })`,
    );
    assert(patched && Array.isArray(patched.providers), 'settings.update 未返回 providers');
    assert(patched.providers[0].apiKey === testKey, 'IPC 读回的 Key 应为明文（内存态无感知）');

    // 直接读盘验证：settings.json 里不得出现明文 Key
    const settingsFile = path.join(userData, 'settings.json');
    assert(fs.existsSync(settingsFile), `settings.json 不存在：${settingsFile}`);
    const raw = fs.readFileSync(settingsFile, 'utf8');
    assert(!raw.includes(testKey), '明文 Key 出现在 settings.json，加密存储未生效');
    assert(/enc:v1:/.test(raw), 'settings.json 中未发现 enc:v1: 密文前缀（safeStorage 未启用或未迁移）');

    // 清理：把 Key 还原为空，避免影响后续演示模式判定
    const restored = await js(
      win,
      `window.runworker.settings.get().then((s) => {
         const providers = s.providers.map((p, i) => (i === 0 ? { ...p, apiKey: '' } : p));
         return window.runworker.settings.update({ providers });
       })`,
    );
    assert(restored.providers[0].apiKey === '', '清理失败：Key 未还原为空');
    const rawAfter = fs.readFileSync(settingsFile, 'utf8');
    assert(!rawAfter.includes(testKey), '清理后明文 Key 仍残留');
    return '落盘=enc:v1:*，内存=明文，清理完成';
  });

  /* ------------------------------ C. 演示模式对话 ------------------------------ */
  async function collectRunEvents(runId, ms) {
    const deadline = Date.now() + ms;
    let events = [];
    while (Date.now() < deadline) {
      events = await js(win, 'window.__e2e ? window.__e2e.events : []');
      const end = events.find((e) => e.type === 'run:end' && e.runId === runId);
      if (end) return { events: events.filter((e) => e.runId === runId), end };
      await sleep(150);
    }
    return { events: events.filter((e) => e.runId === runId), end: null };
  }

  await step('C0 订阅 events.onRun 可收到事件（桥接回调通路）', 'src/preload/index.ts:105 onRun / src/main/chat/service.ts:249 emitRun', async () => {
    const ok = await js(
      win,
      `(() => {
        if (!window.__e2e) {
          window.__e2e = { events: [] };
          window.__e2e.off = window.runworker.events.onRun((e) => window.__e2e.events.push(e));
        }
        return typeof window.__e2e.off === 'function';
      })()`,
    );
    assert(ok === true, 'onRun 未返回取消订阅函数');
    return 'onRun 已订阅';
  });

  let run1 = null;
  let events1 = [];
  await step('C1 未配置 Key 时 chat.send 走演示模式并流式返回', 'src/main/chat/service.ts:342 演示模式分支 / chat/demo.ts', async () => {
    run1 = await js(win, 'window.runworker.chat.send({ text: "帮我整理下载文件夹" })');
    assert(run1 && run1.runId && run1.conversationId, `send() 返回值不完整：${JSON.stringify(run1)}`);
    const { events, end } = await collectRunEvents(run1.runId, 20_000);
    events1 = events;
    assert(end, `20s 内未收到 run:end，已收到事件：${events.map((e) => e.type).join(',') || '（无）'}`);
    assert(events.some((e) => e.type === 'run:start'), '缺少 run:start 事件');
    const thinking = events.filter((e) => e.type === 'run:thinking').map((e) => e.delta || '').join('');
    assert(thinking.length > 0, '缺少 run:thinking 事件（检查 settings.thinking.enabled 是否被关掉）');
    const compact = thinking.replace(/\s/g, '');
    const cjk = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
    const ratio = compact.length ? cjk / compact.length : 0;
    assert(ratio > 0.5, `思考内容中文占比 ${ratio.toFixed(2)} <= 0.5（长度 ${compact.length}）`);
    const content = events.filter((e) => e.type === 'run:content').map((e) => e.delta || '').join('');
    assert(content.length > 0, '缺少 run:content 事件');
    assert(end.status === 'done', `run:end.status=${end.status}（期望 done）`);
    return `事件 ${events.length} 条，思考 ${compact.length} 字（中文 ${(ratio * 100).toFixed(0)}%），正文 ${content.length} 字`;
  });

  await step('C2 会话落库：2 条消息且助手消息 thinking 非空', 'src/main/chat/service.ts:378 demoMsg / src/main/store.ts saveConversation', async () => {
    assert(run1, '上一步未拿到 runId，跳过');
    const conv = await js(win, `window.runworker.conversations.get(${JSON.stringify(run1.conversationId)})`);
    assert(conv, 'conversations.get 返回空（会话未落库）');
    assert(Array.isArray(conv.messages), 'messages 不是数组');
    assert(conv.messages.length === 2, `消息数 ${conv.messages.length}（期望 2：user + assistant）`);
    const assistant = conv.messages[conv.messages.length - 1];
    assert(assistant.role === 'assistant', `最后一条角色是 ${assistant.role}`);
    assert(typeof assistant.thinking === 'string' && assistant.thinking.trim().length > 0, '助手消息 thinking 为空（thinkingVisible 未生效）');
    assert(typeof assistant.content === 'string' && assistant.content.trim().length > 0, '助手消息 content 为空');
    return `messages=${conv.messages.length} title=${conv.title}`;
  });

  /* ------------------------------ C3~C7. 自动路由语义与 trace 三态 ------------------------------ */
  // C6/C7 验证 trace 三态（自动路由/路由判定/手动指定）：演示模式与真实路径同构，全部落 conv.trace。

  let route1 = null;

  async function sendAndCollect(text, conversationId, ms = 25_000) {
    const payload = conversationId ? { text, conversationId } : { text };
    const sent = await js(win, `window.runworker.chat.send(${JSON.stringify(payload)})`);
    assert(sent && sent.runId, `send() 未返回 runId：${JSON.stringify(sent)}`);
    const collected = await collectRunEvents(sent.runId, ms);
    assert(
      collected.end,
      `${ms}ms 内未收到 run:end，事件：${collected.events.map((e) => e.type).join(',') || '（无）'}`,
    );
    return { ...sent, events: collected.events, end: collected.end };
  }

  await step('C3 首轮自动路由：run:routing 从 orchestrator 指向 image', 'src/main/chat/service.ts:347-358 演示模式路由 / src/main/agents/orchestrator.ts KEYWORDS', async () => {
    const input = '帮我画一张猫的插画做封面';
    route1 = await sendAndCollect(input);
    const routing = route1.events.find((e) => e.type === 'run:routing');
    assert(
      routing,
      `未收到 run:routing。实际输入「${input}」，收到的事件类型：${[...new Set(route1.events.map((e) => e.type))].join(',')}`,
    );
    assert(routing.from === 'orchestrator', `routing.from=${routing.from}（期望 orchestrator）`);
    assert(routing.to === 'image', `实际路由到 ${routing.to}（期望 image），输入「${input}」`);
    // 注意：下面这个 reason 是演示分支（service.ts:358）的硬编码常量，不是 run:routing.reason 的通用取值。
    // 真实模型路径（service.ts:423）透传的是 decision.reason 或模型自由文案，不做归一，只能断「非空字符串」。
    // 断言如此写不构成契约：reason 语义是「给用户看的一句说明」，不是枚举。
    assert(routing.reason === '按任务关键词匹配', `routing.reason=${routing.reason}（期望「按任务关键词匹配」）`);
    return `orchestrator → ${routing.to}（${routing.reason}）`;
  });

  await step('C4 首轮结束后会话基线未被写回（agentId === orchestrator）', 'src/main/chat/service.ts:267 仅手动模式写 conv.agentId', async () => {
    assert(route1, 'C3 未成功执行，无法校验基线');
    const conv = await js(win, `window.runworker.conversations.get(${JSON.stringify(route1.conversationId)})`);
    assert(conv, 'conversations.get 返回空');
    assert(
      conv.agentId === 'orchestrator',
      `会话基线 agentId=${conv.agentId}（期望 orchestrator，说明自动路由把基线写回了子 Agent）`,
    );
    const assistant = conv.messages[conv.messages.length - 1];
    assert(assistant && assistant.role === 'assistant', '最后一条不是助手消息');
    assert(
      assistant.agentId === 'image',
      `助手消息 agentId=${assistant.agentId}（期望 image：路由只应决定本轮执行者）`,
    );
    return `基线=orchestrator，本轮执行者=${assistant.agentId}`;
  });

  await step('C5 同会话第二条可重新分派（to 变为 code），基线仍不变', 'src/main/chat/service.ts:347-358 每轮重新路由', async () => {
    assert(route1, 'C3 未成功执行，无法校验重新分派');
    const input = '帮我写个 python 脚本批量重命名文件';
    const route2 = await sendAndCollect(input, route1.conversationId);
    const routing = route2.events.find((e) => e.type === 'run:routing');
    assert(
      routing,
      `第二条未收到 run:routing。实际输入「${input}」，事件类型：${[...new Set(route2.events.map((e) => e.type))].join(',')}`,
    );
    assert(routing.to === 'code', `实际路由到 ${routing.to}（期望 code），输入「${input}」`);
    const conv = await js(win, `window.runworker.conversations.get(${JSON.stringify(route1.conversationId)})`);
    assert(conv, 'conversations.get 返回空');
    assert(conv.agentId === 'orchestrator', `第二轮后会话基线 agentId=${conv.agentId}（期望仍为 orchestrator）`);
    return `第二条 orchestrator → ${routing.to}，基线仍 orchestrator`;
  });

  await step('C6 演示模式 trace：自动路由与路由判定均落 conv.trace', 'src/main/chat/service.ts 演示分支 trace.push / conv.trace 落库', async () => {
    assert(route1, 'C3 未成功执行，无法校验 trace');
    // 「你好」不命中任何子 Agent 关键词 → 触发「路由判定」
    const keep = await sendAndCollect('你好', route1.conversationId);
    const conv = await js(win, `window.runworker.conversations.get(${JSON.stringify(route1.conversationId)})`);
    assert(conv, 'conversations.get 返回空');
    const actions = (conv.trace ?? []).map((t) => t.action);
    assert(
      actions.includes('自动路由'),
      `trace 中没有「自动路由」。已有 actions：${actions.join(',') || '（空）'}`,
    );
    assert(
      actions.includes('路由判定'),
      `「你好」未产生「路由判定」trace。已有 actions：${actions.join(',')}`,
    );
    const routed = (conv.trace ?? []).find((t) => t.action === '自动路由');
    assert(
      /orchestrator → \w+/.test(String(routed?.detail ?? '')),
      `自动路由 detail 格式异常：${routed && routed.detail}`,
    );
    return `trace actions：${[...new Set(actions)].join(' / ')}`;
  });

  await step('C7 手动指定 Agent 时 trace 记录「手动指定」并写会话基线', 'src/main/chat/service.ts manual 分支 / conv.agentId 写回', async () => {
    // 用全新会话显式指定 agentId=image
    const sent = await js(win, 'window.runworker.chat.send({ text: "帮我画一张海报", agentId: "image" })');
    assert(sent && sent.runId, 'send() 未返回 runId');
    await collectRunEvents(sent.runId, 25_000);
    const conv = await js(win, `window.runworker.conversations.get(${JSON.stringify(sent.conversationId)})`);
    assert(conv, 'conversations.get 返回空');
    const actions = (conv.trace ?? []).map((t) => t.action);
    assert(actions.includes('手动指定'), `trace 中没有「手动指定」。已有 actions：${actions.join(',') || '（空）'}`);
    assert(conv.agentId === 'image', `手动模式应写会话基线 agentId=${conv.agentId}（期望 image）`);
    const stepManual = (conv.trace ?? []).find((t) => t.action === '手动指定');
    assert(stepManual.agentId === 'image', `手动指定 trace 的 agentId=${stepManual.agentId}（期望 image）`);
    return `trace 记录「手动指定」，基线=${conv.agentId}`;
  });

  /* ------------------------------ D. 中断 ------------------------------ */
  await step('D1 chat.abort(runId) 能中断并回 run:end=aborted', 'src/main/chat/service.ts:97 abort / chat/demo.ts:104 signal 检查', async () => {
    const run2 = await js(win, 'window.runworker.chat.send({ text: "帮我整理下载文件夹" })');
    assert(run2 && run2.runId, 'send() 未返回 runId');
    await sleep(300);
    await js(win, `window.runworker.chat.abort(${JSON.stringify(run2.runId)})`);
    const { end, events } = await collectRunEvents(run2.runId, 15_000);
    assert(end, `abort 后 15s 内未收到 run:end，事件：${events.map((e) => e.type).join(',') || '（无）'}`);
    assert(end.status === 'aborted', `run:end.status=${end.status}（期望 aborted）`);
    return `status=${end.status}`;
  });

  /* ------------------------------ E. 知识库 ------------------------------ */
  let kbDir = '';
  await step('E1 knowledge.addSource + reindex 产出分块', 'src/main/platform/knowledge.ts / src/main/ipc.ts kbAddSource', async () => {
    kbDir = path.join(userData, 'e2e-kb');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, 'quantum.md'),
      '# 量子纠缠笔记\n\n量子纠缠是量子力学中的非定域关联现象。测量一个粒子会瞬间影响另一个粒子的状态，这一现象被用于量子通信与量子密钥分发。\n\n## 应用\n\n量子纠缠是量子计算与量子隐形传态的基础资源。\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(kbDir, 'retrieval.md'),
      '# 检索测试文档\n\n本文用于验证本地知识库检索：关键词「量子纠缠」应当命中，中文二gram 分词与 BM25 排序都应生效。\n',
      'utf8',
    );

    const sources = await js(win, `window.runworker.knowledge.addSource(${JSON.stringify(kbDir)}, false)`);
    assert(Array.isArray(sources) && sources.length === 1, `addSource 返回 ${sources && sources.length} 个源（期望 1）`);

    const stats = await js(win, 'window.runworker.knowledge.reindex()');
    assert(stats && typeof stats.chunks === 'number', 'reindex 未返回 KnowledgeStats');
    assert(stats.chunks > 0, `chunks=${stats.chunks}（期望 >0，检查分块/扩展名过滤）`);
    assert(stats.documents >= 2, `documents=${stats.documents}（期望 >=2）`);
    return `documents=${stats.documents} chunks=${stats.chunks}`;
  });

  await step("E2 knowledge.search('量子纠缠') 有命中且带片段", 'src/main/platform/knowledge.ts BM25 / ipc kbSearch', async () => {
    const hits = await js(win, `window.runworker.knowledge.search(${JSON.stringify('量子纠缠')}, 5)`);
    assert(Array.isArray(hits), 'search 未返回数组');
    assert(hits.length > 0, '检索无命中（BM25/分词异常）');
    const h = hits[0];
    assert(typeof h.snippet === 'string' && h.snippet.length > 0, '命中缺少 snippet');
    assert(typeof h.score === 'number' && h.score > 0, `score=${h.score}`);
    assert(typeof h.path === 'string' && h.path.length > 0, '命中缺少 path');
    return `${hits.length} 条，首条 score=${h.score.toFixed(3)}`;
  });

  /* ------------------------------ F. 定时任务 ------------------------------ */
  const taskId = 'e2e-task-cron';
  await step('F1 tasks.save 计算未来 nextRunAt 且小时为 9', 'src/main/platform/scheduler.ts computeNextRun / ipc taskSave', async () => {
    const task = {
      id: taskId,
      name: 'E2E 每日早报',
      prompt: '生成今日早报',
      agentId: 'orchestrator',
      kind: 'cron',
      cron: '0 9 * * *',
      enabled: true,
      createdAt: Date.now(),
      indexResult: false,
    };
    const list = await js(win, `window.runworker.tasks.save(${JSON.stringify(task)})`);
    assert(Array.isArray(list), 'tasks.save 未返回数组');
    const saved = list.find((t) => t.id === taskId);
    assert(saved, '保存后 tasks 列表里找不到该任务');
    assert(typeof saved.nextRunAt === 'number', `nextRunAt 缺失（${saved.nextRunAt}）`);
    assert(saved.nextRunAt > Date.now(), `nextRunAt=${new Date(saved.nextRunAt).toISOString()} 不在未来`);
    const hour = new Date(saved.nextRunAt).getHours();
    assert(hour === 9, `nextRunAt 小时=${hour}（期望 9）`);
    return new Date(saved.nextRunAt).toLocaleString('zh-CN');
  });

  await step('F2 tasks.remove 后任务消失', 'src/main/platform/scheduler.ts remove / ipc taskRemove', async () => {
    await js(win, `window.runworker.tasks.remove(${JSON.stringify(taskId)})`);
    const list = await js(win, 'window.runworker.tasks.list()');
    assert(!list.some((t) => t.id === taskId), '删除后任务仍在列表中');
    return `剩余 ${list.length} 个任务`;
  });

  /* ------------------------------ F3. 立即执行 ------------------------------ */
  const runTaskId = 'e2e-task-run-now';
  await step('F3 tasks.run 立即执行成功并落一条历史（不走 30s ticker）', 'src/main/platform/scheduler.ts:438 runNow / ipc taskRun', async () => {
    const task = {
      id: runTaskId,
      name: 'E2E 立即执行',
      prompt: '用一句话总结今天要做的三件事',
      agentId: 'orchestrator',
      kind: 'cron',
      cron: '0 9 * * *',
      enabled: true,
      createdAt: Date.now(),
      indexResult: false,
    };
    await js(win, `window.runworker.tasks.save(${JSON.stringify(task)})`);

    const before = (await js(win, 'window.runworker.tasks.history()')).length;

    // runNow 直接调 runner.run()，与「到点自动触发」无关；演示模式下 1~3s 完成。
    // 超时用页面内 Promise.race 兜，避免 executeJavaScript 无限挂起。
    const run = await js(
      win,
      `Promise.race([
        window.runworker.tasks.run(${JSON.stringify(runTaskId)}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('tasks.run 15s 未返回')), 15000)),
      ])`,
    );
    assert(run && typeof run === 'object', `tasks.run 返回值不是对象：${run}`);
    assert(
      run.status === 'success',
      `run.status=${run.status}${run.error ? `，error=${run.error}` : ''}（期望 success）`,
    );
    assert(run.taskId === runTaskId, `run.taskId=${run.taskId}（期望 ${runTaskId}）`);
    assert(
      typeof run.startedAt === 'number' && typeof run.endedAt === 'number' && run.endedAt >= run.startedAt,
      `时间戳异常：startedAt=${run.startedAt} endedAt=${run.endedAt}`,
    );

    const history = await js(win, 'window.runworker.tasks.history()');
    assert(
      history.length === before + 1,
      `history 条数 ${history.length}（期望 ${before + 1}，before=${before}）`,
    );
    assert(history[0].taskId === runTaskId, `history[0].taskId=${history[0].taskId}（期望最新一条是本次执行）`);

    const saved = (await js(win, 'window.runworker.tasks.list()')).find((t) => t.id === runTaskId);
    assert(saved, '执行后 tasks.list() 里找不到该任务');
    assert(
      saved.lastStatus === 'success',
      `task.lastStatus=${saved.lastStatus}（期望 success）`,
    );

    // 收尾：删掉本任务，保持与 F2 一致的「无残留」状态
    await js(win, `window.runworker.tasks.remove(${JSON.stringify(runTaskId)})`);

    const ms = run.endedAt - run.startedAt;
    return `status=success，history ${before} → ${history.length}，lastStatus=success，耗时 ${ms}ms`;
  });

  /* ------------------------------ F4. ticker 补跑 ------------------------------ */
  // 任务在文件顶部（require 主进程之前）预置进 <userData>/tasks/tasks.json：
  // once、runAt 已过期、从未执行 → 启动校准应保留该 nextRunAt，start() 后 3 秒的首次 tick 补跑。
  await step('F4 调度器 ticker 补跑已到期的预置任务并落历史', 'tests/e2e/harness.cjs 顶部预置 / src/main/platform/scheduler.ts tick + 启动校准', async () => {
    const history = await js(win, 'window.runworker.tasks.history()');
    const run = history.find((r) => r.taskId === 'e2e-task-ticker');
    assert(run, `history 中没有 e2e-task-ticker 的执行记录（共 ${history.length} 条，来源应是文件顶部预置任务 + 首次 tick）`);
    assert(
      run.status === 'success',
      `run.status=${run.status}${run.error ? `，error=${run.error}` : ''}（期望 success）`,
    );
    const task = (await js(win, 'window.runworker.tasks.list()')).find((t) => t.id === 'e2e-task-ticker');
    assert(task, '任务应在列表中');
    assert(task.enabled === false, `once 任务执行后 enabled=${task.enabled}（期望 false）`);
    assert(typeof task.lastRunAt === 'number', 'lastRunAt 未写入');
    return `status=success，enabled=false，lastRunAt=${new Date(task.lastRunAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  });

  /* ------------------------------ F5. cron 跨月顺延提示 ------------------------------ */
  // 验证 0.0.3 新增的 nextNote：日字段在当月不存在时顺延到下月并给出提示文案。
  await step('F5 cron 日字段跨月顺延时给出 nextNote 提示', 'src/main/platform/scheduler.ts computeNextRun', async () => {
    const now = new Date();
    const maxDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // 当月不足 31 天时，用 31 号必然跨月且当月不存在；否则退化为一致性检查（不依赖具体月份）
    const crossMonth = maxDay < 31;
    const day = crossMonth ? 31 : now.getDate();
    const cron = `0 9 ${day} * *`;
    const f5id = 'e2e-task-nextnote';
    const task = {
      id: f5id,
      name: 'E2E 跨月提示',
      prompt: 'hi',
      agentId: 'orchestrator',
      kind: 'cron',
      cron,
      enabled: true,
      createdAt: Date.now(),
      indexResult: false,
    };
    await js(win, `window.runworker.tasks.save(${JSON.stringify(task)})`);
    const saved = (await js(win, 'window.runworker.tasks.list()')).find((t) => t.id === f5id);
    assert(saved, 'tasks.list() 找不到刚保存的任务');
    assert(typeof saved.nextNote === 'string' || saved.nextNote === undefined, 'nextNote 字段类型异常');
    if (crossMonth) {
      assert(saved.nextNote && saved.nextNote.includes('顺延'), `跨月应给出顺延提示，实际：${saved.nextNote}`);
      assert(saved.nextNote.includes(String(day)), `nextNote 应提及日期 ${day}`);
    }
    await js(win, `window.runworker.tasks.remove(${JSON.stringify(f5id)})`);
    return crossMonth
      ? `nextNote=${JSON.stringify(saved.nextNote)}`
      : `当月有 ${day} 号，nextNote=${saved.nextNote ?? 'undefined'}（一致性检查）`;
  });

  /* ------------------------------ G. 更新检测 ------------------------------ */
  await step('G1 update.check(true) 返回结构完整的 UpdateInfo（离线也算通过）', 'src/main/platform/updater.ts check / ipc updateCheck', async () => {
    const info = await js(win, 'window.runworker.update.check(true)');
    assert(info && typeof info === 'object', `返回值不是对象：${info}`);
    assert(typeof info.available === 'boolean', 'available 不是布尔值');
    assert(typeof info.currentVersion === 'string' && info.currentVersion.length > 0, 'currentVersion 缺失');
    assert(typeof info.latestVersion === 'string', 'latestVersion 缺失');
    assert(typeof info.checkedAt === 'number', 'checkedAt 缺失');

    // 在线模式（仓库已公开时用）：只要求「检测链路通」，不要求真有新版本
    if (process.env.RUNWORKER_E2E_ONLINE === '1') {
      const benign = !info.error || /暂无发布版本|暂无正式版本可用/.test(info.error);
      assert(benign, `在线模式要求 error 为空或「无可用版本」，实际：${info.error}`);
      return `在线模式通过：available=${info.available}${info.error ? `，error=${info.error}` : ''}`;
    }

    if (!info.available) {
      // 合法状态一：更新源可达且无需更新（当前已是最新，或当前版本比远端最新 Release 还新——例如开发版领先于已发布版本）
      if (!info.error) {
        return `更新源可达，无可用更新：latest=${info.latestVersion}，current=${info.currentVersion}`;
      }
      // 合法状态二：离线/无发布 → 必须给中文 error
      assert(typeof info.error === 'string' && /[\u4e00-\u9fff]/.test(info.error), `离线时的 error 不是中文：${info.error}`);
      return `available=false，error=${info.error.slice(0, 40)}`;
    }
    return `available=true，latest=${info.latestVersion}`;
  });

  /* ------------------------------ H. 渲染进程健康 ------------------------------ */
  await step('H1 无渲染崩溃 / 加载失败 / 非 CSP 的控制台错误', 'dist/renderer 控制台输出 / preload 注入', async () => {
    const fatal = rendererErrors.filter((e) => e.kind === 'preload-error' || e.kind === 'render-process-gone' || e.kind === 'did-fail-load');
    assert(fatal.length === 0, `致命错误：${fatal.map((e) => `[${e.kind}] ${e.text}`).join(' | ')}`);

    const cspLike = /content security policy|content-security-policy|\bCSP\b|Electron Security Warning|devtools/i;
    const consoleErrors = rendererErrors.filter((e) => e.kind === 'console' && !cspLike.test(e.text));
    assert(
      consoleErrors.length === 0,
      `${consoleErrors.length} 条控制台错误：${consoleErrors.slice(0, 5).map((e) => e.text).join(' | ')}`,
    );
    return `阈值内无异常（已忽略 ${rendererErrors.length - consoleErrors.length} 条 CSP/安全提示）`;
  });

  // 自检开关：验证「失败报告格式 + 退出码 1」这条路径本身是可用的
  if (process.env.RUNWORKER_E2E_FAIL_PROBE === '1') {
    await step('Z0 自检：故意失败的断言（验证失败报告格式）', 'tests/e2e/harness.cjs（仅 RUNWORKER_E2E_FAIL_PROBE=1 时出现）', async () => {
      throw new Error('这是 FAIL_PROBE 注入的假失败，用于验证 FAIL 输出与退出码，不是真实缺陷');
    });
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

main()
  .catch((err) => {
    log(`!! 主流程异常：${err && err.stack ? err.stack : err}`);
    results.push({ name: 'harness 主流程', ok: false, message: String(err && err.message ? err.message : err) });
    finish(1);
  })
  .then(() => {
    const failed = results.some((r) => !r.ok);
    finish(failed ? 1 : 0);
  });

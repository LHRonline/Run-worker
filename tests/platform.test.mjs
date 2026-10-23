/**
 * Run worker — 平台模块集成测试（直接跑编译产物，验证真实行为而非接口存在）
 * 运行：npm run build:main && node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');

const { createDefaultSettings } = require(path.join(DIST, 'shared/presets.js'));
const { createPermissionGuard } = require(path.join(DIST, 'main/platform/permissions.js'));
const { createMemoryStore } = require(path.join(DIST, 'main/platform/memory.js'));
const { createKnowledgeBase } = require(path.join(DIST, 'main/platform/knowledge.js'));
const { createScheduler } = require(path.join(DIST, 'main/platform/scheduler.js'));
const { createUpdater } = require(path.join(DIST, 'main/platform/updater.js'));

function makeDeps(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-test-'));
  let settings = { ...createDefaultSettings(), ...overrides };
  const deps = {
    dataDir: dir,
    settings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    emit: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  return { deps, dir, getSettings: () => settings };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- 命令安全 ----------------------------- */

test('权限守卫：常规命令放行，危险命令拦截', () => {
  const { deps } = makeDeps();
  const guard = createPermissionGuard(deps.settings);

  const safe = guard.inspectCommand('dir');
  assert.equal(safe.risk, 'low');
  assert.equal(safe.requiresApproval, false);

  const risky = guard.inspectCommand('Remove-Item -Recurse -Force C:\\temp');
  assert.equal(risky.risk, 'high');
  assert.equal(risky.requiresApproval, true);

  const denied = guard.inspectCommand('shutdown /s /t 0');
  assert.equal(denied.allowed, false);

  // 大小写与多余空格不应绕过
  const sneaky = guard.inspectCommand('  SHUTDOWN   /s  ');
  assert.equal(sneaky.allowed, false);
});

test('权限守卫：safe-only 模式下中风险命令需要确认', () => {
  const { deps } = makeDeps();
  deps.settings().agent.approvalMode = 'safe-only';
  const guard = createPermissionGuard(deps.settings);
  const verdict = guard.inspectCommand('npm install left-pad');
  assert.equal(verdict.requiresApproval, true);
});

/* ----------------------------- 长期记忆 ----------------------------- */

test('长期记忆：去重合并、摘要、删除', () => {
  const { deps } = makeDeps();
  const memory = createMemoryStore(deps);

  memory.add({ text: '用户偏好：回答直接给结论', kind: 'preference', weight: 0.9 });
  memory.add({ text: '用户偏好：回答直接给结论。', kind: 'preference' });
  const list = memory.list();
  assert.equal(list.length, 1, '近似重复的记忆应合并而不是新增');
  assert.ok(list[0].weight >= 0.9);

  memory.add({ text: '项目使用 Electron 33 + React 19', kind: 'project' });
  const digest = memory.digest(200);
  assert.match(digest, /偏好/);
  assert.match(digest, /Electron/);

  const removed = memory.forget(list[0].id);
  assert.equal(removed.length, 1);
  memory.clear();
  assert.equal(memory.list().length, 0);
});

/* ------------------------------ 知识库 ------------------------------ */

test('知识库：索引本地文件并支持中文检索', async () => {
  const { deps, dir } = makeDeps();
  const docsDir = path.join(dir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    path.join(docsDir, 'install.md'),
    '# 安装说明\n\nRun worker 支持自定义安装目录，安装器会写入 RUN_WORKER_HOME 环境变量。\n\n开始菜单会创建快捷方式。',
    'utf8',
  );
  writeFileSync(
    path.join(docsDir, 'faq.md'),
    '# 常见问题\n\n没有 API Key 时可以进入演示模式，或者使用 Ollama 本地模型。',
    'utf8',
  );

  const kb = createKnowledgeBase(deps);
  await kb.init();
  const sources = await kb.addSource(docsDir, false);
  assert.equal(sources.length, 1);

  await kb.reindex();
  const stats = kb.stats();
  assert.ok(stats.chunks >= 2, `应至少切出 2 个分块，实际 ${stats.chunks}`);
  assert.equal(stats.documents, 2);

  const hits = await kb.search('自定义安装目录', 3);
  assert.ok(hits.length > 0, '中文检索应命中');
  assert.match(hits[0].snippet + hits[0].title, /安装|RUN_WORKER_HOME/);

  const ctx = await kb.contextFor('本地模型', 2);
  assert.ok(ctx.text.length > 0);
  assert.ok(ctx.citations.length > 0);
});

/* ----------------------------- 定时任务 ----------------------------- */

test('定时任务：cron 下次执行时间计算正确', async () => {
  const { deps } = makeDeps();
  let called = 0;
  const scheduler = createScheduler({
    ...deps,
    runner: {
      async run() {
        called += 1;
        return { text: 'ok', conversationId: 'c1' };
      },
    },
  });

  const base = {
    id: 't1',
    name: '每日简报',
    prompt: '总结今天的任务',
    agentId: 'orchestrator',
    enabled: true,
    createdAt: Date.now(),
    indexResult: false,
  };

  const tasks = scheduler.save({ ...base, kind: 'cron', cron: '0 9 * * *' });
  const task = tasks.find((t) => t.id === 't1');
  assert.ok(task);
  assert.ok(task.nextRunAt > Date.now(), '下次执行时间应在未来');
  const delta = task.nextRunAt - Date.now();
  assert.ok(delta <= 24 * 3600 * 1000 + 60_000, '每天 9 点应在 24 小时内');
  const next = new Date(task.nextRunAt);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getSeconds(), 0);

  // 每 30 分钟一次
  const intervalTasks = scheduler.save({ ...base, id: 't2', kind: 'interval', intervalMinutes: 30 });
  const t2 = intervalTasks.find((t) => t.id === 't2');
  assert.ok(t2.nextRunAt - Date.now() <= 30 * 60 * 1000 + 5000);

  const run = await scheduler.runNow('t1');
  assert.equal(run.status, 'success');
  assert.equal(called, 1);
  assert.equal(scheduler.history().length, 1);
});

test('定时任务：非法 cron 不应崩溃', () => {
  const { deps } = makeDeps();
  const scheduler = createScheduler({ ...deps, runner: { async run() { return { text: '', conversationId: '' }; } } });
  assert.doesNotThrow(() => {
    scheduler.save({
      id: 'bad',
      name: '坏的',
      prompt: 'x',
      agentId: 'orchestrator',
      kind: 'cron',
      cron: 'not a cron',
      enabled: false,
      createdAt: Date.now(),
      indexResult: false,
    });
  });
});

/* ------------------------------ 更新检测 ----------------------------- */

test('更新检测：语义化版本比较与可用性判断', async () => {
  const { deps } = makeDeps();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '0.0.10', notes: '修复若干问题', url: 'https://example.com/dl' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const updater = createUpdater({ ...deps, appVersion: '0.0.9', repoUrl: 'LHRonline/run-worker' });
  deps.saveSettings({ update: { ...deps.settings().update, feed: `http://127.0.0.1:${port}/latest.json` } });
  const info = await updater.check(true);
  server.close();

  assert.equal(info.latestVersion, '0.0.10');
  assert.equal(info.available, true, '0.0.10 应大于 0.0.9');
  assert.equal(info.downloadUrl, 'https://example.com/dl');
});

test('更新检测：网络失败返回中文错误而不是抛异常', async () => {
  const { deps } = makeDeps();
  const updater = createUpdater({ ...deps, appVersion: '0.0.1', repoUrl: 'LHRonline/run-worker' });
  deps.saveSettings({ update: { ...deps.settings().update, feed: 'http://127.0.0.1:1/latest.json' } });
  const info = await updater.check(true);
  assert.equal(info.available, false);
  assert.ok(typeof info.error === 'string' && info.error.length > 0);
});

/* -------------------------------- MCP -------------------------------- */

test('MCP：stdio 服务器连接、工具发现与调用', async () => {
  const { deps, dir } = makeDeps();
  const { createMcpManager } = require(path.join(DIST, 'main/platform/mcp.js'));

  const serverPath = path.join(dir, 'fake-mcp.mjs');
  writeFileSync(
    serverPath,
    `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
    else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.text ?? '') }] } });
    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`,
    'utf8',
  );

  const manager = createMcpManager(deps);
  await manager.add({
    id: 'fake',
    name: '假服务器',
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    enabled: true,
    autoStart: true,
  });
  await manager.init();

  const statuses = manager.statuses();
  const st = statuses.find((s) => s.id === 'fake');
  assert.ok(st, '服务器应出现在状态列表');
  assert.equal(st.state, 'ready', `状态应为 ready，实际 ${st.state} / ${st.message ?? ''}`);

  const tools = manager.tools();
  assert.ok(tools.some((t) => t.name === 'echo'), '应发现 echo 工具');

  const result = await manager.call('fake', 'echo', { text: '你好' });
  assert.equal(result.ok, true);
  assert.match(result.content, /echo:你好/);

  await manager.shutdown();
});

/* ------------------------------ 设置持久化 ----------------------------- */

test('设置存储：深合并、对话增删改查与导出', () => {
  const { Store } = require(path.join(DIST, 'main/store.js'));
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-store-'));
  const store = new Store(dir);

  const patch = store.updateSettings({ appearance: { theme: 'light' } });
  assert.equal(patch.appearance.theme, 'light');
  assert.equal(patch.appearance.zoom, 1, '未提供的字段应保留默认值');
  assert.equal(patch.persona.preset, 'direct');

  const conv = store.createConversation('测试对话');
  store.saveConversation({ ...conv, messages: [{ id: 'm1', role: 'user', content: '你好', createdAt: Date.now() }] });
  assert.equal(store.getConversation(conv.id).messages.length, 1);

  store.renameConversation(conv.id, '改名了');
  assert.equal(store.listConversations().find((c) => c.id === conv.id).title, '改名了');

  const md = store.exportMarkdown(conv.id);
  assert.match(md, /测试对话|改名了/);
  assert.match(md, /你好/);

  store.deleteConversation(conv.id);
  assert.equal(store.listConversations().length, 0);

  rmSync(dir, { recursive: true, force: true });
});

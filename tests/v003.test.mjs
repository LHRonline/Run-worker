/**
 * Run worker — v0.0.3 稳定性修复回归测试
 * 覆盖：cron 跨月顺延、会话索引孤儿清理、LLM 错误渠道标注、模型列表兼容、
 *       python 路径规范化、对话异常必补 run:end。
 * 运行：npm run build:main && node --test tests/v003.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');

/* ------------------------- 定时任务：跨月顺延 ------------------------- */

test('定时任务：cron 日字段当月不存在时顺延到下月并给出 nextNote', () => {
  const { computeNextRun } = require(path.join(DIST, 'main/platform/scheduler.js'));
  // 2026-11（30 天）里设定「每月 31 号」→ 应顺延到 12 月 31 日
  const from = new Date(2026, 10, 12, 8, 0, 0).getTime(); // 月份 0 基：10 = 11 月
  const task = { id: 't1', kind: 'cron', cron: '0 9 31 * *', enabled: true };
  const next = computeNextRun(task, from);
  assert.ok(next, '应算出下一次执行时间');
  const d = new Date(next);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 11, '应顺延到 12 月');
  assert.equal(d.getDate(), 31);
  assert.ok(task.nextNote && task.nextNote.includes('31'), 'nextNote 应提及日期 31');
  assert.ok(task.nextNote.includes('顺延'), 'nextNote 应含顺延字样');

  // 当月存在的日期（15 号）→ 不触发顺延提示
  const t2 = { id: 't2', kind: 'cron', cron: '0 9 15 * *', enabled: true };
  computeNextRun(t2, from);
  assert.equal(t2.nextNote, undefined, '当月存在的日期不应有顺延提示');

  // 非 cron 任务重算时 nextNote 应被清空，避免残留
  const t3 = { id: 't3', kind: 'interval', intervalMinutes: 30, enabled: true, nextNote: '旧提示' };
  computeNextRun(t3, from);
  assert.equal(t3.nextNote, undefined, 'interval 重算应清除残留 nextNote');
});

/* ------------------------- 会话索引：孤儿清理 ------------------------- */

test('设置存储：loadIndex 剔除指向缺失文件的孤儿会话', () => {
  const { Store } = require(path.join(DIST, 'main/store.js'));
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-orphan-'));
  const store = new Store(dir);
  const conv = store.createConversation('正常对话');
  store.saveConversation({ ...conv, messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: Date.now() }] });
  assert.equal(store.listConversations().length, 1, '初始应有 1 个会话');

  // 模拟异常退出：会话文件被删，但 index.json 还保留着该条目
  const fs = require('node:fs');
  fs.unlinkSync(path.join(dir, 'conversations', `${conv.id}.json`));

  // 重新载入（等价重启）→ 孤儿条目应被剔除
  const store2 = new Store(dir);
  assert.equal(store2.listConversations().length, 0, '孤儿索引应被剔除');

  rmSync(dir, { recursive: true, force: true });
});

/* --------------------------- LLM 错误提示 --------------------------- */

test('LLM 错误提示：429 频率限制带渠道名标注', () => {
  const { friendlyStatus } = require(path.join(DIST, 'main/llm/client.js'));
  const withLabel = friendlyStatus(429, '', 'DeepSeek');
  assert.match(withLabel.message, /触发频率限制（429）/);
  assert.match(withLabel.message, /渠道：DeepSeek/);

  const noLabel = friendlyStatus(429, '', undefined);
  assert.ok(!noLabel.message.includes('渠道：'), '无渠道名时不出现「渠道：」');

  // 其他状态码保持原有文案
  assert.match(friendlyStatus(401, '').message, /API Key/);
  assert.match(friendlyStatus(404, '').message, /模型名|Base URL/);
});

test('LLM 网络错误：ollama 渠道给出本地启动提示', () => {
  const { wrapError } = require(path.join(DIST, 'main/llm/client.js'));
  const ollama = wrapError(new Error('fetch failed ENOTFOUND localhost'), false, undefined, 'ollama');
  assert.match(ollama.message, /ollama serve/, 'ollama 渠道应提示先运行 ollama serve');

  const other = wrapError(new Error('fetch failed ECONNREFUSED'), false, undefined, 'openai-compatible');
  assert.ok(!other.message.includes('ollama serve'), '非 ollama 渠道不应出现本地启动提示');
});

/* --------------------------- 模型列表兼容 --------------------------- */

test('listModels：兼容只有 name 无 id 的模型条目，并排序', async () => {
  const { listModels } = require(path.join(DIST, 'main/llm/client.js'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { name: 'gpt-4o-mini' },
      { name: 'claude-3-opus' },
      { id: 'custom-id-1' },
    ] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const models = await listModels({ kind: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'x' });
  server.close();
  assert.deepEqual(models, ['claude-3-opus', 'custom-id-1', 'gpt-4o-mini'], 'm.id ?? m.name 取值且按字母排序');
});

test('listModels：服务端异常时回退到预设模型列表', async () => {
  const { listModels } = require(path.join(DIST, 'main/llm/client.js'));
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const models = await listModels({ kind: 'deepseek', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'x' });
  server.close();
  assert.deepEqual(models, ['deepseek-chat', 'deepseek-reasoner'], '500 应回退 deepseek 预设');
});

/* ------------------------ python 路径规范化 ------------------------ */

test('python.exec：含空格的可执行路径会被引号包裹', () => {
  const { safeExe } = require(path.join(DIST, 'main/tools/python.js'));
  if (process.platform !== 'win32') return; // 引号逻辑仅在 Windows 生效
  assert.equal(safeExe('python'), 'python');
  assert.equal(safeExe('  python3  '), 'python3', '应 trim 前后空格');
  assert.equal(
    safeExe('C:\\Program Files\\Python39\\python.exe'),
    '"C:\\Program Files\\Python39\\python.exe"',
    '含空格路径应被引号包裹',
  );
  assert.equal(safeExe('"C:\\x y\\py.exe"'), '"C:\\x y\\py.exe"', '已带引号不应重复包裹');
});

/* ------------------- 对话服务：异常必补 run:end ------------------- */

test('对话服务：execute 运行期异常时必补发 run:end，界面不会卡运行中', async () => {
  const { createContext } = require(path.join(DIST, 'main/chat/context.js'));
  const { EVT } = require(path.join(DIST, 'shared/ipc.js'));
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-svc-'));
  const events = [];
  const ctx = createContext({
    dataDir: dir,
    appInfo: { version: '0.0.3', repoUrl: 'LHRonline/run-worker' },
    emit: (channel, payload) => events.push({ channel, payload }),
  });

  // 让 saveConversation 在会话已有消息（运行期）时抛错，模拟运行期崩溃
  const origSave = ctx.store.saveConversation.bind(ctx.store);
  ctx.store.saveConversation = (conv) => {
    if (conv && Array.isArray(conv.messages) && conv.messages.length >= 1) {
      throw new Error('模拟运行期异常');
    }
    return origSave(conv);
  };

  const result = await ctx.chat.runForScheduler('你好', { title: '异常用例' });
  const endEvents = events.filter((e) => e.channel === EVT.run && e.payload && e.payload.type === 'run:end');
  assert.ok(endEvents.length >= 1, '异常时应至少补发一次 run:end');
  assert.equal(endEvents[endEvents.length - 1].payload.status, 'error', '异常时 run:end 状态应为 error');
  assert.equal(result.text, '', '致命异常应安全回退为空文本');

  rmSync(dir, { recursive: true, force: true });
});

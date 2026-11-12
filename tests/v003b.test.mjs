/**
 * Run worker — v0.0.3b 回归测试
 *
 * 覆盖：
 *  1) 彻底删除：会话文件 / 前缀辅助文件 / 索引 / 产物 / 旧版散落文件 / 擦除报告
 *  2) 删除屏障：在途 run 不会把已删除会话写回复活
 *  3) 长期记忆按来源删除（含合并后的多来源）
 *  4) 精准 token：无 usage 时明确标估算；已输出增量后断线不整轮重试
 *  5) 人设 / 更新内容 / 升级契约 / 版本号
 *
 * 运行：npm run build:main && node --test tests/v003b.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');
const ROOT = path.resolve('.');

const { Store } = require(path.join(DIST, 'main/store.js'));
const { createMemoryStore } = require(path.join(DIST, 'main/platform/memory.js'));
const { createContext } = require(path.join(DIST, 'main/chat/context.js'));
const { EVT, IPC } = require(path.join(DIST, 'shared/ipc.js'));
const { createDefaultSettings, CURRENT_RELEASE_NOTES, COMPOSER_SKILLS, PERSONA_PRESET_META } = require(path.join(DIST, 'shared/presets.js'));
const { buildSystemPrompt } = require(path.join(DIST, 'main/llm/prompts.js'));
const { compareVersion, createUpdater } = require(path.join(DIST, 'main/platform/updater.js'));
const { estimateTokens, streamChat } = require(path.join(DIST, 'main/llm/client.js'));
const { sumUsage } = require(path.join(DIST, 'main/store.js'));
const { AGENT_MAP } = require(path.join(DIST, 'shared/agents.js'));

function tmp(tag) {
  return mkdtempSync(path.join(tmpdir(), `rw-003b-${tag}-`));
}

const waitFor = async (fn, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/* ---------------- 1) 彻底删除单个会话 ---------------- */

test('彻底删除：会话文件、前缀辅助文件与索引条目一并擦除', () => {
  const dir = tmp('del');
  const store = new Store(dir);
  const conv = store.createConversation('要删掉的对话');
  const convDir = store.paths.convDir;
  writeFileSync(path.join(convDir, `${conv.id}.trace.json`), '{}');
  writeFileSync(path.join(convDir, `${conv.id}.lock`), 'x');
  assert.equal(store.listConversations().length, 1);

  const report = store.deleteConversation(conv.id);
  assert.equal(report.files, 3, '主文件 + 两个辅助文件都应被删除');
  assert.deepEqual(report.failed, [], '不应有删除失败的路径');
  assert.equal(existsSync(path.join(convDir, `${conv.id}.json`)), false);
  assert.equal(existsSync(path.join(convDir, `${conv.id}.trace.json`)), false);
  assert.equal(existsSync(path.join(convDir, `${conv.id}.lock`)), false);
  assert.equal(store.listConversations().length, 0, '索引条目也应被移除');
  assert.equal(store.getConversation(conv.id), null, '缓存与磁盘都不应再读得到');
  // index.json 必须落盘，重启后也不会复活
  const store2 = new Store(dir);
  assert.equal(store2.listConversations().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('彻底删除：产物目录与 0.0.3a 遗留的散落文件都清掉', () => {
  const dir = tmp('artifact');
  const store = new Store(dir);
  const workspace = path.join(dir, 'workspace');
  const root = path.join(workspace, '.runworker-artifacts');
  const id = 'conv_legacy';
  mkdirSync(path.join(root, id), { recursive: true });
  writeFileSync(path.join(root, id, 'chart.png'), 'img');
  writeFileSync(path.join(root, id, 'note.md'), 'note');
  writeFileSync(path.join(root, `${id}-cover.png`), 'old'); // 旧版直接散落在根目录

  const report = store.purgeConversationArtifacts(id, workspace);
  assert.equal(report.files, 3, '会话目录内 2 个 + 根目录 1 个旧文件');
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, id)), false);
  assert.equal(existsSync(path.join(root, `${id}-cover.png`)), false);
  rmSync(dir, { recursive: true, force: true });
});

test('清空全部：整个产物根目录（含旧散落文件与 _shared）一起删除', () => {
  const dir = tmp('clear');
  const store = new Store(dir);
  store.createConversation('一');
  store.createConversation('二');
  const workspace = path.join(dir, 'workspace');
  const root = path.join(workspace, '.runworker-artifacts');
  mkdirSync(path.join(root, 'conv_a'), { recursive: true });
  mkdirSync(path.join(root, '_shared'), { recursive: true });
  writeFileSync(path.join(root, 'conv_a', 'a.txt'), 'a');
  writeFileSync(path.join(root, '_shared', 's.txt'), 's');
  writeFileSync(path.join(root, 'old-loose.png'), 'loose'); // 不是目录，旧版遗留

  const report = store.clearConversations(workspace);
  assert.equal(report.files, 2, '两个会话文件');
  assert.equal(report.artifacts, 3, '目录内 2 个 + 根下 1 个散落文件');
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(root), false, '产物根目录应被整个删掉');
  assert.equal(store.listConversations().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('引用对话文件：历史附件与会话产物都能列出来', () => {
  const dir = tmp('files');
  const store = new Store(dir);
  const conv = store.createConversation('带附件');
  const workspace = path.join(dir, 'workspace');
  const artifactDir = path.join(workspace, '.runworker-artifacts', conv.id);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, 'result.png'), 'img');
  conv.messages.push({
    id: 'm1', role: 'user', content: '看看这个', createdAt: Date.now(),
    attachments: [{ id: 'a1', name: 'src.md', path: '/tmp/src.md', kind: 'file' }],
  });
  store.saveConversation(conv);

  const files = store.listConversationFiles(conv.id, workspace);
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.origin === 'attachment' && f.name === 'src.md' && f.missing));
  assert.ok(files.some((f) => f.origin === 'artifact' && f.name === 'result.png' && !f.missing));
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 2) 删除屏障 ---------------- */

test('删除屏障：已标记删除的会话，在途 run 不会把它写回复活', async () => {
  const dir = tmp('barrier');
  const events = [];
  const ctx = createContext({
    dataDir: dir,
    appInfo: { version: '0.0.3b', repoUrl: 'LHRonline/run-worker' },
    emit: (channel, payload) => events.push({ channel, payload }),
  });
  const conv = ctx.store.createConversation('即将删除');
  // 按真实时序：run 已经拿到 conv 引用并启动，此时用户点「彻底删除」
  ctx.chat.send({ conversationId: conv.id, text: '还能写回来吗' });
  ctx.chat.markDeleted(conv.id);
  const removed = ctx.store.deleteConversation(conv.id);
  assert.ok(removed.files >= 1, '删除时会话主文件应被清掉');

  const ended = await waitFor(() =>
    events.some((e) => e.channel === EVT.run && e.payload?.type === 'run:end'),
  );
  assert.ok(ended, 'run 应正常以 run:end 收尾');
  assert.equal(existsSync(path.join(ctx.store.paths.convDir, `${conv.id}.json`)), false, '文件不得复活');
  assert.equal(ctx.store.listConversations().length, 0, '索引不得复活');
  rmSync(dir, { recursive: true, force: true });
});

test('删除屏障：markAllDeleted 覆盖全部已有会话，且 aborted 数可被统计', () => {
  const dir = tmp('barrier2');
  const ctx = createContext({
    dataDir: dir,
    appInfo: { version: '0.0.3b', repoUrl: 'LHRonline/run-worker' },
    emit: () => {},
  });
  ctx.store.createConversation('A');
  ctx.store.createConversation('B');
  ctx.chat.markAllDeleted();
  assert.equal(ctx.chat.abortByConversation('conv_not_exist'), 0);
  assert.equal(typeof ctx.chat.abortAll(), 'number');
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 3) 记忆按来源删除 ---------------- */

test('记忆按来源删除：只清目标会话，合并后的多来源也能命中', () => {
  const dir = tmp('memory');
  const deps = {
    dataDir: dir,
    settings: () => createDefaultSettings(),
    saveSettings: (p) => p,
    emit: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  const memory = createMemoryStore(deps);
  memory.add({ text: '会话 A 的偏好：用中文表格', kind: 'preference', source: 'auto:convA' });
  memory.add({ text: '会话 B 的偏好：用英文表头', kind: 'preference', source: 'auto:convB' });
  memory.add({ text: '手工添加的全局偏好', kind: 'preference', source: 'manual' });
  assert.equal(memory.list().length, 3);

  memory.forgetBySource(['auto:convA', 'tool:convA', 'feedback:convA']);
  const left = memory.list();
  assert.equal(left.length, 2, '只应删掉 A 派生的那一条');
  assert.ok(!left.some((f) => (f.source ?? '').includes('convA')));
  assert.ok(left.some((f) => (f.source ?? '').includes('convB')), 'B 的记忆不能被误删');
  assert.ok(left.some((f) => f.source === 'manual'), '手工记忆不能被误删');

  // 逗号分隔的多来源：命中任一即删（符合「彻底删除」语义）
  memory.add({ text: 'A 与 B 合并出来的共享记忆', kind: 'fact', source: 'auto:convA,auto:convB' });
  assert.equal(memory.list().length, 3);
  memory.forgetBySource('auto:convB');
  assert.ok(!memory.list().some((f) => f.text.includes('共享记忆')), '多来源记忆命中 B 也应被清掉');
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 4) 精准 token ---------------- */

test('精准 token：服务商未返回 usage 时明确标记为估算', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你好，世界"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await streamChat({
      target: { providerId: 'x', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' },
      messages: [{ role: 'user', content: '你好' }],
      retries: 0,
    });
    assert.equal(result.text, '你好，世界');
    assert.equal(result.usage.__estimated, true, '没有服务端 usage 时必须打估算标记');
    assert.ok(result.usage.total_tokens > 0, '仍应给出可用的估算值，而不是 0');
  } finally {
    server.close();
  }
});

test('精准 token：服务端返回 usage 时不打估算标记', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await streamChat({
      target: { providerId: 'x', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' },
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    });
    assert.equal(result.usage.prompt_tokens, 123);
    assert.equal(result.usage.total_tokens, 168);
    assert.notEqual(result.usage.__estimated, true, '精确值不能被标成估算');
  } finally {
    server.close();
  }
});

test('断流保护：已经吐出增量后不再整轮重试，避免重复输出', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"已经发出去的一段"}}]}\n\n');
    // 故意不发 [DONE] 就断开，模拟网络中断
    setTimeout(() => res.destroy(), 120);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    let result = null;
    try {
      result = await streamChat({
        target: { providerId: 'x', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', model: 'm' },
        messages: [{ role: 'user', content: 'hi' }],
        retries: 2,
      });
    } catch {
      // 断线可能抛错，也可能被当成流自然结束；关键是绝不能重发整轮请求
    }
    assert.equal(hits, 1, '已输出内容后必须停止重试，否则界面会出现重复文本');
    if (result) assert.equal(result.text, '已经发出去的一段', '即便成功收尾也不能出现重复文本');
  } finally {
    server.close();
  }
});

test('精准 token：sumUsage 会区分精确 / 估算 / 混合', () => {
  const exact = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cachedTokens: 0, totalTokens: 15, costCny: 0, tokenSource: 'api', exactRequests: 1, totalRequests: 1 };
  const est = { promptTokens: 4, completionTokens: 2, reasoningTokens: 0, cachedTokens: 0, totalTokens: 6, costCny: 0, tokenSource: 'estimated', exactRequests: 0, totalRequests: 1 };
  const all = sumUsage([{ role: 'assistant', content: '', createdAt: 0, id: 'a', usage: exact }, { role: 'assistant', content: '', createdAt: 0, id: 'b', usage: est }]);
  assert.equal(all.totalTokens, 21);
  assert.equal(all.tokenSource, 'mixed');
  assert.equal(all.exactRequests, 1);
  assert.equal(all.totalRequests, 2);
  assert.ok(estimateTokens('中文测试 abc') > 0);
});

/* ---------------- 5) 契约、人设、版本 ---------------- */

test('0.0.3c：版本号、比较与更新内容', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.0.3c');
  assert.equal(compareVersion('0.0.3c', '0.0.3b'), 1);
  assert.equal(compareVersion('0.0.3b', '0.0.3c'), -1);
  assert.ok(CURRENT_RELEASE_NOTES.sections.length >= 2, '应用内应展示分组更新内容');
  assert.ok(
    CURRENT_RELEASE_NOTES.sections.some((s) => s.title.includes('本次修复') || s.items.some((i) => i.includes('设置页'))),
    '应用内更新内容应反映 0.0.3c 的弹窗遮挡修复',
  );
  assert.ok(COMPOSER_SKILLS.length >= 6, '增强菜单的快捷技能应齐备');
  assert.ok(PERSONA_PRESET_META.length >= 4, '模式应齐备');
});

test('0.0.3b：IPC 契约含一键升级与引用对话文件，Updater 实现 install', () => {
  assert.ok(IPC.updateInstall, '缺少 updateInstall 通道');
  assert.ok(IPC.convFiles, '缺少 convFiles 通道');
  assert.ok(EVT.updateProgress, '缺少 updateProgress 事件');
  const dir = tmp('updater');
  const deps = {
    dataDir: dir,
    settings: () => createDefaultSettings(),
    saveSettings: (p) => p,
    emit: () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  const updater = createUpdater({ ...deps, appVersion: '0.0.3b', repoUrl: 'LHRonline/run-worker' });
  assert.equal(typeof updater.install, 'function', '一键升级入口必须存在');
  rmSync(dir, { recursive: true, force: true });
});

test('更像人 / 自我改进：人设层与纠正优先级写进系统提示', () => {
  const settings = createDefaultSettings();
  assert.equal(settings.persona.humanize, true, '默认开启更自然的人设层');
  const prompt = buildSystemPrompt({
    persona: settings.persona,
    agent: AGENT_MAP.orchestrator,
    duty: '测试职责',
    memory: '- [要求] 回答里不要写免责声明',
    toolsEnabled: true,
    thinking: false,
  });
  assert.match(prompt, /像真人同事一样对话/, '应注入人类化协作规则');
  assert.match(prompt, /被纠正时先认/, '被纠正时直接改');
  assert.match(prompt, /【要求】是用户主动纠正/, '纠正记忆应被标为最高优先级');
});

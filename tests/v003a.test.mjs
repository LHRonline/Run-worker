/**
 * Run worker — v0.0.3a 补丁回归测试
 *
 * 修复的问题：模型网关要求工具（function）名必须匹配 ^[a-zA-Z0-9_-]+$，
 * 而本应用工具名带点号（python.exec / fs.list / net.fetch …），导致整轮请求被拒：
 *   Invalid `tools[0].function.name`: string does not match pattern.
 *
 * 覆盖：
 *  1) 工具名规整函数本身；
 *  2) 全部已注册工具规整后合法且不重名；
 *  3) 端到端：mock 网关按真实规则强校验，工具循环不再被 400 拒绝，且能执行真实工具；
 *  4) 界面版本号不再硬编码（防止再次与实际构建版本脱节）。
 *
 * 运行：npm run build:main && node --test tests/v003a.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');
const ROOT = path.resolve('.');

/** 服务端强校验规则（与真实网关一致） */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function loadOrchestrator() {
  return require(path.join(DIST, 'main/agents/orchestrator.js'));
}

/* ---------------------- 1) 规整函数本身 ---------------------- */

test('工具名规整：非法字符被替换，输出满足 ^[a-zA-Z0-9_-]+$', () => {
  const { sanitizeToolName } = loadOrchestrator();

  assert.equal(sanitizeToolName('python.exec'), 'python_exec', '点号应替换为下划线');
  assert.equal(sanitizeToolName('fs.list'), 'fs_list');
  assert.equal(sanitizeToolName('net.fetch'), 'net_fetch');
  assert.equal(sanitizeToolName('mcp.call'), 'mcp_call');
  assert.equal(sanitizeToolName('task.schedule'), 'task_schedule');
  assert.equal(sanitizeToolName('ok_name-1'), 'ok_name-1', '本来就合法的名字不应被改动');

  for (const raw of ['a.b c/d', '中文名', 'a.b.c', 'weird@name#1', '']) {
    const safe = sanitizeToolName(raw);
    if (!safe) continue; // 空名由调用方兜底
    assert.match(safe, NAME_PATTERN, `规整结果 "${safe}" 不满足服务端规则`);
  }
});

/* ---------------- 2) 全部工具：合法且不重名 ---------------- */

test('全部已注册工具：规整后的名称合法且互不冲突', () => {
  const { sanitizeToolName } = loadOrchestrator();
  const { toolRegistry } = require(path.join(DIST, 'main/tools/index.js'));

  const names = toolRegistry.names();
  assert.ok(names.length >= 10, `应至少有 10 个工具，实际 ${names.length}`);

  const safe = names.map((n) => sanitizeToolName(n));
  for (const s of safe) {
    assert.match(s, NAME_PATTERN, `工具名 "${s}" 不满足 ^[a-zA-Z0-9_-]+$`);
  }
  assert.equal(new Set(safe).size, safe.length, `规整后出现重名：${safe.join(', ')}`);

  // 确认这个修复确实有意义：真实工具名本身含非法字符
  const dirty = names.filter((n) => n !== sanitizeToolName(n));
  assert.ok(dirty.length > 0, '应存在需要规整的工具名（点号）');
});

/* ------------- 3) 端到端：mock 网关强校验工具名 ------------- */

test('工具循环：网关严格校验工具名时不再被 400 拒绝，且执行的是真实工具', async () => {
  const { runAgentLoop } = loadOrchestrator();

  const workdir = mkdtempSync(path.join(tmpdir(), 'rw-toolname-'));
  const receivedToolNames = [];   // 每次请求收到的 tools 名称
  const receivedMessages = [];    // 每次请求收到的 messages（用于校验上下文一致性）
  let requestCount = 0;
  let rejected = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const tools = body.tools || [];
      receivedToolNames.push(tools.map((t) => t.function && t.function.name));
      receivedMessages.push(body.messages || []);

      // 复刻真实网关的校验：工具名不合法 → 400
      for (const t of tools) {
        const n = t.function && t.function.name;
        if (!NAME_PATTERN.test(String(n))) {
          rejected = n;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Invalid \`tools[0].function.name\`: string does not match pattern. Expected a string that matches the pattern \`^[a-zA-Z0-9_-]+$\`.`,
              },
            }),
          );
          return;
        }
      }

      requestCount += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (requestCount === 1) {
        // 第一轮：模型请求调用被规整过的工具名 fs_list
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'fs_list', arguments: JSON.stringify({ path: workdir }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      } else {
        send({ choices: [{ delta: { content: '目录已看完。' }, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const noop = () => {};
  const rt = {
    settings: () => ({}),
    permissions: null,
    memory: null,
    kb: null,
    scheduler: null,
    mcp: null,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    workspace: () => workdir,
    artifactsDir: workdir,
    askApproval: async () => true,
    notify: noop,
  };

  const events = [];
  const controller = new AbortController();

  const result = await runAgentLoop({
    target: { kind: 'custom', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test', model: 'test-model' },
    agent: 'code',
    messages: [{ role: 'user', content: '看看这个目录' }],
    maxSteps: 3,
    temperature: 0,
    maxOutputTokens: 512,
    toolsEnabled: true,
    toolOutputLimit: 4000,
    signal: controller.signal,
    deps: { runId: 'run-test', rt, emitRun: (e) => events.push(e) },
    onDelta: noop,
    onReasoning: noop,
  });

  server.close();

  // 1) 网关没有因工具名被拒
  assert.equal(rejected, null, `网关拒绝了工具名 "${rejected}"`);
  assert.ok(receivedToolNames.length >= 2, `应发起至少 2 次请求，实际 ${receivedToolNames.length}`);

  // 2) 发给网关的工具名全部合法，且已是规整后的形式
  for (const list of receivedToolNames) {
    for (const n of list) {
      assert.match(String(n), NAME_PATTERN, `发出的工具名 "${n}" 不合法`);
    }
  }
  const firstNames = receivedToolNames[0];
  assert.ok(firstNames.includes('fs_list'), `应发送规整名 fs_list，实际 ${firstNames.join(',')}`);
  assert.ok(!firstNames.includes('fs.list'), '不应再发送带点号的原始工具名');

  // 3) 工具真实执行，且记录的是真实工具名
  assert.equal(result.toolCalls.length, 1, `应有 1 次工具调用，实际 ${result.toolCalls.length}`);
  const call = result.toolCalls[0];
  assert.equal(call.name, 'fs.list', `记录的工具名应为真实名 fs.list，实际 ${call.name}`);
  assert.equal(call.status, 'done', `工具应执行成功，实际状态 ${call.status}`);
  assert.ok(String(call.result).includes(path.basename(workdir)), '工具结果应包含目录名');

  // 4) 回填给模型的上下文里，工具名仍是规整名（与声明的工具一致）
  const secondMessages = receivedMessages[1] || [];
  const assistantMsg = secondMessages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantMsg, '第二轮请求应带上 assistant 的 tool_calls');
  const sentName = assistantMsg.tool_calls[0].function.name;
  assert.equal(sentName, 'fs_list', `上下文中工具名应保持规整名，实际 ${sentName}`);

  // 5) 工具结果已回填
  const toolMsg = secondMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '第二轮请求应带上 tool 结果消息');
  assert.ok(String(toolMsg.content).length > 0, '工具结果内容不应为空');

  // 6) 最终回复正常收尾
  assert.equal(result.text, '目录已看完。');
  assert.equal(result.steps, 2, '应完成 2 轮（调用工具 + 收尾）');

  rmSync(workdir, { recursive: true, force: true });
});

/* ------------- 5) 版本比较：补丁号 0.0.3a 要高于 0.0.3 ------------- */

test('版本比较：字母补丁号高于同数字版本（0.0.3a > 0.0.3）', () => {
  const { compareVersion } = require(path.join(DIST, 'main/platform/updater.js'));

  assert.equal(compareVersion('0.0.3a', '0.0.3'), 1, '0.0.3a 应高于 0.0.3（补丁可被提示升级）');
  assert.equal(compareVersion('0.0.3', '0.0.3a'), -1);
  assert.equal(compareVersion('0.0.3a', '0.0.3a'), 0, '同版本应相等');
  assert.equal(compareVersion('0.0.3b', '0.0.3a'), 1, 'b 应高于 a');
  assert.equal(compareVersion('0.0.3a', '0.0.2'), 1, '补丁号不应影响跨小版本比较');
  assert.equal(compareVersion('0.0.4', '0.0.3a'), 1, '更高小版本仍应更高');
  assert.equal(compareVersion('v0.0.3a', '0.0.3'), 1, '应兼容 v 前缀');

  // 预发布版本仍小于正式版
  assert.equal(compareVersion('0.0.3', '0.0.3-alpha'), 1);
  assert.equal(compareVersion('0.0.3-alpha', '0.0.3'), -1);
});

/* ---------------- 4) 界面版本号不再硬编码 ---------------- */

test('界面版本号不再硬编码为旧版本（防止与实际构建版本脱节）', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.0.3a', `package.json 版本应为 0.0.3a，实际 ${pkg.version}`);

  // 递归扫描渲染进程源码，检查是否还残留旧的硬编码版本号
  const hardcoded = /(['"])0\.0\.1\1/;
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        const text = readFileSync(full, 'utf8');
        if (hardcoded.test(text)) hits.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src/renderer'));
  assert.deepEqual(hits, [], `渲染进程仍有硬编码旧版本号：${hits.join(', ')}`);

  // 标题栏与设置面板应改为读取真实版本
  const titleBar = readFileSync(path.join(ROOT, 'src/renderer/components/TitleBar.tsx'), 'utf8');
  assert.match(titleBar, /app\?\.version/, '标题栏应取自主进程 app.version');
  assert.match(titleBar, /__APP_VERSION__/, '标题栏应有构建期版本兜底');

  const settings = readFileSync(path.join(ROOT, 'src/renderer/components/Settings.tsx'), 'utf8');
  assert.match(settings, /__APP_VERSION__/, '设置面板应使用构建期注入的版本号');
});

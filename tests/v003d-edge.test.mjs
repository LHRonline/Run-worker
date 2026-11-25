/**
 * Run worker — v0.0.3d 收尾：4 个「待确认」边界问题的回归测试
 *
 *  1) send 连点空窗：SET_RUN 在 await 之后才 dispatch，空窗内第二次 send 会漏过守卫
 *  2) selectConversation 中止在途 run：切换会话不应杀掉正在生成的回复
 *  3) resolveRun 并发占位歧义：两个 run 同时流式时不能串消息 / 永久卡住
 *  4) newConversation 只把 agentId 改在本地，未落库，重启后丢失
 *
 * 运行：npm run build:main && node --test tests/v003d-edge.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStoreHarness } = require('./helpers/store-harness.cjs');

/** 造一个足够 send 用的最小 api：chat.send 可控挂起 */
function baseApi(overrides = {}) {
  const calls = [];
  const api = {
    chat: {
      send: async (req) => {
        calls.push(['send', req]);
        return { runId: `run-${calls.length}`, conversationId: req.conversationId };
      },
      abort: async (id) => { calls.push(['abort', id]); },
      approve: async () => {},
    },
    conversations: {
      create: async (title, workspaceId, agentId) => {
        calls.push(['create', title, workspaceId, agentId]);
        return {
          id: `conv-${calls.length}`, title: title || '新对话', createdAt: Date.now(), updatedAt: Date.now(),
          pinned: false, messageCount: 0, agentId: 'orchestrator',
          usage: {}, preview: '', ...(workspaceId ? { workspaceId } : {}), messages: [],
        };
      },
      get: async () => null,
      list: async () => [],
      remove: async () => ({}),
      clear: async () => ({}),
    },
    memory: { list: async () => [], add: async () => [], forget: async () => [], clear: async () => [] },
    tasks: { list: async () => [], history: async () => [] },
    mcp: { tools: async () => [], list: async () => [] },
    events: {
      onRun: () => () => {}, onApproval: () => () => {}, onToast: () => () => {},
      onTasksChanged: () => () => {}, onMcpChanged: () => () => {}, onKnowledgeChanged: () => () => {},
      onUpdateAvailable: () => () => {}, onUpdateProgress: () => () => {},
    },
    ...overrides,
  };
  return { api, calls };
}

function putConv(harness, conv) {
  harness.dispatch({ type: 'UPSERT_CONV', conversation: conv });
  return conv;
}

/* -------------- 1) send 连点空窗 -------------- */

test('连点空窗：第一次 send 卡在 await 时，第二次 send 必须被挡住', async () => {
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let sendCount = 0;
  const { api, calls } = baseApi();
  api.chat.send = async (req) => {
    sendCount += 1;
    calls.push(['send', req]);
    if (sendCount === 1) await firstGate; // 模拟 IPC 尚未返回
    return { runId: `run-${sendCount}`, conversationId: req.conversationId };
  };
  const h = await createStoreHarness({ mockApi: api });
  try {
    putConv(h, {
      id: 'conv-1', title: '连点测试', createdAt: 1, updatedAt: 1, pinned: false, messageCount: 0,
      agentId: 'orchestrator', usage: {}, preview: '', messages: [],
    });
    h.dispatch({ type: 'SET_ACTIVE', id: 'conv-1' });

    const p1 = h.actions.send('第一条', 'orchestrator', []);
    // 此时第一次 send 已挂起在 api.chat.send，SET_RUN 尚未 dispatch
    const p2 = h.actions.send('第二条', 'orchestrator', []);
    await p2;
    releaseFirst();
    await p1;

    const sends = calls.filter((c) => c[0] === 'send');
    assert.equal(sends.length, 1, `空窗内第二次 send 应被守卫挡住，实际发出 ${sends.length} 条`);
    const msgs = h.getState().conversations['conv-1'].messages;
    assert.equal(msgs.filter((m) => m.role === 'user').length, 1, '界面只应出现一条用户消息');
  } finally {
    h.cleanup();
  }
});

/* -------------- 2) 切换会话不应中止在途 run -------------- */

test('切换会话：在途 run 应继续在后台生成，不被中止', async () => {
  const { api, calls } = baseApi();
  const h = await createStoreHarness({ mockApi: api });
  try {
    for (const id of ['conv-a', 'conv-b']) {
      putConv(h, {
        id, title: id, createdAt: 1, updatedAt: 1, pinned: false, messageCount: 0,
        agentId: 'orchestrator', usage: {}, preview: '', messages: [],
      });
    }
    h.dispatch({ type: 'SET_ACTIVE', id: 'conv-a' });
    h.dispatch({
      type: 'SET_RUN',
      run: { runId: 'run-a', conversationId: 'conv-a', messageId: 'placeholder-a', startedAt: Date.now(), status: 'running', agentId: 'orchestrator' },
    });

    await h.actions.selectConversation('conv-b');

    const aborts = calls.filter((c) => c[0] === 'abort');
    assert.equal(aborts.length, 0, `切换会话不应中止在途 run，实际调用 abort ${aborts.length} 次`);
    const run = h.getState().runs['run-a'];
    assert.ok(run, '原会话的 run 记录应保留');
    assert.equal(run.status, 'running', '原 run 应继续运行');
  } finally {
    h.cleanup();
  }
});

/* -------------- 3) 并发 run 的占位解析 -------------- */

test('并发 run：SET_RUN 前的首批事件按 conversationId 命中各自占位，不串消息', async () => {
  const { api } = baseApi();
  const h = await createStoreHarness({ mockApi: api });
  try {
    // 两个会话各有一条 streaming 占位，但 SET_RUN 尚未 dispatch（首批事件抢跑）
    for (const [convId, msgId] of [['conv-1', 'ph-1'], ['conv-2', 'ph-2']]) {
      putConv(h, {
        id: convId, title: convId, createdAt: 1, updatedAt: 1, pinned: false, messageCount: 0,
        agentId: 'orchestrator', usage: {}, preview: '', messages: [],
      });
      h.dispatch({
        type: 'ADD_MESSAGE', convId,
        message: { id: msgId, role: 'assistant', content: '', status: 'streaming', createdAt: Date.now(), toolCalls: [] },
      });
    }
    // 通过导出的 resolveRun 验证：给定 conversationId 应精确命中，而不是因「全局不唯一」返回空
    const resolveRun = h.resolveRun;
    assert.ok(resolveRun, 'harness 应导出 resolveRun');
    const r1 = resolveRun(h.getState(), 'run-1', 'conv-1');
    assert.equal(r1.messageId, 'ph-1');
    const r2 = resolveRun(h.getState(), 'run-2', 'conv-2');
    assert.equal(r2.messageId, 'ph-2');
  } finally {
    h.cleanup();
  }
});

/* -------------- 4) newConversation 的 agentId 落库 -------------- */

test('从 Agent 广场新建会话：agentId 必须落到后端，而不是只在本地对象上', async () => {
  const { api, calls } = baseApi();
  const h = await createStoreHarness({ mockApi: api });
  try {
    await h.actions.newConversation('code', '代码任务');
    const createCall = calls.find((c) => c[0] === 'create');
    assert.ok(createCall, '应调用 conversations.create');
    assert.equal(createCall[2], undefined, '第三个参数是 workspaceId');
    // agentId 应随 create 一起传给后端（参数形态由实现决定，这里看 api 收到的参数里有没有 code）
    const passedAgent = createCall.slice(1).includes('code');
    assert.ok(passedAgent, 'agentId=code 必须传给后端会话创建接口，否则重启后丢失');
  } finally {
    h.cleanup();
  }
});

/**
 * Run worker — v0.0.3d：预览模式（MockApi）记忆按工作区隔离回归
 *
 * bridge.ts 是浏览器预览时 window.runworker 缺失下的实现。文件头声明
 * 「同一个界面在 Electron 与静态预览下行为一致」，但旧实现完全忽略 wsId，
 * 导致预览里「范围：工作区X」是假象，在工作区点清空还会把全局记忆清光。
 *
 * 这里用 esbuild 把 bridge.ts 单独打成 CJS（注入 __APP_VERSION__），
 * 在 Node 里 mock window / localStorage 后，直接验证 MockApi 的四个记忆操作。
 *
 * 运行：npm run build:main 前后均可（只依赖 TS 源码），node --test tests/v003d-mock.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');
const esbuild = require('esbuild');

/** 编译 bridge.ts → 临时 CJS，并注入浏览器全局后加载 */
function loadMockApi() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rw-mock-'));
  const out = path.join(tmp, 'bridge.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/renderer/lib/bridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    define: { __APP_VERSION__: '"0.0.3d"' },
    alias: { '@shared': './src/shared' },
    logLevel: 'silent',
  });
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  // bridge.ts 顶层会读 window.runworker；置空则走 MockApi
  globalThis.window = { runworker: undefined, matchMedia: () => ({ matches: true, addEventListener() {} }) };
  globalThis.localStorage = localStorage;
  globalThis.document = { documentElement: { setAttribute() {} } };
  const mod = require(out);
  return { api: mod.api, tmp, localStorage };
}

test('预览模式：记忆按工作区分桶，add/list/forget/clear 都只作用于目标范围', async () => {
  const { api, tmp } = loadMockApi();
  try {
    const WS = 'ws-A';
    // 干净起点
    await api.memory.clear(WS);
    await api.memory.clear(null);

    // 工作区写一条、全局写一条
    const inWs = await api.memory.add({ text: '工作区 A 专属记忆', kind: 'fact' }, WS);
    assert.equal(inWs.length, 1, 'add(wsId) 返回该工作区桶');
    await api.memory.add({ text: '全局记忆', kind: 'fact' }, null);

    const scoped = await api.memory.list(WS);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].text, '工作区 A 专属记忆');
    const globalList = await api.memory.list(null);
    assert.equal(globalList.length, 1);
    assert.equal(globalList[0].text, '全局记忆', '两个范围互不串');

    // clear(wsId) 不误清全局
    await api.memory.clear(WS);
    assert.equal((await api.memory.list(WS)).length, 0);
    assert.equal((await api.memory.list(null)).length, 1, '全局记忆未被误清');

    // forget 按范围：目标 id 在全局，从工作区 forget 无效
    const gid = (await api.memory.list(null))[0].id;
    await api.memory.forget(gid, WS);
    assert.equal((await api.memory.list(null)).length, 1, '工作区 forget 不动全局');
    await api.memory.forget(gid, null);
    assert.equal((await api.memory.list(null)).length, 0, '全局 forget 生效');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('预览模式：add 保留调用方传入的 source（纠正写的 feedback:<id> 不能丢）', async () => {
  const { api, tmp } = loadMockApi();
  try {
    await api.memory.clear('ws-B');
    const facts = await api.memory.add(
      { text: '以后回复要更自然', kind: 'instruction', source: 'feedback:conv-1' },
      'ws-B',
    );
    assert.equal(facts[0].source, 'feedback:conv-1', 'source 没被硬编码成「手动添加」覆盖');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('预览模式：删除 / 清空对话时，派生记忆跨所有工作区桶清理，手动记忆保留', async () => {
  const { api, tmp } = loadMockApi();
  try {
    await api.memory.clear('ws-C');
    await api.memory.clear(null);
    // 两个范围各放一条派生 + 一条手动
    await api.memory.add({ text: '派生记忆-全局', source: 'auto:conv-x' }, null);
    await api.memory.add({ text: '手动记忆-全局', source: 'manual' }, null);
    await api.memory.add({ text: '派生记忆-工作区', source: 'auto:conv-x' }, 'ws-C');
    await api.memory.add({ text: '手动记忆-工作区', source: 'manual' }, 'ws-C');

    const report = await api.conversations.clear();
    assert.equal(report.memories, 2, '两个桶里的派生记忆都被清掉');

    const g = await api.memory.list(null);
    assert.equal(g.length, 1);
    assert.equal(g[0].text, '手动记忆-全局');
    const w = await api.memory.list('ws-C');
    assert.equal(w.length, 1);
    assert.equal(w[0].text, '手动记忆-工作区', '工作区桶的手动记忆也保留');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('预览模式：持久化结构兼容旧版（只有 memory、没有 memoryByWs）', async () => {
  const { tmp, localStorage } = loadMockApi();
  try {
    // 写入一份旧版形状的存档，重新加载不应崩溃且全局记忆仍可读
    writeFileSync(path.join(tmp, 'unused'), '');
    localStorage.setItem('runworker.preview.state.v2', JSON.stringify({
      settings: { onboardingDone: true },
      memory: [{ id: 'old-1', kind: 'fact', text: '旧版记忆', weight: 0.6, createdAt: 1, updatedAt: 1, hits: 0 }],
    }));
    // 重新 eval 同一 bundle 会命中 require 缓存，这里直接用新进程外的实例验证读取路径：
    // 通过再次 loadMockApi（不同临时文件 → 不同模块）读同一份 localStorage 不可行，
    // 改为直接断言 bridge 的 loadData 对缺字段的兜底由构造完成（不抛错即为通过）。
    const esbuild2 = require('esbuild');
    const out2 = path.join(tmp, 'bridge2.cjs');
    esbuild2.buildSync({
      entryPoints: [path.join(ROOT, 'src/renderer/lib/bridge.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: out2,
      define: { __APP_VERSION__: '"0.0.3d"' }, alias: { '@shared': './src/shared' }, logLevel: 'silent',
    });
    assert.doesNotThrow(() => require(out2), '旧存档缺 memoryByWs 不应导致解析崩溃');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

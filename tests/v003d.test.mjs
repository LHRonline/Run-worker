/**
 * Run worker — v0.0.3d 修复回归
 *
 * 覆盖：
 *  1) 工作区记忆读写清按范围隔离（IPC 形参错位导致 wsId 丢失的回归）
 *  2) 会话产物目录按会话绑定的工作区解析（写入/引用/删除指向同一目录）
 *  3) 清空全部会话：产物覆盖所有工作区目录，手动记忆保留、派生记忆清除
 *  4) 删除失败（文件被占用）时索引保持一致，不留永久孤儿
 *
 * 运行：npm run build:main && node --test tests/v003d.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');
const { Store } = require(path.join(DIST, 'main/store.js'));
const { createContext } = require(path.join(DIST, 'main/chat/context.js'));

function tmp(tag) {
  return mkdtempSync(path.join(tmpdir(), `rw-003d-${tag}-`));
}

function context(dir) {
  return createContext({
    dataDir: dir,
    appInfo: { version: '0.0.3d', repoUrl: 'LHRonline/run-worker' },
    emit: () => {},
  });
}

/* -------------- 1) 工作区记忆按范围隔离 -------------- */

test('记忆按工作区隔离：写入工作区的记忆能被该工作区读到并清空，不影响全局', () => {
  const dir = tmp('mem-scope');
  const ctx = context(dir);
  const wsDir = path.join(dir, '工作区A');
  mkdirSync(wsDir, { recursive: true });
  const ws = ctx.store.addWorkspace({ name: '工作区A', path: wsDir })[0];

  // 模拟 IPC memoryAdd 的真实调用：第一个参数就是 fact，第二个是 wsId
  ctx.memoryForWorkspace(ws.id).add({ text: '工作区A 专属事实', source: 'manual' });
  ctx.memoryForWorkspace(null).add({ text: '全局专属事实', source: 'manual' });

  // memoryList(wsId) 应能拿到工作区自己的记忆，且看不到全局那条
  const scoped = ctx.memoryForWorkspace(ws.id).list();
  assert.equal(scoped.length, 1, '工作区 store 只有自己那条');
  assert.equal(scoped[0].text, '工作区A 专属事实');
  const globalMem = ctx.memoryForWorkspace(null).list();
  assert.equal(globalMem.length, 1);
  assert.equal(globalMem[0].text, '全局专属事实');

  // memoryClear(wsId) 只清工作区，不波及全局
  ctx.memoryForWorkspace(ws.id).clear();
  assert.equal(ctx.memoryForWorkspace(ws.id).list().length, 0);
  assert.equal(ctx.memoryForWorkspace(null).list().length, 1, '全局记忆不受影响');
  rmSync(dir, { recursive: true, force: true });
});

/* -------------- 2) 产物目录按会话工作区解析 -------------- */

test('产物目录：绑定工作区的会话，解析到它自己的文件夹；移出后回到全局', () => {
  const dir = tmp('wsdir');
  const ctx = context(dir);
  const wsDir = path.join(dir, '项目A');
  mkdirSync(wsDir, { recursive: true });
  const ws = ctx.store.addWorkspace({ name: '项目A', path: wsDir })[0];
  const conv = ctx.store.createConversation('工作区里的对话', 'orchestrator', ws.id);

  assert.equal(
    ctx.workspaceDirForConversation(conv.id).toLowerCase(),
    path.resolve(wsDir).toLowerCase(),
    '产物目录应指向会话绑定的工作区',
  );
  ctx.store.moveConversation(conv.id, null);
  assert.notEqual(
    ctx.workspaceDirForConversation(conv.id).toLowerCase(),
    path.resolve(wsDir).toLowerCase(),
    '移出工作区后不再指向该文件夹',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('清空全部会话：产物覆盖所有工作区目录，不留孤儿', () => {
  const dir = tmp('clear-multi');
  const store = new Store(dir);
  const wsA = path.join(dir, 'A');
  const wsB = path.join(dir, 'B');
  const globalWs = path.join(dir, 'workspace');
  for (const d of [wsA, wsB, globalWs]) mkdirSync(d, { recursive: true });
  store.addWorkspace({ name: 'A', path: wsA });
  store.addWorkspace({ name: 'B', path: wsB });
  const c1 = store.createConversation('一');
  const c2 = store.createConversation('二');

  const rootA = path.join(wsA, '.runworker-artifacts');
  const rootB = path.join(wsB, '.runworker-artifacts');
  const rootG = path.join(globalWs, '.runworker-artifacts');
  mkdirSync(path.join(rootA, c1.id), { recursive: true });
  mkdirSync(path.join(rootB, c2.id), { recursive: true });
  mkdirSync(path.join(rootG, '_shared'), { recursive: true });
  writeFileSync(path.join(rootA, c1.id, 'a.png'), 'a');
  writeFileSync(path.join(rootB, c2.id, 'b.png'), 'b');
  writeFileSync(path.join(rootG, '_shared', 'g.txt'), 'g');

  const dirs = store.listWorkspaces().map((w) => w.path);
  const report = store.clearConversations(globalWs, dirs);
  assert.equal(report.files, 2, '两个会话文件被删');
  assert.equal(report.artifacts, 3, '三个产物文件（两个工作区 + 全局）全部清理');
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(rootA), false, '工作区 A 产物根目录清空');
  assert.equal(existsSync(rootB), false, '工作区 B 产物根目录清空');
  assert.equal(existsSync(rootG), false, '全局产物根目录清空');
  assert.equal(store.listConversations().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

/* -------------- 3) 清空全部：派生记忆清除、手动记忆保留 -------------- */

test('清空全部对话：只清会话派生记忆，手动添加的长期记忆保留', () => {
  const dir = tmp('clear-mem');
  const ctx = context(dir);
  const wsDir = path.join(dir, '工作区B');
  mkdirSync(wsDir, { recursive: true });
  const ws = ctx.store.addWorkspace({ name: '工作区B', path: wsDir })[0];
  const conv = ctx.store.createConversation('对话1', 'orchestrator', ws.id);

  // 会话派生记忆（散落在全局与工作区 store），以及一条手动记忆
  ctx.memoryForWorkspace(ws.id).add({ text: '派生事实', source: `auto:${conv.id}` });
  ctx.memoryForWorkspace(null).add({ text: '手动长期要求', source: 'manual' });

  const ids = ctx.store.listConversations().map((m) => m.id);
  const sources = ids.flatMap((id) => [`auto:${id}`, `tool:${id}`, `feedback:${id}`]);
  const removed = ctx.forgetMemoryEverywhere(sources);
  assert.equal(removed, 1, '清掉一条派生记忆');
  assert.equal(ctx.memoryForWorkspace(ws.id).list().length, 0, '工作区派生记忆不再残留');
  assert.equal(ctx.memoryForWorkspace(null).list().length, 1, '手动记忆保留');
  rmSync(dir, { recursive: true, force: true });
});

test('兜底清理覆盖已移除工作区：目录不再登记时，进程内创建过的 store 仍被清到', () => {
  const dir = tmp('removed-ws');
  const ctx = context(dir);
  const wsDir = path.join(dir, '临时工作区');
  mkdirSync(wsDir, { recursive: true });
  const ws = ctx.store.addWorkspace({ name: '临时工作区', path: wsDir })[0];
  const conv = ctx.store.createConversation('对话1', 'orchestrator', ws.id);
  // 先让该工作区的记忆 store 在进程内被创建
  ctx.memoryForWorkspace(ws.id).add({ text: '将被清掉的派生记忆', source: `auto:${conv.id}` });
  // 移除工作区（文件夹保留在磁盘，不再出现在 listWorkspaces）
  ctx.store.removeWorkspace(ws.id);
  assert.equal(ctx.store.listWorkspaces().length, 0);

  const removed = ctx.forgetMemoryEverywhere([`auto:${conv.id}`]);
  assert.equal(removed, 1, '已移除工作区里残留的派生记忆仍应被清掉');
  rmSync(dir, { recursive: true, force: true });
});

/* -------------- 4) 删除失败时索引一致性 -------------- */

test('清空全部遇到被占用文件：删除失败的会话仍留在索引里，可再次重试', () => {
  const dir = tmp('clear-locked');
  const store = new Store(dir);
  const c1 = store.createConversation('一');
  const c2 = store.createConversation('二');
  const convDir = store.paths.convDir;
  // 模拟 rmSync 抛错：让其中一个会话主文件删不掉
  const fs = require('node:fs');
  const original = fs.rmSync;
  const locked = path.join(convDir, `${c2.id}.json`);
  fs.rmSync = (target, opts) => {
    if (typeof target === 'string' && path.resolve(target) === path.resolve(locked)) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return original(target, opts);
  };
  try {
    const report = store.clearConversations(path.join(dir, 'workspace'));
    assert.equal(report.files, 1, '一个会话文件删成功');
    assert.ok(report.failed.some((f) => f.includes(c2.id)), '被占用的文件路径应出现在 failed 里');
    const remaining = store.listConversations();
    assert.equal(remaining.length, 1, '删不掉的会话必须留在索引里');
    assert.equal(remaining[0].id, c2.id);
  } finally {
    fs.rmSync = original;
  }
  rmSync(dir, { recursive: true, force: true });
});

/* -------------- 5) 边界：失效绑定 / 路径外溢 / 删除屏障 -------------- */

test('边界：绑定到不存在工作区的会话自动降级为未绑定，不产生看不见的孤儿', () => {
  const dir = tmp('dead-ws');
  const store = new Store(dir);
  const conv = store.createConversation('测试', 'orchestrator', 'ws-not-exist');
  assert.equal(conv.workspaceId, undefined, '失效 workspaceId 不应写入会话');
  assert.equal(store.listConversations().find((m) => m.id === conv.id).workspaceId, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('边界：子工作区名为 .. / ... 时不会外溢到父工作区之外', () => {
  const dir = tmp('dotdot');
  const store = new Store(dir);
  const root = path.join(dir, '父工作区');
  mkdirSync(root, { recursive: true });
  const parent = store.addWorkspace({ name: '父工作区', path: root })[0];

  const child = store.addWorkspace({ name: '..', parentId: parent.id }).find((w) => w.parentId === parent.id);
  assert.ok(child, '应创建子工作区');
  assert.equal(path.dirname(child.path), path.resolve(root), '子工作区仍在父工作区文件夹内');
  assert.ok(child.path.startsWith(path.resolve(root) + path.sep), '路径不得指向父级之上');

  // ... 与 .. 一样会被规范化为同一个安全目录，触发「同一文件夹不重复登记」的去重
  const after = store.addWorkspace({ name: '...', parentId: parent.id });
  const children = after.filter((w) => w.parentId === parent.id);
  assert.equal(children.length, 1, '纯点号名落到同一安全目录，不应重复登记');
  assert.ok(children[0].path.startsWith(path.resolve(root) + path.sep));
  rmSync(dir, { recursive: true, force: true });
});

test('边界：删除屏障裁剪时保留在途 run 的会话 id，避免落库复活', () => {
  const dir = tmp('barrier-cap');
  const ctx = context(dir);
  // 直接构造确定性的「在途 run」：往运行时 Map 放一条记录，不依赖异步时序
  const inFlightConv = 'conv-in-flight';
  ctx.chat.runs.set('run-fake', { runId: 'run-fake', conversationId: inFlightConv });
  ctx.chat.markDeleted(inFlightConv);
  // 灌入超过上限的已删会话，触发裁剪
  for (let i = 0; i < 600; i += 1) ctx.chat.markDeleted(`old-${i}`);
  const barriers = ctx.chat.deletedConversations;
  assert.ok(barriers.has(inFlightConv), '在途 run 的会话屏障不能被 FIFO 淘汰');
  assert.ok(barriers.size <= 501, '集合仍应有界，不能无限增长');
  rmSync(dir, { recursive: true, force: true });
});

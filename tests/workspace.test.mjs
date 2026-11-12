/**
 * 工作区（文件夹）：套娃层级、真实子文件夹、会话绑定与持久化回归
 * 运行：npm run build:main && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');
const { Store } = require(path.join(DIST, 'main/store.js'));
const { createPermissionGuard } = require(path.join(DIST, 'main/platform/permissions.js'));
const { createDefaultSettings } = require(path.join(DIST, 'shared/presets.js'));

test('工作区：顶层选文件夹、子级自动建真实文件夹、会话绑定与持久化', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rw-ws-'));
  const root = path.join(dataDir, '我的工作区');
  mkdirSync(root, { recursive: true });
  const store = new Store(dataDir);

  const top = store.addWorkspace({ name: '我的工作区', path: root })[0];
  assert.equal(top.name, '我的工作区');
  assert.equal(top.parentId, undefined);

  const child = store.addWorkspace({ name: '地图编辑器', parentId: top.id }).find((w) => w.parentId === top.id);
  assert.ok(child, '子工作区应挂到父工作区下');
  assert.equal(child.path, path.join(root, '地图编辑器'));
  assert.equal(existsSync(child.path), true, '子工作区要在磁盘上真的建出文件夹');

  const grand = store.addWorkspace({ name: '关卡', parentId: child.id }).find((w) => w.parentId === child.id);
  assert.equal(grand.path, path.join(root, '地图编辑器', '关卡'), '支持继续套娃');

  const conv = store.createConversation('做个关卡', 'orchestrator', grand.id);
  assert.equal(store.getConversation(conv.id).workspaceId, grand.id);
  assert.equal(store.listConversations().find((m) => m.id === conv.id).workspaceId, grand.id, '索引里也要保留绑定');

  store.moveConversation(conv.id, child.id);
  assert.equal(store.getConversation(conv.id).workspaceId, child.id);
  store.moveConversation(conv.id, null);
  assert.equal(store.getConversation(conv.id).workspaceId, undefined);

  // 重开一个 Store，工作区与绑定都要从 workspaces.json / 会话文件恢复
  store.moveConversation(conv.id, top.id);
  const reopened = new Store(dataDir);
  assert.equal(reopened.listWorkspaces().length, 3);
  assert.equal(reopened.getConversation(conv.id).workspaceId, top.id);
  assert.equal(reopened.listConversations().find((m) => m.id === conv.id).workspaceId, top.id);

  // 移除父级连带解绑所有后代与它们的对话，但绝不删磁盘文件夹
  reopened.removeWorkspace(top.id);
  assert.equal(reopened.listWorkspaces().length, 0);
  assert.equal(reopened.getConversation(conv.id).workspaceId, undefined);
  assert.equal(existsSync(grand.path), true);

  rmSync(dataDir, { recursive: true, force: true });
});

test('工作区：写进自己文件夹里判低风险，文件夹外仍是中风险', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-ws-perm-'));
  const wsDir = path.join(dir, '项目A');
  mkdirSync(wsDir, { recursive: true });
  const settings = createDefaultSettings();
  const guard = createPermissionGuard(() => settings, () => [wsDir]);

  assert.equal(guard.inspectFileWrite(path.join(wsDir, 'notes.md')).risk, 'low');
  assert.equal(guard.inspectFileWrite(path.join(wsDir, '子目录', 'a.txt')).risk, 'low');
  assert.equal(guard.inspectFileWrite(path.join(dir, '别处.txt')).risk, 'medium');

  rmSync(dir, { recursive: true, force: true });
});

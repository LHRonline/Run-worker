/**
 * Run worker — v0.0.3d：直接打到 IPC 层的参数契约回归
 *
 * 根因：handle 包装器已经消费掉 event，handler 若仍写 (_e, wsId) 会把
 * invoke 传来的第一个参数当成 event，导致 wsId 恒为 undefined。
 * 这里 mock electron.ipcMain 注册真实 handler，再用真实 invoke 参数列表调用，
 * 验证「工作区记忆读写清」确实按 wsId 路由，而不是退回全局。
 *
 * 运行：npm run build:main && node --test tests/v003d-ipc.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DIST = path.resolve('dist-electron');
const { createContext } = require(path.join(DIST, 'main/chat/context.js'));
const { IPC } = require(path.join(DIST, 'shared/ipc.js'));

/** 拦截 'electron' 模块，提供最小可用的 ipcMain/browserWindow/dialog/shell/app */
function withElectronMock(fn) {
  const handlers = new Map();
  const fakeElectron = {
    ipcMain: {
      handle: (channel, fn2) => handlers.set(channel, fn2),
      on: () => {},
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getPath: () => '', getVersion: () => '0.0.3d', isPackaged: false, quit: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', openExternal: async () => {} },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return original.call(this, request, parent, isMain);
  };
  try {
    // 清掉缓存，确保 ipc.js 重新以 mock 的 electron 加载
    const ipcPath = path.join(DIST, 'main/ipc.js');
    delete require.cache[require.resolve(ipcPath)];
    const { registerIpc } = require(ipcPath);
    return { handlers, registerIpc, fakeElectron };
  } finally {
    // registerIpc 调用期间必须保持拦截，故由调用方在结束时 restore
    Module._restore = () => { Module._load = original; };
  }
}

test('IPC 记忆读写清：wsId 正确路由到工作区 store，不退回全局', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rw-003d-ipc-'));
  let restore = () => {};
  try {
    const ctx = createContext({
      dataDir: dir,
      appInfo: { version: '0.0.3d', repoUrl: 'LHRonline/run-worker' },
      emit: () => {},
    });
    const wsDir = path.join(dir, '工作区A');
    mkdirSync(wsDir, { recursive: true });
    const ws = ctx.store.addWorkspace({ name: '工作区A', path: wsDir })[0];

    const mock = withElectronMock();
    restore = Module._restore;
    mock.registerIpc(ctx, { getWindow: () => null });

    // 模拟渲染进程 invoke：list(wsId) / add(fact, wsId) / clear(wsId)
    const invoke = async (channel, ...args) => mock.handlers.get(channel)({}, ...args);

    const added = await invoke(IPC.memoryAdd, { text: '工作区A 专属记忆', source: 'manual' }, ws.id);
    assert.equal(added.length, 1, 'add 返回该工作区 store 的结果');
    assert.equal(added[0].text, '工作区A 专属记忆');

    // 全局 store 不应出现这条（证明没退回全局）
    const globalList = await invoke(IPC.memoryList, null);
    assert.equal(globalList.length, 0, '全局记忆列表为空，add 没有误写全局');

    const scopedList = await invoke(IPC.memoryList, ws.id);
    assert.equal(scopedList.length, 1, '工作区记忆列表能读到自己那条');
    assert.equal(scopedList[0].text, '工作区A 专属记忆');

    // clear(wsId) 只清该工作区；先在全局放一条，确认不受影响
    await invoke(IPC.memoryAdd, { text: '全局记忆', source: 'manual' }, null);
    const cleared = await invoke(IPC.memoryClear, ws.id);
    assert.equal(cleared.length, 0, '清空的是目标工作区');
    assert.equal((await invoke(IPC.memoryList, ws.id)).length, 0, '工作区记忆已清空');
    assert.equal((await invoke(IPC.memoryList, null)).length, 1, '全局记忆没被误清');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

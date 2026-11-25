/**
 * StoreProvider 测试夹具：用 esbuild 把 store.tsx 打成 CJS，
 * 替换 react / bridge 为轻量 mock，把 useReducer 的状态和 actions 暴露出来直接调用。
 * stateRef.current 会随 dispatch 同步更新，保证 action 内读到的始终是最新 state。
 */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');

async function createStoreHarness(opts = {}) {
  const tag = `store-harness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const out = path.join(ROOT, 'tests', `.${tag}.cjs`);

  const apiBox = { current: opts.mockApi || {} };
  globalThis.__harnessApi = apiBox;
  globalThis.__harnessRefs = [];

  const mockReact = `
    module.exports = {
      createContext: () => ({}),
      useContext: () => ({}),
      useReducer: (reducer, initial) => {
        if (!globalThis.__harnessState) globalThis.__harnessState = initial;
        globalThis.__harnessReducer = reducer;
        globalThis.__harnessDispatch = (a) => {
          globalThis.__harnessState = globalThis.__harnessReducer(globalThis.__harnessState, a);
          if (globalThis.__harnessRefs[0]) globalThis.__harnessRefs[0].current = globalThis.__harnessState;
          return a;
        };
        return [globalThis.__harnessState, globalThis.__harnessDispatch];
      },
      useRef: (v) => {
        const r = { current: v };
        globalThis.__harnessRefs.push(r);
        return r;
      },
      useMemo: (fn) => {
        const r = fn();
        if (r && r.send && r.refreshMemory) globalThis.__harnessActions = r;
        return r;
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
    };
  `;
  const mockBridge = `module.exports = { api: globalThis.__harnessApi.current };`;
  const mockJsx = `module.exports = { jsx: () => ({}), jsxs: () => ({}), Fragment: Symbol('Fragment') };`;

  const harnessPlugin = {
    name: 'harness',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'mock' }));
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'mock' }));
      // Windows 下 importer 是反斜杠路径，统一成正斜杠再判断
      build.onResolve({ filter: /bridge$/ }, (args) =>
        /state[\/\\]store\.tsx$/.test((args.importer || '').replace(/\\/g, '/'))
          ? { path: 'bridge', namespace: 'mock' }
          : undefined);
      build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => {
        if (args.path === 'react') return { contents: mockReact, loader: 'js' };
        if (args.path === 'jsx') return { contents: mockJsx, loader: 'js' };
        if (args.path === 'bridge') return { contents: mockBridge, loader: 'js' };
        return null;
      });
    },
  };

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/renderer/state/store.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    define: { __APP_VERSION__: '"0.0.3d"' },
    alias: { '@shared': './src/shared', '@renderer': './src/renderer' },
    plugins: [harnessPlugin],
    logLevel: 'silent',
  });

  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };

  const mod = require(out);
  globalThis.__harnessState = undefined;
  globalThis.__harnessRefs = [];
  globalThis.__harnessActions = null;
  mod.StoreProvider({ children: null });
  const actions = globalThis.__harnessActions;
  if (!actions) throw new Error('未能从 StoreProvider 抓取 actions');

  return {
    actions,
    getState: () => globalThis.__harnessState,
    dispatch: (a) => globalThis.__harnessDispatch(a),
    resolveRun: mod.resolveRun || null,
    setApi: (a) => { apiBox.current = a; },
    cleanup: () => { try { fs.unlinkSync(out); } catch {} },
  };
}

module.exports = { createStoreHarness, ROOT };

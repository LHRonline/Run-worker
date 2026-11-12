import { api, hasNativeWindow } from '../lib/bridge';
import { useStore } from '../state/store';

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none">
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none">
      <rect x="2.4" y="2.4" width="7.2" height="7.2" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function TitleBar() {
  // 版本号取自主进程 app.getVersion()，不再硬编码，避免与实际构建版本脱节
  const { state, actions } = useStore();
  const version = state.app?.version ?? __APP_VERSION__;
  return (
    <header className="titlebar">
      <div className="brand">
        <img className="brand-mark" src="./icon.png" alt="Run worker 图标" />
        <span className="brand-name">Run worker</span>
        {version ? (
          <button
            type="button"
            className="version-chip version-click"
            title="查看本次更新内容"
            onClick={() => actions.setReleaseNotesOpen(true)}
          >
            {version}
          </button>
        ) : null}
      </div>
      <div className="titlebar-drag">
        <span className="titlebar-hint">多智能体调度 · 直接操作电脑</span>
      </div>
      {hasNativeWindow ? (
        <div className="win-actions">
          <button type="button" className="win-btn" title="最小化" onClick={() => api.window.minimize()}>
            <MinimizeIcon />
          </button>
          <button type="button" className="win-btn" title="最大化 / 还原" onClick={() => api.window.maximize()}>
            <MaximizeIcon />
          </button>
          <button type="button" className="win-btn close" title="关闭" onClick={() => api.window.close()}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </header>
  );
}

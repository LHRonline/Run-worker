import { useEffect, useState } from 'react';
import { accentOf, darken, hexToRgba, lighten } from './lib/theme';
import { useStore } from './state/store';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { AgentGrid } from './components/AgentGrid';
import { TasksPanel } from './components/TasksPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { McpPanel } from './components/McpPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { Onboarding } from './components/Onboarding';
import { Settings } from './components/Settings';
import { ToastStack } from './components/Toast';

export default function App() {
  const { state, actions } = useStore();
  const { settings, ready, view, systemTheme } = state;
  const [systemDark, setSystemDark] = useState(systemTheme === 'dark');

  /* 浏览器环境也监听系统主题；主进程事件由 store 同步 */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystemDark(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const themeMode = settings.appearance.theme;
  const resolved = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  /* 主题色、缩放、等宽字体 */
  useEffect(() => {
    const root = document.documentElement;
    const accent = accentOf(settings.appearance.accent);
    root.style.setProperty('--accent', accent.value);
    root.style.setProperty('--accent-2', accent.alt);
    root.style.setProperty('--accent-text', resolved === 'light' ? darken(accent.value, 0.18) : lighten(accent.value, 0.42));
    root.style.setProperty('--accent-soft', hexToRgba(accent.value, resolved === 'light' ? 0.11 : 0.14));
    root.style.setProperty('--accent-softer', hexToRgba(accent.value, resolved === 'light' ? 0.06 : 0.07));
    root.style.setProperty('--accent-line', hexToRgba(accent.value, 0.38));
    root.style.setProperty('--zoom', String(settings.appearance.zoom));
  }, [settings.appearance.accent, settings.appearance.zoom, resolved]);

  /* 快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key === 'n') {
        e.preventDefault();
        void actions.newConversation();
      }
      if (e.key === ',') {
        e.preventDefault();
        actions.openSettings(true);
      }
      if (e.key === 'k') {
        e.preventDefault();
        actions.setView('chat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <img src="./icon.png" alt="Run worker" />
          <div className="bt">Run worker</div>
          <div className="bs">正在载入工作区与本地配置…</div>
          <div className="boot-bar">
            <i />
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`app${settings.appearance.decorations ? ' decor' : ''}${settings.appearance.monoFont ? ' mono-ui' : ''}`}>
        <TitleBar />
        <div className="shell">
          <Sidebar />
          {view === 'chat' ? <ChatView /> : null}
          {view === 'agents' ? <AgentGrid /> : null}
          {view === 'tasks' ? <TasksPanel /> : null}
          {view === 'kb' ? <KnowledgePanel /> : null}
          {view === 'mcp' ? <McpPanel /> : null}
          {view === 'memory' ? <MemoryPanel /> : null}
        </div>
      </div>

      {!settings.onboardingDone ? <Onboarding /> : null}
      {state.settingsOpen ? <Settings /> : null}
      <ToastStack toasts={state.toasts} onDismiss={actions.dismissToast} />
    </>
  );
}

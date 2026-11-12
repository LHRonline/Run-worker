import { CURRENT_RELEASE_NOTES } from '@shared/presets';
import { api } from '../lib/bridge';
import { useStore } from '../state/store';
import { Modal } from './Modal';

/** 应用内「本次更新」：与发布说明共用同一份数据，版本号始终取真实构建版本 */
export function ReleaseNotes() {
  const { state, actions } = useStore();
  const version = state.app?.version ?? __APP_VERSION__;
  const { summary, sections } = CURRENT_RELEASE_NOTES;

  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Run worker 更新内容
          <span className="version-chip">{version}</span>
        </span>
      }
      subtitle="2026-11-12 · 补丁版本，可直接覆盖安装，老数据无需迁移"
      onClose={() => actions.setReleaseNotesOpen(false)}
      wide
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            onClick={() => void api.app.openExternal('https://github.com/LHRonline/run-worker/blob/main/CHANGELOG.md')}
          >
            查看完整更新日志
          </button>
          <button type="button" className="btn primary" onClick={() => actions.setReleaseNotesOpen(false)}>
            知道了
          </button>
        </>
      }
    >
      <div className="release-notes">
        <p className="release-summary">{summary}</p>
        {sections.map((section) => (
          <section className="release-section" key={section.title}>
            <h4>
              <span className="rs-ico">{section.icon}</span>
              {section.title}
            </h4>
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
        <div className="release-foot">
          这一版的更新内容随时可以在「设置 → 关于」里重新打开。
        </div>
      </div>
    </Modal>
  );
}

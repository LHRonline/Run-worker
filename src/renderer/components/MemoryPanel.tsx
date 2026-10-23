import { useMemo, useState } from 'react';
import type { MemoryKind } from '@shared/types';
import { formatRelative } from '../lib/format';
import { useStore } from '../state/store';
import { Confirm } from './Modal';

const KINDS: { key: MemoryKind; label: string; icon: string; desc: string }[] = [
  { key: 'preference', label: '偏好', icon: '♥', desc: '表达习惯、口味、常用技术栈' },
  { key: 'fact', label: '事实', icon: '◇', desc: '关于你或环境的确定信息' },
  { key: 'project', label: '项目', icon: '▣', desc: '项目路径、约定、背景' },
  { key: 'instruction', label: '指令', icon: '⚑', desc: '需要长期遵守的硬性要求' },
];

export function MemoryPanel() {
  const { state, actions } = useStore();
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [text, setText] = useState('');
  const [clearing, setClearing] = useState(false);
  const [saving, setSaving] = useState(false);

  const grouped = useMemo(() => {
    return KINDS.map((k) => ({
      ...k,
      items: state.memory.filter((m) => m.kind === k.key).sort((a, b) => b.weight - a.weight),
    }));
  }, [state.memory]);

  const add = async () => {
    if (!text.trim()) return;
    setSaving(true);
    await actions.addMemory(text.trim(), kind);
    setText('');
    setSaving(false);
  };

  return (
    <div className="main">
      <div className="page">
        <div className="page-scroll">
          <div className="page-inner">
            <div className="page-head">
              <div className="lead">
                <h2 className="page-title">
                  记忆
                  <span className="badge accent">{state.memory.length} 条长期事实</span>
                </h2>
                <p className="page-sub">
                  这里保存跨对话生效的长期信息。权重越高越容易被召回；指令类记忆会作为硬性要求优先注入。
                  你随时可以删除单条或全部清空。
                </p>
              </div>
              <div className="page-actions">
                <span className="pill">
                  <span className={`status-dot ${state.settings.memory.enabled ? 'ready' : 'stopped'}`} />
                  记忆{state.settings.memory.enabled ? '已开启' : '已关闭'}
                  {state.settings.memory.autoExtract ? ' · 自动抽取' : ''}
                </span>
                <button type="button" className="btn danger" onClick={() => setClearing(true)} disabled={state.memory.length === 0}>
                  清空全部
                </button>
              </div>
            </div>

            <div className="set-card">
              <div className="set-card-head">
                <span className="t">手动新增一条记忆</span>
                <span className="s">适合必须长期遵守的偏好与指令</span>
              </div>
              <div className="set-card-body">
                <div className="mem-add">
                  <select className="select" style={{ width: 120, flex: '0 0 120px' }} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
                    {KINDS.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    value={text}
                    placeholder="例如：回答先给结论，代码注释统一用中文"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void add();
                    }}
                  />
                  <button type="button" className={`btn primary${saving ? ' loading' : ''}`} disabled={!text.trim()} onClick={() => void add()}>
                    添加
                  </button>
                </div>
              </div>
            </div>

            {state.memory.length === 0 ? (
              <div className="empty-hint">还没有长期记忆。对话中说过的重要偏好会自动抽取，也可以在上方手动添加。</div>
            ) : (
              grouped.map((group) =>
                group.items.length === 0 ? null : (
                  <div className="mem-group" key={group.key}>
                    <div className="mem-group-head">
                      <span style={{ color: 'var(--accent-text)' }}>{group.icon}</span>
                      {group.label}
                      <span className="cnt">{group.items.length}</span>
                      <span className="field-hint" style={{ marginLeft: 6 }}>
                        {group.desc}
                      </span>
                    </div>
                    <div className="mem-list">
                      {group.items.map((m) => (
                        <div className="mem-item" key={m.id}>
                          <div className="mem-text">
                            {m.text}
                            <div className="field-hint" style={{ marginTop: 3 }}>
                              {m.source ?? '对话自动提取'} · 命中 {m.hits} 次 · {formatRelative(m.updatedAt)}
                            </div>
                          </div>
                          <div className="mem-side">
                            <div className="weight-wrap" title={`权重 ${m.weight.toFixed(2)}`}>
                              <span className="weight-bar">
                                <i style={{ width: `${Math.round(m.weight * 100)}%` }} />
                              </span>
                              <span className="weight-num">{m.weight.toFixed(2)}</span>
                            </div>
                            <button
                              type="button"
                              className="mem-del"
                              title="删除这条记忆"
                              onClick={() => void actions.forgetMemory(m.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              )
            )}

            <div className="note-card" style={{ marginTop: 8 }}>
              <span className="ni">◈</span>
              <span>
                记忆在每轮对话开始前按权重与相关度注入，占用少量 token。开启「省 Token」后会自动压缩低权重条目；
                涉及隐私的内容建议不要写入记忆。
              </span>
            </div>
          </div>
        </div>
      </div>

      {clearing ? (
        <Confirm
          title="清空长期记忆"
          text="全部记忆条目会被永久删除，之后的对话将不再引用这些信息。此操作不可撤销。"
          confirmLabel="清空记忆"
          onClose={() => setClearing(false)}
          onConfirm={() => void actions.clearMemory()}
        />
      ) : null}
    </div>
  );
}

import { useMemo, useState } from 'react';
import type { ProviderConfig, ProviderPreset, ProviderTestResult } from '@shared/types';
import { PROVIDER_PRESETS } from '@shared/presets';
import { api } from '../lib/bridge';
import { useStore } from '../state/store';
import { Field } from './ui';

const PERSONAS = [
  { id: 'direct', name: '直接给结果', desc: '不寒暄、不复述，先给结论与可执行动作。', tag: '推荐' },
  { id: 'balanced', name: '均衡', desc: '先给答案，再用最少篇幅说明关键理由。', tag: '' },
  { id: 'teaching', name: '讲解型', desc: '给答案后解释原理与常见坑，适合学习。', tag: '' },
  { id: 'cold', name: '极简', desc: '只输出事实与步骤，句子极短。', tag: '' },
] as const;

const ORDER = ['deepseek', 'openrouter-free', 'groq', 'siliconflow', 'ollama'];

export function Onboarding() {
  const { state, actions } = useStore();
  const { settings } = state;
  const presets = state.presets.length ? state.presets : PROVIDER_PRESETS;
  const providers = useMemo(
    () => ORDER.map((id) => presets.find((p) => p.id === id)).filter((p): p is ProviderPreset => Boolean(p)),
    [presets],
  );

  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState(settings.activeProviderId || 'deepseek');
  const [apiKey, setApiKey] = useState(settings.providers.find((p) => p.id === providerId)?.apiKey ?? '');
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<ProviderTestResult | null>(null);
  const [persona, setPersona] = useState(settings.persona.preset);
  const [workspace, setWorkspace] = useState(settings.agent.workspaceDir);
  const [saving, setSaving] = useState(false);

  const preset = providers.find((p) => p.id === providerId) ?? providers[0];
  const isLocal = Boolean(preset?.local);

  const selectProvider = (p: ProviderPreset) => {
    setProviderId(p.id);
    setApiKey(settings.providers.find((x) => x.id === p.id)?.apiKey ?? '');
    setTested(null);
  };

  const test = async () => {
    if (!preset) return;
    setTesting(true);
    setTested(null);
    const cfg: ProviderConfig = {
      id: preset.id,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: isLocal ? 'local' : apiKey,
      models: preset.models,
      free: preset.free,
      enabled: true,
    };
    try {
      const res = await api.settings.testProvider(cfg);
      setTested(res);
    } catch (err) {
      setTested({ ok: false, latencyMs: 0, message: err instanceof Error ? err.message : '连接失败' });
    } finally {
      setTesting(false);
    }
  };

  const finish = async () => {
    if (!preset) return;
    setSaving(true);
    const existing = settings.providers.find((p) => p.id === preset.id);
    const provider: ProviderConfig = {
      id: preset.id,
      name: preset.name,
      kind: preset.kind,
      baseUrl: existing?.baseUrl || preset.baseUrl,
      apiKey: isLocal ? '' : apiKey.trim(),
      models: existing?.models.length ? existing.models : preset.models,
      free: preset.free,
      enabled: true,
      status: tested?.ok ? 'ok' : existing?.status ?? 'unknown',
      statusMessage: tested?.message ?? existing?.statusMessage,
      checkedAt: tested ? Date.now() : existing?.checkedAt,
    };
    const others = settings.providers.filter((p) => p.id !== preset.id);
    const model = provider.models[0] ?? settings.activeModel;
    await actions.applySettings({
      ...settings,
      providers: [...others, provider],
      activeProviderId: provider.id,
      activeModel: model,
      freeMode: preset.free,
      persona: { ...settings.persona, preset: persona },
      agent: { ...settings.agent, workspaceDir: workspace },
      onboardingDone: true,
    });
    setSaving(false);
    if (!isLocal && !apiKey.trim()) {
      actions.toast('warn', '未填写 Key，已进入演示模式，可随时在设置中补充');
    } else {
      actions.toast('success', '配置完成，开始使用 Run worker');
    }
  };

  const skip = async () => {
    await actions.applySettings({ ...settings, onboardingDone: true, telemetry: false });
    actions.toast('info', '已进入演示模式，模型渠道可稍后在设置中配置');
  };

  const pickWorkspace = async () => {
    const dir = await api.app.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  return (
    <div className="onb">
      <div className="onb-left">
        <div className="onb-logo">
          <img src="./icon.png" alt="Run worker" />
          <span className="name">Run worker</span>
          <span className="tag">{__APP_VERSION__}</span>
          <span className="tag" style={{ marginLeft: 'auto' }}>
            MIT · 本地优先
          </span>
        </div>

        <div className="onb-main">
          <h1 className="onb-hero-title">
            桌面端全能 Agent
            <br />
            把目标变成结果
          </h1>
          <p className="onb-sub">桌面端全能 Agent · 万能系统助手。三步完成配置，之后直接说你要做什么。</p>

          <div className="onb-points">
            <span className="onb-point">
              <span className="ic">◎</span>多 Agent 调度
            </span>
            <span className="onb-point">
              <span className="ic">▣</span>直接操作电脑
            </span>
            <span className="onb-point">
              <span className="ic">❖</span>本地知识库
            </span>
            <span className="onb-point">
              <span className="ic">⚡</span>省 Token
            </span>
          </div>

          <div className="onb-steps">
            {['模型渠道', '办事风格', '工作区'].map((label, i) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {i > 0 ? <span className="onb-step-line" /> : null}
                <span className={`onb-step-dot${step === i ? ' active' : ''}${step > i ? ' done' : ''}`}>
                  <span className="n">{step > i ? '✓' : i + 1}</span>
                  {label}
                </span>
              </div>
            ))}
          </div>

          {step === 0 ? (
            <div className="onb-panel">
              <h3>选择模型渠道</h3>
              <p className="desc">
                没有 Key 也能用：Ollama 完全本地免费，OpenRouter / Groq / 硅基流动都有免费模型额度。
              </p>
              <div className="onb-providers">
                {providers.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={`provider-pick${providerId === p.id ? ' selected' : ''}`}
                    onClick={() => selectProvider(p)}
                  >
                    <span className="p-name">
                      {p.name}
                      {p.free ? <span className="free-tag">免费</span> : null}
                    </span>
                    <span className="p-note">{p.note}</span>
                  </button>
                ))}
              </div>

              {preset && !isLocal ? (
                <div className="onb-key">
                  <Field
                    label={`${preset.name} API Key`}
                    hint={
                      <>
                        仅保存在本机配置文件中，不会上传。还没有 Key？
                        {preset.keyUrl ? (
                          <a
                            href={preset.keyUrl}
                            onClick={(e) => {
                              e.preventDefault();
                              void api.app.openExternal(preset.keyUrl as string);
                            }}
                            style={{ marginLeft: 4 }}
                          >
                            去申请
                          </a>
                        ) : null}
                      </>
                    }
                  >
                    <div className="input-inline">
                      <input
                        className="input"
                        type="password"
                        placeholder="粘贴 API Key，或先跳过"
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setTested(null);
                        }}
                      />
                      <button type="button" className="suffix-btn" onClick={() => void test()} disabled={testing}>
                        {testing ? '测试中…' : '测试连接'}
                      </button>
                    </div>
                  </Field>
                  {tested ? (
                    <div className={`test-result ${tested.ok ? 'ok' : 'err'}`}>
                      {tested.ok ? `连接成功 · ${tested.latencyMs}ms` : `连接失败 · ${tested.message}`}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {preset && isLocal ? (
                <div className="onb-key">
                  <div className="note-card">
                    <span className="ni">◈</span>
                    <span>
                      本地渠道无需 Key。请先安装 Ollama 并执行 <code>ollama pull qwen2.5:7b</code>，
                      然后在下方测试本地服务是否就绪。
                    </span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn sm" onClick={() => void test()} disabled={testing}>
                      {testing ? <span className="spin" /> : null}
                      测试本地服务
                    </button>
                    {tested ? (
                      <span className={`test-result ${tested.ok ? 'ok' : 'err'}`} style={{ marginLeft: 8 }}>
                        {tested.ok ? `${tested.message} · ${tested.latencyMs}ms` : tested.message}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="onb-panel">
              <h3>选择办事风格</h3>
              <p className="desc">决定 Run worker 说话的密度。之后可以在设置里随时调整，也能在输入框一键切「直给」。</p>
              <div className="persona-grid">
                {PERSONAS.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={`persona-card${persona === p.id ? ' active' : ''}`}
                    onClick={() => setPersona(p.id)}
                  >
                    <span className="pn">
                      {p.name}
                      {p.tag ? <span className="badge accent">{p.tag}</span> : null}
                    </span>
                    <span className="pd">{p.desc}</span>
                  </button>
                ))}
              </div>
              <div className="preview-bubble">
                <div className="ph">实时预览</div>
                <div className="ptext">
                  {persona === 'teaching'
                    ? '结论：把这个脚本放到 tools 目录即可。原理是用 pathlib 遍历并生成新名称，注意同名文件要跳过，否则会覆盖原图。'
                    : persona === 'cold'
                      ? '1. 新建 tools 目录\n2. 保存脚本\n3. 运行 --apply'
                      : persona === 'balanced'
                        ? '结论：先预览再执行。脚本默认只打印重命名计划，加 --apply 才真正改名，同名文件自动跳过。'
                        : '结论：用这个脚本，先预览再执行。\n\npython rename_images.py "D:/照片" --apply'}
                </div>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="onb-panel">
              <h3>选择工作区目录</h3>
              <p className="desc">
                Agent 读写文件、执行脚本都限制在这个目录内。未选择时默认使用用户目录下的 RunWorker 工作区。
              </p>
              <Field label="工作区目录" hint="建议选一个独立的项目目录，便于授权与回溯。">
                <div className="input-inline">
                  <input className="input mono-text" value={workspace} placeholder="尚未选择" readOnly />
                  <button type="button" className="suffix-btn" onClick={() => void pickWorkspace()}>
                    选择目录
                  </button>
                </div>
              </Field>
              <div className="note-card">
                <span className="ni">◈</span>
                <span>
                  所有对话、记忆、知识库索引都保存在本机数据目录。除非你主动调用联网工具，内容不会离开这台电脑。
                </span>
              </div>
              <div className="onb-points" style={{ marginTop: 14 }}>
                <span className="onb-point">
                  <span className="ic">✓</span>危险命令默认需要授权
                </span>
                <span className="onb-point">
                  <span className="ic">✓</span>可随时在设置中修改
                </span>
              </div>
            </div>
          ) : null}

          <div className="onb-foot">
            {step > 0 ? (
              <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => void skip()}>
                先跳过，进入演示模式
              </button>
            )}
            <span className="grow" />
            {step < 2 ? (
              <button type="button" className="btn primary lg" onClick={() => setStep(step + 1)}>
                下一步
              </button>
            ) : (
              <button type="button" className={`btn primary lg${saving ? ' loading' : ''}`} onClick={() => void finish()}>
                {saving ? <span className="spin" /> : null}
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="onb-right">
        <img src="./cover.png" alt="Run worker 主视觉" />
      </div>
    </div>
  );
}

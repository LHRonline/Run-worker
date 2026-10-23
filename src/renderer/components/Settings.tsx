import { useEffect, useMemo, useState } from 'react';
import type {
  ApprovalMode,
  ProviderConfig,
  ProviderPreset,
  ProviderTestResult,
  Settings as SettingsModel,
  ThemeMode,
  UpdateChannel,
} from '@shared/types';
import { PROVIDER_PRESETS } from '@shared/presets';
import { api } from '../lib/bridge';
import { ACCENTS, accentOf, darken, hexToRgba, lighten } from '../lib/theme';
import { formatCny, formatDateTime, formatTokens, normalizePath } from '../lib/format';
import { useStore } from '../state/store';
import { Field, Seg, SetCard, SettingRow, Slider, Switch } from './ui';
import { Icon, type IconName } from './Icon';

type GroupId =
  | 'general'
  | 'models'
  | 'free'
  | 'persona'
  | 'token'
  | 'thinking'
  | 'agent'
  | 'mcp'
  | 'kb'
  | 'memory'
  | 'appearance'
  | 'update'
  | 'about';

const GROUPS: { id: GroupId; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'general' },
  { id: 'models', label: '模型与 API', icon: 'models' },
  { id: 'free', label: '免费 API', icon: 'free' },
  { id: 'persona', label: '人格风格', icon: 'persona' },
  { id: 'token', label: '省 Token', icon: 'token' },
  { id: 'thinking', label: '思考过程', icon: 'thinking' },
  { id: 'agent', label: 'Agent 与安全', icon: 'security' },
  { id: 'mcp', label: 'MCP', icon: 'mcp' },
  { id: 'kb', label: '知识库', icon: 'kb' },
  { id: 'memory', label: '记忆', icon: 'memory' },
  { id: 'appearance', label: '外观', icon: 'appearance' },
  { id: 'update', label: '更新', icon: 'update' },
  { id: 'about', label: '关于', icon: 'about' },
];

const PERSONAS = [
  { id: 'direct', name: '直接给结果', desc: '先给结论与可执行动作，不复述问题。' },
  { id: 'balanced', name: '均衡', desc: '结论优先，补充必要理由。' },
  { id: 'teaching', name: '讲解型', desc: '解释原理与常见坑，适合学习。' },
  { id: 'cold', name: '极简', desc: '只输出事实与步骤，句子极短。' },
  { id: 'custom', name: '自定义', desc: '用你自己的风格描述覆盖以上预设。' },
] as const;

export function Settings() {
  const { state, actions } = useStore();
  const [draft, setDraft] = useState<SettingsModel>(() => structuredClone(state.settings));
  const [group, setGroup] = useState<GroupId>('general');
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({});
  const [modelsLoading, setModelsLoading] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(state.updateInfo);
  const [bootAutoStart, setBootAutoStart] = useState(false);
  const [denyText, setDenyText] = useState(draft.agent.denyPatterns.join('\n'));

  /* 主题、主题色、缩放支持未保存即时预览；关闭设置后回到已保存的值 */
  const saved = useMemo(() => state.settings.appearance, [state.settings.appearance]);
  useEffect(() => {
    const root = document.documentElement;
    const mode = draft.appearance.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : draft.appearance.theme;
    root.dataset.theme = mode;
    const accent = accentOf(draft.appearance.accent);
    root.style.setProperty('--accent', accent.value);
    root.style.setProperty('--accent-2', accent.alt);
    root.style.setProperty('--accent-text', mode === 'light' ? darken(accent.value, 0.18) : lighten(accent.value, 0.42));
    root.style.setProperty('--accent-soft', hexToRgba(accent.value, mode === 'light' ? 0.11 : 0.14));
    root.style.setProperty('--accent-softer', hexToRgba(accent.value, mode === 'light' ? 0.06 : 0.07));
    root.style.setProperty('--accent-line', hexToRgba(accent.value, 0.38));
    root.style.setProperty('--zoom', String(draft.appearance.zoom));
  }, [draft.appearance.theme, draft.appearance.accent, draft.appearance.zoom]);

  useEffect(() => () => {
    const root = document.documentElement;
    const mode = saved.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : saved.theme;
    root.dataset.theme = mode;
    const accent = accentOf(saved.accent);
    root.style.setProperty('--accent', accent.value);
    root.style.setProperty('--accent-2', accent.alt);
    root.style.setProperty('--accent-text', mode === 'light' ? darken(accent.value, 0.18) : lighten(accent.value, 0.42));
    root.style.setProperty('--accent-soft', hexToRgba(accent.value, mode === 'light' ? 0.11 : 0.14));
    root.style.setProperty('--accent-softer', hexToRgba(accent.value, mode === 'light' ? 0.06 : 0.07));
    root.style.setProperty('--accent-line', hexToRgba(accent.value, 0.38));
    root.style.setProperty('--zoom', String(saved.zoom));
  }, [saved]);

  const app = state.app;
  const presets = state.presets.length ? state.presets : PROVIDER_PRESETS;

  const patch = (fn: (d: SettingsModel) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const patchProvider = (id: string, p: Partial<ProviderConfig>) => {
    patch((d) => {
      d.providers = d.providers.map((x) => (x.id === id ? { ...x, ...p } : x));
    });
  };

  const save = async () => {
    setSaving(true);
    const next = {
      ...draft,
      agent: {
        ...draft.agent,
        denyPatterns: denyText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
    await actions.saveSettingsDraft(next);
    setSaving(false);
  };

  const resetAll = async () => {
    const fresh = await api.settings.reset();
    setDraft(structuredClone(fresh));
    setDenyText(fresh.agent.denyPatterns.join('\n'));
    actions.toast('info', '已恢复默认设置，点击「保存并应用」生效');
  };

  const testProvider = async (p: ProviderConfig) => {
    setTesting(p.id);
    try {
      const res = await api.settings.testProvider(p);
      setTests((prev) => ({ ...prev, [p.id]: res }));
      patchProvider(p.id, {
        status: res.ok ? 'ok' : 'error',
        statusMessage: res.message,
        checkedAt: Date.now(),
      });
    } finally {
      setTesting(null);
    }
  };

  const loadModels = async (p: ProviderConfig) => {
    setModelsLoading(p.id);
    try {
      const models = await api.settings.models({ providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey });
      if (models.length) {
        patchProvider(p.id, { models });
        actions.toast('success', `已拉取 ${models.length} 个模型`);
      } else {
        actions.toast('warn', '渠道未返回可用模型，请检查 Key 与 BaseURL');
      }
    } catch (err) {
      actions.toast('error', `拉取失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setModelsLoading(null);
    }
  };

  const fillFree = (preset: ProviderPreset) => {
    patch((d) => {
      const exists = d.providers.some((x) => x.id === preset.id);
      const cfg: ProviderConfig = {
        id: preset.id,
        name: preset.name,
        kind: preset.kind,
        baseUrl: preset.baseUrl,
        apiKey: '',
        models: preset.models,
        free: true,
        enabled: true,
        status: 'unknown',
      };
      d.providers = exists ? d.providers.map((x) => (x.id === preset.id ? { ...x, enabled: true } : x)) : [...d.providers, cfg];
      d.freeMode = true;
    });
    actions.toast('success', `已填入 ${preset.name}，补充 Key 后即可使用`);
  };

  const providerName = useMemo(
    () => draft.providers.find((p) => p.id === draft.activeProviderId)?.name ?? '未选择',
    [draft.providers, draft.activeProviderId],
  );

  const personaPreview = () => {
    const p = draft.persona;
    const base =
      p.preset === 'teaching'
        ? '结论：把脚本放进 tools 目录即可。原理是遍历目录生成新名称，注意同名文件要跳过，否则会覆盖原图。'
        : p.preset === 'cold'
          ? '1. 新建 tools 目录\n2. 写入脚本\n3. 运行 --apply'
          : '结论：用下面这段脚本，先预览再执行，同名文件自动跳过。';
    const extra =
      p.verbosity >= 4
        ? '\n\n补充说明：脚本用 pathlib 保证跨平台；--apply 才会落盘；建议先在 10 个样本上跑一遍预览。'
        : p.verbosity <= 1
          ? ''
          : '\n\n需要我直接在你的目录上跑一次预览吗？';
    return base + extra;
  };

  const estSaving = draft.tokenSave.enabled
    ? Math.min(
        78,
        18 +
          (draft.tokenSave.skipReasoningResend ? 18 : 0) +
          (draft.tokenSave.cacheFriendlyPrefix ? 14 : 0) +
          Math.round(Math.max(0, 32 - draft.tokenSave.maxHistoryMessages) * 0.8) +
          (draft.tokenSave.toolOutputLimit <= 4000 ? 8 : 0),
      )
    : 0;

  return (
    <div className="settings-overlay">
      <div className="settings-top">
        <span style={{ fontSize: 14 }}>⚙</span>
        <div>
          <div className="title">设置</div>
          <div className="sub">Run worker 0.0.1 · 修改后需点击保存并应用</div>
        </div>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="icon-btn" title="关闭设置" onClick={() => actions.openSettings(false)}>
          ✕
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-nav">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`settings-nav-btn${group === g.id ? ' active' : ''}`}
              onClick={() => setGroup(g.id)}
            >
              <span className="ico">
                <Icon name={g.icon} size={15} />
              </span>
              {g.label}
            </button>
          ))}
          <div style={{ marginTop: 'auto', padding: '10px 8px 0', fontSize: 10.5, color: 'var(--faint)', lineHeight: 1.6 }}>
            配置保存在本机
            <br />
            不会上传到服务器
          </div>
        </nav>

        <div className="settings-main">
          <div className="settings-main-inner">
            <div className="settings-group-head">
              <h2>{GROUPS.find((g) => g.id === group)?.label}</h2>
              <p>{GROUP_DESC[group]}</p>
            </div>

            {group === 'general' ? (
              <>
                <SetCard title="基础" sub="界面语言与启动行为">
                  <SettingRow title="界面语言" desc="当前版本仅提供简体中文，其他语言在规划中。">
                    <select className="select" value="zh-CN" disabled>
                      <option value="zh-CN">简体中文</option>
                    </select>
                  </SettingRow>
                  <SettingRow title="开机自启" desc="安装版支持写入系统启动项；当前未打包安装，开关仅占位。" badge={<span className="badge">安装版可用</span>}>
                    <Switch checked={bootAutoStart} onChange={setBootAutoStart} disabled />
                  </SettingRow>
                  <SettingRow title="匿名使用统计" desc="仅上报启动次数与错误类型，不含对话内容。默认关闭。">
                    <Switch checked={draft.telemetry} onChange={(v) => patch((d) => (d.telemetry = v))} />
                  </SettingRow>
                </SetCard>

                <SetCard title="目录" sub="文件读写与数据存放位置">
                  <SettingRow
                    title="工作区目录"
                    desc="Agent 读写文件、执行脚本都被限制在此目录内。"
                    wide
                  >
                    <div className="input-inline" style={{ width: '100%' }}>
                      <input className="input mono-text" value={normalizePath(draft.agent.workspaceDir)} placeholder="尚未选择" readOnly />
                      <button
                        type="button"
                        className="suffix-btn"
                        onClick={async () => {
                          const dir = await api.app.pickDirectory();
                          if (dir) patch((d) => (d.agent.workspaceDir = dir));
                        }}
                      >
                        浏览
                      </button>
                    </div>
                  </SettingRow>
                  <SettingRow title="数据目录" desc="设置、对话、索引与日志的存放位置，由系统用户目录决定。" wide>
                    <input className="input mono-text" value={normalizePath(app?.userData)} readOnly />
                  </SettingRow>
                  <SettingRow title="安装目录" desc="当前运行的程序文件位置。" wide>
                    <input className="input mono-text" value={normalizePath(app?.installDir)} readOnly />
                  </SettingRow>
                </SetCard>
              </>
            ) : null}

            {group === 'models' ? (
              <>
                <SetCard title="当前生效" sub={`${providerName} · ${draft.activeModel}`}>
                  <SettingRow
                    title="免费模式"
                    desc="自动优先选择可用的免费渠道（OpenRouter 免费模型 / Groq / 硅基流动 / Ollama）。免费额度耗尽时会提示切换。"
                  >
                    <Switch checked={draft.freeMode} onChange={(v) => patch((d) => (d.freeMode = v))} />
                  </SettingRow>
                  <SettingRow title="思考模型" desc="DeepSeek Reasoner 会输出完整思维链，适合复杂任务；日常问答可用更便宜的 Chat 模型。">
                    <select
                      className="select"
                      value={draft.activeModel}
                      onChange={(e) => patch((d) => (d.activeModel = e.target.value))}
                    >
                      {(draft.providers.find((p) => p.id === draft.activeProviderId)?.models ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </SettingRow>
                </SetCard>

                {draft.providers.map((p) => {
                  const test = tests[p.id];
                  const active = p.id === draft.activeProviderId;
                  const status =
                    test ??
                    (p.status === 'ok'
                      ? { ok: true, latencyMs: 0, message: p.statusMessage ?? '上次检测通过' }
                      : p.status === 'error'
                        ? { ok: false, latencyMs: 0, message: p.statusMessage ?? '上次检测失败' }
                        : null);
                  return (
                    <div className={`provider-card${active ? ' active' : ''}`} key={p.id}>
                      <div className="provider-card-head">
                        <span className="pn">{p.name}</span>
                        {p.free ? <span className="badge free">免费</span> : null}
                        {active ? <span className="badge accent">当前</span> : null}
                        <div className="right">
                          {!active ? (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                patch((d) => {
                                  d.activeProviderId = p.id;
                                  d.activeModel = p.models[0] ?? d.activeModel;
                                });
                              }}
                            >
                              设为当前
                            </button>
                          ) : null}
                          <Switch
                            checked={p.enabled}
                            title={p.enabled ? '停用渠道' : '启用渠道'}
                            onChange={(v) => patchProvider(p.id, { enabled: v })}
                          />
                        </div>
                      </div>

                      <div className="provider-fields">
                        <div>
                          <div className="tiny-label">API Key</div>
                          <div className="input-inline">
                            <input
                              className="input mono-text"
                              type={showKey[p.id] ? 'text' : 'password'}
                              value={p.apiKey}
                              placeholder={p.kind === 'ollama' ? '本地部署无需 Key' : 'sk-…'}
                              onChange={(e) => patchProvider(p.id, { apiKey: e.target.value, status: 'unknown' })}
                            />
                            <button type="button" className="suffix-btn" onClick={() => setShowKey((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}>
                              {showKey[p.id] ? '隐藏' : '显示'}
                            </button>
                          </div>
                        </div>
                        <div>
                          <div className="tiny-label">Base URL</div>
                          <input
                            className="input mono-text"
                            value={p.baseUrl}
                            onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                          />
                        </div>
                        <div className="full">
                          <div className="tiny-label">模型（可直接输入自定义名称）</div>
                          <div className="field-row">
                            <input
                              className="input mono-text"
                              list={`models-${p.id}`}
                              value={p.id === draft.activeProviderId ? draft.activeModel : p.models[0] ?? ''}
                              onChange={(e) => {
                                const model = e.target.value;
                                patch((d) => {
                                  const target = d.providers.find((x) => x.id === p.id);
                                  if (target) target.models = [model, ...target.models.filter((m) => m !== model)];
                                  if (d.activeProviderId === p.id) d.activeModel = model;
                                });
                              }}
                            />
                            <datalist id={`models-${p.id}`}>
                              {p.models.map((m) => (
                                <option value={m} key={m} />
                              ))}
                            </datalist>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={modelsLoading === p.id}
                              onClick={() => void loadModels(p)}
                            >
                              {modelsLoading === p.id ? <span className="spin" /> : null}
                              拉取列表
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="provider-status">
                        <button
                          type="button"
                          className="btn sm"
                          disabled={testing === p.id}
                          onClick={() => void testProvider({ ...p, apiKey: p.apiKey || (p.kind === 'ollama' ? 'local' : '') })}
                        >
                          {testing === p.id ? <span className="spin" /> : null}
                          测试连接
                        </button>
                        {status ? (
                          <span className={`test-result ${status.ok ? 'ok' : 'err'}`}>
                            {status.ok
                              ? `连接成功${status.latencyMs ? ` · ${status.latencyMs}ms` : ''}`
                              : `失败 · ${status.message}`}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--faint)' }}>尚未检测</span>
                        )}
                        {p.checkedAt ? <span>上次检测 {formatDateTime(p.checkedAt)}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : null}

            {group === 'free' ? (
              <>
                <div className="note-card" style={{ marginBottom: 16 }}>
                  <span className="ni">⚡</span>
                  <span>
                    免费渠道适合日常轻量任务与长对话，都有额度限制：OpenRouter 免费模型有每分钟/每日请求上限，
                    Groq 按天刷新配额，硅基流动部分 7B 模型长期免费，Ollama 完全本地但占用本机算力。
                  </span>
                </div>
                <div className="provider-card" style={{ marginBottom: 14 }}>
                  <SettingRow title="免费模式总开关" desc="开启后自动优先选择已启用的免费渠道，额度耗尽的渠道会被跳过。">
                    <Switch checked={draft.freeMode} onChange={(v) => patch((d) => (d.freeMode = v))} />
                  </SettingRow>
                </div>
                {presets
                  .filter((p) => p.free)
                  .map((preset) => {
                    const cfg = draft.providers.find((p) => p.id === preset.id);
                    const ready = Boolean(cfg?.enabled) && (preset.local || Boolean(cfg?.apiKey));
                    return (
                      <div className="provider-card" key={preset.id}>
                        <div className="provider-card-head">
                          <span className="pn">{preset.name}</span>
                          <span className="badge free">免费</span>
                          <span className={`badge ${ready ? 'ok' : ''}`}>{ready ? '已可用' : cfg ? '待补 Key' : '未启用'}</span>
                          <div className="right">
                            {preset.keyUrl ? (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => void api.app.openExternal(preset.keyUrl as string)}
                              >
                                去申请 Key ↗
                              </button>
                            ) : null}
                            <button type="button" className="btn sm primary" onClick={() => fillFree(preset)}>
                              一键填入
                            </button>
                          </div>
                        </div>
                        <div className="field-hint" style={{ marginTop: 7 }}>
                          {preset.note}
                        </div>
                        <div className="field-hint" style={{ marginTop: 3, fontFamily: 'var(--font-mono)' }}>
                          {preset.baseUrl} · {preset.models.slice(0, 3).join(' / ')}
                          {preset.models.length > 3 ? ' …' : ''}
                        </div>
                      </div>
                    );
                  })}
              </>
            ) : null}

            {group === 'persona' ? (
              <>
                <SetCard title="办事风格" sub={`当前：${PERSONAS.find((p) => p.id === draft.persona.preset)?.name ?? '自定义'}`}>
                  <div className="persona-grid" style={{ marginBottom: 14 }}>
                    {PERSONAS.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        className={`persona-card${draft.persona.preset === p.id ? ' active' : ''}`}
                        onClick={() => patch((d) => (d.persona.preset = p.id))}
                      >
                        <span className="pn">{p.name}</span>
                        <span className="pd">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                  {draft.persona.preset === 'custom' ? (
                    <Field label="自定义风格" hint="会作为系统提示的一部分，建议写成可执行的规则。">
                      <textarea
                        className="textarea"
                        rows={4}
                        value={draft.persona.customPrompt}
                        placeholder="例如：只说实话，不确定就标注「未验证」，禁止编造数据。"
                        onChange={(e) => patch((d) => (d.persona.customPrompt = e.target.value))}
                      />
                    </Field>
                  ) : null}
                  <SettingRow title="直给模式" desc="不寒暄、不复述问题、先给结论，去掉免责声明与客套话。">
                    <Switch checked={draft.persona.noFiller} onChange={(v) => patch((d) => (d.persona.noFiller = v))} />
                  </SettingRow>
                  <SettingRow title="结果优先" desc="优先输出可执行的结论、命令与代码，解释放在后面。">
                    <Switch checked={draft.persona.resultFirst} onChange={(v) => patch((d) => (d.persona.resultFirst = v))} />
                  </SettingRow>
                  <SettingRow title="冗长度" desc="1 极简 ～ 5 详尽，影响补充说明与示例数量。">
                    <Slider value={draft.persona.verbosity} min={1} max={5} onChange={(v) => patch((d) => (d.persona.verbosity = v))} format={(v) => `${v} / 5`} />
                  </SettingRow>
                  <SettingRow title="Temperature" desc="越低越稳定，越高越发散。写代码建议 0.2~0.5。">
                    <Slider
                      value={draft.persona.temperature}
                      min={0}
                      max={1.5}
                      step={0.1}
                      onChange={(v) => patch((d) => (d.persona.temperature = v))}
                      format={(v) => v.toFixed(1)}
                    />
                  </SettingRow>
                </SetCard>

                <div className="preview-bubble">
                  <div className="ph">实时预览 · 同样的问题会这样回答</div>
                  <div className="ptext">{personaPreview()}</div>
                </div>
              </>
            ) : null}

            {group === 'token' ? (
              <>
                <SetCard title="省 Token" sub={`预计节省 ${estSaving}%`}>
                  <SettingRow title="启用省 Token" desc="关闭后会把完整历史与工具输出回传模型，费用显著上升。">
                    <Switch checked={draft.tokenSave.enabled} onChange={(v) => patch((d) => (d.tokenSave.enabled = v))} />
                  </SettingRow>
                  <SettingRow title="携带历史消息数" desc="超过轮数的历史会被摘要替代，建议 12~20 条。">
                    <input
                      className="input w-sm"
                      type="number"
                      min={2}
                      max={80}
                      value={draft.tokenSave.maxHistoryMessages}
                      onChange={(e) => patch((d) => (d.tokenSave.maxHistoryMessages = Number(e.target.value) || 0))}
                    />
                  </SettingRow>
                  <SettingRow title="压缩阈值（字符）" desc="上下文超过该长度时触发滚动摘要。">
                    <input
                      className="input w-md"
                      type="number"
                      min={1000}
                      step={1000}
                      value={draft.tokenSave.compressThreshold}
                      onChange={(e) => patch((d) => (d.tokenSave.compressThreshold = Number(e.target.value) || 0))}
                    />
                  </SettingRow>
                  <SettingRow title="工具输出截断" desc="单次工具结果最多回传的字符数，超出部分本地留存。">
                    <input
                      className="input w-md"
                      type="number"
                      min={500}
                      step={500}
                      value={draft.tokenSave.toolOutputLimit}
                      onChange={(e) => patch((d) => (d.tokenSave.toolOutputLimit = Number(e.target.value) || 0))}
                    />
                  </SettingRow>
                  <SettingRow title="不回传思考内容" desc="DeepSeek 官方建议：多轮对话中不把 reasoning 再发给模型。">
                    <Switch
                      checked={draft.tokenSave.skipReasoningResend}
                      onChange={(v) => patch((d) => (d.tokenSave.skipReasoningResend = v))}
                    />
                  </SettingRow>
                  <SettingRow title="稳定前缀命中缓存" desc="固定系统提示前缀，提高缓存命中率，降低输入费用。">
                    <Switch
                      checked={draft.tokenSave.cacheFriendlyPrefix}
                      onChange={(v) => patch((d) => (d.tokenSave.cacheFriendlyPrefix = v))}
                    />
                  </SettingRow>
                  <SettingRow title="最大输出 token" desc="单次回复上限，超出会被截断。">
                    <input
                      className="input w-md"
                      type="number"
                      min={256}
                      step={256}
                      value={draft.tokenSave.maxOutputTokens}
                      onChange={(e) => patch((d) => (d.tokenSave.maxOutputTokens = Number(e.target.value) || 0))}
                    />
                  </SettingRow>
                  <SettingRow title="预算告警（元）" desc="累计费用超过该值时提示，0 表示不限制。">
                    <input
                      className="input w-sm"
                      type="number"
                      min={0}
                      step={5}
                      value={draft.tokenSave.budgetAlertCny}
                      onChange={(e) => patch((d) => (d.tokenSave.budgetAlertCny = Number(e.target.value) || 0))}
                    />
                  </SettingRow>
                </SetCard>
                <div className="note-card">
                  <span className="ni">◈</span>
                  <span>
                    按当前配置，单轮上下文预计减少约 <b>{estSaving}%</b> 的输入 token；
                    单次输出上限 {state.settings.tokenSave.maxOutputTokens} token。
                    关闭「不回传思考」会让每轮多消耗 30%~60% token。
                  </span>
                </div>
              </>
            ) : null}

            {group === 'thinking' ? (
              <SetCard title="思考过程" sub="DeepSeek 风格的可视化推理">
                <SettingRow title="显示思考过程" desc="关闭后不展示推理内容，仅保留最终回答。">
                  <Switch checked={draft.thinking.enabled} onChange={(v) => patch((d) => (d.thinking.enabled = v))} />
                </SettingRow>
                <SettingRow
                  title="强制中文思考"
                  desc="检测到英文思考时自动要求模型重述为中文。关闭后可能出现英文思考内容。"
                  badge={<span className="badge accent">默认开启</span>}
                >
                  <Switch checked={draft.thinking.forceChinese} onChange={(v) => patch((d) => (d.thinking.forceChinese = v))} />
                </SettingRow>
                <SettingRow title="中文占比阈值" desc="低于该比例时触发一次中文重述，建议 0.5~0.7。">
                  <Slider
                    value={draft.thinking.chineseRatioThreshold}
                    min={0.3}
                    max={1}
                    step={0.05}
                    onChange={(v) => patch((d) => (d.thinking.chineseRatioThreshold = v))}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </SettingRow>
                <SettingRow title="显示思考 token" desc="在思考面板标题旁显示估算的 token 数。">
                  <Switch checked={draft.thinking.showTokens} onChange={(v) => patch((d) => (d.thinking.showTokens = v))} />
                </SettingRow>
              </SetCard>
            ) : null}

            {group === 'agent' ? (
              <>
                <SetCard title="授权与安全" sub="决定 Agent 能动手到什么程度">
                  <SettingRow title="授权模式" desc="每次都要：所有工具调用都询问；仅危险操作：读写文件等低风险操作自动放行；从不：完全自动，风险自负。">
                    <Seg<ApprovalMode>
                      value={draft.agent.approvalMode}
                      onChange={(v) => patch((d) => (d.agent.approvalMode = v))}
                      options={[
                        { value: 'always', label: '每次都要' },
                        { value: 'safe-only', label: '仅危险操作' },
                        { value: 'never', label: '从不' },
                      ]}
                    />
                  </SettingRow>
                  <SettingRow title="最大执行步数" desc="单个任务内允许的工具调用轮数，防止死循环。">
                    <input
                      className="input w-sm"
                      type="number"
                      min={1}
                      max={60}
                      value={draft.agent.maxSteps}
                      onChange={(e) => patch((d) => (d.agent.maxSteps = Number(e.target.value) || 1))}
                    />
                  </SettingRow>
                  <SettingRow title="自动分派子 Agent" desc="由总调度自动拆解任务并选择执行者。关闭后只使用当前指定 Agent。">
                    <Switch checked={draft.agent.autoDelegate} onChange={(v) => patch((d) => (d.agent.autoDelegate = v))} />
                  </SettingRow>
                </SetCard>

                <SetCard title="运行环境" sub="执行 Shell 与 Python 的方式">
                  <SettingRow title="Shell 类型" desc="执行命令时使用的解释器。">
                    <select
                      className="select"
                      value={draft.agent.shell}
                      onChange={(e) => patch((d) => (d.agent.shell = e.target.value as SettingsModel['agent']['shell']))}
                    >
                      <option value="powershell">PowerShell</option>
                      <option value="cmd">CMD</option>
                      <option value="bash">Bash (Git Bash / WSL)</option>
                    </select>
                  </SettingRow>
                  <SettingRow title="Python 路径" desc="可填绝对路径或命令名，例如 python / py -3。">
                    <input
                      className="input mono-text"
                      value={draft.agent.pythonPath}
                      onChange={(e) => patch((d) => (d.agent.pythonPath = e.target.value))}
                    />
                  </SettingRow>
                  <SettingRow title="命令超时（毫秒）" desc="超时后会终止进程并返回错误。">
                    <input
                      className="input w-md"
                      type="number"
                      min={1000}
                      step={1000}
                      value={draft.agent.commandTimeout}
                      onChange={(e) => patch((d) => (d.agent.commandTimeout = Number(e.target.value) || 1000))}
                    />
                  </SettingRow>
                </SetCard>

                <SetCard title="危险命令黑名单" sub="每行一条，命中后直接拒绝">
                  <textarea
                    className="textarea mono-text"
                    rows={6}
                    value={denyText}
                    onChange={(e) => setDenyText(e.target.value)}
                    placeholder={'rm -rf /\nformat \nshutdown /s'}
                  />
                  <div className="field-hint" style={{ marginTop: 6 }}>
                    支持子串匹配，保存后生效。建议保留系统级破坏命令，避免误操作。
                  </div>
                </SetCard>
              </>
            ) : null}

            {group === 'mcp' ? (
              <>
                <SetCard title="连接的服务器" sub={`${draft.mcpServers.length} 个配置 · ${state.mcp.filter((m) => m.state === 'ready').length} 个在线`}>
                  {draft.mcpServers.length === 0 ? (
                    <div className="empty-hint">还没有 MCP 服务器，可在「MCP 连接器」页面添加。</div>
                  ) : (
                    draft.mcpServers.map((s) => (
                      <SettingRow
                        key={s.id}
                        title={s.name}
                        desc={`${s.transport.toUpperCase()} · ${s.command ?? s.url ?? ''}`}
                      >
                        <Switch
                          checked={s.enabled}
                          onChange={(v) =>
                            patch((d) => {
                              d.mcpServers = d.mcpServers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x));
                            })
                          }
                        />
                      </SettingRow>
                    ))
                  )}
                </SetCard>
                <div className="note-card">
                  <span className="ni">⌁</span>
                  <span>
                    服务器的添加、重连与工具查看在独立面板中完成，保存设置后不会自动重启进程；
                    如需立即生效请到面板点「重新连接」。
                  </span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      actions.openSettings(false);
                      actions.setView('mcp');
                    }}
                  >
                    打开 MCP 连接器面板 →
                  </button>
                </div>
              </>
            ) : null}

            {group === 'kb' ? (
              <>
                <SetCard title="索引概况" sub="本地向量检索">
                  <div className="kv-list">
                    <div className="kv">
                      <span className="k">来源数量</span>
                      <span className="v">{state.knowledge.length} 个</span>
                    </div>
                    <div className="kv">
                      <span className="k">文档 / 分块</span>
                      <span className="v">
                        {state.knowledge.reduce((n, k) => n + k.files, 0)} / {state.knowledge.reduce((n, k) => n + k.chunks, 0)}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">向量索引</span>
                      <span className="v ok">已就绪</span>
                    </div>
                    <div className="kv">
                      <span className="k">自动监听</span>
                      <span className="v">{state.knowledge.filter((k) => k.watch).length} 个来源</span>
                    </div>
                  </div>
                </SetCard>
                <div className="note-card">
                  <span className="ni">❖</span>
                  <span>
                    知识库只解析本地文本文件，不读取系统目录。开启监听后文件变更会自动重建索引；
                    对话中的引用可直接点开原文件。
                  </span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      actions.openSettings(false);
                      actions.setView('kb');
                    }}
                  >
                    管理知识库来源 →
                  </button>
                </div>
              </>
            ) : null}

            {group === 'memory' ? (
              <SetCard title="长期记忆" sub={`当前 ${state.memory.length} 条`}>
                <SettingRow title="启用记忆" desc="关闭后不再读写任何长期事实。">
                  <Switch checked={draft.memory.enabled} onChange={(v) => patch((d) => (d.memory.enabled = v))} />
                </SettingRow>
                <SettingRow title="跨对话长期记忆" desc="在新对话中也能引用之前的偏好与项目背景。">
                  <Switch checked={draft.memory.longTerm} onChange={(v) => patch((d) => (d.memory.longTerm = v))} />
                </SettingRow>
                <SettingRow title="每轮自动抽取" desc="对话结束后自动提取值得长期记住的信息，会产生少量额外 token。">
                  <Switch checked={draft.memory.autoExtract} onChange={(v) => patch((d) => (d.memory.autoExtract = v))} />
                </SettingRow>
                <SettingRow title="最大条目数" desc="超过上限时按权重淘汰旧条目。">
                  <input
                    className="input w-sm"
                    type="number"
                    min={20}
                    step={20}
                    value={draft.memory.maxFacts}
                    onChange={(e) => patch((d) => (d.memory.maxFacts = Number(e.target.value) || 20))}
                  />
                </SettingRow>
              </SetCard>
            ) : null}

            {group === 'appearance' ? (
              <>
                <SetCard title="主题" sub="深色为默认，浅色同样完整适配">
                  <div className="theme-preview" style={{ marginBottom: 16 }}>
                    {(
                      [
                        { v: 'dark', label: '深色' },
                        { v: 'light', label: '浅色' },
                        { v: 'system', label: '跟随系统' },
                      ] as { v: ThemeMode; label: string }[]
                    ).map((t) => (
                      <button
                        type="button"
                        key={t.v}
                        className={`theme-chip${draft.appearance.theme === t.v ? ' active' : ''}`}
                        onClick={() => patch((d) => (d.appearance.theme = t.v))}
                      >
                        <span className={`bar ${t.v}`}>
                          <i />
                        </span>
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <SettingRow title="主题色" desc="用于按钮、选中态与运行中的流光。">
                    <div className="accent-grid">
                      {ACCENTS.map((a) => (
                        <button
                          type="button"
                          key={a.value}
                          className={`accent-dot${accentOf(draft.appearance.accent).value === a.value ? ' active' : ''}`}
                          style={{ background: `linear-gradient(135deg, ${a.value}, ${a.alt})`, ['--dot' as string]: a.value }}
                          title={a.name}
                          onClick={() => patch((d) => (d.appearance.accent = a.value))}
                        >
                          {accentOf(draft.appearance.accent).value === a.value ? <span className="check">✓</span> : null}
                        </button>
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow title="界面缩放" desc="0.85 ~ 1.20，适合高分屏或小尺寸笔记本。">
                    <Slider
                      value={draft.appearance.zoom}
                      min={0.85}
                      max={1.2}
                      step={0.05}
                      onChange={(v) => patch((d) => (d.appearance.zoom = v))}
                      format={(v) => `${Math.round(v * 100)}%`}
                    />
                  </SettingRow>
                </SetCard>

                <SetCard title="阅读与动效" sub="影响对话区呈现">
                  <SettingRow title="默认折叠思考过程" desc="长对话中减少视觉噪音，展开后可看完整推理。">
                    <Switch
                      checked={draft.appearance.collapseThinking}
                      onChange={(v) => patch((d) => (d.appearance.collapseThinking = v))}
                    />
                  </SettingRow>
                  <SettingRow title="消息区等宽字体" desc="长代码与技术文档阅读更整齐。">
                    <Switch checked={draft.appearance.monoFont} onChange={(v) => patch((d) => (d.appearance.monoFont = v))} />
                  </SettingRow>
                  <SettingRow title="背景装饰" desc="首屏网格、速度线与光晕，关闭后界面更素。">
                    <Switch checked={draft.appearance.decorations} onChange={(v) => patch((d) => (d.appearance.decorations = v))} />
                  </SettingRow>
                </SetCard>
              </>
            ) : null}

            {group === 'update' ? (
              <>
                <div className="update-box">
                  <div className="uh">
                    <span className="badge accent">当前版本</span>
                    <span className="uv">v0.0.1</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--faint)' }}>
                      {updateInfo?.checkedAt ? `上次检查 ${formatDateTime(updateInfo.checkedAt)}` : '尚未检查更新'}
                    </span>
                  </div>
                  {updateInfo ? (
                    <>
                      {updateInfo.available ? (
                        <div className="uvv">
                          <span className="from">v{updateInfo.currentVersion}</span>
                          <span className="arrow">→</span>
                          <span className="to">v{updateInfo.latestVersion}</span>
                          <span className="badge accent">可更新</span>
                          {updateInfo.publishedAt ? (
                            <span className="at">发布于 {formatDateTime(new Date(updateInfo.publishedAt).getTime())}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="un" style={{ borderColor: updateInfo.available ? 'var(--accent-line)' : 'var(--line)' }}>
                        {updateInfo.available
                          ? updateInfo.notes
                          : `已是最新版本 v${updateInfo.currentVersion}，发布时间 ${updateInfo.publishedAt ? formatDateTime(new Date(updateInfo.publishedAt).getTime()) : '—'}。`}
                      </div>
                      {updateInfo.available && updateInfo.assetSha256 ? (
                        <div className="field-hint mono-text" style={{ wordBreak: 'break-all' }}>
                          安装包 SHA-256：{updateInfo.assetSha256}
                        </div>
                      ) : null}
                      <div className="ua">
                        {updateInfo.available ? (
                          <>
                            <button type="button" className="btn primary" onClick={() => void api.update.open()}>
                              打开下载页
                            </button>
                            {updateInfo.releaseUrl ? (
                              <button type="button" className="btn" onClick={() => void api.app.openExternal(updateInfo.releaseUrl as string)}>
                                查看更新说明
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <button type="button" className="btn" onClick={() => void api.app.openExternal('https://github.com/LHRonline/run-worker/releases')}>
                            查看历史版本
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="field-hint" style={{ marginTop: 8 }}>
                      点击「检查更新」从更新源获取最新版本信息。更新只下载安装包，不会静默替换程序。
                    </div>
                  )}
                  <div className="ua">
                    <button
                      type="button"
                      className={`btn${updateChecking ? ' loading' : ''}`}
                      disabled={updateChecking}
                      onClick={async () => {
                        setUpdateChecking(true);
                        const info = await actions.checkUpdate(true);
                        setUpdateInfo(info);
                        setUpdateChecking(false);
                      }}
                    >
                      {updateChecking ? <span className="spin" /> : null}
                      {updateChecking ? '检查中…' : '检查更新'}
                    </button>
                  </div>
                </div>

                <SetCard title="更新策略" sub="通道与更新源">
                  <SettingRow title="更新通道" desc="beta 通道会更早拿到新功能，但稳定性较低。">
                    <Seg<UpdateChannel>
                      value={draft.update.channel}
                      onChange={(v) => patch((d) => (d.update.channel = v))}
                      options={[
                        { value: 'stable', label: 'stable' },
                        { value: 'beta', label: 'beta' },
                      ]}
                    />
                  </SettingRow>
                  <SettingRow title="更新源" desc="GitHub owner/repo 或版本清单 JSON 地址。">
                    <input
                      className="input mono-text"
                      value={draft.update.feed}
                      onChange={(e) => patch((d) => (d.update.feed = e.target.value))}
                    />
                  </SettingRow>
                  <SettingRow title="启动时自动检查" desc="启动后静默检查一次，有新版时在侧栏提示。">
                    <Switch checked={draft.update.autoCheck} onChange={(v) => patch((d) => (d.update.autoCheck = v))} />
                  </SettingRow>
                </SetCard>
              </>
            ) : null}

            {group === 'about' ? (
              <>
                <div className="about-head">
                  <img src="./icon.png" alt="Run worker" />
                  <div>
                    <div className="an">Run worker</div>
                    <div className="av">v0.0.1 · MIT License</div>
                    <div className="ad">桌面端全能 Agent · 多智能体调度的万能系统助手</div>
                  </div>
                </div>

                <SetCard title="运行环境" sub={app?.platform ? `${app.platform} · ${app.arch}` : ''}>
                  <div className="kv-list">
                    <div className="kv">
                      <span className="k">Electron</span>
                      <span className="v">{app?.electron ?? '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Chrome</span>
                      <span className="v">{app?.chrome ?? '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">Node.js</span>
                      <span className="v">{app?.node ?? '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">数据目录</span>
                      <span className="v">{normalizePath(app?.userData) || '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">安装目录</span>
                      <span className="v">{normalizePath(app?.installDir) || '—'}</span>
                    </div>
                    <div className="kv">
                      <span className="k">RUN_WORKER_HOME</span>
                      <span className={`v ${app?.env.RUN_WORKER_HOME ? 'ok' : 'warn'}`}>
                        {app?.env.RUN_WORKER_HOME ?? '未设置（不影响运行）'}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">安装目录已加入 PATH</span>
                      <span className={`v ${app?.env.pathHasInstall ? 'ok' : 'warn'}`}>
                        {app?.env.pathHasInstall ? '是' : '否（命令行工具可能不可用）'}
                      </span>
                    </div>
                  </div>
                </SetCard>

                <SetCard title="链接与许可" sub="开源、可审计">
                  <SettingRow title="GitHub 仓库" desc="问题反馈、更新日志与源码都在这里。">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void api.app.openExternal(app?.repoUrl ?? 'https://github.com/LHRonline/run-worker')}
                    >
                      打开仓库 ↗
                    </button>
                  </SettingRow>
                  <SettingRow title="开源协议" desc="MIT License，可商用、可修改，需保留版权声明。">
                    <span className="badge accent">MIT</span>
                  </SettingRow>
                  <SettingRow title="花费提示" desc="当前会话累计估算费用（按渠道公开单价计算）。">
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
                      {formatCny(state.metas.reduce((n, m) => n + m.usage.costCny, 0))}
                    </span>
                  </SettingRow>
                </SetCard>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="settings-foot">
        <button type="button" className="btn ghost" onClick={() => void resetAll()}>
          恢复默认
        </button>
        <span className="status">
          {draft.providers.length} 个渠道 · {draft.mcpServers.length} 个 MCP · 当前模型 {draft.activeModel}
        </span>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => actions.openSettings(false)}>
          取消
        </button>
        <button type="button" className={`btn primary${saving ? ' loading' : ''}`} onClick={() => void save()}>
          {saving ? <span className="spin" /> : null}
          保存并应用
        </button>
      </div>
    </div>
  );
}

const GROUP_DESC: Record<GroupId, string> = {
  general: '语言、启动行为与本地目录。所有配置只保存在这台电脑上。',
  models: '配置模型渠道与默认模型。Key 仅写入本机配置文件，界面中默认隐藏。',
  free: '零成本或带免费额度的渠道。填入配置后可在不花钱的情况下跑通完整流程。',
  persona: '决定 Run worker 说话的方式：先给结果还是先解释、写多长、语气多重。',
  token: '在效果与成本之间取平衡。默认配置适合大多数日常任务。',
  thinking: 'DeepSeek 风格推理内容的展示与语言控制。思考过程不参与后续上下文回传。',
  agent: '授权策略、执行步数与命令环境。涉及系统修改的操作都会被记录。',
  mcp: '查看已接入的外部能力。详细配置在独立的 MCP 连接器面板中完成。',
  kb: '本地知识库索引概况。添加来源、重建索引与检索测试在知识库面板中完成。',
  memory: '跨对话长期记忆的开关与容量。权重越高越容易被召回。',
  appearance: '主题、主题色、缩放与阅读偏好。浅色主题下所有面板同样保持高对比度。',
  update: '检查新版本与更新通道。更新不会静默安装，需要你手动确认。',
  about: '版本、运行环境、开源协议与环境变量状态。',
};

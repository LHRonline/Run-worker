import { useMemo, useState } from 'react';
import type { McpServerConfig, McpTransport } from '@shared/types';
import { useStore } from '../state/store';
import { Confirm, Modal } from './Modal';
import { Field, Seg, Switch } from './ui';

const EXAMPLE_CONFIGS: { title: string; desc: string; command: string; args: string[]; note: string }[] = [
  {
    title: 'filesystem',
    desc: '读写工作区文件，官方参考实现，限制在指定目录内。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/RunWorker/工作区'],
    note: 'npx -y @modelcontextprotocol/server-filesystem D:/RunWorker/工作区',
  },
  {
    title: 'fetch',
    desc: '抓取网页并转换为可读文本，供资料研究 Agent 使用。',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    note: 'uvx mcp-server-fetch',
  },
];

const STATE_TEXT: Record<string, { text: string; cls: string }> = {
  ready: { text: '已连接', cls: 'ok' },
  starting: { text: '正在启动', cls: 'info' },
  error: { text: '连接失败', cls: 'err' },
  stopped: { text: '未启用', cls: '' },
};

function blankConfig(): McpServerConfig {
  return {
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {},
    enabled: true,
    autoStart: true,
    description: '',
  };
}

export function McpPanel() {
  const { state, actions } = useStore();
  const [form, setForm] = useState<McpServerConfig | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; tools: typeof state.mcpTools }>();
    for (const tool of state.mcpTools) {
      const entry = map.get(tool.serverId) ?? { name: tool.serverName, tools: [] };
      entry.tools.push(tool);
      map.set(tool.serverId, entry);
    }
    return [...map.entries()];
  }, [state.mcpTools]);

  const readyCount = state.mcp.filter((s) => s.state === 'ready').length;

  return (
    <div className="main">
      <div className="page">
        <div className="page-scroll">
          <div className="page-inner">
            <div className="page-head">
              <div className="lead">
                <h2 className="page-title">
                  MCP 连接器
                  <span className="badge ok">{readyCount} 个在线</span>
                </h2>
                <p className="page-sub">
                  通过 Model Context Protocol 把外部能力接进来：文件系统、网页抓取、数据库、内部服务。
                  连接后工具会自动出现在对应 Agent 的可用清单里。
                </p>
              </div>
              <div className="page-actions">
                <button type="button" className="btn" onClick={() => void actions.refreshMcp()}>
                  刷新状态
                </button>
                <button type="button" className="btn primary" onClick={() => setForm(blankConfig())}>
                  ＋ 添加服务器
                </button>
              </div>
            </div>

            {state.mcp.length === 0 ? (
              <div className="empty-hint">还没有 MCP 服务器。可以从下方示例一键填入，或手动添加一个 stdio / http 服务。</div>
            ) : (
              <div className="source-list">
                {state.mcp.map((server) => {
                  const cfg = state.settings.mcpServers.find((x) => x.id === server.id);
                  const st = STATE_TEXT[server.state] ?? STATE_TEXT.stopped;
                  const toolCount = state.mcpTools.filter((t) => t.serverId === server.id).length;
                  return (
                    <div className="mcp-row" key={server.id}>
                      <span className={`status-dot ${server.state}`} />
                      <div className="mcp-main">
                        <div className="mcp-name">
                          {server.name}
                          <span className={`badge ${st.cls}`}>{st.text}</span>
                          <span className="tr">{cfg?.transport ?? 'stdio'}</span>
                        </div>
                        <div className="mcp-desc">{cfg?.description || cfg?.command || cfg?.url || '无描述'}</div>
                        <div className="mcp-meta">
                          <span>{toolCount} 个工具</span>
                          {server.message ? <span style={{ color: server.state === 'error' ? 'var(--err)' : 'var(--faint)' }}>{server.message}</span> : null}
                        </div>
                      </div>
                      <div className="task-actions">
                        <Switch
                          checked={cfg?.enabled ?? server.state === 'ready'}
                          title={cfg?.enabled ? '停用连接器' : '启用连接器'}
                          onChange={(v) => void actions.toggleMcp(server.id, v)}
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          title="重新连接"
                          disabled={reconnecting === server.id}
                          onClick={async () => {
                            setReconnecting(server.id);
                            await actions.connectMcp(server.id);
                            setReconnecting(null);
                          }}
                        >
                          {reconnecting === server.id ? <span className="spin" /> : '↻'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除连接器"
                          onClick={() => setRemoving({ id: server.id, name: server.name })}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="section-title">
              已发现工具
              <span className="hint">按服务器分组，折叠查看</span>
            </div>
            {grouped.length === 0 ? (
              <div className="empty-hint">连接成功的服务器会在这里列出全部工具与用途说明。</div>
            ) : (
              grouped.map(([id, group]) => {
                const open = openGroups[id] !== false;
                return (
                  <div className="tool-group" key={id}>
                    <button
                      type="button"
                      className="tool-group-head"
                      onClick={() => setOpenGroups((prev) => ({ ...prev, [id]: !open }))}
                    >
                      <span className="status-dot ready" />
                      {group.name}
                      <span className="n">{open ? '▾' : '▸'} {group.tools.length} 个工具</span>
                    </button>
                    {open ? (
                      <div className="tool-tags">
                        {group.tools.map((t) => (
                          <span className="tool-tag" key={`${t.serverId}-${t.name}`} title={t.description}>
                            {t.name}
                            <span className="d">{t.description}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}

            <div className="section-title">
              内置示例
              <span className="hint">只填入表单，不会自动启用</span>
            </div>
            <div className="example-grid">
              {EXAMPLE_CONFIGS.map((ex) => (
                <div className="example-card" key={ex.title}>
                  <div className="et">
                    <span>⌁</span>
                    {ex.title}
                    <span className="badge" style={{ marginLeft: 'auto' }}>
                      stdio
                    </span>
                  </div>
                  <div className="ed">{ex.desc}</div>
                  <div className="ecmd">{ex.note}</div>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ marginTop: 8 }}
                    onClick={() =>
                      setForm({
                        ...blankConfig(),
                        name: ex.title,
                        command: ex.command,
                        args: ex.args,
                        description: ex.desc,
                        enabled: false,
                        autoStart: false,
                      })
                    }
                  >
                    填入示例
                  </button>
                </div>
              ))}
            </div>

            <div className="note-card" style={{ marginTop: 18 }}>
              <span className="ni">◈</span>
              <span>
                stdio 服务器会作为子进程启动，需要在环境变量中提供运行时（如 Node 的 npx、Python 的 uvx）。
                http 服务器走 Streamable HTTP，可附带自定义请求头。所有连接失败原因会显示在状态行。
              </span>
            </div>
          </div>
        </div>
      </div>

      {form ? (
        <McpEditor
          initial={form}
          onClose={() => setForm(null)}
          onSave={async (cfg) => {
            await actions.addMcp(cfg);
            setForm(null);
          }}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="删除 MCP 连接器"
          text={`「${removing.name}」的配置与已注册工具会被移除，其他 Agent 将无法再调用它。`}
          onClose={() => setRemoving(null)}
          onConfirm={() => void actions.removeMcp(removing.id)}
        />
      ) : null}
    </div>
  );
}

function McpEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: McpServerConfig;
  onClose(): void;
  onSave(cfg: McpServerConfig): Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [transport, setTransport] = useState<McpTransport>(initial.transport);
  const [command, setCommand] = useState(initial.command ?? '');
  const [args, setArgs] = useState((initial.args ?? []).join(' '));
  const [url, setUrl] = useState(initial.url ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [autoStart, setAutoStart] = useState(initial.autoStart);
  const [env, setEnv] = useState<{ k: string; v: string }[]>(
    Object.entries(initial.env ?? {}).map(([k, v]) => ({ k, v })),
  );
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && (transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const envObj: Record<string, string> = {};
    for (const pair of env) {
      if (pair.k.trim()) envObj[pair.k.trim()] = pair.v;
    }
    await onSave({
      id: initial.id || `mcp-${Date.now().toString(36)}`,
      name: name.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: transport === 'stdio' ? args.split(/\s+/).filter(Boolean) : undefined,
      url: transport === 'http' ? url.trim() : undefined,
      env: envObj,
      enabled,
      autoStart,
      description: description.trim(),
    });
    setSaving(false);
  };

  return (
    <Modal
      title={initial.name ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
      subtitle="保存后可随时启用、重连或删除"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className={`btn primary${saving ? ' loading' : ''}`} disabled={!valid} onClick={() => void save()}>
            {saving ? <span className="spin" /> : null}
            保存服务器
          </button>
        </>
      }
    >
      <div className="provider-fields" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Field label="名称" required>
          <input className="input" value={name} placeholder="例如 filesystem" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="传输方式">
          <Seg<McpTransport>
            value={transport}
            onChange={setTransport}
            options={[
              { value: 'stdio', label: 'stdio 本地进程' },
              { value: 'http', label: 'HTTP 远程' },
            ]}
          />
        </Field>
      </div>

      {transport === 'stdio' ? (
        <div className="provider-fields">
          <Field label="启动命令" hint="例如 npx、uvx、node。" required>
            <input className="input mono-text" value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field label="参数" hint="用空格分隔，包含空格的路径请避免使用空格。">
            <input
              className="input mono-text"
              value={args}
              placeholder="-y @modelcontextprotocol/server-filesystem D:/工作区"
              onChange={(e) => setArgs(e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <Field label="服务地址" hint="Streamable HTTP 端点，例如 https://mcp.example.com/mcp。" required>
          <input className="input mono-text" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </Field>
      )}

      <Field label="描述" hint="会显示在连接器列表，帮助 Agent 判断何时使用。">
        <input className="input" value={description} placeholder="例如：读写工作区文件" onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="field">
        <div className="field-label" style={{ justifyContent: 'space-between' }}>
          <span>环境变量</span>
          <button type="button" className="btn sm" onClick={() => setEnv((prev) => [...prev, { k: '', v: '' }])}>
            ＋ 添加
          </button>
        </div>
        {env.length === 0 ? (
          <div className="field-hint">无需环境变量时可留空。密钥类变量只会保存在本机配置中。</div>
        ) : (
          env.map((pair, i) => (
            <div className="env-row" key={i}>
              <input
                className="input"
                placeholder="KEY"
                value={pair.k}
                onChange={(e) => setEnv((prev) => prev.map((p, j) => (j === i ? { ...p, k: e.target.value } : p)))}
              />
              <input
                className="input"
                placeholder="VALUE"
                value={pair.v}
                onChange={(e) => setEnv((prev) => prev.map((p, j) => (j === i ? { ...p, v: e.target.value } : p)))}
              />
              <button
                type="button"
                className="icon-btn"
                title="删除变量"
                onClick={() => setEnv((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="set-row">
        <div className="set-row-main">
          <div className="set-row-title">添加后立即启用</div>
          <div className="set-row-desc">关闭时只保存配置，不启动进程，也不会出现在工具清单里。</div>
        </div>
        <div className="set-row-ctrl">
          <Switch checked={enabled} onChange={setEnabled} />
        </div>
      </div>
      <div className="set-row" style={{ borderBottom: 'none' }}>
        <div className="set-row-main">
          <div className="set-row-title">应用启动时自动连接</div>
          <div className="set-row-desc">开启后每次启动 Run worker 都会自动拉起该服务器。</div>
        </div>
        <div className="set-row-ctrl">
          <Switch checked={autoStart} onChange={setAutoStart} />
        </div>
      </div>
    </Modal>
  );
}

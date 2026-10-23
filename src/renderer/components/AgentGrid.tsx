import { useStore } from '../state/store';

export function AgentGrid() {
  const { state, actions } = useStore();

  return (
    <div className="main">
      <div className="page">
        <div className="page-scroll">
          <div className="page-inner">
            <div className="page-head">
              <div className="lead">
                <h2 className="page-title">
                  Agent 广场
                  <span className="badge accent">{state.agents.length} 个执行者</span>
                </h2>
                <p className="page-sub">
                  主 Agent「总调度」会按任务自动调度，也可以在下方手动指定一个 Agent 直接开工。
                  无论谁执行，危险操作都会按你的授权策略先征求确认。
                </p>
              </div>
              <div className="page-actions">
                <span className="pill">
                  <span className="status-dot ready" />
                  当前模型 {state.settings.activeModel}
                </span>
              </div>
            </div>

            <div className="agent-grid">
              {state.agents.map((agent) => (
                <button
                  type="button"
                  className="agent-card"
                  key={agent.id}
                  style={{ ['--agent-color' as string]: agent.color }}
                  onClick={() => void actions.newConversation(agent.id, agent.name)}
                >
                  <div className="top">
                    <span className="agent-icon">{agent.icon}</span>
                    <div>
                      <div className="agent-name">
                        {agent.name}
                        {agent.id === 'orchestrator' ? <span className="role">主 Agent</span> : null}
                      </div>
                      <div className="card-sub">{agent.tagline}</div>
                    </div>
                  </div>
                  <div className="agent-tagline">{agent.description}</div>
                  <div className="agent-caps">
                    {agent.capabilities.map((c) => (
                      <span className="cap" key={c}>
                        {c}
                      </span>
                    ))}
                  </div>
                  <div className="foot">
                    <span>{agent.tools.length} 个可用工具</span>
                    <span style={{ opacity: 0.6 }}>·</span>
                    <span>{agent.requiresImageGen ? '需图像能力' : agent.requiresVision ? '需视觉模型' : '文本模型即可'}</span>
                    <span className="go">开始对话 →</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="note-card" style={{ marginTop: 20 }}>
              <span className="ni">◎</span>
              <span>
                不确定该用谁？直接在对话里描述目标即可。总调度会先拆解任务，再选择最合适的执行者，
                必要时串联多个 Agent 完成一条完整流程。
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

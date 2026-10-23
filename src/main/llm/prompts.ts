/**
 * Run worker — 系统提示词拼装
 * 顺序固定（身份风格 → 硬规则 → Agent 职责 → 记忆 → 知识库 → 输出约束），
 * 保证前缀稳定以命中服务商的前缀缓存。
 */
import { DEFAULT_PERSONA_PROMPTS } from '../../shared/presets';
import type { AgentDescriptor, PersonaSettings, Settings } from '../../shared/types';

export interface PromptParts {
  persona: PersonaSettings;
  agent: AgentDescriptor;
  /** Agent 专属职责说明 */
  duty: string;
  /** 长期记忆摘要 */
  memory?: string;
  /** 知识库检索上下文 */
  knowledge?: string;
  /** 工作目录，便于模型使用相对路径 */
  workspaceDir?: string;
  /** 本轮是否可用工具 */
  toolsEnabled: boolean;
  /** 是否开启思考 */
  thinking: boolean;
  /** 自定义补充说明 */
  extra?: string;
}

const VERBOSITY_RULES: Record<number, string> = {
  1: '字数上限：3 行以内。只给结论或命令，不解释。',
  2: '字数上限：200 字。先给结论，再列最多 3 条要点。',
  3: '先给结论，再给关键步骤；必要时补一个最小示例。',
  4: '分节展开：结论 → 步骤 → 原理 → 常见坑。允许 500~800 字。',
  5: '详尽回答：结论、步骤、示例、风险、替代方案都要覆盖，可以长。',
};

function personaBlock(persona: PersonaSettings): string {
  const base = persona.preset === 'custom'
    ? (persona.customPrompt || '').trim() || DEFAULT_PERSONA_PROMPTS.balanced
    : DEFAULT_PERSONA_PROMPTS[persona.preset] || DEFAULT_PERSONA_PROMPTS.balanced;
  const lines = [base.trim()];
  if (persona.resultFirst) lines.push('优先给可执行结论、命令或代码，解释放在后面并按需省略。');
  if (persona.noFiller) {
    lines.push('不寒暄、不复述问题、不输出免责声明，第一句就是结论。');
    lines.push('禁止「好的」「当然可以」「希望对你有帮助」这类填充语。');
  }
  const v = Math.min(5, Math.max(1, Math.round(persona.verbosity)));
  lines.push(VERBOSITY_RULES[v]);
  return lines.filter(Boolean).join('\n');
}

function hardRules(parts: PromptParts): string {
  const rules = [
    '事实优先：不确定就直说不确定，并给出验证办法，禁止编造 API、路径、文件内容或运行结果。',
    '不要假装做过没做的事：没有调用工具就说没做，工具失败就如实报告失败原因。',
    '给命令、路径、代码时直接可用，不要留 TODO 占位。',
  ];
  if (parts.toolsEnabled) {
    rules.push('需要真实数据或真实改动时先调用工具，不要凭猜测作答；同一工具不要反复用相同参数重试。');
  }
  if (parts.thinking) {
    rules.push('思考过程（reasoning）必须使用简体中文，即使提问是英文也用中文思考。');
  }
  if (parts.workspaceDir) {
    rules.push(`当前工作目录：${parts.workspaceDir}（相对路径基于此目录）。`);
  }
  return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

function dutyBlock(parts: PromptParts): string {
  const { agent } = parts;
  return [
    `当前身份：${agent.name}（${agent.id}）— ${agent.tagline}`,
    agent.description,
    `能力范围：${agent.capabilities.join('、')}`,
    parts.duty,
    '只做本职范围内的判断；需要别的能力时说明该交给哪个子 Agent，不要越权硬做。',
  ]
    .filter(Boolean)
    .join('\n');
}

function memoryBlock(parts: PromptParts): string {
  const text = (parts.memory || '').trim();
  if (!text) return '';
  return `以下是用户长期偏好与事实（已在历史中确认，可直接采用，无需再问）：\n${text}`;
}

function knowledgeBlock(parts: PromptParts): string {
  const text = (parts.knowledge || '').trim();
  if (!text) return '';
  return `以下是从用户本地知识库检索到的片段，回答涉及这些内容时以此为准，并标注来源：\n${text}`;
}

function formatBlock(): string {
  return [
    '输出格式：',
    '- 使用简体中文；代码、命令、标识符保留原文。',
    '- Markdown 渲染：标题从 ### 起，不要用一级标题；表格只用于真正的对比。',
    '- 代码块必须标注语言。',
    '- 涉及文件时给出完整路径；涉及命令时说明在哪个目录执行。',
  ].join('\n');
}

/** 拼装系统提示词；各段缺失时自动跳过，保持前缀稳定 */
export function buildSystemPrompt(parts: PromptParts): string {
  const sections: string[] = [
    `你是 Run worker 的桌面端执行助手。\n\n## 身份与风格\n${personaBlock(parts.persona)}`,
    `## 硬规则\n${hardRules(parts)}`,
    `## 当前职责\n${dutyBlock(parts)}`,
  ];
  const mem = memoryBlock(parts);
  if (mem) sections.push(`## 长期记忆\n${mem}`);
  const kb = knowledgeBlock(parts);
  if (kb) sections.push(`## 知识库上下文\n${kb}`);
  sections.push(`## 输出约束\n${formatBlock()}`);
  if (parts.extra && parts.extra.trim()) sections.push(`## 补充\n${parts.extra.trim()}`);
  return sections.join('\n\n');
}

/** 路由/抽取类轻量调用使用的紧凑系统提示 */
export function buildUtilityPrompt(task: string): string {
  return [
    '你在 Run worker 内部负责轻量判定任务，不需要与用户对话。',
    task,
    '只输出要求的格式，不要解释，不要加代码块围栏。',
  ].join('\n');
}

/** 演示模式（未配置 Key）下的说明文本 */
export function demoSetupGuide(settings: Settings): string {
  const hasProvider = settings.providers.some((p) => p.apiKey.trim());
  const head = hasProvider
    ? '当前选中的服务商没有可用 Key。'
    : '还没有配置任何大模型 API Key。';
  return [
    head,
    '',
    '任选一条免费路径，填入「设置 → 模型服务」即可开始真实对话：',
    '',
    '1. **OpenRouter 免费模型**：https://openrouter.ai/keys 领取 Key，模型选带 `:free` 后缀的（如 `deepseek/deepseek-r1:free`）。零成本，有每分钟限额。',
    '2. **Groq 免费额度**：https://console.groq.com/keys 领 Key，Base URL 用 `https://api.groq.com/openai/v1`，模型 `llama-3.3-70b-versatile`，速度极快。',
    '3. **硅基流动**：https://cloud.siliconflow.cn/account/ak 注册送额度，免费模型如 `Qwen/Qwen2.5-7B-Instruct`，国内直连。',
    '4. **Ollama 本地**：装好 Ollama 后执行 `ollama pull qwen2.5:7b`，Base URL 填 `http://localhost:11434/v1`，完全离线零成本。',
    '',
    '配置完成后点「测试连接」，通过即可正常使用全部 Agent 与工具能力。',
  ].join('\n');
}

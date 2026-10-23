/**
 * Run worker — 演示模式
 * 没有任何可用 Key 时也能对话：本地规则生成中文回复，并照常流式输出。
 */
import type { AgentId, Settings } from '../../shared/types';
import { demoSetupGuide } from '../llm/prompts';
import { agentDescriptor } from '../agents/registry';

const GREETING = /^(你好|您好|hi|hello|hey|在吗|有人吗)[\s!！。.~]*$/i;
const ASK_CONFIG = /怎么(配置|设置|用)|如何(配置|设置)|免费|api key|apikey|没(有)?key|不能用|报错/i;
const ASK_ABILITY = /能做什么|会什么|有什么功能|支持什么|介绍下|你是谁/i;

export interface DemoOptions {
  text: string;
  agentId: AgentId;
  settings: Settings;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** 正文之前的推理增量（中文），让首屏也能看到思考过程 */
  onThinking?: (text: string) => void;
}

export interface DemoResult {
  text: string;
  thinking: string;
}

const PATHS_BRIEF = [
  '免费可用的四条路径：',
  '- OpenRouter 免费模型（https://openrouter.ai/keys，模型名带 `:free`）',
  '- Groq 免费额度（https://console.groq.com/keys，速度最快）',
  '- 硅基流动（https://cloud.siliconflow.cn/account/ak，国内直连）',
  '- Ollama 本地（`http://localhost:11434/v1`，装好即用，完全离线）',
].join('\n');

function abilityText(): string {
  return [
    '我能做的事按 Agent 分工：',
    '',
    '- **代码工坊**：读写项目文件、生成代码、跑构建与测试、修报错。',
    '- **电脑操控**：执行 PowerShell/Python、批量整理文件、查进程端口（危险命令会先问你）。',
    '- **资料研究**：检索本地知识库、抓网页、给出带引用的结论。',
    '- **图像 / 视频 / 3D**：出图、出短视频方案、导出模型脚本。',
    '- **数据分析**：清洗表格、统计、出图表。',
    '- **定时任务**：按 cron 或固定间隔自动跑同一件事。',
  ].join('\n');
}

function buildBody(text: string, settings: Settings, agentId: AgentId): string {
  const agent = agentDescriptor(agentId);
  if (GREETING.test(text.trim())) {
    return [
      '在。不过现在是**演示模式**——还没有可用的模型 API Key，所以我只能用本地规则回答，无法真正理解复杂任务。',
      '',
      abilityText(),
      '',
      '配置一个免费 Key 后（一分钟就能搞定），这些能力全部可真实执行。',
      '',
      PATHS_BRIEF,
    ].join('\n');
  }

  if (ASK_CONFIG.test(text)) {
    return ['先说明：现在没有可用 Key，处于演示模式。', '', demoSetupGuide(settings)].join('\n');
  }

  if (ASK_ABILITY.test(text)) {
    return [abilityText(), '', PATHS_BRIEF].join('\n');
  }

  return [
    `收到：「${text.trim().slice(0, 80)}」。`,
    '',
    `这类任务按分工应该交给 **${agent.name}**（${agent.tagline}）。但当前处于**演示模式**：没有可用的模型 API Key，我无法真正规划步骤、调用工具或生成内容，也不会假装已经做完。`,
    '',
    demoSetupGuide(settings),
    '',
    '配好 Key 后把这句需求再发一次，我会直接开工。',
  ].join('\n');
}

/** 演示模式的"思考"：贴合输入的中文推理，30~60 字 */
function buildThinking(text: string, agentId: AgentId): string {
  const agent = agentDescriptor(agentId);
  const raw = text.replace(/\s+/g, ' ').trim();
  let intent: string;
  if (GREETING.test(raw)) intent = '打招呼';
  else if (ASK_CONFIG.test(raw)) intent = '询问怎么配置模型';
  else if (ASK_ABILITY.test(raw)) intent = '了解我的能力边界';
  else intent = `「${raw.slice(0, 18)}」`;

  return `用户这句话的意图是${intent}，按分工应交给${agent.name}。当前没有可用 API Key，不能假装已执行，先说明演示模式并给出免费配置路径。`;
}

/** 按小块推送，保持与真实流式一致的体验 */
export async function streamDemoReply(opts: DemoOptions): Promise<DemoResult> {
  const thinking = buildThinking(opts.text, opts.agentId);
  const body = buildBody(opts.text, opts.settings, opts.agentId);

  // 先思考再正文，与真实模型的输出节奏一致
  const thinkChars = [...thinking];
  const thinkChunk = 8;
  for (let i = 0; i < thinkChars.length; i += thinkChunk) {
    if (opts.signal.aborted) break;
    opts.onThinking?.(thinkChars.slice(i, i + thinkChunk).join(''));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const chars = [...body];
  const chunkSize = 6;
  for (let i = 0; i < chars.length; i += chunkSize) {
    if (opts.signal.aborted) break;
    opts.onDelta(chars.slice(i, i + chunkSize).join(''));
    // 20ms 一块，整段大约 1~3 秒，避免瞬间刷完显得假
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { text: body, thinking };
}

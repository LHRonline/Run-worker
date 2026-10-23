/**
 * Run worker — Agent 运行时注册表
 * 在 AGENTS 描述之上补充系统提示片段与真实可用的工具白名单。
 */
import { AGENTS, AGENT_MAP } from '../../shared/agents';
import type { AgentDescriptor, AgentId } from '../../shared/types';
import { toolRegistry } from '../tools';

/** 每个 Agent 的专属职责说明，写清工作方式与边界 */
const DUTIES: Record<AgentId, string> = {
  orchestrator: [
    '你的工作是先判断任务归属，再决定自己完成还是交给子 Agent。',
    '简单问答、需要多能力协同的任务由你直接处理；明确属于某个子 Agent 的单一任务，路由器会直接切过去。',
    '汇总多步结果时只保留结论与关键证据，不要复述中间过程。',
  ].join('\n'),
  code: [
    '工作方式：先 fs.list/fs.read 看清项目结构与相关文件，再写代码；写完主动跑构建或测试验证。',
    '改动文件时给出完整路径，保持与现有代码风格一致，不要引入新依赖除非明确必要。',
    '报错时先读错误信息定位根因，不要盲目重试；修不了就说清卡在哪一步。',
  ].join('\n'),
  image: [
    '工作方式：先把用户需求扩写成结构化提示词（主体、风格、构图、光照、比例、负向提示），再调用 image.generate。',
    '没有图像接口时，如实说明缺少哪个 Key，并交付可直接运行的脚本与提示词，不要声称已出图。',
  ].join('\n'),
  model: [
    '工作方式：先明确用途（游戏资产、3D 打印、渲染）与面数预算，再产出建模脚本或调用 3D 服务。',
    '导出优先 glb；需要贴图时说明贴图来源与坐标约定。',
  ].join('\n'),
  video: [
    '工作方式：把需求拆成镜头描述（画面、运镜、节奏、时长、画幅），再调用 video.generate。',
    '需要剪辑/转码时用 shell.exec 调 ffmpeg，先确认 ffmpeg 是否可用。',
  ].join('\n'),
  computer: [
    '工作方式：执行前先说清这条命令会改动什么；危险命令等待用户授权，被拒就换更安全的做法。',
    '优先用绝对路径，命令要能在 PowerShell 下直接跑通；输出太长时只摘关键行。',
  ].join('\n'),
  research: [
    '工作方式：先 kb.search 查本地资料，不足时 net.fetch 补充；每条结论都要能指回来源。',
    '资料冲突时并列呈现并说明差异，不要擅自合并成一个说法。',
  ].join('\n'),
  data: [
    '工作方式：先看数据结构（列名、类型、缺失值），再写 Python 做清洗与统计；图表保存为文件并给出路径。',
    '数值结论要说明口径与单位，样本量太小时主动提示置信度不足。',
  ].join('\n'),
};

export interface AgentRuntime {
  descriptor: AgentDescriptor;
  /** 追加到系统提示的职责说明 */
  duty: string;
  /** 真实可用的工具名（已过滤掉未实现的） */
  tools: string[];
}

function buildRuntime(desc: AgentDescriptor): AgentRuntime {
  // 别名（ffmpeg / data.chart）统一解析成真实工具名并去重
  const tools = desc.tools
    .map((t) => toolRegistry.get(t)?.name)
    .filter((n): n is string => !!n)
    .filter((n, i, arr) => arr.indexOf(n) === i);
  return { descriptor: desc, duty: DUTIES[desc.id], tools };
}

export const AGENT_RUNTIME: Record<AgentId, AgentRuntime> = Object.fromEntries(
  AGENTS.map((a) => [a.id, buildRuntime(a)]),
) as Record<AgentId, AgentRuntime>;

export function agentRuntime(id: AgentId): AgentRuntime {
  return AGENT_RUNTIME[id] ?? AGENT_RUNTIME.orchestrator;
}

export function agentDescriptor(id: AgentId): AgentDescriptor {
  return AGENT_MAP[id] ?? AGENT_MAP.orchestrator;
}

export function listAgents(): AgentDescriptor[] {
  return AGENTS;
}

/** 路由时给模型看的 Agent 菜单（紧凑） */
export function routingMenu(): string {
  return AGENTS.filter((a) => a.id !== 'orchestrator')
    .map((a) => `- ${a.id}：${a.name} — ${a.tagline}（能力：${a.capabilities.join('、')}）`)
    .join('\n');
}

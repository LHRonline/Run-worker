/**
 * Run worker — 编排器：先路由，再以子 Agent 身份进入工具循环
 */
import type { AgentId, RunEvent, Settings, ToolCallRecord } from '../../shared/types';
import { completeText, streamChat } from '../llm/client';
import type { LlmMessage, LlmTarget, RawUsage, LlmToolSchema } from '../llm/client';
import { truncateMiddle } from '../tools/types';
import type { ToolRuntime } from '../tools/types';
import { toolRegistry } from '../tools';
import type { ToolRegistry } from '../tools';
import { agentRuntime, listAgents } from './registry';

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export interface RouteStep {
  agentId: AgentId;
  goal: string;
}

export interface RouteDecision {
  agentId: AgentId;
  steps: RouteStep[];
  reason: string;
  /** 是否由模型判定（否则是关键词兜底） */
  usedLlm: boolean;
}

const AGENT_IDS: AgentId[] = ['orchestrator', 'code', 'image', 'model', 'video', 'computer', 'research', 'data'];

const KEYWORDS: Array<{ agentId: AgentId; words: RegExp }> = [
  { agentId: 'image', words: /画|插画|海报|封面|图标|logo|配图|生成图|image|图片.*生成|文生图|图生图/i },
  { agentId: 'video', words: /视频|短片|剪辑|转码|ffmpeg|字幕|镜头|video/i },
  { agentId: 'model', words: /3d|三维|建模|模型文件|glb|gltf|obj 文件|mesh/i },
  { agentId: 'code', words: /代码|函数|写个脚本|重构|bug|报错|编译|构建|测试|接口实现|typescript|python 脚本|组件/i },
  { agentId: 'data', words: /csv|excel|表格|数据清洗|统计|透视|图表|相关性|回归|均值/i },
  { agentId: 'research', words: /查一下|检索|资料|文档里|知识库|总结这篇|对比|调研|来源|引用/i },
  { agentId: 'computer', words: /执行命令|跑一下|安装|删除文件|进程|端口|环境变量|批量改名|powershell|cmd|cmd 命令/i },
];

function ruleRoute(text: string, current: AgentId, autoDelegate: boolean): RouteDecision {
  const body = (text || '').slice(0, 2000);
  if (autoDelegate) {
    for (const rule of KEYWORDS) {
      if (rule.words.test(body)) {
        return {
          agentId: rule.agentId,
          steps: [{ agentId: rule.agentId, goal: body.slice(0, 120) }],
          reason: '关键词规则命中',
          usedLlm: false,
        };
      }
    }
  }
  return {
    agentId: current,
    steps: [{ agentId: current, goal: body.slice(0, 120) }],
    reason: autoDelegate ? '未命中特定领域，由总调度处理' : '已关闭自动分派，由当前 Agent 处理',
    usedLlm: false,
  };
}

function parseRouteJson(raw: string): { agentId?: string; steps?: unknown; reason?: string } | null {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { agentId?: string; steps?: unknown; reason?: string };
  } catch {
    return null;
  }
}

export interface RouteOptions {
  text: string;
  current: AgentId;
  settings: Settings;
  /** 可用的轻量模型；为 null 时只用规则 */
  target: LlmTarget | null;
  signal?: AbortSignal;
}

const ROUTE_SYSTEM = [
  '判断用户这句话该由哪个子 Agent 执行。可选值：',
  ...listAgents()
    .filter((a) => a.id !== 'orchestrator')
    .map((a) => `${a.id}（${a.name}）：${a.tagline}`),
  '如果任务简单、闲聊、或需要综合多个能力，用 orchestrator。',
  '',
  '只输出 JSON，格式：',
  '{"agentId":"code","steps":[{"agentId":"code","goal":"一句话描述这一步做什么"}],"reason":"一句话理由"}',
  'steps 只在任务确实需要多步时给 2~4 步；单步任务就给 1 步。',
].join('\n');

/** 一次轻量调用判断归属；失败或无 Key 时退回关键词规则 */
export async function routeTask(opts: RouteOptions): Promise<RouteDecision> {
  const { text, current, settings, target } = opts;
  const fallback = ruleRoute(text, current, settings.agent.autoDelegate);
  if (!settings.agent.autoDelegate) return fallback;
  if (!target) return fallback;

  try {
    const raw = await completeText(target, `用户消息：\n${text.slice(0, 1200)}`, {
      system: ROUTE_SYSTEM,
      temperature: 0,
      maxTokens: 220,
      json: true,
      signal: opts.signal,
      timeoutMs: 20_000,
    });
    const parsed = parseRouteJson(raw);
    if (!parsed) return fallback;
    const agentId = (parsed.agentId ?? '').trim() as AgentId;
    if (!AGENT_IDS.includes(agentId)) return fallback;

    const steps: RouteStep[] = Array.isArray(parsed.steps)
      ? (parsed.steps as Array<Record<string, unknown>>)
          .map((s) => {
            const id = String(s.agentId ?? agentId) as AgentId;
            return {
              agentId: AGENT_IDS.includes(id) ? id : agentId,
              goal: String(s.goal ?? '').slice(0, 200),
            };
          })
          .filter((s) => s.goal)
          .slice(0, 4)
      : [];

    return {
      agentId,
      steps: steps.length > 0 ? steps : [{ agentId, goal: text.slice(0, 120) }],
      reason: (parsed.reason ?? '').toString().slice(0, 200) || '模型判定',
      usedLlm: true,
    };
  } catch {
    return fallback;
  }
}

/** 兜底用的规则路由，供无 Key 场景直接调用 */
export function ruleRoutePublic(text: string, current: AgentId, autoDelegate: boolean): RouteDecision {
  return ruleRoute(text, current, autoDelegate);
}

/* ------------------------------------------------------------------ */
/* 工具循环                                                            */
/* ------------------------------------------------------------------ */

export interface LoopDeps {
  runId: string;
  rt: ToolRuntime;
  emitRun(event: RunEvent): void;
}

export interface LoopOptions {
  target: LlmTarget;
  agent: AgentId;
  messages: LlmMessage[];
  maxSteps: number;
  temperature: number;
  maxOutputTokens: number;
  toolsEnabled: boolean;
  toolOutputLimit: number;
  signal: AbortSignal;
  deps: LoopDeps;
  registry?: ToolRegistry;
  onDelta(text: string): void;
  onReasoning(text: string): void;
}

export interface LoopResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCallRecord[];
  usages: RawUsage[];
  steps: number;
  exhausted: boolean;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI 兼容网关要求工具（function）名必须满足 ^[a-zA-Z0-9_-]+$，
 *  而本应用的工具名带点号（如 python.exec / net.fetch），直接发送会被服务端拒绝：
 *  「Invalid `tools[0].function.name`: string does not match pattern」。
 *  发送前把工具名规整为合法字符；模型回传后再映射回真实工具名。 */
export function sanitizeToolName(name: string): string {
  return (name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 以指定 Agent 身份跑工具循环，直到模型不再请求工具或步数耗尽 */
export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const registry = opts.registry ?? toolRegistry;
  const runtime = agentRuntime(opts.agent);
  const schemas = opts.toolsEnabled ? registry.schemas(runtime.tools) : [];
  // 对外发送的工具名必须是合法字符；这里建立「合法名 → 真实名」映射，
  // 模型回传的是合法名，真正执行前再换回真实工具名。
  const nameMap = new Map<string, string>();
  const usedNames = new Set<string>();
  const safeSchemas: LlmToolSchema[] = schemas.map((s) => {
    let safe = sanitizeToolName(s.function.name);
    if (!safe) safe = 'tool';
    if (usedNames.has(safe)) {
      let i = 2;
      while (usedNames.has(`${safe}_${i}`)) i += 1;
      safe = `${safe}_${i}`;
    }
    usedNames.add(safe);
    nameMap.set(safe, s.function.name);
    return { ...s, function: { ...s.function, name: safe } };
  });
  const messages = opts.messages;
  const collected: ToolCallRecord[] = [];
  const usages: RawUsage[] = [];
  const seen = new Map<string, number>();
  let text = '';
  let reasoning = '';
  let steps = 0;
  let exhausted = false;

  while (steps < Math.max(1, opts.maxSteps)) {
    if (opts.signal.aborted) throw new Error('已取消本次生成。');
    steps += 1;

    const res = await streamChat({
      target: opts.target,
      messages,
      tools: safeSchemas.length > 0 ? safeSchemas : undefined,
      toolChoice: safeSchemas.length > 0 ? 'auto' : undefined,
      temperature: opts.temperature,
      maxTokens: opts.maxOutputTokens,
      signal: opts.signal,
      retries: 2,
      onDelta: (d) => {
        text += d;
        opts.onDelta(d);
      },
      onReasoning: (d) => {
        reasoning += d;
        opts.onReasoning(d);
      },
    });
    usages.push(res.usage);

    if (res.toolCalls.length === 0) {
      return { text, reasoning, toolCalls: collected, usages, steps, exhausted: false };
    }

    // 模型本轮要调工具：先落一条 assistant 消息，再逐个执行
    messages.push({
      role: 'assistant',
      content: res.text || '',
      tool_calls: res.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    for (const call of res.toolCalls) {
      // 模型回传的是规整后的合法名，这里换回真实工具名再执行
      const realName = nameMap.get(call.name) ?? call.name;
      const args = parseArgs(call.arguments);
      const record: ToolCallRecord = {
        id: call.id,
        name: realName,
        args,
        status: 'running',
        startedAt: Date.now(),
      };

      const signature = `${realName}:${JSON.stringify(args)}`;
      const hit = seen.get(signature) ?? 0;
      seen.set(signature, hit + 1);

      const emit = (r: ToolCallRecord) => {
        opts.deps.emitRun({ type: 'run:tool', runId: opts.deps.runId, call: r });
      };
      // 先推一条 running 给界面，最终结果再单独入库
      emit({ ...record });

      if (hit >= 2) {
        const blocked: ToolCallRecord = {
          ...record,
          status: 'error',
          error: '相同参数的重复调用已被拦截',
          result: '该工具刚用相同参数调用过，结果已在上下文中，请勿重复调用。',
          endedAt: Date.now(),
        };
        collected.push(blocked);
        emit(blocked);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: blocked.result ?? '',
        });
        continue;
      }

      if (!call.arguments.trim()) {
        // 部分模型会漏掉 arguments，按空对象继续放过
        opts.deps.rt.log.warn('[orchestrator] 工具参数为空', realName);
      }

      const result = await registry.execute(realName, args, {
        runId: opts.deps.runId,
        agentId: opts.agent,
        signal: opts.signal,
        rt: opts.deps.rt,
        emitRun: opts.deps.emitRun,
      });

      const denied = !result.ok && /用户拒绝|被安全策略拒绝/.test(result.error ?? result.content ?? '');
      const finalRecord: ToolCallRecord = {
        ...record,
        status: result.ok ? 'done' : denied ? 'denied' : 'error',
        result: truncateMiddle(result.content, opts.toolOutputLimit),
        error: result.error,
        endedAt: Date.now(),
      };
      if (result.citations && result.citations.length > 0) {
        opts.deps.emitRun({ type: 'run:citation', runId: opts.deps.runId, citations: result.citations });
      }
      collected.push(finalRecord);
      emit(finalRecord);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: truncateMiddle(result.content || (result.ok ? '（无输出）' : '工具失败'), opts.toolOutputLimit),
      });
    }
  }

  exhausted = true;
  opts.deps.emitRun({
    type: 'run:notice',
    runId: opts.deps.runId,
    level: 'warn',
    text: `已达到最大步数（${opts.maxSteps}），工具循环停止。可以继续追问，或调高「设置 → Agent → 最大步数」。`,
  });
  return { text, reasoning, toolCalls: collected, usages, steps, exhausted };
}

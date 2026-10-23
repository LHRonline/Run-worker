/**
 * Run worker — 平台能力工具（知识库 / 记忆 / 定时任务 / MCP）
 */
import { bool, fail, num, ok, str } from './types';
import type { ToolDefinition, ToolResult } from './types';
import type { AgentId, ScheduleKind, ScheduledTask } from '../../shared/types';

const AGENT_IDS: AgentId[] = ['orchestrator', 'code', 'image', 'model', 'video', 'computer', 'research', 'data'];

function newTaskId(): string {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const platformTools: ToolDefinition[] = [
  {
    name: 'kb.search',
    description:
      '在用户本地知识库中检索。回答需要依据用户自己的文档、笔记、代码库时先检索，再基于命中片段作答并标注来源。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言问题' },
        topK: { type: 'number', description: '返回条数，默认 6' },
      },
      required: ['query'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const query = str(args, 'query').trim();
      if (!query) return fail('检索内容不能为空。');
      const topK = Math.min(20, Math.max(1, Math.round(num(args, 'topK', 6))));
      const hits = await rt.kb.search(query, topK);
      if (hits.length === 0) {
        return ok('知识库没有命中内容。可能尚未添加资料源，或关键词与已有资料无关。可以改用 net.fetch 检索网络信息。');
      }
      const body = hits
        .map((h, i) => `[${i + 1}] ${h.title}（${h.path}｜相关度 ${h.score.toFixed(2)}）\n${h.snippet.trim()}`)
        .join('\n\n');
      return ok(`检索「${query}」命中 ${hits.length} 条：\n\n${body}`, hits.map((h) => ({
        title: h.title,
        sourcePath: h.path,
        snippet: h.snippet.slice(0, 300),
        score: h.score,
      })));
    },
  },
  {
    name: 'memory.save',
    description:
      '把值得长期记住的偏好、事实、项目背景写入长期记忆。用户明确表达习惯（如"我用 pnpm"）或稳定事实时使用，不要记录一次性的临时信息。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话描述要记住的内容，写成陈述句' },
        kind: {
          type: 'string',
          enum: ['preference', 'fact', 'project', 'instruction'],
          description: '类型：偏好 / 事实 / 项目 / 指令，默认 fact',
        },
        weight: { type: 'number', description: '重要度 0~1，默认 0.6' },
      },
      required: ['text'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const text = str(args, 'text').trim();
      if (!text) return fail('记忆内容不能为空。');
      const kindRaw = str(args, 'kind', 'fact');
      const kind = ['preference', 'fact', 'project', 'instruction'].includes(kindRaw) ? kindRaw : 'fact';
      const weight = Math.min(1, Math.max(0, num(args, 'weight', 0.6)));
      const facts = rt.memory.add({ text, kind: kind as 'preference' | 'fact' | 'project' | 'instruction', weight, source: 'tool' });
      return ok(`已记住（当前共 ${facts.length} 条）：${text}`);
    },
  },
  {
    name: 'task.schedule',
    description:
      '创建定时任务，让 Run worker 按计划自动执行某段提示词。用户说"每天早上/每隔 N 小时帮我做某事"时使用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，简短可辨识' },
        prompt: { type: 'string', description: '到点要执行的完整指令' },
        agentId: { type: 'string', enum: AGENT_IDS, description: '由哪个 Agent 执行，默认 orchestrator' },
        kind: { type: 'string', enum: ['cron', 'interval', 'once'], description: '调度类型' },
        cron: { type: 'string', description: 'kind=cron 时的 5 段 cron，如 "0 9 * * *"' },
        intervalMinutes: { type: 'number', description: 'kind=interval 时的间隔分钟数' },
        runAt: { type: 'number', description: 'kind=once 时的执行时间戳（毫秒）' },
        indexResult: { type: 'boolean', description: '结果是否写入知识库，默认 false' },
      },
      required: ['name', 'prompt', 'kind'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const kindRaw = str(args, 'kind', 'interval');
      const kind: ScheduleKind = ['cron', 'interval', 'once'].includes(kindRaw) ? (kindRaw as ScheduleKind) : 'interval';
      const name = str(args, 'name').trim() || '未命名任务';
      const prompt = str(args, 'prompt').trim();
      if (!prompt) return fail('任务指令不能为空。');
      const agentRaw = str(args, 'agentId', 'orchestrator');
      const agentId: AgentId = AGENT_IDS.includes(agentRaw as AgentId) ? (agentRaw as AgentId) : 'orchestrator';

      const task: ScheduledTask = {
        id: newTaskId(),
        name,
        prompt,
        agentId,
        kind,
        enabled: true,
        createdAt: Date.now(),
        indexResult: bool(args, 'indexResult'),
      };
      if (kind === 'cron') {
        task.cron = str(args, 'cron', '0 9 * * *');
      } else if (kind === 'interval') {
        task.intervalMinutes = Math.max(1, Math.round(num(args, 'intervalMinutes', 60)));
      } else {
        const at = Math.round(num(args, 'runAt', Date.now() + 3_600_000));
        task.runAt = at > Date.now() ? at : Date.now() + 60_000;
      }

      const list = rt.scheduler.save(task);
      const when = kind === 'cron'
        ? `cron ${task.cron}`
        : kind === 'interval'
          ? `每 ${task.intervalMinutes} 分钟`
          : new Date(task.runAt ?? Date.now()).toLocaleString('zh-CN', { hour12: false });
      return ok(`已创建定时任务「${name}」（${when}），当前共 ${list.length} 个任务。`);
    },
  },
  {
    name: 'mcp.call',
    description:
      '调用已连接的 MCP 服务器提供的工具。需要外部系统能力（浏览器、数据库、第三方 API）且已配置对应 MCP 时使用。',
    parameters: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'MCP 服务器 id，可用空字符串表示按工具名自动匹配' },
        tool: { type: 'string', description: '工具名' },
        args: { type: 'object', description: '传给该工具的参数对象' },
      },
      required: ['tool'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const tool = str(args, 'tool').trim();
      if (!tool) return fail('需要指定 MCP 工具名。');
      let serverId = str(args, 'serverId').trim();
      if (!serverId) {
        const found = rt.mcp.tools().find((t) => t.name === tool);
        if (!found) return fail(`未找到名为 ${tool} 的 MCP 工具，请先在设置中连接 MCP 服务器。`);
        serverId = found.serverId;
      }
      const rawArgs = args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : {};
      const res = await rt.mcp.call(serverId, tool, rawArgs);
      if (!res.ok) return { ok: false, content: res.content || 'MCP 调用失败', error: res.content };
      return ok(res.content || '（MCP 返回空结果）');
    },
  },
];

/**
 * Run worker — 工具注册表
 */
import { fail } from './types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import type { LlmToolSchema } from '../llm/client';
import { fsTools } from './fs';
import { shellTools } from './shell';
import { pythonTools } from './python';
import { netTools } from './net';
import { platformTools } from './platform';
import { mediaTools } from './media';

/** Agent 清单里出现的别名 → 真实工具名 */
const ALIASES: Record<string, string> = {
  ffmpeg: 'shell.exec',
  'data.chart': 'python.exec',
};

export const ALL_TOOLS: ToolDefinition[] = [
  ...fsTools,
  ...shellTools,
  ...pythonTools,
  ...netTools,
  ...platformTools,
  ...mediaTools,
];

export class ToolRegistry {
  private readonly map = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = ALL_TOOLS) {
    for (const t of tools) this.map.set(t.name, t);
  }

  has(name: string): boolean {
    return this.map.has(name) || !!ALIASES[name];
  }

  get(name: string): ToolDefinition | undefined {
    const real = ALIASES[name] ?? name;
    return this.map.get(real);
  }

  names(): string[] {
    return [...this.map.keys()];
  }

  /** 过滤出真实存在的工具定义 */
  resolve(names: string[]): ToolDefinition[] {
    const seen = new Set<string>();
    const out: ToolDefinition[] = [];
    for (const n of names) {
      const tool = this.get(n);
      if (!tool || seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
    return out;
  }

  schemas(names: string[]): LlmToolSchema[] {
    return this.resolve(names).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async execute(name: string, args: Record<string, unknown>, tc: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) return fail(`不存在名为 ${name} 的工具。可用工具：${this.names().join('、')}`);
    if (tc.signal.aborted) return fail('已取消，未执行该工具。');
    try {
      return await tool.run(args, tc);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}` : String(err);
      tc.rt.log.error(`[tool:${name}] 执行异常`, err);
      return fail(msg);
    }
  }
}

export const toolRegistry = new ToolRegistry();

export type { ToolContext, ToolDefinition, ToolResult };

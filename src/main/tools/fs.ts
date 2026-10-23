/**
 * Run worker — 文件系统工具
 */
import fs from 'node:fs';
import path from 'node:path';
import { bool, fail, num, ok, str, truncateMiddle } from './types';
import type { ToolDefinition, ToolResult } from './types';

const MAX_READ_BYTES = 400_000;
const MAX_READ_LINES = 4000;

/** 相对路径基于工作目录解析 */
export function resolveToolPath(base: string, input: string): string {
  const raw = (input || '').trim();
  if (!raw) return base;
  // 去掉模型偶尔加的引号
  const clean = raw.replace(/^["']|["']$/g, '');
  return path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(base, clean);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shouldSkip(name: string, showHidden: boolean): boolean {
  if (!showHidden && name.startsWith('.')) return true;
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === '__pycache__';
}

interface ListEntry {
  rel: string;
  dir: boolean;
  size: number;
}

function walk(dir: string, depth: number, maxDepth: number, showHidden: boolean, out: ListEntry[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    out.push({ rel: `（无法读取：${(err as Error).message}）`, dir: false, size: 0 });
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (shouldSkip(entry.name, showHidden)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ rel: `${full}${path.sep}`, dir: true, size: 0 });
      if (depth < maxDepth) walk(full, depth + 1, maxDepth, showHidden, out, limit);
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      out.push({ rel: full, dir: false, size });
    }
  }
}

export const fsTools: ToolDefinition[] = [
  {
    name: 'fs.list',
    description:
      '列出目录内容。需要先了解项目结构、确认文件是否存在时使用。返回绝对路径、是否目录、文件大小。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对路径基于工作目录；留空表示工作目录' },
        depth: { type: 'number', description: '递归深度，默认 1，最大 4' },
        limit: { type: 'number', description: '最多返回条数，默认 300' },
        showHidden: { type: 'boolean', description: '是否显示隐藏文件与构建产物，默认 false' },
      },
      required: [],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const target = resolveToolPath(rt.workspace(), str(args, 'path'));
      const depth = Math.min(4, Math.max(1, Math.round(num(args, 'depth', 1))));
      const limit = Math.min(2000, Math.max(10, Math.round(num(args, 'limit', 300))));
      if (!fs.existsSync(target)) return fail(`目录不存在：${target}`);
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) return fail(`这不是目录：${target}（读取文件请用 fs.read）`);

      const out: ListEntry[] = [];
      walk(target, 1, depth, bool(args, 'showHidden'), out, limit);
      if (out.length === 0) return ok(`目录为空：${target}`);
      const lines = out.map((e) => (e.dir ? `${e.rel}` : `${e.rel}  (${sizeLabel(e.size)})`));
      const suffix = out.length >= limit ? `\n…（已截断，仅显示前 ${limit} 条）` : '';
      return ok(`目录：${target}\n共 ${out.length} 项\n\n${lines.join('\n')}${suffix}`);
    },
  },
  {
    name: 'fs.read',
    description:
      '读取文本文件内容。改代码、看配置、读日志、分析数据前使用。支持按行区间读取大文件，超大文件会自动截断。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径基于工作目录' },
        startLine: { type: 'number', description: '起始行号（从 1 开始），可选' },
        endLine: { type: 'number', description: '结束行号，可选' },
      },
      required: ['path'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const target = resolveToolPath(rt.workspace(), str(args, 'path'));
      if (!fs.existsSync(target)) return fail(`文件不存在：${target}`);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) return fail(`这是目录，请用 fs.list：${target}`);
      if (stat.size > 8 * 1024 * 1024) return fail(`文件过大（${sizeLabel(stat.size)}），请用 fs.read 配合 startLine/endLine 或改用 shell.exec 处理。`);

      let text = fs.readFileSync(target, 'utf8');
      const truncated = text.length > MAX_READ_BYTES ? truncateMiddle(text, MAX_READ_BYTES) : text;

      const startLine = Math.max(1, Math.round(num(args, 'startLine', 0)));
      const endLine = Math.round(num(args, 'endLine', 0));
      if (startLine > 1 || endLine > 0) {
        const lines = text.split('\n');
        const from = startLine > 0 ? startLine - 1 : 0;
        const to = endLine > 0 ? Math.min(lines.length, endLine) : Math.min(lines.length, from + 800);
        const slice = lines.slice(from, to);
        return ok(`${target}\n行 ${from + 1}-${to}（共 ${lines.length} 行）\n\n${slice.join('\n')}`);
      }

      if (text.length > 0 && text.length > MAX_READ_BYTES) {
        return ok(`${target}\n（文件较大，已截断；共 ${text.length} 字符）\n\n${truncated}`);
      }
      const lineCount = text.split('\n').length;
      if (lineCount > MAX_READ_LINES) {
        text = text.split('\n').slice(0, MAX_READ_LINES).join('\n') + `\n…（已截断，共 ${lineCount} 行）`;
      }
      return ok(`${target}\n共 ${lineCount} 行 / ${sizeLabel(stat.size)}\n\n${text}`);
    },
  },
  {
    name: 'fs.write',
    description:
      '写入或覆盖文件，会自动创建父目录。生成代码、保存结果、修改配置时使用。覆写已有文件前应先 fs.read 确认内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径，相对路径基于工作目录' },
        content: { type: 'string', description: '完整文件内容' },
        append: { type: 'boolean', description: '是否追加而不是覆盖，默认 false' },
      },
      required: ['path', 'content'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const target = resolveToolPath(rt.workspace(), str(args, 'path'));
      const content = str(args, 'content');
      const verdict = rt.permissions.inspectFileWrite(target);
      if (!verdict.allowed) return fail(verdict.reason);
      const existed = fs.existsSync(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (bool(args, 'append')) fs.appendFileSync(target, content, 'utf8');
      else fs.writeFileSync(target, content, 'utf8');
      const stat = fs.statSync(target);
      const mode = bool(args, 'append') ? '追加' : existed ? '覆盖' : '新建';
      return ok(`已${mode}：${target}\n大小 ${sizeLabel(stat.size)}，${content.split('\n').length} 行。`);
    },
  },
  {
    name: 'fs.delete',
    description: '删除文件或目录（危险操作，需要用户确认）。清理临时文件、删除错误产物时使用。',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的路径，相对路径基于工作目录' },
        recursive: { type: 'boolean', description: '删除目录时是否递归，默认 false' },
      },
      required: ['path'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const target = resolveToolPath(rt.workspace(), str(args, 'path'));
      if (!fs.existsSync(target)) return ok(`路径本来就不存在：${target}`);
      if (target === path.parse(target).root) return fail('拒绝对磁盘根目录执行删除。');
      const stat = fs.statSync(target);
      const recursive = bool(args, 'recursive');
      const approved = await rt.askApproval({
        toolName: 'fs.delete',
        command: `删除 ${stat.isDirectory() ? '目录' : '文件'}：${target}`,
        risk: 'high',
        reason: '删除后无法恢复',
      });
      if (!approved) return fail('用户拒绝了删除操作。');
      fs.rmSync(target, { recursive: recursive || stat.isDirectory(), force: true });
      return ok(`已删除：${target}`);
    },
  },
];

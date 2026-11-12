/**
 * Run worker — 网络抓取
 * 只允许 http/https；响应体过大时截断，二进制可落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, num, ok, str, truncateMiddle } from './types';
import type { ToolDefinition, ToolResult } from './types';
import { resolveToolPath } from './fs';

const MAX_BODY = 600_000;
const MAX_DOWNLOAD = 20 * 1024 * 1024;

export const netTools: ToolDefinition[] = [
  {
    name: 'net.fetch',
    description:
      '抓取网页或调用 HTTP 接口。需要最新的公开信息、读在线文档、调 REST API 时使用。返回状态码与正文（超大响应会截断）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' },
        method: { type: 'string', description: 'HTTP 方法，默认 GET' },
        headers: { type: 'object', description: '请求头键值对，可选' },
        body: { type: 'string', description: '请求体（POST/PUT 时使用）' },
        savePath: { type: 'string', description: '把响应保存到该路径（适合图片/文件下载）' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000' },
      },
      required: ['url'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const rawUrl = str(args, 'url').trim();
      if (!/^https?:\/\//i.test(rawUrl)) return fail('URL 必须以 http:// 或 https:// 开头。');
      const method = (str(args, 'method', 'GET') || 'GET').toUpperCase();
      const headers: Record<string, string> = { 'User-Agent': 'Run-worker/1.0 (+https://github.com/LHRonline/run-worker)' };
      const extra = args.headers;
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }
      const body = str(args, 'body');
      const timeoutMs = Math.min(120_000, Math.max(1000, Math.round(num(args, 'timeoutMs', 30_000))));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (tc.signal.aborted) controller.abort();
      else tc.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const res = await fetch(rawUrl, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body || undefined,
          signal: controller.signal,
          redirect: 'follow',
        });
        const contentType = res.headers.get('content-type') || '';
        const savePath = str(args, 'savePath');

        if (savePath) {
          // 错误页不能当成"下载成功"落盘
          if (!res.ok) {
            return { ok: false, content: `${rawUrl}\n下载失败：HTTP ${res.status} ${res.statusText}`, error: `HTTP ${res.status}` };
          }
          const target = resolveToolPath(rt.workspace(), savePath);
          const verdict = rt.permissions.inspectFileWrite(target);
          if (!verdict.allowed) return fail(verdict.reason);
          // 先用 Content-Length 预检，避免把超大响应读进内存
          const declared = Number(res.headers.get('content-length') || 0);
          if (declared > MAX_DOWNLOAD) return fail(`下载内容过大（${declared} 字节），超过上限 ${MAX_DOWNLOAD} 字节。`);
          const buf = Buffer.from(await res.arrayBuffer());
          // 无 Content-Length 时以下载后的实际长度复核
          if (buf.length > MAX_DOWNLOAD) return fail(`下载内容过大（${buf.length} 字节），超过上限 ${MAX_DOWNLOAD} 字节。`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, buf);
          return ok(`已下载：${rawUrl}\n状态：${res.status}\n类型：${contentType}\n保存到：${target}（${buf.length} 字节）`);
        }

        const text = await res.text();
        const head = `${rawUrl}\n状态：${res.status} ${res.statusText}\n类型：${contentType || '未知'}\n长度：${text.length} 字符\n\n`;
        const content = text.length > MAX_BODY ? truncateMiddle(text, MAX_BODY) : text;
        if (!res.ok) {
          return { ok: false, content: `${head}${content.slice(0, 4000)}`, error: `HTTP ${res.status}` };
        }
        return ok(`${head}${content}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted && tc.signal.aborted) return fail('请求已取消。');
        if (controller.signal.aborted) return fail(`请求超时（${timeoutMs} ms）。`);
        return fail(`请求失败：${msg}`);
      } finally {
        clearTimeout(timer);
        tc.signal.removeEventListener('abort', onAbort);
      }
    },
  },
];

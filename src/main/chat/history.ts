/**
 * Run worker — 历史消息整理与压缩
 * Token 节省核心：只带必要历史、超限滚动摘要、不回传 reasoning、工具输出截断。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, ChatMessage, Conversation } from '../../shared/types';
import type { LlmContentPart, LlmMessage } from '../llm/client';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** 图片附件转 data URL；非图片或过大则退化为文字说明 */
export function attachmentsToParts(attachments: Attachment[] | undefined): LlmContentPart[] {
  if (!attachments || attachments.length === 0) return [];
  const parts: LlmContentPart[] = [];
  for (const a of attachments) {
    const isImage = a.kind === 'image' || IMAGE_EXT.test(a.path || a.name);
    if (isImage && a.path && fs.existsSync(a.path)) {
      try {
        const stat = fs.statSync(a.path);
        if (stat.size <= MAX_IMAGE_BYTES) {
          const b64 = fs.readFileSync(a.path).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${a.mime || mimeOf(a.path)};base64,${b64}` } });
          continue;
        }
        parts.push({ type: 'text', text: `（图片过大未上传：${a.name}，${(stat.size / 1024 / 1024).toFixed(1)} MB）` });
      } catch {
        parts.push({ type: 'text', text: `（图片读取失败：${a.name}）` });
      }
      continue;
    }
    parts.push({ type: 'text', text: `（附件：${a.name}｜路径：${a.path}${a.size ? `｜${a.size} 字节` : ''}）` });
  }
  return parts;
}

/** 工具调用的极简回顾，让模型知道上一轮做过什么，又不至于把结果重复塞满上下文 */
function toolRecap(m: ChatMessage): string {
  if (!m.toolCalls || m.toolCalls.length === 0) return '';
  const items = m.toolCalls
    .map((t) => `- ${t.name}（${t.status}）${t.error ? `：${t.error}` : ''}`)
    .join('\n');
  return `\n\n[上一轮已调用工具]\n${items}`;
}

export interface HistoryOptions {
  maxHistoryMessages: number;
  skipReasoningResend: boolean;
  /** 已有摘要 */
  summary?: string;
}

/** 把落库消息转成模型消息；跳过 system/tool 与思考内容 */
export function conversationToMessages(conv: Conversation, opts: HistoryOptions): LlmMessage[] {
  const out: LlmMessage[] = [];
  if (opts.summary && opts.summary.trim()) {
    out.push({ role: 'system', content: `[历史摘要]（更早的对话已压缩）\n${opts.summary.trim()}` });
  }

  const history = conv.messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'summary');
  const windowed = history.slice(-Math.max(2, opts.maxHistoryMessages));

  for (const m of windowed) {
    if (m.role === 'summary') {
      // 已有 conv.summary 时不再重复注入同一个摘要节点
      if (opts.summary) continue;
      out.push({ role: 'system', content: `[历史摘要]\n${m.content.trim()}` });
      continue;
    }
    if (m.role === 'user') {
      const parts = attachmentsToParts(m.attachments);
      if (parts.length > 0) {
        out.push({ role: 'user', content: [{ type: 'text', text: m.content || '（见附件）' }, ...parts] });
      } else {
        out.push({ role: 'user', content: m.content });
      }
      continue;
    }
    // assistant：正文 + 工具回顾；思考内容按设置决定是否回传
    const body = m.content || '';
    const recap = toolRecap(m);
    const thinking = opts.skipReasoningResend ? '' : m.thinking ? `\n\n[思考]\n${m.thinking}` : '';
    if (!body && !recap) continue;
    out.push({ role: 'assistant', content: `${body}${thinking}${recap}`.trim() });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 压缩                                                                */
/* ------------------------------------------------------------------ */

export const KEEP_RECENT = 4;

export function charCount(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.thinking?.length ?? 0), 0);
}

export interface CompressionPlan {
  older: ChatMessage[];
  recent: ChatMessage[];
}

/** 超过阈值时给出压缩方案（保留最近几条原文） */
export function planCompression(messages: ChatMessage[], threshold: number): CompressionPlan | null {
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'summary');
  if (usable.length <= KEEP_RECENT + 1) return null;
  if (charCount(usable) <= threshold) return null;
  const cut = usable.length - KEEP_RECENT;
  return { older: usable.slice(0, cut), recent: usable.slice(cut) };
}

/** 拼成给摘要模型的纯文本，控制输入体积 */
export function renderForSummary(messages: ChatMessage[], limit = 16000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === 'user' ? '用户' : m.role === 'summary' ? '已有摘要' : '助手';
    const body = (m.content || '').replace(/\s+\n/g, '\n').trim();
    if (!body) continue;
    lines.push(`【${who}】${body.length > 1200 ? `${body.slice(0, 1200)}…` : body}`);
  }
  const text = lines.join('\n\n');
  return text.length > limit ? `${text.slice(0, limit)}\n……（后文省略）` : text;
}

export function makeSummaryMessage(text: string): ChatMessage {
  return {
    id: `sum_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    role: 'summary',
    content: text.trim(),
    createdAt: Date.now(),
    isSummary: true,
  };
}

export const SUMMARY_SYSTEM = [
  '你在压缩对话历史。把下面的多轮对话合并成一段精炼摘要。',
  '必须保留：用户的目标与约束、已确认的结论、关键参数与文件路径、未完成的事项。',
  '丢弃：寒暄、重复表述、失败尝试的细节。',
  '用简体中文，纯文本，不超过 400 字，不要分点超过 6 条。',
].join('\n');

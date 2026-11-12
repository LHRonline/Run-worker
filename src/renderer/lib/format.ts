import type { Citation, UsageStats } from '@shared/types';

const CJK = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g;

/** 粗略 token 估算：中文≈1 token/字，英文≈4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 3.6));
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 精确展示：不做 k/M 缩写，直接给完整数字（带千分位） */
export function formatTokensExact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** 判断一组 token 数值是「API 精确」还是「本地估算」，供界面如实标注 */
export function usageSource(u: UsageStats | undefined): {
  label: string;
  title: string;
  estimated: boolean;
} {
  if (!u) return { label: '', title: '', estimated: false };
  if (u.tokenSource === 'estimated') {
    return { label: '约', title: '本地估算：服务商未返回 usage，数值为近似值', estimated: true };
  }
  if (u.tokenSource === 'mixed') {
    return {
      label: '部分估算',
      title: `本轮共 ${u.totalRequests ?? 0} 次请求，其中 ${u.exactRequests ?? 0} 次为服务商精确值，其余为本地估算`,
      estimated: true,
    };
  }
  return { label: '精确', title: '来自服务商返回的 usage 字段，为实际计费 token', estimated: false };
}

export function formatCny(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '¥0.00';
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTimeShort(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(ts: number): string {
  if (!ts) return '—';
  const now = Date.now();
  const diff = now - ts;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `今天 ${formatClock(ts)}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${formatClock(ts)}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return formatDateTime(ts);
}

/** 将未来时间描述为"x 分钟后 / 今天 09:00" */
export function formatFuture(ts?: number): string {
  if (!ts) return '未排期';
  const diff = ts - Date.now();
  if (diff <= 0) return '即将执行';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟后`;
  if (diff < 86_400_000) return `今天 ${formatClock(ts)}`;
  return formatDateTime(ts);
}

export function totalUsage(a: UsageStats | undefined, b: UsageStats | undefined): UsageStats {
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0),
    cachedTokens: (a?.cachedTokens ?? 0) + (b?.cachedTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    costCny: (a?.costCny ?? 0) + (b?.costCny ?? 0),
  };
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx > 0 ? norm.slice(0, idx) : norm;
}

export function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n)}…`;
}

export function citationsLabel(list: Citation[] | undefined): string {
  if (!list || list.length === 0) return '无引用';
  return `引用 ${list.length}`;
}

/** 从首句生成简洁标题，避免把提示词从中间截断 */
export function shortTitle(text: string, max = 20): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const first = clean.split(/[，。！？；,.!?;\n]/)[0] ?? '';
  const base = first.length >= 4 ? first : clean;
  return base.length > max ? `${base.slice(0, max)}…` : base;
}

/** 展示用路径规范化：统一分隔符、合并重复斜杠、去掉末尾斜杠 */
export function normalizePath(p?: string | null): string {
  if (!p) return '';
  const s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return s.length > 3 ? s.replace(/\/+$/, '') : s;
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

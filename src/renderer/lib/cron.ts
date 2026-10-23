/** 轻量 cron 人类可读描述（5 段：分 时 日 月 周），无法识别时原样返回 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function cronToHuman(expr: string): string {
  const raw = expr.trim();
  if (!raw) return '未设置';
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = parts;

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${everyMin[1]} 分钟`;
  }
  if (min === '*' && hour === '*') return '每分钟';
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每小时第 ${min} 分`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `每天 ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
    return `每${WEEK[Number(dow)].slice(1)} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    return `每月 ${dom} 日 ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (min === '0' && hour === '*/2') return '每 2 小时';
  return raw;
}

/** 估算下一次执行时间（仅覆盖常见表达式，未知时返回 undefined） */
export function nextRunAt(expr: string): number | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [min, hour, dom, mon, dow] = parts;
  const now = new Date();
  const candidate = new Date(now.getTime());
  candidate.setSeconds(0, 0);

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const target = new Date(now);
    target.setHours(Number(hour), Number(min), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === '*') {
    const step = Math.max(1, Number(every[1]));
    candidate.setMinutes(Math.ceil((now.getMinutes() + 0.001) / step) * step);
    if (candidate.getTime() <= now.getTime()) candidate.setMinutes(candidate.getMinutes() + step);
    return candidate.getTime();
  }
  if (/^\d+$/.test(min) && hour === '*') {
    const target = new Date(now);
    target.setMinutes(Number(min), 0, 0);
    if (target.getTime() <= now.getTime()) target.setHours(target.getHours() + 1);
    return target.getTime();
  }
  return undefined;
}

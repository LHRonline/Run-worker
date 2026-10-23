/** 主题色板与颜色工具 */
export interface AccentOption {
  name: string;
  value: string;
  alt: string;
}

export const ACCENTS: AccentOption[] = [
  { name: '蓝', value: '#3b82f6', alt: '#22d3ee' },
  { name: '青', value: '#0ea5b7', alt: '#67e8f9' },
  { name: '紫', value: '#8b5cf6', alt: '#d8b4fe' },
  { name: '绿', value: '#10b981', alt: '#a3e635' },
  { name: '橙', value: '#f97316', alt: '#fbbf24' },
  { name: '粉', value: '#ec4899', alt: '#f9a8d4' },
];

export function accentOf(value: string): AccentOption {
  return ACCENTS.find((a) => a.value.toLowerCase() === value.toLowerCase()) ?? ACCENTS[0];
}

export function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const num = Number.parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lighten(hex: string, amount: number): string {
  return mix(hex, '#ffffff', amount);
}

export function darken(hex: string, amount: number): string {
  return mix(hex, '#0b1220', amount);
}

function mix(hex: string, target: string, amount: number): string {
  const a = toRgb(hex);
  const b = toRgb(target);
  const ch = (i: number) => Math.round(a[i] + (b[i] - a[i]) * amount);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function toRgb(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const num = Number.parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

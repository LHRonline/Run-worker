/**
 * Run worker — 思考语言治理
 * 模型可能用英文思考；这里检测中文占比，低于阈值时用低价模型重述为中文。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** 去掉代码块与行内代码，避免代码把占比拉偏 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * 中文占比：CJK 字数 /（CJK 字数 + 英文单词数）。
 * 一个汉字与一个英文单词视作等价信息量，比按字母算更贴近实际语言比例。
 */
export function chineseRatio(text: string): number {
  const body = stripCode(text || '');
  if (!body.trim()) return 1;
  const cjk = (body.match(CJK_GLOBAL) ?? []).length;
  const words = (body.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
  const total = cjk + words;
  if (total === 0) return 1;
  return cjk / total;
}

/** 长度太短的思考不值得重写，直接放过 */
const MIN_LENGTH = 40;

export function needsRewrite(text: string, threshold = 0.55): boolean {
  const body = stripCode(text || '').trim();
  if (body.length < MIN_LENGTH) return false;
  return chineseRatio(text) < threshold;
}

/** 轻量模型接口，便于测试替换 */
export interface ThinkingRewriteLlm {
  complete(input: string, opts?: { system?: string; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
}

export interface RewriteOptions {
  threshold?: number;
  signal?: AbortSignal;
  /** 结论回调：交给上层发 run:thinking-lang */
  onEvent?: (info: { ratio: number; rewritten: boolean }) => void;
}

export interface RewriteResult {
  text: string;
  ratio: number;
  rewritten: boolean;
  /** 尝试过但失败了 */
  failed: boolean;
}

const REWRITE_SYSTEM = [
  '你是翻译器，只做一件事：把给定的推理过程改写成简体中文。',
  '要求：保留原有逻辑顺序、结论、数字、代码与专有名词；不增加新内容，不总结，不删减关键步骤。',
  '只输出改写后的正文，不要任何前后缀说明。',
].join('\n');

const FAIL_MARK = '\n\n（以上思考为原文，自动转为中文失败）';

/** 把推理内容重写为中文；失败时原样保留并打标记 */
export async function rewriteThinkingToChinese(
  text: string,
  llm: ThinkingRewriteLlm,
  opts: RewriteOptions = {},
): Promise<RewriteResult> {
  const threshold = opts.threshold ?? 0.55;
  const ratio = chineseRatio(text);
  if (!needsRewrite(text, threshold)) {
    opts.onEvent?.({ ratio, rewritten: false });
    return { text, ratio, rewritten: false, failed: false };
  }

  try {
    // 过长时只重写前段，避免为了省 token 反而多花 token
    const input = text.length > 6000 ? `${text.slice(0, 6000)}\n……（后文省略）` : text;
    const out = await llm.complete(input, { system: REWRITE_SYSTEM, maxTokens: 1200, signal: opts.signal });
    const cleaned = out.trim();
    if (!cleaned || chineseRatio(cleaned) < threshold) {
      opts.onEvent?.({ ratio, rewritten: false });
      return { text: `${text}${FAIL_MARK}`, ratio, rewritten: false, failed: true };
    }
    opts.onEvent?.({ ratio, rewritten: true });
    return { text: cleaned, ratio: chineseRatio(cleaned), rewritten: true, failed: false };
  } catch {
    opts.onEvent?.({ ratio, rewritten: false });
    return { text: `${text}${FAIL_MARK}`, ratio, rewritten: false, failed: true };
  }
}

/** 给界面展示的比率文案 */
export function ratioLabel(ratio: number): string {
  return `${Math.round(ratio * 100)}% 中文`;
}

export { CJK };

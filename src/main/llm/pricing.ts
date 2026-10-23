/**
 * Run worker — 成本估算（元 / 百万 token）
 * 价格随时会变，这里只做量级估算，界面上标注为「估算」。
 */

interface PriceRule {
  match: RegExp;
  /** 输入（缓存未命中）元/百万 token */
  input: number;
  /** 输出 元/百万 token */
  output: number;
  /** 缓存命中输入 元/百万 token */
  cached?: number;
}

const RULES: PriceRule[] = [
  { match: /:free$/i, input: 0, output: 0, cached: 0 },
  // Ollama / 本地量化模型常用「模型:7b」命名，视作零成本
  { match: /:(1\.5b|3b|7b|8b|14b|32b|70b)$/i, input: 0, output: 0, cached: 0 },
  { match: /deepseek-reasoner|deepseek-r1/i, input: 4, output: 16, cached: 1 },
  { match: /deepseek-chat|deepseek-v3/i, input: 2, output: 8, cached: 0.5 },
  { match: /qwen2\.5[:-]7b|glm-4-9b|llama-?3\.?2[:-]3b/i, input: 0, output: 0, cached: 0 },
  { match: /qwen-2\.5-72b|llama-3\.3-70b/i, input: 3.5, output: 3.5, cached: 3.5 },
  { match: /gpt-4o-mini/i, input: 1, output: 4, cached: 0.5 },
  { match: /gpt-4o(?!-mini)/i, input: 18, output: 72, cached: 9 },
  { match: /claude-3-5-sonnet|claude-3\.5-sonnet/i, input: 22, output: 108, cached: 2.2 },
];

const DEFAULT_RULE: PriceRule = { match: /.*/, input: 2, output: 8, cached: 0.5 };

function ruleFor(model: string): PriceRule {
  const name = (model || '').toLowerCase();
  return RULES.find((r) => r.match.test(name)) ?? DEFAULT_RULE;
}

/** 估算本次调用成本（人民币元） */
export function estimateCostCny(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const rule = ruleFor(model);
  if (rule.input === 0 && rule.output === 0) return 0;
  const cached = Math.min(cachedTokens, promptTokens);
  const fresh = Math.max(0, promptTokens - cached);
  const cost =
    (fresh * rule.input + cached * (rule.cached ?? rule.input) + completionTokens * rule.output) / 1_000_000;
  // 保留 6 位，避免小数值被抹成 0
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** 该模型是否零成本（免费渠道） */
export function isFreeModel(model: string): boolean {
  const rule = ruleFor(model);
  return rule.input === 0 && rule.output === 0;
}

/** 人类可读的价格标签 */
export function priceLabel(model: string): string {
  const rule = ruleFor(model);
  if (rule.input === 0 && rule.output === 0) return '免费';
  return `约 ¥${rule.input}/¥${rule.output} 每百万 token（输入/输出）`;
}

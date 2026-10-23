/**
 * Run worker — 内置服务商预设与默认设置
 * 所有"免费可用"的渠道都标注了 free: true，免费模式会优先挑选它们。
 */
import type { ProviderPreset, Settings } from './types';

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    free: false,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '原生思维链，deepseek-reasoner 输出 reasoning_content；国内直连，价格最低之一。',
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter（免费模型）',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'deepseek/deepseek-r1:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'qwen/qwen-2.5-72b-instruct:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    free: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: '带 :free 后缀的模型零成本调用，有每分钟/每日限额，适合日常轻量任务。',
  },
  {
    id: 'groq',
    name: 'Groq（免费额度）',
    kind: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'qwen-2.5-32b'],
    free: true,
    keyUrl: 'https://console.groq.com/keys',
    note: '推理速度极快，免费额度按天刷新，适合长对话与工具循环。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动（免费模型）',
    kind: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-R1', 'THUDM/glm-4-9b-chat'],
    free: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '国内节点，7B 级模型长期免费，注册送额度，中文表现好。',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地（完全免费）',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'deepseek-r1:7b', 'llama3.2:3b'],
    free: true,
    local: true,
    note: '本地推理零成本、零联网，需先安装 Ollama 并 pull 对应模型。',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    kind: 'custom',
    baseUrl: '',
    models: [],
    free: false,
    note: '任意兼容 /v1/chat/completions 的服务，如 vLLM、LM Studio、OneAPI 中转。',
  },
];

export const DEFAULT_PERSONA_PROMPTS: Record<string, string> = {
  direct: '你是追求结果的操作者。先给结论与可执行动作，再补充必要依据。不寒暄、不复述问题、不写免责声明。',
  balanced: '你在结论与解释之间保持平衡：先给答案，再用最少的篇幅说明关键理由。',
  teaching: '你像耐心的工程师带新人：给出答案后解释原理与常见坑，必要时补充示例。',
  cold: '你只输出事实与操作步骤，句子极短，禁止任何情绪化表达。',
  custom: '',
};

export function createDefaultSettings(): Settings {
  const now = Date.now();
  return {
    version: 1,
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek 官方',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        free: false,
        enabled: true,
        status: 'unknown',
      },
      {
        id: 'openrouter-free',
        name: 'OpenRouter（免费模型）',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        models: PROVIDER_PRESETS[1].models,
        free: true,
        enabled: true,
        status: 'unknown',
      },
    ],
    activeProviderId: 'deepseek',
    activeModel: 'deepseek-reasoner',
    freeMode: false,
    appearance: {
      theme: 'dark',
      accent: '#3b82f6',
      zoom: 1,
      collapseThinking: false,
      monoFont: false,
      decorations: true,
    },
    persona: {
      preset: 'direct',
      customPrompt: '',
      verbosity: 2,
      temperature: 0.6,
      noFiller: true,
      resultFirst: true,
    },
    tokenSave: {
      enabled: true,
      maxHistoryMessages: 16,
      compressThreshold: 24000,
      toolOutputLimit: 4000,
      skipReasoningResend: true,
      maxOutputTokens: 4096,
      cacheFriendlyPrefix: true,
      budgetAlertCny: 20,
    },
    thinking: {
      enabled: true,
      forceChinese: true,
      chineseRatioThreshold: 0.55,
      showTokens: true,
    },
    memory: {
      enabled: true,
      longTerm: true,
      maxFacts: 200,
      autoExtract: true,
    },
    agent: {
      approvalMode: 'safe-only',
      maxSteps: 12,
      workspaceDir: '',
      pythonPath: 'python',
      shell: 'powershell',
      commandTimeout: 120000,
      autoDelegate: true,
      denyPatterns: ['rm -rf /', 'format ', 'del /f /s /q c:\\', 'shutdown /s', 'diskpart'],
    },
    mcpServers: [],
    update: {
      autoCheck: true,
      channel: 'stable',
      feed: 'LHRonline/run-worker',
    },
    onboardingDone: false,
    telemetry: false,
    createdAt: now,
    updatedAt: now,
  };
}

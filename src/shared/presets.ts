/**
 * Run worker — 内置服务商预设与默认设置
 * 所有"免费可用"的渠道都标注了 free: true，免费模式会优先挑选它们。
 */
import type { PersonaPreset, ProviderPreset, Settings } from './types';

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
      humanize: true,
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

/* ------------------------------------------------------------------ */
/* Composer 增强菜单：模式 / 技能                                       */
/* ------------------------------------------------------------------ */

export const PERSONA_PRESET_META: Array<{
  id: PersonaPreset;
  label: string;
  icon: string;
  hint: string;
  patch: { noFiller: boolean; resultFirst: boolean; verbosity: number };
}> = [
  { id: 'direct', label: '直给', icon: '⚡', hint: '先给结论与可执行动作，不寒暄', patch: { noFiller: true, resultFirst: true, verbosity: 2 } },
  { id: 'balanced', label: '均衡', icon: '◐', hint: '结论 + 最少的必要解释', patch: { noFiller: false, resultFirst: true, verbosity: 3 } },
  { id: 'teaching', label: '教学', icon: '✦', hint: '讲清原理、常见坑与示例', patch: { noFiller: false, resultFirst: false, verbosity: 4 } },
  { id: 'cold', label: '极简', icon: '▬', hint: '只给事实与步骤，句子极短', patch: { noFiller: true, resultFirst: true, verbosity: 1 } },
];

export interface ComposerSkill {
  id: string;
  label: string;
  icon: string;
  hint: string;
  /** {text} 会替换为输入框里已有的内容 */
  template: string;
}

export const COMPOSER_SKILLS: ComposerSkill[] = [
  { id: 'summarize', label: '总结要点', icon: '≡', hint: '把内容压成 3-5 条要点', template: '请把下面的内容总结成 3-5 条要点，保留关键结论与数字：\n\n{text}' },
  { id: 'rewrite', label: '改写润色', icon: '✎', hint: '保持原意，改得更清楚简洁', template: '在保持原意与事实不变的前提下，把下面这段改得更清楚、简洁、易读：\n\n{text}' },
  { id: 'explain', label: '解释原理', icon: '◇', hint: '讲清为什么和一个最小例子', template: '请解释下面内容的原理与关键假设，并给一个最小可运行的例子：\n\n{text}' },
  { id: 'plan', label: '拆解任务', icon: '▤', hint: '列成可执行的步骤清单', template: '把下面这件事拆成可执行步骤，标出每步的产出、所需工具和可能的坑：\n\n{text}' },
  { id: 'review', label: '审查找错', icon: '⌕', hint: '找逻辑错误、边界与安全风险', template: '请审查下面的内容，找出逻辑错误、边界条件遗漏与潜在风险，按严重程度排序并给出修正建议：\n\n{text}' },
  { id: 'translate', label: '中英互译', icon: '↔', hint: '保留术语与代码块原样', template: '把下面内容在中英文之间互译；保留代码、命令、专有名词原样，不要添加解释：\n\n{text}' },
];

/** 本次更新的展示内容（界面「本次更新」面板与发布说明共用同一份数据） */
export interface ReleaseNoteSection {
  title: string;
  icon: string;
  items: string[];
}

export const CURRENT_RELEASE_NOTES: {
  summary: string;
  sections: ReleaseNoteSection[];
} = {
  summary: '彻底删除更干净、看得见的 token 数字、应用内一键升级，以及一轮全面的 Bug 修复与算法优化。',
  sections: [
    {
      title: '新增',
      icon: '✚',
      items: [
        'Composer 增强菜单：添加文件、引用对话文件、模式、专家、技能、连接器一屏可达',
        '精确 Token 计量：逐轮累加服务商 usage，明确区分「API 精确」与「本地估算」',
        '应用内一键升级：自动下载安装包、SHA-256 校验、拉起静默安装并退出应用',
        '自我改进：可对任意回复提交「纠正」，写入长期记忆并在后续提示词中优先遵守',
        '更像人：新增人设层，自然协作、记住约定、被纠正时直接改',
        '「本次更新」面板：在应用内直接查看这一版改了什么',
      ],
    },
    {
      title: '彻底删除',
      icon: '⌫',
      items: [
        '删除对话会同时擦除会话文件与索引、派生长期记忆、该会话产物图片与生成物',
        '中止在途任务并加删除屏障，杜绝「删完又被写回复活」',
        '兼容清理 0.0.3a 及更早版本散落在产物根目录的旧文件',
        '清理报告如实展示已擦除数量与被占用未能删除的文件',
        '新增「清空全部对话」，一次清干净',
      ],
    },
    {
      title: '修复',
      icon: '✓',
      items: [
        '流式输出中断重试导致文本重复（增量计数恒为 0）',
        '多步工具调用把中间轮过渡文本拼进最终答案',
        'shell/python 超时后 Promise 永久挂起，Windows 下无法结束进程树',
        '定时任务触发的 run 让输入框永久锁死；删除会话后残留孤儿 run 与授权请求',
        '切换会话 / 点停止时状态不回滚；stop 可能误杀其它会话的全部任务',
        'bootstrap 失败时永久卡在启动画面；并发发送造成跨会话内容串台',
        'python 含空格路径被加引号导致 ENOENT；临时脚本无限累积',
        'net.fetch 把 404 错误页当下载成功；fs.read 行范围倒挂；fs.delete 忽略 recursive 参数',
      ],
    },
    {
      title: '优化',
      icon: '↗',
      items: [
        '工具循环按字符预算滚动裁剪上下文，避免多步调用把请求体撑爆',
        '工具调用去重改用键排序的稳定序列化',
        'cron 下次执行时间由逐分钟暴力搜索改为按字段跳进',
        '定时任务 tick 加互斥、任务产物滚动清理、原子写复用带回退的实现',
        '长期记忆归一化结果缓存、多来源合并后按来源删除更准确',
        '思考过程折叠时停止定时器；流式 Markdown 解析改为节流',
      ],
    },
  ],
};

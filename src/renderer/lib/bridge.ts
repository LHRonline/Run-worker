/**
 * 渲染进程与主进程的唯一桥接点。
 * 浏览器预览时 window.runworker 不存在，用内存 Mock 完整模拟流式协议，
 * 因此同一个界面在 Electron 与静态预览下行为一致。
 */
import type { DeepPartial, RunWorkerApi } from '@shared/ipc';
import type {
  AgentDescriptor,
  AgentId,
  AppInfo,
  ApprovalRequest,
  Attachment,
  BootstrapPayload,
  ChatMessage,
  ChatSendRequest,
  Citation,
  Conversation,
  ConversationMeta,
  ConversationFileRef,
  ConversationPurgeReport,
  KnowledgeHit,
  KnowledgeSource,
  KnowledgeStats,
  McpCallResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  MemoryFact,
  ProviderConfig,
  ProviderPreset,
  ProviderTestResult,
  RunEvent,
  ScheduledTask,
  Settings,
  TaskRun,
  ToastPayload,
  UpdateInfo,
  UpdateProgress,
  UsageStats,
} from '@shared/types';
import { DEFAULT_USAGE } from '@shared/types';
import { AGENTS } from '@shared/agents';
import { PROVIDER_PRESETS, createDefaultSettings } from '@shared/presets';
import { shortTitle } from './format';

export const isDesktop = typeof window !== 'undefined' && Boolean(window.runworker);

/* ------------------------------------------------------------------ */
/* Mock 数据                                                           */
/* ------------------------------------------------------------------ */

const LS_KEY = 'runworker.preview.state.v2';
const MOCK_NOW = Date.now();

interface MockData {
  settings: Settings;
  conversations: Conversation[];
  tasks: ScheduledTask[];
  taskRuns: TaskRun[];
  knowledge: KnowledgeSource[];
  memory: MemoryFact[];
  mcp: McpServerConfig[];
  mcpStatus: Record<string, McpServerStatus>;
}

function seedTasks(): ScheduledTask[] {
  return [
    {
      id: 'task-morning',
      name: '每日工作晨报',
      prompt: '汇总我昨天在知识库中新增的文档要点，输出 5 条待办，并标注优先级。',
      agentId: 'research',
      kind: 'cron',
      cron: '0 9 * * *',
      enabled: true,
      createdAt: MOCK_NOW - 86400000 * 6,
      lastRunAt: MOCK_NOW - 86400000,
      lastStatus: 'success',
      lastResult: '已生成 5 条待办：1) 完成接口联调 …',
      nextRunAt: MOCK_NOW + 3600000 * 3,
      indexResult: true,
    },
    {
      id: 'task-clean',
      name: '周末整理下载文件夹',
      prompt: '把下载目录里超过 30 天的安装包移到归档目录，并按类型归类文档与图片，输出移动清单。',
      agentId: 'computer',
      kind: 'cron',
      cron: '0 10 * * 6',
      enabled: false,
      createdAt: MOCK_NOW - 86400000 * 12,
      lastRunAt: MOCK_NOW - 86400000 * 8,
      lastStatus: 'success',
      lastResult: '归档 42 个文件，释放 1.8 GB。',
      nextRunAt: MOCK_NOW + 86400000 * 2,
      indexResult: false,
    },
  ];
}

function seedKnowledge(): KnowledgeSource[] {
  return [
    {
      id: 'kb-docs',
      path: 'D:/RunWorker/工作区/产品文档',
      name: '产品文档',
      kind: 'dir',
      files: 26,
      chunks: 418,
      addedAt: MOCK_NOW - 86400000 * 9,
      updatedAt: MOCK_NOW - 3600000 * 5,
      watch: true,
      status: 'ready',
    },
    {
      id: 'kb-notes',
      path: 'D:/RunWorker/工作区/周会纪要.md',
      name: '周会纪要.md',
      kind: 'file',
      files: 1,
      chunks: 12,
      addedAt: MOCK_NOW - 86400000 * 2,
      updatedAt: MOCK_NOW - 86400000,
      watch: false,
      status: 'ready',
    },
  ];
}

function seedMemory(): MemoryFact[] {
  const base = MOCK_NOW - 86400000 * 4;
  return [
    { id: 'mem-1', kind: 'preference', text: '默认用简体中文回答，代码注释也用中文。', weight: 0.92, createdAt: base, updatedAt: base, hits: 14, source: '对话自动提取' },
    { id: 'mem-2', kind: 'preference', text: '偏好先给结论和可执行命令，再补充解释。', weight: 0.86, createdAt: base, updatedAt: base, hits: 9, source: '对话自动提取' },
    { id: 'mem-3', kind: 'project', text: 'Run worker 桌面端项目位于 D:/Apps/run-worker，主进程入口 dist-electron/main。', weight: 0.78, createdAt: base, updatedAt: base, hits: 6, source: '手动添加' },
    { id: 'mem-4', kind: 'instruction', text: '删除或覆盖文件前必须先征求授权，禁止静默执行。', weight: 0.95, createdAt: base, updatedAt: base, hits: 3, source: '手动添加' },
    { id: 'mem-5', kind: 'fact', text: '本机 Python 为 3.12，Shell 使用 PowerShell 7。', weight: 0.64, createdAt: base, updatedAt: base, hits: 2, source: '手动添加' },
  ];
}

function seedMcp(): { cfg: McpServerConfig[]; status: Record<string, McpServerStatus> } {
  return {
    cfg: [
      {
        id: 'mcp-fs',
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/RunWorker/工作区'],
        enabled: true,
        autoStart: true,
        description: '读写工作区文件，已限制在 D:/RunWorker/工作区 内。',
      },
    ],
    status: {
      'mcp-fs': { id: 'mcp-fs', name: 'filesystem', state: 'ready', toolCount: 11 },
    },
  };
}

function seedConversations(): Conversation[] {
  return [];
}

function loadData(): MockData {
  const mcpSeed = seedMcp();
  const defaultSettings = createDefaultSettings();
  defaultSettings.mcpServers = mcpSeed.cfg;
  const fallback: MockData = {
    settings: defaultSettings,
    conversations: seedConversations(),
    tasks: seedTasks(),
    taskRuns: [],
    knowledge: seedKnowledge(),
    memory: seedMemory(),
    mcp: mcpSeed.cfg,
    mcpStatus: mcpSeed.status,
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<MockData>;
    return {
      settings: { ...fallback.settings, ...(parsed.settings ?? {}) },
      conversations: parsed.conversations ?? fallback.conversations,
      tasks: parsed.tasks ?? fallback.tasks,
      taskRuns: parsed.taskRuns ?? [],
      knowledge: parsed.knowledge ?? fallback.knowledge,
      memory: parsed.memory ?? fallback.memory,
      mcp: parsed.mcp ?? fallback.mcp,
      mcpStatus: parsed.mcpStatus ?? fallback.mcpStatus,
    };
  } catch {
    return fallback;
  }
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (Array.isArray(base) || Array.isArray(patch)) return (patch as unknown as T) ?? base;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const current = (base as Record<string, unknown>)[k];
    out[k] = current && typeof current === 'object' && !Array.isArray(current) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(current, v as DeepPartial<typeof current>)
      : v;
  }
  return out as T;
}

function emptyUsage(): UsageStats {
  return { ...DEFAULT_USAGE };
}

function usageOf(prompt: string, completion: string): UsageStats {
  const p = Math.round(prompt.length * 0.8);
  const c = Math.round(completion.length * 0.85);
  return {
    promptTokens: p,
    completionTokens: c,
    reasoningTokens: Math.round(c * 0.4),
    cachedTokens: Math.round(p * 0.3),
    totalTokens: p + c,
    costCny: Number(((p + c) * 0.0000012).toFixed(5)),
    tokenSource: 'estimated',
    exactRequests: 0,
    totalRequests: 1,
  };
}

function metaOf(c: Conversation): ConversationMeta {
  const { messages, summary, trace, ...meta } = c;
  void summary;
  void trace;
  return meta;
}

/* ------------------------------------------------------------------ */
/* Mock 回复素材                                                       */
/* ------------------------------------------------------------------ */

const RISK_WORDS = ['整理', '删除', '重命名', '移动', '批量', '脚本'];

const THINKING_TEXT: Record<string, string> = {
  clean:
    '用户想整理下载文件夹。先确认目录结构，统计文件类型与体积，再按「安装包 / 文档 / 图片 / 压缩包 / 其他」分成五类。移动文件属于会改变磁盘状态的操作，需要先申请授权。计划先列出清单让用户确认，再执行移动，最后输出归档报告。',
  code:
    '这是一个脚本编写任务。需要先确认目标目录、命名规则与冲突策略：同名文件要自动追加序号，避免覆盖。用 pathlib 遍历，保证跨平台；默认只预览不执行，加上 --apply 才真正落盘。再补一份 PowerShell 的等价写法备用。',
  report:
    '周报需要从知识库取最近一周的变更记录。先检索「本周进展」「待办」「风险」三类片段，再按项目分组汇总。引用要带来源路径，避免编造数据。输出结构固定为：本周完成、关键数据、下周计划、需要协助。',
  image:
    '封面图需求。先确定使用场景是桌面应用首屏，比例建议 16:10，主色沿用品牌蓝到青的渐变。构图想用运行中的进度轨道作为隐喻，避免俗套的机器人形象。先出两版提示词，再调用图像生成工具出图并保存到工作区。',
  default:
    '先理解目标，判断是否需要拆步骤。这个问题可以直接回答，不需要调用外部工具。给出结论、执行步骤和验证方式三段即可，控制篇幅，避免重复用户的问题。',
};

interface ReplyPlan {
  thinking: string;
  content: string;
  tool?: { name: string; args: Record<string, unknown>; result: string; risk?: 'low' | 'medium' | 'high'; requiresApproval?: boolean; command?: string };
  citations?: Citation[];
  agentId: AgentId;
}

function buildReply(text: string, requested: AgentId): ReplyPlan {
  const t = text.toLowerCase();
  if (/整理|下载|归档/.test(text)) {
    return {
      agentId: 'computer',
      thinking: THINKING_TEXT.clean,
      tool: {
        name: 'shell.exec',
        args: { shell: 'powershell', command: "Get-ChildItem $env:USERPROFILE\\Downloads -File | Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 8 Name, Count" },
        command: 'Get-ChildItem $env:USERPROFILE\\Downloads -File | Group-Object Extension',
        result: '7 类文件：.exe 18 个 · 3.2 GB\n.zip 9 个 · 1.1 GB\n.pdf 24 个 · 620 MB\n.png 41 个 · 380 MB\n.docx 12 个 · 96 MB',
        risk: 'medium',
        requiresApproval: true,
      },
      content: `## 下载文件夹整理方案

当前识别到 **104 个文件 / 约 5.4 GB**，按类型可分成 5 组：

| 目标目录 | 类型 | 文件数 | 体积 |
| --- | --- | --- | --- |
| 安装包 | .exe .msi | 18 | 3.2 GB |
| 压缩包 | .zip .7z | 9 | 1.1 GB |
| 文档 | .pdf .docx | 36 | 716 MB |
| 图片 | .png .jpg | 41 | 380 MB |

> 移动文件会改变磁盘状态，已暂停等待你的授权。批准后按下面的规则执行。

**执行规则**

1. 目标根目录为 \`D:/RunWorker/工作区/归档\`，按 \`年-月/类型\` 二级分目录。
2. 同名文件自动追加 \`(2)\`，绝不覆盖。
3. 只处理 30 天以前的安装包，近期文件保持原位。
4. 完成后输出移动清单与释放空间。

\`\`\`powershell
$root = "$env:USERPROFILE\\Downloads"
$dest = "D:/RunWorker/工作区/归档"
Get-ChildItem $root -File |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  ForEach-Object {
    $folder = Join-Path $dest ("{0}-{1}" -f $_.LastWriteTime.ToString("yyyy-MM"), $_.Extension.TrimStart("."))
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Move-Item $_.FullName -Destination $folder -WhatIf
  }
\`\`\`

先去掉 \`-WhatIf\` 预览一遍结果，确认后再真实移动。需要我直接按这个方案执行吗？`,
    };
  }
  if (/python|脚本|重命名|rename/.test(t)) {
    return {
      agentId: 'code',
      thinking: THINKING_TEXT.code,
      tool: {
        name: 'fs.write',
        args: { path: 'D:/RunWorker/工作区/tools/rename_images.py', bytes: 1842 },
        result: '已写入 rename_images.py（1.8 KB）',
        risk: 'low',
      },
      content: `## 批量重命名图片脚本

直接保存为 \`rename_images.py\`，默认只预览，加 \`--apply\` 才真正改名。

\`\`\`python
from pathlib import Path
import argparse

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

def plan(directory: Path, prefix: str, start: int):
    files = sorted(p for p in directory.iterdir() if p.suffix.lower() in SUPPORTED)
    width = max(3, len(str(len(files))))
    for i, path in enumerate(files, start):
        yield path, directory / f"{prefix}_{str(i).zfill(width)}{path.suffix.lower()}"

def main():
    parser = argparse.ArgumentParser(description="批量重命名图片，默认预览模式")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--prefix", default="IMG")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    for src, dst in plan(args.directory, args.prefix, args.start):
        print(("重命名 " if args.apply else "预览 ") + f"{src.name} -> {dst.name}")
        if args.apply and not dst.exists():
            src.rename(dst)

if __name__ == "__main__":
    main()
\`\`\`

**使用方式**

\`\`\`bash
# 预览
python rename_images.py "D:/照片/待整理" --prefix 旅行

# 真正执行
python rename_images.py "D:/照片/待整理" --prefix 旅行 --apply
\`\`\`

要点：

- 用 \`pathlib\` 而不是字符串拼接，Windows 与 macOS 都能跑。
- 先排序再编号，重复执行结果稳定。
- 目标已存在时跳过，不会覆盖原图。

需要我把它接到你这个目录上先跑一次预览吗？`,
    };
  }
  if (/周报|总结|汇报|资料/.test(text)) {
    return {
      agentId: 'research',
      thinking: THINKING_TEXT.report,
      tool: {
        name: 'kb.search',
        args: { query: '本周进展 待办 风险', topK: 6 },
        result: '命中 6 个片段，来自 3 份文档，最高相似度 0.87',
        risk: 'low',
      },
      citations: [
        { title: '第 42 周项目周报.md', sourcePath: 'D:/RunWorker/工作区/产品文档/第 42 周项目周报.md', snippet: '本周完成多 Agent 路由的内测，工具调用成功率从 82% 提升到 94%……', score: 0.87 },
        { title: '需求评审纪要-1021.md', sourcePath: 'D:/RunWorker/工作区/产品文档/需求评审纪要-1021.md', snippet: '评审确认首版只保留 8 个子 Agent，知识库仅支持本地目录索引……', score: 0.79 },
        { title: '周会纪要.md', sourcePath: 'D:/RunWorker/工作区/周会纪要.md', snippet: '风险：安装包体积超过 90 MB，需要拆分内置模型资源与静态资源……', score: 0.73 },
      ],
      content: `## 本周工作周报

**周期**：10 月 19 日 — 10 月 23 日 ｜ **来源**：知识库 3 份文档

### 本周完成

- 多 Agent 路由完成内测，工具调用成功率从 82% 提升到 **94%**，平均响应时间下降 1.4s。
- 知识库索引支持增量更新，26 份产品文档重建耗时从 4 分 12 秒降到 38 秒。
- 桌面端自绘窗口、深浅主题与设置中心全部落地，13 个设置分组可实时生效。

### 关键数据

| 指标 | 上周 | 本周 | 变化 |
| --- | --- | --- | --- |
| 工具调用成功率 | 82% | 94% | +12 pt |
| 首字延迟 | 2.6s | 1.2s | -54% |
| 单轮 token 消耗 | 8.4k | 5.9k | -30% |

### 下周计划

1. 上线定时任务的失败重试与通知，补齐运行历史筛选。
2. MCP 连接器支持 HTTP 传输与工具白名单。
3. 打包体积优化，拆分安装包与资源包。

### 需要协助

> 安装包体积已超过 90 MB，需要设计确认是否接受首启时下载资源包。若接受，预计可压到 46 MB。

以上结论均来自知识库检索，点击下方引用可打开原文核对。`,
    };
  }
  if (/封面|图片|图像|生成一张|海报/.test(text)) {
    return {
      agentId: 'image',
      thinking: THINKING_TEXT.image,
      tool: {
        name: 'image.generate',
        args: { prompt: '深色科技风产品封面，蓝青渐变速度线，运行轨道，极简几何', size: '1536x960', steps: 28 },
        result: '已生成 cover-draft-01.png（1536×960）',
        risk: 'low',
      },
      content: `## 产品封面图方案

已按桌面端首屏比例（16:10）出第一版，视觉主线是「持续运行的速度轨道」。

**画面构成**

- 背景：\`#080b12\` 深空底，叠加 -18° 斜向速度线与极淡网格。
- 主体：一条从左侧汇聚、向右延伸的蓝青渐变光轨，末端化为进度节点。
- 留白：右侧 42% 保持低信息密度，用于叠标题与副标题。

\`\`\`text
深色科技产品封面，深空蓝黑背景，蓝到青的渐变速度线从左侧汇聚，
一条发光轨道向右延伸，末端是圆形进度节点，极简几何，轻微网格纹理，
大量留白，电影级布光，8k，无文字
\`\`\`

**已产出**

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| cover-draft-01.png | 1536×960 | 首屏 hero |
| icon-draft-01.png | 512×512 | 应用图标 |

需要更偏"跑车推进感"还是"机械臂作业感"？我可以按选定方向再出两版对比。`,
    };
  }
  return {
    agentId: requested === 'orchestrator' ? 'orchestrator' : requested,
    thinking: THINKING_TEXT.default,
    content: `## 结论

这件事可以直接处理，不需要额外工具。先给可执行的做法：

1. **明确目标**：把需求收敛成一句可验证的结果描述。
2. **最小步骤**：优先用一条命令或一段脚本跑通，再考虑封装。
3. **验证**：给出可复核的输出，而不是只描述过程。

\`\`\`bash
# 以「列出当前目录结构」为例
find . -maxdepth 2 -type f | head -40
\`\`\`

如果你把具体的目录、文件或报错贴给我，我可以直接给出可运行的完整方案，并在这里执行验证。`,
  };
}

function extractTopic(text: string): keyof typeof THINKING_TEXT {
  if (/整理|下载|归档/.test(text)) return 'clean';
  if (/python|脚本|重命名|rename/i.test(text)) return 'code';
  if (/周报|总结|汇报|资料/.test(text)) return 'report';
  if (/封面|图片|图像|生成一张|海报/.test(text)) return 'image';
  return 'default';
}

/* ------------------------------------------------------------------ */
/* Mock 实现                                                           */
/* ------------------------------------------------------------------ */

type Listener<T> = (payload: T) => void;

class MockApi implements RunWorkerApi {
  private data: MockData = loadData();
  private runListeners: Listener<RunEvent>[] = [];
  private toastListeners: Listener<ToastPayload>[] = [];
  private approvalListeners: Listener<ApprovalRequest>[] = [];
  private tasksListeners: Listener<ScheduledTask[]>[] = [];
  private mcpListeners: Listener<McpServerStatus[]>[] = [];
  private kbListeners: Listener<KnowledgeSource[]>[] = [];
  private updateListeners: Listener<UpdateInfo>[] = [];
  private updateProgressListeners: Listener<UpdateProgress>[] = [];
  private settingsListeners: Listener<Settings>[] = [];
  private themeListeners: Listener<'dark' | 'light'>[] = [];
  private aborted = new Set<string>();
  private pending = new Map<string, (approved: boolean) => void>();
  private runSeq = 0;

  private save(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.data));
    } catch {
      /* 预览环境存储不可用时忽略 */
    }
  }

  private emitRun(e: RunEvent): void {
    this.runListeners.forEach((cb) => cb(e));
  }

  private emitToast(kind: ToastPayload['kind'], text: string): void {
    this.toastListeners.forEach((cb) => cb({ kind, text }));
  }

  private emitTasks(): void {
    const list = this.data.tasks;
    this.tasksListeners.forEach((cb) => cb(list));
  }

  private emitMcp(): void {
    const list = Object.values(this.data.mcpStatus);
    this.mcpListeners.forEach((cb) => cb(list));
  }

  private emitKb(): void {
    this.kbListeners.forEach((cb) => cb(this.data.knowledge));
  }

  private touchConversation(id: string): void {
    const c = this.data.conversations.find((x) => x.id === id);
    if (c) {
      c.updatedAt = Date.now();
      c.messageCount = c.messages.length;
      const last = [...c.messages].reverse().find((m) => m.role === 'assistant' || m.role === 'user');
      c.preview = last?.content.slice(0, 80) ?? '';
    }
  }

  bootstrap = async (): Promise<BootstrapPayload> => {
    const meta = this.data.conversations.map(metaOf).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return {
      settings: this.data.settings,
      providers: PROVIDER_PRESETS,
      agents: AGENTS,
      conversations: meta,
      mcp: Object.values(this.data.mcpStatus),
      tasks: this.data.tasks,
      knowledge: this.data.knowledge,
      memory: this.data.memory,
      update: null,
      app: await this.app.info(),
    };
  };

  app = {
    info: async (): Promise<AppInfo> => ({
      name: 'Run worker',
      version: __APP_VERSION__,
      electron: '33.4.11',
      chrome: '130.0.6723.191',
      node: '20.18.1',
      platform: 'win32',
      arch: 'x64',
      userData: 'C:/Users/Administrator/AppData/Roaming/Run worker',
      installDir: 'D:/Apps/Run worker',
      env: { RUN_WORKER_HOME: 'C:/Users/Administrator/.runworker', pathHasInstall: true },
      repoUrl: 'https://github.com/LHRonline/run-worker',
    }),
    openExternal: async (url: string): Promise<void> => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    openPath: async (path: string): Promise<void> => {
      this.emitToast('info', `预览模式无法打开本地文件：${path}`);
    },
    pickFiles: async (opts?: { multiple?: boolean }): Promise<Attachment[]> => {
      const list: Attachment[] = [
        { id: 'att-1', name: '产品需求文档.docx', path: 'D:/RunWorker/工作区/产品需求文档.docx', kind: 'file', size: 348_160, mime: 'application/docx' },
      ];
      if (opts?.multiple) {
        list.push({ id: 'att-2', name: '竞品截图.png', path: 'D:/RunWorker/工作区/竞品截图.png', kind: 'image', size: 812_400, mime: 'image/png' });
      }
      return list;
    },
    pickDirectory: async (): Promise<string | null> => 'D:/RunWorker/工作区',
  };

  window = {
    minimize: (): void => undefined,
    maximize: (): void => undefined,
    close: (): void => undefined,
  };

  settings = {
    get: async (): Promise<Settings> => this.data.settings,
    update: async (patch: DeepPartial<Settings>): Promise<Settings> => {
      this.data.settings = deepMerge(this.data.settings, patch);
      this.data.settings.updatedAt = Date.now();
      this.save();
      this.settingsListeners.forEach((cb) => cb(this.data.settings));
      return this.data.settings;
    },
    reset: async (): Promise<Settings> => {
      this.data.settings = createDefaultSettings();
      this.save();
      return this.data.settings;
    },
    presets: async (): Promise<ProviderPreset[]> => PROVIDER_PRESETS,
    testProvider: async (cfg: ProviderConfig): Promise<ProviderTestResult> => {
      await new Promise((r) => setTimeout(r, 760));
      if (cfg.kind === 'ollama') {
        return { ok: true, latencyMs: 42, message: '本地服务已连通，发现 3 个可用模型', models: cfg.models };
      }
      if (!cfg.apiKey.trim()) {
        return { ok: false, latencyMs: 0, message: '未填写 API Key，无法发起请求' };
      }
      if (cfg.apiKey.trim().length < 8) {
        return { ok: false, latencyMs: 0, message: 'API Key 格式不正确，请检查是否完整复制' };
      }
      return { ok: true, latencyMs: 268, message: '连接成功，模型列表可正常拉取', models: cfg.models };
    },
    models: async (cfg: { providerId: string; baseUrl: string; apiKey: string }): Promise<string[]> => {
      await new Promise((r) => setTimeout(r, 620));
      const preset = PROVIDER_PRESETS.find((p) => p.id === cfg.providerId);
      if (preset?.models.length) return preset.models;
      void cfg;
      return [];
    },
  };

  chat = {
    send: async (req: ChatSendRequest): Promise<{ runId: string; conversationId: string }> => {
      let conv = req.conversationId ? this.data.conversations.find((c) => c.id === req.conversationId) : undefined;
      if (!conv) {
        conv = await this.conversations.create(req.text.slice(0, 18));
      }
      const conversation = conv;
      const now = Date.now();
      const userMsg: ChatMessage = { id: `u-${now}`, role: 'user', content: req.text, createdAt: now, attachments: req.attachments };
      conversation.messages.push(userMsg);
      conversation.agentId = req.agentId ?? conversation.agentId;
      const topic = extractTopic(req.text);
      conversation.title = !conversation.title || conversation.title === '新对话' ? shortTitle(req.text) : conversation.title;
      this.touchConversation(conversation.id);
      this.save();

      const runId = `run-${++this.runSeq}-${now.toString(36)}`;
      const plan = buildReply(req.text, req.agentId ?? 'orchestrator');
      const agentId = req.agentId && req.agentId !== 'orchestrator' ? req.agentId : plan.agentId;
      const model = this.data.settings.activeModel || 'deepseek-reasoner';
      void topic;
      this.stream(runId, conversation.id, plan, agentId, model, req.text);
      return { runId, conversationId: conversation.id };
    },
    abort: async (runId?: string): Promise<void> => {
      if (runId) {
        this.aborted.add(runId);
        this.emitRun({ type: 'run:end', runId, status: 'aborted' });
        this.emitToast('info', '已停止本次运行');
      }
    },
    approve: async (requestId: string, approved: boolean, remember?: boolean): Promise<void> => {
      const resolve = this.pending.get(requestId);
      if (resolve) {
        this.pending.delete(requestId);
        resolve(approved);
      }
      if (remember && approved) {
        this.data.settings.agent.approvalMode = 'safe-only';
        this.save();
      }
    },
  };

  conversations = {
    list: async (): Promise<ConversationMeta[]> =>
      this.data.conversations.map(metaOf).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
    get: async (id: string): Promise<Conversation | null> => {
      const c = this.data.conversations.find((x) => x.id === id);
      return c ? structuredClone(c) : null;
    },
    create: async (title?: string): Promise<Conversation> => {
      const now = Date.now();
      const conv: Conversation = {
        id: `conv-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        title: title?.trim() || '新对话',
        createdAt: now,
        updatedAt: now,
        pinned: false,
        messageCount: 0,
        agentId: 'orchestrator',
        usage: emptyUsage(),
        preview: '',
        messages: [],
      };
      this.data.conversations.unshift(conv);
      this.save();
      return structuredClone(conv);
    },
    rename: async (id: string, title: string): Promise<void> => {
      const c = this.data.conversations.find((x) => x.id === id);
      if (c) c.title = title.trim() || c.title;
      this.save();
    },
    remove: async (id: string): Promise<ConversationPurgeReport> => {
      const before = this.data.conversations.length;
      const beforeMem = this.data.memory.length;
      this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
      this.data.memory = this.data.memory.filter((f) => !(f.source ?? '').includes(id));
      this.save();
      return {
        files: Math.max(0, before - this.data.conversations.length),
        artifacts: 0,
        memories: beforeMem - this.data.memory.length,
        runs: 0,
        failed: [],
      };
    },
    clear: async (): Promise<ConversationPurgeReport> => {
      const files = this.data.conversations.length;
      const beforeMem = this.data.memory.length;
      this.data.conversations = [];
      this.data.memory = this.data.memory.filter((f) => !/^(auto|tool|feedback)(:|$)/.test(f.source ?? ''));
      this.save();
      return { files, artifacts: 0, memories: beforeMem - this.data.memory.length, runs: 0, failed: [] };
    },
    pin: async (id: string, pinned: boolean): Promise<void> => {
      const c = this.data.conversations.find((x) => x.id === id);
      if (c) c.pinned = pinned;
      this.save();
    },
    exportMarkdown: async (id: string): Promise<string> => {
      const c = this.data.conversations.find((x) => x.id === id);
      if (!c) return '';
      return c.messages
        .map((m) => `## ${m.role === 'user' ? '我' : 'Run worker'}\n\n${m.content}`)
        .join('\n\n');
    },
    files: async (id: string): Promise<ConversationFileRef[]> => {
      const c = this.data.conversations.find((x) => x.id === id);
      if (!c) return [];
      const seen = new Set<string>();
      const out: ConversationFileRef[] = [];
      for (const m of c.messages) {
        for (const a of m.attachments ?? []) {
          if (!a?.path || seen.has(a.path)) continue;
          seen.add(a.path);
          out.push({ name: a.name, path: a.path, kind: a.kind, size: a.size, mime: a.mime, origin: 'attachment' });
        }
      }
      return out;
    },
  };

  agents = {
    list: async (): Promise<AgentDescriptor[]> => AGENTS,
  };

  mcp = {
    list: async (): Promise<McpServerStatus[]> => Object.values(this.data.mcpStatus),
    tools: async (): Promise<McpToolInfo[]> => this.mockTools(),
    add: async (cfg: McpServerConfig): Promise<McpServerStatus[]> => {
      const next: McpServerConfig = { ...cfg, id: cfg.id || `mcp-${Date.now().toString(36)}` };
      this.data.mcp = [...this.data.mcp.filter((m) => m.id !== next.id), next];
      this.data.mcpStatus[next.id] = {
        id: next.id,
        name: next.name,
        state: next.enabled ? 'ready' : 'stopped',
        toolCount: next.enabled ? 5 : 0,
        message: next.enabled ? '握手完成，能力已注册' : '已添加，未启用',
      };
      this.save();
      this.emitMcp();
      this.emitToast('success', `已添加连接器 ${next.name}`);
      return Object.values(this.data.mcpStatus);
    },
    remove: async (id: string): Promise<McpServerStatus[]> => {
      this.data.mcp = this.data.mcp.filter((m) => m.id !== id);
      delete this.data.mcpStatus[id];
      this.save();
      this.emitMcp();
      return Object.values(this.data.mcpStatus);
    },
    toggle: async (id: string, enabled: boolean): Promise<McpServerStatus[]> => {
      const cfg = this.data.mcp.find((m) => m.id === id);
      if (cfg) cfg.enabled = enabled;
      const st = this.data.mcpStatus[id];
      if (st) {
        st.state = enabled ? 'ready' : 'stopped';
        st.toolCount = enabled ? Math.max(st.toolCount, 4) : 0;
        st.message = enabled ? '已连接' : '已停用';
      }
      this.save();
      this.emitMcp();
      return Object.values(this.data.mcpStatus);
    },
    connect: async (id: string): Promise<McpServerStatus[]> => {
      const st = this.data.mcpStatus[id];
      if (st) {
        st.state = 'starting';
        st.message = '正在握手…';
        this.emitMcp();
        await new Promise((r) => setTimeout(r, 900));
        st.state = 'ready';
        st.message = '握手完成，能力已注册';
        st.toolCount = st.toolCount || 4;
      }
      this.save();
      this.emitMcp();
      return Object.values(this.data.mcpStatus);
    },
    call: async (serverId: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> => ({
      ok: true,
      content: `${serverId} · ${tool} 在预览模式下返回模拟结果\n参数：${JSON.stringify(args)}`,
    }),
  };

  tasks = {
    list: async (): Promise<ScheduledTask[]> => this.data.tasks,
    save: async (task: ScheduledTask): Promise<ScheduledTask[]> => {
      const idx = this.data.tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) this.data.tasks[idx] = task;
      else this.data.tasks.unshift(task);
      this.save();
      this.emitTasks();
      return this.data.tasks;
    },
    remove: async (id: string): Promise<ScheduledTask[]> => {
      this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
      this.save();
      this.emitTasks();
      return this.data.tasks;
    },
    run: async (id: string): Promise<TaskRun> => {
      const task = this.data.tasks.find((t) => t.id === id);
      const startedAt = Date.now();
      const run: TaskRun = { id: `tr-${startedAt.toString(36)}`, taskId: id, startedAt, status: 'running' };
      this.data.taskRuns.unshift(run);
      if (task) {
        task.lastRunAt = startedAt;
        task.lastStatus = 'running';
        this.emitTasks();
      }
      await new Promise((r) => setTimeout(r, 1400));
      run.status = 'success';
      run.endedAt = Date.now();
      run.output = '已完成本轮执行：读取 3 份资料，生成 5 条要点，结果已写入知识库。';
      if (task) {
        task.lastStatus = 'success';
        task.lastResult = run.output;
        task.nextRunAt = task.nextRunAt && task.nextRunAt > Date.now() ? task.nextRunAt : Date.now() + 3600000;
      }
      this.save();
      this.emitTasks();
      this.emitToast('success', `任务「${task?.name ?? '定时任务'}」执行完成`);
      return run;
    },
    history: async (): Promise<TaskRun[]> => this.data.taskRuns,
  };

  knowledge = {
    list: async (): Promise<KnowledgeSource[]> => this.data.knowledge,
    addSource: async (path: string, watch = true): Promise<KnowledgeSource[]> => {
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      const isFile = /\.[a-z0-9]{2,5}$/i.test(name);
      const now = Date.now();
      this.data.knowledge.push({
        id: `kb-${now.toString(36)}`,
        path,
        name,
        kind: isFile ? 'file' : 'dir',
        files: isFile ? 1 : 12,
        chunks: isFile ? 8 : 196,
        addedAt: now,
        updatedAt: now,
        watch,
        status: 'indexing',
      });
      this.save();
      this.emitKb();
      setTimeout(() => {
        const s = this.data.knowledge.find((k) => k.path === path);
        if (s) {
          s.status = 'ready';
          s.updatedAt = Date.now();
          this.save();
          this.emitKb();
          this.emitToast('success', `「${s.name}」索引完成`);
        }
      }, 1600);
      return this.data.knowledge;
    },
    remove: async (id: string): Promise<KnowledgeSource[]> => {
      this.data.knowledge = this.data.knowledge.filter((k) => k.id !== id);
      this.save();
      this.emitKb();
      return this.data.knowledge;
    },
    reindex: async (id?: string): Promise<KnowledgeStats> => {
      const targets = id ? this.data.knowledge.filter((k) => k.id === id) : this.data.knowledge;
      targets.forEach((k) => {
        k.status = 'indexing';
      });
      this.emitKb();
      await new Promise((r) => setTimeout(r, 1200));
      targets.forEach((k) => {
        k.status = 'ready';
        k.updatedAt = Date.now();
        k.chunks = Math.round(k.files * 16 + Math.random() * 20);
      });
      this.save();
      this.emitKb();
      return this.kbStats();
    },
    search: async (query: string, topK = 5): Promise<KnowledgeHit[]> => {
      await new Promise((r) => setTimeout(r, 480));
      const sources = this.data.knowledge.filter((k) => k.status === 'ready');
      if (!query.trim() || sources.length === 0) return [];
      const templates = [
        `围绕「${query}」的评审结论：首版只保留必要能力，复杂流程放到下一迭代。`,
        `与「${query}」相关的数据：本周工具调用成功率 94%，比上周提升 12 个百分点。`,
        `实现「${query}」时需要注意的坑：路径含空格时必须加引号，避免 PowerShell 截断参数。`,
        `「${query}」的负责人分工：产品负责验收标准，工程负责接口与打包，设计负责视觉还原。`,
      ];
      const hits: KnowledgeHit[] = [];
      for (let i = 0; i < Math.min(topK, 4); i += 1) {
        const src = sources[i % sources.length];
        hits.push({
          id: `hit-${i}`,
          sourceId: src.id,
          sourceName: src.name,
          path: `${src.path}/片段-${i + 1}.md`,
          title: `${src.name} · 第 ${i + 1} 段`,
          snippet: templates[i],
          score: Number((0.92 - i * 0.07).toFixed(2)),
        });
      }
      return hits;
    },
    stats: async (): Promise<KnowledgeStats> => this.kbStats(),
  };

  memory = {
    list: async (): Promise<MemoryFact[]> => this.data.memory,
    add: async (fact: Partial<MemoryFact> & { text: string }): Promise<MemoryFact[]> => {
      const now = Date.now();
      this.data.memory.unshift({
        id: `mem-${now.toString(36)}`,
        kind: fact.kind ?? 'fact',
        text: fact.text,
        weight: fact.weight ?? 0.7,
        createdAt: now,
        updatedAt: now,
        hits: 0,
        source: '手动添加',
      });
      this.save();
      return this.data.memory;
    },
    forget: async (id: string): Promise<MemoryFact[]> => {
      this.data.memory = this.data.memory.filter((m) => m.id !== id);
      this.save();
      return this.data.memory;
    },
    clear: async (): Promise<MemoryFact[]> => {
      this.data.memory = [];
      this.save();
      return [];
    },
  };

  update = {
    check: async (force?: boolean): Promise<UpdateInfo> => {
      void force;
      await new Promise((r) => setTimeout(r, 1100));
      const checkedAt = Date.now();
      // 预览模式不伪造「有新版本」，避免误以为可以升级；更新内容在「本次更新」面板里展示
      return {
        currentVersion: __APP_VERSION__,
        latestVersion: __APP_VERSION__,
        available: false,
        prerelease: false,
        notes: '当前为浏览器预览模式，更新检测与安装仅在桌面版可用。',
        publishedAt: new Date(checkedAt - 86400000 * 2).toISOString(),
        releaseUrl: 'https://github.com/LHRonline/run-worker/releases',
        checkedAt,
      };
    },
    open: async (): Promise<void> => {
      window.open('https://github.com/LHRonline/run-worker/releases/latest', '_blank', 'noopener,noreferrer');
    },
    install: async (): Promise<UpdateProgress> => {
      const stages: UpdateProgress[] = [
        { stage: 'downloading', percent: 35, text: '预览模式：模拟下载中…' },
        { stage: 'verifying', percent: 100, text: '预览模式：模拟校验完成' },
      ];
      for (const p of stages) {
        this.updateProgressListeners.forEach((cb) => cb(p));
        await new Promise((r) => setTimeout(r, 500));
      }
      const done: UpdateProgress = {
        stage: 'done',
        percent: 100,
        text: '浏览器预览不执行真实安装，请在桌面版中升级。',
      };
      this.updateProgressListeners.forEach((cb) => cb(done));
      return done;
    },
  };

  events = {
    onRun: (cb: (e: RunEvent) => void): (() => void) => {
      this.runListeners.push(cb);
      return () => {
        this.runListeners = this.runListeners.filter((x) => x !== cb);
      };
    },
    onApproval: (cb: (req: ApprovalRequest) => void): (() => void) => {
      this.approvalListeners.push(cb);
      return () => {
        this.approvalListeners = this.approvalListeners.filter((x) => x !== cb);
      };
    },
    onToast: (cb: (t: ToastPayload) => void): (() => void) => {
      this.toastListeners.push(cb);
      return () => {
        this.toastListeners = this.toastListeners.filter((x) => x !== cb);
      };
    },
    onTasksChanged: (cb: (t: ScheduledTask[]) => void): (() => void) => {
      this.tasksListeners.push(cb);
      return () => {
        this.tasksListeners = this.tasksListeners.filter((x) => x !== cb);
      };
    },
    onMcpChanged: (cb: (s: McpServerStatus[]) => void): (() => void) => {
      this.mcpListeners.push(cb);
      return () => {
        this.mcpListeners = this.mcpListeners.filter((x) => x !== cb);
      };
    },
    onKnowledgeChanged: (cb: (s: KnowledgeSource[]) => void): (() => void) => {
      this.kbListeners.push(cb);
      return () => {
        this.kbListeners = this.kbListeners.filter((x) => x !== cb);
      };
    },
    onUpdateAvailable: (cb: (i: UpdateInfo) => void): (() => void) => {
      this.updateListeners.push(cb);
      return () => {
        this.updateListeners = this.updateListeners.filter((x) => x !== cb);
      };
    },
    onUpdateProgress: (cb: (p: UpdateProgress) => void): (() => void) => {
      this.updateProgressListeners.push(cb);
      return () => {
        this.updateProgressListeners = this.updateProgressListeners.filter((x) => x !== cb);
      };
    },
    onSettingsChanged: (cb: (s: Settings) => void): (() => void) => {
      this.settingsListeners.push(cb);
      return () => {
        this.settingsListeners = this.settingsListeners.filter((x) => x !== cb);
      };
    },
    onSystemTheme: (cb: (m: 'dark' | 'light') => void): (() => void) => {
      this.themeListeners.push(cb);
      return () => {
        this.themeListeners = this.themeListeners.filter((x) => x !== cb);
      };
    },
  };

  /* --------------------------- 内部实现 --------------------------- */

  private kbStats(): KnowledgeStats {
    return {
      sources: this.data.knowledge.length,
      documents: this.data.knowledge.reduce((n, k) => n + k.files, 0),
      chunks: this.data.knowledge.reduce((n, k) => n + k.chunks, 0),
      updatedAt: Math.max(...this.data.knowledge.map((k) => k.updatedAt), 0),
      vectorReady: true,
    };
  }

  private mockTools(): McpToolInfo[] {
    return Object.values(this.data.mcpStatus)
      .filter((s) => s.state === 'ready')
      .flatMap((s) => {
        const defs: Record<string, [string, string][]> = {
          filesystem: [
            ['read_file', '读取指定路径的文件内容，支持文本与 PDF'],
            ['write_file', '写入文件，若已存在则覆盖'],
            ['list_directory', '列出目录下的文件与子目录'],
            ['search_files', '按名称或内容递归搜索'],
            ['get_file_info', '返回文件大小、修改时间等元信息'],
          ],
          fetch: [
            ['fetch_html', '抓取网页并返回可读文本'],
            ['fetch_json', '请求 JSON 接口并解析'],
          ],
        };
        const list = defs[s.name] ?? [['invoke', '通用能力入口']];
        return list.map(([name, description]) => ({
          serverId: s.id,
          serverName: s.name,
          name,
          description,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        }));
      });
  }

  private async stream(runId: string, conversationId: string, plan: ReplyPlan, agentId: AgentId, model: string, prompt: string): Promise<void> {
    const conv = this.data.conversations.find((c) => c.id === conversationId);
    const assistant: ChatMessage = {
      id: `a-${Date.now().toString(36)}`,
      role: 'assistant',
      content: '',
      thinking: '',
      createdAt: Date.now(),
      agentId,
      model,
      status: 'streaming',
      toolCalls: [],
    };
    if (conv) conv.messages.push(assistant);

    const alive = () => !this.aborted.has(runId);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    this.emitRun({ type: 'run:start', runId, conversationId, agentId: agentId === plan.agentId ? agentId : plan.agentId, model, at: Date.now() });
    await sleep(240);
    if (!alive()) return;

    this.emitRun({ type: 'run:routing', runId, from: 'orchestrator', to: plan.agentId, reason: '按任务类型选择最合适的执行者' });
    await sleep(320);

    const thinking = plan.thinking;
    const step = 3;
    for (let i = 0; i < thinking.length; i += step) {
      if (!alive()) return;
      const delta = thinking.slice(i, i + step);
      assistant.thinking = (assistant.thinking ?? '') + delta;
      this.emitRun({ type: 'run:thinking', runId, delta });
      await sleep(26);
    }
    if (!alive()) return;
    this.emitRun({ type: 'run:thinking-lang', runId, ratio: 0.96, rewritten: false });
    await sleep(140);

    if (plan.tool) {
      const callId = `call-${runId}-1`;
      const requiresApproval = Boolean(plan.tool.requiresApproval);
      const call = {
        id: callId,
        name: plan.tool.name,
        args: plan.tool.args,
        status: requiresApproval ? ('pending' as const) : ('running' as const),
        requiresApproval,
        startedAt: Date.now(),
      };
      assistant.toolCalls = [call];
      this.emitRun({ type: 'run:tool', runId, call });

      if (requiresApproval) {
        const approval: ApprovalRequest = {
          id: `appr-${runId}`,
          runId,
          toolName: plan.tool.name,
          command: plan.tool.command ?? plan.tool.name,
          risk: plan.tool.risk ?? 'medium',
          reason: '该操作会修改本地文件，按当前授权策略需要你确认。',
        };
        const approved = await new Promise<boolean>((resolve) => {
          this.pending.set(approval.id, resolve);
          this.approvalListeners.forEach((cb) => cb(approval));
        });
        if (!alive()) return;
        if (!approved) {
          assistant.toolCalls = [{ ...call, status: 'denied', error: '用户拒绝了本次调用', endedAt: Date.now() }];
          this.emitRun({ type: 'run:tool', runId, call: assistant.toolCalls[0] });
          assistant.status = 'done';
          assistant.content = '已取消这次磁盘操作，未对任何文件产生影响。需要调整整理规则或先预览清单时告诉我。';
          this.emitRun({ type: 'run:content', runId, delta: assistant.content });
          this.emitRun({ type: 'run:end', runId, status: 'done', messageId: assistant.id });
          this.save();
          return;
        }
        assistant.toolCalls = [{ ...call, status: 'running', startedAt: Date.now() }];
        this.emitRun({ type: 'run:tool', runId, call: assistant.toolCalls[0] });
        await sleep(360);
      }

      await sleep(720);
      if (!alive()) return;
      assistant.toolCalls = [{ ...call, status: 'done', result: plan.tool.result, endedAt: Date.now() }];
      this.emitRun({ type: 'run:tool', runId, call: assistant.toolCalls[0] });
      await sleep(200);
    }

    const content = plan.content;
    const chunk = 5;
    let emitted = 0;
    for (let i = 0; i < content.length; i += chunk) {
      if (!alive()) return;
      const delta = content.slice(i, i + chunk);
      assistant.content += delta;
      emitted += delta.length;
      this.emitRun({ type: 'run:content', runId, delta });
      if (plan.citations && emitted > content.length * 0.55) {
        assistant.citations = plan.citations;
        this.emitRun({ type: 'run:citation', runId, citations: plan.citations });
        plan.citations = undefined;
      }
      await sleep(14);
    }
    if (!alive()) return;

    const usage = usageOf(prompt, assistant.content);
    assistant.usage = usage;
    assistant.status = 'done';
    if (conv) {
      conv.usage = {
        promptTokens: conv.usage.promptTokens + usage.promptTokens,
        completionTokens: conv.usage.completionTokens + usage.completionTokens,
        reasoningTokens: conv.usage.reasoningTokens + usage.reasoningTokens,
        cachedTokens: conv.usage.cachedTokens + usage.cachedTokens,
        totalTokens: conv.usage.totalTokens + usage.totalTokens,
        costCny: conv.usage.costCny + usage.costCny,
        tokenSource: 'estimated',
        exactRequests: conv.usage.exactRequests ?? 0,
        totalRequests: (conv.usage.totalRequests ?? 0) + 1,
      };
      this.touchConversation(conv.id);
      this.save();
    }
    this.emitRun({ type: 'run:usage', runId, usage, conversationUsage: conv?.usage ?? usage });
    await sleep(120);
    this.emitRun({ type: 'run:end', runId, status: 'done', messageId: assistant.id });
  }
}

export const mockApi: RunWorkerApi = new MockApi();
export const api: RunWorkerApi = window.runworker ?? mockApi;

/** 供界面判断是否处于桌面运行时（用于隐藏窗口按钮等） */
export const hasNativeWindow = Boolean(window.runworker);

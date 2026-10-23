/**
 * Run worker — 子 Agent 清单（渲染进程与主进程共用描述）
 */
import type { AgentDescriptor } from './types';

export const AGENTS: AgentDescriptor[] = [
  {
    id: 'orchestrator',
    name: '总调度',
    tagline: '理解任务、拆解步骤、分派子 Agent',
    description:
      '主 Agent，负责解析你的目标、判断该由哪个子 Agent 执行、串起多步流程，并对最终结果负责。所有对话默认由它接单。',
    icon: '◎',
    color: '#3b82f6',
    capabilities: ['任务规划', '子 Agent 路由', '多步编排', '结果汇总'],
    tools: ['fs.list', 'fs.read', 'kb.search', 'memory.save', 'task.schedule', 'mcp.call'],
  },
  {
    id: 'code',
    name: '代码工坊',
    tagline: '写代码、改项目、跑测试、修 Bug',
    description:
      '面向工程的子 Agent：读写项目文件、生成完整可运行代码、执行构建与测试命令、定位并修复报错。默认先读结构再动手。',
    icon: '⌘',
    color: '#22d3ee',
    capabilities: ['代码生成', '文件读写', '构建运行', '错误修复'],
    tools: ['fs.list', 'fs.read', 'fs.write', 'shell.exec', 'python.exec', 'net.fetch'],
  },
  {
    id: 'image',
    name: '图像生成',
    tagline: '文生图、图生图、封面与图标设计',
    description:
      '把自然语言或参考图变成可用图片：封面、图标、插画、产品图。会先规划构图与风格，再调用图像接口或本地脚本产出文件。',
    icon: '◈',
    color: '#a855f7',
    capabilities: ['文生图', '图生图', '风格控制', '批量出图'],
    tools: ['image.generate', 'fs.write', 'fs.read'],
    requiresImageGen: true,
  },
  {
    id: 'model',
    name: '模型生成',
    tagline: '文本生成 3D 模型与资产管线',
    description:
      '负责 3D 资产：根据描述生成模型脚本、导出 glb/obj、批量处理网格与材质，并可调用外部 3D 生成 MCP。',
    icon: '◇',
    color: '#f59e0b',
    capabilities: ['3D 资产生成', '格式转换', '批量处理', 'MCP 对接'],
    tools: ['model.generate', 'python.exec', 'fs.write'],
  },
  {
    id: 'video',
    name: '视频生成',
    tagline: '文生视频、图生视频、剪辑与转码',
    description:
      '生成短视频、把图片转成动态镜头，或用 ffmpeg 做剪辑、拼接、加字幕与转码，输出可直接播放的 mp4。',
    icon: '▶',
    color: '#ef4444',
    capabilities: ['文生视频', '图生视频', '剪辑转码', '字幕合成'],
    tools: ['video.generate', 'shell.exec', 'ffmpeg', 'fs.write'],
    requiresImageGen: true,
  },
  {
    id: 'computer',
    name: '电脑操控',
    tagline: '执行 Shell/Python、管理文件与进程',
    description:
      '真正"能动手"的子 Agent：执行系统命令、跑 Python 脚本、批量整理文件、查看进程与端口。危险操作会先向你申请授权。',
    icon: '▣',
    color: '#10b981',
    capabilities: ['Shell 执行', 'Python 脚本', '文件管理', '进程与端口'],
    tools: ['shell.exec', 'python.exec', 'fs.list', 'fs.read', 'fs.write', 'fs.delete'],
  },
  {
    id: 'research',
    name: '资料研究',
    tagline: '查知识库、读文档、联网检索并给出结论',
    description:
      '基于你的本地资料库与网络信息做检索与综合，输出带引用的结论。适合读长文档、做对比、整理调研纪要。',
    icon: '❖',
    color: '#6366f1',
    capabilities: ['知识库检索', '文档解析', '联网检索', '引用溯源'],
    tools: ['kb.search', 'net.fetch', 'fs.read', 'memory.save'],
  },
  {
    id: 'data',
    name: '数据分析',
    tagline: '表格清洗、统计分析、图表生成',
    description:
      '处理 CSV/Excel/JSON：清洗、聚合、透视、出图。会用 Python 跑统计并生成可直接查看的图表文件。',
    icon: '▤',
    color: '#14b8a6',
    capabilities: ['表格清洗', '统计分析', '透视汇总', '图表输出'],
    tools: ['python.exec', 'fs.read', 'fs.write', 'data.chart'],
  },
];

export const AGENT_MAP: Record<string, AgentDescriptor> = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

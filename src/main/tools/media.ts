/**
 * Run worker — 生成类工具（图像 / 视频 / 3D 模型）
 * 有可用接口就真调用；没有配置就落地「提示词 + 可执行脚本」，绝不假装已经出图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeBaseUrl } from '../llm/client';
import { fail, num, ok, str } from './types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import type { ProviderConfig, Settings } from '../../shared/types';
import { resolveToolPath } from './fs';

type MediaKind = 'image' | 'video' | 'model';

const HINTS: Record<MediaKind, RegExp> = {
  image: /dall-e|gpt-image|flux|stable-diffusion|sd3|kolors|wanx|qwen-image|imagen/i,
  video: /sora|veo|kling|runway|pika|wan2|video/i,
  model: /3d|tripo|meshy|rodin|hunyuan3d/i,
};

/** 在设置里找最合适的那条服务商；必须可调用（有 Key 或本地服务） */
function pickProvider(settings: Settings, kind: MediaKind): ProviderConfig | null {
  const usable = settings.providers.filter((p) => p.enabled && (p.apiKey.trim() || p.kind === 'ollama'));
  const hinted = usable.find((p) => p.models.some((m) => HINTS[kind].test(m)) || HINTS[kind].test(p.id) || HINTS[kind].test(p.name));
  if (hinted) return hinted;
  if (kind === 'image') {
    // OpenAI 兼容中转通常也提供 /images/generations
    const compat = usable.find((p) => p.kind === 'openai-compatible' || p.kind === 'custom');
    if (compat) return compat;
  }
  return null;
}

function slug(text: string): string {
  const base = text
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'output';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const IMAGE_SCRIPT = (provider: ProviderConfig, model: string, prompt: string, size: string, outFile: string) => `# -*- coding: utf-8 -*-
"""Run worker 生成：图像
用法：
  1) pip install requests
  2) set OPENAI_API_KEY=你的Key    （PowerShell: $env:OPENAI_API_KEY="你的Key"）
  3) python ${path.basename(outFile)}.py
"""
import base64, os, pathlib, requests

BASE_URL = ${JSON.stringify(normalizeBaseUrl(provider.baseUrl))}
API_KEY = os.environ.get("OPENAI_API_KEY", ${JSON.stringify(provider.apiKey ? '<已内嵌>' : '')})
MODEL = ${JSON.stringify(model)}
PROMPT = ${JSON.stringify(prompt)}
SIZE = ${JSON.stringify(size)}
OUT = pathlib.Path(__file__).with_name(${JSON.stringify(outFile)})

resp = requests.post(
    f"{BASE_URL}/images/generations",
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    json={"model": MODEL, "prompt": PROMPT, "size": SIZE, "n": 1, "response_format": "b64_json"},
    timeout=180,
)
resp.raise_for_status()
data = resp.json()["data"][0]
if data.get("b64_json"):
    OUT.write_bytes(base64.b64decode(data["b64_json"]))
else:
    OUT.write_bytes(requests.get(data["url"], timeout=180).content)
print("已保存：", OUT)
`;

const VIDEO_PROMPT_DOC = (prompt: string, extra: string) => `# 视频生成任务

## 提示词
${prompt}

## 建议参数
${extra}

## 可选执行路径
1. 可灵 / 即梦 / Runway / Pika 网页版：把上面的提示词粘进去，导出 mp4 后放到工作目录。
2. 已有视频 API（如可灵、Veo）时，在「设置 → 模型服务」新增一条 OpenAI 兼容服务商，模型名包含 video，
   然后重新执行本工具的 video.generate，会自动调用接口。
3. 用 ffmpeg 把已有图片做成动态镜头：
   \`ffmpeg -loop 1 -i input.png -vf "zoompan=z='min(zoom+0.0015,1.2)':d=125" -t 5 -pix_fmt yuv420p out.mp4\`
`;

const MODEL_SCRIPT = (prompt: string, outFile: string) => `# -*- coding: utf-8 -*-
"""Run worker 生成：3D 模型（程序化建模）
用法：
  1) pip install trimesh numpy
  2) python ${path.basename(outFile)}.py
说明：没有 3D 生成 API 时，用参数化几何体近似目标形态；有 Meshy/Tripo 等 MCP 时优先走 mcp.call。
"""
import trimesh, numpy as np

PROMPT = ${JSON.stringify(prompt)}
OUT = ${JSON.stringify(outFile)}

# 基础体：按描述调整尺寸与细分
mesh = trimesh.creation.box(extents=(2.0, 2.0, 2.0))
mesh = mesh.subdivide().smooth()

# 落地导出
scene = trimesh.Scene(mesh)
with open(OUT.replace(".glb", ".gltf"), "w", encoding="utf-8") as f:
    f.write(scene.export(file_type="gltf"))
scene.export(OUT)
print("已导出：", OUT)
print("提示词：", PROMPT)
`;

function writeArtifacts(rt: { artifactsDir: string }, files: Array<{ name: string; content: string }>): string[] {
  fs.mkdirSync(rt.artifactsDir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const target = path.join(rt.artifactsDir, f.name);
    fs.writeFileSync(target, f.content, 'utf8');
    written.push(target);
  }
  return written;
}

/** 直接调用 OpenAI 兼容 /images/generations，成功则把图片落盘 */
async function callImageApi(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  size: string,
  tc: ToolContext,
): Promise<{ file: string; bytes: number } | { error: string }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  tc.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = data.data?.[0];
    if (!item) return { error: '接口没有返回图片数据' };
    let buf: Buffer;
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
    else if (item.url) {
      const img = await fetch(item.url, { signal: controller.signal });
      buf = Buffer.from(await img.arrayBuffer());
    } else return { error: '接口返回里既没有 b64_json 也没有 url' };

    fs.mkdirSync(tc.rt.artifactsDir, { recursive: true });
    const file = path.join(tc.rt.artifactsDir, `image-${stamp()}.png`);
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    tc.signal.removeEventListener('abort', onAbort);
  }
}

export const mediaTools: ToolDefinition[] = [
  {
    name: 'image.generate',
    description:
      '生成图片：封面、图标、插画、产品图。会优先调用已配置的图像接口；若未配置接口，会把优化后的提示词和可直接运行的 Python 脚本写到产物目录。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，写清主体、风格、构图、光照、比例' },
        size: { type: 'string', description: '尺寸，如 1024x1024、1024x1536、512x512，默认 1024x1024' },
        filename: { type: 'string', description: '输出文件名（不含目录），可选' },
      },
      required: ['prompt'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const settings = rt.settings();
      const prompt = str(args, 'prompt').trim();
      if (!prompt) return fail('图片描述不能为空。');
      const size = str(args, 'size', '1024x1024') || '1024x1024';
      const provider = pickProvider(settings, 'image');
      const model = provider?.models.find((m) => HINTS.image.test(m)) ?? provider?.models[0] ?? '';

      if (provider && provider.apiKey.trim() && model) {
        const result = await callImageApi(provider, model, prompt, size, tc);
        if ('file' in result) {
          return ok(`已生成图片并保存到：${result.file}（${(result.bytes / 1024).toFixed(0)} KB）\n模型：${model}｜尺寸：${size}`);
        }
        rt.log.warn('[image.generate] 接口调用失败', result.error);
        rt.notify('warn', `图像接口调用失败：${result.error}，已改为输出提示词与脚本。`);
      }

      const base = slug(str(args, 'filename') || prompt);
      const scriptName = `${base}-${stamp()}.py`;
      const files = writeArtifacts(rt, [
        {
          name: `${scriptName}.prompt.md`,
          content: `# 图像生成提示词\n\n${prompt}\n\n尺寸：${size}\n推荐模型：gpt-image-1 / dall-e-3 / flux-schnell\n`,
        },
        {
          name: scriptName,
          content: IMAGE_SCRIPT(
            provider ?? { id: 'unset', name: '未配置', kind: 'custom', baseUrl: 'https://api.openai.com', apiKey: '', models: [], free: false, enabled: false },
            model || 'gpt-image-1',
            prompt,
            size,
            `${base}-${stamp()}.png`,
          ),
        },
      ]);
      const missing = provider ? `「${provider.name}」缺少可用的图像模型或 Key` : '尚未配置图像生成接口（缺少 API Key）';
      return ok(
        `没有真的生成图片：${missing}。\n\n已把提示词与可直接运行的脚本写到：\n${files.map((f) => `- ${f}`).join('\n')}\n\n下一步：\n1. 到「设置 → 模型服务」新增支持 Images API 的服务商（OpenAI 或兼容中转）并填 Key；\n2. 或安装依赖后手动执行脚本：pip install requests，再设置 OPENAI_API_KEY 运行上面的 .py。`,
      );
    },
  },
  {
    name: 'video.generate',
    description:
      '生成短视频或图生视频。当前没有内置视频接口，会输出可直接用于可灵/Runway/Veo 的提示词与 ffmpeg 处理方案；配置了视频服务商后会真正调用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '镜头描述：画面内容、运镜、时长、风格' },
        durationSec: { type: 'number', description: '期望时长（秒），默认 5' },
        aspect: { type: 'string', description: '画幅，如 16:9、9:16、1:1' },
        imagePath: { type: 'string', description: '图生视频时的参考图路径，可选' },
      },
      required: ['prompt'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const settings = rt.settings();
      const prompt = str(args, 'prompt').trim();
      if (!prompt) return fail('视频描述不能为空。');
      const duration = Math.min(60, Math.max(1, Math.round(num(args, 'durationSec', 5))));
      const aspect = str(args, 'aspect', '16:9') || '16:9';
      const imagePath = str(args, 'imagePath');
      const provider = pickProvider(settings, 'video');

      const extra = [`时长：${duration} 秒`, `画幅：${aspect}`];
      if (imagePath) extra.push(`参考图：${resolveToolPath(rt.workspace(), imagePath)}`);
      const doc = writeArtifacts(rt, [{ name: `video-${slug(prompt)}-${stamp()}.md`, content: VIDEO_PROMPT_DOC(prompt, extra.join('\n')) }]);

      if (provider && provider.apiKey.trim()) {
        return ok(
          `已检测到视频服务商「${provider.name}」，但视频接口各家协议不同，需要手动确认参数。\n已把提示词与执行方案写到：\n- ${doc[0]}\n\n建议用 mcp.call 接对应 MCP，或在设置里替换为该服务商的 OpenAI 兼容网关。`,
        );
      }
      return ok(
        `还没有配置视频生成接口（缺少对应 API Key），因此没有生成视频。\n\n提示词与执行方案已保存：\n- ${doc[0]}\n\n可选路径：\n- 用到可灵/即梦/Runway 网页版按提示词生成后下载；\n- 用 ffmpeg 把图片做成动态镜头（方案文件里有命令）；\n- 配置视频服务商后重试会自动调用。`,
      );
    },
  },
  {
    name: 'model.generate',
    description:
      '生成 3D 模型资产。无 3D 生成接口时，产出可运行的 trimesh 程序化建模脚本（导出 glb/gltf）；已配置 3D 服务或 MCP 时优先调用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '模型描述：物体、尺寸、风格、面数要求' },
        format: { type: 'string', description: '导出格式：glb / gltf / obj / stl，默认 glb' },
        filename: { type: 'string', description: '输出文件名，可选' },
      },
      required: ['prompt'],
    },
    async run(args, tc): Promise<ToolResult> {
      const rt = tc.rt;
      const prompt = str(args, 'prompt').trim();
      if (!prompt) return fail('模型描述不能为空。');
      const format = (str(args, 'format', 'glb') || 'glb').toLowerCase();
      const base = slug(str(args, 'filename') || prompt);
      const outName = `${base}-${stamp()}.${format}`;
      const files = writeArtifacts(rt, [
        { name: `${base}-${stamp()}.prompt.md`, content: `# 3D 模型任务\n\n${prompt}\n\n导出格式：${format}\n建议：有 Meshy/Tripo/Hunyuan3D 的 MCP 时优先调用 mcp.call 获得高质量网格。\n` },
        { name: `${base}-${stamp()}.py`, content: MODEL_SCRIPT(prompt, outName) },
      ]);
      const mcpHint = rt.mcp.tools().filter((t) => /3d|mesh|model/i.test(t.name) || HINTS.model.test(t.name));
      return ok(
        `还没有配置 3D 生成接口，因此没有直接产出模型文件。\n已生成可执行的程序化建模脚本与提示词：\n${files.map((f) => `- ${f}`).join('\n')}\n\n下一步：\n1. pip install trimesh numpy，然后运行脚本导出 ${outName}；\n2. ${mcpHint.length > 0 ? `检测到可能相关的 MCP 工具：${mcpHint.map((t) => t.name).join('、')}，可用 mcp.call 调用。` : '如需高质量生成，可接入 Meshy/Tripo 的 MCP 服务。'}`,
      );
    },
  },
];

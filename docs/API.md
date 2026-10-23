# 模型接入说明

Run worker 不绑定任何厂商，统一走 **OpenAI 兼容协议**。本文说明协议要求、内置渠道参数、function calling 约束、思考流字段与错误码处理。

字段与预设来源：`src/shared/presets.ts`（`PROVIDER_PRESETS`）、`src/shared/types.ts`（`ProviderConfig`、`UsageStats`）。
各渠道的额度与模型上下架由服务商决定，**以官方文档与实际测试结果为准**。

---

## 1. 协议要求

应用以 `<baseUrl>/chat/completions` 发起请求（部分服务商同时支持 `/v1` 前缀，填写到预设给出的 `baseUrl` 即可）。

### 1.1 必需能力

| 能力 | 要求 | 不满足的后果 |
| --- | --- | --- |
| `POST /chat/completions` | 必须 | 无法对话 |
| `stream: true`（SSE） | 必须 | 无法流式展示，判为渠道不可用 |
| `choices[].delta.content` | 必须 | 无正文输出 |
| `usage` 字段 | 建议 | 缺失则用量显示为 0，预算告警失效 |
| `tools` + `tool_calls` | 需要的 Agent 才用 | 无此能力时工具类 Agent 不可用，纯对话仍可用 |
| `GET /models` | 可选 | 拉不到列表时手动填写模型名 |

### 1.2 请求骨架

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "temperature": 0.6,
  "max_tokens": 4096,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "fs.read",
        "description": "读取文件内容",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
      }
    }
  ]
}
```

请求头：

```
Authorization: Bearer <apiKey>
Content-Type: application/json
```

本地 Ollama 不需要 `Authorization`。

### 1.3 流式响应骨架

```
data: {"choices":[{"delta":{"reasoning_content":"先看目录结构"}}]}
data: {"choices":[{"delta":{"content":"我先扫描"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs.list","arguments":"{\"path\":\"D:\\\\work\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{...}}
data: [DONE]
```

要点：

- `delta.content` 与 `delta.reasoning_content` 是两个独立字段，分别驱动 `run:content` 与 `run:thinking`。
- `tool_calls` 的 `arguments` 是**字符串分片**，必须按 `index` 累积拼接后再 `JSON.parse`。
- `finish_reason` 为 `tool_calls` 时进入工具循环；为 `stop` 时结束。
- 部分服务商在最后一帧之外不发 `usage`，需要 `stream_options: { "include_usage": true }`（是否支持以服务商为准）。

### 1.4 `usage` 字段映射

| 响应字段 | `UsageStats` | 说明 |
| --- | --- | --- |
| `prompt_tokens` | `promptTokens` | 输入 |
| `completion_tokens` | `completionTokens` | 输出（部分厂商含思考 token） |
| `completion_tokens_details.reasoning_tokens` | `reasoningTokens` | 思考消耗 |
| `prompt_tokens_details.cached_tokens` | `cachedTokens` | 前缀缓存命中，用于验证 `cacheFriendlyPrefix` 是否生效 |
| 合计 | `totalTokens` | 缺失时按前两项相加 |
| — | `costCny` | 由本地价格表估算，非服务商返回 |

---

## 2. 内置渠道参数

| 预设 id | 名称 | `baseUrl` | 默认模型 | 免费 | 申请地址 |
| --- | --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-chat`、`deepseek-reasoner` | 否 | <https://platform.deepseek.com/api_keys> |
| `openrouter-free` | OpenRouter（免费模型） | `https://openrouter.ai/api/v1` | `deepseek/deepseek-r1:free` 等 4 个 | 是 | <https://openrouter.ai/keys> |
| `groq` | Groq（免费额度） | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` 等 3 个 | 是 | <https://console.groq.com/keys> |
| `siliconflow` | 硅基流动（免费模型） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` 等 3 个 | 是 | <https://cloud.siliconflow.cn/account/ak> |
| `ollama` | Ollama 本地 | `http://localhost:11434/v1` | `qwen2.5:7b` 等 3 个 | 是（本地） | 无需 Key |
| `custom` | 自定义 OpenAI 兼容接口 | 自填 | 自填 | 否 | — |

### 2.1 各渠道备注

| 渠道 | 特点 | 限制 |
| --- | --- | --- |
| DeepSeek 官方 | 原生思维链，`deepseek-reasoner` 返回 `reasoning_content`；国内直连，价格低 | 需付费；高峰期可能排队 |
| OpenRouter 免费 | 带 `:free` 后缀零成本，模型选择多 | 有每分钟/每日调用上限；免费模型可能随时下线 |
| Groq | 推理极快，适合长对话与多轮工具循环 | 免费额度按天刷新，超限 `429` |
| 硅基流动 | 国内节点延迟低，7B 级模型长期免费，中文好 | 大模型需付费；并发有限 |
| Ollama 本地 | 零成本零联网，隐私最好 | 速度取决于硬件；小模型工具调用能力弱 |
| 自定义 | vLLM、LM Studio、OneAPI 中转、公司内网网关 | 需自行保证 function calling 与流式兼容 |

### 2.2 添加自定义渠道

设置 → 模型渠道 → 新增：

| 字段 | 说明 |
| --- | --- |
| `name` | 显示名 |
| `kind` | 选 `custom`（或语义最接近的：`openai-compatible` / `ollama` 等） |
| `baseUrl` | **不含** `/chat/completions`，例如 `http://192.168.1.10:8000/v1` |
| `apiKey` | 内网服务可留空 |
| `models` | 逗号分隔或从“拉取模型”导入 |
| `free` | 若为本地/自建，勾选后 `freeMode` 会优先选用 |
| `enabled` | 关闭后不参与路由 |

填完点 **测试连接**（`providers:test`），返回 `ok` 与 `latencyMs` 才算配置可用。

---

## 3. Function calling 要求

工具类 Agent（代码工坊、电脑操控、数据分析等）依赖 function calling。要求：

1. 请求体接受标准 `tools` 数组（`type: "function"` + `function.name/description/parameters`）。
2. 响应能在 `delta.tool_calls`（流式）或 `message.tool_calls`（非流式）返回调用。
3. 支持 `role: "tool"` 消息并识别 `tool_call_id` 回填。

```json
{ "role": "tool", "tool_call_id": "call_1", "content": "文件列表：a.txt, b.txt" }
```

注意：

- 部分小参数模型（3B 级、量化版）对工具调用支持不稳，会出现参数不合法或该调不调。这类模型建议只用于纯对话。
- `temperature` 过高（>1.0）会显著提高工具参数格式错误率，`persona.temperature` 默认 0.6。
- 工具结果会按 `tokenSave.toolOutputLimit`（默认 4000 字符）截断后再回灌。

判断方法：选一个明确需要工具的任务（如“列出 D:\ 下的文件夹”），看是否出现 `run:tool` 事件且 `status` 到 `done`。

---

## 4. DeepSeek 风格思考流

### 4.1 `reasoning_content`

`deepseek-reasoner` 在流式响应的 `delta` 里同时给出 `reasoning_content`（思考）与 `content`（正文）。应用把前者映射为 `run:thinking`，后者为 `run:content`，界面分栏展示。

**关键约定**：思考内容**不回传**给模型。下一轮请求里只保留 `content`，不把 `reasoning_content` 塞回 `messages`——这是 DeepSeek 官方建议，也是 `tokenSave.skipReasoningResend`（默认开启）的作用。若关闭该开关，思考内容会作为普通文本回传，token 消耗明显上升。

### 4.2 强制中文思考

`thinking.forceChinese`（默认开启）通过系统提示要求用中文思考；同时统计输出中的中文占比：

| 字段 | 默认 | 行为 |
| --- | --- | --- |
| `thinking.chineseRatioThreshold` | `0.55` | 占比低于阈值时触发一次重述，并通过 `run:thinking-lang` 推送 `ratio` 与 `rewritten: true` |
| `thinking.showTokens` | `true` | 思考块显示 token 数 |

重述只做一次，避免死循环；仍不达标就按原样展示。

### 4.3 兼容其他厂商

OpenRouter 上的 `deepseek-r1` 系列、Groq 的 `deepseek-r1-distill-*`、硅基流动的 `deepseek-ai/DeepSeek-R1` 也返回 `reasoning_content`（字段名可能为 `reasoning`）。识别不到该字段时思考区为空，正文不受影响。

---

## 5. Ollama 本地配置

```bash
# 1. 安装 Ollama（官网下载 Windows 安装包）
# 2. 拉取模型
ollama pull qwen2.5:7b
ollama pull deepseek-r1:7b      # 需要思考流时
# 3. 确认服务在跑（默认 11434）
ollama list
```

应用侧：

1. 设置 → 模型渠道 → 选 `Ollama 本地（完全免费）`。
2. `baseUrl` 保持 `http://localhost:11434/v1`，API Key 留空。
3. 模型名必须与 `ollama list` 输出**完全一致**（含 tag，如 `qwen2.5:7b`）。
4. 点测试连接，选模型，开始对话。

排错：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 连接超时 | 服务未启动 | 运行 `ollama serve`，或确认托盘图标在跑 |
| `404 model not found` | 模型名不匹配/未 pull | `ollama list` 对照 |
| 请求被代理拦截 | 系统代理接管了 `localhost` | 本地地址加入 no-proxy（后续版本内置处理） |
| 工具调用乱参数 | 模型太小 | 换 7B 以上，或降低 `temperature` |

---

## 6. 错误码对照

| HTTP | 常见原因 | 应用提示方向 | 处理建议 |
| --- | --- | --- | --- |
| `400` | 请求体不合法：模型名错、参数越界、工具 schema 非法 | 参数错误 | 检查模型名是否在该渠道 `models` 里；降低 `temperature` |
| `401` | Key 无效、过期、复制带空格 | 鉴权失败 | 重新粘贴 Key，注意首尾空白与换行 |
| `402` | 余额不足（DeepSeek、硅基流动等） | 额度不足 | 充值，或切到免费渠道 |
| `403` | Key 无该模型权限、地域限制 | 无权限 | 换模型或换渠道 |
| `404` | `baseUrl` 少了/多了 `/v1`，或路径拼错 | 接口不存在 | `baseUrl` 只填到 `/v1`，不要带 `/chat/completions` |
| `413` | 单次请求过大 | 上下文过长 | 开启 `compressThreshold` 压缩，减少附件 |
| `422` | 工具参数校验失败 | 参数不合法 | 降低 `temperature`，换工具调用能力更强的模型 |
| `429` | 限流 / 免费额度用尽 | 请求过快或额度耗尽 | 等待重试、换渠道、关闭 `freeMode` 手动选付费模型 |
| `5xx` | 服务端故障、网关超时 | 服务不可用 | 稍后重试；持续失败则换渠道 |
| 无状态码 | DNS/代理/TLS 失败、连接超时 | 网络异常 | 检查代理与防火墙；本地渠道确认端口可达 |

应用内排查顺序：

1. 设置 → 模型渠道，看该渠道 `status` 与 `statusMessage`（`checkedAt` 为最后检测时间）。
2. 点“测试连接”复现，`ProviderTestResult.message` 会带上具体原因。
3. 仍无法定位时看 `%APPDATA%\Run worker\logs\main-YYYY-MM-DD.log`，关键信息已脱敏（不含明文 Key）。

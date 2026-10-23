# Run worker 0.0.1

一个跑在 Windows 桌面上的 AI Agent 客户端：给一句目标，它自己判断该由哪个子 Agent 接手、该调哪些工具，然后真的去执行——写文件、跑命令、出图、剪辑、查本地资料库。不绑定厂商，任何兼容 OpenAI 协议的接口都能接，默认按「省 token + 中文思考流」的方式工作。

## 本版包含

- **多 Agent 架构**：总调度 `orchestrator` 统一接单，按意图路由到 `code` / `image` / `model` / `video` / `computer` / `research` / `data` 七个子 Agent；手动选子 Agent 时优先，自动路由只影响本轮、不回写会话基线。
- **真人级电脑操控**：执行 PowerShell / cmd / bash 与 Python，读写文件、查进程与端口；高风险命令默认要求审批，命中黑名单直接拒绝。
- **MCP 连接器**：支持 `stdio` 与 `http` 两种传输，服务器工具自动并入工具池，单个服务器连不上不影响其他。
- **本地知识库**：索引本地目录与文件，BM25 词法检索，回答带 `Citation` 引用；向量能力不可用时自动退回词法检索。
- **中文思考流**：实时展示 `reasoning_content`，非中文占比低于阈值时自动重述一次，可显示 token 数。
- **免费 API 开箱可用**：内置 OpenRouter `:free`、Groq、硅基流动、Ollama 本地四条零成本路径，另有 DeepSeek 官方与自定义 OpenAI 兼容接口。
- **省 token**：历史条数上限、滚动摘要、工具输出截断、思考不回传、单次输出上限、前缀缓存友好六项机制，配合默认的「直给模式」。
- **安装器体验**：NSIS 非一键式，可选安装目录、建桌面与开始菜单快捷方式，自动写入 `RUN_WORKER_HOME` 并追加到用户 `PATH`，卸载时清理。

## 安装

1. 下载 `Run-worker-0.0.1-setup.exe`（[Releases](https://github.com/LHRonline/run-worker/releases)）并双击运行。
2. 选择安装目录（默认在用户目录下，不需要管理员权限），点下一步完成安装。
3. 首次启动进引导页，配一个模型渠道即可用；环境变量已自动配好，新开终端可用 `echo %RUN_WORKER_HOME%` 验证。

完整说明见 [docs/INSTALL.md](INSTALL.md)，静默安装用 `/S /D=<目录>`。

## 已知限制

> 0.0.2 已修复其中「命令判定变体」并补齐更新包 SHA-256 参照，Key 加密存储见 [RELEASE-NOTES-0.0.2.md](RELEASE-NOTES-0.0.2.md)。

- **无 Key 时进入演示模式**：不调用真实模型，只返回本地模拟内容，用于先跑通界面。
- **MCP 需自备服务器**：`stdio` 传输会以当前用户权限执行你填写的 `command`，请只添加信任的服务器。
- **图像 / 视频 / 3D 需外部能力**：内置不含生成模型，需配置对应接口或 3D 生成类 MCP，否则相关 Agent 会提示能力缺失。
- **安装包未签名**：Windows SmartScreen 会提示「未知发布者」，可点「更多信息 → 仍要运行」；代码签名在后续版本补齐。
- **更新检测取决于发布状态**：仓库已公开但尚未发布 Release 时，检查更新返回「更新源暂无发布版本」；仓库不可见时才返回「更新源仓库不存在或无权访问（HTTP 404）」。两者都属预期，不抛异常。

## 校验

发布前跑过 `npm test`（10 项平台集成用例）与 `npm run test:e2e`（22 项真实 Electron 端到端断言），均全绿：`ALL PASS (22/22)`。

---

完整变更见 [CHANGELOG.md](../CHANGELOG.md)；安装与使用教程见 [INSTALL.md](INSTALL.md) 与 [API.md](API.md)。

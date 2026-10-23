# 更新日志

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- （暂无）

### Changed

- （暂无）

### Fixed

- （暂无）

## [0.0.2] - 预计 2026-11-06

> 补丁版本：仅修复问题，不新增功能、不改配置格式。详细清单见 [docs/PATCH-ROADMAP.md](docs/PATCH-ROADMAP.md)。

### Fixed

- 切换会话时上一轮思考流未中断，增量内容写入错误的会话
- 中文或含空格路径下 `python.exec` 执行失败
- 浅色主题下工具卡片文字对比度不足
- 网络抖动导致 `run:end` 缺失，界面停留在运行中
- 跨天日志未切分，单文件持续膨胀

### Security

- 无

## [0.0.1] - 2026-10-23

首个公开版本。

### Added

- **多 Agent 架构**：总调度 `orchestrator` 统一接单，按意图路由到 `code`、`image`、`model`、`video`、`computer`、`research`、`data` 七个子 Agent；手动选中子 Agent 时优先于自动路由，不路由也不发 `run:routing`（选中总调度或未指定时仍按 `agent.autoDelegate` 自动分派）。自动路由只决定本轮执行者、不回写会话基线，只有手动选择才会把会话钉在某个 Agent 上
- **工具层**：`fs.list` / `fs.read` / `fs.write` / `fs.delete`、`shell.exec`、`python.exec`、`net.fetch`、`kb.search`、`memory.save`、`task.schedule`、`mcp.call`、`image.generate`、`model.generate`、`video.generate`、`ffmpeg`、`data.chart`
- **模型渠道**：内置 6 个预设（DeepSeek 官方、OpenRouter 免费模型、Groq、硅基流动、Ollama 本地、自定义 OpenAI 兼容接口），支持连通性测试、模型列表拉取、免费优先（`freeMode`）
- **中文思考流**：流式展示 `reasoning_content`，中文占比低于 `thinking.chineseRatioThreshold` 时自动重述（`run:thinking-lang`）
- **Token 节省**：历史消息上限、滚动摘要压缩、工具输出截断、思考内容不回传、单次输出上限、前缀缓存友好六项机制，含预算告警 `budgetAlertCny`
- **直给模式**：`persona.preset = 'direct'` 为默认人格，禁止寒暄与复述，优先给可执行结论
- **MCP 连接器**：支持 `stdio` 与 `http` 两种传输，工具自动并入工具池
- **定时任务**：支持 5 段 cron、固定间隔、单次定时，结果可选择写入知识库
- **本地知识库**：索引本地目录与文件，检索结果带引用（`Citation`）；向量能力不可用时退回词法检索
- **长期记忆**：`preference` / `fact` / `project` / `instruction` 四类，支持召回与清空
- **会话管理**：置顶、重命名、删除、清空、导出 Markdown（思考过程折叠）
- **主题与个性化**：深色 / 浅色 / 跟随系统，主题色、界面缩放（0.85~1.2）、等宽字体、背景装饰
- **更新检测**：比对 GitHub Release 版本，支持 `stable` / `beta` 通道与自定义 `feed`
- **Windows 安装器**：NSIS 非一键式，可选安装目录、桌面与开始菜单快捷方式，写入 `RUN_WORKER_HOME` 与用户 `PATH`
- **CI**：GitHub Actions 构建 Windows 安装包并上传产物；打 `v*` tag 自动创建 Release

### Security

- 渲染进程启用 `contextIsolation`，仅通过 `window.runworker` 白名单访问主进程能力
- 命令执行双层校验：`agent.denyPatterns` 黑名单 + 风险正则，默认 `approvalMode: 'safe-only'` 对高风险命令强制审批
- 外部链接白名单：`app:open-external` 与窗口内 `window.open` 均只放行 `http(s)://`，其余协议直接拒绝
- API Key 仅存于本地 `settings.json`，不随包分发
- 日志统一脱敏：主进程 `createLogger` 在落盘与 console 输出前，把 `apiKey`/`token`/`authorization` 键值、裸 `Bearer xxx`、`sk-` 前缀三类替换为 `***` / `sk-***`
- 匿名统计 `telemetry` 默认关闭
- 安装器 `requestedExecutionLevel: asInvoker`，仅写 `HKCU`

### Known Issues

- 切换会话时若上一轮仍在流式输出，可能出现思考内容串台（0.0.2 修复）
- 中文或含空格路径下 Python 脚本可能执行失败（0.0.2 修复）
- 浅色主题下工具调用卡片对比度偏低（0.0.2 修复）
- `0 9 31 * *` 这类表达式在无该日期的月份静默顺延到下一个有该日期的月份，界面无提示（0.0.3 补充提示文案）
- 部分非标准 OpenAI 兼容服务的 `/v1/models` 结构差异会导致渠道测试误报（0.0.3 修复）
- `denyPatterns` 对大小写与多空格变体的匹配不完整（0.0.4 修复）
- Electron 33.4.11 在特定多屏缩放组合下可能出现白屏（0.0.5 修复）
- 重复安装后 `PATH` 可能出现重复条目（0.0.5 修复）

[Unreleased]: https://github.com/LHRonline/run-worker/compare/v0.0.1...HEAD
[0.0.2]: https://github.com/LHRonline/run-worker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/LHRonline/run-worker/releases/tag/v0.0.1

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

## [0.0.2] - 2026-10-23

> 安全与测试补丁：修复 0.0.1 已知限制中的安全项与测试空白。无破坏性变更，`settings.json` 结构不变（version 仍为 1），老数据升级后自动加密。

### Security

- **API Key 加密存储**：通过 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密后落盘，`settings.json` 中的 Key 为 `enc:v1:` 密文；存量明文在启动时自动迁移，内存态保持明文（LLM 调用方与界面无感知）；系统不支持凭据加密时回退明文并记录日志，损坏密文解密失败回落为空 Key 而非把密文发出去
- **命令判定补内置变体模式**：`rimraf`、PowerShell 别名 `ri` 递归删除、`find -delete`、`shred`、`wmic ... delete`、.NET `[System.IO.File/Directory]::Delete`、`\\.\PhysicalDrive` 物理设备写入、`git clean -fdx`、`erase /s`、`truncate -s 0` 等绕过写法全部纳入高危/中危拦截（大小写与多空格归一化在 0.0.1 已具备，本版补齐规则覆盖面并加防误伤用例）
- **更新包完整性**：更新信息透出安装包 SHA-256（GitHub Release 资产 `digest` 字段，兼容自定义源 `sha256` 字段），设置 → 关于 → 检查更新可直接查看，便于下载后人工校验

### Tests

- 平台集成用例 10 → 14：新增命令变体拦截、Key 加密迁移与损坏密文回落、调度器 ticker 补跑（once 到期任务）、资产 digest 透出
- E2E 断言 22 → 26（`ALL PASS (26/26)`）：B3 Key 落盘密文/内存明文、C6/C7 演示模式 trace 三态（自动路由 / 路由判定 / 手动指定，与真实路径同构）、F4 调度器 ticker 补跑预置到期任务；G1 兼容「更新源可达且已是最新」的合法状态

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
- `0 9 31 * *` 这类表达式在无该日期的月份静默顺延到下一个有该日期的月份，界面无提示（后续版本补充提示文案）
- 部分非标准 OpenAI 兼容服务的 `/v1/models` 结构差异会导致渠道测试误报（后续版本修复）
- `denyPatterns` 对大小写与多空格变体的匹配不完整（0.0.2 已修复）
- Electron 33.4.11 在特定多屏缩放组合下可能出现白屏（后续版本修复）
- 重复安装后 `PATH` 可能出现重复条目（后续版本修复）

[Unreleased]: https://github.com/LHRonline/run-worker/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/LHRonline/run-worker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/LHRonline/run-worker/releases/tag/v0.0.1

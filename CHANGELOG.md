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

## [0.0.3a] - 2026-11-12

> 补丁版：修复「工具名不符合服务端规范导致整轮请求被拒」的问题，并把界面版本号改为跟随实际构建版本。无破坏性变更，`settings.json` 结构不变（version 仍为 1），老数据无需迁移，可直接覆盖安装 0.0.3。

### Fixed

- **工具名不再被服务端拒绝（本次核心修复）**：本应用的工具名带点号（`python.exec` / `fs.list` / `net.fetch` / `mcp.call` 等），而 OpenAI 兼容网关要求 function 名必须匹配 `^[a-zA-Z0-9_-]+$`，导致整轮请求被拒：
  `Invalid tools[0].function.name: string does not match pattern`。
  现在发送前把工具名规整为合法字符（如 `python.exec` → `python_exec`），模型回传后再映射回真实工具名执行；界面与日志中展示的仍是真实工具名（如 `python.exec`），工具上下文与去重逻辑不受影响

### Changed

- **界面版本号跟随实际构建版本**：标题栏版本标识、设置 → 更新 → 当前版本、设置 → 关于、首次引导页不再硬编码版本号，统一取自主进程 `app.getVersion()`（渲染进程另有构建期注入的 `__APP_VERSION__` 兜底），彻底消除「界面显示 0.0.1、实际却是 0.0.3」这类脱节
- **MCP 客户端版本号同步**：握手时上报的 clientInfo 版本改为取自 `package.json`，与界面显示一致
- **补丁版本号可被正确识别为更新**：版本比较此前把 `0.0.3a` 与 `0.0.3` 视为相同，导致停留在 0.0.3 的用户收不到补丁更新提示；现在字母后缀按「热修复级别」排序（`0.0.3a` > `0.0.3` > `0.0.2`），预发布版本仍小于正式版

### Tests

- 平台集成用例 22 → 27：新增工具名规整函数、全部工具规整后合法且不重名、mock 网关按真实规则强校验的端到端工具循环（确认不再 400 且能执行真实工具）、补丁版本号比较（`0.0.3a` > `0.0.3`）、界面版本号不再硬编码
- E2E 全链路回归 27 → 28（`ALL PASS (28/28)`）：新增 A7 标题栏版本号与 `package.json` 一致

## [0.0.3] - 2026-11-12

> 稳定性修复：修复 0.0.1/0.0.2 中一批影响日常使用的已知问题。无破坏性变更，`settings.json` 结构不变（version 仍为 1），老数据无需迁移。

### Fixed

- **切换会话不再串台**：选中新会话时若上一轮仍在流式输出，主进程先自动中断（abort）旧 run，再切换活动会话，避免思考/回答内容混入新会话
- **运行期异常不再卡在「运行中」**：一次 `run` 的外层增加 `try/finally` 守卫，任何未预期的异常都会补发 `run:end`（status: error），界面不会永久停留在生成中
- **定时任务跨月顺延有提示**：`0 9 31 * *` 这类在当月无该日期的表达式原本静默顺延且界面无提示，现在会在任务卡片展示「设定的每月 X 号在本月没有符合条件的日期，已顺延到 X 月 X 日」的说明
- **Python 中文/含空格路径可正常执行**：Windows 下解释器路径含空格时自动加引号（spawn 的 file 参数），避免 `C:\Program Files\...` 这类路径启动失败
- **浅色主题对比度提升**：工具调用卡片与错误文本改用更高对比度的变量，满足 WCAG AA，浅色模式下更易读
- **错误提示标注渠道**：频率限制（429）等错误现在带上服务商展示名（如「渠道：DeepSeek」），便于定位是哪个 Key/渠道触发
- **模型列表兼容更多接口**：拉取模型列表时兼容只返回 `name` 不返回 `id` 的非标准 OpenAI 兼容服务，避免渠道测试误报；服务端异常时回退内置预设列表
- **本地模型连接更稳**：对 ollama 等本地地址追加 `NO_PROXY`，避免被系统代理拦截；本地连接失败提示「请先运行 `ollama serve`」
- **会话索引自愈**：启动时剔除指向已丢失会话文件的孤儿索引条目并写回干净索引，异常退出后偶发的「幽灵会话」不再出现
- **渠道透传更完整**：主进程向 LLM 客户端透传服务商展示名，错误与重试上下文包含渠道信息

### Tests

- 平台集成用例 14 → 22：新增 cron 跨月顺延 `nextNote`、会话索引孤儿清理、429 渠道标注、ollama 网络提示、模型列表 `name/id` 兼容与回退、python 路径引号、对话异常必补 `run:end`
- E2E 全链路回归 26 → 27（`ALL PASS (27/27)`）：新增 F5 cron 跨月顺延 `nextNote` 提示

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

- 切换会话时若上一轮仍在流式输出，可能出现思考内容串台（0.0.3 修复）
- 中文或含空格路径下 Python 脚本可能执行失败（0.0.3 修复）
- 浅色主题下工具调用卡片对比度偏低（0.0.3 修复）
- `0 9 31 * *` 这类表达式在无该日期的月份静默顺延到下一个有该日期的月份，界面无提示（0.0.3 修复）
- 部分非标准 OpenAI 兼容服务的 `/v1/models` 结构差异会导致渠道测试误报（0.0.3 修复）
- `denyPatterns` 对大小写与多空格变体的匹配不完整（0.0.2 已修复）
- 工具名带点号不符合部分网关的 `^[a-zA-Z0-9_-]+$` 约束，导致请求被拒（0.0.3a 修复）
- 界面版本号硬编码，与实际构建版本脱节（0.0.3a 修复）
- Electron 33.4.11 在特定多屏缩放组合下可能出现白屏（后续版本修复）
- 重复安装后 `PATH` 可能出现重复条目（后续版本修复）

[Unreleased]: https://github.com/LHRonline/run-worker/compare/v0.0.3a...HEAD
[0.0.3a]: https://github.com/LHRonline/run-worker/compare/v0.0.3...v0.0.3a
[0.0.3]: https://github.com/LHRonline/run-worker/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/LHRonline/run-worker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/LHRonline/run-worker/releases/tag/v0.0.1

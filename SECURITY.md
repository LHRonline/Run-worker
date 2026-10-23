# 安全策略

## 支持范围

| 版本 | 安全更新 |
| --- | --- |
| 最新发布版本（当前 `0.0.1`） | ✅ |
| 更早版本 | ❌ 建议先升级到最新补丁版本 |

## 报告漏洞

**请不要公开提交 Issue。**

- 首选：GitHub 私密漏洞报告 —— https://github.com/LHRonline/run-worker/security/advisories/new
- 备用：发送到仓库 Issues 并标注 `security` 标签，仅描述大致影响，不要附利用细节
- 内容请包含：受影响版本、复现步骤、影响评估、可选的修复建议
- 我们会在 **3 个工作日内**确认收到，并在评估后同步处理进度与修复版本
- 修复发布后，如你愿意，会在 Release notes 中致谢

请勿在报告中附带你自己的真实 API Key。

---

## 命令执行风险模型

Run worker 的核心能力是“真的能动手”，因此需要明确风险边界。一次工具调用的判定顺序：

1. **黑名单**（`agent.denyPatterns`，默认包含 `rm -rf /`、`format `、`del /f /s /q c:\`、`shutdown /s`、`diskpart`）：命中即**拒绝**，无法通过审批放行。
2. **风险模式匹配**：`rm -rf`、`format`、`del /f`、`shutdown`、`diskpart`、`reg delete`、`Remove-Item -Recurse` 等被判为 `risk: 'high'`。
3. **审批模式**（`agent.approvalMode`）：

| 模式 | 行为 | 建议 |
| --- | --- | --- |
| `safe-only`（默认） | 高风险命令必须你确认 | 日常使用 |
| `always` | 每条命令都确认 | 首次试用、陌生项目、生产机器 |
| `never` | 全部直接执行 | **仅隔离环境**，等同把机器交给模型 |

4. **执行约束**：命令在 `agent.workspaceDir` 下执行，受 `agent.commandTimeout`（默认 120000 ms）限制；一轮运行最多 `agent.maxSteps`（默认 12）步。

### 你必须知道的风险

- 模型可能生成**看似合理但有害**的命令（误删、覆盖、改系统设置），审批弹窗请逐字看清路径与参数，不要习惯性点“允许”。
- `computer` Agent 是唯一拥有文件删除能力（`fs.delete`）的 Agent，涉及删除时务必核对路径。
- `net.fetch` 会把目标 URL 与可能的上下文提交到远端；内网地址、带 token 的 URL 不建议交给 Agent。
- 把 `approvalMode` 设为 `never`、或清空 `denyPatterns`、或把 `workspaceDir` 指向系统目录，都会显著扩大攻击面。

---

## 密钥与隐私

### API Key 存放位置

| 项目 | 现状 |
| --- | --- |
| 位置 | `%APPDATA%\Run worker\settings.json` 的 `providers[].apiKey` |
| 形式 | **明文 JSON**，依赖操作系统用户目录的访问控制保护 |
| 是否加密 | 否（0.0.x 未接入 DPAPI / 凭据管理器，这是已记录的取舍） |
| 是否上传 | 否。仅作为 `Authorization: Bearer` 头发送给你自己配置的模型接口 |
| 是否进日志 | 否。主进程 `createLogger`（`src/main/store.ts`）统一脱敏后落盘，见下节 |

因为 key 是明文，请注意：

- 不要把整个 `%APPDATA%\Run worker\` 目录提交到 Git 或上传网盘。
- 导出/分享会话前检查内容（导出 Markdown **不含** Key，但可能含业务数据）。
- 多人共用一台机器时，为 Run worker 使用独立 Windows 账户。

### 日志脱敏

所有模块共用 `src/main/store.ts` 的 `createLogger`，写入磁盘与输出到 console 前都过一遍 `redactSecrets`，覆盖三类：

| 目标 | 规则 | 结果 |
| --- | --- | --- |
| 键值对 | `apiKey` / `apikey` / `token` / `authorization` / `secret` 的值 | 值替换为 `***` |
| Bearer 令牌 | 裸 `Bearer xxx` | `Bearer sk-***` |
| 厂商 Key | `sk-` 前缀的字符串 | `sk-***` |

因此 `logs/main-YYYY-MM-DD.log` 中不会出现明文 Key（已实测落盘日志）。若你在别处发现明文，请按本文开头的渠道报告。

### 数据外发清单

仅三类数据会离开本机：

1. 发给**你自己配置的**模型接口（对话内容、必要的工具结果、知识库命中片段）。
2. Agent 显式调用 `net.fetch` 时的目标请求。
3. 更新检测：向 `update.feed`（默认 `LHRonline/run-worker` 的 GitHub Release）发起只读请求，携带版本号。

其余数据（对话、记忆、知识库索引、日志、生成物）全部留在本地。匿名统计 `telemetry` 默认关闭，开启后也不包含对话内容。

---

## 建议的最小权限运行方式

1. **用普通用户账户运行**，不要用管理员身份启动。安装器本身就是 `asInvoker`，只写 `HKCU`。
2. **保持 `approvalMode: 'safe-only'`**，不要为了省事改 `never`。
3. **把 `agent.workspaceDir` 指向专用目录**（例如 `D:\AgentWorkspace`），不要指向磁盘根目录、`C:\Windows`、用户资料目录。
4. **保留默认 `denyPatterns`**，可增不可减。
5. **只添加信任的 MCP Server**。`stdio` 传输会以当前用户权限执行你填写的 `command`，`env` 里的值会传给子进程。
6. **只添加需要的知识库目录**，不要整盘索引。
7. **不用时退出程序**，避免定时任务在你不知情时执行。
8. 在企业/生产机器上，先在与生产隔离的环境验证 Agent 行为。

---

## 安全相关的实现约定

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`，只能通过 `window.runworker` 白名单调用主进程。
- 外部链接：已实现白名单，`app:open-external` 只放行 `^https?://`，否则抛「只允许打开 http/https 链接。」；`window.open` 与新窗口请求同样只放行 http(s)。
- 工具输出在界面按纯文本渲染，不解析 HTML（防 XSS）。
- 安装/卸载只操作 `HKCU`（`RUN_WORKER_HOME`、`Path`、`Software\RunWorker`），不写系统级注册表。
- 卸载默认保留用户数据目录；如设备要转手，请手动删除 `%APPDATA%\Run worker\`。

---

## 已知限制

| 限制 | 说明 | 计划 |
| --- | --- | --- |
| ~~Key 明文存储~~ ✅ 已解决（0.0.2） | Key 经 Electron `safeStorage`（Windows DPAPI）加密后落盘为 `enc:v1:` 密文，存量明文自动迁移；系统不支持加密时回退明文并记日志 | 已完成 |
| ~~命令判定为启发式~~ ✅ 已解决（0.0.2） | 归一化（大小写 / 多空格 / 去引号）+ 内置变体模式覆盖 `rimraf`、`ri -r`、`find -delete`、`shred`、`wmic delete`、.NET Delete、`git clean -fdx` 等；黑名单 `denyPatterns` 仍可自定义兜底 | 已完成 |
| 无沙箱 | 命令以当前用户权限真实执行，不是容器隔离 | 不在 0.0.x 范围 |
| ~~更新包未强校验签名~~ 🟡 部分解决（0.0.2） | 更新信息已透出安装包 SHA-256（设置 → 关于可见），可下载后人工校验；自动签名校验依赖代码签名证书 | 0.0.5 补齐签名 |

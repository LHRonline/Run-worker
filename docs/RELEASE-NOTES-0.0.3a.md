# Run worker 0.0.3a 发布说明

> 补丁版发布日期：2026-11-12
> 本版针对 0.0.3 使用中暴露的一个阻塞性缺陷，以及界面版本号与实际构建版本脱节的问题。
> 无破坏性变更，`settings.json` 结构不变（version 仍为 1），老数据无需迁移，**可直接覆盖安装 0.0.3**。

## 本版修复的问题

### 补丁版本号无法被识别为「有更新」

版本比较此前把 `0.0.3a` 与 `0.0.3` 视为**相同版本**，停留在 0.0.3 的用户即使检查更新也不会收到
0.0.3a 的提示。现在字母后缀按「热修复级别」排序：`0.0.3a` > `0.0.3` > `0.0.2`，
而 `-alpha` / `-rc` 这类预发布版本仍然小于对应的正式版。

### 工具名不符合服务端规范，导致整轮请求被拒

**现象**

在开启工具调用（Agent 模式）时，请求被网关拒绝，界面提示：

```
本轮执行失败
请求被拒绝，可能是模型名或参数不被支持（服务端信息：
{"error":{"message":"Invalid `tools[0].function.name`: string does not match pattern.
Expected a string that matches the pattern `^[a-zA-Z0-9_-]+$`."}})
```

**原因**

Run worker 的工具名采用「模块.动作」形式：`fs.list`、`fs.read`、`fs.write`、`shell.exec`、
`python.exec`、`net.fetch`、`kb.search`、`memory.save`、`task.schedule`、`mcp.call`、
`image.generate`、`video.generate`、`model.generate`。

而 OpenAI 兼容网关（DeepSeek、OpenRouter、硅基流动、Groq、vLLM 等）对 function 名的约束是
`^[a-zA-Z0-9_-]+$` —— **点号不在允许字符集内**。因此只要请求里带了工具定义，就一定被拒，
表现为「模型一动就失败」。

**修复**

- 发送给网关前，把工具名规整为合法字符：`fs.list` → `fs_list`、`python.exec` → `python_exec`。
- 模型回传工具名时再映射回真实工具名后执行，因此工具能力、参数、返回结果**完全不变**。
- 界面里的工具调用卡片与日志展示的仍是真实工具名（如 `python.exec`），便于阅读。
- 工具上下文（assistant 的 tool_calls）与重复调用去重逻辑同步保持规整名，与声明的工具一致。

### 界面版本号与实际构建版本脱节

标题栏版本标识、设置 → 更新 → 当前版本、设置 → 关于、首次引导页此前都把版本号写死为 `0.0.1`，
无论实际安装的是哪个版本。现在统一改为：

- 标题栏与设置面板取自主进程 `app.getVersion()`；
- 渲染进程由 Vite 在构建期注入 `__APP_VERSION__`（来源 `package.json`）作为兜底；
- MCP 握手上报的 clientInfo 版本同样取自 `package.json`。

以后升级只需改 `package.json` 一处，界面自动跟随。

## 安装

- [Releases](https://github.com/LHRonline/run-worker/releases) 下载 `Run-worker-0.0.3a-setup.exe`。
- 安装器为 NSIS 非一键式：可自选安装目录，会写入用户级 `RUN_WORKER_HOME`、把安装目录追加到
  用户 `PATH`、创建桌面与开始菜单快捷方式，卸载时自动清理上述环境变量。
- 升级前建议先退出正在运行的 Run worker（托盘/窗口）。

## 测试

- 平台集成用例 22 → 27：新增工具名规整函数、全部工具规整后合法且不重名、
  mock 网关按真实规则强校验的端到端工具循环、补丁版本号比较、界面版本号不再硬编码。
- E2E 全链路回归 27 → 28（`ALL PASS (28/28)`）：新增 A7 标题栏版本号与 `package.json` 一致。
- 打包产物验证：真实 `win-unpacked` 产物通过全部断言。

## 已知问题

见仓库 [CHANGELOG.md](../CHANGELOG.md) 的 `Known Issues` 小节。

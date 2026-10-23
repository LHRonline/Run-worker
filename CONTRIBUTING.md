# 贡献指南

感谢你愿意参与 Run worker。请先读 [README.md](README.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，了解模块分工后再动手。

---

## 1. 环境准备

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20 及以上 |
| npm | 随 Node 附带即可 |
| 操作系统 | 开发主体在 Windows 上进行（主进程含平台相关逻辑） |

```bash
git clone https://github.com/LHRonline/run-worker.git
cd run-worker
npm install
npm run dev
```

`npm run dev` 会构建主进程、启动 Vite（端口 5173，`strictPort`），并拉起 Electron。

---

## 2. 分支模型

| 分支 | 用途 | 说明 |
| --- | --- | --- |
| `main` | 稳定分支 | 只接受经过 PR 审查的合并；与 Release tag 对应 |
| `feat/<简短描述>` | 新功能 | 从 `main` 切出，例如 `feat/mcp-http-headers` |
| `fix/<简短描述>` | Bug 修复 | 例如 `fix/thinking-stream-cross-talk` |
| `docs/<简短描述>` | 纯文档 | 例如 `docs/patch-roadmap` |
| `chore/<简短描述>` | 构建、CI、依赖 | 例如 `chore/electron-33-patch` |

规则：

- 一个 PR 只做一件事，避免“顺手重构”。
- 面向 0.0.x 的修复请**只修不增**：不改 `Settings` 结构、不新增 Agent（参见 [docs/PATCH-ROADMAP.md](docs/PATCH-ROADMAP.md)）。
- 合并前先 rebase 到最新 `main`，保持线性历史。

---

## 3. 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，**描述用中文**，类型与范围用英文。

格式：

```
<type>(<scope>): <简短描述>

<可选正文：为什么这么改，而不是改了什么>

<可选 Footer：Refs #123 / BREAKING CHANGE: ...>
```

`type` 取值：

| type | 含义 |
| --- | --- |
| `feat` | 新功能（合入 0.1.0+；0.0.x 分支不接受） |
| `fix` | 缺陷修复 |
| `docs` | 仅文档 |
| `refactor` | 重构，不改变外部行为 |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `build` | 构建脚本、依赖、打包配置 |
| `ci` | GitHub Actions 等 CI 配置 |
| `chore` | 杂项 |

`scope` 建议使用模块名：`main`、`preload`、`renderer`、`shared`、`llm`、`tools`、`agents`、`platform`、`store`、`installer`、`ci`。

示例：

```
fix(chat): 切换会话时中止上一轮流式输出

原实现只在组件卸载时 abort，切换会话时旧 run 仍在推送事件，
导致增量内容按 runId 找不到归属后被写入当前会话。
现在 conv 切换处显式调用 chat.abort，并在主进程按 runId 过滤。

Refs #42
```

```
docs(patch-roadmap): 补充 0.0.4 权限判定修复清单
```

```
ci(build): 无 lock 文件时回退到 npm install
```

---

## 4. 代码约定

- TypeScript `strict` 必须通过，不使用 `any` 逃逸（确需时加注释说明）。
- 共享类型只写在 `src/shared/`，`main` / `preload` / `renderer` 三方不得各自定义同名结构。
- 新增 IPC 通道必须**同时**修改 `src/shared/ipc.ts`（常量 + `RunWorkerApi`）与 `src/preload/index.ts`（桥接），缺一不可。
- 主进程持久化统一走 `src/main/store.ts` 的原子写，不要直接 `fs.writeFileSync` 写用户数据。
- 时间戳统一用 `Date.now()`（毫秒）；展示层负责格式化。
- 注释只写“为什么”，不复述代码。
- 提交前删掉调试用的 `console.log`（日志请走 `PlatformDeps.log`）。

---

## 5. PR 检查清单

在提交 PR 前逐项确认：

- [ ] 已在本机跑过 `npm run typecheck`，无错误
- [ ] 已跑过 `npm run build`，主进程与渲染进程均构建成功
- [ ] 涉及主进程 / IPC / 存储的改动，已跑过 `npm run test:e2e` 并输出 `ALL PASS (26/26)`
- [ ] 涉及界面的改动，附截图或录屏（深浅两套主题各一张更佳）
- [ ] 涉及主进程逻辑的改动，说明是否影响已有 `settings.json`（默认：不允许）
- [ ] 涉及工具/命令执行的改动，说明风险判定是否更新（`platform/permissions.ts`）
- [ ] 新增文件已加入 `electron-builder.yml` 的 `files` 白名单（若需随包分发）
- [ ] 文档同步：改了 Agent / 设置项 / 命令，更新 `README.md`、`docs/AGENTS.md` 或 `docs/API.md`
- [ ] 涉及用户可见变更，在 `CHANGELOG.md` 的 `[Unreleased]` 下补一条
- [ ] 没有提交 `node_modules/`、`release/`、`dist/`、`dist-electron/`、个人 `settings.json`
- [ ] 提交信息符合第 3 节格式

PR 描述模板：

```markdown
## 改了什么
（一两句）

## 为什么
（关联 Issue / 复现场景）

## 怎么验证
（命令、步骤、截图）

## 影响面
（是否影响配置兼容、是否需要用户手动操作）
```

---

## 6. 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 开发调试 |
| `npm run typecheck` | 渲染 + 主进程双份类型检查（提交前必跑） |
| `npm run build` | 构建产物到 `dist-electron/` 与 `dist/renderer/` |
| `npm run pack` | 打免安装目录，验证打包结果 |
| `npm run dist` | 生成 `release/Run-worker-<version>-setup.exe` |
| `npm test` | 运行 `node --test tests/*.test.mjs`（`node:test`），当前 14 项平台集成用例（`tests/platform.test.mjs`） |
| `npm run test:e2e` | 真实 Electron 端到端：`tsc` + `vite build` 后跑 26 项断言，全绿输出 `ALL PASS (26/26)`、退出码 0；失败会打印实际值与「疑似根因：文件:行号」，并把临时 `userData` 留在 `%TEMP%\runworker-e2e-<时间戳>`。无需任何 API Key。设 `RUNWORKER_E2E_FAIL_PROBE=1` 可自检失败路径：会额外出现 1 条故意失败的断言（`FAILED 1/27`，退出码 1） |
| `npm run test:e2e:only` | 跳过构建，直接重跑断言（改了主进程逻辑后快速回归） |
| `npm run test:packaged` | 打包产物验证：**按 `app.asar` 的修改时间自动选最新**的一份 win-unpacked（候选 `release-<版本>/`、`release/`、`dist/`，可用 `RUNWORKER_E2E_EXE` 显式覆盖；运行时会打印每个候选及其时间，缺少 `app.asar` 的目录标记 ✗ 并跳过），真实启动后用 CDP 断言 11 项（exe / asar 大小、调试端口、`window.runworker`、`bootstrap()` 的 agents=8、首屏正文、启动日志三行、8s 后非白屏），全绿输出 `PACKAGED PASS (11/11)`。需先 `npm run pack` 或 `npm run dist`；与 electron-builder 同时跑时它会提示「产物被改动，请等打包结束后重跑」 |
| `npm run icon` | 由 `assets/icon.png` 生成各尺寸图标 |

E2E 两个可选开关：`RUNWORKER_E2E_ONLINE=1` 只放宽 G 组（更新检测）判定——离线时要求返回中文 `error`，在线时只要求检测链路通、`error` 为空或为「暂无发布版本 / 暂无正式版本可用」，仓库公开后可用它复核更新链路（未发版也视为通过）；`RUNWORKER_E2E_FAIL_PROBE=1` 用于自检失败报告格式与退出码。

E2E 断言分组（26 项，均为演示模式，无需 API Key）：

| 组 | 覆盖内容 | 项数 |
| --- | --- | --- |
| A | bootstrap：首屏数据、`AppInfo`、agents=8 等 | 6 |
| B | 设置持久化：B1 深合并保留未传字段、B2 重载后仍生效、B3 Key 落盘密文/内存明文 | 3 |
| C | 会话与路由：C0 事件订阅、C1 演示流式、C2 落库、C3 首轮路由（`orchestrator → image`）、C4 基线不被写回、C5 同会话再分派（`to=code`）、C6 trace 自动路由/路由判定、C7 trace 手动指定并写基线 | 8 |
| D | 中断：`chat.abort` 与 `run:end` 状态 | 1 |
| E | 知识库：添加源、检索 | 2 |
| F | 定时任务：F1 保存计算 nextRunAt、F2 删除后消失、F3 立即执行成功并落历史、F4 ticker 补跑已到期预置任务 | 4 |
| G | 更新检测：离线返回中文 `error`（在线模式放宽） | 1 |
| H | 渲染健康：无崩溃 / 加载失败 / 非 CSP 控制台错误 | 1 |

**覆盖说明（0.0.2 起）**：trace 三态（`自动路由` / `路由判定` / `手动指定`）与调度器 ticker 补跑路径均已覆盖——演示模式与真实路径同构落 `conv.trace`（C6/C7），F4 通过预置到期任务验证 ticker 补跑。真实模型路径的 trace 行为（模型自由文案 reason）仍建议在接入真实 Key 时手动回归一次；B3 验证了 Key 落盘为 `enc:v1:` 密文、内存态保持明文。

本地打包遇到 `release/` 里的旧文件占用，先关闭正在运行的 Run worker 再重试。

---

## 7. Issue 指引

请按模板提交：

- **Bug 报告**（`.github/ISSUE_TEMPLATE/bug_report.yml`）：版本号、系统版本、复现步骤、期望与实际、日志片段。
- **功能建议**（`.github/ISSUE_TEMPLATE/feature_request.yml`）：要解决的问题、期望行为、替代方案。

提交 Bug 前请：

1. 搜索是否已有相同 Issue。
2. 附上 `设置 → 关于` 里的版本与环境信息（不要贴 API Key）。
3. 需要日志时，从 `%APPDATA%\Run worker\logs\main-YYYY-MM-DD.log` 取相关片段，**先自行检查是否含敏感路径**。

安全问题**不要**开公开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

---

## 8. 许可证

提交即表示你同意以 [MIT](LICENSE) 协议授权你的贡献。

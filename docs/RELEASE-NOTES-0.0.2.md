# Run worker 0.0.2

安全与测试补丁：把 0.0.1 已知限制里的安全项和测试空白一次清掉。配置格式不变，老 `settings.json` 升级后自动加密，历史对话与设置完整保留。

## 本版包含

- **API Key 加密存储**：Key 不再明文写进 `settings.json`——改用操作系统凭据机制（Windows DPAPI / macOS Keychain / Linux libsecret）加密后落盘（`enc:v1:` 密文）。存量明文在启动时自动迁移，界面与模型调用完全无感知；系统不支持加密时回退明文并在日志里说明。
- **命令判定补变体模式**：`rimraf`、PowerShell 别名 `ri -r`、`find -delete`、`shred`、`wmic ... delete`、.NET `Delete`、`\\.\PhysicalDrive`、`git clean -fdx`、`erase /s`、`truncate -s 0` 这些绕过写法全部纳入拦截；大小写与多空格归一化继续兜底（`RM  -RF` 依旧逃不掉）。
- **更新包 SHA-256 透出**：检查更新时直接显示安装包 SHA-256（来自 GitHub Release 资产 digest），下载后可自行 `certutil -hashfile` 比对完整性。
- **测试空白清零**：trace 三态（自动路由 / 路由判定 / 手动指定）在演示模式与真实路径同构落库，E2E 直接覆盖；调度器 ticker 补跑路径补上断言。平台用例 10 → 14，E2E 22 → 26，全部全绿。

## 安装

1. 下载 `Run-worker-0.0.2-setup.exe`（[Releases](https://github.com/LHRonline/run-worker/releases)）并双击运行。
2. 覆盖安装到原目录即可，设置与历史对话保留；首次启动会把明文 Key 自动加密。

完整说明见 [docs/INSTALL.md](INSTALL.md)，静默安装用 `/S /D=<目录>`。

## 校验

发布前跑过 `npm test`（14 项平台集成用例）与 `npm run test:e2e`（26 项真实 Electron 端到端断言），均全绿：`ALL PASS (26/26)`。

## 已知限制（余项）

- **无沙箱**：命令以当前用户权限真实执行，不是容器隔离（不在 0.0.x 范围）。
- **安装包未签名**：Windows SmartScreen 会提示「未知发布者」，可点「更多信息 → 仍要运行」；代码签名在后续版本补齐（本版已支持人工比对 SHA-256）。
- **MCP 需自备服务器**：`stdio` 传输会以当前用户权限执行你填写的 `command`，请只添加信任的服务器。
- **图像 / 视频 / 3D 需外部能力**：内置不含生成模型，需配置对应接口或 3D 生成类 MCP。

---

完整变更见 [CHANGELOG.md](../CHANGELOG.md)；安装与使用教程见 [INSTALL.md](INSTALL.md) 与 [API.md](API.md)。

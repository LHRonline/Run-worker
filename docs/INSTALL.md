# 安装指南（Windows）

适用版本：0.0.1 及后续 0.0.x 补丁版本。
下载地址：<https://github.com/LHRonline/run-worker/releases>
安装包文件名：`Run-worker-<version>-setup.exe`（由 `electron-builder.yml` 的 `artifactName` 决定）。

---

## 1. 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 1809 及以上 / Windows 11，64 位（`x64`） |
| 磁盘 | 安装目录约 300 MB 起，`%APPDATA%` 另计（对话、知识库、生成物） |
| 权限 | 普通用户即可完成安装（安装器为 `asInvoker`，只写 `HKCU`） |
| 网络 | 安装不需要；使用云端模型时需要能访问对应 API |
| 可选依赖 | 需要本地 Python 时自备（`agent.pythonPath`，默认 `python`）；视频功能需 ffmpeg 可执行 |

---

## 2. 安装器逐屏说明

安装器基于 NSIS（非一键式 `oneClick: false`），共 5 屏。

### 屏 1 — 欢迎页

显示 `Run worker` 与版本号（`uninstallDisplayName` = `Run worker <version>`）。点“下一步”。

### 屏 2 — 许可协议

展示 MIT 协议全文。选“我接受”继续。

### 屏 3 — 安装位置

- 默认目录在用户目录下，**不强制** `Program Files`，因此不触发 UAC。
- 可点“浏览”改路径（`allowToChangeInstallationDirectory: true`）。
- 若选了需要管理员权限的目录（如 `C:\Program Files\Run worker`），安装器会请求提权（`allowElevation: true`）；取消提权则回到用户目录安装。
- 建议路径：`D:\Apps\Run worker` 或 `%LOCALAPPDATA%\Programs\Run worker`。

### 屏 4 — 安装进度

依次完成：解包 `app.asar`（`asar: true`）→ 写入主程序 → 创建快捷方式 → **配置环境变量**。进度区会打印：

```
正在配置 Run worker 系统环境变量...
已将 <安装目录> 追加到用户 PATH
```

若该目录已在 `PATH` 中，则显示“PATH 中已包含 <安装目录>，跳过”，不会重复写入。

### 屏 5 — 完成

- `runAfterFinish: true`：默认勾选“立即运行 Run worker”。
- 快捷方式：桌面 + 开始菜单，名称均为 `Run worker`（`shortcutName`）；`menuCategory: false`，所以开始菜单里是顶层条目，不建文件夹。
- 首次启动进入引导页，需要配置至少一个模型渠道（可先用 Ollama 本地，无需 Key）。

---

## 3. 环境变量

安装器在 `customInstall`（`build/installer.nsh`）中写入以下**用户级**（`HKCU`）项：

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `RUN_WORKER_HOME` | 安装目录 | 供应用与外部脚本定位安装位置；应用启动时若存在会加入 `PATH` |
| `Path` | 原值 + `;<安装目录>` | 让终端里能直接找到安装目录下的可执行文件 |

同时写入 `HKCU\Software\RunWorker` 的 `InstallDir` 与 `Version`，写完后通过 `WM_SETTINGCHANGE`（`0x001A`）广播刷新，资源管理器与新建终端可立即识别。

应用运行时还会额外把 `<安装目录>\tools` 与 `<安装目录>\bin`（存在时）注入进程 `PATH`，用于自带 ffmpeg / python 包装脚本；这不写入注册表，只在进程内生效。

### 验证方法

**新开一个** PowerShell 或 CMD 窗口（已开的窗口读不到新变量）：

```powershell
echo %RUN_WORKER_HOME%
# 期望输出安装目录，例如 D:\Apps\Run worker

echo %PATH%
# 期望在末尾附近看到同一目录
```

或用 `where` 检查目录内可执行文件是否可见：

```cmd
where runworker
```

应用内也可以自查：设置 → 关于 → 环境信息，对应 `AppInfo.env.RUN_WORKER_HOME` 与 `AppInfo.env.pathHasInstall`（`true` 表示 `PATH` 已包含安装目录）。

---

## 4. 静默安装

```cmd
Run-worker-0.0.1-setup.exe /S
```

指定目录（`/D=` 必须是**最后一个参数**，路径**不要加引号**，即使含空格）：

```cmd
Run-worker-0.0.1-setup.exe /S /D=D:\Apps\Run worker
```

| 参数 | 说明 |
| --- | --- |
| `/S` | 静默模式，无界面 |
| `/D=<路径>` | 安装目录，必须置于命令行末尾，不加引号 |
| `/allusers` | NSIS 支持，但本项目 `perMachine: false`，仍按当前用户安装 |

静默安装同样执行环境变量写入，只是不显示进度文字。

### 静默卸载

```cmd
"%RUN_WORKER_HOME%\Uninstall Run worker.exe" /S
```

（卸载器为安装目录下的 `Uninstall Run worker.exe`；也可从“设置 → 应用 → 已安装的应用”里卸载。）

---

## 5. 卸载与残留清理

卸载器行为（`customUnInstall`）：

1. 删除 `HKCU\Environment\RUN_WORKER_HOME`。
2. 从用户 `PATH` 中移除安装目录，按分号拆分逐段比对后重组，其余条目保持原顺序。
3. 删除 `HKCU\Software\RunWorker`。
4. 删除开始菜单与桌面快捷方式、安装目录内文件。
5. **保留** `%APPDATA%\Run worker\`（`deleteAppDataOnUninstall: false`）——你的对话、设置、知识库、记忆不会被删。

想彻底清干净，卸载后手动删除：

```cmd
rmdir /s /q "%APPDATA%\Run worker"
```

若卸载后 `PATH` 里仍看到残留（早期版本可能出现空条目），手动编辑：

```
Win + R → sysdm.cpl → 高级 → 环境变量 → 用户变量 → Path → 编辑
```

---

## 6. 常见问题

### 6.1 杀毒软件 / SmartScreen 拦截

- SmartScreen 显示“Windows 已保护你的电脑”：点“更多信息”→“仍要运行”。
- 杀软报“未知发布者”或隔离 `setup.exe`：加入信任后再运行；企业环境请让 IT 按组织策略放行。
- 若安装中途被杀软删除文件，卸载后重新安装，安装前先加白名单目录。

### 6.2 没有管理员权限

无需管理员：默认安装在用户目录，仅写 `HKCU`。如果公司策略禁止写入个人目录，请让管理员用 `/D=` 指定一个有写权限的目录，或用 `perMachine` 方式的企业分发（本项目默认未启用）。

### 6.3 目录含中文或空格

- 安装器为 Unicode 版，中文路径可正常安装。
- 应用内的 Python / shell 调用已对含空格路径加引号处理。
- 仍建议安装到纯英文、无空格路径（如 `D:\Apps\RunWorker`）：部分第三方命令行工具（老版本 ffmpeg 包装脚本、某些 Python 包）对非 ASCII 路径支持不佳，这类问题不属于应用可控范围。
- 若已装在中文路径且出现脚本执行异常，卸载后换路径重装是最快的排查手段。

### 6.4 安装后终端里找不到命令

已打开的终端不会自动刷新环境变量。新开一个窗口；仍无效时确认 `HKCU\Environment` 下 `Path` 是否包含安装目录，或重启资源管理器。

### 6.5 重复安装后 `PATH` 出现多条

安装脚本写入前会做包含判断，正常情况下不会重复。若因手动改过 `PATH`（大小写、结尾反斜杠不同）导致重复，手动删除多余条目即可；0.0.5 会补齐大小写与尾斜杠归一化。

### 6.6 安装完打不开 / 白屏

1. 先看 `%APPDATA%\Run worker\logs\main-YYYY-MM-DD.log` 最后几十行。
2. 删除 `%APPDATA%\Run worker\settings.json`（会重置设置，不删对话）后重试，排除配置损坏。
3. 多屏不同缩放导致的白屏问题在 0.0.5 通过升级 Electron 修复；临时可先改回 100% 缩放启动。

### 6.7 升级会丢数据吗

不会。覆盖安装只替换程序文件，不触碰 `%APPDATA%\Run worker\`。升级前建议复制该目录做备份。

# DS Bot 浏览器与电脑操作修复工具

为 **Windows x64 / DS Bot 0.3.1** 制作的离线修复工具，处理浏览器操控未启用，以及 Cua Driver 在 Electron ASAR 中加载原生 DLL 失败的问题。

**[下载 v1.0.0 离线工具包](https://github.com/sonny-27/dsbot-capability-repair/releases/tag/v1.0.0)**

这是独立的社区修复工具，与 DS Bot 官方项目没有隶属关系。其他版本会先检测，版本不匹配时拒绝自动套用补丁。

## 使用

1. 从 Releases 下载 ZIP，完整解压。
2. 双击 `DSBot-Repair.exe`，确认安装目录和数据目录。
3. 点击“检测”，查看两类驱动的实际加载结果。
4. 保存 DS Bot 中当前工作，选择需要修复的项目，点击“修复并重启”。

修复会完整结束并重启所选安装目录的 DS Bot，当前任务会停止。工具自带依赖，无需另装 Node.js、Playwright 或 Chromium，也无需联网下载驱动。

默认识别当前用户下的安装和数据目录。迁移过 DS Bot 数据时，请手动选择包含 `profiles/ds-bot/cordis.patch.yml` 与 `bot/state.json` 的目录。

完整步骤见 [使用说明](使用说明.txt)。

## 修复内容

| 能力 | 默认安装中发现的问题 | 工具的处理 |
| --- | --- | --- |
| 浏览器点击、输入 | 浏览器插件未启用，缺少 Playwright 驱动 | 启用插件，配置离线 `playwright-core`，完整重启 |
| 电脑操作 | 原生 FFI 加载器使用 `app.asar` 内的虚拟 DLL 路径 | 将已存在的 DLL 路径映射至 `app.asar.unpacked`，检测驱动并启用总开关 |
| 缺失或损坏的电脑驱动解包文件 | 安装内容不完整 | 仅在离线文件 SHA-256 与安装包记录匹配时恢复 |
| 改配置后工具仍不可用 | 运行中的工具注册状态可能过期 | 完整停止并重启 DS Bot |

浏览器已有的 `refs` / `script` / `task` 选择会保留，未配置时使用 `refs`。电脑操作会启用总开关，并保留各个 Bot 的权限等级、应用授权和受保护应用限制。

工具不修改 `app.asar`，也不修改模型、API Key、连接器、聊天或 Windows 安全设置。未知的本地加载器改动会提示冲突，避免覆盖。

## 备份与回滚

每次改写前，会在所选数据目录的 `capability-repair/backups/时间戳` 保存原文件和事务清单。失败时自动尝试恢复本次写入。

“回滚并重启”撤销最近一次有实际修改的修复。配置回滚只恢复本工具改动的字段，保留后续修改的其他设置与聊天；相关字段或驱动文件被另行修改时，会停止并提示冲突。

报告仅保存在本机 `reports/` 中。报告和备份不会上传；备份包含原始配置，应按 DS Bot 数据的标准保管。

## 验收

**浏览器：** 在 Bot 的浏览器面板打开百度，让 Bot 调用 `browser_snapshot`，再用 `browser_type` 输入 `test` 并提交，确认面板显示搜索结果。使用 `script` / `task` 插件时，使用对应工具。

**电脑操作：** 先让 Bot 列出应用和窗口。如需验收输入，在记事本中新建空白文档，按 DS Bot 提示授权该 Bot 使用记事本，再让它输入测试文字。

驱动检测会实际创建 Cua Driver、读取工具目录并调用 `list_apps`，但不会向用户桌面点击或输入。驱动检测通过不代替 Bot 内的应用授权与最终操作验收。

## 已完成的验证

- 10 项自动化测试：配置与标签保留、重复修复、回滚冲突、权限保留、路径边界、文件哈希和 ASAR 字节读取。
- 隔离安装副本：原始加载器复现 `cua_driver_sdk.dll / os error 126`；应用补丁后，56 个工具和 `list_apps` 检测成功。
- 合成数据事务测试：首次修复修改 3 个文件，重复修复为 0 个；回滚保留后续模型、偏好与 Bot 授权。
- 独立 EXE 的界面检测流程与渲染检查。
- 本机 Bot 的百度 `test` 搜索验收。

详见 [验证记录](验证记录.txt)。

## 源码与构建

仓库包含与离线包一致的源码、驱动、哈希清单及第三方许可。当前发布版验证环境为 DS Bot 0.3.1、Cua Driver 0.28.0、playwright-core 1.65.0。

源码测试建议 Node.js 24：

```powershell
node --test tests/repair.test.mjs
```

在 Windows 上重建 GUI：

```powershell
powershell -NoProfile -File .\build-gui.ps1
```

GUI 使用 Windows 自带的 .NET Framework 与 Windows PowerShell 运行时；修复后端使用所选 DS Bot 自带的 Electron Node 运行时。

手动运行后端（另装 Node.js 时）：

```powershell
node repair.mjs detect
node repair.mjs repair --components browser,computer --restart
node repair.mjs rollback --restart
```

可追加 `--app-dir "安装目录" --home "数据目录"`。源码中的集成测试需要安装文件及单独的测试输出目录，不应对真实用户配置执行故障注入。

## 第三方许可

随包组件保留各自的许可证、通知与对应源码地址，见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) 与 `licenses/`。修改的 JavaScript 加载器及其原始版本一并提供；原生二进制没有修改。

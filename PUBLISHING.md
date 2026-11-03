# 发布 FoxEss WIKI

正式 Windows 版本使用 `vMAJOR.MINOR.PATCH` 标签，例如 `v1.0.0`。上游多平台打包工作流只允许手动构建，不会在推送标签时自动发布其他安装包。

## 构建和验收

1. 同步修改 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的应用版本；保留 `com.llmwiki.app` 标识。
2. 使用 Windows、Node.js、Rust MSVC、Visual Studio C++ Build Tools 和 protoc 构建。常规源码构建可执行 `npm ci`、`npm --prefix mcp-server ci`、`npm run build:desktop`，再用 Tauri 构建 Windows 应用。本机运维工具使用 `windows-native/Build.ps1`。
3. 完成前端回归、原生更新验证及安装包离线验收。发布时必须使用与候选安装包哈希一致的验证报告。
4. 运行 `windows-native/Build-Installer.py`，安装包输出到 `windows-native/releases/v<version>`。公开发行使用 `public` 凭据模式；`enterprise` 可能包含企业模型凭据，禁止未经明确授权上传到公开仓库。

## 本机运维工具的外部构建输入

公开仓库包含应用源码、锁文件、第三方 HTTP 插件补丁、Windows PDFium、更新助手及其合成测试、签名/发布工具，以及 `skills/llm-wiki/SKILL.md`。标准 npm/Tauri 源码构建使用已安装的 Node.js、Rust MSVC、Visual Studio C++ Build Tools 和 protoc。

`windows-native/Build.ps1` 和 `Build-Installer.py` 同时保留本机原有运维目录布局，不是下载后即运行的通用引导器。若要在新发布机重建同款完整安装包，需要另行准备这些不入库的输入：

- `native-tools/manual-rust`、`native-tools/cargo-cache` 和 `native-tools/protoc`：已安装/校验的 Rust 工具链与 protoc；本机脚本使用其固定位置。
- `original-desktop/release/pdfium/pdfium.dll` 与 `windows-native/app/pdfium.dll`：本机原有 PDFium 副本。标准 Windows 构建对应文件已在 `src-tauri/pdfium/pdfium.dll` 提供，运维目录副本需按相同来源和哈希准备。
- `native-tools/installer-downloads`：NSIS 编译器、微软签名的 WebView2 离线安装器、Node 许可与 PDFium 第三方许可文件。MSVC 发布运行 DLL 来自本机 Visual Studio 可再发行目录。按各供应商官方来源与许可准备，不能用本机密钥或用户数据替代。
- `windows-native/runtime`：候选构建 provenance、回归结果与验包报告等本机证据。重新运行测试和构建生成；不从其他版本复制旧报告代替验收。

默认 `public` 构建会移除私有模型构建输入；`enterprise` 必须显式指定并提供本机私有模型输入。发布私钥、企业凭据和 GitHub 登录不随源码分发。Skill 打包只从仓库的受控文件读取，不再依赖发布者个人的 `~/.codex/skills` 目录。

## 签名和发布资产

应用只信任 `src-tauri/resources/update-public-key.json` 中公钥验证通过的更新。签名算法为 Ed25519，与 Windows Authenticode 证书独立。

每个版本必须同时发布：

- `FoxEss-WIKI-<version>-x64-Setup.exe`
- `FoxEss-WIKI-<version>-update.json`
- `FoxEss-WIKI-<version>-update.json.sig`
- `SHA256SUMS.txt`
- 对应源码压缩包、使用手册、安装说明及经过脱敏的验证结果。

签名覆盖 manifest 的原始 UTF-8 字节；manifest 包含仓库名、版本、安装包文件名、大小、SHA256 和应用程序 SHA256。修改任何字段后都必须重新签名。运行 `node windows-native/Sign-Release.mjs` 生成签名，`--verify-only` 仅验证现有签名。

私钥保存在本地忽略目录 `windows-native/runtime/update-signing-key.private.pem`，也可通过 `FOXESS_UPDATE_SIGNING_KEY` 指定路径。请单独安全备份。私钥、模型密钥、GitHub 令牌、用户配置及知识库数据不属于公开源码或 Release 资产。

`Publish-GitHub-Release.py` 使用本机 Git 凭据管理器读取 GitHub 登录信息，仅在内存中使用令牌。它先创建草稿，上传受控资产并核对 GitHub 返回的 SHA256，再按 `--publish` 发布；不会在上传失败时把不完整版本标记为最新版。

```powershell
python windows-native/Publish-GitHub-Release.py --commit <已推送的提交SHA> --notes-file <版本说明文件> --publish
```

## 用户端更新

应用运行时每天按本机时间 06:00 检查该仓库的最新正式 Release；错过时间会在下次启动或唤醒时补查，网络失败会稍后重试。用户点击更新后才下载安装，保存和暂停任务完成后重启。下载、签名或校验失败时不会安装。需要先用正式安装包安装应用；开发目录内单独运行的 EXE 不执行覆盖安装。

更新仅替换安装清单管理的程序文件。原有项目、原始文档、模型配置和访问令牌沿用原位置。安装器不会把共享盘文档复制进更新包。

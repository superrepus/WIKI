# FoxEss WIKI

Windows 技术资料知识工作台。**v1.0.0 是首个完整版本**，整合 Wiki 知识编译、跨文档关系、来源依赖、可追溯问答和共享盘增量同步。

[下载 Windows 安装包](https://github.com/superrepus/WIKI/releases/latest) · [发布流程](PUBLISHING.md) · [使用手册](src/content/user-manual.zh.md)

## 使用

下载最新 Release 中的 `FoxEss-WIKI-<版本>-x64-Setup.exe` 安装。桌面界面用于日常操作；运行期间也提供本机 API、CLI、MCP 和 Skill 访问。GitHub 下载页提供离线使用手册和对应源码。

创建或切换知识库后，在“原始资料”登记文件或文件夹。原文可以位于本机或当前 Windows 账号有权访问的 UNC 共享盘：应用直接读取原文件，本地保存 Wiki、索引及必要缓存。

“设置 → 来源与自动同步”分别展示始终自动检查的手动来源，以及可以添加多条、分别启停和设置周期的额外监控目录。新增和修改进入提取、编译队列；确认删除后撤回依赖旧来源的知识。共享盘断连或权限异常时保留记录。

对话和知识库构建支持分别选择模型。可以使用兼容 OpenAI API 的本地或远程模型，模型配置与知识库数据保存在本机。安装包的模型凭据策略以该 Release 的安装说明为准；源码不包含模型密钥。

## 更新

应用每天按**本机时间 06:00**检查本仓库的 GitHub Releases，错过后在下次运行或唤醒时补查。发现正式新版会提示版本与变更说明；用户点击后下载安装，完成保存及任务暂停，再更新并重启。

更新 manifest 通过内置 Ed25519 公钥校验，安装包也会核对 SHA256、大小和版本。更新保留原有配置、访问令牌和知识库数据。需要先通过正式安装包安装 v1；开发目录中的单个 EXE 不会自动覆盖安装。

## 源码构建

前端使用 React / TypeScript，桌面后台使用 Tauri / Rust。需要 Node.js、Rust MSVC、Visual Studio C++ Build Tools、protoc 和 Windows WebView2。

```powershell
npm ci
npm --prefix mcp-server ci
npm run build:desktop
npm run tauri -- build --config src-tauri/tauri.windows.conf.json
```

本地打包、验收、签名和发布说明见 [PUBLISHING.md](PUBLISHING.md)。公开源码不包含用户数据、运行日志、模型密钥、GitHub 凭据或更新签名私钥。

## 来源和许可

本项目在 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 的基础上修改，保留其 Wiki 编译、关系分析和检索功能；原项目说明见 [UPSTREAM_README.md](UPSTREAM_README.md)。修改版继续遵循 [GNU GPL v3](LICENSE)，第三方组件许可证随安装包提供。

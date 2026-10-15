# 开发、CI 与发布构建

需要 Node.js 22.12+、npm 和目标平台构建环境。首次克隆运行 `npm ci`，随后 `npm run check`、`npm test`。`npm start` 用于开发启动。

## 本机构建

macOS Apple Silicon：

```sh
npm run package -- --platform darwin --arch arm64
```

macOS Intel：

```sh
npm run package -- --platform darwin --arch x64
```

Windows x64：

```sh
npm run package -- --platform win32 --arch x64
```

在对应操作系统构建。macOS 需要 Xcode Command Line Tools/Swift，以目标架构编译 TokenLens 同源软件样本读取器；Windows 不包含该 Swift helper。不要用跨平台打包成功推定原生安装、签名或第三方 CLI 运行已验证。

默认输出到 `release/`，版本号取自 `package.json`：

| 目标 | 产物 |
| --- | --- |
| macOS arm64 / x64 | `AgentFlow-<版本>-macOS-<架构>.zip` 和 `.dmg` |
| Windows x64 | `AgentFlow-<版本>-Windows-x64.zip` 和 `AgentFlow-<版本>-Windows-x64-Setup.exe` |
| 全部目标 | `SHA256SUMS.txt` |

可传 `--out <目录>` 改输出位置；`--formats zip,dmg` 或 `--formats zip,exe` 选择对应平台格式。ZIP 为完整应用目录，Windows 安装程序与便携目录分别发布。校验和用于检查下载一致性，不等同于发布者身份签名。

发布包包含应用白名单源码、Electron、所需官方 Node 运行时和许可证。不会包含开发机账号、API 连接、聊天、私有 CodeBuddy 安装组件或个人工作目录；外部智能体仍需用户自行安装和授权。

## GitHub Actions

工作流：`.github/workflows/build-release.yml`。

- `push`、`pull_request`：对声明的 macOS arm64、macOS x64、Windows x64 目标进行测试和构建，产物在对应 Actions 运行中下载。
- `workflow_dispatch`：手动构建并上传 Actions 产物，不自动发布 Release。
- `v*` 标签：校验标签版本与 `package.json` 一致，通过目标矩阵后上传 GitHub Release 资产。发布前先检查此次运行状态与平台验收范围。

仅在仓库实际启用发布工作流且目标运行成功后，Release 中才有相应资产。失败或尚未执行的目标不能写作已验证。

## 签名与平台验收

默认 macOS 使用临时签名（ad hoc），没有 Developer ID 公证；Windows 默认未做 Authenticode 签名。当前构建脚本尚未接入自定义发布证书或公证。后续扩展须通过受保护的仓库 secrets 提供凭据，不能提交到源码或公开构建日志。签名状态以对应 Release 说明和实际产物为准。

CI 检查协议、引擎及构建，不持有真实模型账号，不自动进行收费推理。外部产品的认证、工具权限、模型目录与原生 GUI 兼容性还需在目标平台单独验证。[平台支持](platform-support.md) · [验证范围](validation-v04.md)

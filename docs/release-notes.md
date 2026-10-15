# AgentFlow 0.4.3 · Build 10

中文多智能体桌面工作台：输入需求，由启动模型推荐团队；你确认后执行，模型验收后再由你最终接受。每环节可选择已就绪的模型及其支持的思考强度，查看实际对话、尝试记录与用量。

## 下载哪个包

| 电脑 | 安装包 | 便携/压缩包 |
| --- | --- | --- |
| Apple 芯片 Mac | `AgentFlow-0.4.3-macOS-arm64.dmg` | `AgentFlow-0.4.3-macOS-arm64.zip` |
| Intel Mac | `AgentFlow-0.4.3-macOS-x64.dmg` | `AgentFlow-0.4.3-macOS-x64.zip` |
| Windows x64 | `AgentFlow-0.4.3-Windows-x64-Setup.exe` | `AgentFlow-0.4.3-Windows-x64.zip` |

macOS 将 `AgentFlow.app` 放入“应用程序”。Windows 运行安装程序，或解压 ZIP 后打开 `AgentFlow.exe`，不要单独移动 EXE。`SHA256SUMS.txt` 可校验下载文件；源码压缩包不能直接当桌面应用运行。

## 第一次使用

1. 打开“连接”，检测已安装的官方 CLI，按提示在原厂入口完成授权；也可添加自定义 API。
2. 选择可用的启动模型，输入需求并发送，检查并确认推荐流程。
3. 查看执行结果，模型验收通过后选择接受或继续修改。Enter 发送，Shift+Enter 换行。

只有已接通并就绪的执行器能自动运行。发现桌面应用或已有登录，不代表具备自动执行接口；待接入应用保持灰色。账号由本机原厂组件管理，发布包不含任何用户登录数据、API 密钥或聊天。连接验证可能产生少量真实推理用量。

## 用量与平台

本版提供按模型的近期曲线、条形与样本环图，以及逐环节公开对话。未知字段保持未知，缓存和推理不重复计数。

macOS 可读取受支持软件的限量本地日志样本。Windows 当前仅显示 AgentFlow 任务计量，不提供 Swift 软件日志读取器。样本不代表完整账单或订阅余额。

macOS 为临时签名（ad hoc），**未进行 Developer ID 公证**；Windows **未做 Authenticode 发布者签名**。系统可能显示来源提示，请先核对下载来源与校验和。各厂商 CLI、账号和模型权限需自行安装或配置；不同平台的连接能力以实时检测为准。

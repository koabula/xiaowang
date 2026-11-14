# 小王同学

[English](README.en.md)

一个面向科研辅助与日常工作的桌面 Agent：前台 Realtime 模型负责实时语音交流，后台 LLM 负责复杂调研、阅读、比较和写作。语音与文字共用任务、资料库和持久化记录。

## 能做什么

- **实时语音**：支持 OpenAI、通义千问和豆包的适配；麦克风与播放音量驱动波形，界面分别显示聆听、回答、查阅、暂停和重连状态。
- **连续讲解**：逐页讲解材料；等待实际播放结束后续讲，插话后保留讲解位置；支持暂停、恢复和完成。
- **后台任务**：复杂任务排队执行，保存任务编号、状态、结果和输出文件；支持取消、重试、静默完成及空闲时语音通知。
- **科研资料**：检索 OpenAlex、arXiv、Crossref、PubMed；导入 PDF / Markdown / 文本；按页阅读和定位。PDF 解析在独立进程中执行并缓存。
- **工作空间**：每个任务独立保存资料引用、术语、会话和文件；右侧可以查看 PDF、HTML 演示和应用内浏览器。
- **文字交流**：支持 OpenAI 兼容接口和 Anthropic 接口的流式回答；停止操作会传递到正在进行的模型请求。

## 本地开发

需要 **Node.js 24 或以上版本**、npm，以及 macOS、Windows 或 Linux。

```sh
npm ci
npm run desktop
```

首次启动在设置中填写后台模型名称、接口地址和密钥，再选择语音服务、模型、音色与密钥。语音服务与后台模型可以来自不同提供商。

其他命令：

```sh
npm run typecheck     # 检查内核和桌面代码
npm test             # 内核、任务队列、语音时序和流式接口测试
npm run build        # 构建生产版本
npm start            # 启动已构建的桌面应用
npm run preview      # 浏览器预览界面；不连接真实 Agent
npm run test:desktop # 使用隔离数据和本机模拟模型检查真实桌面流程
```

Linux 无图形桌面的环境运行桌面测试时使用：

```sh
xvfb-run --auto-servernum npm run test:desktop
```

桌面测试使用合成麦克风、模拟模型和临时目录，不需要真实模型密钥。

## 模型和搜索设置

后台模型支持 OpenAI 兼容的 Chat Completions 或 Anthropic Messages 接口。模型目录获取失败时，可以直接填写模型名。接口连通性检查不会验证模型是否具备全部工具能力。

语音适配分别处理采样率、会话配置、工具结果和回复触发方式。OpenAI 使用客户端统一调度回复；Qwen 和豆包保留服务端语音活动检测。服务商可能调整模型与协议，使用真实服务时请先试听并进行短通话检查。

通义千问的工作空间域名可在设置中填写工作空间 ID 或完整 `wss://` 地址。旧的 Qwen 3.5 连接配置仍可使用其默认地域地址；建议以所在地域的官方接入说明为准。

快捷网页搜索支持 Brave 和 SearxNG，可在设置中配置；不配置时仍可使用学术检索和应用内浏览器。CLI 可以通过环境变量配置：

| 变量 | 作用 |
| --- | --- |
| `XIAOWANG_MODEL` | 后台模型名称 |
| `XIAOWANG_BASE_URL` | 后台模型 API 地址 |
| `XIAOWANG_API_KEY` | 后台模型密钥 |
| `XIAOWANG_API_STYLE` | `openai` 或 `anthropic`，可省略以自动判断 |
| `XIAOWANG_SEARCH_PROVIDER` | `brave` 或 `searxng` |
| `XIAOWANG_SEARCH_KEY` | 网页搜索密钥 |
| `XIAOWANG_SEARCH_URL` | 自定义搜索地址 |
| `XIAOWANG_HOME` | 会话数据库、资料库及任务工作区根目录 |
| `XIAOWANG_USER_DATA` | Electron 用户配置目录，可用于隔离测试 |
| `XIAOWANG_REALTIME_SERVICE` / `XIAOWANG_REALTIME_MODEL` / `XIAOWANG_REALTIME_KEY` | 桌面端语音服务、模型及密钥的环境配置 |
| `XIAOWANG_REALTIME_URL` | 覆盖当前语音服务的连接地址，适用于本地服务和测试 |

桌面端也可使用这些环境配置；环境值优先，只在内存中使用，不会改写保存的密钥。

CLI 使用方法：

```sh
npm run xiaowang -- help
```

## 语音与后台协作

复杂任务通过 `delegate_task` 提交；返回的编号代表任务已记录，不代表任务已经完成。`get_task` 查询真实状态。`notify=when_idle` 会在通话合适的间隙通知结果；`notify=silent` 仅更新任务记录。

同一工作区的后台任务按顺序执行，不同工作区最多同时执行两项。应用重启后，尚未开始的任务可以继续执行；此前正在执行的任务标记为中断，由用户检查已有输出后手动重试，避免重复执行写入。

完整讲解由持续任务管理，模型可使用 `manage_presentation` 的 `start`、`pause`、`resume`、`complete` 操作。界面也提供暂停与恢复按钮。用户确认和提问会保留讲解任务，明确暂停或结束才改变任务状态。连续讲解有步数保护，避免无限生成。

## 数据和凭据

- 会话与资料默认存放在 `~/.xiaowang/`；可用 `XIAOWANG_HOME` 修改。
- 模型设置保存在 Electron 用户配置目录，密钥优先通过系统的安全存储能力加密。系统不支持加密时会使用本地文件；请妥善保护自己的用户目录。
- 资料库按内容去重，各任务只能读取自己引用的原件；文件工具限制在所属工作区内。
- 文档、网页和工具返回的内容作为资料处理，不能替代用户指令。
- 语音和需要处理的资料会发送到你配置的模型服务商；使用前请确认其数据处理方式适合你的研究材料。

## 打包 macOS、Windows、Linux

通常在对应系统上构建其安装包：

```sh
npm run dist:mac -- --arm64 # Apple Silicon；Intel 使用 --x64
npm run dist:win           # Windows x64，NSIS .exe
npm run dist:linux         # Linux x64，AppImage 和 .deb
```

输出位于 `release/`。`npm run pack` 可先生成用于检查的应用目录。

### GitHub Actions

仓库地址不需要写入构建配置。将项目推送到 GitHub 后，`.github/workflows/desktop.yml` 会在以下情况运行：

- 推送到 `main` 或 `master`；
- 推送 `v*` 标签；
- 手动选择 **Actions → Desktop installers → Run workflow**。

Pull Request 运行检查、测试和生产构建。检查通过后，主分支、标签或手动运行会在三个系统分别打包：

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Intel x64、Apple Silicon arm64 | `.dmg`、`.zip` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | `.AppImage`、`.deb` |

GitHub 构建会自动把当前仓库 URL 填入安装包元数据。若在本机制作 Linux `.deb`，请先填写 `package.json` 的 `homepage` 或 `repository`，或设置 `GITHUB_REPOSITORY=拥有者/仓库名`。

进入对应的 Actions 运行，在 **Artifacts** 下载，默认保留 14 天。各平台同时提供 `SHA256SUMS.txt`。工作流不自动发布 GitHub Release，也不需要模型服务密钥。

### 可选代码签名

不提供签名凭据时可以构建未签名安装包。系统可能对未签名应用显示安全提示。正式对外分发时，可在 GitHub 仓库的 Actions secrets 中配置：

| 平台 | Secret |
| --- | --- |
| macOS 签名 | `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD` |
| macOS 公证 | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |
| Windows 签名 | `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` |

`CSC_LINK` 支持 electron-builder 接受的证书路径或编码内容。macOS 构建包含麦克风使用说明与音频输入权限。不要把证书、密码或模型密钥提交到仓库。

## 项目结构

```text
src/                  Agent 内核、会话、模型接口、任务队列与科研工具
desktop/main/         Electron 主进程、语音调度、展示确认和浏览器
desktop/renderer/     React 界面、音频采集播放、文档阅读与状态反馈
desktop/scripts/      开发、生产构建、校验和脚本
test/                 内核与协议回归测试
e2e/                  隔离的真实桌面流程测试
.github/workflows/    自动检查与三端安装包
```

当前 PDF 阅读针对可提取文字的文件；扫描件 OCR、图表的视觉理解以及真实服务的语音识别质量取决于后续能力接入与提供商。桌面测试验证本机模拟服务下的完整流程，不能替代对真实模型服务的检查。

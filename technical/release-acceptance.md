# 发布前后台验收记录

日期：2026-11-17。验收分支：`codex/release-background-acceptance`。

本轮验证三批优化后的 `96aa567`，随后提交测试兼容修复 `0473950`。产品版本保持 `0.1.19`。环境为 macOS arm64、Node v26.13.1；尚未执行远端 CI 的 Node 24 和其他平台验收。

## 已通过

| 检查 | 结果与范围 |
| --- | --- |
| 类型检查、构建 | `npm run typecheck`、`npm run build` 通过 |
| 单元回归 | `npm test`，221/221 通过 |
| 常规桌面回归 | `npm run test:desktop`，30/30 通过；隐藏窗口，审计未发现显示、焦点或系统剪贴板操作 |
| 资料与任务链路 | PDF 实际抽取、同名资料精确引用、笔记重开引用、任务补充、取消、重启持久化、工作区归属和重复启动去重通过 |
| 下载与异常路径 | 已知及未知长度超限、控制权切换取消、完成/失败/取消/正常退出后的临时目录清理通过；模拟服务故障与重连、更新校验失败重试通过 |
| UI 回归 | 浅深色、窄窗口、多文件、多行输入、资源标签及溢出操作通过 |
| macOS arm64 候选应用 | 在临时目录重新打包，采用本地 Electron 和临时签名；`codesign --verify --deep --strict` 通过 |
| 候选应用内容 | 主进程、PDF worker、两个 preload、渲染入口与本轮构建逐字节一致，版本一致 |
| 候选应用后台流程 | 浏览器控制、PDF/语音/设置综合流程、预算控制、最终回答展示、更新下载校验、论文研究共 6 条路径均通过；其中综合流程首次失败，修复测试后单独复验通过 |

以上模型与语音使用隔离的本地模拟服务和合成音频，不代表真实模型回答质量、真实麦克风或外放效果。运行前清除了模型服务和应用覆盖环境变量，未使用用户真实资料或模型账号。候选应用使用后台启动模式，未执行安装或更新替换。

候选文件：`/tmp/xiaowang-acceptance-package/mac-arm64/xiaowang.app`。`app.asar` SHA-256：`26ec405dd5bf072af79beefac92ad7356e8873a3c47ecc92e3ae89c5896994c5`。临时签名的完整性检查不能代替正式安装、系统信任或公证验收。

## 本轮唯一修复

`e2e/desktop.test.mjs` 的 PDF 缩放检查直接调用开发模式的 `app.evaluate`，实际候选应用通过 CDP 连接，没有这个接口，导致 `TypeError: app.evaluate is not a function`。

改为在应用页面比较 `window.devicePixelRatio`，继续验证 PDF 手势只改变文档缩放、不改变应用视口缩放。开发版本与候选应用分别复验通过。产品代码、UI、配置和正常启动行为没有变化。其余 5 条候选应用路径此前已通过且未受此修改影响。

## 待验收，未运行

| 项目 | 所需条件 | 验收内容 |
| --- | --- | --- |
| 真实模型研究 | 用户指定的模型账号 | 固定 PDF 的回答依据、补充要求、引用准确性和笔记完整性 |
| 真实语音闭环 | 语音账号、麦克风与扬声器，单独安排前台时间 | 收音、实际外放、打断立即停止、继续对话、挂断后结果 |
| 原生输入与剪贴板 | 专用桌面或测试机，会抢焦点且写入剪贴板 | 中文输入法、文字/图片粘贴、鼠标滚轮、浏览器控制权、二次启动激活旧窗口 |
| 安装与更新替换 | 隔离测试机和实际发行安装包，可能激活窗口或重启应用 | ZIP/DMG 首启、安装、更新替换、数据保留和重启；单独运行 `e2e/native/` 专项 |
| 其他平台与架构 | 对应测试机或 CI | macOS x64、Windows、Linux 构建及安装首启；当前通过项仅覆盖本机 arm64 候选应用 |
| 发布配置 | 最终候选提交与新版本号 | Node 24/跨平台 CI；版本、标签、更新清单及下载文件一致 |

真实账号与原生专项本轮均未直接运行，不计为已通过。原生专项不应在用户正在工作的桌面启动。

## GitHub 推送结论

- 远端 `main` 仍为 `8b565b5`，是本分支祖先，没有分叉。
- GitHub API 确认仓库未归档且当前账号有推送权限。
- `git push --dry-run origin HEAD:refs/heads/codex/release-background-acceptance` 成功；没有实际推送或创建远端分支。
- 可以推送功能分支并创建 PR，之后运行远端 CI。当前工作流由 PR 触发检查，单独推送 `codex/*` 分支不会触发该工作流。
- 暂不打发布标签：远端已经存在 `v0.1.19`，正式发布前应完成待验收项并确定新版本号。推送版本标签会触发现有自动发布流程。

## 本机验证记录

- `/tmp/xiaowang-acceptance-typecheck.log`
- `/tmp/xiaowang-acceptance-unit.log`
- `/tmp/xiaowang-acceptance-build.log`
- `/tmp/xiaowang-acceptance-desktop.log`
- `/tmp/xiaowang-acceptance-package.log`
- `/tmp/xiaowang-acceptance-signature.log`
- `/tmp/xiaowang-acceptance-artifact.json`
- `/tmp/xiaowang-acceptance-packaged.log`（首次运行 5/6，保留失败原因）
- `/tmp/xiaowang-acceptance-desktop-recheck.log`（修复后的开发版本复验）
- `/tmp/xiaowang-acceptance-packaged-recheck.log`（修复后的候选应用复验）
- `/tmp/xiaowang-acceptance-screenshots/`（浅深色和设置等后台截图）

临时文件可能被系统清理；以上已通过结论及已知限制记录在本文件中。

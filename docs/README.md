# 小王同学（XiaoWang）设计文档

> **定位**：面向「科研辅助 + 日常助手」的全双工实时语音与富文本工作台 Agent 客户端。

这套文档记录了项目启动阶段确立的**产品心智、核心架构哲学与关键协同机制**。

## 阅读原则：守住边界，拥抱演化

正如 Anthropic 在 *Managed Agents* 中总结的经验——优秀的系统应当**对核心抽象边界保持鲜明立场，而对边界背后的具体实现保持开放**。

因此，本目录中的设计文档遵循以下约定：
- **不变量（Invariants）**：例如“对用户呈现统一连续身份”、“会话记录独立于具体模型的上下文窗口，裁剪对用户不可见”、“前台实时交互不被后台长任务阻塞”、“话题与笔记按 Bot 隔离，资料库原件与浏览器登录则在用户交出后共用”。这些是决定体验下限的基石。
- **可演化决策（Evolvable Choices）**：文档中提到的目录划分、第三方库、数据存储形态、工具签名或状态机参数，均作为**参考基线（Baseline）**而非硬性教条。在编码落地的过程中，只要能用更简洁、更稳健的方式达成目标，随时可以推翻重塑。

---

## 文档目录

1. **[01-philosophy-and-principles.md](./01-philosophy-and-principles.md) — 核心设计哲学**
   极简透明的 Agent 内循环、`Session ≠ Context Window` 且裁剪对用户不可见、大脑与双手及凭据解耦、面向模型打磨 ACI、隔离话题而共享用户明确交出的东西。
2. **[02-product-and-bot-model.md](./02-product-and-bot-model.md) — 产品形态与多 Bot 空间模型**
   总入口是一个空间而不是调度台；一项目一 Bot；论文原件进共享资料库；应用内共用一块浏览器；文本与实时通话是同一个小王。
3. **[03-dual-model-coordination.md](./03-dual-model-coordination.md) — 前后台双模型协同机制**
   Realtime 语音模型与后台通用 LLM 如何围绕同一个灵魂协作：双视图非对称投影、非阻塞任务派发、三级反馈路由（含无反馈静默任务）与择机汇报。
4. **[04-realtime-and-tech-direction.md](./04-realtime-and-tech-direction.md) — Realtime 协议备忘、技术栈倾向与路线图**
   为什么 Realtime 需要专门适配层、首批模型的协议备忘、TypeScript 桌面端技术方向，以及从已落地的无头内核走向完整小王的顺序。
5. **[05-hands-library-and-browser.md](./05-hands-library-and-browser.md) — 双手：文献、资料库、浏览器与执行**
   文献多来源、原件与笔记分开、快捷搜索与应用内浏览器、以后跑命令的两种授权。写的是边界，不是工具清单。

---

## 参考阅读溯源

- [OpenMOSS/MOSS-Live](https://github.com/OpenMOSS/MOSS-Live) — 全双工语音交互与前后台异步协同架构参考
- [Qwen3.5-Omni-Plus-Realtime](https://www.qwencloud.com/models/qwen3.5-omni-plus-realtime) — 多模态实时交互与 WebSocket 工具调用参考
- [How to Build an Agent (Amp / Thorsten Ball)](https://ampcode.com/notes/how-to-build-an-agent) — 去神秘化的 Agent 极简循环哲学
- [Building Effective Agents (Anthropic)](https://www.anthropic.com/research/building-effective-agents) — 简单可组合模式与 ACI（Agent-Computer Interface）打磨指南
- [Scaling Managed Agents: Decoupling the brain from the hands (Anthropic)](https://www.anthropic.com/research/managed-agents) — 会话日志、推理控制循环与执行环境的三元解耦思想
- [Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome) — 代理看页面、点击，并把登录交还给人的操作习惯
- [ChatGPT 桌面版内置浏览器](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app) — 浏览器嵌在应用内、与人共用同一视图、下载与敏感动作分开处理的产品形态

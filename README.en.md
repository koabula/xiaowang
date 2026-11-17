<p align="center">
  <img src="desktop/icon.png" alt="XiaoWang icon" width="112" />
</p>

<h1 align="center">XiaoWang · 小王同学</h1>
<p align="center">A desktop companion for conversations, papers, research, and everyday work.</p>
<p align="center"><a href="https://github.com/koabula/xiaowang/releases/latest">Download</a> · <a href="README.md">简体中文</a> · <a href="https://github.com/koabula/xiaowang/issues">Report an issue</a></p>

## Product film

https://github.com/user-attachments/assets/9b08bac7-c1a6-4cfb-aa03-033debd49c1f

Speak naturally or give instructions in text. XiaoWang brings realtime voice and a background agent together: longer research runs while your conversation continues, and XiaoWang can tell you when the results are ready. PDFs, web pages, Canvas presentations, and generated notes share one window.

## Full demo

https://github.com/user-attachments/assets/7b27eaa3-ece9-470b-a0b3-87df8baa8588

Starting with a fresh workspace, ask XiaoWang to fetch *Attention Is All You Need* and create a sub bot for a quick analysis, then call to discuss the paper, self-attention, and an example. The demo includes immediate follow-ups to short answers, a voice interruption, and a spoken request to hang up. It uses real model services: Doubao's Xiaohe 2.0 for XiaoWang and Bill TTS for the questions, with actual waiting and conversation preserved. The conversation is in Chinese.

## Download and update

Choose an installer from the [latest GitHub Release](https://github.com/koabula/xiaowang/releases/latest):

| OS | Download |
| --- | --- |
| macOS · Apple Silicon | [![DMG Apple Silicon](https://img.shields.io/badge/DMG-Apple%20Silicon-2B59C3?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/koabula/xiaowang/releases/download/v0.1.19/XiaoWang-0.1.19-mac-arm64.dmg) |
| macOS · Intel | [![DMG Intel x64](https://img.shields.io/badge/DMG-Intel%20x64-2B59C3?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/koabula/xiaowang/releases/download/v0.1.19/XiaoWang-0.1.19-mac-x64.dmg) |
| Windows | [![Setup x64](https://img.shields.io/badge/Setup-x64-2B59C3?style=for-the-badge)](https://github.com/koabula/xiaowang/releases/download/v0.1.19/XiaoWang-0.1.19-win-x64.exe) |
| Linux | [![AppImage x64](https://img.shields.io/badge/AppImage-x64-2B59C3?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/koabula/xiaowang/releases/download/v0.1.19/XiaoWang-0.1.19-linux-x86_64.AppImage) [![DEB x64](https://img.shields.io/badge/DEB-x64-2B59C3?style=for-the-badge&logo=debian&logoColor=white)](https://github.com/koabula/xiaowang/releases/download/v0.1.19/XiaoWang-0.1.19-linux-amd64.deb) |

The macOS app currently uses a complete ad-hoc signature. If the first launch warns about an unidentified developer, try opening it, then choose **System Settings → Privacy & Security → Open Anyway**. Choose `arm64` for Apple Silicon (M-series Macs).

XiaoWang checks for updates automatically. When a new version is available, click the download icon beside Settings to install it. You can also select **Check for updates** in Settings.

## First run

1. Open **Settings → Text model** and enter the API address, model name, and key. The background agent uses this model to read sources, call tools, and complete work.
2. For calls, separately choose a **voice** service, model, and voice, and enter that provider's key. Voice is optional; text and voice can use different providers.
3. Create a topic workspace and add a paper or document, or start by typing a question. Click the **voice button on the right of the message input** to begin a call.

Voice calls support Qwen, OpenAI, Doubao full-duplex, and Gemini Live. XiaoWang remembers the key, model, and voice for each provider when you switch. In our current testing, Doubao offers the best user experience.

## Work with XiaoWang

Paste a screenshot or drag a paper or note into the message input to ask about it. Attachments stay in the current bot’s library. Choose a text model with vision support for image analysis.

During a Gemini Live, OpenAI, or Qwen call, you can ask “What does this figure show?” XiaoWang can see images you’ve sent to the current bot and the image or PDF page open in the right panel. The call panel shows what you’re sharing.

**Read a paper**

> Explain this paper's research question, methods, and main findings. Include source page numbers and save a note.

**Look and talk together**

> Walk me through this material page by page. I’ll interrupt when I have questions.

**Compare and research**

> Compare these papers' experimental settings and limitations. Write a note about the differences and let me know when it is ready.

**Ask XiaoWang to create a sub bot**

> Create a sub bot named “Full-duplex speech research.” Summarize our agreed goals, keywords, and paper leads in its task brief, and have it start a literature review.

Each sub bot appears in the sidebar with its own conversation and library. To hand over a paper, try “Start a new topic and ask a sub bot to analyze the paper we just found.” Right-click a sub bot to rename or delete it.

Click **＋** under **Files** or **Canvas** to browse your materials. When reading a PDF, you can scroll through pages, search, pinch to zoom, or follow a citation to its source. Each bot has its own browser page and can share website sign-ins. Click **Take control** to interact with the page yourself.

You can interrupt XiaoWang during a call while background work continues. Expand the **call record** to check progress, open files the bot created, or stop and retry a task.

## Your materials and models

Conversations and documents are stored locally in `~/.xiaowang/` by default. During calls and tasks, XiaoWang sends the relevant audio, context, and materials to the model services you configured.

## Development and feedback

You need **Node.js 24+** and npm:

```sh
npm ci
npm run desktop
```

The [technical architecture document](technical/README.en.md) covers LLM / Realtime coordination, context, and memory, with interactive diagrams and static images.

See the [development notes](DEVELOPMENT.md) for setup, tests, and packaging.

When reporting an [issue](https://github.com/koabula/xiaowang/issues), include the operating system, app version, voice provider, and reproduction steps. Remove keys and private material.

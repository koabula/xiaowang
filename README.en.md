<p align="center">
  <img src="desktop/icon.png" alt="XiaoWang icon" width="112" />
</p>

<h1 align="center">XiaoWang · 小王同学</h1>
<p align="center">A desktop companion for conversations, papers, research, and everyday work.</p>
<p align="center"><a href="README.md">简体中文</a></p>

XiaoWang brings realtime voice and a background agent together. Speak naturally or give instructions in text. Longer research can run in the background while your conversation continues; XiaoWang can let you know when the work is ready.

## What you can do

- **Read and research**: find papers, examine sources, compare methods, and keep notes with references.
- **Look and talk together**: open PDFs, web pages, or Canvas presentations alongside the conversation. Ask for a walkthrough, interrupt with questions, pause, or resume.
- **Delegate everyday work**: describe a longer task in text and follow its progress, results, and output files.
- **Keep topics separate**: give each research topic or project its own conversations, materials, and reading history.

## Get started

1. Install and open XiaoWang. In **Settings**, enter your text model's API address, model name, and key.
2. For voice conversations, choose a voice service, model, and voice, then enter its key. Text and voice can use different providers.
3. Add a paper or another document, or simply ask a question. Click the microphone button to start a call.

Try asking:

> Explain this paper's research question, methods, and main findings. Include source page numbers.
>
> Walk me through the whole presentation, page by page. I’ll interrupt when I have questions.
>
> Compare these papers and write a note about their differences. Let me know when it is ready.

Click **＋** under **Files** or **Canvas** to browse the current task's imported originals, workspace files, and recently opened materials. PDFs support continuous scrolling, text selection, search, and zoom. Click a source citation to jump to its page.

Background work appears in task cards, with cancellation and retry controls. Task records remain after restarting. Work that was running when the app exited requires a manual retry after checking existing results. If you leave Settings with unsaved changes, XiaoWang will ask what to do.

## Installers

Once the project is on GitHub, main-branch updates automatically build macOS, Windows, and Linux installers. Download them from **Actions → Desktop installers → a workflow run → Artifacts** in the repository.

Builds cover Apple Silicon and Intel Macs, Windows x64, and Linux x64. Installers without developer signing may show an operating-system security prompt.

## Development basics

You need **Node.js 24+** and npm:

```sh
npm ci
npm run desktop
```

Useful commands:

```sh
npm run typecheck     # Check the code
npm test             # Run automated tests
npm run build        # Build the desktop app
npm run test:desktop  # Exercise real desktop interactions with local mock models
npm run dist:mac      # Build an installer; dist:win and dist:linux are also available
```

On headless Linux, use `xvfb-run --auto-servernum npm run test:desktop`. See [Development notes](DEVELOPMENT.md) for the project layout, environment settings, and signing.

## Your materials and models

XiaoWang uses the model services you configure. Voice and relevant materials are sent to those providers, so choose services appropriate for your research. Conversations and documents are stored locally in `~/.xiaowang/` by default. Model settings live in the app's configuration directory, with keys stored using operating-system encryption when available.

The project is under active development. OCR for scanned documents is not included yet, and model findings should be checked against the original sources.

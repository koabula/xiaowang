# Development notes / 开发说明

[中文介绍](README.md) · [English introduction](README.en.md)

## Project layout

| Directory | Purpose |
| --- | --- |
| `src/` | Agent runtime, providers, tools, jobs, documents, workspace inventory |
| `desktop/main/` | Electron, voice scheduling, settings and browser integration |
| `desktop/renderer/` | React UI, audio playback, PDF.js Viewer and Canvas adapters |
| `test/` | Core and protocol regression tests |
| `e2e/` | Real Electron interaction and audio tests with isolated local fixtures |
| `.github/workflows/desktop.yml` | Checks and three-platform installer builds |

## Local configuration

Use the app's Settings panel for normal use. Environment overrides remain in memory and do not rewrite saved credentials.

| Variable | Purpose |
| --- | --- |
| `XIAOWANG_MODEL` | Background model name |
| `XIAOWANG_BASE_URL` | OpenAI-compatible or Anthropic endpoint |
| `XIAOWANG_API_KEY` | Background model key |
| `XIAOWANG_API_STYLE` | `openai` or `anthropic`; omit for automatic detection |
| `XIAOWANG_REALTIME_SERVICE` | Voice service selection |
| `XIAOWANG_REALTIME_MODEL` | Voice model name |
| `XIAOWANG_REALTIME_KEY` | Voice service key |
| `XIAOWANG_REALTIME_URL` | Voice endpoint override |
| `XIAOWANG_HOME` | History, materials and workspace root |
| `XIAOWANG_USER_DATA` | Electron configuration directory |

Use `npm run preview` for a UI-only browser preview or `npm run xiaowang -- help` for the CLI. Desktop tests use synthetic microphone input and local mock services; they never need real model keys. Real-provider checks should additionally cover a short conversation, interruptions, tool use and reconnects.

## Canvas integration

Generated decks mark each page with `data-xw-slide` and the current page with `active`. Custom navigation can expose:

```js
window.xiaowangSlides = {
  goToPage(page) { /* 1-based; update the rendered page and internal cursor */ },
  getState() { return { page: currentPage, totalPages: slides.length }; }
};
```

Existing `.slide`, `.s.on` and Reveal decks have compatibility adapters. Rendering receipts confirm the target page is visible. PDF.js resources are bundled for offline reading, including CJK maps, fallback fonts and decoders.

## Jobs and data

Jobs run sequentially within each workspace and at most two workspaces run concurrently. On restart, queued work resumes; previously running work is marked interrupted rather than replayed automatically. Voice interruption stops speech without cancelling background jobs.

Each bot can access only its referenced originals and files within its workspace. Search and browsing retain this boundary. Keys use OS encryption when available; local-file storage is used if encryption is unavailable. Do not commit model keys or signing certificates.

## Installers and CI

Build on the target operating system:

```sh
npm run dist:mac -- --arm64 # Apple Silicon; --x64 for Intel
npm run dist:win           # NSIS .exe, x64
npm run dist:linux         # AppImage and .deb, x64
node desktop/scripts/checksums.mjs
```

Output goes to `release/`; `npm run pack` produces an unpacked app. Local Linux `.deb` builds need a `homepage`/`repository` in `package.json`, or `GITHUB_REPOSITORY=owner/repo`.

GitHub Actions runs checks on pull requests and builds installers after successful checks on pushes to `main`/`master`, `v*` tags, or manual runs. Installers and `SHA256SUMS.txt` are retained as artifacts for 14 days; releases are not published automatically. The build reads repository metadata from GitHub without hardcoded repository URLs.

Optional Actions secrets:

| Purpose | Secrets |
| --- | --- |
| macOS signing | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows signing | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

Without signing secrets, CI produces unsigned installers. macOS microphone descriptions and audio-input entitlements are included.

# XiaoWang (小王同学)

[简体中文](README.md)

A desktop agent for research and everyday work. A foreground Realtime model handles voice conversations, while a background LLM handles longer research, reading, comparisons, and writing. Voice and text share persistent tasks, reference materials, and workspace history.

## Features

- **Realtime voice** with adapters for OpenAI, Qwen, and Doubao. Microphone and playback levels drive the waveform. Listening, responding, checking information, paused, and reconnecting states are shown separately.
- **Continuous walkthroughs** that wait for actual audio playback, retain their position across interruptions, and support pause, resume, and completion.
- **Background jobs** with persistent IDs, queued execution, results, output files, cancellation, retries, silent completion, and spoken notifications at an appropriate pause.
- **Research tools** for OpenAlex, arXiv, Crossref, and PubMed; PDF, Markdown, and text import; page-based reading and navigation. PDF extraction runs outside the main process and is cached.
- **Separate workspaces** with their own references, terminology, history, and files. The side pane displays documents, HTML presentations, and an embedded browser.
- **Streaming text** through OpenAI-compatible or Anthropic APIs. Stop requests propagate to the actual pending model request.

## Development

Requires **Node.js 24 or newer**, npm, and macOS, Windows, or Linux.

```sh
npm ci
npm run desktop
```

On first launch, configure the background model, API URL, and key, then choose a voice service, model, voice, and key. The voice and background models may use different providers.

```sh
npm run typecheck     # Check both core and desktop code
npm test             # Core, jobs, voice scheduling, and streaming tests
npm run build        # Production build
npm start            # Launch the built desktop app
npm run preview      # UI-only browser preview; no live agent
npm run test:desktop # Real desktop flow with isolated data and local model fixtures
```

On headless Linux:

```sh
xvfb-run --auto-servernum npm run test:desktop
```

Desktop tests use a synthetic microphone, mock model services, and temporary directories. Real model credentials are not required.

## Model and search configuration

The background agent supports OpenAI-compatible Chat Completions and Anthropic Messages APIs. If model discovery is unavailable, enter a model name directly. A connectivity check does not establish that every tool feature is supported.

Voice adapters handle provider-specific sample rates, session configuration, tool outputs, and response generation. OpenAI replies are scheduled by the client; Qwen and Doubao retain server-side voice activity detection. Providers may change models or protocols, so preview the selected voice and test a short call before relying on a service.

For Qwen workspace endpoints, enter the workspace ID or a full `wss://` URL in Settings. Existing Qwen 3.5 configurations can retain their default regional endpoint; consult the provider's regional access instructions.

Quick web search supports Brave and SearxNG and can be configured in Settings. Academic search and the embedded browser remain available without it. The CLI accepts:

| Variable | Purpose |
| --- | --- |
| `XIAOWANG_MODEL` | Background model name |
| `XIAOWANG_BASE_URL` | Background API base URL |
| `XIAOWANG_API_KEY` | Background model key |
| `XIAOWANG_API_STYLE` | `openai` or `anthropic`; omit for automatic detection |
| `XIAOWANG_SEARCH_PROVIDER` | `brave` or `searxng` |
| `XIAOWANG_SEARCH_KEY` | Web search key |
| `XIAOWANG_SEARCH_URL` | Custom search endpoint |
| `XIAOWANG_HOME` | Database, reference library, and workspace root |
| `XIAOWANG_USER_DATA` | Electron configuration directory, useful for isolated tests |
| `XIAOWANG_REALTIME_SERVICE` / `XIAOWANG_REALTIME_MODEL` / `XIAOWANG_REALTIME_KEY` | Desktop voice service, model, and key overrides |
| `XIAOWANG_REALTIME_URL` | Override the selected voice service endpoint for local services or testing |

The desktop app also accepts these environment settings. They take precedence in memory and do not rewrite saved credentials.

```sh
npm run xiaowang -- help
```

## Voice and background cooperation

`delegate_task` submits complex work and returns a persistent job ID. An accepted job is not a completed job. `get_task` retrieves its actual status. Use `notify=when_idle` for a short spoken completion notice, or `notify=silent` to update the task record only.

Jobs run sequentially within a workspace, with at most two workspaces executing concurrently. After a restart, queued jobs can continue. Previously running jobs are marked interrupted and require an explicit retry after reviewing existing output, avoiding automatic replay of writes.

A full walkthrough is a persistent presentation managed through `manage_presentation` with `start`, `pause`, `resume`, and `complete`. The UI also offers pause and resume buttons. Acknowledgments and questions preserve the task; explicit pause or stop changes its state. A segment limit prevents unbounded automatic generation.

## Data and credentials

- History and materials are stored in `~/.xiaowang/` by default; override with `XIAOWANG_HOME`.
- Model settings live in Electron's user-data directory. Keys use the operating system's secure storage when available. If encryption is unavailable, local-file storage is used; protect your user directory accordingly.
- Reference files are deduplicated by content. Each workspace can read only its referenced originals, and file tools stay inside the workspace.
- Documents, web pages, and tool outputs are treated as evidence, not replacement user instructions.
- Voice and relevant materials are sent to the model services you configure. Choose services whose data handling is appropriate for your research.

## Build installers

Build on the corresponding operating system:

```sh
npm run dist:mac -- --arm64 # Apple Silicon; use --x64 for Intel
npm run dist:win           # Windows x64 NSIS .exe
npm run dist:linux         # Linux x64 AppImage and .deb
```

Output is written to `release/`. `npm run pack` creates an unpacked application for inspection.

### GitHub Actions

No repository URL needs to be embedded in the build configuration. Once pushed to GitHub, `.github/workflows/desktop.yml` runs for:

- Pushes to `main` or `master`;
- `v*` tags;
- Manual runs through **Actions → Desktop installers → Run workflow**.

Pull requests run checks, tests, and a production build. After checks pass, branch pushes, tags, and manual runs package the app on three operating systems:

| Platform | Architecture | Installers |
| --- | --- | --- |
| macOS | Intel x64 and Apple Silicon arm64 | `.dmg`, `.zip` |
| Windows | x64 | NSIS `.exe` |
| Linux | x64 | `.AppImage`, `.deb` |

GitHub builds automatically use the current repository URL for installer metadata. For a local Linux `.deb`, first set `homepage` or `repository` in `package.json`, or set `GITHUB_REPOSITORY=owner/repository`.

Download packages from the run's **Artifacts** section. They are retained for 14 days and include platform-specific `SHA256SUMS.txt` files. The workflow does not automatically publish GitHub Releases or require model API keys.

### Optional signing

Without signing credentials, the workflow produces unsigned installers, which may trigger operating system security prompts. For public distribution, configure these repository Actions secrets:

| Platform | Secret |
| --- | --- |
| macOS signing | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows signing | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

`CSC_LINK` accepts certificate paths or encoded contents supported by electron-builder. macOS configuration includes the microphone usage description and audio-input entitlement. Keep certificates, passwords, and model keys out of the repository.

## Layout

```text
src/                  Agent core, history, model APIs, jobs, and research tools
desktop/main/         Electron, voice scheduling, display receipts, and browser
desktop/renderer/     React UI, audio, document reading, and activity feedback
desktop/scripts/      Development, production builds, and checksums
test/                 Core and protocol regression tests
e2e/                  Isolated real desktop tests
.github/workflows/    Validation and cross-platform packaging
```

PDF reading currently targets selectable text. OCR for scans, visual chart understanding, and recognition quality with real voice services require additional capabilities or provider support. Desktop tests validate the complete local fixture flow, not the behavior of a real hosted model.

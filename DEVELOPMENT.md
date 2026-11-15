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

## Realtime provider checks

Doubao Seeduplex uses its native ASR and TTS lifecycle. Audio deltas have no identifiers and are bound to the preceding `response.output_audio.started`; a cancel acknowledgement fences old audio before a new stream is admitted. `response.done` carries usage and must not be treated as OpenAI's generation-completion envelope. ASR completion uses `text`, and an ASR-start alone can be a recognizer reset rather than confirmed speech.

The dedicated `test/doubao.test.ts` and `e2e/doubao-native.test.mjs` fixtures reproduce those native events without injecting `response.created`. Continuous walkthroughs use real `continue_speaking` function outputs after playback drains. Native completion notices use `speech_text_buffer.commit`; inserting a user message into context is not used to trigger a spoken notice. Muting also switches the provider to its explicit input-mute mode.

For a real-service check, use an isolated workspace and fixed test speech. Verify actual renderer audio, recognition, tool execution and spoken continuation, not only captions or socket connectivity. Never log credentials or raw user audio. Playwright's default mock keychain cannot decrypt a user's real macOS settings; a real-account check must use normal app startup and a secure, isolated profile.

### MOSS Live

MOSS Live is suspended in v0.1.8 and hidden from normal Settings. Its adapter, voice catalog, profiles and tests remain in the repository. Startup selects another configured provider without reusing the MOSS key; when no other provider is configured it selects an unconfigured Qwen profile. Existing MOSS credentials remain stored in their own inactive profile. `XIAOWANG_ENABLE_MOSS=1` is an internal opt-in for retained development fixtures, not an advertised supported service. With this opt-in, select MOSS Live in Settings, enter a dedicated MOSS key and choose a voice. The stable model is `moss-live-1.0`; the endpoint is `wss://api.mosi.cn/v1/realtime` (note `mosi`, not `moss`). Authentication stays in the main-process WebSocket Authorization header. The renderer receives no key. The background text model remains independently configured.

The native adapter is `desktop/main/moss-call.ts`; `src/moss-realtime.ts` builds its session configuration. It reuses the existing JobQueue and tool permissions rather than installing another agent runtime. The [official API reference](https://platform.moss.cn/docs/reference/moss-live) defines the contract:

- Attach with session-isolated memory and client delegation. Wait for session, voice and media configuration receipts before enabling audio. Reconnect to the same remote session without restarting microphone capture or background work.
- Send mono 16 kHz PCM16 binary frames, including silence and input during speech. Negotiate mono 24 kHz PCM16 output and client playback receipts.
- Pair audio context identifiers with each binary chunk. Acknowledge only actual playback completion. Stop the matching reply and reject its late audio; interruption reports only the unfinished chunk's partial duration.
- Use native delegation as the only MOSS work-creation path. The legacy transcript heuristic and delegate tools stay available for other providers. Namespace source IDs by remote session and delegation, and preserve the actual local call as the job owner.
- Return progress silently and final results through commentary. Preserve full results and artifacts locally; lengthy results use a clearly marked excerpt directing the user to the call's full result. Retry pending commentary with the same event ID and payload, and stop the actual executor on cancellation. Manual job retries report through session-level commentary rather than reopening a terminal remote delegation.
- Foreground tools execute once per call ID. Resume the response only after the provider confirms its tool result. Shared browser ownership and workspace boundaries still apply.

MOSS implementation scope is voice, foreground tools, native background delegation, and result speech. Camera/screen streaming and user-scoped cloud memory are not enabled. If the original remote session cannot be restored, the call reports an error; durable jobs and saved results remain available for a new call.

`response.interrupted` allows missing run/turn identifiers. The adapter correlates a known stop first, then a known run or unique matching active reply. An ambiguous event does not invent an identity or end the socket.

Real-service checks on 2026-11-15 found that session-level `session.commentary.append` can emit a nonempty `run_id` but empty `turn_id` and repeated empty `chunk_id` values. Local playback uses separate node identities, plays every chunk, and never sends fabricated identities or empty IDs as MOSS playback receipts. User speech stops run-only local playback; a delayed timeout for an already completed run cannot stop a newer reply. Malformed audio events are isolated from the conversation, and incomplete streams are reported as failures rather than successful previews.

**Live-service limitation under investigation:** longer session-level commentary stopped after approximately two seconds of PCM and returned `playback_timeout`, before `response.audio.done`. This reproduced with client/server playback, and with default 48 kHz output. The local compatibility handling does not repair that upstream truncation. Normal voice turns and native delegation results carrying a real `delegation_id` completed with valid receipts. Do not treat passing offline fixtures or short audio as proof that longer proactive speech works.

Voice profiles in `src/settings.ts` isolate credentials and options by provider. Legacy single-key settings migrate to their original provider only. `mergeSettings` is pure for unsaved previews; disk saves use OS encryption when available and a same-directory atomic replacement. Renderer settings contain only credential hints. Blank keys retain their own saved profile; removal is explicit. All edited provider drafts participate in save/discard and unsaved-change protection, including inactive providers.

`desktop/main/moss-voices.ts` retrieves every page from `/v1/audio/voices`, deduplicates IDs, detects cursor loops, and caches successful catalogs per credential fingerprint. Failed refreshes do not overwrite cached data. `XIAOWANG_MOSS_VOICES_URL` is a loopback-only test override. Real keys remain in main; voice choices and names cross IPC. Dynamic MOSS voice IDs are preserved through settings normalization and call setup.

### Tests

```sh
npm run typecheck
npm test
npm run build
node --test --test-concurrency=1 --test-timeout=60000 e2e/*.test.mjs
```

`test/moss.test.ts` covers native protocol states, playback identities, ASR revisions, delegation deduplication/cancellation and reconnect replay. `e2e/moss-native.test.mjs` uses the real Electron renderer and audio player with isolated local WebSocket/model fixtures: microphone PCM, audible output, interruption, live task progress, actual source reading and note creation, foreground viewing, reconnect, spoken results and saved-call ownership. Existing Doubao/OpenAI/Qwen and task regressions remain in the full suite. Mock tests establish the application contract, not real-service latency or model quality; a live MOSS account check is still required for those measurements.

`e2e/moss-commentary.test.mjs` exercises the actual settings preview button and production player with the observed empty-ID format, multiple PCM chunks, proactive speech interruption, late timeouts and continued ordinary conversation. The opt-in `scripts/verify-moss-live.mjs` uses real MOSS Live, the production player and a durable controlled calculation executor. It must pass preview, consecutive proactive speech, native result feedback and a subsequent conversation; a failed check prevents a success report. Set `MOSS_TEST_QUESTION_WAV` and `MOSS_TEST_TASK_WAV` to harmless 16 kHz mono PCM16 WAV fixtures described in that script. Supply `MOSS_API_KEY` in memory or via stdin, never in a tracked file. The check creates and removes an isolated profile, does not use the user's microphone, and writes a credential-free report in the system temporary directory.

To refresh the README image from that actual desktop fixture:

```sh
XIAOWANG_DOC_SCREENSHOT="$PWD/assets/readme/voice-research.png" node --test e2e/moss-native.test.mjs
```

The sample PDF and generated notes contain no user material. No installers are generated by these checks. On headless Linux run desktop tests under Xvfb with an audio sink, as configured in the CI workflow.

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

Output goes to `release/`; `npm run pack` produces an unpacked app. The canonical upstream and update feed are `koabula/xiaowang`.

GitHub Actions runs checks on pull requests and builds installers after successful checks on pushes to `main`/`master`, `v*` tags, or manual runs. Installers, `latest*.yml` update manifests and `SHA256SUMS.txt` are retained as artifacts for 14 days. Pushing a `v*` tag matching `package.json` publishes a GitHub Release only after every platform succeeds; assets are uploaded to a draft before it becomes public. To publish a new version, bump the package and lockfile, commit, then push the matching tag (for example `v0.1.6`). Prereleases and downgrades are not offered to stable installs.

The app checks on packaged startup and every six hours. The circular download button beside Settings starts a verified download and restarts to install when calls, jobs and dirty settings are clear. `electron-updater` handles feed resolution and SHA-512 integrity. On macOS a helper prepares a same-volume replacement, validates bundle ID/version and retains the signing Team ID for signed installations; it waits for exit, replaces and relaunches the app, restoring the prior app if replacement or launch fails. Unsigned builds are supported without changing OS security settings. A read-only/translocated app must be moved to a writable Applications folder first. Normal installs retain their data; explicit `XIAOWANG_HOME` / `XIAOWANG_USER_DATA` overrides survive relaunch.

Isolated update fixtures use a loopback-only `XIAOWANG_UPDATE_TEST_FEED`. `XIAOWANG_DISABLE_UPDATES=1` disables automatic checks for offline testing. Neither option is exposed to renderer content or model tools.

Optional Actions secrets:

| Purpose | Secrets |
| --- | --- |
| macOS signing | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows signing | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

Without signing secrets, CI produces unsigned installers. macOS microphone descriptions and audio-input entitlements are included.

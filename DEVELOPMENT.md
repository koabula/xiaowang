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

### Gemini Live

Gemini 3.8 Live is available in Settings from v0.1.9, with its own saved provider profile and 30 prebuilt voices. `src/gemini-live.ts` implements its native protocol and `desktop/main/gemini-call.ts` integrates production call state, tools, transcripts and playback. It waits for setup acceptance, sends mono 16 kHz PCM16, processes every incoming audio part, and gives the production player 24 kHz PCM with call/turn identities. VAD activity controls speaking state; late ASR updates an existing transcript instead of restarting a completed goal. Interruption, pause and hangup stop the actual playback queue.

Resumption handles stay in memory. Reconnects keep the local call identity, microphone and durable jobs, reuse the last accepted remote handle, and deduplicate replayed tool calls. Recovery does not silently create a fresh remote session if the original cannot be restored. Audio spoken while disconnected is not buffered or replayed; the UI asks the user to repeat it. Accepted jobs survive hangup, and their records remain in their source call. A cancelled remote function-response channel does not cancel a durable local job. Terminal task responses return silently, and the app schedules an explicitly requested completion notice after playback drains. `notify=silent` stays silent.

Gemini has **no `continue_speaking` tool**. The application owns the walkthrough goal and cursor. It requests one page per response, advances only after generation and actual speaker playback finish, opens the next page through the normal `show_stage` executor/receipt path, and then requests the next segment. Questions resume the unfinished page; pause stops playback; the last played page completes the goal and fences late output. Model tool requests cannot advance pages early, restart an already completed goal, or hang up without explicit user intent. Existing providers keep their compatibility schedulers.

The full opt-in acceptance check uses real Gemini through the actual Electron main/renderer, macOS synthetic speech, an isolated profile and a controlled local background model that executes real file tools:

```sh
node --env-file=.env.gemini.local scripts/verify-gemini-production.mjs
```

Put `GEMINI_API_KEY` in that ignored local file with owner-only permissions, or provide it in the process environment. Never commit it. A local relay supplies the real key only to Google's upstream socket; Electron receives a dummy relay key. The script uses a silent synthetic microphone and injected test speech, removes temporary data, and writes a credential-free report in the system temporary directory. Failed reports may contain the known synthetic test transcript. It is excluded from offline CI and incurs account API usage. `GEMINI_CHECK_WALKTHROUGH_ONLY=1` narrows debugging to presentation and produces a `partial`, never `passed`, report. The lower-level `scripts/verify-gemini-live.mjs` remains a transport/player probe.

Real-service acceptance on 2026-11-15 passed speech recognition/playback, forced disconnection with remembered context, responsive background file work with spoken results, three-page Canvas narration with pause/silence/resume and playback-gated navigation, and a single call record with its owned job after a full app restart. The [Google Live API reference](https://aistudio.google.com/api-reference/live) and [asynchronous tool contract](https://aistudio.google.com/docs/live-api/tools) define the protocol. For development diagnostics, `XIAOWANG_GEMINI_DIAGNOSTICS=1` logs deduplicated state flags and counts, without keys, text, audio or remote handles.

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

To capture the desktop test fixture locally:

```sh
XIAOWANG_DOC_SCREENSHOT="${TMPDIR:-/tmp}/xiaowang-voice-research.png" node --test e2e/moss-native.test.mjs
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

GitHub Actions runs checks on pull requests and builds installers after successful checks on pushes to `main`/`master`, `v*` tags, or manual runs. Installers, `latest*.yml` update manifests and `SHA256SUMS.txt` are retained as artifacts for 14 days. Pushing a `v*` tag matching `package.json` publishes a GitHub Release only after every platform succeeds; assets are uploaded to a draft before it becomes public. After uploading, `desktop/scripts/release-notes.ts` reads the Release asset list and prepends a managed download table with version-specific links, preferring macOS DMG over ZIP and retaining the update description. Re-running it replaces the table in place. It can also update an existing Release with `node desktop/scripts/release-notes.ts <tag> <owner/repo>`. To publish a new version, bump the package and lockfile, commit, then push the matching tag (for example `v0.1.6`). Prereleases and downgrades are not offered to stable installs.

The app checks on packaged startup and every six hours. The circular download button beside Settings starts a verified download and restarts to install when calls, jobs and dirty settings are clear. `electron-updater` handles feed resolution and SHA-512 integrity. On macOS a helper prepares a same-volume replacement, validates bundle ID/version and retains the signing Team ID for signed installations; it waits for exit, replaces and relaunches the app, restoring the prior app if replacement or launch fails. Unsigned builds are supported without changing OS security settings. A read-only/translocated app must be moved to a writable Applications folder first. Normal installs retain their data; explicit `XIAOWANG_HOME` / `XIAOWANG_USER_DATA` overrides survive relaunch.

Isolated update fixtures use a loopback-only `XIAOWANG_UPDATE_TEST_FEED`. `XIAOWANG_DISABLE_UPDATES=1` disables automatic checks for offline testing. Neither option is exposed to renderer content or model tools.

Optional Actions secrets:

| Purpose | Secrets |
| --- | --- |
| macOS signing | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows signing | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |

Without signing secrets, macOS CI explicitly uses a complete ad-hoc signature (`identity: "-"`). Its separate entitlement file enables JIT, microphone input and disabled library validation while retaining hardened runtime. Certificate-backed builds use the original entitlements. Before uploading, macOS CI extracts both ZIPs, mounts both DMGs, verifies deep/strict signatures and sealed resources for both architectures, and launches the native architecture from each artifact with a fresh profile. It verifies the rendered settings screen, packaged version and post-launch signature. This integrity/startup check does not establish Apple developer trust or notarization; first Internet-downloaded launches may still require approval in Privacy & Security. Run it locally after `npm run dist:mac -- --x64 --arm64` with `XIAOWANG_MAC_RELEASE_DIR=release node --test e2e/mac-release.test.mjs`.

## Message attachments

The composer imports pasted images, dropped files and file-picker selections into the explicitly selected bot's library. IPC validates file content and enforces 8 files per message, 20 MB per file and 40 MB total. Message/job events retain local reference IDs, not base64. Attachment-only messages retain empty user text; a queue task label does not become invented chat text. Retries preserve the attachment references.

Before each model request, the harness loads referenced images into native OpenAI-compatible `image_url` or Anthropic `image` blocks. Documents retain explicit per-message reference IDs and use `read_document`. Missing image references are identified as unavailable rather than silently pretending the model saw them. Models without vision return an actionable error; failed drafts and attachments remain available to retry. Sub bot kickoffs do not inherit the parent's attachments.

`e2e/attachments.test.mjs` exercises the real OS clipboard, compares decoded pixels (clipboard PNG re-encoding is allowed), checks document/PDF tool output, both provider payloads, workspace isolation, error recovery, flat presentation and restart. For real Gemini voice hangup verification, use a private, ignored environment file:

```sh
GEMINI_CHECK_HANGUP_ONLY=1 GEMINI_TEST_REPORT=/tmp/xiaowang-gemini-hangup.json node --env-file=.env.gemini.local scripts/verify-gemini-production.mjs
```

This uses synthetic Chinese speech through the production audio IPC and Google API, waits for closure and stopped playback, and checks that ended calls do not reconnect. The key stays in the upstream relay and is not logged.

### Shared context and realtime vision (v0.1.11)

`SharedContexts` owns a scoped snapshot per bot: visible source/page, sent message attachment references, and recent job results. A separate `viewRevision` rejects late frames without invalidating a page whenever a job progresses. Snapshots persist references and bounded metadata only; image bytes and PDF frames never enter events. Restored views are hidden until the renderer confirms them. Jobs freeze their snapshot when accepted, retain the matching current-page frame in memory, and hydrate image references for the backend model. Context is inserted before the actual question, preserving the tool loop's message order. The narration cursor remains separate from the inspected view.

PDF.js renders the settled current page to an independent JPEG canvas (long side up to 1600 px), avoiding recycled viewer canvases and zoom-dependent screenshots. Capture is cancelled on source/page changes; main validates bot, source, page, revision and optional call ID. A display-tool receipt waits for capture, with a bounded failure rather than claiming unseen page content. Rendering still succeeds with providers without vision. `VisualQueue` limits wire frames to 1 fps, replaces queued old pages, deduplicates repeated receipts, replays the latest view on reconnect, and cancels pending sends at hangup. Imported drafts are not transmitted until sent or deliberately opened as a visible source.

Wire formats: Gemini `realtimeInput.video` JPEG frames and silent `clientContent.turnComplete=false` context, deferred during generation/playback; OpenAI passive `conversation.item.create` / `input_image`; Qwen `input_image_buffer.append` after the first audio append. Passive updates never call `response.create`. Qwen's audio/video buffers commit at its normal speech boundary. Sources: [Gemini capabilities](https://aistudio.google.com/docs/live-api/capabilities), [OpenAI conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Qwen realtime](https://help.aliyun.com/en/model-studio/realtime).

2026-11-15 verification: real Gemini 3.8 Live read an image-only word/number, two distinct PDF page images, and the current page after same-session resumption; passive navigation remained silent, and visual answers persisted in the call record. OpenAI/Qwen wire behavior, actual rendered pixels, backend sharing and workspace isolation are covered by deterministic desktop fixtures; no real OpenAI/Qwen credentials were available for this verification. A real Doubao direct session accepted setup but did not acknowledge the image-input probe. This is not proof of visual support, so its visual capability remains off; the separate RTC product is not treated as equivalent to the direct WebSocket protocol.

```sh
GEMINI_CHECK_VISION_ONLY=1 node --env-file=.env.gemini.local scripts/verify-gemini-production.mjs
node --test test/shared-context.test.ts test/gemini-call.test.ts test/realtime.test.ts
node --test e2e/visual-context.test.mjs
```

The visual acceptance check uses an isolated profile, synthetic macOS speech and a local relay that holds the real key outside the renderer. It records only results and transcripts in a temporary report. `.env.*` files remain ignored.

### Event-based context projection

The backend uses `ContextManager` and the pure functions in `src/event-projection.ts`. Context maintenance performs no LLM inference. Canonical `context_scope` and `context_state` events capture fixed instructions/tools/budgets and accepted application snapshots. Derived `context_append` / `context_checkpoint` manifests store projector version, exact source event IDs, rendering mode, state references, protected inputs and a source watermark. Bump `PROJECTOR_VERSION` when changing rendering or selection semantics.

Within an epoch, messages append without rewriting the prefix. Above the configured input high watermark, deterministic selection targets the low watermark: retain active input IDs, latest state per key and the last conversation unit; remove superseded states, fold old tool outputs to a fixed 1,200-character excerpt, then archive completed jobs before other older units. Large old tool argument units may become references. Native thinking/signature units remain intact or become whole-unit references; they are never partially excerpted. Checkpoints commit only after the final request fits the hard budget and becomes smaller; cancellation and oversized required input retain the prior view. There is no summary prompt, summary output reservation or hidden summary request.

`search_memory` uses a rebuildable FTS5 trigram index of original records, with a short-query literal fallback. `inspect_event` pages original text by event ID and character offset. Both restrict access to the active bot and exclude internal manifests/usage. New tool results link to `assistantEventId`; local invocation IDs do not rely on vendor IDs being globally unique. Old logs associate duplicate IDs chronologically.

Backend text chat, sub bots and voice-delegated tasks share automatic budgets. The target is 131072 total / 8192 output including thinking / 4096 safety; input high 98304 and low 32768. Before each task, resolve /models metadata with a five-minute cache isolated by endpoint, model and credential. Metadata caps total, input and output separately. On the default Ollama port 11434, /api/ps reports the loaded deployment context. Verified official GPT-4.1 / GPT-4o, DeepSeek Flash / V4 Pro and Claude 5.5 / Fable 5.2 limits provide a fallback; unknown deployments use 32768. Output is at most a quarter of the window, safety at most a sixteenth; high is min(98304, floor(input capacity * .85)); low is 32768 when high exceeds it, otherwise floor(high * .55). Legacy saved budgets and budget environment variables are ignored. Gemini Live targets 32768 -> 16384 sliding history. OpenAI uses retention .5 and a post-instructions limit calculated after reserving output and estimating instructions/tools. Doubao/Qwen keep provider-managed audio history; bounded application briefs do not guarantee a server-side 32K cap. Projection remains deterministic and creates no LLM summary calls.

Local `o200k_base` estimates include a 20% margin and envelope costs. Replay data participates in input counting, including thinking; output reserves cover thinking plus answer. Official Anthropic native counting replaces total input. Provider-reported usage and cache reads/writes remain separate from estimates. `reasoningTokens`, when reported, is a subset of output, not an additional total. `npm run xiaowang -- stats [slug]` reports totals; absent actual usage is `null`. Disable optional cache fields with `XIAOWANG_PROMPT_CACHE=off`.

Projector version 2 preserves model-protocol data separately in `assistant_turn.protocol`: OpenAI-compatible `reasoning_content` / `reasoning_details`, or complete Anthropic content blocks with signed/redacted thinking. SSE merges ordered fragments. Tool invocations keep local IDs for event ownership and original vendor IDs/arguments for replay. Matching endpoint/model protocol is replayed verbatim; legacy DeepSeek turns missing required reasoning, foreign protocol groups and output-limited records become labelled historical data without invented traces or tool reexecution. Thinking is excluded from chat text and model-facing history search/inspection. Version 1 manifests stay in the log; version 2 rebuilds from canonical events. Output `length` / `max_tokens` records partial content/protocol and usage, reports a failure and does not execute incomplete calls. See `test/thinking-protocol.test.ts`, `test/research-budget.test.ts` and `e2e/research-budget.test.mjs`.

Request hashes link usage to the scoped request. Attachment bytes hydrate from original library references; transient page pixels are never written into events, so exact visual replay after restart requires recapturing the page. Bot metadata and file-reference tables remain separate application state; the new manifests do not imply full application-wide event sourcing or side-effect rollback.

```bash
node --test test/context-manager.test.ts test/context-provider.test.ts test/memory.test.ts test/task-supplements.test.ts
node --test --test-concurrency=1 e2e/attachments.test.mjs e2e/task-supplements.test.mjs e2e/visual-context.test.mjs e2e/voice-research.test.mjs
```

The interactive technical document is `technical/index.html`, with its text counterpart in `technical/README.md`. Static PNG/SVG assets must be regenerated from `window.xiaowangTechnical.image(id, format)` after diagram changes.

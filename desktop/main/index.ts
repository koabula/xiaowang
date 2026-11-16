import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, protocol, session, shell } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configurePagePermissions, isAppPage, protectAppWindow } from "./page-policy.ts";
import { backgroundTest, testWindowOptions } from "./test-mode.ts";
import { UpdateController } from "./update-state.ts";
import { createUpdateEngine } from "./updates.ts";
import { LiveCall, type InterruptionReceipt, type PlaybackPosition, type VoiceState } from "./call.ts";
import { MossCall, type MossHandlers } from "./moss-call.ts";
import { mossSession } from "../../src/moss-realtime.ts";
import { JobQueue, type JobOutput } from "../../src/jobs.ts";
import { VoiceTasks, voiceJobReceipt } from "../../src/voice-tasks.ts";
import { taskTurnOwners, visibleAnswerIds, presentJob } from "../../src/task-presentation.ts";
import { StageRequests } from "./stage.ts";
import type { Attachment, TaskJob } from "../../src/types.ts";
import type { PresentationState } from "../../src/presentation.ts";
import { runTurn } from "../../src/harness.ts";
import { attachmentMime, resolveAttachments, ATTACHMENT_BYTES } from "../../src/attachments.ts";
import { messagePreview } from "../../src/message-preview.ts";
import { formatVoiceBrief, projectVoiceBrief } from "../../src/project.ts";
import { checkModel, configFromEnv, createProvider, listModels } from "../../src/provider.ts";
import { localeOf } from "../../src/locale.ts";
import { keyForService, realtimeKeyPage, resolveRealtime } from "../../src/realtime-catalog.ts";
import { PREVIEW_LINE, askTextResult, doubaoSession, realtimeEndpoint, realtimeInstructions, sessionUpdate, socketUrl, voiceTools } from "../../src/realtime.ts";
import { Runtime } from "../../src/runtime.ts";
import { resolveHome } from "../../src/store.ts";
import { executeTool, toolSchemas } from "../../src/tools.ts";
import type { BrowserDriver, StageView } from "../../src/stage.ts";
import { CANVAS_HTML_CAP, assertHttpUrl } from "../../src/stage.ts";
import type { Channel, SessionEvent } from "../../src/types.ts";
import { listCanvasPages, resolveInsideWorkspace } from "../../src/workspace.ts";
import { browseBotFiles, type BrowseOptions } from "../../src/file-browser.ts";
import { filePreview } from "../../src/file-preview.ts";
import { BotBrowsers } from "./browser.ts";
import { loadSecrets, mergeSecrets, publicSettings, type SecretPatch, type SecretRecord } from "./secrets.ts";
import { availableRealtimeSettings, mergeSettings, settingsPatchForSave, contextEnvironment } from "../../src/settings.ts";
import { MossVoiceCatalog } from "./moss-voices.ts";
import { GeminiCall } from "./gemini-call.ts";
import { geminiSession } from "../../src/gemini-session.ts";

import { SharedContexts, contextDescription, type WorkspaceContext, type VisualInput } from "../../src/shared-context.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "xwlib",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.env.XIAOWANG_USER_DATA) {
  const directory = path.resolve(process.env.XIAOWANG_USER_DATA);
  mkdirSync(directory, { recursive: true });
  app.setPath("userData", directory);
}
const devUrl = process.env.XIAOWANG_DESKTOP_URL ?? "";
const appPage = devUrl || pathToFileURL(path.join(here, "renderer/index.html")).href;
// Acquire before opening the store: a second process must not restore or run jobs.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

let runtime: Runtime;
let window: BrowserWindow | null = null;
let settingsDirty = false;
let updates: UpdateController;
let updateTimers: Array<ReturnType<typeof setInterval>> = [];
let updateChecksStarted = false;
let updateNotice = "";
const mossVoices = new MossVoiceCatalog();
const experimentalMossEnabled = process.env.XIAOWANG_ENABLE_MOSS === "1";
const geminiEnabled = true;
function settingsView() { return { ...publicSettings(secrets, savedSecrets), experimentalMossEnabled, geminiEnabled }; }
function assertRealtimeAvailable(service: string): void {
  if (service === "moss" && !experimentalMossEnabled) throw new Error("MOSS Live 支持已暂时停用，请选择其他语音服务。");
}
function realtimeUrlOverride(): string {
  const url = process.env.XIAOWANG_REALTIME_URL?.trim() ?? "";
  return !experimentalMossEnabled && /api\.mosi\.cn/i.test(url) ? "" : url;
}

function canInstallUpdate(): boolean {
  return updateWaitReasons().length === 0;
}
function updateWaitReasons(): string[] {
  return [...(settingsDirty ? ["settings"] : []), ...(live ? ["call"] : []), ...((jobs?.list() ?? []).some(job => job.status === "queued" || job.status === "running") ? ["jobs"] : [])];
}
function startUpdateChecks(): void {
  if (updateChecksStarted || process.env.XIAOWANG_DISABLE_UPDATES === "1" || (!app.isPackaged && !process.env.XIAOWANG_UPDATE_TEST_FEED)) return;
  updateChecksStarted = true;
  void updates.check();
  updateTimers = [setInterval(() => void updates.check(), 6 * 60 * 60 * 1000), setInterval(() => void updates.installWhenIdle(), 2000)];
  for (const timer of updateTimers) timer.unref();
}
let browser: BotBrowsers;
let secrets: SecretRecord = {
  model: "",
  baseUrl: "",
  apiStyle: "",
  apiKey: "",
  realtimeModel: "",
  realtimeUrl: "",
  realtimeKey: "",
  realtimeService: "",
  realtimeVoice: "",
  realtimeRegion: "",
  realtimeWorkspace: "",
  locale: "zh",
};
let savedSecrets = secrets;

interface ChatItem {
  attachments?: Attachment[];
  jobId?: string;
  callId?: string;
  id: number;
  kind: "user" | "assistant" | "tool" | "file" | "note" | "call";
  text: string;
  name?: string;
  isError?: boolean;
  lines?: Array<{ who: "user" | "assistant"; text: string }>;
  seconds?: number;
}

interface BotRow {
  id: string;
  slug: string;
  name: string;
  preview: string;
  avatarSeed: string;
  avatarInk: string;
}

function send(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload);
}

function importAttachment(slug: string, filename: string, data: Uint8Array): Attachment {
  const bot = runtime.store.requireBot(slug);
  if (!(data instanceof Uint8Array) || data.length > ATTACHMENT_BYTES || typeof filename !== "string" || filename.length > 255) throw new Error("附件无效或超过 20 MB。");
  const bytes = Buffer.from(data), name = path.basename(filename.replaceAll("\\", "/"));
  const mimeType = attachmentMime(name, bytes);
  if (mimeType.startsWith("image/") && nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error("无法读取这张图片，请更换为有效的图片文件。");
  const suffix: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
  const savedName = mimeType.startsWith("image/") && !/\.(png|jpe?g|gif|webp)$/i.test(name) ? name + suffix[mimeType] : name;
  const { ref } = runtime.store.addLibraryBytes(bot.id, savedName, bytes);
  publish();
  return { refId: ref.id, filename: ref.filename, byteSize: ref.byteSize, mimeType };
}

function previewOf(botId: string): string {
  const event = runtime.store.latestMessage(botId)?.event;
  if (event?.type === "user_text" || event?.type === "assistant_turn")
    return messagePreview(event.text) || (event.type === "user_text" && event.attachments?.length ? event.attachments.map(a => a.filename).join("、") : "还没有对话");
  return "还没有对话";
}

function botRows(): BotRow[] {
  return runtime.store.listBots().map((bot) => ({
    id: bot.id,
    slug: bot.slug,
    name: bot.name,
    preview: previewOf(bot.id),
    avatarSeed: bot.avatarSeed,
    avatarInk: bot.avatarInk,
  }));
}

function chatItems(slug: string): ChatItem[] {
  const bot = runtime.store.requireBot(slug);
  const events = runtime.store.getEvents(bot.id);
  const shownJobs = (jobs?.list(bot.id) ?? []).map(job => presentJob(job, events));
  const owners = taskTurnOwners(shownJobs, events);
  const answers = visibleAnswerIds(shownJobs, events, owners);
  const items: ChatItem[] = [];
  for (const stored of events) {
    if (stored.event.type === "assistant_turn" && !answers.has(stored.id)) continue;
    const item = present(stored.id, stored.event);
    if (item) items.push({ ...item, jobId: item.jobId ?? owners.get(stored.id) });
  }
  return items;
}

function present(id: number, event: SessionEvent): ChatItem | null {
  if (event.type === "user_text" && event.channel === "text") {
    return { id, kind: "user", text: event.text, jobId: event.jobId, attachments: event.attachments };
  }
  if (event.type === "assistant_turn" && event.text.trim()) {
    return { id, kind: "assistant", text: event.text, jobId: event.jobId };
  }
  if (event.type === "call" && event.lines.some((line) => line.text.trim())) {
    const elapsed = Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000);
    return {
      id,
      kind: "call",
      callId: event.callId || `legacy-call:${id}`,
      text: event.lines.map((line) => line.text).join("\n"),
      lines: event.lines,
      seconds: Number.isFinite(elapsed) ? Math.max(1, elapsed) : 1,
    };
  }
  if (event.type === "tool_result") {
    return {
      id,
      kind: "tool",
      name: event.name,
      text: event.output.replace(/\s+/g, " ").trim().slice(0, 180),
      isError: event.isError,
    };
  }
  if (event.type === "artifact") return { id, kind: "file", text: event.path };
  if (event.type === "baseline") return { id, kind: "note", text: event.text };
  return null;
}

function publish(): void {
  const active = runtime.activeBot();
  send("state", { version: app.getVersion(), update: updates?.snapshot(), bots: botRows(), activeSlug: active.slug, settings: settingsView(), jobs: publicJobs() });
}

function publicJobs(): TaskJob[] {
  const events = new Map<string, ReturnType<typeof runtime.store.getEvents>>();
  return (jobs?.list() ?? []).map(job => {
    if (job.display && job.title) return job;
    if (!events.has(job.botId)) events.set(job.botId, runtime.store.getEvents(job.botId));
    return presentJob(job, events.get(job.botId)!);
  });
}

function envFromSecrets(): NodeJS.ProcessEnv {
  return envFromRecord(secrets);
}

function envFromRecord(record: SecretRecord): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(["XIAOWANG_CONTEXT_WINDOW", "XIAOWANG_MAX_OUTPUT_TOKENS", "XIAOWANG_CONTEXT_SAFETY_TOKENS", "XIAOWANG_IMAGE_TOKEN_BUDGET", "XIAOWANG_PROMPT_CACHE"].map(key => [key, process.env[key]])),
    ...contextEnvironment(record, process.env),
    XIAOWANG_MODEL: record.model,
    XIAOWANG_BASE_URL: record.baseUrl,
    XIAOWANG_API_STYLE: record.apiStyle,
    XIAOWANG_API_KEY: record.apiKey,
  };
}

function draftSecrets(patch: SecretPatch): SecretRecord {
  return mergeSettings(secrets, { ...patch, model: patch.model?.trim() || secrets.model });
}

function libraryOf(slug: string) {
  const bot = runtime.store.requireBot(slug);
  return runtime.store.listLibrary(bot.id).map((ref) => ({
    id: ref.id,
    filename: ref.filename,
    byteSize: ref.byteSize,
  }));
}

let jobs: JobQueue;
let live: LiveCall | MossCall | GeminiCall | null = null;
let liveSlug = "";
let liveState: VoiceState | null = null;
const stages = new StageRequests(note => send("stage", note));
const shared = new SharedContexts();
const jobFrames = new Map<string, VisualInput>();
const viewFrames = new Map<string, VisualInput>();
function contextChanged(botId: string, state: WorkspaceContext): void {
  runtime.store.append(botId, { type: "workspace_context", state });
  if (live && liveSlug === runtime.store.requireBot(botId).slug) live.updateContext("workspace", contextDescription(state));
}
function visualCall(slug: string): LiveCall | GeminiCall | null { return liveSlug === slug && (live instanceof LiveCall || live instanceof GeminiCall) ? live : null; }
function jpegFrame(bytes: Buffer): string {
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("无法读取共享画面。");
  const size = image.getSize(); const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
  if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
  return image.toJPEG(85).toString("base64");
}
function shareMessageImages(slug: string, state: WorkspaceContext): void {
  const call = visualCall(slug); if (!call) return;
  const bot = runtime.store.requireBot(slug);
  const images: VisualInput[] = [];
  for (const attachment of state.imageAttachments ?? state.message?.attachments ?? []) {
    if (!attachment.mimeType.startsWith("image/")) continue;
    try { const ref = runtime.store.resolveLibraryRef(bot.id, attachment.refId); images.push({ key: `message:${attachment.refId}`, refId: ref.id, filename: ref.filename, page: 1, revision: state.revision, mimeType: "image/jpeg", data: jpegFrame(readFileSync(ref.storedPath)) }); }
    catch { send("call", { slug, callId: call.id, phase: "visual", visual: { phase: "error", source: attachment.filename, detail: "图片已不可用，未共享画面。" } }); }
  }
  if (images.length) void call.shareVisual(images);
}
const focusedFiles = new Map<string, string>();

async function ask(job: TaskJob, signal: AbortSignal, activity: (text: string) => void): Promise<JobOutput> {
  const bot = runtime.store.requireBot(job.botId);
  const before = runtime.store.getEvents(bot.id).at(-1)?.id ?? 0;
  const provider = createProvider(configFromEnv(envFromSecrets()));
  let resultEventId: number | undefined;
  const result = await runTurn(runtime, {
    botId: bot.id, input: job.task, messageText: job.messageText, attachments: job.attachments, sharedContext: job.sharedContext, sharedImages: jobFrames.has(job.id) ? [{ mimeType: "image/jpeg", data: jobFrames.get(job.id)!.data }] : undefined, channel: job.channel, provider,
    jobId: job.id, inputEventId: job.originEventId,
    excludeJobIds: jobs.list(bot.id).filter(other => other.id !== job.id && other.status === "queued").map(other => other.id),
    readUpdates: () => ({
      ...jobs.updates(job.id),
      sharedImages: jobFrames.has(job.id) ? [{ mimeType: "image/jpeg", data: jobFrames.get(job.id)!.data }] : undefined,
    }),
    onInput: id => jobs.linkInput(job.id, id),
    env: envFromSecrets(), locale: localeOf(secrets.locale), signal,
    browser: browserFor(bot.slug),
    stage: { show: view => stages.show(bot.slug, view) },
    onKickoff: kickoff => { jobs.enqueue({ botId: kickoff.botId, task: kickoff.task, channel: "system", display: "conversation" }); },
    onTextDelta(current, text) { send("delta", { slug: current.slug, jobId: job.id, text }); },
    onStep(step) {
      if (step.final) resultEventId = step.eventId;
      if (step.activity) activity(step.activity);
      send("step", { slug: step.bot.slug, jobId: job.id, kind: step.kind, name: step.name ?? "", text: step.text, isError: Boolean(step.isError), activity: step.activity ?? "" });
    },
  });
  if (result.steps >= 40 && runtime.store.getEvents(bot.id).at(-1)?.event.type === "tool_result") throw new Error("本轮达到处理步数上限。已有结果已保存，可拆小任务后继续。");
  const artifacts = runtime.store.getEvents(bot.id, { afterId: before }).flatMap(({ event }) => event.type === "artifact" ? [event.path] : []);
  if (!result.finalText.trim() && !artifacts.length) throw new Error("模型没有返回可用结果，请重试。");
  return { text: result.finalText, artifacts, resultEventId };
}

function jobChanged(job: TaskJob): void {
  const bot = runtime.store.requireBot(job.botId);
  if (job.status === "queued" || job.supplementEventIds?.length) {
    const frame = viewFrames.get(bot.slug), view = job.sharedContext?.view;
    if (frame && view?.visible && view.path === frame.refId && view.page === frame.page && job.sharedContext?.viewRevision === frame.revision) jobFrames.set(job.id, frame);
    else jobFrames.delete(job.id);
  }
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) jobFrames.delete(job.id);
  contextChanged(bot.id, shared.job(bot.id, job));
  const busy = jobs?.busy(job.botId) ?? job.status === "running";
  const shown = job.display && job.title ? job : presentJob(job, runtime.store.getEvents(bot.id));
  send("job", { ...shown, slug: bot.slug });
  send("turn", { slug: bot.slug, busy, error: job.status === "failed" ? job.error : "" });
  publish();
  if (live && liveSlug === bot.slug) {
    if (live instanceof MossCall || live instanceof GeminiCall) { live.jobChanged(job); return; }
    live.updateContext(`job:${job.id}`, JSON.stringify({ id: job.id, task: job.task.slice(0, 400), status: job.status, activity: job.activity, error: job.error, artifacts: job.artifacts }));
    const latestVoice = jobs.list(bot.id).filter(item => item.channel === "voice").at(-1);
    if (latestVoice) live.updateContext("currentVoiceTask", voiceJobReceipt(latestVoice));
    if (job.notify === "when_idle" && (job.status === "succeeded" || job.status === "failed")) {
      live.notify(`${job.id}:${job.attempts}:${job.status}`, JSON.stringify({ id: job.id, task: job.task.slice(0, 300), status: job.status, result: job.result.slice(0, 1800), error: job.error, artifacts: job.artifacts }));
    }
  }
}

function handoffText(task: string, lines: Array<{ who: "user" | "assistant"; text: string }>, person: string, locale: ReturnType<typeof localeOf>): string {
  const heard = lines
    .slice(-8)
    .filter((line) => line.text.trim())
    .map((line) => {
      const who = line.who === "user" ? (locale === "en" ? "User" : "用户") : person;
      return locale === "en" ? `${who}: ${line.text.trim()}` : `${who}：${line.text.trim()}`;
    })
    .join("\n");
  if (!heard) return task;
  return locale === "en" ? `${task}\n\nJust now on the call:\n${heard}` : `${task}\n\n刚才的通话：\n${heard}`;
}

function taskArgument(args: string): string {
  try {
    const input = JSON.parse(args) as { task?: unknown };
    return typeof input.task === "string" ? input.task.trim() : "";
  } catch {
    return "";
  }
}

function browserFor(slug: string): BrowserDriver {
  runtime.store.requireBot(slug);
  // Merely starting a text turn must not allocate a Chromium page.
  const driver = () => browser.forBot(slug).driver;
  return {
    holder: () => browser.viewState(slug).holder,
    navigate: url => driver().navigate(url), snapshot: () => driver().snapshot(),
    click: target => driver().click(target), type: (target, text) => driver().type(target, text),
    scroll: direction => driver().scroll(direction), back: () => driver().back(),
  };
}

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame.url, appPage)) {
      throw new Error("此操作只能从小王应用窗口发起。");
    }
    return listener(event, ...args);
  });
  handle("state:get", () => {
    // Start only after a renderer is mounted, independently of the first
    // navigation promise (a reload can abort that promise).
    jobs.start();
    startUpdateChecks();
    return {
    version: app.getVersion(), update: updates.snapshot(), updateNotice,
    bots: botRows(),
    activeSlug: runtime.activeBot().slug,
    settings: settingsView(), jobs: publicJobs(),
    call: live ? { slug: liveSlug, state: liveState } : null,
    browser: browser.viewState(runtime.activeBot().slug),
    };
  });
  handle("update:check", async () => {
    await updates.check(true); return updates.snapshot();
  });
  handle("update:download", async () => {
    await updates.update(); return updates.snapshot();
  });
  handle("bot:active", (_event, slug: string) => {
    runtime.store.setActiveBot(runtime.store.requireBot(slug).id);
    browser.activate(slug);
    publish();
  });
  handle("bot:create", (_event, name: string, baseline: string) => {
    const parent = runtime.activeBot();
    const bot = runtime.store.createBot({
      name,
      systemPrompt: baseline || `${name}的任务。`,
      parentBotId: parent.id,
    });
    runtime.store.append(bot.id, { type: "baseline", text: baseline || `${name}的任务。`, fromBotId: parent.id });
    runtime.store.setActiveBot(bot.id);
    browser.activate(bot.slug);
    publish();
    return bot.slug;
  });
  handle("bot:rename", (_event, slug: string, name: string) => {
    runtime.store.renameBot(slug, name);
    publish();
  });
  handle("bot:delete", async (event, slug: string) => {
    const bot = runtime.store.requireBot(slug);
    if (bot.slug === "xiaowang") throw new Error("不能删除主助手。");
    if (liveSlug === slug) live?.hangup();
    // Let aborted tools finish their cleanup before revoking their workspace.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([jobs.prepareBotDeletion(bot.id), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("任务正在停止，请稍后重试删除。")), 10_000); })]);
    } finally { clearTimeout(timer); }
    await browser.clearBot(slug);
    runtime.store.deleteBot(bot.id);
    browser.activate(runtime.activeBot().slug);
    jobs.forgetBot(bot.id);
    focusedFiles.delete(slug); viewFrames.delete(slug); shared.forget(bot.id);
    publish();
  });
  handle("bot:avatar", (_event, slug: string, patch: { seed?: string; ink?: string }) => {
    runtime.store.setAvatar(slug, patch ?? {});
    publish();
  });
  handle("library:forget", (_event, slug: string, id: string) => {
    const bot = runtime.store.requireBot(slug);
    runtime.store.forgetLibraryRef(bot.id, id);
    if (shared.get(bot.id).view?.path === id) { viewFrames.delete(slug); visualCall(slug)?.clearVisual(); }
    visualCall(slug)?.forgetVisual(id); contextChanged(bot.id, shared.revoke(bot.id, id));
    publish();
  });
  handle("chat:events", (_event, slug: string) => chatItems(slug));
  handle("library:list", (_event, slug: string) => libraryOf(slug));
  handle("workspace:browse", (_event, slug: string, options: BrowseOptions) => {
    const bot = runtime.store.requireBot(slug);
    if (!options || !["all", "library", "workspace"].includes(options.source)) throw new Error("无效的资料位置。");
    return browseBotFiles(bot.workspaceDir, runtime.store.listLibrary(bot.id), options);
  });
  handle("library:openReference", (_event, slug: string, id: string, page: number) => {
    const bot = runtime.store.requireBot(slug);
    const ref = runtime.store.resolveLibraryRef(bot.id, id);
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("无效的来源页码。");
    if (/\.html?$/i.test(ref.filename)) {
      const html = readFileSync(ref.storedPath, "utf8");
      if (Buffer.byteLength(html) > CANVAS_HTML_CAP) throw new Error("这份页面过大。");
      send("stage", { slug, mode: "canvas", title: `library:${ref.id}/${ref.filename}`, html, page });
      return;
    }
    send("stage", { slug, mode: "file", id: ref.id, filename: ref.filename, page });
  });
  handle("link:open", (_event, url: string) => {
    const checked = assertHttpUrl(url);
    if (typeof checked !== "string") throw new Error(checked.error);
    return shell.openExternal(checked);
  });
  handle("library:text", (_event, slug: string, id: string) => {
    const bot = runtime.store.requireBot(slug);
    const ref = runtime.store.resolveLibraryRef(bot.id, id);
    return readFileSync(ref.storedPath);
  });
  handle("workspace:pages", (_event, slug: string) => {
    const bot = runtime.store.requireBot(slug);
    return listCanvasPages(bot.workspaceDir);
  });
  handle("workspace:openArtifact", (_event, slug: string, rel: string) => {
    const bot = runtime.store.requireBot(slug);
    const resolved = resolveInsideWorkspace(bot.workspaceDir, rel);
    if (!resolved.ok) throw new Error(resolved.error);
    if (filePreview(resolved.rel) === "canvas") {
      const html = readFileSync(resolved.abs, "utf8");
      if (Buffer.byteLength(html) > CANVAS_HTML_CAP) throw new Error("这份页面过大。");
      send("stage", { slug, mode: "canvas", title: resolved.rel, html, page: 1 });
    } else {
      if (filePreview(resolved.rel) !== "file") throw new Error("暂时不能预览这种文件。");
      const result = runtime.store.addLibraryBytes(bot.id, path.basename(resolved.rel), readFileSync(resolved.abs));
      send("stage", { slug, mode: "file", id: result.ref.id, filename: result.ref.filename, page: 1, restore: true });
    }
    publish();
  });
  handle("workspace:openPage", (_event, slug: string, rel: string, page = 1) => {
    const bot = runtime.store.requireBot(slug);
    const resolved = resolveInsideWorkspace(bot.workspaceDir, typeof rel === "string" ? rel : "");
    if (!resolved.ok) throw new Error(resolved.error);
    if (!/\.html?$/i.test(resolved.rel)) throw new Error("Canvas 需要一份 .html 文件。");
    const html = readFileSync(resolved.abs, "utf8");
    if (Buffer.byteLength(html, "utf8") > CANVAS_HTML_CAP) throw new Error("这份 HTML 太大，右栏放不下。");
    const view = { mode: "canvas" as const, title: resolved.rel, html, page: Math.max(1, Number(page) || 1) };
    send("stage", { slug: bot.slug, ...view });
    return view;
  });
  handle("library:add", async () => {
    if (!window) return;
    const picked = await dialog.showOpenDialog(window, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文档", extensions: ["pdf", "txt", "md", "markdown"] }],
    });
    if (picked.canceled) return;
    const bot = runtime.activeBot();
    for (const file of picked.filePaths) {
      runtime.store.addLibraryBytes(bot.id, path.basename(file), readFileSync(file));
    }
    publish();
  });
  handle("chat:attach", (_event, slug: string, filename: string, data: Uint8Array) => importAttachment(slug, filename, data));
  handle("chat:pasteImage", async (_event, slug: string) => {
    runtime.store.requireBot(slug);
    for (const item of await clipboard.read()) {
      const mimeType = item.types.find(type => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type));
      if (!mimeType) continue;
      const image = await item.getType(mimeType);
      if (!("arrayBuffer" in image) || image.size > ATTACHMENT_BYTES) throw new Error("图片无效或超过 20 MB。");
      return importAttachment(slug, `image.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}`, new Uint8Array(await image.arrayBuffer()));
    }
    return null;
  });
  handle("chat:ask", async (_event, slug: string, text: string, ids: string[] = [], queueNew = false) => {
    const bot = runtime.store.requireBot(slug);
    if (typeof text !== "string") throw new Error("消息格式无效。");
    const attachments = resolveAttachments(runtime.store, bot.id, ids);
    const task = text.trim() || (attachments.length ? "请查看这些附件。" : "");
    const snapshot = shared.message(bot.id, text.trim(), attachments);
    contextChanged(bot.id, snapshot); shareMessageImages(slug, snapshot);
    const ongoing = queueNew ? undefined : jobs.active(bot.id);
    const job = jobs.submit({ botId: bot.id, task, messageText: text.trim(), attachments, sharedContext: snapshot, channel: "text" }, queueNew === true);
    if (ongoing?.id === job.id) return chatItems(slug);
    const result = await jobs.wait(job.id);
    if (result.status === "failed") throw new Error(result.error);
    return chatItems(slug);
  });
  handle("chat:stop", (_event, slug: string) => {
    const bot = runtime.store.requireBot(slug);
    for (const job of jobs.list(bot.id)) if (job.status === "running") jobs.cancel(job.id);
  });
  handle("job:cancel", (_event, id: string) => jobs.cancel(id));
  handle("job:retry", (_event, id: string) => jobs.retry(id));
  handle("stage:ack", (_event, slug: string, requestId: string, receipt: { page: number; totalPages: number; title?: string; error?: string }) => stages.acknowledge(slug, requestId, receipt));
  handle("stage:position", (_event, slug: string, position: { path: string; page: number; totalPages: number; mode: "canvas" | "file" }) => {
    const bot = runtime.store.getBot(slug);
    if (!bot || runtime.activeBot().id !== bot.id) return -1;
    if (!["canvas", "file"].includes(position.mode) || typeof position.path !== "string") return -1;
    if (!Number.isSafeInteger(position.page) || !Number.isSafeInteger(position.totalPages) || position.page < 1 || position.page > position.totalPages) return -1;
    const ref = position.mode === "file" ? runtime.store.resolveLibraryRef(bot.id, position.path) : null;
    const before = shared.get(bot.id);
    const snapshot = shared.view(bot.id, { ...position, filename: ref?.filename ?? position.path, visible: true });
    if (snapshot.revision !== before.revision) {
      viewFrames.delete(slug); visualCall(slug)?.clearVisual(); contextChanged(bot.id, snapshot);
    }
    if (ref) focusedFiles.set(slug, ref.id);
    if (liveSlug === slug) live?.locate(position.path, position.page, position.totalPages, position.mode);
    if (ref && /\.(png|jpe?g|webp|gif)$/i.test(ref.filename)) {
      const image: VisualInput = { key: `view:${ref.id}:1:${snapshot.viewRevision}`, refId: ref.id, filename: ref.filename, page: 1, revision: snapshot.viewRevision, mimeType: "image/jpeg", data: jpegFrame(readFileSync(ref.storedPath)) };
      viewFrames.set(slug, image); void visualCall(slug)?.shareVisual([image]);
    }
    return snapshot.viewRevision;
  });
  handle("stage:hide", (_event, slug: string) => {
    const bot = runtime.store.getBot(slug); if (!bot) return; const snapshot = shared.get(bot.id);
    if (!snapshot.view?.visible) return;
    contextChanged(bot.id, shared.view(bot.id, { ...snapshot.view, visible: false }));
    viewFrames.delete(slug); visualCall(slug)?.clearVisual();
  });
  handle("stage:visual", (_event, slug: string, frame: { refId: string; page: number; revision: number; data: string; callId?: string }) => {
    const bot = runtime.store.getBot(slug), call = visualCall(slug);
    if (!bot) return false;
    if ((frame.callId && (liveSlug !== slug || live?.id !== frame.callId)) || runtime.activeBot().id !== bot.id || !shared.matches(bot.id, frame.refId, frame.page, frame.revision)) return false;
    if (frame.data === "") { if (call) send("call", { slug, callId: call.id, phase: "visual", visual: { phase: "error", source: shared.get(bot.id).view?.filename, detail: "当前页图像未能生成，请重新打开文档。" } }); return false; }
    const ref = runtime.store.resolveLibraryRef(bot.id, frame.refId);
    if (!/\.pdf$/i.test(ref.filename) || typeof frame.data !== "string" || frame.data.length > 4_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) return false;
    const image: VisualInput = { key: `view:${ref.id}:${frame.page}:${frame.revision}`, refId: ref.id, filename: ref.filename, page: frame.page, revision: frame.revision, mimeType: "image/jpeg", data: jpegFrame(Buffer.from(frame.data, "base64")) };
    viewFrames.set(slug, image);
    const delivered = call?.shareVisual([image]);
    // Display receipts confirm local rendering even when this provider has no visual protocol.
    return !call || call instanceof LiveCall && !call.supportsVision() ? true : delivered;
  });
  handle("settings:models", async (_event, patch: SecretPatch) => {
    const draft = draftSecrets(patch);
    return listModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiStyle: draft.apiStyle });
  });
  handle("settings:check", async (_event, patch: SecretPatch) => {
    const draft = draftSecrets(patch);
    if (!draft.model) throw new Error("请先选择模型。");
    if (!draft.apiKey && !/localhost|127\.0\.0\.1/.test(draft.baseUrl)) throw new Error("请先填写模型密钥。");
    return checkModel(configFromEnv(envFromRecord(draft)));
  });
  handle("link:key", (_event, service: string, region: string) => {
    assertRealtimeAvailable(service);
    return shell.openExternal(realtimeKeyPage(typeof service === "string" ? service : "", typeof region === "string" ? region : ""));
  });
  handle("settings:save", (_event, patch: SecretPatch) => {
    const draft = mergeSettings(secrets, patch);
    assertRealtimeAvailable(draft.realtimeService);
    savedSecrets = mergeSecrets(savedSecrets, settingsPatchForSave(secrets, patch));
    secrets = draft;
    publish();
    return settingsView();
  });
  handle("settings:voices", async (event, patch: SecretPatch, refresh: boolean) => {
    const draft = mergeSettings(secrets, patch);
    assertRealtimeAvailable(draft.realtimeService);
    if (draft.realtimeService !== "moss") return [];
    return mossVoices.list(draft.realtimeKey, refresh === true);
  });
  handle("settings:dirty", (_event, dirty: boolean) => { settingsDirty = dirty === true; });
  handle("settings:finishClose", (_event, intent: "window" | "quit") => {
    if (settingsDirty) return;
    if (intent === "quit") app.quit();
    else if (intent === "window") window?.close();
  });
  handle("call:start", (_event, slug: string) => {
    startCall(slug);
  });
  handle("call:preview", (_event, patch: SecretPatch) => {
    startPreview(patch);
  });
  handle("call:stop", () => {
    live?.hangup();
    live = null;
  });
  ipcMain.on("call:audio", (_event, audio: string) => {
    if (typeof audio !== "string" || !audio) return;
    live?.sendAudio(Buffer.from(audio, "base64"));
  });
  ipcMain.on("call:position", (_event, position: PlaybackPosition) => live?.notePlayback(position));
  ipcMain.on("call:chunkPlayed", (_event, position: PlaybackPosition) => { if (live instanceof MossCall) live.noteChunkPlayed(position); });
  ipcMain.on("call:interrupted", (_event, receipt: InterruptionReceipt) => live?.noteInterrupted(receipt));
  handle("call:control", (_event, action: "pause" | "resume" | "complete") => { if (["pause", "resume", "complete"].includes(action)) live?.control(action); });
  ipcMain.on("call:mute", (_event, muted: boolean) => live?.setMuted(muted === true));
  ipcMain.on("call:idle", (_event, serial: number, callId?: string) => {
    live?.noteSpeakerIdle(serial, callId);
  });
  handle("browser:bounds", (_event, bounds: { x: number; y: number; width: number; height: number } | null, slug?: string) => {
    browser.setBounds(slug || runtime.activeBot().slug, bounds);
  });
  handle("browser:go", async (_event, url: string) => {
    return browser.forBot(runtime.activeBot().slug).userNavigate(url);
  });
  handle("browser:back", () => browser.forBot(runtime.activeBot().slug).userBack());
  handle("browser:forward", () => browser.forBot(runtime.activeBot().slug).userForward());
  handle("browser:holder", (_event, holder: "bot" | "user") => {
    browser.forBot(runtime.activeBot().slug).setHolder(holder);
  });
}

function attachDownloads(): void {
  const partition = session.fromPartition("persist:xiaowang");
  partition.on("will-download", (_event, item, contents) => {
    const slug = contents && browser.slugForContents(contents.id);
    const owner = slug ? runtime.store.getBot(slug) : undefined;
    if (!owner) { item.cancel(); return; }
    const filename = item.getFilename() || "download";
    const savePath = path.join(app.getPath("temp"), `xiaowang-${randomUUID()}-${filename}`);
    item.setSavePath(savePath);
    item.once("done", (_done, state) => {
      if (state !== "completed") return;
      try {
        const bytes = readFileSync(savePath);
        const bot = runtime.store.getBot(owner.id);
        if (!bot) return;
        const added = runtime.store.addLibraryBytes(bot.id, filename, bytes);
        send("stage", { slug: bot.slug, mode: "file", id: added.ref.id, filename: added.ref.filename, page: 1 });
        send("download", { slug: bot.slug, id: added.ref.id, filename: added.ref.filename });
        publish();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send("download", { error: message });
      }
    });
  });
}

function appIcon() {
  return nativeImage.createFromPath(path.join(here, "icon.png"));
}

async function createWindow(): Promise<void> {
  const icon = appIcon();
  if (process.platform === "darwin" && !icon.isEmpty()) app.dock?.setIcon(icon);
  window = new BrowserWindow({
    ...testWindowOptions(),
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 680,
    icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#F6F6F7",
    webPreferences: {
      ...testWindowOptions().webPreferences,
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  protectAppWindow(window, appPage, url => shell.openExternal(url));
  browser.attach(window);
  browser.activate(runtime.activeBot().slug);
  // Native edit-menu accelerators can consume Ctrl+V before Chromium dispatches
  // a key/paste event for an image. The renderer checks composer focus first.
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key.toLowerCase() === "v" && (input.control || input.meta) && !input.shift) send("clipboard:pasteShortcut", { at: Date.now() });
  });
  window.on("close", event => {
    if (settingsDirty) { event.preventDefault(); send("settings:closeRequested", "window"); }
  });
  window.on("closed", () => {
    window = null;
  });
  try {
    if (devUrl) await window.loadURL(devUrl);
    else await window.loadFile(path.join(here, "renderer/index.html"));
  } catch (error) {
    if (!String(error).includes("ERR_ABORTED")) throw error;
  }
}

function realtimeChoice() {
  const choice = resolveRealtime({
    service: secrets.realtimeService,
    model: secrets.realtimeModel,
    voice: secrets.realtimeVoice,
    region: secrets.realtimeRegion,
    workspace: secrets.realtimeWorkspace,
    url: secrets.realtimeUrl,
  });
  assertRealtimeAvailable(choice.service);
  return { ...choice, url: realtimeUrlOverride() || choice.url };
}

function startPreview(patch: SecretPatch): void {
  if (live) throw new Error("正在通话。挂断后再试听。");
  const draft = mergeSettings(secrets, patch);
  const choice = resolveRealtime({ service: draft.realtimeService, model: draft.realtimeModel, voice: draft.realtimeVoice, region: draft.realtimeRegion, workspace: draft.realtimeWorkspace });
  assertRealtimeAvailable(choice.service);
  if (!choice.url) throw new Error("先填写通义千问的工作空间。");
  const key = keyForService(choice.service, draft.realtimeKey, draft.apiKey, draft.baseUrl);
  if (!key) throw new Error("先填写这一家的密钥。");
  const endpoint = realtimeEndpoint({ url: realtimeUrlOverride() || choice.url, model: choice.model, family: choice.service });
  const session = endpoint.family === "gemini" ? geminiSession("仅试听音色，按要求读出一句话。", [], choice.voice, choice.model) : endpoint.family === "moss" ? mossSession("仅试听音色，按要求读出一句话。", [], choice.voice) : endpoint.family === "doubao"
    ? doubaoSession({ instructions: "试听音色。", tools: [], voice: choice.voice })
    : sessionUpdate({
      instructions: "试听音色。用户要求说一句时，只说那一句。",
      tools: [],
      audioFormat: endpoint.audioFormat,
      transcriptionModel: endpoint.transcriptionModel,
      family: endpoint.family,
      voice: choice.voice,
    });
  openCall(socketUrl(endpoint), key, session, endpoint.inputRate, endpoint.outputRate, "", PREVIEW_LINE);
}

function startCall(slug: string): void {
  const choice = realtimeChoice();
  const key = keyForService(choice.service, secrets.realtimeKey, secrets.apiKey, secrets.baseUrl);
  if (!key) throw new Error("先在设置里填写这一家的密钥。");
  if (!choice.url) throw new Error("先填写通义千问的工作空间。");
  const endpoint = realtimeEndpoint({ url: choice.url, model: choice.model, family: choice.service });
  const bot = runtime.store.requireBot(slug);
  const person = runtime.ensureSteward().name;
  const library = runtime.store.listLibrary(bot.id).map((ref) => ({ id: ref.id, filename: ref.filename }));
  const locale = localeOf(secrets.locale);
  const brief = formatVoiceBrief(projectVoiceBrief(bot, runtime.store.getEvents(bot.id), { library }), person, locale);
  const instructions = realtimeInstructions(person, brief, locale, endpoint.family === "gemini", endpoint.family === "doubao");
  const voiceTasks = new VoiceTasks(jobs, bot.id, randomUUID(), task => {
    const focus = focusedFiles.get(slug);
    let reference = null;
    try { if (focus) reference = runtime.store.resolveLibraryRef(bot.id, focus); } catch { focusedFiles.delete(slug); }
    return handoffText(task, live?.transcript() ?? [], bot.name, locale)
      + (reference ? `\n\n当前阅读的原文（上下文资料）：${JSON.stringify({ id: reference.id, filename: reference.filename })}。用户明确提到另一份资料时以用户要求为准。` : "");
  }, () => live?.id, () => shared.get(bot.id));
  const tools = voiceTools(toolSchemas(), locale);
  const session = endpoint.family === "gemini" ? geminiSession(instructions, tools, choice.voice, choice.model) : endpoint.family === "moss" ? mossSession(brief, tools, choice.voice) : endpoint.family === "doubao"
    ? doubaoSession({ instructions, tools, voice: choice.voice })
    : sessionUpdate({
      instructions,
      tools,
      audioFormat: endpoint.audioFormat,
      transcriptionModel: endpoint.transcriptionModel,
      family: endpoint.family,
      voice: choice.voice,
    });
  openCall(socketUrl(endpoint), key, session, endpoint.inputRate, endpoint.outputRate, slug, "", {
    onTranscript(who, text) {
      if (who !== "user") return;
      if (endpoint.family === "moss") return;
      const accepted = voiceTasks.userText(text, endpoint.family !== "gemini");
      const job = accepted || voiceTasks.latest();
      live?.updateContext("currentVoiceTask", job ? voiceJobReceipt(job) : "没有已受理的后台任务。需要分析、梳理或调研时调用 delegate_task；口头承诺不代表已经开始。");
    },
    delegate(task) {
      const focus = focusedFiles.get(slug);
      let reference = null;
      try { if (focus) reference = runtime.store.resolveLibraryRef(bot.id, focus); } catch { focusedFiles.delete(slug); }
      return jobs.enqueue({ botId: bot.id, task: handoffText(task.objective, live?.transcript() ?? [], bot.name, locale)
        + `\n\n委派上下文（仅作资料）：${JSON.stringify(task.context ?? [])}`
        + (reference ? `\n当前原文：${JSON.stringify({ id: reference.id, filename: reference.filename })}` : ""),
        sharedContext: shared.get(bot.id), channel: "voice", notify: "silent", title: task.objective, sourceCallId: `moss:${task.sessionId}:${task.id}`, originCallId: live?.id });
    },
    cancelDelegation(id) { jobs.cancel(id); },
    async runTool(name, args, callId, signal) {
      if (name === "ask_text" || name === "delegate_task") {
        const task = taskArgument(args);
        if (!task) return askTextResult("missing", locale);
        let notify: TaskJob["notify"] = "when_idle";
        try { if (JSON.parse(args).notify === "silent") notify = "silent"; } catch { /* validated by taskArgument */ }
        const job = voiceTasks.delegate(task, callId, notify, JSON.parse(args).mode === "queue");
        live?.updateContext("currentVoiceTask", voiceJobReceipt(job));
        return voiceJobReceipt(job);
      }
      if (name === "cancel_task") {
        const id = JSON.parse(args || "{}").id;
        const job = typeof id === "string" ? jobs.get(id) : jobs.active(bot.id);
        if (!job) return JSON.stringify({ status: "idle" });
        if (job.botId !== bot.id) throw new Error("这个任务属于其他工作区。");
        jobs.cancel(job.id);
        return JSON.stringify({ id: job.id, status: "cancelled" });
      }
      if (name === "get_task") {
        const id = JSON.parse(args || "{}").id;
        const job = typeof id === "string" && id.trim() ? jobs.get(id) : voiceTasks.latest();
        if (!job) return JSON.stringify({ status: "not_started", message: "还没有开始后台任务，需要处理时调用 delegate_task。" });
        if (job.botId !== bot.id) throw new Error("这个任务属于其他工作区。");
        return JSON.stringify(job);
      }
      // A research turn is already owned by the background LLM. Realtime can
      // still locate/open sources, but must not run a second competing workflow.
      const accepted = voiceTasks.current();
      if (accepted && !["list_library", "list_files", "show_stage"].includes(name)) return voiceJobReceipt(accepted);
      let input: unknown = {};
      try {
        input = args.trim() ? JSON.parse(args) : {};
      } catch {
        input = null;
      }
      const outcome = await executeTool(name, input, {
        store: runtime.store,
        bot,
        enqueueKickoff: job => { jobs.enqueue({ botId: job.botId, task: job.task, channel: "system", display: "conversation" }); },
        env: envFromSecrets(),
        browser: browserFor(slug),
        signal,
        stage: { show: view => stages.show(bot.slug, view) },
      });
      runtime.store.append(bot.id, { type: "assistant_turn", channel: "voice", text: "", toolCalls: [{ id: callId || `voice_${Date.now()}`, name, input }] });
      runtime.store.append(bot.id, { type: "tool_result", callId: callId || `voice_${Date.now()}`, name, output: outcome.output, isError: outcome.isError });
      if (outcome.artifact) runtime.store.append(bot.id, { type: "artifact", ...outcome.artifact });
      publish();
      return outcome.output;
    },
  });
}

function openCall(
  url: string,
  key: string,
  session: Record<string, unknown>,
  inputRate: number,
  outputRate: number,
  slug: string,
  previewText: string,
  extra?: {
    onTranscript?: (who: "user" | "assistant", text: string) => void;
    runTool?: (name: string, args: string, callId?: string, signal?: AbortSignal) => Promise<string>;
    delegate?: MossHandlers["delegate"];
    cancelDelegation?: MossHandlers["cancelDelegation"];
  },
): void {
  const preview = Boolean(previewText);
  live?.hangup();
  liveSlug = slug;
  liveState = null;
  const initial = slug ? runtime.store.getEvents(runtime.store.requireBot(slug).id).findLast(item => item.event.type === "presentation")?.event : undefined;
  let previousPresentation = "";
  let call: LiveCall | MossCall | GeminiCall;
  const handlers: MossHandlers = {
    onVisual(visual) { if (!preview) send("call", { slug, callId: call.id, phase: "visual", visual }); },
    onState(state) {
      liveState = state;
      send("call", { slug, callId: call.id, phase: "state", state, preview });
      const next = JSON.stringify(state.presentation);
      if (slug && next !== previousPresentation) {
        previousPresentation = next;
        runtime.store.append(runtime.store.requireBot(slug).id, { type: "presentation", state: state.presentation });
      }
    },
    onPhase(phase, detail) {
      if (phase === "closed" && !preview && slug) {
        const lines = call.transcript();
        if (lines.length > 0) {
          const bot = runtime.store.requireBot(slug);
          runtime.store.append(bot.id, { type: "call", callId: call.id, startedAt: call.startedAt(), endedAt: new Date().toISOString(), lines });
          publish();
          send("call", { slug, callId: call.id, phase: "saved" });
        }
      }
      send("call", { slug, callId: call.id, phase, detail: detail ?? "", preview, inputRate, outputRate });
      if (phase === "live" && slug && !preview) {
        const bot = runtime.store.requireBot(slug), snapshot = shared.get(bot.id);
        call.updateContext("workspace", contextDescription(snapshot)); shareMessageImages(slug, snapshot);
        const frame = viewFrames.get(slug); if (frame && visualCall(slug)) void visualCall(slug)!.shareVisual([frame]);
        if (call instanceof MossCall || call instanceof LiveCall && !call.supportsVision()) handlers.onVisual?.({ phase: "unavailable", detail: "当前语音服务暂未开放视觉输入，可交给后台分析。" });
      }
      if (phase === "closed" && live === call) { live = null; liveSlug = ""; liveState = null; }
    },
    onAudio(pcm, serial, identity) {
      send("call", { slug, callId: call.id, phase: "audio", preview, audio: pcm.toString("base64"), serial, identity });
    },
    onInterrupt(interruption) {
      send("call", { slug, callId: call.id, phase: "interrupt", preview, interruption });
    },
    onLine(who, text, partial, itemId, order) {
      if (!preview) send("call", { slug, callId: call.id, phase: "line", who, text, partial, itemId, order });
    },
    onTranscript(who, text, itemId) {
      if (slug && text.trim()) runtime.store.append(runtime.store.requireBot(slug).id, { type: "voice_line", callId: call.id, who, text, ...(itemId ? { itemId } : {}) });
      extra?.onTranscript?.(who, text);
    },
    onToolOutput(toolCallId) {
      if (!preview && slug) runtime.store.append(runtime.store.requireBot(slug).id, { type: "voice_tool_output", callId: call.id, toolCallId });
    },
    runTool(name, args, callId, signal) {
      return extra?.runTool?.(name, args, callId, signal) ?? Promise.resolve("");
    },
    delegate: extra?.delegate,
    cancelDelegation: extra?.cancelDelegation,
  };
  const initialPresentation = initial?.type === "presentation" ? initial.state : undefined;
  call = session.type === "gemini.session" ? new GeminiCall(url, key, session, handlers, undefined, previewText, initialPresentation)
    : session.action === "moss.session" ? new MossCall(url, key, session, handlers, undefined, previewText, initialPresentation)
    : new LiveCall(url, key, session, handlers, undefined, previewText, initialPresentation);
  live = call;
  call.start();
}

app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    if (backgroundTest) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else if (runtime && browser) void createWindow();
});

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  runtime = Runtime.open(resolveHome());
  for (const bot of runtime.store.listBots()) {
    const events = runtime.store.getEvents(bot.id), saved = events.findLast(item => item.event.type === "workspace_context")?.event;
    if (saved?.type === "workspace_context") shared.restore(bot.id, saved.state);
    else { const message = events.findLast(item => item.event.type === "user_text" && item.event.channel === "text")?.event; if (message?.type === "user_text") shared.message(bot.id, message.text, message.attachments ?? []); }
  }
  configurePagePermissions(session.defaultSession, session.fromPartition("persist:xiaowang"), () => window, appPage);
  protocol.handle("xwlib", (request) => {
    try {
      const url = new URL(request.url);
      const [slug, id] = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
      const bot = runtime.store.requireBot(slug ?? "");
      const ref = runtime.store.resolveLibraryRef(bot.id, id ?? "");
      const type = ref.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain; charset=utf-8";
      return new Response(readFileSync(ref.storedPath), {
        headers: { "content-type": type, "content-disposition": "inline" },
      });
    } catch {
      return new Response("找不到这份资料。", { status: 404 });
    }
  });
  savedSecrets = loadSecrets();
  secrets = savedSecrets;
  try { const outcome = JSON.parse(readFileSync(path.join(app.getPath("userData"), "update-outcome.json"), "utf8")); if (typeof outcome.error === "string") updateNotice = outcome.error.slice(0, 180); } catch { /* No failed installation to report. */ }
  // Environment configuration stays in memory and never rewrites stored keys.
  const overrides: Array<[Exclude<keyof SecretPatch, "realtimeProfiles">, string]> = [
    ["model", "XIAOWANG_MODEL"], ["baseUrl", "XIAOWANG_BASE_URL"], ["apiStyle", "XIAOWANG_API_STYLE"], ["apiKey", "XIAOWANG_API_KEY"],
    ["realtimeService", "XIAOWANG_REALTIME_SERVICE"], ["realtimeModel", "XIAOWANG_REALTIME_MODEL"], ["realtimeKey", "XIAOWANG_REALTIME_KEY"],
  ];
  const environmentPatch: SecretPatch = {};
  for (const [field, variable] of overrides) if (process.env[variable]?.trim()) environmentPatch[field] = process.env[variable]!.trim();
  secrets = availableRealtimeSettings(mergeSettings(secrets, environmentPatch), experimentalMossEnabled);
  attachDownloads();
  browser = new BotBrowsers(
    (slug, state) => { if (slug === runtime.activeBot().slug) send("browser", { ...state, slug }); },
    (slug, filename, bytes) => {
      const bot = runtime.store.requireBot(slug);
      const added = runtime.store.addLibraryBytes(bot.id, filename, bytes);
      send("stage", { slug: bot.slug, mode: "file", id: added.ref.id, filename: added.ref.filename, page: 1 });
      send("download", { slug: bot.slug, id: added.ref.id, filename: added.ref.filename });
      publish();
      return { id: added.ref.id, filename: added.ref.filename };
    },
  );
  jobs = new JobQueue(runtime.store, ask, jobChanged);
  updates = new UpdateController(app.getVersion(), createUpdateEngine(canInstallUpdate), state => send("update", state), canInstallUpdate, updateWaitReasons);
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  live?.hangup();
  stages.dispose();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", event => {
  if (settingsDirty && window && !window.isDestroyed()) { event.preventDefault(); send("settings:closeRequested", "quit"); return; }
  for (const timer of updateTimers) clearInterval(timer);
  live?.hangup();
  jobs?.shutdown();
  stages.dispose();
  runtime?.close();
});

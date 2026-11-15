import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, session, shell } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveCall, type InterruptionReceipt, type PlaybackPosition, type VoiceState } from "./call.ts";
import { JobQueue, type JobOutput } from "../../src/jobs.ts";
import { VoiceTasks, voiceJobReceipt } from "../../src/voice-tasks.ts";
import { backgroundTurnOwners, presentJob } from "../../src/task-presentation.ts";
import { StageRequests } from "./stage.ts";
import type { TaskJob } from "../../src/types.ts";
import type { PresentationState } from "../../src/presentation.ts";
import { runTurn } from "../../src/harness.ts";
import { formatVoiceBrief, projectVoiceBrief } from "../../src/project.ts";
import { checkModel, configFromEnv, createProvider, listModels } from "../../src/provider.ts";
import { localeOf } from "../../src/locale.ts";
import { keyForService, realtimeKeyPage, resolveRealtime } from "../../src/realtime-catalog.ts";
import { PREVIEW_LINE, askTextResult, doubaoSession, realtimeEndpoint, realtimeInstructions, sessionUpdate, socketUrl, voiceTools } from "../../src/realtime.ts";
import { Runtime } from "../../src/runtime.ts";
import { resolveHome } from "../../src/store.ts";
import { executeTool, toolSchemas } from "../../src/tools.ts";
import type { BrowserDriver, StageView } from "../../src/stage.ts";
import { BROWSER_BUSY, CANVAS_HTML_CAP, assertHttpUrl } from "../../src/stage.ts";
import type { Channel, SessionEvent } from "../../src/types.ts";
import { listCanvasPages, resolveInsideWorkspace } from "../../src/workspace.ts";
import { browseBotFiles, type BrowseOptions } from "../../src/file-browser.ts";
import { BrowserPane } from "./browser.ts";
import { loadSecrets, mergeSecrets, publicSettings, type SecretPatch, type SecretRecord } from "./secrets.ts";

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

let runtime: Runtime;
let window: BrowserWindow | null = null;
let settingsDirty = false;
let browser: BrowserPane;
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

interface ChatItem {
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

function previewOf(botId: string): string {
  const events = runtime.store.getEvents(botId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]?.event;
    if (!event) continue;
    if ((event.type === "user_text" || event.type === "assistant_turn") && event.text.trim()) {
      return event.text.replace(/\s+/g, " ").trim().slice(0, 42);
    }
  }
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
  const owners = backgroundTurnOwners((jobs?.list(bot.id) ?? []).map(job => presentJob(job, events)), events);
  const items: ChatItem[] = [];
  for (const stored of events) {
    const item = present(stored.id, stored.event);
    if (item) items.push({ ...item, jobId: item.jobId ?? owners.get(stored.id) });
  }
  return items;
}

function present(id: number, event: SessionEvent): ChatItem | null {
  if (event.type === "user_text" && event.channel === "text") {
    return { id, kind: "user", text: event.text, jobId: event.jobId };
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
  send("state", { bots: botRows(), activeSlug: active.slug, settings: publicSettings(secrets), jobs: publicJobs() });
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
    XIAOWANG_MODEL: record.model,
    XIAOWANG_BASE_URL: record.baseUrl,
    XIAOWANG_API_STYLE: record.apiStyle,
    XIAOWANG_API_KEY: record.apiKey,
  };
}

function draftSecrets(patch: SecretPatch): SecretRecord {
  return {
    ...secrets,
    model: patch.model?.trim() || secrets.model,
    baseUrl: patch.baseUrl?.trim() ?? secrets.baseUrl,
    apiStyle: patch.apiStyle?.trim() ?? secrets.apiStyle,
    apiKey: patch.apiKey?.trim() || secrets.apiKey,
  };
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
let live: LiveCall | null = null;
let liveSlug = "";
let liveState: VoiceState | null = null;
const stages = new StageRequests(note => send("stage", note));
const focusedFiles = new Map<string, string>();

async function ask(job: TaskJob, signal: AbortSignal, activity: (text: string) => void): Promise<JobOutput> {
  const bot = runtime.store.requireBot(job.botId);
  const before = runtime.store.getEvents(bot.id).at(-1)?.id ?? 0;
  const provider = createProvider(configFromEnv(envFromSecrets()));
  let resultEventId: number | undefined;
  const result = await runTurn(runtime, {
    botId: bot.id, input: job.task, channel: job.channel, provider,
    jobId: job.id,
    onInput: id => jobs.linkInput(job.id, id),
    env: envFromSecrets(), locale: localeOf(secrets.locale), signal,
    browser: browserFor(bot.slug),
    stage: { show: view => stages.show(bot.slug, view) },
    onKickoff: kickoff => { jobs.enqueue({ botId: kickoff.botId, task: kickoff.task, channel: "system" }); },
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
  const busy = jobs?.busy(job.botId) ?? job.status === "running";
  const shown = job.display && job.title ? job : presentJob(job, runtime.store.getEvents(bot.id));
  send("job", { ...shown, slug: bot.slug });
  send("turn", { slug: bot.slug, busy, error: job.status === "failed" ? job.error : "" });
  publish();
  if (live && liveSlug === bot.slug) {
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
  const claim = (): string | null => {
    const owner = browser.ownerSlug;
    if (owner && owner !== slug && jobs.busy(runtime.store.requireBot(owner).id)) return BROWSER_BUSY;
    browser.actingSlug = slug;
    browser.ownerSlug = slug;
    return null;
  };
  const run = async (action: () => Promise<string>): Promise<string> => {
    const blocked = claim();
    if (blocked) return blocked;
    return action();
  };
  const real = browser.driver;
  return {
    holder: () => real.holder(),
    navigate: (url) => run(() => real.navigate(url)),
    snapshot: () => run(() => real.snapshot()),
    click: (target) => run(() => real.click(target)),
    type: (target, text) => run(() => real.type(target, text)),
    scroll: (direction) => run(() => real.scroll(direction)),
    back: () => run(() => real.back()),
  };
}

function registerIpc(): void {
  ipcMain.handle("state:get", () => {
    // Start only after a renderer is mounted, independently of the first
    // navigation promise (a reload can abort that promise).
    jobs.start();
    return {
    bots: botRows(),
    activeSlug: runtime.activeBot().slug,
    settings: publicSettings(secrets), jobs: publicJobs(),
    call: live ? { slug: liveSlug, state: liveState } : null,
    browser: browser.viewState(),
    };
  });
  ipcMain.handle("bot:active", (_event, slug: string) => {
    runtime.store.setActiveBot(runtime.store.requireBot(slug).id);
    publish();
  });
  ipcMain.handle("bot:create", (_event, name: string, baseline: string) => {
    const parent = runtime.activeBot();
    const bot = runtime.store.createBot({
      name,
      systemPrompt: baseline || `${name}的任务。`,
      parentBotId: parent.id,
    });
    runtime.store.append(bot.id, { type: "baseline", text: baseline || `${name}的任务。`, fromBotId: parent.id });
    runtime.store.setActiveBot(bot.id);
    publish();
    return bot.slug;
  });
  ipcMain.handle("bot:rename", (_event, slug: string, name: string) => {
    runtime.store.renameBot(slug, name);
    publish();
  });
  ipcMain.handle("bot:avatar", (_event, slug: string, patch: { seed?: string; ink?: string }) => {
    runtime.store.setAvatar(slug, patch ?? {});
    publish();
  });
  ipcMain.handle("library:forget", (_event, slug: string, id: string) => {
    const bot = runtime.store.requireBot(slug);
    runtime.store.forgetLibraryRef(bot.id, id);
    publish();
  });
  ipcMain.handle("chat:events", (_event, slug: string) => chatItems(slug));
  ipcMain.handle("library:list", (_event, slug: string) => libraryOf(slug));
  ipcMain.handle("workspace:browse", (_event, slug: string, options: BrowseOptions) => {
    const bot = runtime.store.requireBot(slug);
    if (!options || !["all", "library", "workspace"].includes(options.source)) throw new Error("无效的资料位置。");
    return browseBotFiles(bot.workspaceDir, runtime.store.listLibrary(bot.id), options);
  });
  ipcMain.handle("library:openReference", (_event, slug: string, id: string, page: number) => {
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
  ipcMain.handle("link:open", (_event, url: string) => {
    const checked = assertHttpUrl(url);
    if (typeof checked !== "string") throw new Error(checked.error);
    return shell.openExternal(checked);
  });
  ipcMain.handle("library:text", (_event, slug: string, id: string) => {
    const bot = runtime.store.requireBot(slug);
    const ref = runtime.store.resolveLibraryRef(bot.id, id);
    return readFileSync(ref.storedPath);
  });
  ipcMain.handle("workspace:pages", (_event, slug: string) => {
    const bot = runtime.store.requireBot(slug);
    return listCanvasPages(bot.workspaceDir);
  });
  ipcMain.handle("workspace:openArtifact", (_event, slug: string, rel: string) => {
    const bot = runtime.store.requireBot(slug);
    const resolved = resolveInsideWorkspace(bot.workspaceDir, rel);
    if (!resolved.ok) throw new Error(resolved.error);
    if (/\.html?$/i.test(resolved.rel)) {
      const html = readFileSync(resolved.abs, "utf8");
      if (Buffer.byteLength(html) > CANVAS_HTML_CAP) throw new Error("这份页面过大。");
      send("stage", { slug, mode: "canvas", title: resolved.rel, html, page: 1 });
    } else {
      if (!/\.(pdf|md|markdown|txt|csv|json|jsonl)$/i.test(resolved.rel)) throw new Error("暂时不能预览这种文件。");
      const result = runtime.store.addLibraryBytes(bot.id, path.basename(resolved.rel), readFileSync(resolved.abs));
      send("stage", { slug, mode: "file", id: result.ref.id, filename: result.ref.filename, page: 1, restore: true });
    }
    publish();
  });
  ipcMain.handle("workspace:openPage", (_event, slug: string, rel: string, page = 1) => {
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
  ipcMain.handle("library:add", async () => {
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
  ipcMain.handle("chat:ask", async (_event, slug: string, text: string) => {
    const bot = runtime.store.requireBot(slug);
    const job = jobs.enqueue({ botId: bot.id, task: text, channel: "text" });
    const result = await jobs.wait(job.id);
    if (result.status === "failed") throw new Error(result.error);
    return chatItems(slug);
  });
  ipcMain.handle("chat:stop", (_event, slug: string) => {
    const bot = runtime.store.requireBot(slug);
    for (const job of jobs.list(bot.id)) if (job.status === "running") jobs.cancel(job.id);
  });
  ipcMain.handle("job:cancel", (_event, id: string) => jobs.cancel(id));
  ipcMain.handle("job:retry", (_event, id: string) => jobs.retry(id));
  ipcMain.handle("stage:ack", (_event, slug: string, requestId: string, receipt: { page: number; totalPages: number; title?: string; error?: string }) => stages.acknowledge(slug, requestId, receipt));
  ipcMain.handle("stage:position", (_event, slug: string, position: { path: string; page: number; totalPages: number; mode: "canvas" | "file" }) => {
    runtime.store.requireBot(slug);
    if (Number.isSafeInteger(position.page) && Number.isSafeInteger(position.totalPages) && position.page > 0 && position.page <= position.totalPages) {
      if (position.mode === "file") focusedFiles.set(slug, position.path);
      if (liveSlug === slug) live?.locate(position.path, position.page, position.totalPages, position.mode);
    }
  });
  ipcMain.handle("settings:models", async (_event, patch: SecretPatch) => {
    const draft = draftSecrets(patch);
    return listModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiStyle: draft.apiStyle });
  });
  ipcMain.handle("settings:check", async (_event, patch: SecretPatch) => {
    const draft = draftSecrets(patch);
    if (!draft.model) throw new Error("请先选择模型。");
    if (!draft.apiKey && !/localhost|127\.0\.0\.1/.test(draft.baseUrl)) throw new Error("请先填写模型密钥。");
    return checkModel(configFromEnv(envFromRecord(draft)));
  });
  ipcMain.handle("link:key", (_event, service: string, region: string) => {
    return shell.openExternal(realtimeKeyPage(typeof service === "string" ? service : "", typeof region === "string" ? region : ""));
  });
  ipcMain.handle("settings:save", (_event, patch: SecretPatch) => {
    const choice = resolveRealtime({
      service: patch.realtimeService,
      model: patch.realtimeModel,
      voice: patch.realtimeVoice,
      region: patch.realtimeRegion,
      workspace: patch.realtimeWorkspace,
      url: secrets.realtimeUrl,
    });
    secrets = mergeSecrets(secrets, {
      ...patch,
      realtimeService: choice.service,
      realtimeModel: choice.model,
      realtimeVoice: choice.voice,
      realtimeRegion: choice.region,
      realtimeWorkspace: choice.service === "qwen" ? choice.workspace : "",
      realtimeUrl: choice.url,
    });
    publish();
    return publicSettings(secrets);
  });
  ipcMain.handle("settings:dirty", (_event, dirty: boolean) => { settingsDirty = dirty === true; });
  ipcMain.handle("settings:finishClose", (_event, intent: "window" | "quit") => {
    if (settingsDirty) return;
    if (intent === "quit") app.quit();
    else if (intent === "window") window?.close();
  });
  ipcMain.handle("call:start", (_event, slug: string) => {
    startCall(slug);
  });
  ipcMain.handle("call:preview", (_event, patch: SecretPatch) => {
    startPreview(patch);
  });
  ipcMain.handle("call:stop", () => {
    live?.hangup();
    live = null;
  });
  ipcMain.on("call:audio", (_event, audio: string) => {
    if (typeof audio !== "string" || !audio) return;
    live?.sendAudio(Buffer.from(audio, "base64"));
  });
  ipcMain.on("call:position", (_event, position: PlaybackPosition) => live?.notePlayback(position));
  ipcMain.on("call:interrupted", (_event, receipt: InterruptionReceipt) => live?.noteInterrupted(receipt));
  ipcMain.handle("call:control", (_event, action: "pause" | "resume" | "complete") => { if (["pause", "resume", "complete"].includes(action)) live?.control(action); });
  ipcMain.on("call:mute", (_event, muted: boolean) => live?.setMuted(muted === true));
  ipcMain.on("call:idle", (_event, serial: number, callId?: string) => {
    live?.noteSpeakerIdle(serial, callId);
  });
  ipcMain.handle("browser:bounds", (_event, bounds: { x: number; y: number; width: number; height: number } | null) => {
    browser.setBounds(bounds);
  });
  ipcMain.handle("browser:go", async (_event, url: string) => {
    browser.actingSlug = runtime.activeBot().slug;
    return browser.userNavigate(url);
  });
  ipcMain.handle("browser:back", () => browser.userBack());
  ipcMain.handle("browser:forward", () => browser.userForward());
  ipcMain.handle("browser:holder", (_event, holder: "bot" | "user") => {
    browser.setHolder(holder);
  });
}

function attachDownloads(): void {
  const partition = session.fromPartition("persist:xiaowang");
  partition.on("will-download", (_event, item) => {
    const filename = item.getFilename() || "download";
    const savePath = path.join(app.getPath("temp"), `xiaowang-${Date.now()}-${filename}`);
    item.setSavePath(savePath);
    item.once("done", (_done, state) => {
      if (state !== "completed") return;
      try {
        const bytes = readFileSync(savePath);
        const bot = runtime.store.requireBot(browser.ownerSlug || runtime.activeBot().slug);
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
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 680,
    icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#F6F6F7",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.attach(window);
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
  return { ...choice, url: process.env.XIAOWANG_REALTIME_URL?.trim() || choice.url };
}

function startPreview(patch: SecretPatch): void {
  if (live) throw new Error("正在通话。挂断后再试听。");
  const choice = resolveRealtime({
    service: patch.realtimeService,
    model: patch.realtimeModel,
    voice: patch.realtimeVoice,
    region: patch.realtimeRegion,
    workspace: patch.realtimeWorkspace,
  });
  if (!choice.url) throw new Error("先填写通义千问的工作空间。");
  const key = patch.realtimeKey?.trim() || keyForService(choice.service, secrets.realtimeKey, secrets.apiKey, secrets.baseUrl);
  if (!key) throw new Error("先填写这一家的密钥。");
  const endpoint = realtimeEndpoint({ url: choice.url, model: choice.model, family: choice.service });
  const session = endpoint.family === "doubao"
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
  const instructions = realtimeInstructions(person, brief, locale);
  const voiceTasks = new VoiceTasks(jobs, bot.id, randomUUID(), task => {
    const focus = focusedFiles.get(slug);
    let reference = null;
    try { if (focus) reference = runtime.store.resolveLibraryRef(bot.id, focus); } catch { focusedFiles.delete(slug); }
    return handoffText(task, live?.transcript() ?? [], bot.name, locale)
      + (reference ? `\n\n当前阅读的原文（上下文资料）：${JSON.stringify({ id: reference.id, filename: reference.filename })}。用户明确提到另一份资料时以用户要求为准。` : "");
  }, () => live?.id);
  const tools = voiceTools(toolSchemas(), locale);
  const session = endpoint.family === "doubao"
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
      const accepted = voiceTasks.userText(text);
      const job = accepted || voiceTasks.latest();
      live?.updateContext("currentVoiceTask", job ? voiceJobReceipt(job) : "没有已受理的后台任务。需要分析、梳理或调研时调用 delegate_task；口头承诺不代表已经开始。");
    },
    async runTool(name, args, callId, signal) {
      if (name === "ask_text" || name === "delegate_task") {
        const task = taskArgument(args);
        if (!task) return askTextResult("missing", locale);
        let notify: TaskJob["notify"] = "when_idle";
        try { if (JSON.parse(args).notify === "silent") notify = "silent"; } catch { /* validated by taskArgument */ }
        const job = voiceTasks.delegate(task, callId, notify);
        live?.updateContext("currentVoiceTask", voiceJobReceipt(job));
        return voiceJobReceipt(job);
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
        enqueueKickoff: job => { jobs.enqueue({ botId: job.botId, task: job.task, channel: "system" }); },
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
  },
): void {
  const preview = Boolean(previewText);
  live?.hangup();
  liveSlug = slug;
  liveState = null;
  const initial = slug ? runtime.store.getEvents(runtime.store.requireBot(slug).id).findLast(item => item.event.type === "presentation")?.event : undefined;
  let previousPresentation = "";
  let call: LiveCall;
  call = new LiveCall(url, key, session, {
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
    onTranscript(who, text) {
      if (slug && text.trim()) runtime.store.append(runtime.store.requireBot(slug).id, { type: "voice_line", callId: call.id, who, text });
      extra?.onTranscript?.(who, text);
    },
    onToolOutput(toolCallId) {
      if (!preview && slug) runtime.store.append(runtime.store.requireBot(slug).id, { type: "voice_tool_output", callId: call.id, toolCallId });
    },
    runTool(name, args, callId, signal) {
      return extra?.runTool?.(name, args, callId, signal) ?? Promise.resolve("");
    },
  }, undefined, previewText, initial?.type === "presentation" ? initial.state : undefined);
  live = call;
  call.start();
}

app.whenReady().then(async () => {
  runtime = Runtime.open(resolveHome());
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
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
  secrets = loadSecrets();
  // Environment configuration stays in memory and never rewrites stored keys.
  const overrides: Array<[keyof SecretRecord, string]> = [
    ["model", "XIAOWANG_MODEL"], ["baseUrl", "XIAOWANG_BASE_URL"], ["apiStyle", "XIAOWANG_API_STYLE"], ["apiKey", "XIAOWANG_API_KEY"],
    ["realtimeService", "XIAOWANG_REALTIME_SERVICE"], ["realtimeModel", "XIAOWANG_REALTIME_MODEL"], ["realtimeKey", "XIAOWANG_REALTIME_KEY"],
  ];
  for (const [field, variable] of overrides) if (process.env[variable]?.trim()) secrets[field] = process.env[variable]!.trim();
  attachDownloads();
  browser = new BrowserPane(
    () => runtime.activeBot().slug,
    (state) => send("browser", state),
    (filename, bytes) => {
      const bot = runtime.store.requireBot(browser.ownerSlug || runtime.activeBot().slug);
      const added = runtime.store.addLibraryBytes(bot.id, filename, bytes);
      send("stage", { slug: bot.slug, mode: "file", id: added.ref.id, filename: added.ref.filename, page: 1 });
      send("download", { slug: bot.slug, id: added.ref.id, filename: added.ref.filename });
      publish();
      return { id: added.ref.id, filename: added.ref.filename };
    },
  );
  jobs = new JobQueue(runtime.store, ask, jobChanged);
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
  live?.hangup();
  jobs?.shutdown();
  stages.dispose();
  runtime?.close();
});

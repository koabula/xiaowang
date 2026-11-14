import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveCall } from "./call.ts";
import { runTurn } from "../../src/harness.ts";
import { formatVoiceBrief, projectVoiceBrief } from "../../src/project.ts";
import { checkModel, configFromEnv, createProvider, listModels } from "../../src/provider.ts";
import { keyForService, realtimeKeyPage, resolveRealtime } from "../../src/realtime-catalog.ts";
import { PREVIEW_LINE, doubaoSession, realtimeEndpoint, realtimeInstructions, sessionUpdate, socketUrl, voiceTools } from "../../src/realtime.ts";
import { Runtime } from "../../src/runtime.ts";
import { resolveHome } from "../../src/store.ts";
import { executeTool, toolSchemas } from "../../src/tools.ts";
import type { BrowserDriver, StageView } from "../../src/stage.ts";
import { BROWSER_BUSY } from "../../src/stage.ts";
import type { SessionEvent } from "../../src/types.ts";
import { BrowserPane } from "./browser.ts";
import { loadSecrets, mergeSecrets, publicSettings, type SecretPatch, type SecretRecord } from "./secrets.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "xwlib",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.XIAOWANG_DESKTOP_URL ?? "";

let runtime: Runtime;
let window: BrowserWindow | null = null;
let browser: BrowserPane;
let secrets: SecretRecord = {
  model: "",
  baseUrl: "",
  apiStyle: "",
  apiKey: "",
  searchKey: "",
  searchUrl: "",
  searchProvider: "",
  realtimeModel: "",
  realtimeUrl: "",
  realtimeKey: "",
  realtimeService: "",
  realtimeVoice: "",
  realtimeRegion: "",
  realtimeWorkspace: "",
};

interface ChatItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "file" | "note" | "call";
  text: string;
  name?: string;
  isError?: boolean;
  lines?: Array<{ who: "user" | "assistant"; text: string }>;
  seconds?: number;
}

interface BotRow {
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
    slug: bot.slug,
    name: bot.name,
    preview: previewOf(bot.id),
    avatarSeed: bot.avatarSeed,
    avatarInk: bot.avatarInk,
  }));
}

function chatItems(slug: string): ChatItem[] {
  const bot = runtime.store.requireBot(slug);
  const items: ChatItem[] = [];
  for (const stored of runtime.store.getEvents(bot.id)) {
    const item = present(stored.id, stored.event);
    if (item) items.push(item);
  }
  return items;
}

function present(id: number, event: SessionEvent): ChatItem | null {
  if (event.type === "user_text" && event.channel !== "system") {
    return { id, kind: "user", text: event.text };
  }
  if (event.type === "assistant_turn" && event.text.trim()) {
    return { id, kind: "assistant", text: event.text };
  }
  if (event.type === "call" && event.lines.some((line) => line.text.trim())) {
    const elapsed = Math.round((Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000);
    return {
      id,
      kind: "call",
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
  send("state", { bots: botRows(), activeSlug: active.slug, settings: publicSettings(secrets) });
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

async function ask(slug: string, text: string, signal: AbortSignal): Promise<void> {
  const bot = runtime.store.requireBot(slug);
  const provider = createProvider(configFromEnv(envFromSecrets()));
  await runTurn(runtime, {
    botId: bot.id,
    input: text,
    provider,
    env: envFromSecrets(),
    signal,
    browser: browserFor(slug),
    stage: {
      show(view: StageView) {
        send("stage", { slug: bot.slug, ...view });
        publish();
      },
    },
    onStep(step) {
      send("step", {
        slug: step.bot.slug,
        kind: step.kind,
        name: step.name ?? "",
        text: step.text,
        isError: Boolean(step.isError),
        activity: step.activity ?? "",
      });
    },
  });
  publish();
}

let turns = new Map<string, AbortController>();
let live: LiveCall | null = null;

function browserFor(slug: string): BrowserDriver {
  const claim = (): string | null => {
    const owner = browser.ownerSlug;
    if (owner && owner !== slug && turns.has(owner)) return BROWSER_BUSY;
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
  ipcMain.handle("state:get", () => ({
    bots: botRows(),
    activeSlug: runtime.activeBot().slug,
    settings: publicSettings(secrets),
  }));
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
  ipcMain.handle("library:text", (_event, slug: string, id: string) => {
    const bot = runtime.store.requireBot(slug);
    const ref = runtime.store.resolveLibraryRef(bot.id, id);
    return readFileSync(ref.storedPath);
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
    turns.get(slug)?.abort();
    const controller = new AbortController();
    turns.set(slug, controller);
    try {
      await ask(slug, text, controller.signal);
    } finally {
      if (turns.get(slug) === controller) turns.delete(slug);
    }
    return chatItems(slug);
  });
  ipcMain.handle("chat:stop", (_event, slug: string) => {
    if (typeof slug === "string") turns.get(slug)?.abort();
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
      realtimeWorkspace: choice.model.startsWith("qwen3.8") ? choice.workspace : "",
      realtimeUrl: choice.url,
    });
    publish();
    return publicSettings(secrets);
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
  ipcMain.on("call:idle", (_event, serial: number) => {
    live?.noteSpeakerIdle(serial);
  });
  ipcMain.handle("browser:bounds", (_event, bounds: { x: number; y: number; width: number; height: number } | null) => {
    browser.setBounds(bounds);
  });
  ipcMain.handle("browser:go", async (_event, url: string) => {
    browser.actingSlug = runtime.activeBot().slug;
    return browser.driver.navigate(url);
  });
  ipcMain.handle("browser:back", () => browser.back());
  ipcMain.handle("browser:forward", () => browser.forward());
  ipcMain.handle("browser:holder", (_event, holder: "bot" | "user") => {
    browser.setHolder(holder);
    send("browser", browser.viewState());
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
        send("stage", { mode: "file", id: added.ref.id, filename: added.ref.filename, page: 1 });
        send("download", { slug: bot.slug, id: added.ref.id, filename: added.ref.filename });
        publish();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send("download", { error: message });
      }
    });
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 680,
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
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(here, "../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}

function realtimeChoice() {
  return resolveRealtime({
    service: secrets.realtimeService,
    model: secrets.realtimeModel,
    voice: secrets.realtimeVoice,
    region: secrets.realtimeRegion,
    workspace: secrets.realtimeWorkspace,
    url: secrets.realtimeUrl,
  });
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
  const endpoint = realtimeEndpoint({ url: choice.url, model: choice.model });
  const session = endpoint.family === "doubao"
    ? doubaoSession({ instructions: "试听音色。", tools: [], voice: choice.voice })
    : sessionUpdate({
      instructions: "试听音色。用户要求说一句时，只说那一句。",
      tools: [],
      audioFormat: endpoint.audioFormat,
      transcriptionModel: endpoint.transcriptionModel,
      voice: choice.voice,
    });
  openCall(socketUrl(endpoint), key, session, endpoint.inputRate, endpoint.outputRate, "", PREVIEW_LINE);
}

function startCall(slug: string): void {
  const choice = realtimeChoice();
  const key = keyForService(choice.service, secrets.realtimeKey, secrets.apiKey, secrets.baseUrl);
  if (!key) throw new Error("先在设置里填写这一家的密钥。");
  if (!choice.url) throw new Error("先填写通义千问的工作空间。");
  const endpoint = realtimeEndpoint({ url: choice.url, model: choice.model });
  const bot = runtime.store.requireBot(slug);
  const person = runtime.ensureSteward().name;
  const library = runtime.store.listLibrary(bot.id).map((ref) => ({ id: ref.id, filename: ref.filename }));
  const brief = formatVoiceBrief(projectVoiceBrief(bot, runtime.store.getEvents(bot.id), { library }), person);
  const instructions = realtimeInstructions(person, brief);
  const tools = voiceTools(toolSchemas());
  const session = endpoint.family === "doubao"
    ? doubaoSession({ instructions, tools, voice: choice.voice })
    : sessionUpdate({
      instructions,
      tools,
      audioFormat: endpoint.audioFormat,
      transcriptionModel: endpoint.transcriptionModel,
      voice: choice.voice,
    });
  openCall(socketUrl(endpoint), key, session, endpoint.inputRate, endpoint.outputRate, slug, "", {
    async runTool(name, args) {
      let input: unknown = {};
      try {
        input = args.trim() ? JSON.parse(args) : {};
      } catch {
        input = null;
      }
      const outcome = await executeTool(name, input, {
        store: runtime.store,
        bot,
        enqueueKickoff: (job) => runtime.enqueueKickoff(job),
        env: envFromSecrets(),
        browser: browserFor(slug),
        stage: {
          show(view) {
            send("stage", { slug: bot.slug, ...view });
            publish();
          },
        },
      });
      runtime.store.append(bot.id, {
        type: "tool_result",
        callId: `voice_${Date.now()}`,
        name,
        output: outcome.output,
        isError: outcome.isError,
      });
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
    runTool?: (name: string, args: string) => Promise<string>;
  },
): void {
  const preview = Boolean(previewText);
  live?.hangup();
  let call: LiveCall;
  call = new LiveCall(url, key, session, {
    onPhase(phase, detail) {
      if (phase === "closed" && !preview && slug) {
        const lines = call.transcript();
        if (lines.length > 0) {
          const bot = runtime.store.requireBot(slug);
          runtime.store.append(bot.id, { type: "call", startedAt: call.startedAt(), endedAt: new Date().toISOString(), lines });
          publish();
          send("call", { slug, phase: "saved" });
        }
      }
      send("call", { slug, phase, detail: detail ?? "", preview, inputRate, outputRate });
      if (phase === "closed") live = null;
    },
    onAudio(pcm, serial) {
      send("call", { slug, phase: "audio", preview, audio: pcm.toString("base64"), serial });
    },
    onInterrupt() {
      if (!preview) send("call", { slug, phase: "interrupt" });
    },
    onLine(who, text, partial) {
      if (!preview) send("call", { slug, phase: "line", who, text, partial });
    },
    onTranscript(who, text) {
      extra?.onTranscript?.(who, text);
    },
    runTool(name, args) {
      return extra?.runTool?.(name, args) ?? Promise.resolve("");
    },
  }, undefined, previewText);
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
  attachDownloads();
  browser = new BrowserPane(
    () => runtime.activeBot().slug,
    (state) => send("browser", state),
    (filename, bytes) => {
      const bot = runtime.store.requireBot(browser.ownerSlug || runtime.activeBot().slug);
      const added = runtime.store.addLibraryBytes(bot.id, filename, bytes);
      send("stage", { mode: "file", id: added.ref.id, filename: added.ref.filename, page: 1 });
      send("download", { slug: bot.slug, id: added.ref.id, filename: added.ref.filename });
      publish();
      return { id: added.ref.id, filename: added.ref.filename };
    },
  );
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  runtime?.close();
  if (process.platform !== "darwin") app.quit();
});

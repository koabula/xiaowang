import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn } from "../../src/harness.ts";
import { checkModel, configFromEnv, createProvider, listModels } from "../../src/provider.ts";
import { Runtime } from "../../src/runtime.ts";
import { resolveHome } from "../../src/store.ts";
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
};

interface ChatItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "file" | "note";
  text: string;
  name?: string;
  isError?: boolean;
}

interface BotRow {
  slug: string;
  name: string;
  preview: string;
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
  ipcMain.handle("settings:save", (_event, patch: SecretPatch) => {
    secrets = mergeSecrets(secrets, patch);
    publish();
    return publicSettings(secrets);
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

app.whenReady().then(async () => {
  runtime = Runtime.open(resolveHome());
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

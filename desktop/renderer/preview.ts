import { realtimeKeyPage } from "../../src/realtime-catalog.ts";
import type { AppState, BrowserNote, CallNote, ChatItem, DownloadNote, LibraryItem, SettingsPatch, SettingsView, StageNote, StepNote, TurnNote } from "./types.ts";

/** 普通浏览器里预览界面。桌面端有 preload 时不会装上。 */
export function installPreviewBridge(): void {
  if (window.xiaowang) return;
  let state: AppState = {
    activeSlug: "xiaowang",
    settings: {
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiStyle: "",
      keyHint: "已保存 ····8f2a",
      searchProvider: "",
      searchUrl: "",
      searchKeyHint: "",
      realtimeModel: "",
      realtimeUrl: "",
      realtimeKeyHint: "",
      realtimeService: "",
      realtimeVoice: "",
      realtimeRegion: "",
      realtimeWorkspace: "",
      locale: "zh",
      ready: true,
    },
    bots: [
      { slug: "xiaowang", name: "小王同学", preview: "还没有单独立项的对话留在这里", avatarSeed: "", avatarInk: "" },
      { slug: "speculative", name: "投机解码", preview: "先核对代表论文，再写笔记", avatarSeed: "", avatarInk: "" },
    ],
  };
  const chats = new Map<string, ChatItem[]>([
    ["xiaowang", [{ id: 1, kind: "note", text: "小王同学的总入口。还没有单独立项的对话留在这里。" }]],
    [
      "speculative",
      [
        { id: 1, kind: "user", text: "帮我看一下投机解码最近的论文。" },
        { id: 2, kind: "tool", name: "search_literature", text: "在 openalex 检索到 5 条。" },
        { id: 3, kind: "assistant", text: "先看 *Online Speculative Decoding*（2023）。我把对照写进了笔记。" },
        { id: 4, kind: "file", text: "notes/reading.md" },
      ],
    ],
  ]);
  const library: LibraryItem[] = [{ id: "f_demo", filename: "reading.md", byteSize: 120 }];
  const listeners = {
    state: new Set<(state: AppState) => void>(),
    step: new Set<(step: StepNote) => void>(),
    stage: new Set<(view: StageNote) => void>(),
    browser: new Set<(state: BrowserNote) => void>(),
    download: new Set<(note: DownloadNote) => void>(),
    call: new Set<(note: CallNote) => void>(),
  };
  const publish = () => listeners.state.forEach((callback) => callback(state));
  window.xiaowang = {
    async getState() {
      return state;
    },
    async setActive(slug) {
      state = { ...state, activeSlug: slug };
      publish();
    },
    async renameBot(slug, name) {
      state = { ...state, bots: state.bots.map((bot) => bot.slug === slug ? { ...bot, name } : bot) };
      publish();
    },
    async setAvatar(slug, patch) {
      state = {
        ...state,
        bots: state.bots.map((bot) => bot.slug === slug ? { ...bot, avatarSeed: patch.seed ?? bot.avatarSeed, avatarInk: patch.ink ?? bot.avatarInk } : bot),
      };
      publish();
    },
    async forgetFile() {},
    async createBot(name) {
      const slug = name.toLowerCase().replace(/\s+/g, "-") || "bot";
      state = { ...state, activeSlug: slug, bots: [...state.bots, { slug, name, preview: "还没有对话", avatarSeed: "", avatarInk: "" }] };
      chats.set(slug, []);
      publish();
      return slug;
    },
    async events(slug) {
      return chats.get(slug) ?? [];
    },
    async library() {
      return library;
    },
    async pages() {
      return [{ path: "deck.html", name: "deck.html" }];
    },
    async openPage(_slug, path) {
      return { title: path, html: "<!doctype html><title>Deck</title><section>One</section><section>Two</section>", page: 1 };
    },
    async readFile() {
      return new TextEncoder().encode("# 阅读笔记\n\n投机解码用小模型起草，大模型逐段确认。\n");
    },
    async addFiles() {
      listeners.download.forEach((callback) => callback({ filename: "paper.pdf" }));
    },
    async ask(slug, text) {
      const next = [...(chats.get(slug) ?? []), { id: Date.now(), kind: "user" as const, text }, { id: Date.now() + 1, kind: "assistant" as const, text: "界面预览里还没有接上模型。桌面端会走现在的会话。" }];
      chats.set(slug, next);
      return next;
    },
    async stop(_slug?: string) {},
    async callStart(slug) {
      const note = (phase: CallNote["phase"], extra: Partial<CallNote> = {}) => {
        listeners.call.forEach((callback) => callback({ slug, phase, ...extra }));
      };
      note("live", { inputRate: 16_000, outputRate: 24_000 });
      note("line", { who: "assistant", text: "你好，我是小王同学。", partial: false });
      note("line", { who: "user", text: "今天先看到这里。", partial: true });
      note("line", { who: "user", text: "今天先看到这里。", partial: false });
    },
    async previewVoice() {
      throw new Error("预览里没有接通实时模型。");
    },
    async callStop() {
      const slug = state.activeSlug;
      const next = [...(chats.get(slug) ?? []), {
        id: Date.now(),
        kind: "call" as const,
        text: "你好，我是小王同学。",
        seconds: 15,
        lines: [
          { who: "assistant" as const, text: "你好，我是小王同学。" },
          { who: "user" as const, text: "今天先看到这里。" },
        ],
      }];
      chats.set(slug, next);
      listeners.call.forEach((callback) => callback({ slug, phase: "closed" }));
      listeners.call.forEach((callback) => callback({ slug, phase: "saved" }));
    },
    callAudio() {},
    callIdle() {},
    onCall(callback) {
      listeners.call.add(callback);
      return () => listeners.call.delete(callback);
    },
    async saveSettings(patch: SettingsPatch) {
      const settings: SettingsView = { ...state.settings, model: patch.model || state.settings.model, baseUrl: patch.baseUrl ?? state.settings.baseUrl, apiStyle: patch.apiStyle ?? state.settings.apiStyle, realtimeService: patch.realtimeService ?? state.settings.realtimeService, realtimeModel: patch.realtimeModel ?? state.settings.realtimeModel, realtimeVoice: patch.realtimeVoice ?? state.settings.realtimeVoice, realtimeRegion: patch.realtimeRegion ?? state.settings.realtimeRegion, realtimeWorkspace: patch.realtimeWorkspace ?? state.settings.realtimeWorkspace, locale: patch.locale === "en" ? "en" : "zh", ready: true };
      state = { ...state, settings };
      publish();
      return settings;
    },
    async openKeyPage(service: string, region: string) {
      window.open(realtimeKeyPage(service, region), "_blank", "noopener,noreferrer");
    },
    async listModels() {
      return ["deepseek-chat", "qwen-plus"];
    },
    async checkSettings() {
      return "好";
    },
    async browserBounds() {},
    async browserGo(url) {
      const note: BrowserNote = { url, title: url, holder: "bot", loading: false };
      listeners.browser.forEach((callback) => callback(note));
      return url;
    },
    async browserBack() {},
    async browserForward() {},
    async browserHolder(holder) {
      listeners.browser.forEach((callback) => callback({ url: "https://example.com", title: "Example", holder, loading: false }));
    },
    onState(callback) {
      listeners.state.add(callback);
      return () => listeners.state.delete(callback);
    },
    onStep(callback) {
      listeners.step.add(callback);
      return () => listeners.step.delete(callback);
    },
    onTurn(_callback: (note: TurnNote) => void) {
      return () => {};
    },
    onStage(callback) {
      listeners.stage.add(callback);
      return () => listeners.stage.delete(callback);
    },
    onBrowser(callback) {
      listeners.browser.add(callback);
      return () => listeners.browser.delete(callback);
    },
    onDownload(callback) {
      listeners.download.add(callback);
      return () => listeners.download.delete(callback);
    },
  };
}

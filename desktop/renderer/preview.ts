import type { AppState, BrowserNote, ChatItem, DownloadNote, LibraryItem, SettingsPatch, SettingsView, StageNote, StepNote } from "./types.ts";

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
    async saveSettings(patch: SettingsPatch) {
      const settings: SettingsView = { ...state.settings, model: patch.model || state.settings.model, baseUrl: patch.baseUrl ?? state.settings.baseUrl, apiStyle: patch.apiStyle ?? state.settings.apiStyle, ready: true };
      state = { ...state, settings };
      publish();
      return settings;
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

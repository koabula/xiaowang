export {};

declare global {
  interface Window {
    xiaowang: {
      getState: () => Promise<AppState>;
      setActive: (slug: string) => Promise<void>;
      createBot: (name: string, baseline: string) => Promise<string>;
      renameBot: (slug: string, name: string) => Promise<void>;
      setAvatar: (slug: string, patch: { seed?: string; ink?: string }) => Promise<void>;
      forgetFile: (slug: string, id: string) => Promise<void>;
      events: (slug: string) => Promise<ChatItem[]>;
      library: (slug: string) => Promise<LibraryItem[]>;
      readFile: (slug: string, id: string) => Promise<Uint8Array>;
      addFiles: () => Promise<void>;
      ask: (slug: string, text: string) => Promise<ChatItem[]>;
      stop: (slug: string) => Promise<void>;
      saveSettings: (patch: SettingsPatch) => Promise<SettingsView>;
      listModels: (patch: SettingsPatch) => Promise<string[]>;
      checkSettings: (patch: SettingsPatch) => Promise<string>;
      browserBounds: (bounds: Bounds | null) => Promise<void>;
      browserGo: (url: string) => Promise<string>;
      browserBack: () => Promise<void>;
      browserForward: () => Promise<void>;
      browserHolder: (holder: "bot" | "user") => Promise<void>;
      onState: (callback: (state: AppState) => void) => () => void;
      onStep: (callback: (step: StepNote) => void) => () => void;
      onStage: (callback: (view: StageNote) => void) => () => void;
      onBrowser: (callback: (state: BrowserNote) => void) => () => void;
      onDownload: (callback: (note: DownloadNote) => void) => () => void;
    };
  }
}

export interface AppState {
  bots: BotRow[];
  activeSlug: string;
  settings: SettingsView;
}

export interface BotRow {
  slug: string;
  name: string;
  preview: string;
  avatarSeed: string;
  avatarInk: string;
}

export interface ChatItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "file" | "note";
  text: string;
  name?: string;
  isError?: boolean;
}

export interface LibraryItem {
  id: string;
  filename: string;
  byteSize: number;
}

export interface SettingsView {
  model: string;
  baseUrl: string;
  apiStyle: string;
  keyHint: string;
  searchProvider: string;
  searchUrl: string;
  searchKeyHint: string;
  ready: boolean;
}

export interface SettingsPatch {
  model?: string;
  baseUrl?: string;
  apiStyle?: string;
  apiKey?: string;
  searchKey?: string;
  searchUrl?: string;
  searchProvider?: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StepNote {
  slug: string;
  kind: "assistant" | "tool";
  name: string;
  text: string;
  isError: boolean;
  activity?: string;
}

export type StageNote = { slug: string } & (
  | { mode: "file"; id: string; filename: string; page: number }
  | { mode: "browser"; url: string }
  | { mode: "slides"; title: string; pages: string[] }
);

export interface BrowserNote {
  url: string;
  title: string;
  holder: "bot" | "user";
  loading: boolean;
}

export interface DownloadNote {
  slug?: string;
  id?: string;
  filename?: string;
  error?: string;
}

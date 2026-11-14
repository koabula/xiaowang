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
      pages: (slug: string) => Promise<CanvasPage[]>;
      openPage: (slug: string, path: string, page?: number) => Promise<{ title: string; html: string; page: number }>;
      addFiles: () => Promise<void>;
      ask: (slug: string, text: string) => Promise<ChatItem[]>;
      stop: (slug: string) => Promise<void>;
      saveSettings: (patch: SettingsPatch) => Promise<SettingsView>;
      listModels: (patch: SettingsPatch) => Promise<string[]>;
      checkSettings: (patch: SettingsPatch) => Promise<string>;
      openKeyPage: (service: string, region: string) => Promise<void>;
      browserBounds: (bounds: Bounds | null) => Promise<void>;
      browserGo: (url: string) => Promise<string>;
      browserBack: () => Promise<void>;
      browserForward: () => Promise<void>;
      browserHolder: (holder: "bot" | "user") => Promise<void>;
      callStart: (slug: string) => Promise<void>;
      callStop: () => Promise<void>;
      previewVoice: (patch: SettingsPatch) => Promise<void>;
      callAudio: (audio: string) => void;
      callIdle: (serial: number) => void;
      onState: (callback: (state: AppState) => void) => () => void;
      onStep: (callback: (step: StepNote) => void) => () => void;
      onTurn: (callback: (note: TurnNote) => void) => () => void;
      onStage: (callback: (view: StageNote) => void) => () => void;
      onBrowser: (callback: (state: BrowserNote) => void) => () => void;
      onDownload: (callback: (note: DownloadNote) => void) => () => void;
      onCall: (callback: (note: CallNote) => void) => () => void;
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
  kind: "user" | "assistant" | "tool" | "file" | "note" | "call";
  text: string;
  name?: string;
  isError?: boolean;
  lines?: Array<{ who: "user" | "assistant"; text: string }>;
  seconds?: number;
}

export interface LibraryItem {
  id: string;
  filename: string;
  byteSize: number;
}

export interface CanvasPage {
  path: string;
  name: string;
}

export interface SettingsView {
  model: string;
  baseUrl: string;
  apiStyle: string;
  keyHint: string;
  searchProvider: string;
  searchUrl: string;
  searchKeyHint: string;
  realtimeModel: string;
  realtimeUrl: string;
  realtimeKeyHint: string;
  realtimeService: string;
  realtimeVoice: string;
  realtimeRegion: string;
  realtimeWorkspace: string;
  locale: string;
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
  realtimeModel?: string;
  realtimeUrl?: string;
  realtimeKey?: string;
  realtimeService?: string;
  realtimeVoice?: string;
  realtimeRegion?: string;
  realtimeWorkspace?: string;
  locale?: string;
}

export interface CallNote {
  slug: string;
  phase: "connecting" | "live" | "closed" | "audio" | "interrupt" | "line" | "saved";
  detail?: string;
  who?: "user" | "assistant";
  text?: string;
  partial?: boolean;
  audio?: string;
  serial?: number;
  inputRate?: number;
  outputRate?: number;
  preview?: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TurnNote {
  slug: string;
  busy: boolean;
  error?: string;
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
  | { mode: "canvas"; title: string; html: string; page?: number }
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

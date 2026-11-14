import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SecretRecord {
  model: string;
  baseUrl: string;
  apiStyle: string;
  apiKey: string;
  realtimeModel: string;
  realtimeUrl: string;
  realtimeKey: string;
  realtimeService: string;
  realtimeVoice: string;
  realtimeRegion: string;
  realtimeWorkspace: string;
  locale: string;
}

export interface SecretPatch {
  model?: string;
  baseUrl?: string;
  apiStyle?: string;
  apiKey?: string;
  realtimeModel?: string;
  realtimeUrl?: string;
  realtimeKey?: string;
  realtimeService?: string;
  realtimeVoice?: string;
  realtimeRegion?: string;
  realtimeWorkspace?: string;
  locale?: string;
}

export interface SettingsView {
  model: string;
  baseUrl: string;
  apiStyle: string;
  keyHint: string;
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

const EMPTY: SecretRecord = {
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

function filePath(): string {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "secrets.bin");
}

export function loadSecrets(): SecretRecord {
  try {
    const raw = readFileSync(filePath());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
    const loaded = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(EMPTY).map(([key, fallback]) => [key, typeof loaded[key] === "string" ? loaded[key] : fallback])) as unknown as SecretRecord;
  } catch {
    return { ...EMPTY };
  }
}

export function mergeSecrets(current: SecretRecord, patch: SecretPatch): SecretRecord {
  const next: SecretRecord = { ...current };
  for (const key of Object.keys(patch) as (keyof SecretPatch)[]) {
    if (!Object.hasOwn(EMPTY, key)) continue;
    const value = patch[key];
    if (typeof value !== "string") continue;
    if ((key === "apiKey" || key === "realtimeKey") && !value.trim()) continue;
    if (key === "locale") {
      next.locale = value.trim() === "en" ? "en" : "zh";
      continue;
    }
    next[key] = value.trim();
  }
  const payload = JSON.stringify(next);
  const bytes = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(payload) : Buffer.from(payload);
  writeFileSync(filePath(), bytes);
  return next;
}

export function publicSettings(secrets: SecretRecord): SettingsView {
  const local = /localhost|127\.0\.0\.1/.test(secrets.baseUrl);
  return {
    model: secrets.model,
    baseUrl: secrets.baseUrl,
    apiStyle: secrets.apiStyle,
    keyHint: hint(secrets.apiKey),
    realtimeModel: secrets.realtimeModel,
    realtimeUrl: secrets.realtimeUrl,
    realtimeKeyHint: hint(secrets.realtimeKey),
    realtimeService: secrets.realtimeService,
    realtimeVoice: secrets.realtimeVoice,
    realtimeRegion: secrets.realtimeRegion,
    realtimeWorkspace: secrets.realtimeWorkspace,
    locale: secrets.locale === "en" ? "en" : "zh",
    ready: Boolean(secrets.model) && (Boolean(secrets.apiKey) || local),
  };
}

function hint(secret: string): string {
  if (!secret) return "";
  return `已保存 ····${secret.slice(-4)}`;
}

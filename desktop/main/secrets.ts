import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SecretRecord {
  model: string;
  baseUrl: string;
  apiStyle: string;
  apiKey: string;
  searchKey: string;
  searchUrl: string;
  searchProvider: string;
}

export interface SecretPatch {
  model?: string;
  baseUrl?: string;
  apiStyle?: string;
  apiKey?: string;
  searchKey?: string;
  searchUrl?: string;
  searchProvider?: string;
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

const EMPTY: SecretRecord = {
  model: "",
  baseUrl: "",
  apiStyle: "",
  apiKey: "",
  searchKey: "",
  searchUrl: "",
  searchProvider: "",
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
    return { ...EMPTY, ...(JSON.parse(json) as Partial<SecretRecord>) };
  } catch {
    return { ...EMPTY };
  }
}

export function mergeSecrets(current: SecretRecord, patch: SecretPatch): SecretRecord {
  const next: SecretRecord = { ...current };
  for (const key of Object.keys(patch) as (keyof SecretPatch)[]) {
    const value = patch[key];
    if (typeof value !== "string") continue;
    if ((key === "apiKey" || key === "searchKey") && !value.trim()) continue;
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
    searchProvider: secrets.searchProvider,
    searchUrl: secrets.searchUrl,
    searchKeyHint: hint(secrets.searchKey),
    ready: Boolean(secrets.model) && (Boolean(secrets.apiKey) || local),
  };
}

function hint(secret: string): string {
  if (!secret) return "";
  return `已保存 ····${secret.slice(-4)}`;
}

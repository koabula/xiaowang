import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EMPTY_SETTINGS, mergeSettings, readSettings, withoutSecretKeys, type SecretRecord, type SecretPatch } from "../../src/settings.ts";
export { publicSettings } from "../../src/settings.ts";
export type { SecretRecord, SecretPatch, SettingsView } from "../../src/settings.ts";
function filePath(): string {
  const dir = app.getPath("userData"); mkdirSync(dir, { recursive: true }); return path.join(dir, "secrets.bin");
}
export function loadSecrets(): SecretRecord {
  try {
    const raw = readFileSync(filePath()); let loaded: unknown;
    try { loaded = JSON.parse(raw.toString("utf8")); } catch { loaded = JSON.parse(safeStorage.decryptString(raw)); }
    return readSettings(loaded);
  } catch { return readSettings(EMPTY_SETTINGS); }
}
export function mergeSecrets(current: SecretRecord, patch: SecretPatch): SecretRecord {
  const encrypt = safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  const next = mergeSettings(current, patch), persisted = encrypt ? next : withoutSecretKeys(next), payload = JSON.stringify(persisted);
  const bytes = encrypt ? safeStorage.encryptString(payload) : Buffer.from(payload);
  const destination = filePath(), temporary = `${destination}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
  return persisted;
}

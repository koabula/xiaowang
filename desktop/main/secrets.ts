import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EMPTY_SETTINGS, mergeSettings, readSettings, type SecretRecord, type SecretPatch } from "../../src/settings.ts";
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
  const next = mergeSettings(current, patch), payload = JSON.stringify(next);
  const bytes = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(payload) : Buffer.from(payload);
  const destination = filePath(), temporary = `${destination}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
  return next;
}

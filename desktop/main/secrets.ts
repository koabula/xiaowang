import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EMPTY_SETTINGS, mergeSettings, readSettings, withoutSecretKeys, type SecretRecord, type SecretPatch } from "../../src/settings.ts";
export { publicSettings } from "../../src/settings.ts";
export type { SecretRecord, SecretPatch, SettingsView } from "../../src/settings.ts";
function filePath(name = "secrets.bin"): string {
  const dir = app.getPath("userData"); mkdirSync(dir, { recursive: true }); return path.join(dir, name);
}
const localMacSettings = "settings.local.json";
let encryptedLegacy: Buffer | undefined;
export function needsKeyMigration(): boolean { return encryptedLegacy !== undefined; }

export function loadSecrets(): SecretRecord {
  const mac = process.platform === "darwin";
  const local = mac && existsSync(filePath(localMacSettings));
  try {
    const raw = readFileSync(local ? filePath(localMacSettings) : filePath());
    try { return readSettings(JSON.parse(raw.toString("utf8"))); }
    catch {
      if (!mac) {
        try { return readSettings(JSON.parse(safeStorage.decryptString(raw))); }
        catch { return readSettings(EMPTY_SETTINGS); }
      }
      if (!local) encryptedLegacy = raw;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readSettings(EMPTY_SETTINGS);
}

export function migrateLegacySecrets(): SecretRecord {
  if (!encryptedLegacy) throw new Error("没有待迁移的旧设置。");
  let previous: SecretRecord;
  try { previous = readSettings(JSON.parse(safeStorage.decryptString(encryptedLegacy))); }
  catch { throw new Error("未能读取旧密钥。可以再次允许钥匙串访问，或在设置中重新填写。"); }
  return mergeSecrets(previous, {});
}
export function mergeSecrets(current: SecretRecord, patch: SecretPatch): SecretRecord {
  const mac = process.platform === "darwin";
  const encrypt = !mac && safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
  const next = mergeSettings(current, patch), persisted = mac || encrypt ? next : withoutSecretKeys(next), payload = JSON.stringify(persisted);
  const bytes = encrypt ? safeStorage.encryptString(payload) : Buffer.from(payload);
  const destination = mac ? filePath(localMacSettings) : filePath(), temporary = `${destination}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
  encryptedLegacy = undefined;
  return persisted;
}

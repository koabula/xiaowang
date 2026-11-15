import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSettings, readSettings, publicSettings } from "../src/settings.ts";
import { resolveRealtime } from "../src/realtime-catalog.ts";
import { hasUnsavedSettings } from "../desktop/renderer/settings-draft.ts";

test("legacy voice key migrates only to its provider; switching and restarting restore independent profiles", () => {
  const original = readSettings({ realtimeService: "doubao", realtimeKey: "doubao-secret", realtimeVoice: "zh_male_m191_uranus_bigtts" });
  const moss = mergeSettings(original, { realtimeService: "moss" });
  assert.equal(moss.realtimeKey, ""); assert.equal(moss.realtimeProfiles?.doubao?.key, "doubao-secret");
  const saved = mergeSettings(moss, { realtimeKey: "moss-secret", realtimeVoice: "account-voice-77" });
  const restarted = readSettings(JSON.parse(JSON.stringify(saved)));
  const back = mergeSettings(restarted, { realtimeService: "doubao", realtimeKey: "" });
  assert.equal(back.realtimeKey, "doubao-secret"); assert.equal(back.realtimeVoice, "zh_male_m191_uranus_bigtts");
  const again = mergeSettings(back, { realtimeService: "moss" });
  assert.equal(again.realtimeKey, "moss-secret"); assert.equal(again.realtimeVoice, "account-voice-77");
  assert.equal(original.realtimeProfiles?.moss, undefined, "Previews must not mutate saved records");
});
test("all edited provider drafts save together, blank keys retain their own key, and removal is explicit", () => {
  const saved = mergeSettings(readSettings({ realtimeService: "doubao", realtimeKey: "D" }), {
    realtimeService: "moss", realtimeProfiles: { moss: { key: "M", voice: "custom" }, openai: { key: "O", voice: "cedar" }, qwen: { key: "Q", region: "singapore" } },
  });
  const blank = mergeSettings(saved, { realtimeKey: "", realtimeProfiles: { doubao: { key: "" }, moss: { key: "" } } });
  assert.equal(blank.realtimeKey, "M"); assert.equal(blank.realtimeProfiles?.doubao?.key, "D");
  const removed = mergeSettings(blank, { realtimeProfiles: { moss: { key: "", clearKey: true } } });
  assert.equal(removed.realtimeKey, ""); assert.equal(mergeSettings(removed, { realtimeService: "openai" }).realtimeKey, "O");
  assert.equal(mergeSettings(removed, { realtimeService: "qwen" }).realtimeRegion, "singapore");
  assert.equal(mergeSettings(removed, { realtimeService: "doubao" }).realtimeKey, "D");
});
test("public settings expose provider-specific hints but no plaintext keys", () => {
  const saved = mergeSettings(readSettings({ apiKey: "text-private", realtimeService: "doubao", realtimeKey: "doubao-private" }), { realtimeService: "moss", realtimeKey: "moss-private" });
  const view = publicSettings(saved), json = JSON.stringify(view);
  for (const key of ["text-private", "doubao-private", "moss-private"]) assert.equal(json.includes(key), false);
  assert.match(view.realtimeProfiles?.doubao?.keyHint ?? "", /已保存/);
  assert.match(view.realtimeProfiles?.moss?.keyHint ?? "", /已保存/);
});
test("MOSS account voice IDs survive normalization and explicit provider choices override old URLs", () => {
  assert.equal(resolveRealtime({ service: "doubao", url: "wss://api.mosi.cn/v1/realtime" }).service, "doubao");
  assert.equal(resolveRealtime({ service: "moss", voice: "new-account-voice" }).voice, "new-account-voice");
  const current = readSettings({ realtimeService: "moss", realtimeKey: "M", realtimeProfiles: { moss: { voice: "dynamic", key: "M" }, unrelated: { key: "ignored" } } });
  assert.equal(current.realtimeVoice, "dynamic"); assert.equal(Object.hasOwn(current.realtimeProfiles!, "unrelated"), false);
});
test("unsaved provider drafts include inactive edits and explicit key removal", () => {
  const saved = { model: "test", realtimeService: "doubao", realtimeProfiles: { doubao: { key: "" }, moss: { key: "", voice: "a" } } };
  assert.equal(hasUnsavedSettings(structuredClone(saved), saved), false);
  assert.equal(hasUnsavedSettings({ ...saved, realtimeProfiles: { ...saved.realtimeProfiles, moss: { key: "typed-key", voice: "a" } } }, saved), true);
  assert.equal(hasUnsavedSettings({ ...saved, realtimeProfiles: { ...saved.realtimeProfiles, moss: { key: "", voice: "a", clearKey: true } } }, saved), true);
});

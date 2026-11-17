import assert from "node:assert/strict";
import { test } from "node:test";
import { availableRealtimeSettings, mergeSettings, readSettings, publicSettings, settingsPatchForSave, withoutSecretKeys } from "../src/settings.ts";
import { realtimeServicesForSettings, resolveRealtime } from "../src/realtime-catalog.ts";
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

test("suspended MOSS is absent from normal settings while its implementation remains opt-in", () => {
  assert.deepEqual(realtimeServicesForSettings().map(item => item.id), ["qwen", "openai", "doubao", "gemini"]);
  assert.ok(realtimeServicesForSettings(true).some(item => item.id === "moss"));
  assert.equal(resolveRealtime({ service: "moss" }).model, "moss-live-1.0");
});
test("suspended MOSS selection restores an available profile and preserves both providers' credentials", () => {
  const old = readSettings({ realtimeService: "moss", realtimeKey: "M", realtimeVoice: "custom-moss", realtimeProfiles: { doubao: { key: "D", voice: "zh_male_m191_uranus_bigtts" } } });
  const next = availableRealtimeSettings(old);
  assert.equal(next.realtimeService, "doubao"); assert.equal(next.realtimeKey, "D"); assert.equal(next.realtimeVoice, "zh_male_m191_uranus_bigtts");
  assert.equal(next.realtimeProfiles?.moss?.key, "M"); assert.equal(next.realtimeProfiles?.moss?.voice, "custom-moss");
  assert.equal(old.realtimeService, "moss", "Migration must be pure");
  const restarted = availableRealtimeSettings(readSettings(JSON.parse(JSON.stringify(mergeSettings(next, { locale: "en" })))));
  assert.equal(restarted.realtimeKey, "D"); assert.equal(restarted.realtimeProfiles?.moss?.key, "M");
  assert.equal(availableRealtimeSettings(old, true), old);
});
test("a MOSS-only account falls back to an unconfigured provider without borrowing its key", () => {
  const old = readSettings({ realtimeUrl: "wss://api.mosi.cn/v1/realtime", realtimeKey: "M" });
  const next = availableRealtimeSettings(old);
  assert.equal(next.realtimeService, "qwen"); assert.equal(next.realtimeKey, "");
  assert.equal(next.realtimeProfiles?.moss?.key, "M"); assert.equal(publicSettings(next).realtimeKeyHint, "");
  assert.ok(!next.realtimeUrl.includes("mosi"));
  assert.equal(availableRealtimeSettings(next), next);
});

test("text keys follow normalized service origins across paths, switches, defaults and restart", () => {
  const a = readSettings({ baseUrl: "https://A.example:443/v1", apiKey: "key-A", model: "fixture" });
  assert.equal(mergeSettings(a, { baseUrl: "https://a.example/api/v2" }).apiKey, "key-A");
  const b = mergeSettings(a, { baseUrl: "https://b.example/v1", apiKey: "" });
  assert.equal(b.apiKey, ""); assert.equal(a.apiKey, "key-A");
  const saved = readSettings(JSON.parse(JSON.stringify(mergeSettings(b, { apiKey: "key-B" }))));
  assert.equal(mergeSettings(saved, { baseUrl: "https://a.example/v1" }).apiKey, "key-A");
  assert.equal(mergeSettings(saved, { baseUrl: "http://b.example/v1" }).apiKey, "");
  assert.equal(mergeSettings(saved, { baseUrl: "https://b.example:444/v1" }).apiKey, "");
  const official = readSettings({ apiKey: "openai-key", model: "gpt-fixture" });
  assert.equal(mergeSettings(official, { model: "claude-fixture" }).apiKey, "");
  const json = JSON.stringify(publicSettings(saved));
  for (const key of ["key-A", "key-B", "textKeys"]) assert.ok(!json.includes(key));
});

test("saving unchanged runtime drafts excludes environment values and all inactive voice keys", () => {
  const saved = readSettings({ model: "stored", baseUrl: "https://a.example/v1", apiKey: "saved-A", realtimeService: "openai", realtimeKey: "saved-voice" });
  const runtime = mergeSettings(saved, { model: "temporary-model", apiKey: "temporary-text", realtimeKey: "temporary-voice" });
  const views = publicSettings(runtime, saved);
  assert.match(views.keyHint, /仅本次使用/); assert.match(views.realtimeKeyHint, /仅本次使用/);
  const patch = { model: runtime.model, baseUrl: runtime.baseUrl, apiStyle: runtime.apiStyle, apiKey: "", locale: "en", realtimeService: runtime.realtimeService,
    realtimeModel: runtime.realtimeModel, realtimeVoice: runtime.realtimeVoice, realtimeKey: "", realtimeProfiles: { openai: { ...runtime.realtimeProfiles!.openai!, key: "" } } };
  const persisted = mergeSettings(saved, settingsPatchForSave(runtime, patch));
  assert.equal(persisted.model, "stored"); assert.equal(persisted.locale, "en");
  assert.equal(persisted.apiKey, "saved-A"); assert.equal(persisted.realtimeKey, "saved-voice");
  assert.ok(!JSON.stringify(persisted).includes("temporary-"));
  const edited = mergeSettings(saved, settingsPatchForSave(runtime, { baseUrl: "https://b.example", apiKey: "explicit-key" }));
  assert.equal(edited.apiKey, "explicit-key"); assert.equal(edited.baseUrl, "https://b.example");
  const stripped = withoutSecretKeys(runtime);
  assert.ok(!JSON.stringify(stripped).includes("saved-A")); assert.ok(!JSON.stringify(stripped).includes("temporary-" + "text"));
  assert.equal(stripped.apiKey, ""); assert.equal(stripped.realtimeProfiles?.openai?.key, "");
  assert.equal(runtime.apiKey, "temporary-text", "Stripping disk data does not erase the running session");
  const switched = mergeSettings(saved, { baseUrl: "https://environment.example/v1", realtimeService: "qwen", realtimeKey: "temporary-qwen" });
  const bound = mergeSettings(saved, settingsPatchForSave(switched, { apiKey: "entered-text", realtimeKey: "entered-qwen" }));
  assert.equal(bound.baseUrl, "https://environment.example/v1"); assert.equal(bound.apiKey, "entered-text");
  assert.equal(bound.textKeys?.["https://a.example"], "saved-A");
  assert.equal(bound.realtimeService, "qwen"); assert.equal(bound.realtimeProfiles?.openai?.key, "saved-voice");
  assert.equal(bound.realtimeKey, "entered-qwen");
});

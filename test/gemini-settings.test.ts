import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSettings, publicSettings, readSettings } from "../src/settings.ts";
import { modelsFor, resolveRealtime, voicesFor } from "../src/realtime-catalog.ts";
import { realtimeEndpoint, realtimeInstructions, socketUrl, voiceTools } from "../src/realtime.ts";
import { geminiSession } from "../src/gemini-session.ts";

test("Gemini uses its native endpoint and preserves its own key, model and all prebuilt voices", () => {
  const first = readSettings({ realtimeService: "doubao", realtimeKey: "doubao-private", realtimeProfiles: { gemini: { key: "gemini-private", voice: "Sulafat" } } });
  const switched = mergeSettings(first, { realtimeService: "gemini" });
  assert.equal(switched.realtimeKey, "gemini-private"); assert.equal(switched.realtimeVoice, "Sulafat");
  assert.equal(switched.realtimeModel, "gemini-3.8-live");
  const restarted = readSettings(JSON.parse(JSON.stringify(mergeSettings(switched, { realtimeService: "doubao" }))));
  assert.equal(restarted.realtimeKey, "doubao-private"); assert.equal(restarted.realtimeProfiles?.gemini?.key, "gemini-private");
  assert.equal(JSON.stringify(publicSettings(switched)).includes("gemini-private"), false);
  assert.equal(mergeSettings(readSettings({ realtimeService: "doubao", realtimeKey: "only-doubao" }), { realtimeService: "gemini" }).realtimeKey, "");
  const choice = resolveRealtime({ service: "gemini" });
  const endpoint = realtimeEndpoint({ url: choice.url, model: choice.model, family: choice.service });
  assert.equal(endpoint.inputRate, 16000); assert.equal(endpoint.outputRate, 24000); assert.equal(endpoint.family, "gemini");
  assert.equal(new URL(socketUrl(endpoint)).search, ""); assert.equal(voicesFor("gemini", choice.model).length, 30);
  assert.deepEqual(modelsFor("gemini").map(item => item.id), ["gemini-3.8-live"]);
});

test("Gemini exposes no continuation tool, keeps background calls non-blocking and preserves context verbatim", () => {
  const brief = "上下文资料：我们在论文中讨论 continue_speaking 这个名字。";
  const session = geminiSession(realtimeInstructions("小王", brief, "zh", true), voiceTools([]), "Kore", "gemini-3.8-live");
  assert.ok(String(session.instructions).includes(brief));
  const tools = session.tools as Array<{ name: string; behavior?: string; parameters?: Record<string, unknown> }>;
  assert.equal(tools.some(tool => tool.name === "continue_speaking"), false);
  assert.equal(tools.find(tool => tool.name === "delegate_task")?.behavior, "NON_BLOCKING");
  assert.equal(tools.find(tool => tool.name === "get_task")?.behavior, undefined);
  assert.equal(tools.find(tool => tool.name === "delegate_task")?.parameters?.additionalProperties, undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { contextPolicy, inputCapacity, watermarks, validatePolicy } from "../src/token-budget.ts";
import { contextEnvironment, readSettings, mergeSettings, publicSettings } from "../src/settings.ts";
import { hasUnsavedSettings } from "../desktop/renderer/settings-draft.ts";

test("research budget uses independent 32K/96K input watermarks with output/safety reserves", () => {
  const conservative = contextPolicy({});
  assert.equal(conservative.windowTokens, 32768); assert.equal(inputCapacity(conservative), 26624);
  const research = contextPolicy({ XIAOWANG_CONTEXT_PROFILE: "research" });
  assert.equal(research.windowTokens, 131072); assert.equal(inputCapacity(research), 118784);
  assert.deepEqual(watermarks(research), { high: 98304, low: 32768 });
  assert.equal(research.outputTokens, 8192); assert.equal(research.safetyTokens, 4096);
  assert.deepEqual(watermarks(contextPolicy({ XIAOWANG_CONTEXT_PROFILE: "research", XIAOWANG_MAX_OUTPUT_TOKENS: "16384" })), { high: 98304, low: 32768 });
  const custom = contextPolicy({ XIAOWANG_CONTEXT_PROFILE: "research", XIAOWANG_MAX_OUTPUT_TOKENS: "16384", XIAOWANG_CONTEXT_HIGH_WATER_TOKENS: "90000", XIAOWANG_CONTEXT_LOW_WATER_TOKENS: "24000" });
  assert.deepEqual(watermarks(custom), { high: 90000, low: 24000 });
});

test("model context caps limit research budgets; invalid/oversubscribed budgets fail before inference", () => {
  const small = contextPolicy({ XIAOWANG_CONTEXT_PROFILE: "research", XIAOWANG_MODEL_CONTEXT_WINDOW: "32768" });
  assert.equal(small.windowTokens, 32768); assert.ok(watermarks(small).high <= inputCapacity(small));
  assert.ok(watermarks(small).low < watermarks(small).high);
  for (const env of [
    { XIAOWANG_CONTEXT_PROFILE: "other" }, { XIAOWANG_CONTEXT_LOW_WATER_TOKENS: "30000" },
    { XIAOWANG_CONTEXT_HIGH_WATER_TOKENS: "99999" }, { XIAOWANG_CONTEXT_WINDOW: "-1" },
    { XIAOWANG_MODEL_CONTEXT_WINDOW: "4096" }, { XIAOWANG_CONTEXT_LOW_WATER_TOKENS: "1.5" },
    { XIAOWANG_MODEL_CONTEXT_WINDOW: "NaN" },
  ]) assert.throws(() => contextPolicy(env));
  assert.throws(() => validatePolicy({ ...small, lowWaterTokens: 20000, highWaterTokens: 10000 }));
});

test("desktop budget profiles persist separately from voice service and count as unsaved changes", () => {
  const original = readSettings({ realtimeService: "doubao", realtimeKey: "secret" });
  const patch = { contextProfile: "research", contextHighWater: "90000", contextLowWater: "24000", contextOutput: "12000", modelContextWindow: "131072" };
  const saved = mergeSettings(original, patch), restarted = readSettings(JSON.parse(JSON.stringify(saved)));
  assert.equal(restarted.contextHighWater, "90000"); assert.equal(restarted.contextProfile, "research");
  assert.equal(mergeSettings(restarted, { realtimeService: "openai" }).contextLowWater, "24000");
  assert.equal(publicSettings(restarted).contextOutput, "12000");
  assert.equal(hasUnsavedSettings(patch, {}), true); assert.equal(hasUnsavedSettings(patch, patch), false);
  const env = contextEnvironment(restarted, { XIAOWANG_CONTEXT_HIGH_WATER_TOKENS: "80000", XIAOWANG_CONTEXT_SAFETY_TOKENS: "5000" });
  assert.equal(env.XIAOWANG_CONTEXT_HIGH_WATER_TOKENS, "90000"); assert.equal(env.XIAOWANG_CONTEXT_SAFETY_TOKENS, "5000");
  assert.equal(contextPolicy(env).windowTokens, 131072);
  assert.equal(contextEnvironment(mergeSettings(saved, { contextHighWater: "" }), {}).XIAOWANG_CONTEXT_HIGH_WATER_TOKENS, undefined);
  assert.throws(() => mergeSettings(original, { contextHighWater: "invalid" }));
  assert.equal(original.realtimeKey, "secret"); assert.equal(original.contextProfile, "");
});

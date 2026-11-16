import assert from "node:assert/strict";
import { test } from "node:test";
import { contextPolicy, inputCapacity, watermarks } from "../src/token-budget.ts";
import { limitsFromMetadata, resolveModelLimits } from "../src/model-limits.ts";
import { contextEnvironment, readSettings, mergeSettings, publicSettings } from "../src/settings.ts";
import { createProvider } from "../src/provider.ts";

test("automatic 128K backend budget ignores all legacy profile and parameter values", () => {
  const policy = contextPolicy({ XIAOWANG_CONTEXT_PROFILE: "conservative", XIAOWANG_CONTEXT_WINDOW: "4096", XIAOWANG_MAX_OUTPUT_TOKENS: "invalid" });
  assert.equal(policy.windowTokens, 131072);
  assert.equal(inputCapacity(policy), 118784);
  assert.deepEqual(watermarks(policy), { high: 98304, low: 32768 });
  const small = contextPolicy({}, { context: 8192, output: 1024, input: 6000 });
  assert.equal(inputCapacity(small), 6000); assert.equal(small.outputTokens, 1024);
  assert.ok(watermarks(small).low < watermarks(small).high);
  assert.ok(small.windowTokens <= 8192);
  assert.equal(contextPolicy({}, { context: 1000000 }).windowTokens, 131072);
});

test("upgrade discards saved budgets including invalid legacy values without affecting credentials", () => {
  const settings = readSettings({ contextProfile: "conservative", contextOutput: "invalid", contextWindow: "32768", realtimeService: "doubao", realtimeKey: "secret" });
  assert.equal(settings.contextProfile, undefined);
  const saved = mergeSettings(settings, { contextProfile: "research", contextOutput: "12" });
  assert.equal(publicSettings(saved).contextOutput, undefined);
  assert.equal(saved.realtimeKey, "secret");
  assert.deepEqual(contextEnvironment(saved, { XIAOWANG_CONTEXT_WINDOW: "4096" }), {});
});

test("endpoint metadata constrains input, output and total independently and is cached per model/credentials", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ data: [
    { id: "large", context_length: 1000000, top_provider: { max_completion_tokens: 16384 } },
    { id: "small", context_window: 16384, max_output_tokens: 1000 },
  ] }); });
  const config = { baseUrl: "https://budget-fixture.invalid/v1", apiKey: "a", apiStyle: "openai" as const, model: "large" };
  const large = createProvider(config); await large.resolveContextPolicy!();
  assert.equal(large.contextPolicy!.windowTokens, 131072);
  await createProvider(config).resolveContextPolicy!(); assert.equal(requests, 1);
  const small = createProvider({ ...config, model: "small" }); await small.resolveContextPolicy!();
  assert.equal(small.contextPolicy!.windowTokens, 16384); assert.equal(small.contextPolicy!.outputTokens, 1000);
  await resolveModelLimits({ ...config, apiKey: "b" }); assert.equal(requests, 3);
  assert.deepEqual(limitsFromMetadata({ inputTokenLimit: 10000, outputTokenLimit: 500 }), { context: undefined, input: 10000, output: 500 });
  assert.equal(limitsFromMetadata({ context_length: -1 }), undefined);
});

test("unknown deployments fall back to 32K while verified official models use their actual limits", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 404 }));
  const config = { baseUrl: "https://unknown-budget.invalid/v1", apiKey: "a", apiStyle: "openai", model: "gpt-4.1" };
  assert.equal((await resolveModelLimits(config)).context, 32768);
  assert.equal((await resolveModelLimits({ ...config, baseUrl: "https://api.openai.com/v1" })).context, 1047576);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveModelLimits(config, controller.signal), /abort/i);
});

test("text, sub bot and delegated voice turns resolve the same automatic policy before projection", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { Runtime } = await import("../src/runtime.ts");
  const { runTurn } = await import("../src/harness.ts");
  const home = mkdtempSync(`${tmpdir()}/xw-auto-entry-`), runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  const root = runtime.activeBot(), child = runtime.store.createBot({ slug: "budget-child", name: "child", systemPrompt: "analyze" });
  let completions = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ data: [{ id: "entry-fixture", context_length: 262144 }] });
    const body = JSON.parse(String(init.body)); assert.equal(body.max_tokens, 8192); completions++;
    return Response.json({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
  });
  for (const [botId, channel] of [[root.id, "text"], [child.id, "text"], [child.id, "voice"]] as const) {
    await runTurn(runtime, { botId, channel, input: "analyze", provider: createProvider({ apiStyle: "openai", baseUrl: "https://entry-budget.invalid/v1", apiKey: "test", model: "entry-fixture" }) });
    const scope = runtime.store.getEvents(botId).findLast(({ event }) => event.type === "context_scope")!.event;
    assert.equal(scope.type === "context_scope" && scope.policy.windowTokens, 131072);
  }
  assert.equal(completions, 3);
});

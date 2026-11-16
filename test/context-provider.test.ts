import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider, toAnthropicMessages, toOpenAIMessages } from "../src/provider.ts";

const messages = [{ role: "user" as const, content: "first" }, { role: "user" as const, content: "second" }];
const request = { system: "stable", messages, tools: [], maxOutputTokens: 777, preserveMessageBlocks: true, cacheKey: "epoch-key" };
function stream(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("managed adapter payloads preserve user block prefixes and request output limits", async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 80 } } });
  });
  const provider = createProvider({ apiStyle: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "test", model: "test" });
  const result = await provider.complete(request);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 12, cacheReadTokens: 80 });
  assert.equal(bodies[0]?.max_tokens, 777);
  assert.equal(bodies[0]?.prompt_cache_key, "epoch-key");
  assert.deepEqual(bodies[0]?.messages, toOpenAIMessages("stable", messages, true));
  const before = toAnthropicMessages(messages, true);
  assert.deepEqual(toAnthropicMessages([...messages, { role: "user", content: "third" }], true).slice(0, before.length), before);
  await createProvider({ apiStyle: "openai", baseUrl: "https://proxy.invalid/v1", apiKey: "test", model: "test" }).complete(request);
  assert.equal(bodies[1]?.prompt_cache_key, undefined);
});

test("OpenAI usage-only stream frames and DeepSeek cache fields are retained", async t => {
  let index = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)).stream_options, { include_usage: true });
    return stream([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage: index++ === 0
      ? { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } }
      : { prompt_tokens: 200, completion_tokens: 20, prompt_cache_hit_tokens: 150 } }, "[DONE]"]);
  });
  const provider = createProvider({ apiStyle: "openai", baseUrl: "https://proxy.invalid/v1", apiKey: "test", model: "test" });
  assert.deepEqual((await provider.complete({ ...request, onTextDelta() {} })).usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 });
  assert.deepEqual((await provider.complete({ ...request, onTextDelta() {} })).usage, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 });
});

test("Anthropic native count and streaming cache reads/writes include all billed input", async t => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (String(url).endsWith("count_tokens")) return Response.json({ input_tokens: 240 });
    return stream([
      { type: "message_start", message: { usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 150 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", usage: { output_tokens: 20 } }, { type: "message_stop" },
    ]);
  });
  const provider = createProvider({ apiStyle: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "test", model: "test" });
  assert.equal(await provider.countTokens!(request), 240);
  assert.equal(bodies[0]?.max_tokens, undefined);
  assert.deepEqual(bodies[0]?.messages, toAnthropicMessages(messages, true));
  const result = await provider.complete({ ...request, onTextDelta() {} });
  assert.deepEqual(bodies[1]?.cache_control, { type: "ephemeral" });
  assert.equal(bodies[1]?.max_tokens, 777);
  assert.deepEqual(result.usage, { inputTokens: 240, outputTokens: 20, cacheReadTokens: 150, cacheWriteTokens: 50 });
  const proxy = createProvider({ apiStyle: "anthropic", baseUrl: "https://proxy.invalid", apiKey: "test", model: "test", promptCaching: false });
  assert.equal(proxy.countTokens, undefined);
  await proxy.complete({ ...request, onTextDelta() {} });
  assert.equal(bodies[2]?.cache_control, undefined);
});

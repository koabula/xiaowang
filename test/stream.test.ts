import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider } from "../src/provider.ts";
import { readEventStream } from "../src/stream.ts";

function sse(lines: unknown[], event = "") {
  const source = lines.map(line => `${event ? `event: ${event}\n` : ""}data: ${typeof line === "string" ? line : JSON.stringify(line)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
const config = { apiStyle: "openai" as const, baseUrl: "http://localhost/v1", apiKey: "test-key", model: "fixture" };

test("SSE parser preserves UTF-8 boundaries, CRLF, comments and multiline data", async () => {
  const events = [];
  for await (const event of readEventStream(sse(["中文", "[DONE]"]))) events.push(event.data);
  assert.deepEqual(events, ["中文", "[DONE]"]);
  const response = new Response(": ping\nevent: content\ndata: first\ndata: second\n\n");
  const result = []; for await (const event of readEventStream(response)) result.push(event);
  assert.deepEqual(result, [{ event: "content", data: "first\nsecond" }]);
});

test("OpenAI streams text and assembles split tool arguments before executing them", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return sse([
      { choices: [{ delta: { content: "你好" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { content: "，我来查。", tool_calls: [{ index: 0, function: { arguments: '"notes.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, "[DONE]",
    ]);
  });
  let streamed = "";
  const result = await createProvider(config).complete({ system: "s", messages: [], tools: [], onTextDelta: text => { streamed += text; } });
  assert.equal(streamed, "你好，我来查。"); assert.equal(result.text, streamed); assert.deepEqual(result.toolCalls[0], { id: "call_1", name: "read_file", arguments: '{"path":"notes.md"}' });
});

test("Anthropic streams text and typed tool blocks", async t => {
  t.mock.method(globalThis, "fetch", async () => sse([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正在核对" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.md"}' } },
    { type: "message_stop" },
  ]));
  let text = ""; const result = await createProvider({ ...config, apiStyle: "anthropic" }).complete({ system: "s", messages: [], tools: [], onTextDelta: delta => { text += delta; } });
  assert.equal(text, "正在核对"); assert.equal(result.toolCalls[0]?.arguments, '{"path":"a.md"}');
});

test("incomplete streams fail rather than executing partial tools", async t => {
  t.mock.method(globalThis, "fetch", async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "write_file", arguments: '{"path":' } }] } }] }]));
  await assert.rejects(createProvider(config).complete({ system: "s", messages: [], tools: [], onTextDelta() {} }), /提前断开/);
});

test("stop aborts the actual pending model request", async t => {
  let observed: AbortSignal | null = null;
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    observed = init?.signal as AbortSignal;
    observed.addEventListener("abort", () => reject(observed?.reason), { once: true });
  }));
  const controller = new AbortController();
  const result = createProvider(config).complete({ system: "s", messages: [], tools: [], signal: controller.signal });
  controller.abort(); await assert.rejects(result); assert.ok(observed); assert.equal((observed as AbortSignal).aborted, true);
});

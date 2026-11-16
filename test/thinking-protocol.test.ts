import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProvider, toAnthropicMessages, toOpenAIMessages } from "../src/provider.ts";
import { Runtime } from "../src/runtime.ts";
import { runTurn } from "../src/harness.ts";
import { ContextManager, contextUsage } from "../src/context-manager.ts";
import { replayHistory } from "../src/protocol-history.ts";
import { memoryText } from "../src/memory.ts";
import { projectContextUnits, projectLlmContext } from "../src/project.ts";
import { measureRequest, DEFAULT_CONTEXT_POLICY } from "../src/token-budget.ts";
import type { AssistantProtocol, ModelMessage } from "../src/types.ts";

const config = { apiStyle: "openai" as const, baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-flash" };
const request = { system: "rules", tools: [], messages: [{ role: "user" as const, content: "hello" }] };
function sse(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(path.join(tmpdir(), "xw-thinking-"));
  let runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  return { get runtime() { return runtime; }, restart() { runtime.close(); runtime = Runtime.open(home); } };
}

test("DeepSeek reasoning survives streaming, tool execution, persistence, replay and process restart", async t => {
  const f = fixture(t), bot = f.runtime.activeBot();
  const provider = createProvider(config);
  let n = 0;
  const bodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    for (const message of body.messages) if (message.role === "assistant") assert.equal(typeof message.reasoning_content, "string", "the original HTTP 400 contract");
    if (n++ === 0) return sse([
      { choices: [{ delta: { reasoning_content: "先核对", content: null } }] },
      { choices: [{ delta: { reasoning_content: "文件。", tool_calls: [{ index: 0, id: "native-ID", function: { name: "list_files", arguments: "{  }" } }] }, finish_reason: "tool_calls" }] }, "[DONE]",
    ]);
    assert.equal(body.messages.find((m: any) => m.tool_calls)?.tool_calls[0].id, "native-ID");
    assert.equal(body.messages.find((m: any) => m.tool_calls)?.tool_calls[0].function.arguments, "{  }");
    assert.equal(body.messages.find((m: any) => m.role === "tool").tool_call_id, "native-ID");
    return Response.json({ choices: [{ message: { content: "完成", reasoning_content: n === 2 ? "核对完毕。" : "继续使用结果。" }, finish_reason: "stop" }], usage: { prompt_tokens: 250, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } } });
  });
  await runTurn(f.runtime, { botId: bot.id, input: "看下文件", provider, onTextDelta() {} });
  const events = f.runtime.store.getEvents(bot.id);
  const assistant = events.find(({ event }) => event.type === "assistant_turn")!;
  assert.equal(assistant.event.type === "assistant_turn" && assistant.event.protocol?.reasoningContent, "先核对文件。");
  assert.match(assistant.event.type === "assistant_turn" ? assistant.event.toolCalls[0]!.id : "", /^xw_/);
  assert.doesNotMatch(memoryText(assistant), /先核对文件/);
  assert.equal(f.runtime.store.searchMemory(bot.id, "先核对文件").length, 0);
  const units = projectContextUnits(events);
  assert.equal(units.find(unit => unit.source === String(assistant.id))!.messages[0]!.protocol?.reasoningContent, "先核对文件。");
  const legacy = projectLlmContext(bot, events);
  assert.equal(legacy.messages.find(message => message.role === "assistant")?.protocol?.reasoningContent, "先核对文件。");
  f.restart();
  await runTurn(f.runtime, { botId: bot.id, input: "接着说", provider: createProvider(config) });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].messages.find((m: any) => m.content === "完成").reasoning_content, "核对完毕。");
  assert.equal(f.runtime.store.getEvents(bot.id).filter(({ event }) => event.type === "tool_result").length, 1);
  assert.equal(contextUsage(f.runtime.store, bot.id).reasoningTokens, 24);
});

test("legacy thinking history becomes deterministic historical data without inventing traces or rerunning tools", async t => {
  const { runtime } = fixture(t), bot = runtime.activeBot();
  runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "已保存", toolCalls: [{ id: "old", name: "write_file", input: { path: "saved.md", content: "saved" } }] });
  runtime.store.append(bot.id, { type: "tool_result", callId: "old", name: "write_file", output: "OLD-SUCCESS", isError: false });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages.some((m: any) => m.role === "tool" || m.role === "assistant"), false);
    const history = body.messages.find((m: any) => m.content.includes("OLD-SUCCESS"));
    assert.match(history.content, /不要因为恢复历史而重复执行/);
    assert.equal(history.reasoning_content, undefined);
    return Response.json({ choices: [{ message: { content: "文件之前已保存", reasoning_content: "采用历史成功结果" } }] });
  });
  await runTurn(runtime, { botId: bot.id, input: "之前完成了吗", provider: createProvider(config) });
  assert.equal(runtime.store.getEvents(bot.id).filter(({ event }) => event.type === "tool_result").length, 1);
});

test("empty reasoning is preserved; opaque details stream by index and never appear in text deltas", async t => {
  const shown: string[] = [];
  t.mock.method(globalThis, "fetch", async () => sse([
    { choices: [{ delta: { reasoning_content: "", reasoning_details: [{ index: 0, type: "reasoning.encrypted", data: "abc", format: "vendor" }] } }] },
    { choices: [{ delta: { reasoning_details: [{ index: 0, data: "def" }], content: "answer" }, finish_reason: "stop" }] }, "[DONE]",
  ]));
  const provider = createProvider(config), result = await provider.complete({ ...request, onTextDelta: text => shown.push(text) });
  assert.equal(result.protocol?.reasoningContent, "");
  assert.deepEqual(result.protocol?.reasoningDetails, [{ index: 0, type: "reasoning.encrypted", data: "abcdef", format: "vendor" }]);
  assert.deepEqual(shown, ["answer"]);
  const wire = toOpenAIMessages("", [{ role: "assistant", content: result.text, protocol: result.protocol }], true, provider.historyPolicy) as any[];
  assert.equal(wire[1].reasoning_content, ""); assert.equal(wire[1].reasoning_details[0].data, "abcdef");
});

test("Anthropic JSON and SSE retain complete signed/redacted thinking blocks and original tool ids", async t => {
  const provider = createProvider({ ...config, apiStyle: "anthropic", baseUrl: "https://proxy.invalid", model: "claude-test" });
  const blocks = [{ type: "thinking", thinking: "private", signature: "signed" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "checking" }, { type: "tool_use", id: "native", name: "list_files", input: {} }];
  let streamed = false;
  t.mock.method(globalThis, "fetch", async () => streamed ? sse([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "ned" } },
    ...blocks.slice(1).map((block, i) => ({ type: "content_block_start", index: i + 1, content_block: block })),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } } },
    { type: "message_stop" },
  ]) : Response.json({ content: blocks, stop_reason: "tool_use" }));
  const json = await provider.complete(request); streamed = true;
  const stream = await provider.complete({ ...request, onTextDelta() {} });
  assert.deepEqual(stream.protocol, json.protocol); assert.equal(stream.stopReason, "tool_use");
  assert.equal(stream.usage?.reasoningTokens, 30);
  const messages: ModelMessage[] = [{ role: "assistant", content: json.text, protocol: json.protocol, toolCalls: json.toolCalls }, { role: "tool", toolCallId: "native", content: "OK" }];
  const wire = toAnthropicMessages(messages, true, provider.historyPolicy) as any[];
  assert.deepEqual(wire[0].content, blocks); assert.equal(wire[1].content[0].tool_use_id, "native");
  const foreign = replayHistory(messages, createProvider(config).historyPolicy);
  assert.equal(foreign.length, 1); assert.equal(foreign[0]?.role, "user");
  assert.doesNotMatch(JSON.stringify(foreign), /private|signed|opaque/);
});

test("reasoning is counted as input, kept whole during deterministic projection, and replayed after checkpoints", async t => {
  const { runtime } = fixture(t), bot = runtime.activeBot(), provider = createProvider(config);
  const protocol: AssistantProtocol = { key: provider.historyPolicy!.key, format: "openai", reasoningContent: "reason ".repeat(1000) };
  const base = { system: "", tools: [], messages: [{ role: "assistant" as const, content: "OK" }] };
  assert.ok(measureRequest({ ...base, messages: [{ ...base.messages[0]!, protocol }] }, DEFAULT_CONTEXT_POLICY).input > measureRequest(base, DEFAULT_CONTEXT_POLICY).input + 1000);
  const old = runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "old", protocol, toolCalls: [{ id: "local", wireId: "wire", name: "read_file", arguments: "{}", input: {} }] });
  runtime.store.append(bot.id, { type: "tool_result", assistantEventId: old.id, callId: "local", name: "read_file", output: "output ".repeat(1000), isError: false });
  const goal = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "current" });
  const active = { ...provider, contextPolicy: { ...DEFAULT_CONTEXT_POLICY, windowTokens: 4096, outputTokens: 256, safetyTokens: 256, highWaterTokens: 1500, lowWaterTokens: 800 } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", [], active);
  manager.ingest(runtime.store.getEvents(bot.id), [goal.id], []);
  const prepared = await manager.prepare(active);
  assert.doesNotMatch(JSON.stringify(prepared.request), /reason reason/);
  assert.equal(prepared.request.messages.some(m => m.role === "tool"), false);
  const restored = await new ContextManager(runtime.store, bot.id, "stable", [], active).prepare(active);
  assert.deepEqual(restored.request.messages, prepared.request.messages);
});

test("output exhaustion records reasoning/usage but never executes truncated tool calls", async t => {
  const { runtime } = fixture(t), bot = runtime.activeBot();
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "unfinished", tool_calls: [{ id: "bad", function: { name: "write_file", arguments: '{"path":"unsafe"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 4096 } }));
  await assert.rejects(runTurn(runtime, { botId: bot.id, input: "test", provider: createProvider(config) }), /输出预算/);
  const events = runtime.store.getEvents(bot.id);
  assert.equal(events.some(({ event }) => event.type === "tool_result"), false);
  assert.ok(events.some(({ event }) => event.type === "assistant_turn" && event.stopReason === "length" && event.protocol?.reasoningContent === "unfinished"));
  assert.equal(contextUsage(runtime.store, bot.id).outputTokens, 4096);
  assert.equal(contextUsage(runtime.store, bot.id).failures, 1);
});


test("an empty thinking-only answer is retained as protocol data and reported as incomplete", async t => {
  const { runtime } = fixture(t), bot = runtime.activeBot();
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "private-only" } }] }));
  await assert.rejects(runTurn(runtime, { botId: bot.id, input: "test", provider: createProvider(config) }), /没有返回可用的正文/);
  const saved = runtime.store.getEvents(bot.id).find(({ event }) => event.type === "assistant_turn");
  assert.equal(saved?.event.type === "assistant_turn" && saved.event.protocol?.reasoningContent, "private-only");
});

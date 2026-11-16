import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../src/runtime.ts";
import { runTurn } from "../src/harness.ts";
import { ContextManager, contextUsage } from "../src/context-manager.ts";
import { DEFAULT_CONTEXT_POLICY, measureRequest } from "../src/token-budget.ts";
import { projectContextUnits } from "../src/project.ts";
import type { CompletionRequest, LlmProvider } from "../src/types.ts";

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(path.join(tmpdir(), "xw-context-"));
  const runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  return { runtime, home, bot: runtime.activeBot() };
}
const result = (text: string) => ({ text, toolCalls: [] });
const policy = { ...DEFAULT_CONTEXT_POLICY, windowTokens: 4096, outputTokens: 256, safetyTokens: 256 };
const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }];

function seed(runtime: Runtime, botId: string, turns = 12) {
  for (let n = 0; n < turns; n++) {
    runtime.store.append(botId, { type: "user_text", channel: "text", text: `Read section ${n}` });
    runtime.store.append(botId, { type: "assistant_turn", channel: "text", text: Array.from({ length: 85 }, (_, i) => `evidence-${n}-${i}`).join(" "), toolCalls: [] });
  }
}

test("normal turns append stable blocks across task, library and voice-revision changes", async t => {
  const { runtime, bot } = fixture(t);
  const inputs: CompletionRequest[] = [];
  const provider: LlmProvider = { model: "test", async complete(request) { inputs.push(structuredClone({ ...request, signal: undefined })); return result("done"); } };
  await runTurn(runtime, { botId: bot.id, input: "first", provider });
  runtime.store.addLibraryBytes(bot.id, "new.md", Buffer.from("new reference"));
  runtime.store.append(bot.id, { type: "voice_line", callId: "phone", who: "user", text: "initial", itemId: "utterance" });
  await runTurn(runtime, { botId: bot.id, input: "second", provider });
  assert.equal(inputs[0]!.system, inputs[1]!.system);
  assert.deepEqual(inputs[1]!.messages.slice(0, inputs[0]!.messages.length), inputs[0]!.messages);
  assert.equal(inputs[1]!.messages.at(-1)!.content, "second");
  const previous = inputs[1]!.messages;
  runtime.store.append(bot.id, { type: "voice_line", callId: "phone", who: "user", text: "corrected", itemId: "utterance" });
  await runTurn(runtime, { botId: bot.id, input: "third", provider });
  assert.deepEqual(inputs[2]!.messages.slice(0, previous.length), previous);
  assert.ok(inputs[2]!.messages.some(message => message.content.includes("先前记录的更新") && message.content.includes("corrected")));
  assert.ok(runtime.store.getEvents(bot.id).some(({ event }) => event.type === "model_usage" && event.prefixTokens > 0));
  const stats = contextUsage(runtime.store, bot.id);
  assert.equal(stats.cacheReadTokens, null, "An unreported cache count stays unknown");
});

test("budget includes tools, all messages, images, output and safety", () => {
  const request = { system: "rules", tools, messages: [{ role: "user" as const, content: "hello", images: [{ mimeType: "image/png", data: "not tokenized base64" }] }], maxOutputTokens: 1024 };
  const budget = measureRequest(request, DEFAULT_CONTEXT_POLICY);
  assert.equal(budget.images, DEFAULT_CONTEXT_POLICY.imageTokens);
  assert.equal(budget.output, 1024);
  assert.equal(budget.total, budget.system + budget.tools + budget.messages + budget.images + budget.output + budget.safety);
  const more = measureRequest({ ...request, tools: [...tools, { ...tools[0]!, description: "long tool ".repeat(100) }] }, DEFAULT_CONTEXT_POLICY);
  assert.ok(more.tools > budget.tools);
});

test("watermark rebuild is deterministic, makes no inference, and replays exact manifests", async t => {
  const { runtime, bot } = fixture(t);
  seed(runtime, bot.id);
  const current = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "NEWEST-REQUEST" });
  let inference = 0;
  const provider: LlmProvider = { model: "test", contextPolicy: policy, async complete() { inference++; return result("ok"); } };
  const events = runtime.store.getEvents(bot.id);
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest(events, [current.id], []);
  const prepared = await manager.prepare(provider);
  assert.equal(inference, 0);
  assert.ok(prepared.budget.total <= policy.windowTokens);
  assert.match(prepared.request.messages[0]!.content, /search_memory/);
  assert.equal(prepared.request.messages.at(-1)?.content, "NEWEST-REQUEST");
  const checkpoint = runtime.store.getEvents(bot.id).findLast(({ event }) => event.type === "context_checkpoint")!.event;
  assert.ok(checkpoint.type === "context_checkpoint");
  assert.equal("summary" in checkpoint, false);
  assert.equal("blocks" in checkpoint, false, "A checkpoint stores references, not a second message history");
  assert.ok(checkpoint.entries.every(entry => entry.eventIds.length > 0));
  const restored = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  restored.ingest(runtime.store.getEvents(bot.id), [current.id], []);
  const recovered = await restored.prepare(provider);
  assert.deepEqual(recovered.request.messages, prepared.request.messages);
  assert.equal(recovered.request.cacheKey, prepared.request.cacheKey);
  const next = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "FOLLOWUP" });
  restored.ingest(runtime.store.getEvents(bot.id), [next.id], []);
  const after = (await restored.prepare(provider)).request;
  assert.deepEqual(after.messages.slice(0, prepared.request.messages.length), prepared.request.messages);
  assert.equal(after.messages.at(-1)?.content, "FOLLOWUP");
  assert.equal(projectContextUnits(runtime.store.getEvents(bot.id)).length, projectContextUnits(events).length + 1);
});

test("an oversized newest request fails before task inference and another bot has a separate context", async t => {
  const { runtime, bot } = fixture(t);
  let calls = 0;
  const provider: LlmProvider = { model: "test", contextPolicy: policy, async complete() { calls++; return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  const input = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "巨大的新输入".repeat(3000) });
  manager.ingest(runtime.store.getEvents(bot.id), [input.id], []);
  await assert.rejects(manager.prepare(provider), /超出上下文预算/);
  assert.equal(calls, 0);
  const other = runtime.store.createBot({ name: "Other", systemPrompt: "test" });
  const isolated = new ContextManager(runtime.store, other.id, "stable", tools, provider);
  isolated.ingest(runtime.store.getEvents(other.id), [], []);
  assert.equal((await isolated.prepare(provider)).request.messages.length, 0);
});

test("persistent model blocks omit transient pixels and usage is aggregated only from reported metrics", async t => {
  const { runtime, bot } = fixture(t);
  const provider: LlmProvider = { model: "test", async complete() { return { ...result("ok"), usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } }; } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest([], [], [{ key: "frame", message: { role: "user", content: "PAGE", images: [{ mimeType: "image/jpeg", data: "PRIVATE-PIXELS" }] } }]);
  await manager.complete(provider, await manager.prepare(provider));
  assert.doesNotMatch(JSON.stringify(runtime.store.getEvents(bot.id)), /PRIVATE-PIXELS/);
  const stats = contextUsage(runtime.store, bot.id);
  assert.equal(stats.cacheReadTokens, 80); assert.equal(stats.cacheReadRatio, 0.8); assert.equal(stats.cacheWriteTokens, null);
  const restored = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  const request = (await restored.prepare(provider)).request;
  assert.equal(request.messages[0]?.images, undefined);
  assert.match(request.messages[0]!.content, /临时页面画面只在当前进程内可用/);
});

test("cancellation during budget counting never commits a partial checkpoint", async t => {
  const { runtime, bot } = fixture(t);
  seed(runtime, bot.id);
  const controller = new AbortController(); let counts = 0;
  const provider: LlmProvider = { model: "test", contextPolicy: policy,
    async countTokens(request) { if (++counts === 2) controller.abort(); return measureRequest(request, policy).input; },
    async complete() { throw Error("Projection must never infer"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest(runtime.store.getEvents(bot.id), [], []);
  await assert.rejects(manager.prepare(provider, controller.signal), { name: "AbortError" });
  assert.equal(contextUsage(runtime.store, bot.id).checkpoints, 0);
  assert.equal(contextUsage(runtime.store, bot.id).requests, 0);
  const restored = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  restored.ingest(runtime.store.getEvents(bot.id), [], []);
  assert.ok((await restored.prepare(provider)).budget.total <= policy.windowTokens);
});

test("projection rebuild preserves consecutive unprocessed requirements and atomic tool pairs", async t => {
  const { runtime, bot } = fixture(t);
  seed(runtime, bot.id);
  runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "REQ-A" });
  runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "REQ-B" });
  runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "reading", toolCalls: [{ id: "pair", name: "read", input: {} }] });
  runtime.store.append(bot.id, { type: "tool_result", callId: "pair", name: "read", output: "TOOL-EVIDENCE", isError: false });
  const provider: LlmProvider = { model: "test", contextPolicy: policy, async complete() { return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest(runtime.store.getEvents(bot.id), [], []);
  const prepared = await manager.prepare(provider);
  assert.ok(prepared.request.messages.some(message => message.content === "REQ-A"));
  assert.ok(prepared.request.messages.some(message => message.content === "REQ-B"));
  const tool = prepared.request.messages.findIndex(message => message.role === "tool");
  assert.ok(tool > 0);
  assert.equal(prepared.request.messages[tool - 1]?.toolCalls?.[0]?.id, "pair");
  assert.equal(prepared.request.messages[tool]?.content, "TOOL-EVIDENCE");
});

test("supplements received during budget preparation enter the next task request together", async t => {
  const { runtime, bot } = fixture(t);
  seed(runtime, bot.id, 60);
  const updates: ReturnType<typeof runtime.store.getEvents> = [];
  let counts = 0;
  const tasks: CompletionRequest[] = [];
  const provider: LlmProvider = { model: "test",
    async countTokens(request) {
      if (counts++ === 0) for (const text of ["ADDITIONAL-A", "ADDITIONAL-B"]) updates.push(runtime.store.append(bot.id, { type: "user_text", channel: "text", text }));
      return measureRequest(request, DEFAULT_CONTEXT_POLICY).input;
    },
    async complete(request) { tasks.push(request); return result("done"); },
  };
  await runTurn(runtime, { botId: bot.id, input: "CURRENT-REQUEST", provider, readUpdates: () => ({ events: updates }) });
  assert.ok(counts > 1);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0]!.tools.length > 0, "There is no hidden summary call");
  assert.deepEqual(tasks[0]!.messages.filter(message => message.content.startsWith("ADDITIONAL-")).map(message => message.content), ["ADDITIONAL-A", "ADDITIONAL-B"]);
});

test("native counting controls the hard limit and changing model opens a separate scope", async t => {
  const { runtime, bot } = fixture(t);
  const provider: LlmProvider = { model: "test", contextPolicy: policy, countTokens: async () => 100, async complete() { return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest([], [], []);
  const prepared = await manager.prepare(provider);
  assert.equal(prepared.budget.method, "provider-count");
  assert.equal(prepared.budget.input, 100);
  assert.equal(prepared.budget.total, 100 + policy.outputTokens + policy.safetyTokens);
  assert.notEqual(new ContextManager(runtime.store, bot.id, "stable", tools, { ...provider, model: "other" }).scope, manager.scope);
});


test("latest exact task state survives rebuild and remains discoverable after restart", async t => {
  const { runtime, bot } = fixture(t);
  const provider: LlmProvider = { model: "test", contextPolicy: policy, async complete() { return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest([], [], [{ key: "task", message: { role: "user", content: "OLD-CONSTRAINT" } }]);
  seed(runtime, bot.id);
  const input = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "NEW-INPUT" });
  manager.ingest(runtime.store.getEvents(bot.id), [input.id], [{ key: "task", message: { role: "user", content: "EXACT-USER-CONSTRAINT-42" } }]);
  const prepared = await manager.prepare(provider);
  assert.ok(prepared.request.messages.some(message => message.content === "EXACT-USER-CONSTRAINT-42"));
  assert.ok(!prepared.request.messages.some(message => message.content === "OLD-CONSTRAINT"));
  const restored = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  assert.deepEqual((await restored.prepare(provider)).request.messages, prepared.request.messages);
});

test("changed page pixels append a new state instead of mutating an old prefix", async t => {
  const { runtime, bot } = fixture(t);
  const provider: LlmProvider = { model: "test", async complete() { return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  const page = (data: string) => [{ key: "page", message: { role: "user" as const, content: "same metadata", images: [{ mimeType: "image/jpeg", data }] } }];
  manager.ingest([], [], page("FRAME-A"));
  const first = (await manager.prepare(provider)).request;
  manager.ingest([], [], page("FRAME-B"));
  const second = (await manager.prepare(provider)).request;
  assert.deepEqual(second.messages[0], first.messages[0]);
  assert.equal(second.messages.at(-1)!.images?.[0]?.data, "FRAME-B");
});

test("an archived tool result remains readable through the actual agent tool loop", async t => {
  const { runtime, bot } = fixture(t);
  const call = runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "read original", toolCalls: [{ id: "old", name: "read_document", input: { file: "paper.pdf" } }] });
  const original = "long original evidence ".repeat(4000) + "EXACT-END-VALUE-731";
  const event = runtime.store.append(bot.id, { type: "tool_result", assistantEventId: call.id, callId: "old", name: "read_document", output: original, isError: false });
  seed(runtime, bot.id, 60);
  let calls = 0;
  const provider: LlmProvider = { model: "test", async complete(request) {
    assert.ok(request.tools.some(tool => tool.name === "inspect_event"));
    if (calls++ === 0) {
      assert.ok(!request.messages.some(message => message.content.includes("EXACT-END-VALUE-731")));
      return { text: "核对原始记录", toolCalls: [{ id: "look", name: "inspect_event", arguments: JSON.stringify({ event_id: event.id, offset: original.length - 19, limit: 100 }) }] };
    }
    assert.ok(request.messages.some(message => message.role === "tool" && message.content.includes("EXACT-END-VALUE-731")));
    return result("verified 731");
  } };
  const completed = await runTurn(runtime, { botId: bot.id, input: "Verify the old original value", provider });
  assert.equal(completed.finalText, "verified 731");
  assert.equal(calls, 2);
  assert.equal(runtime.store.memoryEvent(bot.id, event.id).event.type, "tool_result");
  assert.ok(contextUsage(runtime.store, bot.id).checkpoints > 0);
});

test("retrying an archived input appends the exact original requirement as the new focus", async t => {
  const { runtime, bot } = fixture(t);
  const original = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "ORIGINAL-RETRY-GOAL" });
  seed(runtime, bot.id);
  const current = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "OTHER-WORK" });
  const provider: LlmProvider = { model: "test", contextPolicy: policy, async complete() { return result("ok"); } };
  const manager = new ContextManager(runtime.store, bot.id, "stable", tools, provider);
  manager.ingest(runtime.store.getEvents(bot.id), [current.id], []);
  const before = (await manager.prepare(provider)).request;
  assert.ok(!before.messages.some(message => message.content === "ORIGINAL-RETRY-GOAL"));
  manager.ingest(runtime.store.getEvents(bot.id), [original.id], []);
  const after = (await manager.prepare(provider)).request;
  assert.equal(after.messages.at(-1)?.content, "ORIGINAL-RETRY-GOAL");
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
});

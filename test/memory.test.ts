import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../src/runtime.ts";
import { executeTool } from "../src/tools.ts";
import { projectContextUnits } from "../src/project.ts";
import { runTurn } from "../src/harness.ts";
import type { LlmProvider } from "../src/types.ts";

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(path.join(tmpdir(), "xw-memory-"));
  const runtime = Runtime.open(home), bot = runtime.activeBot();
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  return { runtime, bot, home, host: { store: runtime.store, bot, enqueueKickoff() {} } };
}

test("memory search supports Chinese, short queries, literal punctuation, types and pagination", async t => {
  const { runtime, bot, host } = fixture(t);
  const a = runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "注意力机制测试 needle \"quoted\" %_" });
  const b = runtime.store.append(bot.id, { type: "tool_result", callId: "x", name: "read", output: "注意力机制原文 needle", isError: false });
  runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "其他内容" });
  assert.deepEqual(runtime.store.searchMemory(bot.id, "注意力机制", { limit: 1 }).map(hit => hit.eventId), [a.id]);
  assert.deepEqual(runtime.store.searchMemory(bot.id, "注意力机制", { afterId: a.id }).map(hit => hit.eventId), [b.id]);
  assert.deepEqual(runtime.store.searchMemory(bot.id, "注意", { types: ["tool_result"] }).map(hit => hit.eventId), [b.id]);
  assert.deepEqual(runtime.store.searchMemory(bot.id, '"quoted" %_').map(hit => hit.eventId), [a.id]);
  const search = await executeTool("search_memory", { query: "needle", event_types: ["tool_result"] }, host);
  assert.equal(search.isError, false); assert.equal(JSON.parse(search.output).matches[0].eventId, b.id);
  for (const input of [{ query: "" }, { query: "x", event_types: ["model_usage"] }, { query: "x", limit: 0 }, { query: "x", after_id: "1" }]) assert.equal((await executeTool("search_memory", input, host)).isError, true);
});

test("inspect_event pages the original output without rerunning tools and enforces bot access", async t => {
  const { runtime, bot, host } = fixture(t);
  const text = "line-42\n".repeat(2000);
  const stored = runtime.store.append(bot.id, { type: "tool_result", callId: "original", name: "write_file", output: text, isError: false });
  const first = JSON.parse((await executeTool("inspect_event", { event_id: stored.id, limit: 71 }, host)).output);
  const second = JSON.parse((await executeTool("inspect_event", { event_id: stored.id, offset: first.nextOffset, limit: 71 }, host)).output);
  assert.equal(first.text + second.text, text.slice(0, 142));
  const other = runtime.store.createBot({ name: "Other", systemPrompt: "" });
  assert.deepEqual(runtime.store.searchMemory(other.id, "line-42"), []);
  const denied = await executeTool("inspect_event", { event_id: stored.id }, { ...host, bot: other });
  assert.equal(denied.isError, true); assert.doesNotMatch(denied.output, /line-42/);
  const internal = runtime.store.append(bot.id, { type: "context_append", projectorVersion: 1, scope: "x", epoch: 0, throughEventId: stored.id, entries: [], sources: {}, states: {}, pinned: [] });
  assert.equal((await executeTool("inspect_event", { event_id: internal.id }, host)).isError, true);
  assert.equal(runtime.store.getEvents(bot.id).filter(({ event }) => event.type === "tool_result").length, 1);
});

test("legacy duplicate tool ids resolve to the matching chronological invocation", t => {
  const { runtime, bot } = fixture(t);
  for (const output of ["FIRST-RESULT", "SECOND-RESULT"]) {
    runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "read", toolCalls: [{ id: "reused", name: "read", input: {} }] });
    runtime.store.append(bot.id, { type: "tool_result", callId: "reused", name: "read", output, isError: false });
  }
  const units = projectContextUnits(runtime.store.getEvents(bot.id));
  assert.equal(units[0]?.messages[1]?.content, "FIRST-RESULT");
  assert.equal(units[1]?.messages[1]?.content, "SECOND-RESULT");
  assert.notEqual(units[0]?.eventIds[1], units[1]?.eventIds[1]);
});

test("new executions generate distinct tool identities even if the provider repeats ids", async t => {
  const { runtime, bot } = fixture(t);
  let calls = 0;
  const provider: LlmProvider = { model: "test", async complete() {
    return calls++ % 2 === 0 ? { text: "check", toolCalls: [{ id: "same-vendor-id", name: "list_files", arguments: "{}" }] } : { text: "done", toolCalls: [] };
  } };
  await runTurn(runtime, { botId: bot.id, input: "first", provider });
  await runTurn(runtime, { botId: bot.id, input: "second", provider });
  const results = runtime.store.getEvents(bot.id).filter(({ event }) => event.type === "tool_result");
  assert.equal(results.length, 2);
  assert.ok(results.every(({ event }) => event.type === "tool_result" && event.assistantEventId));
  assert.notEqual(results[0]!.event.type === "tool_result" && results[0]!.event.callId, results[1]!.event.type === "tool_result" && results[1]!.event.callId);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";
import { JobQueue } from "../src/jobs.ts";

test("recent sidebar messages preserve whitespace, attachment and bot isolation rules across restart", t => {
  const home = mkdtempSync(path.join(tmpdir(), "xw-history-reads-"));
  let store = Store.open(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "first", systemPrompt: "" }), other = store.createBot({ name: "second", systemPrompt: "" });
  assert.equal(store.latestMessage(bot.id), undefined);
  const visible = store.append(bot.id, { type: "assistant_turn", channel: "text", text: "## 结论\n\n**有依据**", toolCalls: [] });
  store.append(bot.id, { type: "assistant_turn", channel: "text", text: "\n\t　\u00a0", toolCalls: [] });
  store.append(bot.id, { type: "tool_result", name: "read_document", callId: "read", output: "原文".repeat(1000), isError: false });
  store.append(other.id, { type: "user_text", channel: "text", text: "另一个课题" });
  assert.equal(store.latestMessage(bot.id)?.id, visible.id);
  const attached = store.append(bot.id, { type: "user_text", channel: "text", text: "", attachments: [{ refId: "file-fixture", filename: "原件.pdf", byteSize: 12, mimeType: "application/pdf" }] });
  store.append(bot.id, { type: "user_text", channel: "text", text: "\n", attachments: [] });
  assert.deepEqual(store.latestMessage(bot.id), attached);
  store.close(); store = Store.open(home);
  assert.deepEqual(store.latestMessage(bot.id), attached);
  const latest = store.append(bot.id, { type: "user_text", channel: "text", text: "新的问题" });
  assert.equal(store.latestMessage(bot.id)?.id, latest.id);
});

test("supplement lookup returns exact owned events in chronological order without loading unrelated history", t => {
  const home = mkdtempSync(path.join(tmpdir(), "xw-supplement-reads-")), store = Store.open(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "first", systemPrompt: "" }), other = store.createBot({ name: "second", systemPrompt: "" });
  const foreign = store.append(other.id, { type: "user_text", channel: "text", text: "不能混入" });
  const queue = new JobQueue(store, async () => ({ text: "" })), job = queue.enqueue({ botId: bot.id, task: "研究" });
  const getEvents = store.getEvents;
  store.getEvents = () => { throw new Error("Supplement checks must not scan full history"); };
  assert.deepEqual(queue.updates(job.id).events, []);
  queue.supplement(job.id, { botId: bot.id, task: "补充一" }); queue.supplement(job.id, { botId: bot.id, task: "补充二" });
  const updates = queue.updates(job.id).events;
  assert.deepEqual(updates.map(item => item.event.type === "user_text" && item.event.text), ["补充一", "补充二"]);
  assert.deepEqual(store.eventsByIds(bot.id, [updates[1]!.id, foreign.id, updates[0]!.id, updates[0]!.id, 999999]), updates);
  store.getEvents = getEvents;
});

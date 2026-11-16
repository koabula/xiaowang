import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../src/runtime.ts";
import { JobQueue } from "../src/jobs.ts";
import { isVoiceWorkRequest, VoiceTasks } from "../src/voice-tasks.ts";

test("voice work starts on explicit commands, not progress, quotations or stop requests", () => {
  for (const text of ["你去分析一下刚刚这篇文章。", "梳理刚刚获取的这篇文章", "帮我把刚刚那篇论文梳理一下", "Please analyze this paper", "Compare these papers"]) assert.ok(isVoiceWorkRequest(text), text);
  for (const text of ["梳理了吗？", "我们刚刚这篇文章的梳理出来了吗？", "分析进度怎么样？", "不要分析这篇论文", "Stop analyzing this paper", "现在打开这篇论文", "Hello", "作者说：分析这篇论文"]) assert.equal(isVoiceWorkRequest(text), false, text);
});

test("one research request owns one durable job across duplicate tool choices and interruptions", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "xw-voice-task-"));
  const runtime = Runtime.open(root);
  let finish!: (result: { text: string }) => void;
  const queue = new JobQueue(runtime.store, () => new Promise(resolve => { finish = resolve; }));
  t.after(() => { queue.shutdown(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const session = new VoiceTasks(queue, runtime.activeBot().id, "call", text => `${text}\n原文 id=paper`);
  queue.start();
  const accepted = session.userText("你去分析一下刚刚这篇文章。");
  assert.ok(accepted); await Promise.resolve();
  assert.equal(session.delegate("分析论文", "model-call-1", "when_idle").id, accepted.id);
  assert.equal(queue.list().length, 1);
  assert.equal(session.userText("梳理了吗？"), null);
  assert.equal(session.latest()?.status, "running");
  assert.equal(session.delegate("查询分析结果", "mistaken-progress-delegation", "when_idle").id, accepted.id);
  assert.equal(queue.list().length, 1);
  assert.equal(session.userText("现在打开这篇论文"), null);
  finish({ text: "基于原文的分析结果" });
  assert.equal((await queue.wait(accepted.id)).result, "基于原文的分析结果");
  assert.equal(session.latest()?.status, "succeeded");
  assert.equal(queue.list().length, 1);
  const next = session.userText("梳理了吗？对比另一篇论文");
  assert.ok(next); assert.notEqual(next.id, accepted.id);
});

test("voice supplements text work, explicit queue creates another task, and progress never adds an input", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "xw-voice-supplement-"));
  const runtime = Runtime.open(root);
  const queue = new JobQueue(runtime.store, async () => ({ text: "unused" }));
  t.after(() => { queue.shutdown(); runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const botId = runtime.activeBot().id;
  const original = queue.enqueue({ botId, task: "Analyze", channel: "text" });
  const session = new VoiceTasks(queue, botId, "call", text => text);
  session.userText("补充，重点看实验", false);
  assert.equal(queue.list().length, 1);
  assert.equal(queue.updates(original.id).events.length, 1);
  assert.equal(session.delegate("重点看实验", "tool-1", "when_idle").id, original.id);
  assert.equal(queue.updates(original.id).events.length, 1);
  session.userText("进度怎么样？");
  assert.equal(queue.updates(original.id).events.length, 1);
  session.userText("还有一个要求", false);
  const appended = session.delegate("只要摘要，不用笔记", "tool-2", "when_idle");
  assert.equal(appended.id, original.id);
  session.delegate("重复工具", "tool-3", "when_idle");
  assert.equal(queue.updates(original.id).events.length, 2);
  session.userText("做完再帮我查另一篇", false);
  const separate = session.delegate("Find another paper", "tool-4", "when_idle", true);
  assert.notEqual(separate.id, original.id);
  assert.equal(queue.list().length, 2);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JobQueue } from "../src/jobs.ts";
import { Runtime } from "../src/runtime.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function home(t: { after(fn: () => void): void }) { const root = mkdtempSync(path.join(os.tmpdir(), "xw-jobs-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("jobs persist snapshots, serialize within a workspace and run across workspaces", async t => {
  const runtime = Runtime.open(home(t)); t.after(() => runtime.close());
  const first = runtime.activeBot(); const second = runtime.store.createBot({ name: "Other", systemPrompt: "test" });
  const starts: string[] = []; const releases = new Map<string, () => void>();
  const queue = new JobQueue(runtime.store, async job => { starts.push(job.task); await new Promise<void>(resolve => releases.set(job.task, resolve)); return { text: `done:${job.task}` }; });
  t.after(() => queue.shutdown()); queue.start();
  const a = queue.enqueue({ botId: first.id, task: "a", sourceCallId: "once" });
  const b = queue.enqueue({ botId: first.id, task: "b" });
  const c = queue.enqueue({ botId: second.id, task: "c" }); await tick();
  assert.deepEqual(starts, ["a", "c"]); assert.equal(queue.get(b.id).status, "queued");
  assert.equal(queue.enqueue({ botId: first.id, task: "duplicate", sourceCallId: "once" }).id, a.id);
  const snapshots = runtime.store.getEvents(first.id).filter(item => item.event.type === "job");
  assert.equal(snapshots[0]?.event.type === "job" && snapshots[0].event.job.status, "queued");
  releases.get("a")!(); await queue.wait(a.id); await tick(); assert.deepEqual(starts, ["a", "c", "b"]);
  releases.get("b")!(); releases.get("c")!();
  assert.equal((await queue.wait(b.id)).result, "done:b"); assert.equal((await queue.wait(c.id)).status, "succeeded");
});

test("cancelling queued jobs never runs them and running work receives AbortSignal", async t => {
  const runtime = Runtime.open(home(t)); t.after(() => runtime.close());
  let cancelled = false; let runs = 0;
  const queue = new JobQueue(runtime.store, async (_job, signal) => { runs++; await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true })); return { text: "never" }; });
  t.after(() => queue.shutdown()); queue.start();
  const a = queue.enqueue({ botId: runtime.activeBot().id, task: "a" });
  const b = queue.enqueue({ botId: runtime.activeBot().id, task: "b" }); await tick();
  queue.cancel(b.id); queue.cancel(a.id); await tick();
  assert.equal(cancelled, true); assert.equal(runs, 1); assert.equal((await queue.wait(a.id)).status, "cancelled"); assert.equal(queue.get(b.id).status, "cancelled");
});

test("restart recovers queued work but never replays an interrupted mutation automatically", async t => {
  const root = home(t); let runtime = Runtime.open(root);
  const botId = runtime.activeBot().id;
  const base = { id: "in-flight", botId, task: "write", channel: "voice" as const, notify: "when_idle" as const, status: "running" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activity: "writing", result: "", error: "", attempts: 1, artifacts: [] };
  runtime.store.append(botId, { type: "job", job: base });
  runtime.store.append(botId, { type: "job", job: { ...base, id: "pending", task: "queued", status: "queued" } });
  runtime.close(); runtime = Runtime.open(root); t.after(() => runtime.close());
  const ran: string[] = [];
  const queue = new JobQueue(runtime.store, async job => { ran.push(job.id); return { text: "ok" }; }); t.after(() => queue.shutdown());
  assert.equal(queue.get("in-flight").status, "interrupted"); queue.start(); await queue.wait("pending");
  assert.deepEqual(ran, ["pending"]);
  queue.retry("in-flight"); await queue.wait("in-flight"); assert.deepEqual(ran, ["pending", "in-flight"]);
});

test('display metadata and canonical reply links survive progress and restart', async t => {
  const root = home(t); let runtime = Runtime.open(root);
  const botId = runtime.activeBot().id; let queue: JobQueue;
  queue = new JobQueue(runtime.store, async current => {
    queue.linkInput(current.id, 100);
    return { text: 'canonical reply', resultEventId: 101, artifacts: ['notes/result.md'] };
  });
  queue.start();
  const chat = queue.enqueue({ botId, task: 'hi' });
  const background = queue.enqueue({ botId, task: '整理备忘录，包含环境与步骤', channel: 'voice', originCallId: 'phone' });
  await queue.wait(chat.id); const completed = await queue.wait(background.id);
  assert.equal(queue.get(chat.id).display, 'conversation');
  assert.equal(completed.display, 'background'); assert.equal(completed.title, '整理备忘录');
  assert.equal(completed.originEventId, 100); assert.equal(completed.resultEventId, 101); assert.equal(completed.originCallId, 'phone');
  queue.shutdown(); runtime.close(); runtime = Runtime.open(root);
  const restored = new JobQueue(runtime.store, async () => ({ text: 'never' }));
  t.after(() => { restored.shutdown(); runtime.close(); });
  assert.equal(restored.get(background.id).resultEventId, 101);
  assert.equal(restored.get(background.id).display, 'background');
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../src/runtime.ts";
import { JobQueue } from "../src/jobs.ts";
import { runTurn } from "../src/harness.ts";
import { VoiceTasks } from "../src/voice-tasks.ts";
import type { CompletionResult, LlmProvider, ModelMessage } from "../src/types.ts";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function home(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), "xw-supplements-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const answer = (text: string): CompletionResult => ({ text, toolCalls: [] });

test("rapid text and voice supplements join one turn after an in-flight answer, queued work stays separate", async t => {
  const runtime = Runtime.open(home(t));
  t.after(() => runtime.close());
  const firstRequest = deferred<void>(), firstAnswer = deferred<CompletionResult>();
  const inputs: ModelMessage[][] = [];
  const provider: LlmProvider = {
    model: "fixture",
    async complete(input) {
      inputs.push(structuredClone(input.messages));
      if (inputs.length === 1) { firstRequest.resolve(); return firstAnswer.promise; }
      return answer(inputs.length === 2 ? "Combined research" : "Separate work");
    },
  };
  const finals: string[] = [];
  const queue = new JobQueue(runtime.store, async (job, signal) => {
    const result = await runTurn(runtime, {
      botId: job.botId, input: job.task, inputEventId: job.originEventId, jobId: job.id,
      channel: job.channel, provider, signal,
      excludeJobIds: queue.list(job.botId).filter(other => other.id !== job.id && other.status === "queued").map(other => other.id),
      readUpdates: () => queue.updates(job.id),
      onStep: step => { if (step.final) finals.push(step.text); },
    });
    return { text: result.finalText };
  });
  t.after(() => queue.shutdown());
  queue.start();
  const botId = runtime.activeBot().id;
  const first = queue.submit({ botId, task: "Analyze this paper" });
  await firstRequest.promise;
  const revision = queue.submit({ botId, task: "Focus on the experiments" });
  assert.equal(revision.id, first.id);
  const voice = new VoiceTasks(queue, botId, "phone", text => text);
  voice.userText("补充，简短一点", false);
  const separate = queue.submit({ botId, task: "SEPARATE-TRANSLATION" }, true);
  assert.equal(queue.list().length, 2);
  assert.equal(separate.status, "queued");
  const users = runtime.store.getEvents(botId).filter(item => item.event.type === "user_text");
  assert.equal(users.length, 4, "Messages persist immediately while work is running");
  firstAnswer.resolve(answer("An answer generated before the supplements"));
  assert.equal((await queue.wait(first.id)).result, "Combined research");
  await queue.wait(separate.id);
  const combined = inputs[1]!.map(message => message.content).join("\n");
  assert.match(combined, /Focus on the experiments/);
  assert.match(combined, /简短一点/);
  assert.doesNotMatch(combined, /SEPARATE-TRANSLATION/);
  assert.deepEqual(finals, ["Combined research", "Separate work"]);
  assert.equal(runtime.store.getEvents(botId).filter(item => item.event.type === "user_text").length, 4, "Each input is recorded once");
});

test("supplements arriving during a tool call are batched before the next model call with images", async t => {
  const runtime = Runtime.open(home(t)); t.after(() => runtime.close());
  const entered = deferred<void>(), release = deferred<string>();
  const image = runtime.store.addLibraryBytes(runtime.activeBot().id, "sample.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")).ref;
  const attachment = { refId: image.id, filename: image.filename, mimeType: "image/png", byteSize: 68 };
  const requests: ModelMessage[][] = [];
  const provider: LlmProvider = { model: "fixture", async complete(input) {
    requests.push(structuredClone(input.messages));
    if (requests.length === 1) return { text: "", toolCalls: [{ id: "browse", name: "browser_snapshot", arguments: "{}" }] };
    return answer("Updated");
  }};
  const queue = new JobQueue(runtime.store, async (job, signal) => {
    const result = await runTurn(runtime, {
      botId: job.botId, input: job.task, inputEventId: job.originEventId, jobId: job.id,
      provider, signal, readUpdates: () => queue.updates(job.id),
      browser: { snapshot: async () => { entered.resolve(); return release.promise; } } as any,
    });
    return { text: result.finalText };
  });
  t.after(() => queue.shutdown()); queue.start();
  const botId = runtime.activeBot().id, job = queue.submit({ botId, task: "Research" });
  await entered.promise;
  queue.submit({ botId, task: "Use this image", attachments: [attachment] });
  queue.submit({ botId, task: "Also compare latency" });
  release.resolve("Actual page");
  await queue.wait(job.id);
  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.some(message => message.role === "tool" && message.content.includes("Actual page")));
  assert.ok(requests[1]!.some(message => message.content.includes("Also compare latency")));
  assert.ok(requests[1]!.some(message => message.content.includes("Use this image") && message.images?.length));
});

test("queued supplements survive restart, deduplicate delivery, and cancellation prevents further execution", async t => {
  const dir = home(t);
  let runtime = Runtime.open(dir);
  const botId = runtime.activeBot().id;
  let queue = new JobQueue(runtime.store, async () => ({ text: "unused" }));
  const job = queue.submit({ botId, task: "Original" });
  queue.submit({ botId, task: "Supplement", sourceCallId: "once" });
  queue.submit({ botId, task: "Supplement", sourceCallId: "once" });
  assert.equal(queue.updates(job.id).events.length, 1);
  queue.shutdown(); runtime.close();
  runtime = Runtime.open(dir);
  t.after(() => runtime.close());
  queue = new JobQueue(runtime.store, async current => {
    assert.equal(queue.updates(current.id).events.length, 1);
    return { text: "Recovered" };
  });
  queue.start();
  assert.equal((await queue.wait(job.id)).result, "Recovered");
  assert.equal(queue.submit({ botId, task: "retry duplicate", sourceCallId: "once" }).id, job.id);
  assert.equal(queue.list().length, 1);
  queue.shutdown();
  assert.throws(() => queue.submit({ botId, task: "late" }), /关闭/);
});

test("cancelling stops an in-flight turn and retry retains its supplements exactly once", async t => {
  const runtime = Runtime.open(home(t)); t.after(() => runtime.close());
  const entered = deferred<void>(), release = deferred<CompletionResult>();
  let calls = 0;
  const provider: LlmProvider = { model: "fixture", async complete(input) {
    calls++;
    if (calls === 1) { entered.resolve(); return release.promise; }
    assert.equal(input.messages.filter(message => message.content === "Keep this correction").length, 1);
    return answer("Resumed with correction");
  }};
  const queue = new JobQueue(runtime.store, async (job, signal) => {
    const result = await runTurn(runtime, {
      botId: job.botId, input: job.task, inputEventId: job.originEventId, jobId: job.id, provider, signal,
      readUpdates: () => queue.updates(job.id),
    });
    return { text: result.finalText };
  });
  t.after(() => queue.shutdown()); queue.start();
  const botId = runtime.activeBot().id;
  const job = queue.submit({ botId, task: "Original task" });
  await entered.promise;
  queue.submit({ botId, task: "Keep this correction" });
  queue.cancel(job.id);
  release.resolve(answer("Stale response"));
  assert.equal((await queue.wait(job.id)).status, "cancelled");
  queue.retry(job.id);
  assert.equal((await queue.wait(job.id)).result, "Resumed with correction");
  assert.equal(calls, 2);
});

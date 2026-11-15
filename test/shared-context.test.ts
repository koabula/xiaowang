import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SharedContexts, supportsRealtimeVision, type VisualInput } from "../src/shared-context.ts";
import { VisualQueue } from "../src/visual-queue.ts";
import { Runtime } from "../src/runtime.ts";
import { runTurn } from "../src/harness.ts";
import { JobQueue } from "../src/jobs.ts";
import type { CompletionRequest } from "../src/types.ts";

const frame = (key: string): VisualInput => ({ key, refId: "pdf", filename: "paper.pdf", page: 1, revision: 1, mimeType: "image/jpeg", data: "pixel-bytes" });
test("workspace snapshots isolate bots, reject stale frames and never confuse job revisions with view revisions", () => {
  const shared = new SharedContexts();
  const first = shared.view("a", { path: "pdf", filename: "paper.pdf", mode: "file", page: 1, totalPages: 3, visible: true });
  const message = shared.message("a", "question", []);
  assert.equal(message.viewRevision, first.viewRevision); assert.ok(message.revision > first.revision);
  assert.equal(shared.matches("a", "pdf", 1, first.viewRevision), true);
  shared.view("a", { ...first.view!, page: 2 });
  assert.equal(shared.matches("a", "pdf", 1, first.viewRevision), false);
  assert.equal(shared.matches("b", "pdf", 2, shared.get("a").viewRevision), false);
  const detached = shared.get("a"); detached.view!.page = 99; assert.equal(shared.get("a").view!.page, 2);
  shared.restore("a", shared.get("a")); assert.equal(shared.get("a").view!.visible, false, "Restart must not claim an old page is visible");
  assert.equal(supportsRealtimeVision("doubao"), false); for (const provider of ["gemini", "openai", "qwen"]) assert.equal(supportsRealtimeVision(provider), true);
});

test("visual queue limits frames to 1 fps, discards superseded pages and cancels pending sends at hangup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  let ready = true; const sent: string[] = [];
  const queue = new VisualQueue(() => ready, image => sent.push(image.key), () => {});
  assert.equal(await queue.add([frame("view:1")]), true);
  const stale = queue.add([frame("view:2")]), latest = queue.add([frame("view:3")]);
  assert.equal(await stale, false); t.mock.timers.tick(999); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); assert.equal(await latest, true); assert.deepEqual(sent, ["view:1", "view:3"]);
  assert.equal(await queue.add([frame("view:3")]), true); assert.equal(sent.length, 2, "Repeated receipts do not resend bytes");
  queue.replay(); t.mock.timers.tick(1000); assert.deepEqual(sent, ["view:1", "view:3", "view:3"], "Reconnect replays only current page");
  ready = false; const pending = queue.add([frame("view:4")]); queue.close(); assert.equal(await pending, false);
  t.mock.timers.tick(10000); assert.equal(sent.length, 3);
  const revoked: string[] = []; const second = new VisualQueue(() => true, image => revoked.push(image.key), () => {});
  await second.add([frame("message:pdf")]); second.forget("pdf"); second.replay(); t.mock.timers.tick(1000); assert.equal(revoked.length, 1, "Removed sources cannot replay after reconnect"); second.close();
});

test("queued jobs freeze shared references, hydrate image pixels and keep PDF frames out of persisted events", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "xw-shared-")); const runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  const bot = runtime.activeBot(), shared = new SharedContexts();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const ref = runtime.store.addLibraryBytes(bot.id, "image.png", png).ref;
  const snapshot = shared.message(bot.id, "previous image", [{ refId: ref.id, filename: ref.filename, byteSize: ref.byteSize, mimeType: "image/png" }]);
  shared.message(bot.id, "a follow-up without attachments", []); assert.equal(shared.get(bot.id).imageAttachments?.[0]?.refId, ref.id);
  shared.view(bot.id, { path: "different", filename: "other.pdf", page: 8, totalPages: 9, mode: "file", visible: true });
  let received: CompletionRequest | undefined;
  const queue = new JobQueue(runtime.store, async job => {
    await runTurn(runtime, { botId: bot.id, input: job.task, sharedContext: job.sharedContext, sharedImages: [{ mimeType: "image/jpeg", data: "CURRENT-PDF-PIXELS" }], provider: { model: "fixture", async complete(req) { received = req; return { text: "done", toolCalls: [] }; } } });
    return { text: "done" };
  });
  const job = queue.enqueue({ botId: bot.id, task: "analyze", sharedContext: snapshot }); snapshot.message!.text = "mutated";
  queue.start(); await queue.wait(job.id);
  assert.ok(received); assert.equal(received.messages.at(-1)?.content, "analyze", "Context must not replace the user's current request or follow tool outputs");
  const context = received.messages.find(m => m.content.includes("previous image"))!;
  assert.equal(context.images!.length, 2, "Hydration must retain both PDF frame and image attachment");
  shared.revoke(bot.id, ref.id); assert.deepEqual(shared.get(bot.id).imageAttachments, []);
  assert.equal(context.images![0]!.data, "CURRENT-PDF-PIXELS"); assert.equal(context.images![1]!.data, png.toString("base64"));
  assert.equal(context.content.includes("other.pdf"), false, "A queued job owns the snapshot accepted at delegation");
  const events = JSON.stringify(runtime.store.getEvents(bot.id)); assert.equal(events.includes("CURRENT-PDF-PIXELS"), false); assert.equal(events.includes(png.toString("base64")), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../src/runtime.ts";
import { attachmentMime, hydrateImages, resolveAttachments } from "../src/attachments.ts";
import { runTurn } from "../src/harness.ts";
import { JobQueue } from "../src/jobs.ts";
import { toAnthropicMessages, toOpenAIMessages } from "../src/provider.ts";
import type { CompletionRequest, ModelMessage } from "../src/types.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
test("attachments reach both image APIs without losing images when adjacent user turns merge", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "first", images: [{ mimeType: "image/png", data: "a" }] }, { role: "user", content: "second", images: [{ mimeType: "image/jpeg", data: "b" }] }];
  const openai = toOpenAIMessages("test", messages) as any[];
  assert.deepEqual(openai[1].content.map((p: any) => p.type), ["text", "image_url", "image_url"]);
  assert.equal(openai[1].content[2].image_url.url, "data:image/jpeg;base64,b");
  const anthropic = toAnthropicMessages(messages) as any[];
  assert.deepEqual(anthropic[0].content.map((p: any) => p.type), ["image", "image", "text"]);
  assert.equal(anthropic[0].content[0].source.media_type, "image/png");
  assert.equal(messages[0]!.images!.length, 1, "Projection does not mutate stored history");
});
test("queued attachment-only messages retain references across restart and load actual image bytes for the model", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "xw-attach-")); let runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  const bot = runtime.activeBot(), other = runtime.store.createBot({ name: "Other", systemPrompt: "" });
  const image = runtime.store.addLibraryBytes(bot.id, "screenshot.png", png).ref;
  const doc = runtime.store.addLibraryBytes(bot.id, "attached.md", Buffer.from("# actual document\nCONTENT-42")).ref;
  const attachments = resolveAttachments(runtime.store, bot.id, [image.id, doc.id, image.id]);
  assert.equal(attachments.length, 2);
  assert.throws(() => resolveAttachments(runtime.store, other.id, [image.id]), /没有这份/);
  assert.throws(() => resolveAttachments(runtime.store, bot.id, Array(9).fill(image.id)), /8/);
  let request: CompletionRequest | undefined;
  let queue = new JobQueue(runtime.store, async () => ({ text: "unused" }));
  const job = queue.enqueue({ botId: bot.id, task: "请查看这些附件。", messageText: "", attachments });
  runtime.close(); runtime = Runtime.open(home);
  queue = new JobQueue(runtime.store, async job => {
    await runTurn(runtime, { botId: job.botId, input: job.task, messageText: job.messageText, attachments: job.attachments, provider: { model: "vision", async complete(value) { request = value; return { text: "image received", toolCalls: [] }; } } });
    return { text: "done" };
  });
  assert.deepEqual(queue.get(job.id).attachments, attachments); queue.start(); await queue.wait(job.id);
  const storedInput = runtime.store.getEvents(bot.id).find(e => e.event.type === "user_text")!.event;
  assert.ok(storedInput.type === "user_text"); assert.equal(storedInput.text, "", "Attachment-only input does not invent a text bubble");
  const user = request!.messages.find(m => m.role === "user")!;
  assert.equal(user.images![0]!.data, png.toString("base64")); assert.match(user.content, /attached.md/); assert.match(user.content, /read_document/);
  assert.equal(JSON.stringify(runtime.store.getEvents(bot.id)).includes(png.toString("base64")), false);
  runtime.store.forgetLibraryRef(bot.id, image.id);
  assert.equal(hydrateImages(runtime.store, bot.id, [{ role: "user", content: "removed", attachments }])[0]!.images!.length, 0);
});
test("attachment validation rejects unsupported, empty, forged PDF and oversized data", () => {
  assert.equal(attachmentMime("screen.png", png), "image/png");
  assert.equal(attachmentMime("notes.csv", Buffer.from("a,b\n1,2")), "text/csv");
  assert.throws(() => attachmentMime("x.exe", Buffer.from("test")), /请选择/);
  assert.throws(() => attachmentMime("x.pdf", Buffer.from("not a pdf")), /请选择/);
  assert.throws(() => attachmentMime("x.txt", Buffer.alloc(0)), /不能为空/);
  assert.throws(() => attachmentMime("x.png", Buffer.alloc(21 * 1024 * 1024)), /20 MB/);
});

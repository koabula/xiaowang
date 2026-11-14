import assert from "node:assert/strict";
import { test } from "node:test";
import { Presentation } from "../src/presentation.ts";
import { StageRequests } from "../desktop/main/stage.ts";

test("presentation survives questions and acknowledgments, obeys explicit commands, and restores paused", () => {
  const p = new Presentation(); p.userText("带我把这份论文逐页讲完"); p.locate("paper", 3, 8, "file");
  p.userText("OK"); p.userText("为什么要这样比较？"); assert.equal(p.shouldContinue(), true); assert.equal(p.snapshot().page, 3);
  p.userText("先停一下"); assert.equal(p.shouldContinue(), false); p.userText("继续"); assert.equal(p.shouldContinue(), true);
  const restored = new Presentation(p.snapshot()); assert.equal(restored.snapshot().status, "paused"); assert.equal(restored.snapshot().page, 3);
  restored.userText("resume"); assert.equal(restored.shouldContinue(), true); restored.userText("不用讲了"); assert.equal(restored.snapshot().status, "completed");
});

test("automatic continuation has a finite runaway guard", () => {
  const p = new Presentation(); p.start("present"); for (let i = 0; i < 100; i++) p.segmentPlayed(); assert.equal(p.shouldContinue(), false); assert.equal(p.snapshot().status, "paused");
});

test("stage receipts are correlated to a workspace and confirm actual page bounds", async () => {
  const sent: Array<{ slug: string; requestId: string }> = [];
  const stage = new StageRequests(note => sent.push(note), 1000);
  const result = stage.show("bot", { mode: "canvas", title: "deck.html", html: "<section>one</section>", page: 1 });
  const id = sent[0]!.requestId;
  assert.equal(stage.acknowledge("other", id, { page: 1, totalPages: 2 }), false);
  assert.equal(stage.acknowledge("bot", id, { page: 1, totalPages: 2 }), true);
  assert.deepEqual(await result, { page: 1, totalPages: 2 });
  const invalid = stage.show("bot", { mode: "file", id: "doc", filename: "file.pdf", page: 5 });
  stage.acknowledge("bot", sent[1]!.requestId, { page: 5, totalPages: 2 }); await assert.rejects(invalid, /无效页码/);
  stage.dispose();
});

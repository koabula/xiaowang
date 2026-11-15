import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/runtime.ts";

test("only a newly created steward gets the new default avatar; existing choices stay untouched", t => {
  const home = mkdtempSync(path.join(tmpdir(), "xw-avatar-default-"));
  let runtime = Runtime.open(home);
  t.after(() => { runtime.close(); rmSync(home, { recursive: true, force: true }); });
  const first = runtime.activeBot();
  assert.equal(first.avatarSeed, "xw-6udis"); assert.equal(first.avatarInk, "#2B59C3");
  const child = runtime.store.createBot({ name: "Child", systemPrompt: "test" });
  assert.equal(child.avatarSeed, ""); assert.equal(child.avatarInk, "");
  for (const avatar of [{ seed: "", ink: "" }, { seed: "custom-face", ink: "#177E6B" }]) {
    runtime.store.setAvatar(first.id, avatar);
    runtime.close(); runtime = Runtime.open(home);
    const existing = runtime.ensureSteward();
    assert.equal(existing.avatarSeed, avatar.seed); assert.equal(existing.avatarInk, avatar.ink);
  }
});

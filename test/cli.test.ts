import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const node = process.execPath;

function run(home: string, args: string[]) {
  return spawnSync(node, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      XIAOWANG_HOME: home,
      XIAOWANG_MODEL: "",
      XIAOWANG_API_KEY: "",
      XIAOWANG_BASE_URL: "",
      XIAOWANG_API_STYLE: "",
    },
  });
}

test("cli lists the steward, creates a bot, and prints help without a model key", () => {
  const home = mkdtempSync(path.join(tmpdir(), "xiaowang-cli-"));
  try {
    const help = run(home, []);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /XIAOWANG_MODEL/);

    const bots = run(home, ["bots"]);
    assert.equal(bots.status, 0, bots.stderr);
    assert.match(bots.stdout, /\* xiaowang\s+小王同学/);

    const created = run(home, ["new", "Name That LLM", "--baseline", "核对改写归因的边界"]);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /name-that-llm/);

    const events = run(home, ["events", "name-that-llm"]);
    assert.match(events.stdout, /baseline\s+核对改写归因的边界/);

    const brief = run(home, ["brief", "name-that-llm"]);
    assert.match(brief.stdout, /核对改写归因的边界/);
    assert.doesNotMatch(brief.stdout, /父空间/);

    const paper = path.join(home, "user-paper.txt");
    writeFileSync(paper, "USER-PDF-SENTENCE");
    const added = run(home, ["add", paper, "--bot", "name-that-llm"]);
    assert.equal(added.status, 0, added.stderr + added.stdout);
    assert.match(added.stdout, /f_[0-9a-f]+/);
    const listed = run(home, ["library", "name-that-llm"]);
    assert.match(listed.stdout, /user-paper\.txt/);
    const empty = run(home, ["library"]);
    assert.match(empty.stdout, /还没有引用/);
    const id = added.stdout.match(/f_[0-9a-f]+/)?.[0] ?? "";
    const shared = run(home, ["share", id, "--to", "xiaowang", "--from", "name-that-llm"]);
    assert.equal(shared.status, 0, shared.stderr + shared.stdout);
    const after = run(home, ["library"]);
    assert.match(after.stdout, /user-paper\.txt/);

    const missing = run(home, ["ask", "你好"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /XIAOWANG_MODEL|XIAOWANG_API_KEY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

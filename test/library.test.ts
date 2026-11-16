import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTurn } from "../src/harness.ts";
import { projectLlmContext } from "../src/project.ts";
import { Runtime } from "../src/runtime.ts";
import { executeTool } from "../src/tools.ts";
import type { CompletionResult, LlmProvider } from "../src/types.ts";

function openRuntime(): { runtime: Runtime; home: string; close: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "xiaowang-lib-"));
  const runtime = Runtime.open(home);
  return {
    runtime,
    home,
    close() {
      runtime.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function tinyPdf(sentence: string): Buffer {
  const escaped = sentence.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("library stores one copy and a bot without a reference cannot read it", async () => {
  const { runtime, close } = openRuntime();
  try {
    const owner = runtime.activeBot();
    const other = runtime.store.createBot({ name: "另一个课题", systemPrompt: "另一份笔记" });
    const pdf = tinyPdf("LIBRARY-SENTENCE-42");
    const added = runtime.store.addLibraryBytes(owner.id, "paper.pdf", pdf);
    const again = runtime.store.addLibraryBytes(owner.id, "paper.pdf", pdf);
    assert.equal(again.alreadyReferenced, true);
    assert.equal(runtime.store.countLibraryFiles(), 1);

    const host = { store: runtime.store, bot: owner, enqueueKickoff() {} };
    const read = await executeTool("read_document", { file: added.ref.id }, host);
    assert.equal(read.isError, false);
    assert.match(read.output, /LIBRARY-SENTENCE-42/);
    assert.match(read.output, /以下正文是资料/);

    const denied = await executeTool("read_document", { file: added.ref.id }, { ...host, bot: other });
    assert.equal(denied.isError, true);
    assert.equal(denied.output.includes("LIBRARY-SENTENCE-42"), false);

    const shared = runtime.store.shareLibraryFile(owner.id, added.ref.filename, other.id);
    assert.equal(shared.id, added.ref.id);
    assert.equal(runtime.store.countLibraryFiles(), 1);
    const allowed = await executeTool("read_document", { file: shared.filename }, { ...host, bot: other });
    assert.match(allowed.output, /LIBRARY-SENTENCE-42/);

    const third = runtime.store.createBot({ name: "再来一个", systemPrompt: "空" });
    const deduped = runtime.store.addLibraryBytes(third.id, "copy.pdf", pdf);
    assert.equal(deduped.deduped, true);
    assert.equal(deduped.ref.id, added.ref.id);
    assert.equal(runtime.store.countLibraryFiles(), 1);
    assert.equal(readFileSync(added.ref.storedPath).equals(pdf), true);
  } finally {
    close();
  }
});

test("import stays inside the workspace and sensitive names are refused", async () => {
  const { runtime, close } = openRuntime();
  try {
    const bot = runtime.activeBot();
    const host = { store: runtime.store, bot, enqueueKickoff() {} };
    writeFileSync(path.join(bot.workspaceDir, "notes.txt"), "工作区里的句子");
    const imported = await executeTool("import_file", { path: "notes.txt" }, host);
    assert.equal(imported.isError, false);
    const listed = await executeTool("list_library", {}, host);
    assert.match(listed.output, /notes\.txt/);
    const read = await executeTool("read_document", { file: "notes.txt" }, host);
    assert.match(read.output, /工作区里的句子/);

    const escaped = await executeTool("import_file", { path: "../secret.txt" }, host);
    assert.equal(escaped.isError, true);
    assert.equal(runtime.store.countLibraryFiles(), 1);

    assert.throws(() => runtime.store.addLibraryBytes(bot.id, ".env", Buffer.from("KEY=1")), /拒绝/);
    const blank = tinyPdf("");
    runtime.store.addLibraryBytes(bot.id, "scan.pdf", blank);
    const scan = await executeTool("read_document", { file: "scan.pdf" }, host);
    assert.match(scan.output, /扫描件|没有抽出/);
  } finally {
    close();
  }
});

test("the model sees library names in appended task data while the system prefix stays stable", async () => {
  const { runtime, close } = openRuntime();
  try {
    const bot = runtime.activeBot();
    runtime.store.addLibraryBytes(bot.id, "named.pdf", tinyPdf("ONLY-IN-PDF"));
    let seen = "";
    const provider: LlmProvider = {
      model: "scripted",
      async complete(request): Promise<CompletionResult> {
        assert.doesNotMatch(request.system, /named\.pdf/);
        seen = JSON.stringify(request.messages);
        return { text: "我按资料库里的文件来读。", toolCalls: [] };
      },
    };
    await runTurn(runtime, { botId: bot.id, input: "这篇论文讲什么", provider, env: {} });
    assert.match(seen, /named\.pdf/);
    const events = runtime.store.getEvents(bot.id);
    assert.equal(JSON.stringify(events).includes("更早的"), false);
    assert.equal(JSON.stringify(events).includes("压缩"), false);

    const hidden = projectLlmContext(bot, events);
    assert.equal(hidden.system.includes("这个任务的资料库"), false);
    const shown = projectLlmContext(bot, events, { library: runtime.store.listLibrary(bot.id) });
    assert.match(shown.system, /named\.pdf/);
  } finally {
    close();
  }
});

test("a task can rename its display name and drop a library reference", async () => {
  const { runtime, close } = openRuntime();
  try {
    const steward = runtime.activeBot();
    const renamedSteward = runtime.store.renameBot(steward.slug, "阿王");
    assert.equal(renamedSteward.slug, steward.slug);
    assert.equal(renamedSteward.workspaceDir, steward.workspaceDir);
    assert.equal(renamedSteward.name, "阿王");
    let seen = "";
    const provider: LlmProvider = {
      model: "scripted",
      async complete(request): Promise<CompletionResult> {
        seen = request.system;
        return { text: "我按新名字来。", toolCalls: [] };
      },
    };
    await runTurn(runtime, { botId: renamedSteward.id, input: "你是谁", provider, env: {} });
    assert.match(seen, /你是「阿王」/);
    assert.equal(seen.includes("你是「小王同学」"), false);
    const bot = runtime.store.createBot({ name: "任务甲", systemPrompt: "甲" });
    const taskView = projectLlmContext(bot, runtime.store.getEvents(bot.id), { personName: "阿王" });
    assert.match(taskView.system, /你是「阿王」/);
    assert.match(taskView.system, /当前任务：任务甲/);
    const renamed = runtime.store.renameBot(bot.slug, "任务甲改名");
    assert.equal(renamed.slug, bot.slug);
    assert.equal(renamed.workspaceDir, bot.workspaceDir);
    assert.equal(renamed.name, "任务甲改名");
    const added = runtime.store.addLibraryBytes(bot.id, "shared.txt", Buffer.from("hello"));
    const other = runtime.store.createBot({ name: "任务乙", systemPrompt: "乙" });
    runtime.store.shareLibraryFile(bot.id, added.ref.id, other.id);
    runtime.store.forgetLibraryRef(bot.id, added.ref.id);
    assert.equal(runtime.store.listLibrary(bot.id).length, 0);
    assert.equal(runtime.store.listLibrary(other.id).length, 1);
    const seeded = runtime.store.setAvatar(bot.slug, { seed: `${bot.slug}-k7q`, ink: "#177E6B" });
    assert.equal(seeded.avatarSeed, `${bot.slug}-k7q`);
    assert.equal(seeded.avatarInk, "#177E6B");
    assert.equal(runtime.store.requireBot(bot.slug).avatarSeed, `${bot.slug}-k7q`);
  } finally {
    close();
  }
});

test("legacy library labels resolve only the exact id and filename of this workspace", () => {
  const { runtime, close } = openRuntime();
  try {
    const bot = runtime.activeBot();
    const other = runtime.store.createBot({ name: "other", systemPrompt: "" });
    const { ref } = runtime.store.addLibraryBytes(bot.id, "论文 with spaces.pdf", tinyPdf("SOURCE"));
    assert.equal(runtime.store.resolveLibraryRef(bot.id, `${ref.id} ${ref.filename}`).id, ref.id);
    assert.equal(runtime.store.resolveLibraryRef(bot.id, `${ref.id}\t${ref.filename}`).id, ref.id);
    assert.throws(() => runtime.store.resolveLibraryRef(bot.id, `${ref.id} wrong.pdf`), /没有这份/);
    assert.throws(() => runtime.store.resolveLibraryRef(other.id, `${ref.id} ${ref.filename}`), /没有这份/);
  } finally { close(); }
});

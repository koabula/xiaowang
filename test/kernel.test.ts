import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArxivAtom } from "../src/arxiv.ts";
import { runTurn } from "../src/harness.ts";
import { projectLlmContext, projectVoiceBrief } from "../src/project.ts";
import { Runtime } from "../src/runtime.ts";
import { slugify } from "../src/store.ts";
import { executeTool } from "../src/tools.ts";
import type { CompletionResult, LlmProvider } from "../src/types.ts";

function openRuntime(): { runtime: Runtime; close: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "xiaowang-"));
  const runtime = Runtime.open(home);
  return {
    runtime,
    close() {
      runtime.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("slugify keeps readable english names and invents an id for chinese", () => {
  assert.equal(slugify("Name That LLM"), "name-that-llm");
  assert.match(slugify("小王同学"), /^bot-[0-9a-f]+$/);
});

test("bots are isolated append-only logs", () => {
  const { runtime, close } = openRuntime();
  const steward = runtime.activeBot();
  assert.equal(steward.slug, "xiaowang");
  runtime.store.append(steward.id, { type: "user_text", channel: "text", text: "父空间密语 ALPHA-7749" });
  const child = runtime.store.createBot({
    name: "投机解码",
    systemPrompt: "只跟进投机解码",
    parentBotId: steward.id,
  });
  runtime.store.append(child.id, { type: "baseline", text: "只跟进投机解码", fromBotId: steward.id });
  runtime.store.append(child.id, { type: "user_text", channel: "text", text: "子空间句子" });

  const parentEvents = runtime.store.getEvents(steward.id);
  const childEvents = runtime.store.getEvents(child.id);
  assert.equal(parentEvents.some((item) => JSON.stringify(item.event).includes("子空间句子")), false);
  assert.equal(childEvents.some((item) => JSON.stringify(item.event).includes("ALPHA-7749")), false);
  assert.deepEqual(
    runtime.store.getEvents(steward.id, { afterId: parentEvents[0]?.id ?? 0 }).map((item) => item.id),
    parentEvents.slice(1).map((item) => item.id),
  );
  close();
});

test("file tools stay inside the bot workspace", async () => {
  const { runtime, close } = openRuntime();
  const bot = runtime.activeBot();
  const outside = path.join(path.dirname(bot.workspaceDir), "secret.txt");
  writeFileSync(outside, "OUTSIDE-SECRET");
  const host = {
    store: runtime.store,
    bot,
    enqueueKickoff() {},
  };

  try {
    const escaped = await executeTool("read_file", { path: "../secret.txt" }, host);
    assert.equal(escaped.isError, true);
    assert.equal(escaped.output.includes("OUTSIDE-SECRET"), false);

    const absolute = await executeTool("read_file", { path: outside }, host);
    assert.equal(absolute.isError, true);
    assert.equal(absolute.output.includes("OUTSIDE-SECRET"), false);

    const link = path.join(bot.workspaceDir, "escape");
    symlinkSync(path.dirname(bot.workspaceDir), link);
    const throughLink = await executeTool("write_file", { path: "escape/pwn.txt", content: "nope" }, host);
    assert.equal(throughLink.isError, true);
    assert.equal(readFileSync(outside, "utf8"), "OUTSIDE-SECRET");

    const written = await executeTool(
      "write_file",
      { path: "notes/reading.md", content: "三条边界" },
      host,
    );
    assert.equal(written.isError, false);
    const read = await executeTool("read_file", { path: "notes/reading.md" }, host);
    assert.match(read.output, /三条边界/);
    const listed = await executeTool("list_files", {}, host);
    assert.match(listed.output, /notes\/reading\.md/);
  } finally {
    close();
  }
});

test("projection keeps the full log but drops old turns and hides tool dumps from the voice brief", () => {
  const { runtime, close } = openRuntime();
  const bot = runtime.activeBot();
  runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "FIRST-TOKEN-00 " + "甲".repeat(300) });
  for (let i = 0; i < 8; i += 1) {
    runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "中".repeat(300) });
  }
  runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: "中间结论", toolCalls: [] });
  runtime.store.append(bot.id, {
    type: "tool_result",
    callId: "orphan",
    name: "search_arxiv",
    output: "Z".repeat(3000),
    isError: false,
  });
  runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "LAST-TOKEN-99" });
  runtime.store.append(bot.id, {
    type: "assistant_turn",
    channel: "text",
    text: "",
    toolCalls: [{ id: "c-missing", name: "read_file", input: { path: "notes/a.md" } }],
  });

  const events = runtime.store.getEvents(bot.id);
  const projection = projectLlmContext(bot, events, { budget: 1800 });
  const flat = projection.messages.map((message) => message.content).join("\n");
  assert.ok(projection.droppedTurns > 0);
  assert.equal(events.some((item) => JSON.stringify(item.event).includes("更早的")), false);
  assert.match(flat, /更早的/);
    assert.equal(projection.system.includes("这个任务的资料库"), false);
  assert.equal(flat.includes("FIRST-TOKEN-00"), false);
  assert.equal(flat.includes("LAST-TOKEN-99"), true);
  assert.match(flat, /工具执行被中断/);
  assert.equal(events.length > projection.messages.length, true);

  runtime.store.append(bot.id, {
    type: "assistant_turn",
    channel: "text",
    text: "两步都做。",
    toolCalls: [
      { id: "w1", name: "write_file", input: { path: "notes/a.md" } },
      { id: "w2", name: "write_file", input: { path: "notes/b.md" } },
    ],
  });
  runtime.store.append(bot.id, {
    type: "tool_result",
    callId: "w1",
    name: "write_file",
    output: "已写入 notes/a.md",
    isError: false,
  });
  runtime.store.append(bot.id, { type: "artifact", path: "notes/a.md", bytes: 4 });
  runtime.store.append(bot.id, {
    type: "tool_result",
    callId: "w2",
    name: "write_file",
    output: "已写入 notes/b.md",
    isError: false,
  });
  const paired = projectLlmContext(runtime.store.requireBot(bot.id), runtime.store.getEvents(bot.id), {
    budget: 20_000,
  });
  const toolOutputs = paired.messages.filter((message) => message.role === "tool").map((message) => message.content);
  assert.equal(toolOutputs.some((content) => content.includes("notes/a.md")), true);
  assert.equal(toolOutputs.some((content) => content.includes("notes/b.md")), true);

  const brief = JSON.stringify(projectVoiceBrief(bot, events));
  assert.equal(brief.includes("ZZZZZZ"), false);
  assert.equal(brief.includes("LAST-TOKEN-99"), true);
  close();
});

test("a turn wakes from the session, and spawn does not copy the parent transcript", async () => {
  const { runtime, close } = openRuntime();
  const steward = runtime.activeBot();
  const script: CompletionResult[] = [
    {
      text: "我来单独开一个项目。",
      toolCalls: [
        {
          id: "c1",
          name: "spawn_bot",
          arguments: JSON.stringify({
            name: "投机解码",
            baseline: "只跟进投机解码的论文线索",
            kickoff_task: "写一份开题笔记到 notes/open.md",
          }),
        },
      ],
    },
    { text: "已经单独开了项目。", toolCalls: [] },
    {
      text: "",
      toolCalls: [
        {
          id: "c2",
          name: "write_file",
          arguments: JSON.stringify({
            path: "notes/open.md",
            content: "CHILD-ONLY-SENTENCE",
          }),
        },
      ],
    },
    { text: "笔记写好了。", toolCalls: [] },
  ];
  const provider: LlmProvider = {
    model: "scripted",
    async complete() {
      const next = script.shift();
      if (!next) throw new Error("scripted provider ran out of steps");
      return next;
    },
  };

  const turn = await runTurn(runtime, {
    botId: steward.id,
    input: "父空间密语 ALPHA-7749。请把投机解码单独开项目。",
    provider,
  });
  assert.equal(turn.finalText, "已经单独开了项目。");
  assert.equal(turn.kickoffs.length, 1);
  assert.equal(turn.kickoffs[0]?.finalText, "笔记写好了。");
  assert.equal(runtime.activeBot().slug, "xiaowang");

  const child = runtime.store.getBot("投机解码") ?? runtime.store.listBots().find((bot) => bot.slug !== "xiaowang");
  assert.ok(child);
  assert.equal(child.parentBotId, steward.id);
  assert.equal(readFileSync(path.join(child.workspaceDir, "notes/open.md"), "utf8"), "CHILD-ONLY-SENTENCE");
  assert.equal(existsSync(path.join(steward.workspaceDir, "notes/open.md")), false);

  const parentBlob = JSON.stringify(runtime.store.getEvents(steward.id));
  const childBlob = JSON.stringify(runtime.store.getEvents(child.id));
  assert.equal(parentBlob.includes("CHILD-ONLY-SENTENCE"), false);
  assert.equal(childBlob.includes("ALPHA-7749"), false);
  assert.equal(childBlob.includes("只跟进投机解码的论文线索"), true);

  let seen = "";
  await runTurn(runtime, {
    botId: steward.id,
    input: "第二点是什么？",
    provider: {
      model: "scripted",
      async complete(request) {
        seen = JSON.stringify(request.messages);
        return { text: "还记得。", toolCalls: [] };
      },
    },
  });
  assert.match(seen, /已经单独开了项目/);
  close();
});

test("a finished call is one record in the text context", () => {
  const { runtime, close } = openRuntime();
  const bot = runtime.activeBot();
  runtime.store.append(bot.id, {
    type: "call",
    startedAt: "2026-11-14T08:00:00.000Z",
    endedAt: "2026-11-14T08:00:15.000Z",
    lines: [
      { who: "assistant", text: "你好，我是小王同学。" },
      { who: "user", text: "今天先看到这里。" },
    ],
  });
  const projected = projectLlmContext(bot, runtime.store.getEvents(bot.id));
  const flat = projected.messages.map((message) => message.content).join("\n");
  assert.match(flat, /通话记录/);
  assert.match(flat, /今天先看到这里/);
  const brief = projectVoiceBrief(bot, runtime.store.getEvents(bot.id));
  assert.equal(brief.recentTurns.some((turn) => turn.text.includes("今天先看到这里")), true);
  close();
});

test("arxiv atom entries become compact citations", () => {
  const papers = parseArxivAtom(`<?xml version="1.0"?>
<feed>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention  Is
      All You Need</title>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL" />
    <summary>We propose the Transformer &amp; discard recurrence.</summary>
  </entry>
</feed>`);
  assert.equal(papers.length, 1);
  assert.equal(papers[0]?.title, "Attention Is All You Need");
  assert.equal(papers[0]?.url, "https://arxiv.org/abs/1706.03762v7");
  assert.equal(papers[0]?.authors[0], "Ashish Vaswani");
  assert.match(papers[0]?.summary ?? "", /Transformer & discard/);
});

test("a running LLM turn keeps its task when live voice progress and tools arrive", async () => {
  const { runtime, close } = openRuntime();
  try {
    const bot = runtime.activeBot(); let step = 0;
    runtime.store.append(bot.id, { type: "user_text", channel: "text", text: "历史研究背景" });
    const provider: LlmProvider = { model: "fixture", async complete(request) {
      step += 1;
      if (step === 1) {
        runtime.store.append(bot.id, { type: "voice_line", callId: "live", who: "user", text: "梳理了吗-PROGRESS" });
        runtime.store.append(bot.id, { type: "assistant_turn", channel: "voice", text: "", toolCalls: [{ id: "foreground", name: "list_library", input: {} }] });
        runtime.store.append(bot.id, { type: "tool_result", callId: "foreground", name: "list_library", output: "FOREGROUND-TOOL", isError: false });
        return { text: "正在查阅", toolCalls: [{ id: "own", name: "list_files", arguments: "{}" }] };
      }
      const contents = request.messages.map(message => message.content).join("\n");
      assert.match(contents, /历史研究背景/); assert.match(contents, /分析论文-PRIMARY/);
      assert.doesNotMatch(contents, /PROGRESS|FOREGROUND-TOOL/);
      const ownCall = request.messages.findLast(message => message.role === "assistant" && message.toolCalls?.some(call => call.name === "list_files"))?.toolCalls?.[0];
      assert.ok(ownCall?.id.startsWith("xw_"));
      assert.ok(request.messages.some(message => message.role === "tool" && message.toolCallId === ownCall?.id));
      return { text: "分析完成", toolCalls: [] };
    } };
    const result = await runTurn(runtime, { botId: bot.id, input: "分析论文-PRIMARY", provider });
    assert.equal(result.finalText, "分析完成");
    const log = JSON.stringify(runtime.store.getEvents(bot.id));
    assert.match(log, /PROGRESS/); assert.match(log, /FOREGROUND-TOOL/);
  } finally { close(); }
});

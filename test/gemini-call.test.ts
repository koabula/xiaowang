import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiCall } from "../desktop/main/gemini-call.ts";
import { geminiSession } from "../src/gemini-session.ts";
import { voiceTools } from "../src/realtime.ts";
import type { GeminiSocket } from "../src/gemini-live.ts";
import type { CallHandlers, VoiceState } from "../desktop/main/call.ts";
import type { TaskJob } from "../src/types.ts";

type Packet = Record<string, any>;
class Socket implements GeminiSocket {
  sent: Packet[] = []; listeners = new Map<string, Array<(event: any) => void>>();
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() {}
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  emit(type: string, value: any = {}) { this.listeners.get(type)?.forEach(fn => fn(value)); }
  message(value: Packet) { this.emit("message", { data: JSON.stringify(value) }); }
  result(id: string) { return this.sent.flatMap(item => item.toolResponse?.functionResponses || []).find(item => item.id === id); }
}
const sleep = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(patch: Partial<CallHandlers> = {}, preview = "") {
  const sockets: Socket[] = [], states: VoiceState[] = [], phases: string[] = [], transcripts: string[] = [];
  const call = new GeminiCall("ws://fixture", "local", geminiSession("test", voiceTools([]), "Kore", "gemini-3.8-live"), {
    onPhase: phase => phases.push(phase), onState: state => states.push(state), onAudio() {}, onInterrupt() {}, onLine() {}, onTranscript: (_who, text) => transcripts.push(text), runTool: async () => "ok", ...patch,
  }, () => { const socket = new Socket(); sockets.push(socket); return socket; }, preview);
  call.start(); const socket = sockets[0]!; socket.emit("open"); socket.message({ setupComplete: {} });
  return { call, socket, sockets, phases, states, transcripts };
}
const tool = (socket: Socket, id: string, name: string, args: Packet = {}) => socket.message({ toolCall: { functionCalls: [{ id, name, args }] } });
function speech(socket: Socket, input: string, output: string) {
  socket.message({ serverContent: { inputTranscription: { text: input }, outputTranscription: { text: output }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } } });
}

test("Gemini walkthrough waits for actual playback, pauses, resumes and never accepts stale idle receipts", async t => {
  const { call, socket } = fixture(); t.after(() => call.hangup());
  tool(socket, "start", "manage_presentation", { action: "start", goal: "read all pages" }); await sleep();
  speech(socket, "逐页讲解", "第一页内容");
  socket.message({ serverContent: { turnComplete: true } });
  assert.equal(socket.sent[0]?.setup.tools[0].functionDeclarations.some((item: Packet) => item.name === "continue_speaking"), false);
  await sleep(400); assert.equal(socket.sent.filter(item => item.clientContent?.turnComplete === true).length, 0);
  call.control("pause"); call.noteSpeakerIdle(1, call.id); await sleep(400);
  assert.equal(socket.sent.filter(item => item.clientContent?.turnComplete === true).length, 1, "Only the deliberate pause control was sent");
  call.control("resume"); call.noteSpeakerIdle(0, call.id); await sleep(400);
  assert.match(socket.sent.at(-1)?.clientContent.turns[0].parts[0].text, /应用已确认的讲解位置/);
  assert.equal(call.presentation.snapshot().segments, 0, "An interrupted segment must not count as fully played");
  tool(socket, "finish", "manage_presentation", { action: "complete" }); await sleep();
  speech(socket, "", "讲解完成"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(2, call.id); await sleep(400);
  assert.equal(call.presentation.snapshot().status, "completed");
  assert.equal(socket.sent.filter(item => item.clientContent?.turnComplete === true).length, 2, "Only pause and one resumed segment are sent; completion stops continuation");
});

test("Gemini resumes the same session, captures only one live phase and never reexecutes replayed tools", async t => {
  let executions = 0;
  const { call, socket, sockets, phases, transcripts } = fixture({ runTool: async () => { executions++; return "saved"; } }); t.after(() => call.hangup());
  socket.message({ sessionResumptionUpdate: { resumable: true, newHandle: "PRIVATE-RESUME-TOKEN" } });
  speech(socket, "记住蓝色星星", "记住了"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(1, call.id);
  tool(socket, "write-once", "write_file", { path: "notes/a.md" }); await sleep();
  socket.emit("close", { code: 1006 }); await sleep(350);
  assert.equal(sockets.length, 2); const resumed = sockets[1]!; resumed.emit("open");
  assert.deepEqual(resumed.sent[0]?.setup.sessionResumption, { handle: "PRIVATE-RESUME-TOKEN" });
  resumed.message({ setupComplete: {} }); tool(resumed, "write-once", "write_file", { path: "notes/a.md" }); await sleep();
  assert.equal(executions, 1); assert.equal(resumed.result("write-once")?.response.result, "saved");
  assert.equal(phases.filter(phase => phase === "live").length, 1, "Reconnect must not restart microphone capture");
  speech(resumed, "刚才的暗号呢", "蓝色星星"); resumed.message({ serverContent: { turnComplete: true } });
  call.hangup(); assert.deepEqual(call.transcript().map(line => line.text), ["记住蓝色星星", "记住了", "刚才的暗号呢", "蓝色星星"]);
  assert.equal(transcripts.length, 4); assert.equal(phases.filter(phase => phase === "closed").length, 1);
});

test("Gemini ends visibly without a resumption token instead of silently starting a new session", async () => {
  const { socket, sockets, phases, states } = fixture();
  socket.emit("close", { code: 1006 }); await sleep(350);
  assert.equal(sockets.length, 1); assert.equal(phases.at(-1), "closed"); assert.match(states.at(-1)!.detail, /无法恢复原会话/);
});

test("Gemini preview closes only after generation and actual audio playback finish", async t => {
  const { call, socket, phases } = fixture({}, "你好"); t.after(() => call.hangup());
  await sleep(400); assert.equal(phases.includes("closed"), false);
  speech(socket, "", "你好"); socket.message({ serverContent: { turnComplete: true } });
  await sleep(400); assert.equal(phases.includes("closed"), false);
  call.noteSpeakerIdle(1, call.id); await sleep(400); assert.equal(phases.at(-1), "closed");
});

test("the application owns page progression even when Gemini requests later pages before audio arrives", async t => {
  const pages: number[] = [];
  const { call, socket } = fixture({ runTool: async (name, args) => {
    if (name === "show_stage") { const page = Number(JSON.parse(args).page); pages.push(page); call.locate("lesson.html", page, 3); }
    return "shown";
  } }); t.after(() => call.hangup());
  socket.message({ serverContent: { inputTranscription: { text: "逐页讲解 lesson.html" } } });
  tool(socket, "start", "manage_presentation", { action: "start" }); await sleep();
  tool(socket, "page1", "show_stage", { mode: "canvas", path: "lesson.html", page: 1 }); await sleep();
  tool(socket, "too-early", "show_stage", { mode: "canvas", path: "lesson.html", page: 2 }); await sleep();
  assert.match(socket.result("too-early")?.response.result, /application_managed/); assert.deepEqual(pages, [1]);
  speech(socket, "", "第一页"); socket.message({ serverContent: { turnComplete: true } }); await sleep(400); assert.deepEqual(pages, [1]);
  call.noteSpeakerIdle(1, call.id); await sleep(400); assert.deepEqual(pages, [1, 2]);
  speech(socket, "", "第二页开头"); socket.message({ serverContent: { interrupted: true, turnComplete: true } });
  const cues = socket.sent.filter(item => item.clientContent?.turnComplete === true).length;
  await sleep(450); assert.equal(socket.sent.filter(item => item.clientContent?.turnComplete === true).length, cues, "An interrupted old turn cannot restart narration while the user is speaking");
  speech(socket, "为什么？", "这是问题的回答"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(3, call.id); await sleep(400);
  assert.deepEqual(pages, [1, 2], "Answering an interruption must resume the same page, without skipping its unfinished content");
  speech(socket, "", "第二页剩余内容"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(4, call.id); await sleep(400);
  assert.deepEqual(pages, [1, 2, 3]);
  tool(socket, "finish", "manage_presentation", { action: "complete" }); await sleep(); assert.equal(call.presentation.snapshot().status, "active");
  speech(socket, "", "第三页"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(5, call.id);
  assert.equal(call.presentation.snapshot().status, "completed");
});

const completedJob = (notify: TaskJob["notify"] = "when_idle"): TaskJob => ({ id: "job", botId: "bot", task: "research", channel: "voice", notify, status: "succeeded", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:01Z", attempts: 1, activity: "", result: "actual-result", error: "", artifacts: ["notes/result.md"] });

test("silent Gemini jobs do not trigger speech, and accepted jobs survive hangup", async t => {
  let signal: AbortSignal | undefined;
  const { call, socket } = fixture({ runTool: async (_name, _args, _id, value) => { signal = value; return JSON.stringify({ id: "job", status: "running" }); } }); t.after(() => call.hangup());
  tool(socket, "silent", "delegate_task", { task: "research", notify: "silent" }); await sleep();
  call.jobChanged(completedJob("silent")); await sleep();
  assert.equal(socket.result("silent")?.response.scheduling, "SILENT");
  await sleep(400); assert.equal(socket.sent.some(item => item.clientContent?.turnComplete === true), false);
  tool(socket, "ongoing", "delegate_task", { task: "another research" }); await sleep(); call.hangup();
  assert.equal(signal?.aborted, false, "A durable job is independent of a closed voice response channel");
});

test("cancellation before the local job receipt arrives still preserves a real completion notice", async t => {
  let accepted!: (value: string) => void;
  const { call, socket } = fixture({ runTool: () => new Promise(resolve => { accepted = resolve; }) }); t.after(() => call.hangup());
  tool(socket, "late-receipt", "delegate_task", { task: "research" }); await sleep();
  socket.message({ toolCallCancellation: { ids: ["late-receipt"] } });
  accepted(JSON.stringify({ id: "job", status: "running" })); await sleep();
  call.jobChanged(completedJob()); await sleep(400);
  assert.equal(socket.result("late-receipt"), undefined, "Never reply through a cancelled provider ID");
  assert.match(socket.sent.at(-1)?.clientContent.turns[0].parts[0].text, /actual-result/);
});

test("Gemini cannot hang up without an explicit user request or mistake 'do not hang up' for consent", async t => {
  const { call, socket, phases } = fixture(); t.after(() => call.hangup());
  speech(socket, "只回答记住了。", "记住了"); tool(socket, "premature", "end_call"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(1, call.id); await sleep(400);
  assert.equal(socket.result("premature")?.response.result.status, "call_remains_open"); assert.equal(phases.includes("closed"), false);
  speech(socket, "不要挂断", "好的"); tool(socket, "refused", "end_call"); await sleep();
  assert.equal(socket.result("refused")?.response.result.status, "call_remains_open");
  socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(2, call.id);
  speech(socket, "再见，挂断吧。", "再见"); tool(socket, "bye", "end_call"); socket.message({ serverContent: { turnComplete: true } }); await sleep(400);
  assert.equal(phases.includes("closed"), false); call.noteSpeakerIdle(3, call.id); await sleep(400); assert.equal(phases.at(-1), "closed");
});

test("late ASR and late generated audio cannot restart a completed walkthrough", async t => {
  let played = 0;
  const { call, socket } = fixture({ onAudio: () => { played++; } }); t.after(() => call.hangup());
  socket.message({ voiceActivity: { type: "ACTIVITY_START" } });
  socket.message({ serverContent: { inputTranscription: { text: "逐页讲解全文" } } });
  socket.message({ voiceActivity: { type: "ACTIVITY_END" } });
  call.locate("lesson.html", 1, 1);
  speech(socket, "", "最后一页的内容"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(1, call.id);
  assert.equal(call.presentation.snapshot().status, "completed");
  speech(socket, "", "迟到的重复结尾"); socket.message({ serverContent: { inputTranscription: { text: "，不要等我说继续。" }, turnComplete: true } });
  await sleep(400); assert.equal(played, 1); assert.equal(call.presentation.snapshot().status, "completed");
  assert.equal(call.transcript().filter(line => line.who === "user").length, 1, "A late recognition fragment belongs to its existing user line");
  socket.message({ voiceActivity: { type: "ACTIVITY_START" } });
  socket.message({ serverContent: { inputTranscription: { text: "一加一是多少？" } } }); socket.message({ voiceActivity: { type: "ACTIVITY_END" } });
  speech(socket, "", "等于二"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(2, call.id);
  assert.equal(played, 2, "A real new question reopens speech without reopening the old goal");
  assert.equal(call.presentation.snapshot().status, "completed");
});

test("Gemini ends colloquial Chinese requests after goodbye playback and ignores notices/new tools", async t => {
  for (const input of ["现在要把它挂了。", "没有，你可以挂了。", "把电话挂掉吧。", "不用继续讲了，你可以挂断了。", "今天就到这儿了。"]) {
    const { call, socket, phases, states } = fixture(); t.after(() => call.hangup());
    speech(socket, input, "好的，再见。");
    tool(socket, "bye", "end_call", { user_request: input }); await sleep();
    assert.equal(states.at(-1)?.phase, "ending");
    call.notify("late-result", "Do not speak this result"); tool(socket, "new-tool", "read_file", { path: "x" });
    socket.message({ serverContent: { turnComplete: true } }); await sleep(400);
    assert.equal(phases.includes("closed"), false, "Goodbye is still playing");
    call.noteSpeakerIdle(1, call.id); await sleep(400);
    assert.equal(phases.at(-1), "closed"); assert.equal(socket.sent.some(p => p.clientContent?.turnComplete === true), false);
  }
});
test("Gemini waits for late and fragmented ASR, blocks negated/quoted requests, and closes instead of reconnecting while ending", async t => {
  const { call, socket, phases, sockets } = fixture(); t.after(() => call.hangup());
  speech(socket, "不要挂断", "好的"); socket.message({ serverContent: { turnComplete: true } }); call.noteSpeakerIdle(1, call.id);
  socket.message({ voiceActivity: { type: "ACTIVITY_START" } }); socket.message({ voiceActivity: { type: "ACTIVITY_END" } });
  tool(socket, "late", "end_call", { user_request: "没有，你可以挂了。" });
  await sleep(50); socket.message({ serverContent: { inputTranscription: { text: "没有，" } } }); await sleep(80);
  assert.equal(socket.result("late"), undefined);
  socket.message({ serverContent: { inputTranscription: { text: "你可以挂了。" }, outputTranscription: { text: "再见" } } });
  await sleep(100); assert.match(socket.result("late")?.response.result, /结束通话/);
  socket.message({ sessionResumptionUpdate: { resumable: true, newHandle: "private-resume" } });
  socket.emit("close", { code: 1006 }); await sleep(500);
  assert.equal(phases.at(-1), "closed"); assert.equal(sockets.length, 1, "Do not resurrect an ending call");
});
test("Gemini cannot treat a negation as consent even with a model quote", async t => {
  for (const input of ["别急着挂电话", "现在还不要挂了", "先不要结束这次通话", "Don't hang up yet."]) {
    const { call, socket, phases } = fixture(); t.after(() => call.hangup());
    speech(socket, input, "好的"); tool(socket, "end", "end_call", { user_request: input }); await sleep();
    assert.equal(socket.result("end")?.response.result.status, "call_remains_open"); assert.equal(phases.includes("closed"), false);
  }
});
test("ending call has a bounded fallback when playback receipts or turn completion are lost", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, socket, phases } = fixture(); t.after(() => call.hangup());
  speech(socket, "现在挂了吧", "好的"); tool(socket, "end", "end_call", { user_request: "现在挂了吧" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(phases.includes("closed"), false); t.mock.timers.tick(8001);
  assert.equal(phases.at(-1), "closed");
});

test("Gemini shares JPEG frames passively, defers context during playback, and restores visuals on the same resumed session", async t => {
  const { call, socket, sockets } = fixture(); t.after(() => call.hangup());
  socket.message({ sessionResumptionUpdate: { resumable: true, newHandle: "visual-resume" } });
  const image = { key: "view:pdf:1", refId: "pdf", filename: "paper.pdf", page: 1, revision: 1, mimeType: "image/jpeg" as const, data: "JPEG-PIXELS" };
  await call.shareVisual([image]); assert.deepEqual(socket.sent.at(-1)?.realtimeInput.video, { mimeType: "image/jpeg", data: "JPEG-PIXELS" });
  speech(socket, "question", "answer"); const before = socket.sent.length;
  call.updateContext("workspace", "current page 2"); assert.equal(socket.sent.length, before, "Passive text must not interrupt generation");
  socket.message({ serverContent: { turnComplete: true } }); assert.equal(socket.sent.length, before, "Wait for speaker drain too");
  call.noteSpeakerIdle(1, call.id);
  const passive = socket.sent.find(p => p.clientContent?.turnComplete === false); assert.match(passive!.clientContent.turns[0].parts[0].text, /current page 2/);
  assert.equal(socket.sent.some(p => p.clientContent?.turnComplete === true), false);
  socket.emit("close", { code: 1006 }); await sleep(350); const resumed = sockets[1]!; resumed.emit("open"); resumed.message({ setupComplete: {} }); await sleep(750);
  assert.deepEqual(resumed.sent[0]!.setup.sessionResumption, { handle: "visual-resume" });
  assert.equal(resumed.sent.filter(p => p.realtimeInput?.video?.data === "JPEG-PIXELS").length, 1);
  assert.equal(resumed.sent.some(p => p.clientContent?.turnComplete === false), true);
});

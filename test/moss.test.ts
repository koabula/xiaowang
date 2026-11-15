import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MossCall, type MossSocket, type MossHandlers } from "../desktop/main/moss-call.ts";
import type { AudioIdentity, PlaybackInterruption } from "../desktop/main/call.ts";
import { resolveRealtime, realtimeKeyPage, keyForService } from "../src/realtime-catalog.ts";
import { realtimeEndpoint, voiceTools } from "../src/realtime.ts";
import { mossSession } from "../src/moss-realtime.ts";
import type { TaskJob } from "../src/types.ts";
import { projectVoiceBrief } from "../src/project.ts";
import type { Bot, StoredEvent } from "../src/types.ts";
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
class Socket implements MossSocket {
  sent: Array<Record<string, unknown> | Buffer> = [];
  handlers = new Map<string, (event: { data?: unknown }) => void>();
  send(value: string | Buffer): void { this.sent.push(typeof value === "string" ? JSON.parse(value) : value); }
  close(): void { this.handlers.get("close")?.({}); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void { this.handlers.set(type, listener); }
  emit(action: string, data: Record<string, unknown> = {}): void { this.handlers.get("message")?.({ data: JSON.stringify({ action, data }) }); }
  binary(data: Buffer): void { this.handlers.get("message")?.({ data }); }
  events(action: string) { return this.sent.filter((value): value is Record<string, unknown> => !Buffer.isBuffer(value) && value.action === action); }
}
function job(patch: Partial<TaskJob> = {}): TaskJob { return { id: "job", botId: "bot", task: "分析论文", title: "分析论文", channel: "voice", notify: "silent", status: "running", createdAt: "now", updatedAt: "now", activity: "正在读论文", result: "", error: "", artifacts: [], attempts: 1, ...patch }; }
function fixture(t: TestContext, extra: Partial<MossHandlers> = {}, preview = "") {
  const sockets: Socket[] = [], audio: Array<{ serial: number; identity: AudioIdentity }> = [], interrupts: PlaybackInterruption[] = [], lines: unknown[] = [], final: string[] = [], phases: string[] = [], tools: string[] = [];
  const voice = resolveRealtime({ service: "moss" }).voice;
  const call = new MossCall("wss://api.mosi.cn/v1/realtime", "secret", mossSession("brief", voiceTools([]), voice), {
    onPhase: (phase, detail) => phases.push(`${phase}:${detail ?? ""}`), onAudio: (_pcm, serial, identity) => audio.push({ serial, identity: identity! }),
    onInterrupt: value => interrupts.push(value), onLine: (...line) => lines.push(line), onTranscript: (_who, value) => final.push(value),
    runTool: async name => { tools.push(name); return "result"; }, ...extra,
  }, (_url, headers) => { assert.deepEqual(headers, { Authorization: "Bearer secret" }); const socket = new Socket(); sockets.push(socket); return socket; }, preview);
  t.after(() => call.hangup()); call.start();
  const configure = (socket = sockets.at(-1)!) => {
    socket.handlers.get("open")?.({});
    socket.emit("session_attached", { session_id: "session", memory_scope: "session", delegation: "client" });
    socket.emit("session.updated", { error: "" }); socket.emit("voice_changed", { name: voice });
    socket.emit("media.configured", { input_audio: { format: "pcm16", sample_rate: 16000 }, output_audio: { format: "pcm16", sample_rate: 24000 }, playback: "client", error: "" });
  };
  const speak = (run = "run", turn = "turn", chunk = "chunk", ms = 100) => {
    const socket = sockets.at(-1)!; socket.emit("response.audio.started", { run_id: run, turn_id: turn });
    socket.emit("response.audio.context", { run_id: run, turn_id: turn, chunk_id: chunk }); socket.binary(Buffer.alloc(ms * 48));
  };
  return { call, sockets, socket: sockets[0]!, audio, interrupts, lines, final, phases, tools, configure, speak };
}
test("MOSS is a separate service with isolated credentials and native delegation tools", () => {
  const choice = resolveRealtime({ service: "moss" });
  assert.equal(choice.model, "moss-live-1.0"); assert.equal(choice.url, "wss://api.mosi.cn/v1/realtime");
  assert.equal(realtimeEndpoint({ ...choice, family: "moss" }).inputRate, 16000);
  assert.equal(keyForService("moss", "", "text-secret", "https://api.openai.com/v1"), "");
  assert.equal(realtimeKeyPage("moss", ""), "https://platform.moss.cn/app/api-keys/");
  const session = mossSession("brief", voiceTools([]), choice.voice).session as { tools: Array<{ name: string }> };
  assert.ok(!session.tools.some(tool => ["delegate_task", "ask_text"].includes(tool.name)));
});
test("MOSS waits for all negotiation receipts before sending raw microphone PCM", t => {
  const f = fixture(t); f.call.sendAudio(Buffer.alloc(80)); assert.equal(f.socket.sent.length, 0);
  f.configure(); assert.deepEqual(f.socket.events("attach_session")[0], { action: "attach_session", session_id: null, memory_scope: "session", delegation: { type: "client" } });
  f.call.sendAudio(Buffer.alloc(80)); assert.ok(Buffer.isBuffer(f.socket.sent.at(-1)));
  f.call.setMuted(true); const n = f.socket.sent.length; f.call.sendAudio(Buffer.alloc(80)); assert.equal(f.socket.sent.length, n);
  f.call.setMuted(false); assert.equal(f.socket.events("mic_state").at(-1)?.enabled, true);
});
test("MOSS playback acknowledges actual chunks, not receipt or transmission completion", t => {
  const f = fixture(t); f.configure(); f.speak(); f.socket.emit("response.audio.done", { run_id: "run", turn_id: "turn" });
  assert.equal(f.socket.events("playback.completed").length, 0);
  const a = f.audio[0]!;
  f.call.noteChunkPlayed({ ...a.identity, serial: a.serial, callId: "old-call", playedMs: 100 });
  assert.equal(f.socket.events("playback.chunk.completed").length, 0);
  f.call.noteChunkPlayed({ ...a.identity, serial: a.serial, playedMs: 100 });
  f.call.noteChunkPlayed({ ...a.identity, serial: a.serial, playedMs: 100 });
  assert.equal(f.socket.events("playback.chunk.completed").length, 1); assert.equal(f.socket.events("playback.completed").length, 1);
});
test("MOSS stop uses partial head-chunk duration, rejects late audio, and accepts the next reply", t => {
  const f = fixture(t); f.configure(); f.speak("r", "t", "1");
  const first = f.audio[0]!; f.call.noteChunkPlayed({ ...first.identity, serial: first.serial, playedMs: 100 });
  f.speak("r", "t", "2", 500); f.socket.emit("input.speech.started"); assert.equal(f.interrupts.length, 0, "MOSS decides actual barge-in");
  f.socket.emit("response.audio.stop", { run_id: "r", turn_id: "t" }); const interrupted = f.interrupts[0]!;
  const second = f.audio[1]!;
  f.call.noteInterrupted({ callId: f.call.id, playbackEpoch: interrupted.playbackEpoch, position: { ...second.identity, serial: second.serial, playedMs: 125 } });
  assert.equal(f.socket.events("playback.stopped")[0]?.played_audio_ms, 125);
  f.speak("r", "t", "late"); assert.equal(f.audio.length, 2);
  f.socket.emit("response.interrupted", { run_id: "r", turn_id: "t" }); assert.equal(f.interrupts.length, 1);
  f.speak("new", "next", "1"); assert.equal(f.audio.length, 3);
});
test("MOSS ASR snapshots and revisions replace one line without redispatch", t => {
  const f = fixture(t); f.configure();
  f.socket.emit("input.transcript.updated", { text: "分析" }); f.socket.emit("input.transcript.updated", { text: "分析这篇" });
  f.socket.emit("input.transcript.done", { text: "分析这篇论文", turn: "opaque-turn" });
  f.socket.emit("input.transcript.revised", { previous: "分析这篇论文", text: "分析另一篇论文", turn: "opaque-turn" });
  assert.deepEqual(f.call.transcript(), [{ who: "user", text: "分析另一篇论文" }]); assert.deepEqual(f.final, ["分析这篇论文", "分析另一篇论文"]);
});
test("MOSS revised ASR replaces the same item in future voice context without rewriting the event log", () => {
  const bot: Bot = { id: "bot", slug: "bot", name: "王", systemPrompt: "", glossary: [], workspaceDir: "", parentBotId: null, avatarSeed: "", avatarInk: "", createdAt: "now" };
  const events: StoredEvent[] = ["旧识别", "修订识别"].map((value, id) => ({ id, botId: "bot", createdAt: "now", event: { type: "voice_line", callId: "call", itemId: "same", who: "user", text: value } }));
  assert.deepEqual(projectVoiceBrief(bot, events).recentTurns, [{ role: "user", text: "修订识别" }]); assert.equal(events.length, 2);
});
test("MOSS output snapshots without identifiers join the later identified final line", t => {
  const f = fixture(t); f.configure();
  f.socket.emit("output.transcript.updated", { text: "你好" });
  f.socket.emit("response.audio.started", { run_id: "r", turn_id: "t" });
  f.socket.emit("output.transcript.done", { run_id: "r", turn_id: "t", text: "你好，我在。" });
  assert.deepEqual(f.call.transcript(), [{ who: "assistant", text: "你好，我在。" }]);
});
test("MOSS tools execute once and resume only after the matching output acknowledgement", async t => {
  const f = fixture(t); f.configure();
  const args = { call_id: "tool", name: "list_library", arguments: "{}" };
  f.socket.emit("response.function_call_arguments.done", args); f.socket.emit("response.function_call_arguments.done", args); await wait();
  assert.deepEqual(f.tools, ["list_library"]); assert.equal(f.socket.events("response.create").length, 0);
  f.socket.emit("conversation.item.created", { item: { call_id: "wrong" } }); assert.equal(f.socket.events("response.create").length, 0);
  f.socket.emit("conversation.item.created", { item: { call_id: "tool" } });
  assert.deepEqual(f.socket.events("response.create")[0]?.response, { call_ids: ["tool"] });
});
test("MOSS native delegation is idempotent; cancellation stops its executor and suppresses stale results", t => {
  let count = 0; const cancelled: string[] = [];
  const f = fixture(t, { delegate: task => { assert.equal(task.sessionId, "session"); count++; return job(); }, cancelDelegation: id => cancelled.push(id) }); f.configure();
  const task = { delegation: { id: "d1" }, objective: "分析论文", purpose: "task" };
  f.socket.emit("session.delegation.created", task); f.socket.emit("session.delegation.created", task); assert.equal(count, 1);
  f.socket.emit("session.delegation.cancelled", { delegation_id: "d1" }); assert.deepEqual(cancelled, ["job"]);
  f.call.jobChanged(job({ status: "succeeded", result: "stale" })); assert.equal(f.socket.events("session.commentary.append").length, 0);
});
test("MOSS reconnect resumes the session and retries the same result event without rerunning work", async t => {
  let count = 0;
  const f = fixture(t, { delegate: () => { count++; return job(); } }); f.configure();
  f.socket.emit("session.delegation.created", { delegation: { id: "d" }, objective: "分析论文" });
  f.call.jobChanged(job({ status: "succeeded", result: "😀".repeat(3000), artifacts: ["notes/result.md"] }));
  const result = f.socket.events("session.commentary.append")[0]!;
  assert.ok(Array.from(String(result.content)).length <= 2000); assert.match(String(result.content), /完整结果保存在本次通话中/); assert.match(String(result.content), /notes\/result.md/);
  f.socket.close(); await wait(550); f.configure(); const socket = f.sockets[1]!;
  assert.equal(socket.events("attach_session")[0]?.session_id, "session"); assert.deepEqual(socket.events("session.commentary.append")[0], result);
  socket.emit("session.delegation.created", { delegation: { id: "d" }, objective: "分析论文" }); assert.equal(count, 1);
  socket.emit("session.commentary.appended", { client_event_id: result.event_id });
  f.call.jobChanged(job({ status: "succeeded", result: "😀".repeat(3000), artifacts: ["notes/result.md"] }));
  assert.equal(socket.events("session.commentary.append").length, 1);
});
test("MOSS configuration errors terminate visibly instead of waiting silently", t => {
  const f = fixture(t); f.socket.handlers.get("open")?.({}); f.socket.emit("session_attached", { session_id: "s", memory_scope: "session", delegation: "client" });
  f.socket.emit("session.updated", { error: "invalid tools" }); assert.equal(f.call.isClosed(), true); assert.match(f.phases.at(-1)!, /invalid tools/);
});

test("MOSS continuous speech waits for transmission and actual playback, and pause holds continuation", async t => {
  const f = fixture(t); f.configure(); f.call.presentation.start("逐页讲解"); f.speak();
  f.socket.emit("response.function_call_arguments.done", { call_id: "continue", name: "continue_speaking", arguments: "{}" }); await wait();
  const a = f.audio[0]!; f.call.noteChunkPlayed({ ...a.identity, serial: a.serial, playedMs: 100 });
  assert.equal(f.socket.events("conversation.item.create").length, 0, "More audio may still arrive before audio.done");
  f.call.control("pause"); f.socket.emit("response.audio.done", { run_id: "run", turn_id: "turn" });
  assert.equal(f.socket.events("conversation.item.create").length, 0);
  f.call.control("resume");
  assert.equal(f.socket.events("conversation.item.create").length, 1);
  f.socket.emit("conversation.item.created", { item: { call_id: "continue" } });
  assert.equal(f.socket.events("response.create").length, 1);
});
test("MOSS interruption aborts obsolete foreground tools and continuous speech but not delegated work", async t => {
  let aborted = false, resolve: (value: string) => void = () => {};
  const f = fixture(t, { runTool: (_name, _args, _id, signal) => new Promise(done => { resolve = done; signal?.addEventListener("abort", () => { aborted = true; }); }) });
  f.configure(); f.speak();
  f.socket.emit("response.function_call_arguments.done", { call_id: "reading", name: "read_file", arguments: "{}" });
  f.socket.emit("response.function_call_arguments.done", { call_id: "continue", name: "continue_speaking", arguments: "{}" });
  f.socket.emit("response.audio.stop", { run_id: "run", turn_id: "turn" }); resolve("old result"); await wait();
  assert.equal(aborted, true); assert.equal(f.socket.events("conversation.item.create").length, 0); assert.equal(f.socket.events("response.create").length, 0);
});
test("MOSS zero-length audio is acknowledged without creating a silent stuck player", t => {
  const f = fixture(t); f.configure(); f.speak("empty", "turn", "1", 0);
  f.socket.emit("response.audio.done", { run_id: "empty", turn_id: "turn" });
  assert.equal(f.audio.length, 0); assert.equal(f.socket.events("playback.chunk.completed").length, 1); assert.equal(f.socket.events("playback.completed").length, 1);
});

test("MOSS manual retry returns through session commentary without reopening a terminal delegation", t => {
  const f = fixture(t, { delegate: () => job() }); f.configure();
  f.socket.emit("session.delegation.created", { delegation: { id: "d" }, objective: "分析论文" });
  f.call.jobChanged(job({ status: "failed", error: "temporary" }));
  const failed = f.socket.events("session.commentary.append")[0]!;
  f.socket.emit("session.commentary.appended", { client_event_id: failed.event_id });
  f.call.jobChanged(job({ status: "running", attempts: 2 })); f.call.jobChanged(job({ status: "succeeded", attempts: 2, result: "retried result" }));
  const result = f.socket.events("session.commentary.append").at(-1)!;
  assert.equal(result.delegation_id, undefined); assert.equal(result.content, "retried result");
  assert.equal(f.call.isClosed(), false);
});

test("MOSS voice preview ends only after actual audio playback", t => {
  const f = fixture(t, {}, "你好，我是小王。"); f.configure();
  assert.equal(f.socket.events("session.commentary.append")[0]?.content, "你好，我是小王。");
  f.speak(); f.socket.emit("response.audio.done", { run_id: "run", turn_id: "turn" }); assert.equal(f.call.isClosed(), false);
  const chunk = f.audio[0]!; f.call.noteChunkPlayed({ ...chunk.identity, serial: chunk.serial, playedMs: 100 }); assert.equal(f.call.isClosed(), true);
});

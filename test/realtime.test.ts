import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCall, type VoiceState } from "../desktop/main/call.ts";
import { keyForService, realtimeKeyPage, resolveRealtime, voicesFor } from "../src/realtime-catalog.ts";
import { DOUBAO_REALTIME_URL, DOUBAO_REALTIME_MODEL, PREVIEW_LINE, QWEN_REALTIME_MODEL, QWEN_REALTIME_URL, doubaoSession, foldTranscript, functionOutput, mergeUtterance, parseRealtimeEvent, pcm16FromFloat, realtimeEndpoint, realtimeInstructions, sessionUpdate, socketUrl, voiceTools } from "../src/realtime.ts";

const delay = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t: { after(fn: () => void): void }, runTool: (name: string, args: string) => Promise<string> = async () => "实际结果", url = "wss://api.openai.com/v1/realtime", preview = "") {
  const sent: Record<string, any>[] = [];
  const listeners = new Map<string, (event: { data?: unknown }) => void>();
  const states: VoiceState[] = [];
  let interruptions = 0;
  const socket = { send: (data: string) => sent.push(JSON.parse(data)), close() {}, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { listeners.set(type, fn); } };
  const isDoubao = url === DOUBAO_REALTIME_URL;
  const call = new LiveCall(url, "test-key", isDoubao ? doubaoSession({ instructions: "小王", tools: [] }) : { type: "session.update", session: { instructions: "小王" } }, {
    onPhase() {}, onAudio() {}, onInterrupt() { interruptions++; }, onLine() {}, onTranscript() {}, onState(state) { states.push(state); }, runTool,
  }, () => socket, preview);
  t.after(() => call.hangup());
  call.start(); listeners.get("open")?.({});
  const emit = (data: unknown) => listeners.get("message")?.({ data: JSON.stringify(data) });
  emit({ type: "session.created" }); if (!isDoubao) emit({ type: "session.updated" });
  const begin = (id: string) => emit({ type: "response.created", response: { id } });
  const done = (id: string, status = "completed") => emit({ type: "response.done", response: { id, status, output: [] } });
  const tool = (id: string, callId: string, name: string, args = "{}") => emit({ type: "response.function_call_arguments.done", response_id: id, call_id: callId, name, arguments: args });
  const audio = (id: string, itemId = `item_${id}`) => emit({ type: "response.output_audio.delta", response_id: id, item_id: itemId, content_index: 0, delta: Buffer.alloc(480).toString("base64") });
  const creates = () => sent.filter(event => event.type === "response.create");
  return { call, sent, states, emit, begin, done, tool, audio, creates, interruptions: () => interruptions };
}

test("provider-specific session configuration and audio rates", () => {
  const qwen = realtimeEndpoint();
  assert.equal(qwen.family, "qwen"); assert.equal(qwen.url, QWEN_REALTIME_URL); assert.equal(qwen.model, QWEN_REALTIME_MODEL);
  assert.equal(qwen.inputRate, 16_000); assert.equal(qwen.outputRate, 24_000); assert.equal(qwen.transcriptionModel, "qwen3-asr-flash-realtime");
  assert.match(socketUrl(qwen), /model=qwen3.5/);
  const tools = [{ name: "read_file", description: "read", parameters: { type: "object" } }];
  const q = sessionUpdate({ instructions: "小王", tools, audioFormat: "pcm", transcriptionModel: qwen.transcriptionModel }).session as any;
  assert.equal(q.tools[0].function.name, "read_file"); assert.equal(q.audio.input.format.sample_rate, 16000);
  const o = sessionUpdate({ instructions: "小王", tools, audioFormat: "pcm16", transcriptionModel: "gpt-4o-mini-transcribe" }).session as any;
  assert.equal(o.type, "realtime"); assert.deepEqual(o.output_modalities, ["audio"]); assert.equal(o.tools[0].name, "read_file");
  assert.equal(o.audio.input.turn_detection.create_response, false); assert.equal(o.audio.input.turn_detection.interrupt_response, false);
  assert.equal(realtimeEndpoint({ url: "wss://api.openai.com/v1/realtime" }).inputRate, 24000);
  const d = doubaoSession({ instructions: "小王", tools }).session as any;
  assert.equal(d.model, DOUBAO_REALTIME_MODEL); assert.equal(d.audio.output.format.rate, 24000);
});

test("voice tools expose durable delegation and presentation controls in both languages", () => {
  for (const locale of ["zh", "en"] as const) {
    const instructions = realtimeInstructions("王", "任务：research", locale);
    assert.match(instructions, /delegate_task/); assert.match(instructions, /manage_presentation/);
    const tools = voiceTools([], locale).map(tool => tool.name);
    for (const name of ["delegate_task", "get_task", "manage_presentation", "continue_speaking", "end_call", "ask_text"]) assert.ok(tools.includes(name));
  }
});

test("event identity, response status and real audio completion stay distinct", () => {
  assert.deepEqual(parseRealtimeEvent("not-json"), []);
  assert.deepEqual(parseRealtimeEvent('{"type":"session.updated"}'), [{ kind: "session.updated" }]);
  const audio = parseRealtimeEvent(JSON.stringify({ type: "response.output_audio.delta", response_id: "r1", item_id: "i1", content_index: 0, delta: "AAE=" }))[0];
  assert.equal(audio?.responseId, "r1"); assert.equal(audio?.itemId, "i1");
  assert.equal(parseRealtimeEvent('{"type":"response.output_audio.done"}')[0]?.kind, "audio_done");
  const failed = parseRealtimeEvent(JSON.stringify({ type: "response.done", response: { id: "r2", status: "failed", status_details: { error: { message: "capacity" } } } }))[0];
  assert.equal(failed?.kind, "response_done"); if (failed?.kind === "response_done") { assert.equal(failed.status, "failed"); assert.equal(failed.error, "capacity"); }
  const result = parseRealtimeEvent(JSON.stringify({ type: "response.done", response: { id: "r3", status: "completed", output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }] } }));
  assert.equal(result[0]?.kind, "function_call"); assert.equal(result.at(-1)?.kind, "response_done");
  const transcript = parseRealtimeEvent('{"type":"conversation.item.input_audio_transcription.completed","transcript":"你好"}');
  assert.equal(transcript.length, 1); assert.equal(transcript[0]?.kind, "user_transcript");
});

test("tools return actual results under their own call IDs and a batch starts one response", async t => {
  const f = fixture(t, async name => `result:${name}`);
  f.begin("r1"); f.tool("r1", "a", "read_file"); f.tool("r1", "b", "list_library");
  await delay(); assert.equal(f.creates().length, 0);
  f.done("r1"); await delay(30);
  assert.equal(f.creates().length, 1);
  const outputs = f.sent.filter(event => event.item?.type === "function_call_output");
  assert.deepEqual(outputs.map(event => [event.item.call_id, event.item.output]), [["a", "result:read_file"], ["b", "result:list_library"]]);
  assert.equal(f.sent.some(event => event.item?.role === "user"), false);
  f.tool("r1", "a", "read_file"); await delay(); assert.equal(f.creates().length, 1);
});

test("a persistent walkthrough continues without continue_speaking and waits for actual playback", async t => {
  const f = fixture(t);
  f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "带我把整份材料逐页讲完" });
  f.call.locate("deck.html", 1, 3);
  f.begin("r1"); f.audio("r1"); f.done("r1");
  await delay(400); assert.equal(f.creates().length, 0);
  f.call.noteSpeakerIdle(1); await delay(400); assert.equal(f.creates().length, 1);
  assert.equal(f.call.presentation.snapshot().status, "active");
  assert.match(JSON.stringify(f.sent), /deck.html/);
});

test("acknowledgments and questions preserve a walkthrough; explicit pause and stop do not resume", async t => {
  const f = fixture(t);
  f.call.presentation.start("讲完"); f.call.locate("deck.html", 2, 5);
  f.begin("r1"); f.audio("r1");
  f.call.notePlayback({ serial: 1, itemId: "item_r1", contentIndex: 0, playedMs: 100 });
  f.emit({ type: "input_audio_buffer.speech_started" });
  assert.equal(f.interruptions(), 1);
  assert.equal(f.sent.find(event => event.type === "conversation.item.truncate")?.audio_end_ms, 100);
  f.emit({ type: "input_audio_buffer.speech_stopped" }); f.emit({ type: "input_audio_buffer.committed" });
  f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "OK" });
  f.done("r1", "cancelled"); await delay(30);
  assert.equal(f.creates().length, 1);
  f.begin("r2"); f.audio("r2"); f.done("r2"); f.call.noteSpeakerIdle(2);
  await delay(400); assert.equal(f.creates().length, 2);
  assert.equal(f.call.presentation.snapshot().page, 2);
  f.begin("r3"); f.audio("r3"); f.done("r3"); f.call.noteSpeakerIdle(3);
  f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "先停一下" });
  await delay(400); assert.equal(f.creates().length, 2); assert.equal(f.call.presentation.snapshot().status, "paused");
  f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "不用讲了" });
  assert.equal(f.call.presentation.snapshot().status, "completed");
});

test("late audio, tool calls and completion from an interrupted response cannot corrupt the next response", async t => {
  let tools = 0;
  const f = fixture(t, async () => { tools++; return "ok"; });
  f.begin("old"); f.audio("old"); f.emit({ type: "input_audio_buffer.speech_started" }); f.done("old", "cancelled");
  f.emit({ type: "input_audio_buffer.speech_stopped" }); f.emit({ type: "input_audio_buffer.committed" }); await delay();
  f.begin("new"); const before = f.states.length;
  f.audio("old"); f.tool("old", "late", "write_file"); f.done("old");
  assert.equal(tools, 0); assert.equal(f.states.length, before);
  f.audio("new"); assert.equal(f.states.at(-1)?.phase, "speaking");
});

test("queued job results wait until the user and speaker are idle, and notify only once", async t => {
  const f = fixture(t);
  f.emit({ type: "input_audio_buffer.speech_started" }); f.call.notify("job1", "资料整理好了");
  await delay(400); assert.equal(f.creates().length, 0);
  f.emit({ type: "input_audio_buffer.speech_stopped" }); f.emit({ type: "input_audio_buffer.committed" }); await delay();
  f.begin("r1"); f.audio("r1"); f.done("r1");
  await delay(400); assert.equal(f.creates().length, 1);
  f.call.noteSpeakerIdle(1); await delay(400); assert.equal(f.creates().length, 2);
  assert.match(JSON.stringify(f.sent), /资料整理好了/);
  f.begin("r2"); f.done("r2"); f.call.notify("job1", "资料整理好了"); await delay(400);
  assert.equal(f.creates().length, 2);
});

test("response failure pauses automatic continuation and remains visible", async t => {
  const f = fixture(t); f.call.presentation.start("present"); f.begin("r1"); f.done("r1", "failed");
  await delay(400); assert.equal(f.creates().length, 0); assert.equal(f.call.presentation.snapshot().status, "paused"); assert.equal(f.states.at(-1)?.phase, "error");
});

test("OpenAI VAD waits for input commit and triggers only one user response", async t => {
  const f = fixture(t); f.emit({ type: "input_audio_buffer.speech_started" }); f.emit({ type: "input_audio_buffer.speech_stopped" });
  await delay(); assert.equal(f.creates().length, 0);
  f.emit({ type: "input_audio_buffer.committed" }); await delay(); assert.equal(f.creates().length, 1);
  f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "你好" }); await delay(); assert.equal(f.creates().length, 1);
});

test("preview and end_call wait for audible goodbye completion", async t => {
  for (const preview of ["", PREVIEW_LINE]) {
    const f = fixture(t, undefined, undefined, preview); f.begin(`bye${preview}`); f.audio(`bye${preview}`);
    if (!preview) f.tool(`bye${preview}`, "end", "end_call");
    f.done(`bye${preview}`); await delay(); assert.equal(f.call.isClosed(), false);
    f.call.noteSpeakerIdle(1); await delay(); assert.equal(f.call.isClosed(), true);
  }
});

test("doubao tool result stays correlated and does not commit an empty audio buffer", async t => {
  const f = fixture(t, async () => "找到两篇", DOUBAO_REALTIME_URL);
  f.begin("d1"); f.emit({ type: "response.function_call_arguments.done", response_id: "d1", items: [{ type: "function_call", call_id: "dc1", name: "search_literature", arguments: "{}" }] }); f.done("d1");
  await delay(30);
  assert.equal(f.sent.find(event => event.items?.[0]?.role === "tool")?.items[0].call_id, "dc1");
  assert.equal(f.sent.some(event => event.type === "input_audio_buffer.commit"), false);
  assert.equal(f.sent.some(event => event.type === "response.create"), false);
  assert.equal((functionOutput("x", "结果", "doubao").items as any[])[0].role, "tool");
});

test("transcript revisions replace rather than duplicate, while separate utterances remain separate", () => {
  assert.equal(foldTranscript("Hello", "Hello there"), "Hello there");
  assert.equal(mergeUtterance("第九页", "第9页讲完"), "第9页讲完");
  assert.equal(mergeUtterance("你好", "你好"), "你好");
  const pcm = pcm16FromFloat(new Float32Array([0, .5, -1, 1]), 32000, 16000);
  assert.equal(pcm.length, 4); assert.equal(new DataView(pcm.buffer).getInt16(0, true), Math.round(.25 * 0x7fff));
});

test("service catalogs retain selected voices and service-specific keys", () => {
  const q = resolveRealtime({ service: "qwen", model: "qwen3.8-omni-flash-realtime", workspace: "space", region: "singapore" });
  assert.match(q.url, /space.ap-southeast-1/);
  assert.ok(voicesFor("openai", "").some(voice => voice.id === "marin"));
  assert.equal(keyForService("openai", "", "text", "https://api.deepseek.com/v1"), "");
  assert.equal(keyForService("openai", "", "text", "https://api.openai.com/v1"), "text");
  assert.match(realtimeKeyPage("doubao", ""), /volcengine/);
});

test("opening a different source preserves the suspended presentation position", t => {
  const f = fixture(t); f.call.presentation.start("present"); f.call.locate("deck.html", 4, 8);
  f.call.control("pause"); f.call.locate("source.pdf", 1, 10, "file");
  assert.equal(f.call.presentation.snapshot().path, "deck.html"); assert.equal(f.call.presentation.snapshot().page, 4);
  f.call.control("complete"); f.call.locate("source.pdf", 2, 10, "file");
  assert.equal(f.call.presentation.snapshot().page, 4);
});

test("playback acknowledgments from another call cannot advance this call", async t => {
  const f = fixture(t); f.call.presentation.start("present"); f.begin("r1"); f.audio("r1"); f.done("r1");
  f.call.noteSpeakerIdle(1, "another-call"); await delay(400); assert.equal(f.creates().length, 0);
  f.call.noteSpeakerIdle(1, f.call.id); await delay(400); assert.equal(f.creates().length, 1);
});

test("late ASR completion updates its own utterance and cannot undo the latest pause command", t => {
  const f = fixture(t); f.call.presentation.start("present");
  f.emit({ type: "input_audio_buffer.speech_started", item_id: "first" });
  f.emit({ type: "input_audio_buffer.speech_stopped" }); f.emit({ type: "input_audio_buffer.committed", item_id: "first" });
  f.emit({ type: "input_audio_buffer.speech_started", item_id: "second" });
  f.emit({ type: "input_audio_buffer.speech_stopped" }); f.emit({ type: "input_audio_buffer.committed", item_id: "second" });
  f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "先停一下" });
  f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "继续" });
  assert.equal(f.call.presentation.snapshot().status, "paused");
  assert.deepEqual(f.call.transcript(), [{ who: "user", text: "继续" }, { who: "user", text: "先停一下" }]);
});

test("a transport reconnect keeps the task but never replays an old tool call", async t => {
  const sockets: Array<{ sent: any[]; emit(type: string, data?: unknown): void }> = [];
  const states: VoiceState[] = [];
  let runs = 0; let release: (() => void) | undefined;
  const call = new LiveCall("wss://api.openai.com/v1/realtime", "key", { type: "session.update", session: { instructions: "小王" } }, {
    onPhase() {}, onState(state) { states.push(state); }, onAudio() {}, onInterrupt() {}, onLine() {}, onTranscript() {},
    async runTool() { runs++; await new Promise<void>(resolve => { release = resolve; }); return "已完成读取"; },
  }, () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const sent: any[] = [];
    sockets.push({ sent, emit(type, data) { listeners.get(type)?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); } });
    return { send(data) { sent.push(JSON.parse(data)); }, close() {}, addEventListener(type, listener) { listeners.set(type, listener); } };
  });
  t.after(() => call.hangup()); call.start();
  sockets[0]!.emit("message", { type: "session.created" }); sockets[0]!.emit("message", { type: "session.updated" });
  call.presentation.start("讲完材料"); call.locate("deck.html", 2, 5);
  sockets[0]!.emit("message", { type: "response.created", response: { id: "old" } });
  sockets[0]!.emit("message", { type: "response.function_call_arguments.done", response_id: "old", call_id: "once", name: "read_file", arguments: "{}" });
  sockets[0]!.emit("close"); await delay(550);
  assert.equal(sockets.length, 2);
  sockets[1]!.emit("message", { type: "session.created" }); sockets[1]!.emit("message", { type: "session.updated" });
  sockets[0]!.emit("message", { type: "response.function_call_arguments.done", response_id: "old", call_id: "late", name: "write_file", arguments: "{}" });
  release!(); await delay(20);
  assert.equal(runs, 1); assert.equal(call.presentation.snapshot().page, 2);
  assert.ok(states.some(state => state.phase === "reconnecting"));
  assert.equal(sockets[1]!.sent.some(event => event.item?.call_id === "once"), false);
});

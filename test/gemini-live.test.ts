import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiLive, type GeminiHandlers, type GeminiSocket, type GeminiToolResult } from "../src/gemini-live.ts";

class Socket implements GeminiSocket {
  sent: Array<Record<string, any>> = [];
  listeners = new Map<string, Array<(event: any) => void>>();
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() {}
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
  emit(name: string, event: any = {}) { this.listeners.get(name)?.forEach(listener => listener(event)); }
  message(value: unknown) { this.emit("message", { data: JSON.stringify(value) }); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(patch: Partial<GeminiHandlers> = {}) {
  const socket = new Socket(); const audio: any[] = []; const interrupts: any[] = []; const lines: any[] = []; const closed: string[] = [];
  const session = new GeminiLive("test-secret", { instructions: "test", tools: [{ name: "research", description: "research", behavior: "NON_BLOCKING" }] }, {
    onReady() {}, onAudio: (...args) => audio.push(args), onInterrupt: value => interrupts.push(value), onText: (...args) => lines.push(args),
    onTurnComplete() {}, onClosed: reason => closed.push(reason), runTool: async () => ({ result: "ok" }), ...patch,
  }, headers => { assert.equal(headers["x-goog-api-key"], "test-secret"); return socket; });
  session.start(); socket.emit("open");
  return { session, socket, audio, interrupts, lines, closed };
}

test("Gemini waits for setup, receives all audio parts and stops real playback at interruption/hangup", () => {
  const { session, socket, audio, interrupts, lines } = fixture();
  assert.throws(() => session.sendText("early"), /尚未就绪/);
  assert.deepEqual(socket.sent[0]?.setup.contextWindowCompression, { triggerTokens: 32768, slidingWindow: { targetTokens: 16384 } });
  assert.equal(socket.sent[0]?.setup.tools[0].functionDeclarations[0].behavior, "NON_BLOCKING");
  socket.message({ setupComplete: {} });
  session.sendAudio(Buffer.alloc(320)); session.endAudio();
  assert.equal(socket.sent[1]?.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  socket.message({ serverContent: { inputTranscription: { text: "question" }, outputTranscription: { text: "answer" }, modelTurn: { parts: [
    { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAA==" } }, { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAAAA==" } },
  ] } } });
  assert.equal(audio.length, 2); assert.deepEqual(lines, [["user", "question"], ["assistant", "answer"]]);
  socket.message({ serverContent: { interrupted: true, turnComplete: true } });
  assert.equal(interrupts[0]?.throughSerial, 2);
  socket.message({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAAAA==" } }] } } });
  assert.notEqual(audio[0][2].responseId, audio[2][2].responseId);
  assert.equal(audio[2][2].playbackEpoch, 1);
  session.close(); assert.equal(interrupts[1]?.throughSerial, 3);
  assert.throws(() => session.sendText("late"), /尚未就绪/);
});

test("Gemini async tools do not block audio; cancellation revokes stale output without cancelling durable work", async () => {
  let release!: (result: GeminiToolResult) => void; let calls = 0; let completed = false; const cancelled: string[] = [];
  const { session, socket, audio } = fixture({ runTool: async () => { calls++; const result = await new Promise<GeminiToolResult>(resolve => { release = resolve; }); completed = true; return result; }, onToolCancelled: id => cancelled.push(id) });
  socket.message({ setupComplete: {} });
  const request = { toolCall: { functionCalls: [{ id: "task-1", name: "research", args: { task: "find" } }] } };
  socket.message(request); socket.message(request); await tick();
  socket.message({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAAAA==" } }] } } });
  assert.equal(audio.length, 1); assert.equal(calls, 1);
  socket.message({ toolCallCancellation: { ids: ["task-1"] } });
  release({ result: "durable result", scheduling: "SILENT" }); await tick();
  assert.equal(completed, true); assert.deepEqual(cancelled, ["task-1"]);
  assert.equal(socket.sent.some(value => value.toolResponse), false);
  session.close();
});

test("Gemini returns matching native tool IDs and redacts provider errors", async () => {
  const { session, socket, closed } = fixture({ runTool: async () => ({ result: "saved", scheduling: "SILENT" }) });
  socket.message({ setupComplete: {} }); socket.message({ toolCall: { functionCalls: [{ id: "id", name: "research" }] } }); await tick();
  assert.deepEqual(socket.sent.at(-1)?.toolResponse.functionResponses, [{ id: "id", name: "research", response: { result: "saved", scheduling: "SILENT" } }]);
  socket.message({ error: { message: "denied test-secret" } });
  assert.equal(closed[0]?.includes("test-secret"), false); assert.match(closed[0]!, /redacted/);
  session.close();
});

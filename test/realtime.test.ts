import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCall } from "../desktop/main/call.ts";
import { keyForService, realtimeKeyPage, resolveRealtime, voicesFor } from "../src/realtime-catalog.ts";
import {
  DOUBAO_REALTIME_MODEL,
  PREVIEW_LINE,
  previewCue,
  DOUBAO_REALTIME_URL,
  DOUBAO_VOICE,
  QWEN_REALTIME_MODEL,
  QWEN_REALTIME_URL,
  TOOL_ACCEPTED,
  askTextResult,
  doubaoSession,
  foldTranscript,
  mergeUtterance,
  voiceTools,
  functionOutput,
  parseRealtimeEvent,
  pcm16FromFloat,
  realtimeEndpoint,
  realtimeInstructions,
  sessionUpdate,
  socketUrl,
  spokenResult,
} from "../src/realtime.ts";

test("Qwen is the default realtime endpoint and OpenAI keeps its own audio rate", () => {
  const qwen = realtimeEndpoint();
  assert.equal(qwen.url, QWEN_REALTIME_URL);
  assert.equal(qwen.model, QWEN_REALTIME_MODEL);
  assert.equal(qwen.inputRate, 16_000);
  assert.equal(qwen.outputRate, 24_000);
  assert.equal(qwen.audioFormat, "pcm");
  assert.equal(socketUrl(qwen), `${QWEN_REALTIME_URL}?model=${QWEN_REALTIME_MODEL}`);

  const openai = realtimeEndpoint({ url: "wss://api.openai.com/v1/realtime", model: "gpt-realtime" });
  assert.equal(openai.inputRate, 24_000);
  assert.equal(openai.audioFormat, "pcm16");
  assert.match(socketUrl(openai), /model=gpt-realtime/);

  const preset = realtimeEndpoint({
    url: "wss://space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime",
    model: "ignored",
  });
  assert.equal(socketUrl(preset), "wss://space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime");

  const doubao = realtimeEndpoint({ url: DOUBAO_REALTIME_URL, model: "qwen3.5-omni-plus-realtime" });
  assert.equal(doubao.family, "doubao");
  assert.equal(doubao.model, DOUBAO_REALTIME_MODEL);
  assert.equal(doubao.inputRate, 16_000);
  assert.equal(doubao.audioFormat, "pcm_s16le");
  assert.equal(socketUrl(doubao), DOUBAO_REALTIME_URL);
});

test("a session carries the spoken instructions and the same tool names", () => {
  const update = sessionUpdate({
    instructions: realtimeInstructions("阿王", "任务：投机解码"),
    tools: [{ name: "search_literature", description: "检索", parameters: { type: "object" } }],
    audioFormat: "pcm",
    transcriptionModel: "gummy-realtime-v1",
  });
  const session = update.session as { instructions: string; tools: Array<{ name: string }> };
  assert.match(session.instructions, /你是「阿王」/);
  assert.match(session.instructions, /投机解码/);
  assert.match(session.instructions, /ask_text/);
  assert.match(session.instructions, /end_call/);
  assert.equal(session.tools[0]?.name, "search_literature");
  const voiced = voiceTools([{ name: "search_literature", description: "检索", parameters: { type: "object" } }]);
  assert.equal(voiced.at(-2)?.name, "ask_text");
  assert.equal(voiced.at(-1)?.name, "end_call");
  const english = realtimeInstructions("Wang", "Task: decoding", "en");
  assert.match(english, /ask_text/);
  assert.match(english, /slides/);
});

test("server events become audio, transcripts, and one function call", () => {
  assert.deepEqual(parseRealtimeEvent(JSON.stringify({ type: "session.updated" })), [{ kind: "session.updated" }]);
  const audio = parseRealtimeEvent(JSON.stringify({ type: "response.audio.delta", delta: Buffer.from("hi").toString("base64") }));
  assert.equal(audio[0]?.kind, "audio");
  if (audio[0]?.kind === "audio") assert.equal(audio[0].pcm.toString(), "hi");

  const done = parseRealtimeEvent(JSON.stringify({
    type: "response.done",
    response: { output: [{ type: "function_call", call_id: "call_1", name: "list_library", arguments: "{}" }] },
  }));
  assert.deepEqual(done[1], { kind: "function_call", callId: "call_1", name: "list_library", arguments: "{}" });

  const accepted = functionOutput("call_1", TOOL_ACCEPTED);
  assert.equal((accepted.item as { output: string }).output, TOOL_ACCEPTED);
  const later = spokenResult("找到 2 篇。");
  assert.match(JSON.stringify(later), /找到 2 篇/);
});

test("microphone samples become 16-bit little-endian pcm at the target rate", () => {
  const input = new Float32Array([0, 0.5, -1, 1]);
  const pcm = pcm16FromFloat(input, 32_000, 16_000);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  assert.equal(pcm.length, 4);
  assert.equal(view.getInt16(0, true), Math.round(0.25 * 0x7fff));
  assert.equal(view.getInt16(2, true), 0);
});

test("doubao events use tool items, spoken text, and 16-bit audio", () => {
  const session = doubaoSession({
    instructions: realtimeInstructions("阿王", "任务：投机解码"),
    tools: [{ name: "search_literature", description: "检索", parameters: { type: "object" } }],
  });
  const body = session.session as { model: string; audio: { output: { voice: string; format: { type: string } } }; tools: Array<{ name: string }> };
  assert.equal(session.type, "session.create");
  assert.equal(body.model, DOUBAO_REALTIME_MODEL);
  assert.equal(body.audio.output.voice, DOUBAO_VOICE);
  assert.equal(body.audio.output.format.type, "pcm_s16le");
  assert.equal(body.tools[0]?.name, "search_literature");

  const calls = parseRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    items: [{ type: "function_call", call_id: "call_weather_001", name: "search_literature", arguments: "{\"source\":\"openalex\"}" }],
  }));
  assert.equal(calls[0]?.kind, "function_call");
  const done = parseRealtimeEvent(JSON.stringify({ type: "response.output_text.done", text: "先看这一篇。" }));
  assert.deepEqual(done, [{ kind: "assistant_transcript", text: "先看这一篇。", partial: false }]);
  const heard = parseRealtimeEvent(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "帮我查一下" }));
  assert.equal(heard[0]?.kind, "speech_stopped");
  assert.deepEqual(heard[1], { kind: "user_transcript", text: "帮我查一下", partial: false });

  const tool = functionOutput("call_weather_001", "找到 2 篇。", "doubao");
  const item = (tool.items as Array<{ role: string; call_id: string; content: Array<{ text: string }> }>)[0];
  assert.equal(item?.role, "tool");
  assert.equal(item?.call_id, "call_weather_001");
  assert.match(item?.content[0]?.text ?? "", /找到 2 篇/);
});

test("a doubao call sends the session on open and keeps the tool result in its own item", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  let headers: Record<string, string> = {};
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  let finish = (_output: string) => {};
  const phases: string[] = [];
  const call = new LiveCall(DOUBAO_REALTIME_URL, "volc-key", doubaoSession({ instructions: "你是阿王", tools: [] }), {
    onPhase(phase) {
      phases.push(phase);
    },
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    runTool() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  }, (_url, nextHeaders) => {
    headers = nextHeaders;
    return socket;
  });
  call.start();
  assert.deepEqual(headers, { "X-Api-Key": "volc-key" });
  listeners.get("open")?.[0]?.({});
  assert.equal(JSON.parse(sent[0] ?? "{}").type, "session.create");
  listeners.get("message")?.[0]?.({ data: JSON.stringify({ type: "session.created", session: { id: "dlg_1" } }) });
  assert.deepEqual(phases, ["connecting", "live"]);
  listeners.get("message")?.[0]?.({
    data: JSON.stringify({
      type: "response.function_call_arguments.done",
      items: [{ type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" }],
    }),
  });
  const accepted = JSON.parse(sent.at(-1) ?? "{}") as { type: string; items?: Array<{ role?: string; content?: Array<{ text?: string }> }> };
  assert.equal(accepted.type, "conversation.item.create");
  assert.equal(accepted.items?.[0]?.role, "tool");
  assert.equal(accepted.items?.[0]?.content?.[0]?.text, TOOL_ACCEPTED);
  assert.equal(sent.some((item) => JSON.parse(item).type === "response.create"), false);
  listeners.get("message")?.[0]?.({ data: JSON.stringify({ type: "response.done" }) });
  finish("工作区是空的。");
  await Promise.resolve();
  const tail = sent.slice(-2).map((item) => JSON.parse(item) as { type: string; items?: Array<{ content?: Array<{ text?: string }> }> });
  assert.match(tail[0]?.items?.[0]?.content?.[0]?.text ?? "", /工作区是空的/);
  assert.equal(tail[1]?.type, "input_audio_buffer.commit");
  call.hangup();
});

test("a call accepts a tool immediately and speaks the result after the turn", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  let finish = (_output: string) => {};
  const phases: string[] = [];
  const call = new LiveCall("wss://example.test/realtime?model=qwen", "key", { type: "session.update" }, {
    onPhase(phase) {
      phases.push(phase);
    },
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    runTool() {
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  }, () => socket);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  assert.equal(JSON.parse(sent[0] ?? "{}").type, "session.update");
  message({ data: JSON.stringify({ type: "session.updated" }) });
  assert.deepEqual(phases, ["connecting", "live"]);
  message({ data: Buffer.from(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call_9", name: "list_files", arguments: "{}" })) });
  const accepted = sent.slice(1).map((item) => JSON.parse(item) as { type: string; item?: { output?: string } });
  assert.equal(accepted[0]?.item?.output, TOOL_ACCEPTED);
  assert.equal(accepted[1]?.type, "response.create");
  message({ data: JSON.stringify({ type: "response.done", response: { output: [] } }) });
  finish("工作区是空的。");
  await Promise.resolve();
  const spoken = JSON.parse(sent.at(-2) ?? "{}") as { item?: { content?: Array<{ text?: string }> } };
  assert.match(spoken.item?.content?.[0]?.text ?? "", /工作区是空的/);
  assert.equal(JSON.parse(sent.at(-1) ?? "{}").type, "response.create");
});

test("realtime settings resolve a service, model, and hardcoded voice", () => {
  const qwen = resolveRealtime({});
  assert.equal(qwen.service, "qwen");
  assert.equal(qwen.model, "qwen3.5-omni-plus-realtime");
  assert.equal(qwen.voice, "Tina");
  assert.equal(qwen.url, QWEN_REALTIME_URL);

  const flash = resolveRealtime({ service: "qwen", model: "qwen3.5-omni-flash-realtime", region: "singapore", voice: "Ethan" });
  assert.equal(flash.url, "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime");
  assert.equal(voicesFor("qwen", flash.model).some((voice) => voice.id === "Zane"), false);
  assert.equal(voicesFor("qwen", "qwen3.8-omni-flash-realtime").some((voice) => voice.id === "Ethan"), false);
  assert.equal(voicesFor("qwen", "qwen3.8-omni-flash-realtime").some((voice) => voice.id === "Liora Mira"), true);

  const workspace = resolveRealtime({ service: "qwen", model: "qwen3.8-omni-flash-realtime", workspace: "space-1" });
  assert.equal(workspace.url, "wss://space-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime");
  const full = resolveRealtime({ service: "qwen", model: "qwen3.8-omni-flash-realtime", workspace: "wss://custom.example/realtime" });
  assert.equal(full.url, "wss://custom.example/realtime");

  const openai = resolveRealtime({ service: "openai" });
  assert.equal(openai.model, "gpt-realtime-2.1");
  assert.equal(openai.voice, "marin");
  assert.equal(openai.url, "wss://api.openai.com/v1/realtime");

  const legacy = resolveRealtime({ url: "wss://space-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime" });
  assert.equal(legacy.service, "qwen");
  assert.equal(legacy.model, "qwen3.8-omni-flash-realtime");
  assert.equal(legacy.workspace, "wss://space-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime");

  const doubao = resolveRealtime({ url: DOUBAO_REALTIME_URL });
  assert.equal(doubao.service, "doubao");
  assert.equal(doubao.model, DOUBAO_REALTIME_MODEL);
  assert.equal(doubao.voice, DOUBAO_VOICE);
  assert.equal(keyForService("doubao", "", "deepseek-key", "https://api.deepseek.com/v1"), "");
  assert.equal(keyForService("qwen", "", "dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"), "dash-key");
  assert.equal(keyForService("openai", "own-key", "dash-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"), "own-key");
  assert.equal(realtimeKeyPage("qwen", "beijing"), "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key");
  assert.equal(realtimeKeyPage("qwen", "singapore"), "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key");
  assert.equal(realtimeKeyPage("openai", "beijing"), "https://platform.openai.com/api-keys");
  assert.equal(realtimeKeyPage("doubao", ""), "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default");
});

test("a voice preview asks for the sample line and hangs up when it finishes", () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const phases: string[] = [];
  const call = new LiveCall("wss://example.test/realtime", "key", { type: "session.update" }, {
    onPhase(phase) {
      phases.push(phase);
    },
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    async runTool() {
      return "";
    },
  }, () => socket, PREVIEW_LINE);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  message({ data: JSON.stringify({ type: "session.updated" }) });
  const cue = sent.slice(1).map((item) => JSON.parse(item) as { type: string; item?: { content?: Array<{ text?: string }> } });
  assert.equal(cue[0]?.item?.content?.[0]?.text, `请一字不差地说：${PREVIEW_LINE}`);
  assert.equal(cue[1]?.type, "response.create");
  message({ data: JSON.stringify({ type: "response.done", response: { output: [] } }) });
  assert.equal(phases.at(-1), "closed");
  assert.deepEqual(previewCue("doubao"), [{ type: "speech_text_buffer.commit", text: PREVIEW_LINE }]);
});

test("transcript snapshots replace the line instead of repeating it", () => {
  assert.equal(foldTranscript("以说", "以说这个东西"), "以说这个东西");
  assert.equal(foldTranscript("以说这个东西", "以说这个东西"), "以说这个东西");
  assert.equal(foldTranscript("你好", "世界"), "你好世界");
  assert.equal(
    mergeUtterance("嗯 ok 汇报一下刚刚这么一个工作OK，", "汇报一下刚刚这么一个工作。"),
    "汇报一下刚刚这么一个工作。",
  );
  assert.equal(mergeUtterance("你好", "世界"), "你好世界");
});

test("user speech cuts audio that is still in the speaker", () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  let interrupted = 0;
  const call = new LiveCall("wss://example.test/realtime", "key", { type: "session.update" }, {
    onPhase() {},
    onAudio() {},
    onInterrupt() {
      interrupted += 1;
    },
    onLine() {},
    onTranscript() {},
    async runTool() {
      return "";
    },
  }, () => socket);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  message({ data: JSON.stringify({ type: "session.updated" }) });
  message({ data: JSON.stringify({ type: "response.created" }) });
  message({ data: JSON.stringify({ type: "response.audio.delta", delta: Buffer.from([0, 1]).toString("base64") }) });
  message({ data: JSON.stringify({ type: "response.done", response: { output: [] } }) });
  const mark = sent.length;
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  assert.equal(interrupted, 1);
  assert.equal(sent.slice(mark).some((item) => JSON.parse(item).type === "response.cancel"), false);
  call.noteSpeakerIdle(1);
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) });
  message({ data: JSON.stringify({ type: "response.created" }) });
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  assert.equal(interrupted, 2);
  assert.equal(sent.some((item) => JSON.parse(item).type === "response.cancel"), true);
});

test("a user turn is kept when speech stops, before the final transcript", () => {
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send() {},
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const call = new LiveCall("wss://example.test/realtime", "key", { type: "session.update" }, {
    onPhase() {},
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    async runTool() {
      return "";
    },
  }, () => socket);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  message({ data: JSON.stringify({ type: "session.updated" }) });
  message({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "你好" }) });
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) });
  assert.deepEqual(call.transcript(), [{ who: "user", text: "你好" }]);
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  message({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "下一句" }) });
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) });
  assert.deepEqual(call.transcript(), [
    { who: "user", text: "你好" },
    { who: "user", text: "下一句" },
  ]);
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  message({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "嗯 ok 汇报一下刚刚这么一个工作OK，" }) });
  message({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "汇报一下刚刚这么一个工作。" }) });
  message({ data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }) });
  message({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "汇报一下刚刚这么一个工作。" }) });
  assert.deepEqual(call.transcript().at(-1), { who: "user", text: "汇报一下刚刚这么一个工作。" });
});

test("end_call waits until the goodbye finishes playing", () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const phases: string[] = [];
  const call = new LiveCall("wss://example.test/realtime", "key", { type: "session.update" }, {
    onPhase(phase) {
      phases.push(phase);
    },
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    async runTool() {
      return "不该执行";
    },
  }, () => socket);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  message({ data: JSON.stringify({ type: "session.updated" }) });
  message({ data: JSON.stringify({ type: "response.created" }) });
  message({ data: JSON.stringify({ type: "response.audio.delta", delta: Buffer.from([0, 1]).toString("base64") }) });
  const mark = sent.length;
  message({ data: JSON.stringify({ type: "response.function_call_arguments.done", call_id: "bye", name: "end_call", arguments: "{}" }) });
  const follow = sent.slice(mark).map((item) => JSON.parse(item) as { type: string });
  assert.equal(follow.some((item) => item.type === "response.create"), false);
  assert.equal(phases.includes("closed"), false);
  message({ data: JSON.stringify({ type: "response.done", response: { output: [] } }) });
  assert.equal(phases.includes("closed"), false);
  call.noteSpeakerIdle(1);
  assert.equal(phases.at(-1), "closed");
});

test("ask_text starts the written work without reading it aloud", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const socket = {
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  const call = new LiveCall("wss://example.test/realtime", "key", { type: "session.update" }, {
    onPhase() {},
    onAudio() {},
    onInterrupt() {},
    onLine() {},
    onTranscript() {},
    runTool(name) {
      assert.equal(name, "ask_text");
      return Promise.resolve(askTextResult("started"));
    },
  }, () => socket);
  call.start();
  const message = listeners.get("message")?.[0];
  assert.ok(message);
  message({ data: JSON.stringify({ type: "session.created" }) });
  message({ data: JSON.stringify({ type: "session.updated" }) });
  const mark = sent.length;
  message({ data: JSON.stringify({ type: "response.function_call_arguments.done", call_id: "page", name: "ask_text", arguments: "{\"task\":\"做一份幻灯片\"}" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const follow = sent.slice(mark).join("\n");
  assert.match(follow, /已经开始/);
  assert.doesNotMatch(follow, /结果好了/);
  assert.equal(askTextResult("busy", "en").includes("previous piece"), true);
});

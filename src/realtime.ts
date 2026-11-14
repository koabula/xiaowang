import type { ToolSchema } from "./types.ts";

export const QWEN_REALTIME_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const QWEN_REALTIME_MODEL = "qwen3.5-omni-plus-realtime";
export const DOUBAO_REALTIME_URL = "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue";
export const DOUBAO_REALTIME_MODEL = "1.2.6.1";
export const DOUBAO_VOICE = "zh_female_vv_uranus_bigtts";
export const PREVIEW_LINE = "你好，我是小王同学。";

export const TOOL_ACCEPTED = "已接过，正在做。先用一句口语接住用户，不要复述这句话，也不要说工具或后台。";

export type RealtimeFamily = "openai" | "doubao";

export interface RealtimeEndpoint {
  url: string;
  model: string;
  family: RealtimeFamily;
  inputRate: number;
  outputRate: number;
  audioFormat: string;
  transcriptionModel: string;
}

export type RealtimeNotice =
  | { kind: "session.created" }
  | { kind: "session.updated" }
  | { kind: "session.closed" }
  | { kind: "speech_started" }
  | { kind: "speech_stopped" }
  | { kind: "response_started" }
  | { kind: "response_done" }
  | { kind: "audio"; pcm: Buffer }
  | { kind: "user_transcript"; text: string; partial: boolean }
  | { kind: "assistant_transcript"; text: string; partial: boolean }
  | { kind: "function_call"; callId: string; name: string; arguments: string }
  | { kind: "error"; message: string };

export function realtimeEndpoint(input?: { url?: string; model?: string }): RealtimeEndpoint {
  const url = (input?.url?.trim() || QWEN_REALTIME_URL).replace(/\/$/, "");
  const family = realtimeFamily(url);
  const openai = /api\.openai\.com/i.test(url);
  if (family === "doubao") {
    return {
      url,
      model: DOUBAO_REALTIME_MODEL,
      family,
      inputRate: 16_000,
      outputRate: 24_000,
      audioFormat: "pcm_s16le",
      transcriptionModel: "",
    };
  }
  return {
    url,
    model: input?.model?.trim() || (openai ? "gpt-realtime" : QWEN_REALTIME_MODEL),
    family,
    inputRate: openai ? 24_000 : 16_000,
    outputRate: 24_000,
    audioFormat: openai ? "pcm16" : "pcm",
    transcriptionModel: openai ? "gpt-4o-mini-transcribe" : "gummy-realtime-v1",
  };
}

export function realtimeFamily(url: string): RealtimeFamily {
  return /\/api\/v3\/duplex\/realtime\/dialogue/i.test(url) ? "doubao" : "openai";
}

export function socketUrl(endpoint: RealtimeEndpoint): string {
  if (endpoint.family === "doubao") return endpoint.url;
  const url = new URL(endpoint.url);
  if (!url.searchParams.get("model")) url.searchParams.set("model", endpoint.model);
  return url.toString();
}

export const END_CALL_TOOL: ToolSchema = {
  name: "end_call",
  description: "结束这次通话。先用一句口语道别，说完再调用。不要在道别之前调用。",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

export function voiceTools(tools: ToolSchema[]): ToolSchema[] {
  if (tools.some((tool) => tool.name === "end_call")) return tools;
  return [...tools, END_CALL_TOOL];
}

export function realtimeInstructions(personName: string, brief: string): string {
  return [
    `你是「${personName}」。这是一次语音通话，用口语短句。`,
    "用户只听见你的声音。要查文献、读资料或写笔记时，先接一句再调用工具。不要念工具过程，也不要说自己把事情转交了。",
    "用户要结束通话时，先说一句简短的再见，然后调用 end_call。道别说完就会挂断。",
    "摘要和正文里没有的数字不要编。",
    "",
    brief,
  ].join("\n");
}

export function sessionUpdate(options: {
  instructions: string;
  tools: ToolSchema[];
  audioFormat: string;
  transcriptionModel: string;
  voice?: string;
}): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      input_audio_format: options.audioFormat,
      output_audio_format: options.audioFormat,
      instructions: options.instructions,
      turn_detection: { type: "server_vad" },
      input_audio_transcription: options.transcriptionModel ? { model: options.transcriptionModel } : undefined,
      ...(options.voice ? { voice: options.voice } : {}),
      tools: options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  };
}

export function doubaoSession(options: { instructions: string; tools: ToolSchema[]; voice?: string }): Record<string, unknown> {
  return {
    type: "session.create",
    session: {
      model: DOUBAO_REALTIME_MODEL,
      instructions: options.instructions,
      audio: {
        input: { format: { type: "pcm", rate: 16_000 } },
        output: { format: { type: "pcm_s16le", rate: 24_000 }, voice: options.voice || DOUBAO_VOICE },
      },
      tools: options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  };
}

export function foldTranscript(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  const limit = Math.min(current.length, incoming.length);
  for (let size = limit; size >= 2; size -= 1) {
    if (current.slice(-size) === incoming.slice(0, size)) return current + incoming.slice(size);
  }
  return current + incoming;
}

export function mergeUtterance(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return current;
  if (!current || next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  const shared = commonRun(current, next);
  if (shared >= 6 && shared >= Math.min(current.length, next.length) * 0.6) return next;
  return foldTranscript(current, next);
}

function commonRun(left: string, right: string): number {
  let best = 0;
  const row = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j] ?? 0;
      if (left[i - 1] === right[j - 1]) {
        const run = previous + 1;
        row[j] = run;
        if (run > best) best = run;
      } else {
        row[j] = 0;
      }
      previous = saved;
    }
  }
  return best;
}

export function previewCue(family: RealtimeFamily, line = PREVIEW_LINE): Record<string, unknown>[] {
  if (family === "doubao") return [{ type: "speech_text_buffer.commit", text: line }];
  return [
    {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `请一字不差地说：${line}` }],
      },
    },
    { type: "response.create" },
  ];
}

export function audioAppend(audio: string): Record<string, unknown> {
  return { type: "input_audio_buffer.append", audio };
}

export function responseCancel(): Record<string, unknown> {
  return { type: "response.cancel" };
}

export function responseCreate(): Record<string, unknown> {
  return { type: "response.create" };
}

export function functionOutput(callId: string, output: string, family: RealtimeFamily = "openai"): Record<string, unknown> {
  if (family === "doubao") {
    return {
      type: "conversation.item.create",
      items: [{ call_id: callId, role: "tool", content: [{ type: "input_text", text: output }] }],
    };
  }
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  };
}

export function spokenResult(text: string, family: RealtimeFamily = "openai"): Record<string, unknown> {
  const brief = text.replace(/\s+/g, " ").trim().slice(0, 1_500);
  const prompt = `结果好了。用一两句口语告诉用户，不要说这是系统消息。\n${brief}`;
  if (family === "doubao") {
    return {
      type: "conversation.item.create",
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    };
  }
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  };
}

export function parseRealtimeEvent(raw: string): RealtimeNotice[] {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    message = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "session.created") return [{ kind: "session.created" }];
  if (type === "session.updated") return [{ kind: "session.updated" }];
  if (type === "session.closed") return [{ kind: "session.closed" }];
  if (type === "input_audio_buffer.speech_started" || type === "conversation.item.input_audio_transcription.started") {
    return [{ kind: "speech_started" }];
  }
  if (type === "input_audio_buffer.speech_stopped" || type === "conversation.item.input_audio_transcription.completed") {
    const text = stringField(message, "transcript");
    const notes: RealtimeNotice[] = [{ kind: "speech_stopped" }];
    if (text) notes.push({ kind: "user_transcript", text, partial: false });
    return notes;
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = stringField(message, "delta");
    return text ? [{ kind: "user_transcript", text, partial: true }] : [];
  }
  if (type === "response.created" || type === "response.output_audio.started") return [{ kind: "response_started" }];
  if (type === "response.output_audio.done" || type === "response.canceled") return [{ kind: "response_done" }];
  if (type === "response.output_text.delta") {
    const text = stringField(message, "delta");
    return text ? [{ kind: "assistant_transcript", text, partial: true }] : [];
  }
  if (type === "response.output_text.done") {
    const text = stringField(message, "text") || stringField(message, "transcript");
    return text ? [{ kind: "assistant_transcript", text, partial: false }] : [];
  }
  if (type === "response.audio.delta" || type === "response.output_audio.delta") {
    const delta = stringField(message, "delta");
    if (!delta) return [];
    return [{ kind: "audio", pcm: Buffer.from(delta, "base64") }];
  }
  if (type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta") {
    const text = stringField(message, "delta") || stringField(message, "transcript");
    return text ? [{ kind: "assistant_transcript", text, partial: true }] : [];
  }
  if (type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") {
    const text = stringField(message, "transcript");
    return text ? [{ kind: "assistant_transcript", text, partial: false }] : [];
  }
  if (type === "response.function_call_arguments.done") {
    const nested = functionCalls(message);
    if (nested.length > 0) return nested;
    const call = functionCall(message);
    return call ? [call] : [];
  }
  if (type === "error") {
    const nested = recordField(message, "error");
    const text = (nested && stringField(nested, "message")) || stringField(message, "message") || "实时连接出错了。";
    return [{ kind: "error", message: text }];
  }
  if (type === "response.done") {
    const notes: RealtimeNotice[] = [{ kind: "response_done" }];
    const response = recordField(message, "response");
    const output = response?.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const call = functionCall(item as Record<string, unknown>);
        if (call) notes.push(call);
      }
    }
    return notes;
  }
  return [];
}

export function pcm16FromFloat(input: Float32Array, fromRate: number, toRate: number): Uint8Array {
  const ratio = fromRate / toRate;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const out = new Uint8Array(length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return out;
}

function functionCalls(message: Record<string, unknown>): RealtimeNotice[] {
  const items = message.items;
  if (!Array.isArray(items)) return [];
  const notes: RealtimeNotice[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const call = functionCall(item as Record<string, unknown>);
    if (call) notes.push(call);
  }
  return notes;
}

function functionCall(message: Record<string, unknown>): RealtimeNotice | null {
  const kind = stringField(message, "type");
  if (kind && kind !== "function_call" && kind !== "response.function_call_arguments.done") return null;
  const name = stringField(message, "name");
  const callId = stringField(message, "call_id") || stringField(message, "callId");
  const args = argumentField(message);
  if (!name || !callId) return null;
  return { kind: "function_call", callId, name, arguments: args };
}

function argumentField(record: Record<string, unknown>): string {
  const value = record.arguments;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

import type { Locale } from "./locale.ts";
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

export function askTextTool(locale: Locale = "zh"): ToolSchema {
  if (locale === "en") {
    return {
      name: "ask_text",
      description: "Use this when the user wants a new or edited page or note: make a canvas/ppt/slides, write a report, or save a note. Say one short line first, then call it. Put their words in task. If the deck already exists and the user asks you to present or walk through it, present it yourself page by page with read_file and show_stage instead of calling ask_text.",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "What to make, in the user's words." } },
        required: ["task"],
        additionalProperties: false,
      },
    };
  }
  return {
    name: "ask_text",
    description: "用户要新做或修改一份页面、汇报或笔记时调用（新建/改写 canvas、ppt、slides、幻灯片、报告、笔记）。先用一句口语接住，再调用，task 用用户的原话。如果工作区已有现成 HTML 页面而用户让你讲一遍，直接用 read_file 和 show_stage 按页翻页讲解，不要调用 ask_text。",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "要做的事，用用户的原话。" } },
      required: ["task"],
      additionalProperties: false,
    },
  };
}

export function askTextResult(kind: "started" | "busy" | "missing", locale: Locale = "zh"): string {
  if (locale === "en") {
    if (kind === "busy") return "The previous piece is still going. Tell the user in one short sentence that this one starts when it finishes.";
    if (kind === "missing") return "You did not catch what to make. Ask in one short sentence.";
    return "Started. Keep the conversation going. Do not repeat the task and do not read a long answer.";
  }
  if (kind === "busy") return "上一件还没做完。用一句口语告诉用户，做完再开始这一件。";
  if (kind === "missing") return "没有听清要做的事。用一句口语问用户要哪一份。";
  return "已经开始。继续用口语接住，不要复述任务，也不要念长文。";
}

export function voiceTools(tools: ToolSchema[], locale: Locale = "zh"): ToolSchema[] {
  const names = new Set(tools.map((tool) => tool.name));
  const endCall = locale === "en"
    ? { ...END_CALL_TOOL, description: "End this call. Say a short goodbye first, then call this. Do not call it before the goodbye." }
    : END_CALL_TOOL;
  return [...tools, ...[askTextTool(locale), endCall].filter((tool) => !names.has(tool.name))];
}

export function realtimeInstructions(personName: string, brief: string, locale: Locale = "zh"): string {
  if (locale === "en") {
    return [
      `You are "${personName}". This is a voice call. Speak in short sentences.`,
      "The user only hears your voice. When you look something up or read, say one short line first, then use the tool. Do not narrate the tool, and do not say you handed the work off.",
      "When the user wants a new or edited canvas, ppt, slides, report, or written note, say one short line, then call ask_text and put their words in task. Do not write the long piece yourself.",
      "When the user asks you to present or walk through an existing canvas/ppt/slides HTML file, read it with read_file if needed, then present one slide at a time: call show_stage(mode='canvas', path=..., page=N) as you move to each slide, speak 2-3 sentences for that slide, and flip to page N+1 before talking about the next one. Do not recite the whole deck on page 1.",
      "When the user wants to end the call, say a short goodbye, then call end_call. The call hangs up after the goodbye.",
      "Do not invent numbers that are not in the abstract or the text.",
      "",
      brief,
    ].join("\n");
  }
  return [
    `你是「${personName}」。这是一次语音通话，用口语短句。`,
    "用户只听见你的声音。要查文献或读资料时，先接一句再调用工具。不要念工具过程，也不要说自己把事情转交了。",
    "用户要新做或修改一份 canvas、ppt、slides、幻灯片、演示、汇报或写下来的笔记时，先接一句，再调用 ask_text，把原话放进 task。不要自己写长文。",
    "用户让你讲一遍已有的 canvas/ppt/幻灯片时，先看已有文件（必要时 read_file），再一页一页边翻边讲：讲第 N 页前调用 show_stage(mode='canvas', path=..., page=N) 把右栏翻过去，每页只讲两三句核心结论，讲下一页时再调 page=N+1 翻页，不要停在第一页一口气背完。",
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
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 240, silence_duration_ms: 320 },
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
    if (current.slice(-size).toLowerCase() === incoming.slice(0, size).toLowerCase()) {
      return current.slice(0, current.length - size) + incoming;
    }
  }
  return current + incoming;
}

export function mergeUtterance(current: string, incoming: string): string {
  const next = collapseRepeat(incoming.trim());
  if (!next) return current;
  const prev = collapseRepeat(current.trim());
  if (!prev) return next;
  const left = spokenKey(prev);
  const right = spokenKey(next);
  if (!left || right.startsWith(left)) return next;
  if (left.startsWith(right)) return prev;
  const shared = commonRun(left, right);
  if (shared >= 5 && shared >= Math.min(left.length, right.length) * 0.55) return next;
  return collapseRepeat(foldTranscript(prev, next));
}

function spokenKey(value: string): string {
  return value.toLowerCase().replace(/[\s,.!?;:'"()[\]{}，。！？；：、“”‘’（）【】·…—\-]/g, "");
}

function collapseRepeat(value: string): string {
  const text = value.trim();
  if (text.length < 10) return text;
  const chars = Array.from(text);
  const items = chars.map((char) => ({ char, key: spokenKey(char) }));
  const total = items.map((item) => item.key).join("");
  if (total.length < 8) return text;
  const minHalf = Math.max(4, Math.floor(total.length * 0.4));
  let bestScore = -1;
  let bestText = "";
  for (let cut = Math.floor(items.length * 0.35); cut <= Math.ceil(items.length * 0.65); cut += 1) {
    const first = items.slice(0, cut).map((item) => item.key).join("");
    const second = items.slice(cut).map((item) => item.key).join("");
    if (first.length < minHalf || second.length < minHalf) continue;
    const shorter = Math.min(first.length, second.length);
    const shared = commonRun(first, second);
    const matches = first === second || second.includes(first) || first.includes(second) || shared >= Math.ceil(shorter * 0.8);
    if (!matches) continue;
    const score = shared * 100 - Math.abs(first.length - second.length);
    if (score > bestScore) {
      bestScore = score;
      bestText = chars.slice(cut).join("").trim();
    }
  }
  return bestText || text;
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

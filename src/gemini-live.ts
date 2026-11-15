import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AudioIdentity, PlaybackInterruption } from "../desktop/main/call.ts";

type Data = Record<string, unknown>;
const data = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
export type GeminiScheduling = "SILENT" | "WHEN_IDLE" | "INTERRUPT";
export interface GeminiTool { name: string; description: string; parameters?: Data; behavior?: "NON_BLOCKING" }
export interface GeminiToolCall { id: string; name: string; args: Data }
export interface GeminiToolResult { result: unknown; scheduling?: GeminiScheduling }
export interface GeminiSocket {
  send(value: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { type?: string; data?: unknown; code?: number; reason?: string; message?: string }) => void): void;
}
export interface GeminiHandlers {
  onReady(resumed: boolean): void;
  onReconnecting?(): void;
  onGenerationComplete?(): void;
  onActivity?(active: boolean): void;
  onAudio(pcm: Buffer, serial: number, identity: AudioIdentity): void;
  onInterrupt(value: PlaybackInterruption, internal?: boolean): void;
  onText(who: "user" | "assistant", fragment: string): void;
  onTurnComplete(interrupted?: boolean): void;
  onClosed(reason: string): void;
  onToolCancelled?(id: string): void;
  onGoAway?(): void;
  runTool(call: GeminiToolCall): Promise<GeminiToolResult>;
}

/** Native Gemini transport; never route it through the OpenAI response scheduler. */
export class GeminiLive {
  readonly id = randomUUID();
  private socket: GeminiSocket | null = null;
  private ready = false;
  private closed = false;
  private started = false;
  private everReady = false;
  private connection = 0;
  private reconnects = 0;
  private handle = "";
  private retry: ReturnType<typeof setTimeout> | undefined;
  private serial = 0;
  private epoch = 0;
  private turn = 0;
  private turnOpen = false;
  private outputHeld = false;
  private internalInterruption = false;
  private interruptedTurn = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly replies = new Map<string, { name: string; result: GeminiToolResult }>();
  private readonly unsent = new Set<string>();
  private readonly sentConnection = new Map<string, number>();
  private readonly key: string;
  private readonly config: { model?: string; voice?: string; url?: string; instructions: string; tools?: GeminiTool[] };
  private readonly handlers: GeminiHandlers;
  private readonly connect: (headers: Record<string, string>) => GeminiSocket;

  constructor(key: string, config: GeminiLive["config"], handlers: GeminiHandlers,
    connect?: GeminiLive["connect"]) {
    this.key = key; this.config = config; this.handlers = handlers;
    this.connect = connect ?? (headers => new WebSocket(config.url || "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", { headers, handshakeTimeout: 15000 }));
  }
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.open();
  }
  isReady(): boolean { return this.ready && !this.closed; }
  canResume(): boolean { return Boolean(this.handle); }
  holdOutput(notify = true): void {
    this.outputHeld = true; this.interrupt(true);
    if (notify && this.isReady()) this.sendText("用户点击暂停讲解。立即停止讲解，保持静默等待用户的新问题或恢复指令，不要回复本控制消息。");
  }
  allowOutput(): void { this.outputHeld = false; }
  private open(): void {
    const connection = ++this.connection;
    this.interruptedTurn = this.internalInterruption = false;
    try {
      const socket = this.connect({ "x-goog-api-key": this.key }); this.socket = socket;
      this.timer = setTimeout(() => { if (connection === this.connection) this.lost("Gemini Live 连接或配置超时。"); }, 15000);
      socket.addEventListener("open", () => {
        if (this.closed || connection !== this.connection) return;
        this.send({ setup: {
          model: `models/${this.config.model || "gemini-3.8-live"}`,
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voice || "Kore" } } } },
          systemInstruction: { parts: [{ text: this.config.instructions }] },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          sessionResumption: this.handle ? { handle: this.handle } : {},
          contextWindowCompression: { slidingWindow: {} },
          realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 450 }, activityHandling: "START_OF_ACTIVITY_INTERRUPTS" },
          ...(this.config.tools?.length ? { tools: [{ functionDeclarations: this.config.tools }] } : {}),
        } });
      });
      socket.addEventListener("message", event => {
        if (this.closed || connection !== this.connection) return;
        try { this.receive(JSON.parse(String(event.data))); }
        catch { this.close("Gemini Live 返回了无法解析的消息。"); }
      });
      socket.addEventListener("error", () => { if (connection === this.connection) this.lost("Gemini Live 网络连接失败。"); });
      socket.addEventListener("close", event => {
        if (connection !== this.connection || this.closed) return;
        const reason = `Gemini Live 连接关闭（${event.code ?? 0}）${this.redact(event.reason || "")}`;
        if ([1007, 1008].includes(event.code ?? 0)) this.close(reason); else this.lost(reason);
      });
    } catch { this.lost("Gemini Live 连接失败。"); }
  }
  sendText(value: string): void {
    this.requireReady();
    this.internalInterruption = true;
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: value }] }], turnComplete: true } });
  }
  sendAudio(pcm: Buffer): void {
    this.requireReady();
    if (pcm.length % 2) throw new Error("Gemini 输入需要 16 kHz 单声道 PCM16 音频。");
    this.send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm.toString("base64") } } });
  }
  endAudio(): void { this.requireReady(); this.send({ realtimeInput: { audioStreamEnd: true } }); }
  close(reason = ""): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; clearTimeout(this.timer); clearTimeout(this.retry); this.connection++;
    this.pending.clear(); this.interrupt(); this.socket?.close();
    this.handlers.onClosed(this.redact(reason));
  }
  private redact(value: string): string { return this.key ? value.replaceAll(this.key, "[redacted]") : value; }
  private lost(reason: string): void {
    if (this.closed) return;
    this.ready = false; clearTimeout(this.timer); this.connection++;
    this.interrupt(); this.socket?.close(); this.socket = null;
    if ((this.everReady && !this.handle) || this.reconnects++ >= 3) { this.close(`${reason} 无法恢复原会话，请重新通话。后台任务和已有记录已保留。`); return; }
    this.handlers.onReconnecting?.();
    if (this.closed) return;
    this.retry = setTimeout(() => this.open(), Math.min(2000, this.reconnects * 300));
  }
  private requireReady(): void { if (!this.ready || this.closed) throw new Error("Gemini Live 尚未就绪。"); }
  private send(value: Data): void { if (!this.closed) this.socket?.send(JSON.stringify(value)); }
  private interrupt(internal = false): void {
    this.handlers.onInterrupt({ callId: this.id, playbackEpoch: ++this.epoch, throughSerial: this.serial }, internal);
    this.turnOpen = false;
  }
  private receive(message: Data): void {
    if (message.error) { this.close(`Gemini Live：${this.redact(text(data(message.error).message))}`); return; }
    const resume = data(message.sessionResumptionUpdate);
    if (resume.resumable === true && text(resume.newHandle)) this.handle = text(resume.newHandle);
    if (message.setupComplete && !this.ready) {
      clearTimeout(this.timer); this.ready = true; this.reconnects = 0;
      const resumed = this.everReady; this.everReady = true; this.handlers.onReady(resumed);
      for (const id of this.unsent) this.flushResponse(id);
    }
    if (message.goAway) { this.handlers.onGoAway?.(); this.lost("Gemini 服务正在切换连接。"); return; }
    const activity = text(data(message.voiceActivity).type);
    if (activity === "ACTIVITY_START") { this.internalInterruption = false; this.outputHeld = false; this.interrupt(); this.handlers.onActivity?.(true); }
    else if (activity === "ACTIVITY_END") this.handlers.onActivity?.(false);
    const cancelled = data(message.toolCallCancellation).ids;
    if (Array.isArray(cancelled)) for (const id of cancelled) if (typeof id === "string" && this.seen.has(id)) {
      this.pending.delete(id);
      this.cancelled.add(id); this.unsent.delete(id);
      // A provider call cancellation revokes its response channel. It does not
      // cancel an already accepted durable job or undo local side effects.
      this.handlers.onToolCancelled?.(id);
    }
    const content = data(message.serverContent);
    if (content.interrupted === true) { this.interruptedTurn = true; this.interrupt(this.internalInterruption && !text(data(content.inputTranscription).text)); this.internalInterruption = false; }
    const input = text(data(content.inputTranscription).text);
    const output = text(data(content.outputTranscription).text);
    if (input) { this.internalInterruption = false; this.outputHeld = false; this.handlers.onText("user", input); }
    if (output && !this.outputHeld) { this.internalInterruption = false; this.handlers.onText("assistant", output); }
    const parts = data(content.modelTurn).parts;
    if (Array.isArray(parts)) for (const part of parts) {
      const item = data(part); const audio = data(item.inlineData);
      if (text(item.text) && item.thought !== true && !output && !this.outputHeld) this.handlers.onText("assistant", text(item.text));
      if (text(audio.data) && /^audio\/pcm(?:;|$)/.test(text(audio.mimeType)) && !this.outputHeld) {
        if (!this.turnOpen) { this.turn++; this.turnOpen = true; }
        const serial = ++this.serial;
        this.handlers.onAudio(Buffer.from(text(audio.data), "base64"), serial, { callId: this.id, responseId: `${this.id}:${this.turn}`, itemId: `${this.id}:${this.turn}`, chunkId: String(serial), playbackEpoch: this.epoch });
      }
    }
    if (content.turnComplete === true) { this.turnOpen = false; this.handlers.onTurnComplete(this.interruptedTurn); this.interruptedTurn = false; }
    if (content.generationComplete === true) this.handlers.onGenerationComplete?.();
    const calls = data(message.toolCall).functionCalls;
    if (Array.isArray(calls)) for (const raw of calls) {
      const call = data(raw); const id = text(call.id), name = text(call.name);
      if (!id || !name || this.cancelled.has(id)) continue;
      if (this.seen.has(id)) { if (this.replies.has(id) && this.sentConnection.get(id) !== this.connection) { this.unsent.add(id); this.flushResponse(id); } continue; }
      this.seen.add(id); this.pending.set(id, name);
      // Do not await here: audio, new user turns and other calls remain live.
      void Promise.resolve().then(() => this.handlers.runTool({ id, name, args: data(call.args) }))
        .then(result => this.respond(id, name, result))
        .catch(() => this.respond(id, name, { result: { error: "工具执行失败，请查看后台任务记录。" }, scheduling: "WHEN_IDLE" }));
    }
  }
  private respond(id: string, name: string, result: GeminiToolResult): void {
    if (this.closed || !this.pending.has(id)) return;
    this.replies.set(id, { name, result }); this.unsent.add(id); this.flushResponse(id);
  }
  private flushResponse(id: string): void {
    const reply = this.replies.get(id);
    if (!this.ready || !reply || this.closed || this.cancelled.has(id)) return;
    this.send({ toolResponse: { functionResponses: [{ id, name: reply.name, response: { result: reply.result.result, scheduling: reply.result.scheduling || "WHEN_IDLE" } }] } });
    this.unsent.delete(id); this.pending.delete(id);
    this.sentConnection.set(id, this.connection);
  }
}

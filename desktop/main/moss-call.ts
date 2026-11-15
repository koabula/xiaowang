import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Presentation, type PresentationState } from "../../src/presentation.ts";
import type { TaskJob } from "../../src/types.ts";
import type { AudioIdentity, CallHandlers, InterruptionReceipt, PlaybackPosition, VoiceState } from "./call.ts";

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === "object" ? value as Data : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const short = (value: string): string => Array.from(value).slice(0, 2000).join("");
export interface MossDelegation { sessionId: string; id: string; objective: string; context: unknown; purpose: string }
export interface MossHandlers extends CallHandlers {
  delegate?: (task: MossDelegation) => TaskJob;
  cancelDelegation?: (jobId: string) => void;
}
export interface MossSocket {
  send(data: string | Buffer): void;
  close(): void;
  addEventListener(type: string, listener: (event: { type?: string; data?: unknown }) => void): void;
}
interface Chunk { serial: number; identity: AudioIdentity; wireId: string; completed: boolean; duration: number }
interface Reply { run: string; turn: string; chunks: Chunk[]; done: boolean; stopped: boolean; completed: boolean }
interface Append { action: string; content: string; delegation_id?: string; event_id: string; status?: string }

/** MOSS has its own audio receipts and delegation lifecycle; never use the legacy response scheduler. */
export class MossCall {
  readonly id = randomUUID();
  readonly presentation: Presentation;
  private socket: MossSocket | null = null;
  private closed = false;
  private ready = false;
  private attached = false;
  private configured = false;
  private media = false;
  private voice = false;
  private muted = false;
  private everLive = false;
  private sessionId = "";
  private begunAt = "";
  private connection = 0;
  private reconnects = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private serial = 0;
  private epoch = 0;
  private context: { reply: Reply; chunk: string } | null = null;
  private readonly replies = new Map<string, Reply>();
  private readonly interruptions = new Map<number, Reply>();
  private pendingStopped: Reply[] = [];
  private readonly delegates = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private readonly terminalAttempts = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly appends = new Map<string, Append>();
  private readonly accepted = new Set<string>();
  private readonly tools = new Map<string, { controller: AbortController; output?: string; confirmed: boolean; resumed: boolean; waiting: boolean; owner?: Reply }>();
  private readonly lines = new Map<string, { who: "user" | "assistant"; text: string }>();
  private readonly inputIds = new Map<string, string>();
  private readonly outputIds = new Map<string, string>();
  private pendingOutput: { id: string; key?: string } | null = null;
  private outputTurn = 0;
  private readonly playbackReceipts = new Map<string, Data>();
  private readonly final = new Set<string>();
  private inputTurn = 0;
  private ending = false;
  private statePhase: VoiceState["phase"] = "connecting";
  private readonly url: string;
  private readonly key: string;
  private readonly session: Data;
  private readonly handlers: MossHandlers;
  private readonly connect: (url: string, headers: Record<string, string>) => MossSocket;
  private readonly preview: string;

  constructor(url: string, key: string, session: Data, handlers: MossHandlers,
    connect: (url: string, headers: Record<string, string>) => MossSocket = (url, headers) => new WebSocket(url, { headers }),
    preview = "", presentation?: PresentationState) {
    this.url = url; this.key = key; this.session = session; this.handlers = handlers; this.connect = connect; this.preview = preview;
    this.presentation = new Presentation(presentation);
  }
  start(): void { this.begunAt = new Date().toISOString(); this.handlers.onPhase("connecting"); this.open(); }
  startedAt(): string { return this.begunAt; }
  isClosed(): boolean { return this.closed; }
  transcript(): Array<{ who: "user" | "assistant"; text: string }> { return [...this.lines.values()].filter(line => line.text.trim()).map(line => ({ ...line })); }
  private state(phase: VoiceState["phase"], detail = ""): void {
    this.statePhase = phase;
    this.handlers.onState?.({ phase, detail, presentation: this.presentation.snapshot() });
  }
  private send(value: Data | Append): void { if (!this.closed && this.attached) this.socket?.send(JSON.stringify(value)); }
  private open(): void {
    const epoch = ++this.connection;
    this.attached = this.ready = this.configured = this.media = this.voice = false;
    this.context = null;
    this.pendingStopped = [];
    const socket = this.connect(this.url, { Authorization: `Bearer ${this.key}` }); this.socket = socket;
    this.timer = setTimeout(() => this.hangup("MOSS 连接或配置超时。"), 15000);
    socket.addEventListener("open", () => {
      if (epoch !== this.connection || this.closed) return;
      socket.send(JSON.stringify({ action: "attach_session", session_id: this.sessionId || null, memory_scope: "session", delegation: { type: "client" } }));
    });
    socket.addEventListener("message", event => {
      if (epoch !== this.connection || this.closed) return;
      try {
        if (typeof event.data === "string") this.event(object(JSON.parse(event.data)));
        else if (Buffer.isBuffer(event.data)) this.audio(event.data);
        else if (event.data instanceof ArrayBuffer) this.audio(Buffer.from(event.data));
      } catch (error) {
        const packet = typeof event.data === "string" ? this.packet(event.data) : {};
        const action = text(packet.action);
        console.warn("MOSS protocol event rejected", { action, fields: Object.keys(object(packet.data)), reason: error instanceof Error ? error.message : "invalid event" });
        if (/^response\.(audio\.|ended$|interrupted$)/.test(action) || typeof event.data !== "string") {
          if (this.preview) { this.hangup("MOSS 试听音频格式异常，请稍后重试。"); return; }
          // An unusable reply must not destroy an otherwise healthy conversation.
          this.context = null;
          const run = text(object(packet.data).run_id);
          for (const reply of this.replies.values()) if (run && reply.run === run) this.stop(reply);
          this.state("listening", "本次语音回复格式异常，已跳过，可以继续提问。");
        } else this.hangup(`MOSS 协议错误：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    socket.addEventListener("error", () => { if (epoch === this.connection && !this.closed) this.state("reconnecting", "MOSS 连接异常，正在尝试恢复。"); });
    socket.addEventListener("close", () => {
      if (epoch !== this.connection || this.closed) return;
      clearTimeout(this.timer); this.ready = false;
      for (const reply of this.replies.values()) if (!reply.completed && !reply.stopped) this.stop(reply);
      this.attached = false;
      if (++this.reconnects > 2) { this.hangup("MOSS 连接已断开。后台任务及结果仍保存在通话中。"); return; }
      this.state("reconnecting"); this.retry = setTimeout(() => this.open(), this.reconnects * 500);
    });
  }
  private maybeReady(): void {
    if (this.ready || !this.configured || !this.media || !this.voice) return;
    clearTimeout(this.timer); this.ready = true;
    this.reconnects = 0;
    this.send({ action: "mic_state", enabled: !this.muted });
    if (!this.everLive) { this.everLive = true; this.handlers.onPhase("live"); }
    this.state("listening");
    for (const receipt of this.playbackReceipts.values()) this.send(receipt);
    this.playbackReceipts.clear();
    for (const append of this.appends.values()) this.send(append);
    for (const [id, tool] of this.tools) if (tool.output !== undefined && !tool.resumed) this.output(id, tool.output);
    if (this.preview && !this.previewTimer) this.previewTimer = setTimeout(() => this.hangup("MOSS 音色试听超时，请稍后重试。"), 45000);
    if (this.preview && !this.accepted.has("preview")) this.append({ action: "session.commentary.append", content: this.preview, event_id: "preview", status: "completed" });
  }
  private event(event: Data): void {
    const action = text(event.action), data = object(event.data);
    if (action === "session_attached") {
      const id = text(data.session_id);
      if (!id || data.delegation !== "client" || data.memory_scope !== "session") throw new Error("服务未启用独立会话与客户端委派。");
      if (this.sessionId && id !== this.sessionId) throw new Error("服务未恢复原会话，请重新通话；后台任务仍保留。");
      this.sessionId = id; this.attached = true;
      this.send({ action: "session.update", session: this.session.session });
      this.send({ action: "change_voice", voice_name: this.session.voice });
      this.send({ action: "media.configure", input_audio: { format: "pcm16" }, output_audio: { format: "pcm16", sample_rate: 24000 }, playback: "client" });
      this.send({ action: "client_context.update", context: { time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    } else if (action === "session.updated") {
      if (data.error !== "") throw new Error(text(data.error) || "会话配置失败");
      this.configured = true; this.maybeReady();
    } else if (action === "voice_changed") {
      if (data.name !== this.session.voice) throw new Error("服务未接受所选音色。");
      this.voice = true; this.maybeReady();
    } else if (action === "media.configured") {
      const output = object(data.output_audio), input = object(data.input_audio);
      if (data.error !== "" || output.format !== "pcm16" || output.sample_rate !== 24000 || input.format !== "pcm16" || (input.sample_rate !== undefined && input.sample_rate !== 16000) || (input.channels !== undefined && input.channels !== 1) || (output.channels !== undefined && output.channels !== 1) || data.playback !== "client") throw new Error("服务未接受 PCM 音频与客户端播放回执配置。");
      this.media = true; this.maybeReady();
    } else if (/^input\.transcript\.(updated|done|revised)$/.test(action)) {
      const turn = text(data.turn);
      if (action.endsWith("revised") && !this.inputIds.has(turn)) return;
      const id = this.inputIds.get(turn) ?? `user:${this.inputTurn}`;
      this.line(id, "user", text(data.text), action.endsWith("updated"));
      if (action.endsWith("done") && (!turn || !this.inputIds.has(turn))) { if (turn) this.inputIds.set(turn, id); this.inputTurn++; }
    } else if (/^output\.transcript\.(updated|done)$/.test(action)) {
      this.line(this.outputId(data), "assistant", text(data.text), action.endsWith("updated"));
      if (action.endsWith("done")) this.pendingOutput = null;
    } else if (action === "input.speech.started") {
      // Session commentary has no usable remote playback receipts. Stop its local
      // queue on speech onset; ordinary replies still use MOSS's audio.stop event.
      for (const reply of this.replies.values()) if (!reply.turn) this.stop(reply);
      this.state("listening");
    } else if (action === "input.speech.stopped") { this.state("thinking");
    } else if (action === "response.audio.started") { this.reply(data); this.outputId(data); this.state("speaking");
    } else if (action === "response.audio.context") {
      this.context = { reply: this.reply(data), chunk: text(data.chunk_id) };
      if (!this.context.chunk && this.context.reply.turn) throw new Error("音频缺少 chunk_id");
    } else if (action === "response.audio.done") { const reply = this.reply(data); reply.done = true; this.drain(reply);
    } else if (action === "response.audio.stop") {
      const reply = this.reply(data);
      if (!reply.stopped && !reply.completed) this.pendingStopped = [...this.pendingStopped, reply].slice(-16);
      this.stop(reply); this.replyStopped(reply, text(data.reason));
    } else if (action === "response.interrupted") {
      const run = text(data.run_id), turn = text(data.turn_id);
      const matches = (reply: Reply) => (!run || reply.run === run) && (!turn || reply.turn === turn);
      const stopped = this.pendingStopped.find(matches);
      const candidates = [...this.replies.values()].filter(reply => !reply.completed && !reply.stopped && matches(reply));
      const known = run ? [...this.replies.values()].find(item => matches(item)) : undefined;
      const reply = run && turn ? this.reply(data) : stopped ?? known ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (reply) {
        this.pendingStopped = this.pendingStopped.filter(item => item !== reply);
        if (text(data.text)) this.line(this.outputId({ run_id: reply.run, turn_id: reply.turn }), "assistant", text(data.text), false);
        this.stop(reply);
        this.replyStopped(reply, text(data.reason));
      } else console.warn("MOSS: unassociated interruption", { action, fields: Object.keys(data) });
      if (!reply && this.ready && ![...this.replies.values()].some(item => !item.completed && !item.stopped)) this.state("listening");
    } else if (action === "response.ended") {
      const reply = this.reply(data);
      this.pendingStopped = this.pendingStopped.filter(item => item !== reply);
      if (data.status !== "completed") this.stop(reply);
      else if (!reply.chunks.length) reply.completed = true;
      if (reply.completed || reply.stopped || !reply.chunks.length) this.state("listening");
    } else if (action === "response.function_call_arguments.done") { void this.functionCall(data);
    } else if (action === "conversation.item.created") {
      const id = text(object(data.item).call_id), tool = this.tools.get(id);
      if (tool && !tool.resumed) { tool.confirmed = true; this.resumeTool(id); }
    } else if (action === "session.delegation.created") {
      const delegation = object(data.delegation), id = text(delegation.id);
      if (!id || this.delegates.has(id) || this.cancelled.has(id)) return;
      if (!this.handlers.delegate) throw new Error("未配置后台执行器");
      const job = this.handlers.delegate({ sessionId: this.sessionId, id, objective: text(data.objective), context: data.context, purpose: text(data.purpose) });
      this.delegates.set(id, job.id); this.jobChanged(job);
    } else if (action === "session.delegation.cancelled") {
      const id = text(data.delegation_id); this.cancelled.add(id);
      this.terminalAttempts.set(id, this.attempts.get(id) ?? 0);
      for (const [key, append] of this.appends) if (append.delegation_id === id) this.appends.delete(key);
      const job = this.delegates.get(id); if (job) this.handlers.cancelDelegation?.(job);
    } else if (/^session\.(thinking|commentary|instructions)\.appended$/.test(action)) {
      const id = text(data.client_event_id); this.appends.delete(id); this.accepted.add(id);
    } else if (action === "session.closing") {
      if (data.reconnect === false) this.hangup(text(data.reason));
    } else if (action === "error") {
      const error = object(data.error);
      const id = text(error.client_event_id) || text(data.client_event_id);
      if (id) this.appends.delete(id);
      // Errors must be visible instead of leaving the UI in an indefinite thinking state.
      this.hangup(`MOSS：${text(error.message) || text(error.code) || text(data.error) || "服务返回错误"}`);
    }
  }
  private packet(value: string): Data {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  private replyStopped(reply: Reply, reason: string): void {
    if (!reply.completed && /playback_(timeout|failed)/.test(reason)) {
      const detail = "MOSS 未完整发送本次播报，可以重试或继续提问。";
      if (this.preview) this.hangup(detail); else this.state("listening", detail);
    } else if (![...this.replies.values()].some(item => !item.completed && !item.stopped)) this.state("listening");
  }
  private line(id: string, who: "user" | "assistant", value: string, partial: boolean): void {
    if (!value) return;
    let line = this.lines.get(id);
    const changed = line?.text !== value;
    if (!line) { line = { who, text: value }; this.lines.set(id, line); } else line.text = value;
    this.handlers.onLine(who, value, partial, id, [...this.lines.keys()].indexOf(id));
    if (!partial && (!this.final.has(id) || changed)) {
      const first = !this.final.has(id); this.final.add(id); this.handlers.onTranscript(who, value, id);
      if (first && who === "user") this.presentation.userText(value);
    }
  }
  private outputId(data: Data): string {
    const run = text(data.run_id), turn = text(data.turn_id);
    const key = run ? JSON.stringify([run, turn]) : undefined;
    const known = key && this.outputIds.get(key);
    if (known) return known;
    if (!this.pendingOutput || (key && this.pendingOutput.key && this.pendingOutput.key !== key)) this.pendingOutput = { id: `assistant:${this.outputTurn++}`, key };
    if (key) { this.outputIds.set(key, this.pendingOutput.id); this.pendingOutput.key = key; }
    return this.pendingOutput.id;
  }
  private reply(data: Data): Reply {
    const run = text(data.run_id), turn = text(data.turn_id);
    if (!run) throw new Error("回复缺少 run_id");
    const key = JSON.stringify([run, turn]);
    let reply = this.replies.get(key);
    if (!reply) { reply = { run, turn, chunks: [], done: false, stopped: false, completed: false }; this.replies.set(key, reply); }
    return reply;
  }
  private audio(pcm: Buffer): void {
    const context = this.context; this.context = null;
    if (!context) throw new Error("音频没有对应的 response.audio.context");
    const { reply, chunk } = context;
    if (!this.ready || reply.stopped || reply.completed || (chunk && reply.chunks.some(item => item.wireId === chunk))) return;
    // Live's session-level commentary currently has a run_id, but empty turn_id
    // and chunk_id. Local IDs distinguish its audio nodes; never send them as
    // provider IDs. In particular, repeated empty chunk IDs are distinct PCM.
    const serial = ++this.serial;
    const identity: AudioIdentity = { callId: this.id, responseId: reply.run, itemId: this.itemId(reply), chunkId: chunk || `local:${serial}`, playbackEpoch: this.epoch };
    if (pcm.length % 2) throw new Error("PCM16 音频字节数不完整");
    const item: Chunk = { serial, identity, wireId: chunk, completed: false, duration: pcm.length / 48 }; reply.chunks.push(item);
    if (pcm.length) this.handlers.onAudio(pcm, item.serial, identity); else this.noteChunkPlayed({ ...identity, serial: item.serial, playedMs: 0 });
  }
  sendAudio(pcm: Buffer): void { if (this.ready && !this.muted && !this.closed) this.socket?.send(pcm); }
  setMuted(value: boolean): void { this.muted = value; if (this.ready) this.send({ action: "mic_state", enabled: !value }); }
  notePlayback(_position: PlaybackPosition): void { /* MOSS interruption uses the renderer's synchronous stop receipt. */ }
  noteSpeakerIdle(_serial: number, _callId?: string): void { /* Per-chunk completion is authoritative. */ }
  noteChunkPlayed(position: PlaybackPosition): void {
    if (this.closed || position.callId !== this.id) return;
    for (const reply of this.replies.values()) {
      const chunk = reply.chunks.find(item => item.serial === position.serial && item.identity.chunkId === position.chunkId && item.identity.responseId === position.responseId && item.identity.itemId === position.itemId);
      if (!chunk || chunk.completed || (reply.stopped && ![...this.interruptions.values()].includes(reply))) continue;
      chunk.completed = true;
      if (reply.turn && chunk.wireId) this.playbackReceipt({ action: "playback.chunk.completed", run_id: reply.run, turn_id: reply.turn, chunk_id: chunk.wireId });
      this.drain(reply); this.resumeWaitingTools(); return;
    }
  }
  private drain(reply: Reply): void {
    if (!reply.done || reply.completed || reply.stopped || reply.chunks.some(chunk => !chunk.completed)) return;
    reply.completed = true;
    if (reply.turn) this.playbackReceipt({ action: "playback.completed", run_id: reply.run, turn_id: reply.turn });
    this.presentation.segmentPlayed(); this.state("listening");
    if ((this.preview || this.ending) && ![...this.replies.values()].some(item => !item.completed && !item.stopped && item.chunks.length)) this.hangup();
  }
  private stop(reply: Reply, preserveContinuation = false): void {
    if (reply.stopped || reply.completed) return;
    reply.stopped = true;
    for (const tool of this.tools.values()) if (tool.owner === reply && !tool.resumed && !(preserveContinuation && tool.waiting)) {
      tool.controller.abort(); tool.resumed = true; tool.waiting = false;
    }
    const epoch = ++this.epoch; this.interruptions.set(epoch, reply);
    this.handlers.onInterrupt({ callId: this.id, playbackEpoch: epoch, throughSerial: this.serial, responseId: reply.run, itemId: this.itemId(reply), scope: "reply" });
    this.resumeWaitingTools();
  }
  noteInterrupted(receipt: InterruptionReceipt): void {
    if (receipt.callId !== this.id || this.closed) return;
    const reply = this.interruptions.get(receipt.playbackEpoch); if (!reply) return;
    this.interruptions.delete(receipt.playbackEpoch);
    const p = receipt.position;
    const chunk = p && reply.chunks.find(chunk => chunk.serial === p.serial && chunk.identity.chunkId === p.chunkId && !chunk.completed);
    if (reply.turn) this.playbackReceipt({ action: "playback.stopped", run_id: reply.run, turn_id: reply.turn, played_audio_ms: chunk && p && Number.isFinite(p.playedMs) ? Math.floor(Math.min(chunk.duration, Math.max(0, p.playedMs))) : 0 });
  }
  private itemId(reply: Reply): string { return reply.turn || `local:${reply.run}`; }
  private playbackReceipt(receipt: Data): void {
    const id = `${String(receipt.action)}:${String(receipt.run_id)}:${String(receipt.turn_id)}:${String(receipt.chunk_id ?? "")}`;
    if (this.ready) this.send(receipt); else this.playbackReceipts.set(id, receipt);
  }
  private append(append: Append): void {
    if (this.closed || this.accepted.has(append.event_id) || this.appends.has(append.event_id)) return;
    this.appends.set(append.event_id, append); if (this.ready) this.send(append);
  }
  jobChanged(job: TaskJob): void {
    if (this.closed) return;
    const id = [...this.delegates].find(([, jobId]) => jobId === job.id)?.[0];
    if (!id) return;
    const terminalAttempt = this.terminalAttempts.get(id);
    const retried = terminalAttempt !== undefined && job.attempts > terminalAttempt;
    if (this.cancelled.has(id) && !retried) return;
    this.attempts.set(id, job.attempts);
    if (job.status === "cancelled") {
      this.cancelled.add(id); if (terminalAttempt === undefined) this.terminalAttempts.set(id, job.attempts);
      for (const [key, append] of this.appends) if (append.delegation_id === id) this.appends.delete(key);
      if (!retried) this.send({ action: "session.delegation.cancel", delegation_id: id }); return;
    }
    if (job.status === "queued" || job.status === "running") {
      this.state("working", job.activity);
      if (job.activity) this.append({ action: "session.thinking.append", ...(retried ? {} : { delegation_id: id }), content: short(job.activity), event_id: `${job.id}:${job.attempts}:progress:${job.updatedAt}` });
    } else {
      if (terminalAttempt === undefined) this.terminalAttempts.set(id, job.attempts);
      for (const [key, append] of this.appends) if (append.delegation_id === id && append.action === "session.thinking.append") this.appends.delete(key);
      const status = job.status === "succeeded" ? "completed" : "failed";
      const full = job.result || job.error || "后台任务未完成。";
      const files = job.artifacts.length ? `\n文件：${Array.from(job.artifacts.join("、")).slice(0, 500).join("")}` : "";
      const budget = 1950 - Array.from(files).length;
      const excerpt = Array.from(full).length > budget;
      let body = Array.from(full).slice(0, budget).join("");
      if (excerpt) { const boundary = Math.max(body.lastIndexOf("。"), body.lastIndexOf("\n"), body.lastIndexOf(". ")); if (boundary > budget / 2) body = body.slice(0, boundary + 1); }
      const content = `${excerpt ? "结果节选：\n" : ""}${body}${excerpt ? "\n完整结果保存在本次通话中。" : ""}${files}`;
      this.append({ action: "session.commentary.append", ...(retried ? {} : { delegation_id: id }), content, status, event_id: `${job.id}:${job.attempts}:${job.status}` });
      if (this.statePhase === "working") this.state("listening");
    }
  }
  notify(id: string, value: string): void { this.append({ action: "session.commentary.append", content: short(value), status: "completed", event_id: id }); }
  updateContext(key: string, value: string): void {
    this.append({ action: "session.thinking.append", content: short(value), event_id: `${key}:${randomUUID()}` });
  }
  locate(path: string, page: number, totalPages: number, mode: "canvas" | "file" = "canvas"): void {
    this.presentation.locate(path, page, totalPages, mode); this.updateContext("stage", JSON.stringify({ path, page, totalPages, mode }));
  }
  control(action: "pause" | "resume" | "complete"): void {
    if (action === "pause") this.presentation.pause(); else if (action === "resume") this.presentation.resume(); else this.presentation.finish();
    if (action !== "resume") for (const reply of this.replies.values()) this.stop(reply, action === "pause");
    this.state(action === "pause" ? "paused" : "listening");
    this.updateContext("presentation", JSON.stringify(this.presentation.snapshot()));
    if (action === "resume") this.resumeWaitingTools();
  }
  private output(id: string, output: string): void { this.send({ action: "conversation.item.create", item: { type: "function_call_output", call_id: id, output } }); }
  private resumeTool(id: string): void {
    const tool = this.tools.get(id);
    if (!tool || !tool.confirmed || tool.resumed || tool.waiting || !this.ready) return;
    tool.resumed = true;
    if (this.ending) { if (![...this.replies.values()].some(reply => !reply.completed && !reply.stopped && reply.chunks.length)) this.hangup(); return; }
    this.send({ action: "response.create", response: { call_ids: [id] } });
  }
  private resumeWaitingTools(): void {
    if (this.closed || this.presentation.snapshot().status === "paused") return;
    if ([...this.replies.values()].some(reply => !reply.completed && !reply.stopped)) return;
    for (const [id, tool] of this.tools) if (tool.waiting && !tool.controller.signal.aborted) { tool.waiting = false; if (tool.output !== undefined) this.output(id, tool.output); this.resumeTool(id); }
  }
  private async functionCall(data: Data): Promise<void> {
    const id = text(data.call_id), name = text(data.name);
    if (!id || this.tools.has(id)) return;
    const owner = [...this.replies.values()].findLast(reply => !reply.completed && !reply.stopped);
    const tool = { controller: new AbortController(), output: undefined as string | undefined, confirmed: false, resumed: false, waiting: false, owner }; this.tools.set(id, tool);
    try {
      if (name === "continue_speaking") {
        tool.waiting = this.presentation.snapshot().status === "paused" || [...this.replies.values()].some(reply => !reply.completed && !reply.stopped);
        tool.output = "继续讲解下一段。需要翻页时先打开目标页；完整讲完才结束讲解。";
      } else if (name === "manage_presentation") {
        const args = object(JSON.parse(text(data.arguments) || "{}"));
        if (args.action === "start") this.presentation.start(text(args.goal), text(args.path));
        else if (args.action === "pause" || args.action === "resume" || args.action === "complete") this.control(args.action);
        else throw new Error("action 必须是 start、pause、resume 或 complete。");
        this.state(this.statePhase);
        tool.output = JSON.stringify(this.presentation.snapshot());
      } else if (name === "end_call") { this.ending = true; tool.output = "正在结束通话。";
      } else tool.output = await this.handlers.runTool(name, text(data.arguments), id, tool.controller.signal);
    } catch (error) { tool.output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
    if (this.closed || tool.controller.signal.aborted) return;
    this.handlers.onToolOutput?.(id);
    if (!tool.waiting) this.output(id, tool.output ?? "");
  }
  hangup(detail = ""): void {
    if (this.closed) return;
    clearTimeout(this.timer); clearTimeout(this.retry); clearTimeout(this.previewTimer);
    this.closed = true; this.ready = false;
    for (const reply of this.replies.values()) if (!reply.completed && !reply.stopped) this.stop(reply);
    this.connection++;
    for (const tool of this.tools.values()) tool.controller.abort();
    this.socket?.close(); this.state("ended", detail); this.handlers.onPhase("closed", detail);
  }
}

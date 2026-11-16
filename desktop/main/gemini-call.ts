import { GeminiLive, type GeminiSocket, type GeminiTool, type GeminiToolCall, type GeminiToolResult } from "../../src/gemini-live.ts";
import { Presentation, type PresentationState } from "../../src/presentation.ts";
import type { TaskJob } from "../../src/types.ts";
import { canEndCall, refusesHangup } from "../../src/hangup-intent.ts";
import type { CallHandlers, InterruptionReceipt, PlaybackPosition, VoiceState } from "./call.ts";

import { VisualQueue } from "../../src/visual-queue.ts";
import type { VisualInput } from "../../src/shared-context.ts";

interface Line { who: "user" | "assistant"; text: string; id: string; order: number; sealed: boolean }
interface Delegation { remote: string; notify: boolean; resolve(result: GeminiToolResult): void }
export class GeminiCall {
  readonly id: string;
  readonly presentation: Presentation;
  private readonly transport: GeminiLive;
  private readonly handlers: CallHandlers;
  private readonly preview: string;
  private readonly lines: Line[] = [];
  private readonly tools = new Map<string, AbortController>();
  private readonly delegations = new Map<string, Delegation>();
  private readonly jobSnapshots = new Map<string, TaskJob>();
  private readonly notices = new Map<string, string>();
  private readonly announced = new Set<string>();
  private readonly cancelledRemote = new Set<string>();
  private readonly visuals: VisualQueue;
  private contextDirty = false;
  private readonly context = new Map<string, string>();
  private readonly navigation = new Set<AbortController>();
  private foreground: Promise<unknown> = Promise.resolve();
  private userLine: Line | null = null;
  private lastUserLine: Line | null = null;
  private activitySeen = false;
  private userSpeaking = false;
  private acceptingInput = true;
  private assistantLine: Line | null = null;
  private closed = false;
  private ready = false;
  private everLive = false;
  private muted = false;
  private generating = false;
  private userPending = false;
  private waitingForUser = false;
  private speakerBusy = false;
  private segmentPending = false;
  private narration = false;
  private advanceDue = false;
  private finishRequested = false;
  private automaticSteps = 0;
  private completedInput = "";
  private ending = false;
  private serial = 0;
  private fence = 0;
  private begunAt = "";
  private loop: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private endingTimer: ReturnType<typeof setTimeout> | undefined;
  private lastState = "";
  private lastDiagnostic = "";

  constructor(url: string, key: string, session: Record<string, unknown>, handlers: CallHandlers,
    connect?: (headers: Record<string, string>) => GeminiSocket, preview = "", initial?: PresentationState) {
    this.handlers = handlers; this.preview = preview; this.presentation = new Presentation(initial);
    this.transport = new GeminiLive(key, { url, model: String(session.model || "gemini-3.8-live"), voice: String(session.voice || "Kore"), instructions: String(session.instructions || ""), tools: session.tools as GeminiTool[] }, {
      onReady: resumed => {
        if (this.ending) { this.hangup(); return; }
        this.ready = true; this.contextDirty = this.context.size > 0; this.flushContext(); this.visuals.replay(); this.userPending = this.waitingForUser = false;
        if (resumed) { this.userSpeaking = false; this.acceptingInput = false; }
        if (resumed && this.presentation.snapshot().status === "active") this.narration = true;
        if (!this.everLive) { this.everLive = true; handlers.onPhase("live"); if (preview) { this.generating = true; this.transport.sendText(`只读出这一句话，不添加其他内容：${preview}`); } }
        this.state(undefined, resumed ? "已恢复连接，请重述断线期间的话。" : ""); this.schedule();
      },
      onReconnecting: () => { if (this.ending) { this.hangup(); return; } this.ready = false; this.generating = false; this.seal(this.userLine); this.seal(this.assistantLine); this.userLine = this.assistantLine = null; clearTimeout(this.loop); this.state("reconnecting", "正在恢复原通话，后台任务继续运行。"); },
      onActivity: active => {
        if (this.ending) return;
        this.activitySeen = true; this.userSpeaking = active;
        if (active) { clearTimeout(this.loop); this.userPending = this.waitingForUser = true; this.acceptingInput = true; this.seal(this.userLine); this.userLine = null; this.narration = this.advanceDue = false; }
        else if (!this.waitingForUser && !this.generating) { this.userPending = false; this.schedule(); }
        this.state();
      },
      onAudio: (pcm, serial, identity) => { this.serial = serial; this.waitingForUser = false; this.generating = true; this.speakerBusy = this.segmentPending = true; this.state("speaking"); handlers.onAudio(pcm, serial, identity); },
      onInterrupt: (value, internal) => {
        this.fence = value.throughSerial; this.speakerBusy = this.segmentPending = false;
        this.seal(this.assistantLine); this.assistantLine = null;
        if (this.userLine?.sealed) this.userLine = null;
        if (!internal) { this.generating = false; this.userPending = this.waitingForUser = true; if (!this.userLine || this.userLine.sealed) this.narration = false; this.advanceDue = false; }
        clearTimeout(this.loop); handlers.onInterrupt(value);
      },
      onText: (who, fragment) => this.text(who, fragment),
      onGenerationComplete: () => { if (this.ending) { this.generating = false; this.schedule(); } },
      onTurnComplete: interrupted => {
        if (interrupted) { this.state(); return; }
        this.waitingForUser = false;
        this.generating = false; this.userPending = this.userSpeaking; this.seal(this.userLine); this.seal(this.assistantLine);
        this.acceptingInput = false;
        this.userLine = this.assistantLine = null; this.settleSegment(); this.state(); this.schedule();
      },
      onClosed: reason => this.finish(reason),
      onToolCancelled: id => {
        this.cancelledRemote.add(id);
        this.tools.get(id)?.abort(); this.tools.delete(id);
        for (const [jobId, delegation] of this.delegations) if (delegation.remote === id) {
          delegation.resolve({ result: "回应通道已关闭，后台工作继续。", scheduling: "SILENT" });
          delegation.remote = "";
          const job = this.jobSnapshots.get(jobId); if (job) this.jobChanged(job);
        }
        this.schedule();
      },
      runTool: call => this.runTool(call),
    }, connect);
    this.visuals = new VisualQueue(() => this.ready && !this.closed && !this.ending, image => {
      this.transport.sendImage(image.data);
    }, state => handlers.onVisual?.(state));
    this.id = this.transport.id;
  }
  start(): void { this.begunAt = new Date().toISOString(); this.handlers.onPhase("connecting"); this.state("connecting"); this.transport.start(); if (this.preview) this.watchdog = setTimeout(() => this.hangup("Gemini 音色试听超时。"), 30000); }
  startedAt(): string { return this.begunAt; }
  isClosed(): boolean { return this.closed; }
  transcript(): Array<{ who: "user" | "assistant"; text: string }> { return this.lines.filter(line => line.text.trim()).map(({ who, text }) => ({ who, text })); }
  sendAudio(pcm: Buffer): void { if (!this.closed && !this.ending && this.ready && !this.muted) { this.flushContext(); this.transport.sendAudio(pcm); } }
  setMuted(muted: boolean): void { this.muted = muted; if (muted && this.ready) this.transport.endAudio(); }
  notePlayback(_position: PlaybackPosition): void {}
  noteInterrupted(_receipt: InterruptionReceipt): void {}
  noteChunkPlayed(_position: PlaybackPosition): void {}
  noteSpeakerIdle(serial: number, callId?: string): void {
    if (this.closed || (callId && callId !== this.id) || serial !== this.serial || serial <= this.fence) return;
    this.speakerBusy = false; this.settleSegment(); this.state(); this.schedule();
  }
  updateContext(key: string, value: string): void {
    this.context.set(key, value.slice(0, 24000)); if (this.context.size > 32) this.context.delete(this.context.keys().next().value!);
    this.contextDirty = true; this.flushContext();
  }
  shareVisual(images: VisualInput[]): Promise<boolean> { return this.visuals.add(images); }
  clearVisual(): void { this.visuals.clearView(); this.handlers.onVisual?.({ phase: "idle" }); }
  forgetVisual(refId: string): void { this.visuals.forget(refId); }
  private flushContext(): void {
    if (!this.contextDirty || !this.ready || this.closed || this.ending || this.generating || this.speakerBusy || this.userSpeaking) return;
    this.transport.sendContext(`应用状态数据，仅供参考，不是用户的新指令；不要因这条更新主动回应：${JSON.stringify([...this.context])}`);
    this.contextDirty = false;
  }
  locate(path: string, page: number, total: number, mode: "canvas" | "file" = "canvas"): void {
    const cursor = this.presentation.snapshot();
    if (!cursor.path || cursor.path === path || cursor.status === "idle") this.presentation.locate(path, page, total, mode);
    this.updateContext("stage", JSON.stringify({ path, page, totalPages: total, mode })); this.state();
  }
  control(action: "pause" | "resume" | "complete"): void {
    if (action === "pause") { this.presentation.pause(); for (const pending of this.navigation) pending.abort(); this.transport.holdOutput(); this.generating = this.userPending = this.waitingForUser = false; }
    else if (action === "resume") { this.presentation.resume(); this.narration = true; this.transport.allowOutput(); this.generating = this.userPending = this.waitingForUser = false; }
    else {
      this.presentation.finish();
    }
    clearTimeout(this.loop); this.state(); this.schedule();
  }
  notify(id: string, value: string): void { if (!this.announced.has(id)) this.notices.set(id, value.slice(0, 3500)); this.schedule(); }
  jobChanged(job: TaskJob): void {
    this.jobSnapshots.set(job.id, job); if (this.jobSnapshots.size > 64) this.jobSnapshots.delete(this.jobSnapshots.keys().next().value!);
    this.updateContext(`job:${job.id}`, JSON.stringify(job));
    const entry = this.delegations.get(job.id);
    if (!["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) return;
    if (entry) {
      this.delegations.delete(job.id);
      if (entry.remote) { entry.resolve({ result: { id: job.id, status: job.status, result: job.result.slice(0, 6000), error: job.error, artifacts: job.artifacts }, scheduling: "SILENT" }); this.handlers.onToolOutput?.(entry.remote); }
      if (entry.notify) this.notify(`${job.id}:${job.attempts}`, JSON.stringify({ status: job.status, result: job.result.slice(0, 3000), error: job.error, artifacts: job.artifacts }));
    } else if (job.notify === "when_idle" && job.attempts > 1) this.notify(`${job.id}:${job.attempts}`, JSON.stringify({ result: job.result.slice(0, 3000), error: job.error }));
    this.state(); this.schedule();
  }
  hangup(reason = ""): void { this.transport.close(reason); }
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.visuals.close(); clearTimeout(this.loop); clearTimeout(this.watchdog); clearTimeout(this.endingTimer);
    for (const tool of this.tools.values()) tool.abort(); this.tools.clear();
    for (const entry of this.delegations.values()) entry.resolve({ result: "通话已结束，后台任务继续。", scheduling: "SILENT" }); this.delegations.clear();
    this.seal(this.userLine); this.seal(this.assistantLine); this.state("ended", reason); this.handlers.onPhase("closed", reason);
  }
  private text(who: "user" | "assistant", fragment: string): void {
    if (who === "user") {
      if (!this.activitySeen) { clearTimeout(this.loop); this.userPending = this.waitingForUser = true; if (!this.userLine) this.narration = this.advanceDue = false; }
      this.userLine ??= this.activitySeen && !this.acceptingInput && this.lastUserLine ? this.lastUserLine : this.line(who);
      this.lastUserLine = this.userLine; this.userLine.text += fragment;
      const before = this.presentation.snapshot().status;
      if (!this.userLine.sealed) {
        this.presentation.userText(this.userLine.text);
        if (this.presentation.snapshot().status === "active" && (before !== "active" || /^(继续|接着讲|resume|continue)/i.test(this.userLine.text.trim()))) { this.narration = true; if (before !== "active") { this.finishRequested = false; this.automaticSteps = 0; } }
      }
      this.handlers.onLine(who, this.userLine.text, !this.userLine.sealed, this.userLine.id, this.userLine.order);
    } else {
      this.userPending = this.waitingForUser = false; this.generating = true; this.seal(this.userLine);
      this.assistantLine ??= this.line(who); this.assistantLine.text += fragment;
      this.handlers.onLine(who, this.assistantLine.text, true, this.assistantLine.id, this.assistantLine.order);
    }
    this.state();
  }
  private line(who: Line["who"]): Line { const order = this.lines.length; const line = { who, text: "", order, id: `${this.id}:line:${order}`, sealed: false }; this.lines.push(line); return line; }
  private seal(line: Line | null): void {
    if (!line || line.sealed || !line.text.trim()) return;
    line.sealed = true; this.handlers.onLine(line.who, line.text, false, line.id, line.order); this.handlers.onTranscript(line.who, line.text, line.id);
  }
  private settleSegment(): void {
    if (this.speakerBusy || this.generating) return;
    if (this.segmentPending && this.narration && this.presentation.snapshot().status === "active") {
      this.presentation.segmentPlayed(); this.advanceDue = true;
    }
    this.segmentPending = false;
    const cursor = this.presentation.snapshot();
    if (this.narration && this.advanceDue && cursor.status === "active" && ((cursor.totalPages > 0 && cursor.page >= cursor.totalPages) || (!cursor.totalPages && this.finishRequested))) {
      this.presentation.finish(); this.completedInput = this.lastUserLine?.id || ""; this.transport.holdOutput(false);
    }
  }
  private state(phase?: VoiceState["phase"], detail = ""): void {
    const next: VoiceState = { phase: this.ending && !this.closed ? "ending" : phase || (this.closed ? "ended" : !this.ready ? "reconnecting" : this.speakerBusy ? "speaking" : this.generating || this.userPending ? "thinking" : this.tools.size ? "working" : this.presentation.snapshot().status === "paused" ? "paused" : "listening"), detail, presentation: this.presentation.snapshot() };
    const serialized = JSON.stringify(next); if (this.lastState !== serialized) { this.lastState = serialized; this.handlers.onState?.(next); }
    this.diagnostic(next.phase);
  }
  private diagnostic(phase: string): void {
    if (process.env.XIAOWANG_GEMINI_DIAGNOSTICS !== "1") return;
    const value = JSON.stringify({ phase, ready: this.ready, generating: this.generating, userPending: this.userPending, userSpeaking: this.userSpeaking, activitySeen: this.activitySeen, waitingForUser: this.waitingForUser, speakerBusy: this.speakerBusy, narration: this.narration, advanceDue: this.advanceDue, tools: this.tools.size, delegations: this.delegations.size, page: this.presentation.snapshot().page, status: this.presentation.snapshot().status });
    if (value !== this.lastDiagnostic) { this.lastDiagnostic = value; process.stderr.write(`XW_GEMINI_STATE ${value}\n`); }
  }
  private schedule(): void {
    clearTimeout(this.loop);
    this.diagnostic("schedule"); this.flushContext();
    if (this.ending) {
      if (!this.closed && !this.speakerBusy && !this.generating) this.loop = setTimeout(() => this.hangup(), 350);
      return;
    }
    if (this.closed || !this.ready || this.speakerBusy || this.generating || this.userPending || this.tools.size) return;
    this.loop = setTimeout(() => {
      if (this.ending || this.preview) { this.hangup(); return; }
      if (this.notices.size) {
        const [id, text] = this.notices.entries().next().value!; this.notices.delete(id); this.announced.add(id);
        this.narration = false; this.generating = true; this.transport.allowOutput(); this.transport.sendText(`后台已确认的结果数据：${text}\n请依据这些数据简短告知用户，不要复述控制提示。`); return;
      }
      if (this.presentation.shouldContinue() && !this.delegations.size) void this.advancePresentation();
    }, 350);
  }
  private async advancePresentation(): Promise<void> {
    if (++this.automaticSteps > 100) { this.presentation.pause(); this.state("paused", "讲解达到自动续讲上限，请确认后继续。"); return; }
    const controller = new AbortController(), id = `${this.id}:page:${this.automaticSteps}`;
    this.tools.set(id, controller); this.navigation.add(controller); this.generating = true;
    try {
      const cursor = this.presentation.snapshot();
      if (this.advanceDue && cursor.path && cursor.totalPages > cursor.page) {
        const page = cursor.page + 1;
        const args = cursor.mode === "canvas" ? { mode: "canvas", path: cursor.path, page } : { mode: "file", file: cursor.path, page };
        await this.handlers.runTool("show_stage", JSON.stringify(args), id, controller.signal);
        controller.signal.throwIfAborted();
        if (this.presentation.snapshot().page !== page) throw new Error("下一页未能确认显示，请检查资料后继续。");
      }
      controller.signal.throwIfAborted();
      this.advanceDue = false; this.narration = true;
      this.transport.sendText(`应用已确认的讲解位置：${JSON.stringify(this.presentation.snapshot())}。只讲当前这一页，按原目标接上；已讲过一部分则从中断处继续。需要内容先读取。讲完本页后停下，应用等实际播放完成后负责翻页。不要自行请求下一页或等待用户说继续。`);
    } catch (error) {
      this.generating = false;
      if (!controller.signal.aborted && !this.closed) { this.presentation.pause(); this.state("paused", error instanceof Error ? error.message : String(error)); }
    } finally { this.navigation.delete(controller); this.tools.delete(id); this.state(); }
  }
  private async runTool(call: GeminiToolCall): Promise<GeminiToolResult> {
    if (this.ending) return { result: "通话正在结束，不再执行新的通话指令。", scheduling: "SILENT" };
    this.seal(this.userLine);
    if (call.name === "manage_presentation") {
      if (call.args.action === "complete") await this.foreground;
      if (this.presentation.snapshot().status === "paused" && ["start", "complete"].includes(String(call.args.action))) return { result: this.presentation.snapshot(), scheduling: "SILENT" };
      if (call.args.action === "start" && this.completedInput && this.lastUserLine?.id === this.completedInput && this.presentation.snapshot().status === "completed") return { result: this.presentation.snapshot(), scheduling: "SILENT" };
      if (call.args.action === "start") {
        if (this.presentation.snapshot().status !== "active") this.presentation.start(String(call.args.goal || ""), this.presentation.snapshot().path, this.presentation.snapshot().mode);
        this.narration = true;
      }
      else if (call.args.action === "complete") { this.finishRequested = true; this.settleSegment(); }
      else if (["pause", "resume"].includes(String(call.args.action))) this.control(call.args.action as "pause" | "resume");
      else return { result: { error: "Invalid presentation action" } };
      if (call.args.action === "start" || call.args.action === "resume") this.generating = true;
      this.state(); return { result: this.presentation.snapshot(), scheduling: call.args.action === "complete" || call.args.action === "pause" ? "SILENT" : "WHEN_IDLE" };
    }
    if (call.name === "end_call") {
      // Native tool calls may precede their corresponding input transcription.
      const quote = String(call.args.user_request || "");
      const currentRequest = () => this.userLine?.text || (this.activitySeen && this.acceptingInput ? "" : this.lastUserLine?.text || "");
      for (let n = 0; n < 14 && !canEndCall(currentRequest(), quote) && !refusesHangup(currentRequest()) && (this.activitySeen || quote); n++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (this.closed) return { result: "通话已结束。", scheduling: "SILENT" };
      }
      if (!canEndCall(currentRequest(), quote)) return { result: { status: "call_remains_open", message: "没有确认本轮用户的结束请求，保持通话；不要声称已经挂断。" }, scheduling: "SILENT" };
      this.ending = true; this.notices.clear(); this.presentation.pause();
      for (const pending of this.navigation) pending.abort();
      this.endingTimer = setTimeout(() => this.hangup(), 8000);
      this.state(); this.schedule(); return { result: "道别播完后结束通话。", scheduling: "SILENT" };
    }
    const controller = new AbortController(); this.tools.set(call.id, controller); this.state();
    try {
      const execute = async () => {
        controller.signal.throwIfAborted();
        const cursor = this.presentation.snapshot();
        if (call.name === "show_stage" && cursor.status === "paused") return JSON.stringify({ status: "paused", message: "讲解已暂停，恢复后从原页继续。" });
        if (call.name === "show_stage" && cursor.status === "active" && cursor.path && this.narration && call.args.page !== undefined && call.args.page !== cursor.page) return JSON.stringify({ status: "application_managed", currentPage: cursor.page, message: "本次先讲当前这一页。应用会在实际播放完成后翻页，不要提前讲后面的页面。" });
        controller.signal.throwIfAborted();
        return this.handlers.runTool(call.name, JSON.stringify(call.args), call.id, controller.signal);
      };
      const background = ["delegate_task", "ask_text", "get_task", "cancel_task"].includes(call.name);
      const operation = background ? execute() : this.foreground.then(execute);
      if (!background) this.foreground = operation.catch(() => {});
      const output = await operation;
      if (this.ending || this.closed) return { result: "通话正在结束，后台结果仍保留在记录中。", scheduling: "SILENT" };
      if (["delegate_task", "ask_text"].includes(call.name)) {
        let receipt: Record<string, unknown> = {}; try { receipt = JSON.parse(output); } catch {}
        if (typeof receipt.id === "string") {
          if (this.delegations.get(receipt.id)?.remote) return { result: receipt, scheduling: "SILENT" };
          const cancelled = this.cancelledRemote.has(call.id);
          const result = new Promise<GeminiToolResult>(resolve => {
            this.delegations.set(receipt.id as string, { remote: cancelled ? "" : call.id, notify: call.args.notify !== "silent", resolve });
            if (cancelled) resolve({ result: "回应通道已关闭，后台工作继续。", scheduling: "SILENT" });
          });
          const snapshot = this.jobSnapshots.get(receipt.id); if (snapshot) this.jobChanged(snapshot);
          return result;
        }
      }
      if (controller.signal.aborted) return { result: "当前回应已取消。", scheduling: "SILENT" };
      this.generating = true; this.handlers.onToolOutput?.(call.id); return { result: output, scheduling: "WHEN_IDLE" };
    } catch (error) { return { result: { error: error instanceof Error ? error.message : String(error) }, scheduling: "WHEN_IDLE" }; }
    finally { this.tools.delete(call.id); this.state(); this.schedule(); }
  }
}

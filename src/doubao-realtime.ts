import { parseRealtimeEvent, type RealtimeNotice } from "./realtime.ts";

/** Seeduplex deltas have no IDs: only its ordered audio-start/cancel-ack boundaries bind a stream. */
export class DoubaoRealtime {
  private audio: { responseId: string; itemId: string; questionId?: string } | null = null;
  private cancelling = false;
  private outputQuestion = "";
  private pendingOutput = false;
  private inputItem = "";
  private readonly spokenInputs = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly cancelledQuestions = new Set<string>();
  private readonly finished = new Set<string>();

  isCancelling(): boolean { return this.cancelling; }
  hasOutput(): boolean { return this.pendingOutput || this.audio !== null; }
  isAudioOpen(): boolean { return this.audio !== null; }
  resumeContinuation(): void { this.cancelledQuestions.delete(this.outputQuestion); }
  interrupt(): void {
    if (this.audio) this.cancelled.add(this.audio.responseId);
    if (this.outputQuestion) this.cancelledQuestions.add(this.outputQuestion);
    this.audio = null; this.pendingOutput = false; this.cancelling = true;
  }
  parse(raw: string): RealtimeNotice[] {
    const notices = parseRealtimeEvent(raw);
    const output: RealtimeNotice[] = [];
    for (const notice of notices) {
      if (notice.kind === "asr_started") {
        this.inputItem = notice.itemId || "";
        output.push(notice); continue;
      }
      if (notice.kind === "user_transcript") {
        const item = notice.itemId || this.inputItem;
        // A native ASR-start can also be a recognizer reset after cancel. Actual text confirms speech.
        if (notice.text.trim() && item && !this.spokenInputs.has(item) && (!this.inputItem || item === this.inputItem)) {
          this.spokenInputs.add(item); output.push({ kind: "speech_started", itemId: item });
        }
        output.push(notice); continue;
      }
      if (notice.kind === "response_done" && notice.status === "cancelled") {
        if (!this.cancelling) continue; // An old acknowledgement cannot close a newer stream.
        this.cancelling = false; this.audio = null; output.push(notice); continue;
      }
      if (notice.kind === "response_done" && !notice.status) continue; // Native response.done contains usage, not a lifecycle response ID.
      if (notice.questionId && this.cancelledQuestions.has(notice.questionId)) continue;
      if (notice.responseId && this.cancelled.has(notice.responseId)) continue;
      if (notice.kind === "audio_started") {
        if (this.cancelling || !notice.responseId || this.finished.has(notice.responseId)) continue;
        this.pendingOutput = true;
        this.outputQuestion = notice.questionId || "";
        this.audio = { responseId: notice.responseId, itemId: notice.itemId || `doubao-audio:${notice.responseId}`, questionId: notice.questionId };
        output.push({ ...notice, ...this.audio, kind: "response_started" }); continue;
      }
      if (notice.kind === "audio" || notice.kind === "audio_done") {
        if (this.cancelling || !this.audio || (notice.responseId && notice.responseId !== this.audio.responseId)) continue;
        const identity = this.audio;
        if (notice.kind === "audio_done") {
          this.finished.add(identity.responseId); this.audio = null; this.pendingOutput = false;
          output.push({ ...identity, kind: "response_done", status: "completed" });
        } else output.push({ ...notice, ...identity });
        continue;
      }
      if (notice.kind === "assistant_transcript" || notice.kind === "function_call") {
        if (this.cancelling) continue;
        if (notice.questionId) this.outputQuestion = notice.questionId;
        if (!notice.responseId || !this.finished.has(notice.responseId)) this.pendingOutput = true;
        if (notice.kind === "assistant_transcript") {
          output.push({ ...notice, itemId: notice.itemId || (notice.responseId ? `doubao-text:${notice.responseId}` : undefined) });
        } else output.push(notice);
        continue;
      }
      output.push(notice);
    }
    return output;
  }
}

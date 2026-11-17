import type { TaskJob } from "./types.ts";
import type { Store } from "./store.ts";
import type { JobQueue } from "./jobs.ts";

export function wantsChatDelivery(text: string): boolean {
  return !/(?:不要|不用|别|不必).{0,6}(?:发|贴)|(?:don't|do not) (?:send|post)/i.test(text)
    && /(?:发|贴)(?:送)?(?:给我|.{0,12}(?:聊天|对话|文本|这里))|(?:post|send|paste).{0,24}(?:chat|here|to me)/i.test(text);
}

export function jobPosted(job: TaskJob): boolean {
  return Boolean(job.deliverToChat && job.status === "succeeded" && job.resultEventId && job.result.trim());
}

function receipt(job: TaskJob): string {
  if (jobPosted(job)) return "完整结果已发到当前聊天。";
  if (job.status === "queued" || job.status === "running") return "任务仍在进行，完成后会发到当前聊天。";
  return job.error || "任务没有可发送的完整结果。";
}

/** A turn can forward a durable job result or the sealed reply preceding the request. */
export class VoiceDelivery {
  private reply?: number;
  private precedingReply?: number;
  private deliveryJob?: string;
  private replyReceipt = "";

  get lastReceipt(): string {
    return this.deliveryJob ? receipt(this.jobs.get(this.deliveryJob)) : this.replyReceipt;
  }
  private store: Store;
  private jobs: JobQueue;
  private botId: string;
  private callId: () => string;
  private onPost: (sourceEventId: number) => void;

  constructor(store: Store, jobs: JobQueue, botId: string, callId: () => string, onPost: (sourceEventId: number) => void) {
    this.store = store; this.jobs = jobs; this.botId = botId; this.callId = callId; this.onPost = onPost;
  }

  assistantLine(id: number): void {
    // A delivery acknowledgement cannot replace the answer when the user repeats the request.
    if (!this.lastReceipt) this.reply = id;
  }

  userLine(text: string): string | undefined {
    const previousJob = this.deliveryJob;
    this.precedingReply = this.reply;
    this.deliveryJob = undefined;
    this.replyReceipt = "";
    if (!wantsChatDelivery(text)) return;
    // An explicit forward-only request can be fulfilled before the model starts replying.
    // Compound requests (e.g. "整理成表格，然后发给我") first need a real result.
    const request = text.replace(/^.*我的意思是/u, "").trim();
    const destination = request.replace(/^(?:你|请|直接|就|帮我|在这里)+/u, "")
      .replace(/(?:就行了?|即可|就好)?[。！.!\s]*$/u, "");
    const forwardOnly = /^(?:把(?:刚才的回答|刚才那段|结果|表格))?(?:给我)?(?:发|发送|贴)(?:文本|文字|给我|到(?:我们的|当前|这个)?(?:聊天对话|聊天|对话|这里)[中里]?)$/u;
    if (!forwardOnly.test(destination)) return;
    const job = this.callJob();
    if (/刚(?:才|刚)?.{0,12}(?:说|回答)|那段/.test(text) || !job) return this.post("reply");
    if (previousJob || /表格|结果|后台|subbot/i.test(text) || !this.precedingReply) return this.post("job", previousJob);
    // Both a job and a later spoken answer exist. Let the tool select the referent in context.
    return;
  }

  private callJob(id?: string): TaskJob | undefined {
    return this.jobs.list(this.botId).findLast(job => job.originCallId === this.callId() && (!id || job.id === id));
  }

  post(source: string, id?: string): string {
    if (this.lastReceipt) return this.lastReceipt;
    if (source === "job") {
      const job = this.callJob(id);
      if (!job) return "没有找到本次通话的后台任务。";
      this.jobs.requestChatDelivery(job.id);
      this.deliveryJob = job.id;
      return this.lastReceipt;
    }
    if (source !== "reply" || !this.precedingReply) return "还没有已说完的回答可发送。";
    const inserted = this.store.postVoiceReply(this.botId, this.callId(), this.precedingReply);
    if (inserted) this.onPost(this.precedingReply);
    this.reply = this.precedingReply;
    this.replyReceipt = "刚才的完整回答已发到当前聊天。";
    return this.replyReceipt;
  }
}

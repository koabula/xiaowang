import type { TaskJob } from "./types.ts";
import type { JobQueue } from "./jobs.ts";

export function isVoiceProgressRequest(text: string): boolean {
  return /进度|梳理了吗|梳理了么|(?:分析|总结|整理|处理|做|查|写|研究).{0,8}(?:好了吗|完了吗|了吗|了么|如何了|怎么样)|(?:结果|梳理|分析).{0,8}(?:出来了吗|出来了没)|\b(?:status|progress|finished|done yet)\b/i.test(text);
}

/** Only unambiguous work requests are started locally. Other intent stays with realtime. */
export function isVoiceWorkRequest(text: string): boolean {
  if (/不要|不用|不必|别(?:再|去|分析|梳理|总结|研究|做|写)|暂停|停止|取消|先不|不需要|\b(?:don't|do not|stop|cancel|no need)\b/i.test(text)) return false;
  if (isVoiceProgressRequest(text)) return false;
  return /^(?:(?:嗯|哦|好|好的|那|现在|请|麻烦|帮我|给我|你|您|去|先|一下|我们|再|继续)[，,。\s]*)*(?:分析|梳理|总结|调研|研究一下|比较|对比|整理|撰写|写一|制作|做一)/.test(text.trim())
    || /^(?:(?:请|帮我|你|现在)[，,\s]*)*(?:把|将).{1,100}(?:分析|梳理|总结|整理|比较|对比)/.test(text.trim())
    || /^(?:(?:please|can you|could you|would you|help me|now|go ahead and)\s+)*(?:analy[sz]e|summari[sz]e|research|investigate|compare|review|write|create|prepare)\b/i.test(text.trim());
}

/** One accepted user turn owns one durable job, regardless of subsequent tool choices. */
export class VoiceTasks {
  private turn = 0;
  private accepted: string | null = null;
  private readonly queue: JobQueue;
  private readonly botId: string;
  private readonly sessionId: string;
  private readonly handoff: (text: string) => string;
  private readonly snapshot?: () => TaskJob["sharedContext"];
  private readonly callId?: () => string | undefined;
  constructor(queue: JobQueue, botId: string, sessionId: string, handoff: (text: string) => string, callId?: () => string | undefined, snapshot?: () => TaskJob["sharedContext"]) {
    this.queue = queue; this.botId = botId; this.sessionId = sessionId; this.handoff = handoff;
    this.callId = callId; this.snapshot = snapshot;
  }

  userText(text: string, startWork = true): TaskJob | null {
    this.turn += 1;
    this.accepted = null;
    const work = startWork && text.split(/[。！？!?；;]/).some(clause => isVoiceWorkRequest(clause.trim()));
    if (!work) {
      if (isVoiceProgressRequest(text)) this.accepted = this.latest()?.id ?? null;
      return null;
    }
    const job = this.queue.enqueue({ botId: this.botId, task: this.handoff(text), sharedContext: this.snapshot?.(), channel: "voice", notify: "when_idle", sourceCallId: `${this.sessionId}:user:${this.turn}`, originCallId: this.callId?.() });
    this.accepted = job.id;
    return job;
  }

  delegate(task: string, callId: string | undefined, notify: TaskJob["notify"]): TaskJob {
    const accepted = this.current();
    if (accepted) return accepted;
    const job = this.queue.enqueue({ botId: this.botId, task: this.handoff(task), sharedContext: this.snapshot?.(), channel: "voice", notify, sourceCallId: callId, originCallId: this.callId?.() });
    this.accepted = job.id;
    return job;
  }

  current(): TaskJob | null { return this.accepted ? this.queue.get(this.accepted) : null; }
  latest(): TaskJob | null { return this.queue.list(this.botId).filter(job => job.channel === "voice").at(-1) ?? null; }
}

export function voiceJobReceipt(job: TaskJob): string {
  return JSON.stringify({ id: job.id, task: job.task.slice(0, 400), status: job.status, activity: job.activity, result: job.result.slice(0, 2400), error: job.error, artifacts: job.artifacts, notify: job.notify,
    message: "这是应用确认的后台任务状态。同一任务不要重复分析或再次排队；用户提出不同的新任务时调用 delegate_task。未完成时告知真实进度；完成后依据 result 回答。打开原文需要调用 show_stage，成功后才能说已打开。" });
}

import type { TaskJob } from "./types.ts";
import type { JobQueue } from "./jobs.ts";

export function isVoiceProgressRequest(text: string): boolean {
  return /进度|梳理了吗|梳理了么|(?:分析|总结|整理|处理|做|查|写|研究).{0,8}(?:好了吗|完了吗|了吗|了么|如何了|怎么样)|(?:结果|梳理|分析).{0,8}(?:出来了吗|出来了没)|\b(?:status|progress|finished|done yet)\b/i.test(text);
}

export function isQueuedVoiceTask(text: string): boolean {
  return /排队|独立任务|单独.{0,5}任务|separate (?:task|job)|new task|(?:做完|完成|结束).{0,10}(?:再|之后)|另(?:开|起|建).{0,6}任务|queue (?:a |this |the )?(?:new )?task|after (?:this|you finish)/i.test(text);
}

/** Only the actual user's affirmative request can open another workspace. */
export function requestsSubbot(text: string): boolean {
  return text.split(/[，,。！？!?；;]/).some(part => {
    if (/不要|不必|不用|别|没有|没让|不是|不能|是否|如果|假如|\b(?:not|never|don't|if|unless)\b/i.test(part)) return false;
    return /(?:开|建|创)(?:建|立|设)?(?:一?个|一个新的|新的|独立的|新|独立|单独的|\s){0,5}(?:sub[ -]?bot|子助手|子任务|工作区|助手)|\b(?:create|open|start|spawn) (?:a |an )?(?:new |separate )?(?:sub[ -]?bot|workspace|assistant)\b/i.test(part);
  });
}

/** One accepted user turn owns one durable job, regardless of subsequent tool choices. */
export class VoiceTasks {
  private turn = 0;
  private userRequest = "";
  private spawned = false;

  takeSpawnRequest(): boolean {
    if (this.spawned || !requestsSubbot(this.userRequest)) return false;
    this.spawned = true;
    return true;
  }
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

  userText(text: string): void {
    this.turn += 1;
    this.userRequest = text;
    this.spawned = false;
    const clauses = text.split(/[。！？!?；;]/).map(part => part.trim()).filter(Boolean);
    this.accepted = clauses.length > 0 && clauses.every(isVoiceProgressRequest) ? this.latest()?.id ?? null : null;
  }

  delegate(task: string, callId: string | undefined, notify: TaskJob["notify"], queueNew = false): TaskJob {
    const accepted = this.current();
    if (accepted) return accepted;
    const queued = queueNew || isQueuedVoiceTask(task);
    const job = this.queue.submit({ botId: this.botId, task: this.queue.active(this.botId) && !queued ? task : this.handoff(task), sharedContext: this.snapshot?.(), channel: "voice", notify, sourceCallId: callId || `${this.sessionId}:user:${this.turn}`, originCallId: this.callId?.() }, queued);
    this.accepted = job.id;
    return job;
  }

  current(): TaskJob | null { return this.accepted ? this.queue.get(this.accepted) : null; }
  latest(): TaskJob | null { return this.queue.active(this.botId) ?? this.queue.list(this.botId).filter(job => job.channel === "voice").at(-1) ?? null; }
}

export function voiceJobReceipt(job: TaskJob): string {
  return JSON.stringify({ id: job.id, task: job.task.slice(0, 400), status: job.status, activity: job.activity, result: job.result.slice(0, 2400), error: job.error, artifacts: job.artifacts, notify: job.notify,
    message: "这是应用确认的后台任务状态。同一任务不要重复分析或再次排队；当前资料的简析和追问由你直接阅读并回答。未完成时告知真实进度；完成后依据 result 回答。打开原文需要调用 show_stage，成功后才能说已打开。" });
}

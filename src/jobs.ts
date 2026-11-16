import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Attachment, Channel, TaskJob } from "./types.ts";
import { taskTitle } from "./task-presentation.ts";

export interface JobOutput { text: string; artifacts?: string[]; resultEventId?: number }
export interface JobRunner {
  (job: TaskJob, signal: AbortSignal, activity: (text: string) => void): Promise<JobOutput>;
}
export interface JobInput {
  botId: string;
  task: string;
  messageText?: string;
  attachments?: Attachment[];
  sharedContext?: TaskJob["sharedContext"];
  channel?: Channel;
  notify?: TaskJob["notify"];
  sourceCallId?: string;
  display?: TaskJob["display"];
  title?: string;
  originCallId?: string;
}

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/** Persist transitions before dispatch. Never replay a job that may have made changes. */
export class JobQueue {
  private readonly records = new Map<string, TaskJob>();
  private readonly running = new Map<string, AbortController>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>();
  private readonly waiters = new Map<string, Array<(job: TaskJob) => void>>();
  private stopped = false;
  private enabled = false;
  private readonly store: Store;
  private readonly run: JobRunner;
  private readonly onChange: (job: TaskJob) => void;
  private readonly concurrency: number;

  constructor(store: Store, run: JobRunner, onChange: (job: TaskJob) => void = () => {}, concurrency = 2) {
    this.store = store; this.run = run; this.onChange = onChange; this.concurrency = concurrency;
    for (const bot of store.listBots()) {
      for (const { event } of store.getEvents(bot.id)) if (event.type === "job") this.records.set(event.job.id, event.job);
    }
    for (const job of this.records.values()) {
      if (job.status === "running") this.change(job, { status: "interrupted", error: "应用关闭时任务仍在进行。检查已有输出后，可手动重试。" });
    }
  }

  start(): void { if (this.enabled) return; this.enabled = true; this.pump(); }

  enqueue(input: JobInput): TaskJob {
    if (this.stopped) throw new Error("任务队列正在关闭。");
    if (this.removing.has(input.botId)) throw new Error("这个 Bot 正在删除。");
    this.store.requireBot(input.botId);
    const task = input.task.trim();
    if (!task || task.length > 40_000) throw new Error("任务内容不能为空，且不能超过 40000 字。");
    if (input.sourceCallId) {
      const existing = [...this.records.values()].find(job => job.botId === input.botId && job.sourceCallId === input.sourceCallId);
      if (existing) return { ...existing };
    }
    const now = new Date().toISOString();
    const job: TaskJob = { id: randomUUID(), botId: input.botId, task, channel: input.channel ?? "text", notify: input.notify ?? "silent", sourceCallId: input.sourceCallId, display: input.display ?? (input.channel && input.channel !== "text" ? "background" : "conversation"), title: taskTitle(input.title || task), originCallId: input.originCallId, status: "queued", createdAt: now, updatedAt: now, activity: "", result: "", error: "", attempts: 0, artifacts: [] };
    job.queuedAt = now;
    if (input.attachments?.length) job.attachments = input.attachments.map(a => ({ ...a }));
    if (input.messageText !== undefined) job.messageText = input.messageText;
    if (input.sharedContext) job.sharedContext = structuredClone(input.sharedContext);
    job.originEventId = this.store.append(job.botId, {
      type: "user_text", channel: job.channel, text: input.messageText ?? task, jobId: job.id,
      ...(job.attachments?.length ? { attachments: job.attachments } : {}),
    }).id;
    this.change(job, {});
    // Dispatch in a microtask so the caller can retain the durable job ID first.
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }

  active(botId: string): TaskJob | undefined {
    const jobs = this.list(botId);
    return jobs.find(job => job.status === "running") ?? jobs.find(job => job.status === "queued");
  }

  submit(input: JobInput, queueNew = false): TaskJob {
    if (input.sourceCallId) {
      const previous = this.list(input.botId).find(job => job.sourceCallId === input.sourceCallId || job.supplementSourceIds?.includes(input.sourceCallId!));
      if (previous) return previous;
    }
    if (queueNew) return this.enqueue(input);
    const active = this.active(input.botId);
    return active ? this.supplement(active.id, input) : this.enqueue(input);
  }

  supplement(id: string, input: JobInput): TaskJob {
    const job = this.records.get(id);
    if (!job || job.botId !== input.botId || terminal.has(job.status)) throw new Error("这个任务已结束。");
    if (this.stopped || this.removing.has(job.botId)) throw new Error("这个任务正在关闭。");
    const text = input.task.trim();
    if (!text || text.length > 40_000) throw new Error("任务内容不能为空，且不能超过 40000 字。");
    if (input.sourceCallId && (job.sourceCallId === input.sourceCallId || job.supplementSourceIds?.includes(input.sourceCallId))) return this.get(id);
    const stored = this.store.append(job.botId, {
      type: "user_text", channel: input.channel ?? "text", text: input.messageText ?? text,
      jobId: id, ...(input.attachments?.length ? { attachments: structuredClone(input.attachments) } : {}),
    });
    this.change(job, {
      supplementEventIds: [...(job.supplementEventIds ?? []), stored.id],
      ...(input.sourceCallId ? { supplementSourceIds: [...(job.supplementSourceIds ?? []), input.sourceCallId] } : {}),
      ...(input.sharedContext ? { sharedContext: structuredClone(input.sharedContext) } : {}),
    });
    return this.get(id);
  }

  updates(id: string): { events: import("./types.ts").StoredEvent[]; sharedContext?: TaskJob["sharedContext"] } {
    const job = this.get(id);
    const ids = new Set(job.supplementEventIds ?? []);
    return { events: this.store.getEvents(job.botId).filter(event => ids.has(event.id)), sharedContext: job.sharedContext };
  }

  list(botId?: string): TaskJob[] {
    return [...this.records.values()].filter(job => !botId || job.botId === botId).map(job => structuredClone(job));
  }

  get(id: string): TaskJob {
    const job = this.records.get(id);
    if (!job) throw new Error("找不到这个任务。");
    return structuredClone(job);
  }

  linkInput(id: string, eventId: number): void {
    const job = this.records.get(id);
    if (!job) throw new Error("找不到这个任务。");
    if (job.originEventId !== eventId) this.change(job, { originEventId: eventId });
  }

  busy(botId: string): boolean { return this.list(botId).some(job => job.status === "queued" || job.status === "running"); }

  wait(id: string): Promise<TaskJob> {
    const job = this.get(id);
    if (terminal.has(job.status)) return Promise.resolve(job);
    return new Promise(resolve => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  cancel(id: string): void {
    const job = this.get(id);
    if (terminal.has(job.status)) return;
    this.running.get(id)?.abort(new DOMException("任务已停止", "AbortError"));
    this.change(job, { status: "cancelled", activity: "" });
    this.pump();
  }

  retry(id: string): TaskJob {
    const job = this.get(id);
    if (this.removing.has(job.botId)) throw new Error("这个 Bot 正在删除。");
    if (!terminal.has(job.status) || job.status === "succeeded") throw new Error("只能重试未完成的任务。");
    this.records.delete(id);
    this.change(job, { status: "queued", error: "", activity: "", result: "", resultEventId: undefined, queuedAt: new Date().toISOString() });
    this.pump();
    return this.get(id);
  }

  shutdown(): void {
    this.stopped = true;
    for (const [id, controller] of this.running) {
      controller.abort(new DOMException("应用正在关闭", "AbortError"));
      this.change(this.get(id), { status: "interrupted", activity: "", error: "应用关闭时任务仍在进行。检查已有输出后，可手动重试。" });
    }
  }

  async prepareBotDeletion(botId: string): Promise<void> {
    this.removing.add(botId);
    for (const job of this.list(botId)) if (!terminal.has(job.status)) this.cancel(job.id);
    await Promise.all(this.list(botId).map(job => this.draining.get(job.id)));
  }

  forgetBot(botId: string): void {
    if (this.store.getBot(botId)) throw new Error("请先删除 Bot，再清理任务索引。");
    for (const job of this.list(botId)) this.records.delete(job.id);
  }

  private change(job: TaskJob, patch: Partial<TaskJob>): void {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.records.set(job.id, job);
    this.store.append(job.botId, { type: "job", job: { ...job, artifacts: [...job.artifacts] } });
    this.onChange({ ...job });
    if (terminal.has(job.status)) {
      for (const resolve of this.waiters.get(job.id) ?? []) resolve(this.get(job.id));
      this.waiters.delete(job.id);
    }
  }

  private pump(): void {
    if (this.stopped || !this.enabled) return;
    const occupied = new Set([...this.running.keys()].map(id => this.get(id).botId));
    for (const job of this.records.values()) {
      if (this.running.size >= this.concurrency) break;
      if (job.status !== "queued" || occupied.has(job.botId) || this.removing.has(job.botId)) continue;
      occupied.add(job.botId);
      const controller = new AbortController();
      this.running.set(job.id, controller);
      this.change(job, { status: "running", attempts: job.attempts + 1 });
      const done = this.run({ ...job }, controller.signal, activity => {
        if (!controller.signal.aborted && !this.stopped && activity !== job.activity) this.change(job, { activity: activity.slice(0, 240) });
      }).then(result => {
        if (!controller.signal.aborted && !this.stopped) this.change(job, { status: "succeeded", result: result.text, resultEventId: result.resultEventId, artifacts: result.artifacts ?? [], activity: "" });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && !this.stopped) this.change(job, { status: "failed", error: error instanceof Error ? error.message : String(error), activity: "" });
      }).finally(() => { this.running.delete(job.id); this.draining.delete(job.id); this.pump(); });
      this.draining.set(job.id, done);
    }
  }
}

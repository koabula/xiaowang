import type { StoredEvent, TaskJob } from "./types.ts";

export function isBackgroundJob(job: TaskJob): boolean {
  return (job.display ?? (job.channel === "text" ? "conversation" : "background")) === "background";
}

export function taskTitle(task: string): string {
  const first = task.split(/[\n。；;]/)[0]?.replace(/[，,]\s*(?:包含|包括|要求|涵盖|including\b|covering\b).*/i, '').trim() || task.trim();
  const title = first.replace(/^(?:请|麻烦|帮我|给我|你去|你先)\s*/u, "");
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

/** Old event logs stay intact; recover display metadata without treating chat as work. */
export function presentJob(job: TaskJob, events: StoredEvent[]): TaskJob {
  if (job.display && job.title && (job.resultEventId !== undefined || !job.result.trim())) return { ...job };
  const own = events.filter(stored => "jobId" in stored.event && stored.event.jobId === job.id);
  const input = own.find(stored => stored.event.type === "user_text")
    ?? events.find(stored => stored.createdAt >= job.createdAt && stored.event.type === "user_text" && stored.event.channel === job.channel && stored.event.text === job.task);
  const result = job.result.trim() ? own.findLast(stored => stored.event.type === "assistant_turn" && stored.event.toolCalls.length === 0 && stored.event.text.trim() === job.result.trim())
    ?? events.findLast(stored => stored.createdAt >= job.createdAt && stored.createdAt <= job.updatedAt && stored.event.type === "assistant_turn" && stored.event.toolCalls.length === 0 && stored.event.text.trim() === job.result.trim()) : undefined;
  const call = job.channel === "voice" ? events.find(stored => stored.event.type === "call" && stored.event.startedAt <= job.createdAt && stored.event.endedAt >= job.createdAt) : undefined;
  return { ...job,
    display: isBackgroundJob(job) ? "background" : "conversation",
    title: job.title || taskTitle(job.task),
    originEventId: job.originEventId ?? input?.id,
    resultEventId: job.resultEventId ?? result?.id,
    originCallId: job.originCallId ?? (call?.event.type === "call" ? call.event.callId || `legacy-call:${call.id}` : undefined),
  };
}

/** Attribute old background turns conservatively; explicit job IDs always win. */
export function backgroundTurnOwners(jobs: TaskJob[], events: StoredEvent[]): Map<number, string> {
  return taskTurnOwners(jobs.filter(isBackgroundJob), events);
}

/** Recover ownership only within a known task's input and lifetime. */
export function taskTurnOwners(jobs: TaskJob[], events: StoredEvent[]): Map<number, string> {
  const owners = new Map<number, string>();
  const results = new Map(jobs.filter(job => job.resultEventId !== undefined).map(job => [job.resultEventId, job.id]));
  const inputs = new Map(jobs.filter(job => job.originEventId !== undefined).map(job => [job.originEventId, job]));
  let input: StoredEvent | undefined;
  for (const stored of events) {
    const event = stored.event;
    if (event.type === "user_text") input = stored;
    if (event.type !== "assistant_turn") continue;
    if (event.jobId) { owners.set(stored.id, event.jobId); continue; }
    const result = results.get(stored.id);
    if (result) { owners.set(stored.id, result); continue; }
    const job = input && inputs.get(input.id);
    if (job && stored.createdAt >= job.createdAt && stored.createdAt <= job.updatedAt) owners.set(stored.id, job.id);
  }
  return owners;
}

/** Keep raw steps for model history; expose one successful answer per task. */
export function visibleAnswerIds(jobs: TaskJob[], events: StoredEvent[], owners: ReadonlyMap<number, string>): Set<number> {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const visible = new Set<number>();
  for (const stored of events) {
    const event = stored.event;
    if (event.type !== "assistant_turn" || !event.text.trim() || event.toolCalls.length) continue;
    const owner = event.jobId ?? owners.get(stored.id);
    const job = owner ? byId.get(owner) : undefined;
    if (!job || job.status === "succeeded" && job.resultEventId === stored.id) visible.add(stored.id);
  }
  return visible;
}

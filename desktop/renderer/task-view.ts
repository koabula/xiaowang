import type { TaskJob } from '../../src/types.ts';
import { isBackgroundJob } from '../../src/task-presentation.ts';

/** Voice work belongs only to its call, never to the latest text message. */
export function taskLayout(jobs: TaskJob[], items: Array<{ id: number; kind: string; jobId?: string }>) {
  const background = jobs.filter(isBackgroundJob);
  const callJobs = background.filter(job => job.channel === 'voice' || job.originCallId);
  const callJobIds = new Set(callJobs.map(job => job.id));
  const resultIds = new Set(callJobs.map(job => job.resultEventId).filter(id => id !== undefined));
  const hidden = new Set(items.filter(item => item.kind === 'assistant' && (callJobIds.has(item.jobId ?? '') || resultIds.has(item.id))).map(item => item.id));
  const byCall = new Map<string, TaskJob[]>();
  for (const job of callJobs) {
    if (job.originCallId) byCall.set(job.originCallId, [...(byCall.get(job.originCallId) ?? []), job]);
  }
  const ids = new Set(items.map(item => item.id));
  const chatIssues = new Map<number, TaskJob[]>();
  const pendingChatIssues: TaskJob[] = [];
  for (const job of jobs.filter(job => !isBackgroundJob(job) && ['failed', 'interrupted', 'cancelled'].includes(job.status))) {
    if (job.originEventId && ids.has(job.originEventId)) chatIssues.set(job.originEventId, [...(chatIssues.get(job.originEventId) ?? []), job]);
    else pendingChatIssues.push(job);
  }
  return { background, byCall, hidden, chatIssues, pendingChatIssues };
}

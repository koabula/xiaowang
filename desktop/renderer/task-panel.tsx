import { Check, Clock3, FileText, LoaderCircle, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TaskJob } from './types.ts';
import type { Locale } from './copy.ts';
import { RichText } from './rich-text.tsx';
import { isBackgroundJob, taskTitle } from '../../src/task-presentation.ts';

interface TaskProps {
  slug: string;
  locale: Locale;
  onError: (error: string) => void;
}

export function ConversationIssue({ job, locale, onError }: { job: TaskJob; locale: Locale; onError: (error: string) => void }) {
  const en = locale === 'en';
  async function retry() {
    try { await window.xiaowang.retryJob(job.id); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="conversation-issue" role={job.status === 'cancelled' ? 'status' : 'alert'}>
    <span>{job.error || (job.status === 'cancelled' ? en ? 'Reply stopped.' : '已停止回复。' : en ? 'Reply interrupted. You can retry.' : '回复已中断，可以重试。')}</span>
    <button type="button" onClick={() => void retry()}>{en ? 'Retry reply' : '重试回复'}</button>
  </div>;
}

export function TaskCard({ job, slug, locale, onError }: TaskProps & { job: TaskJob }) {
  const en = locale === 'en';
  const active = job.status === 'running' || job.status === 'queued';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, job.id]);
  const seconds = Math.max(0, Math.floor(((active ? now : Date.parse(job.updatedAt)) - Date.parse(job.queuedAt || job.createdAt)) / 1000));
  const duration = Number.isFinite(seconds) && (active || job.queuedAt) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  const labels = en ? { queued: 'Queued', running: 'In progress', succeeded: 'Completed', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' } : { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' };
  async function action(run: () => Promise<unknown>) { try { await run(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } }
  if (!isBackgroundJob(job)) return null;
  return <article className={`task-item ${job.status}${active ? '' : ' compact'}`} data-job-id={job.id} aria-label={job.title || taskTitle(job.task)}>
    <div className="task-item-heading">
      {job.status === 'running' ? <LoaderCircle className="spin" size={14} /> : job.status === 'succeeded' ? <Check size={14} /> : ['failed', 'interrupted'].includes(job.status) ? <TriangleAlert size={14} /> : <Clock3 size={14} />}
      <strong title={job.task.split('\n')[0]}>{job.title || taskTitle(job.task)}</strong>
      <span>{labels[job.status]}{duration ? ` · ${duration}` : ''}</span>
    </div>
    {active ? <p role="status">{job.activity || (job.status === 'queued' ? en ? 'Starts when the current work finishes.' : '当前工作完成后开始。' : en ? 'Working on your request…' : '正在处理你的请求…')}</p> : job.error && ['failed', 'interrupted'].includes(job.status) ? <p className="task-error">{job.error}</p> : null}
    <div className="task-item-footer">
      {[...new Set(job.artifacts)].map(file => <button className="task-artifact" type="button" key={file} title={file} onClick={() => void action(() => window.xiaowang.openArtifact(slug, file))}><FileText size={13} />{en ? 'Open' : '打开'} {file.split(/[\\/]/).at(-1)}</button>)}
      {active ? <button type="button" onClick={() => void action(() => window.xiaowang.cancelJob(job.id))}><Square size={12} />{en ? 'Stop' : '停止'}</button> : ['failed', 'interrupted', 'cancelled'].includes(job.status) ? <button type="button" onClick={() => void action(() => window.xiaowang.retryJob(job.id))}><RotateCcw size={12} />{en ? 'Retry' : '重试'}</button> : null}
    </div>
    {job.result.trim() ? <details className="call-task-result"><summary>{en ? 'View result' : '查看结果'}</summary><div className="prose"><RichText slug={slug} text={job.result} /></div></details> : null}
  </article>;
}

export function CallTasks({ jobs, ...props }: TaskProps & { jobs: TaskJob[] }) {
  if (!jobs.length) return null;
  return <section className="call-tasks" aria-label={props.locale === 'en' ? 'Work from this call' : '本次通话的工作'}>
    <h3>{props.locale === 'en' ? 'Work from this call' : '本次通话的工作'}</h3>
    {jobs.map(job => <TaskCard key={job.id} job={job} {...props} />)}
  </section>;
}

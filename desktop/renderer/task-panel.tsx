import { Check, ChevronDown, Clock3, FileText, LoaderCircle, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { TaskJob } from "./types.ts";
import type { Locale } from "./copy.ts";

export function TaskPanel({ jobs, locale, slug, onError }: { jobs: TaskJob[]; locale: Locale; slug: string; onError: (error: string) => void }) {
  const en = locale === "en";
  const [history, setHistory] = useState(false);
  if (!jobs.length) return null;
  const active = jobs.filter(job => ["queued", "running", "failed", "interrupted"].includes(job.status));
  const visible = history ? jobs.slice(-12).reverse() : active.slice(-4).reverse();
  const labels = en ? { queued: "Queued", running: "In progress", succeeded: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted" } : { queued: "排队中", running: "进行中", succeeded: "已完成", failed: "失败", cancelled: "已停止", interrupted: "待恢复" };
  async function action(run: () => Promise<unknown>) { try { await run(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } }
  return <section className="task-panel" aria-label={en ? "Background tasks" : "后台任务"}>
    <button className="task-panel-toggle" type="button" aria-expanded={history} onClick={() => setHistory(!history)}><Clock3 size={14} /><span>{en ? "Background tasks" : "后台任务"}</span><span>{active.length ? `${active.length} ${en ? "active" : "待处理"}` : en ? "View results" : "查看结果"}</span><ChevronDown size={14} /></button>
    {visible.map(job => <article key={job.id} className={`task-item ${job.status}`}>
      <div className="task-item-heading">{job.status === "running" ? <LoaderCircle className="spin" size={15} /> : job.status === "succeeded" ? <Check size={15} /> : ["failed", "interrupted"].includes(job.status) ? <TriangleAlert size={15} /> : <Clock3 size={15} />}<strong>{job.task.split("\n")[0]}</strong><span>{labels[job.status]}</span></div>
      <p>{job.error || job.activity || (job.status === "queued" ? en ? "Starts when this workspace is free." : "当前工作完成后自动开始。" : job.notify === "when_idle" && job.status === "running" ? en ? "Will report at the next pause." : "完成后会在合适的间隙提醒。" : "")}</p>
      {job.status === "succeeded" && job.result ? <details><summary>{en ? "Result" : "查看结果"}</summary><p className="task-result">{job.result}</p></details> : null}
      {job.artifacts.map(path => <button type="button" className="task-artifact" key={path} onClick={() => void action(() => window.xiaowang.openArtifact(slug, path))}><FileText size={13} />{path}</button>)}
      <div className="task-item-actions">{["queued", "running"].includes(job.status) ? <button type="button" onClick={() => void action(() => window.xiaowang.cancelJob(job.id))}><Square size={12} />{en ? "Stop" : "停止"}</button> : ["failed", "interrupted", "cancelled"].includes(job.status) ? <button type="button" onClick={() => void action(() => window.xiaowang.retryJob(job.id))}><RotateCcw size={12} />{en ? "Retry" : "重试"}</button> : null}</div>
    </article>)}
  </section>;
}

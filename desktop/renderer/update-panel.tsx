import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { UpdateState } from "../main/update-state.ts";

export function updateDescription(update: UpdateState, en: boolean): string {
  const waiting = (update.waitingFor ?? []).map(reason => ({ call: en ? "the current call" : "当前通话结束", jobs: en ? "background work" : "后台工作完成", settings: en ? "unsaved settings" : "设置更改保存或放弃" })[reason as "call" | "jobs" | "settings"]).filter(Boolean);
  if (update.phase === "checking") return en ? "Checking for updates…" : "正在检查更新…";
  if (update.phase === "downloading") return `${en ? "Downloading update" : "正在下载更新"} ${Math.round(update.percent ?? 0)}%`;
  if (update.phase === "verifying") return en ? "Verifying the download…" : "正在校验更新文件…";
  if (update.phase === "installing") return en ? "Preparing and installing; the app will restart." : "正在准备并安装更新，完成后自动重启。";
  if (update.phase === "ready") return waiting.length ? `${en ? "Downloaded; waiting for " : "下载已完成，等待"}${waiting.join(en ? ", " : "、")}${en ? "." : "后自动安装。"}` : en ? "Downloaded; installs when idle and settings are saved." : "下载已完成，通话、后台工作和未保存设置处理完毕后自动安装。";
  if (update.phase === "error") return update.error || (en ? "Update failed. Please retry." : "更新失败，请重试。");
  if (update.version) return `${en ? "Update available" : "发现新版本"} v${update.version}`;
  return update.lastCheckedAt ? en ? "You’re up to date." : "已是最新版本。" : en ? "No update check yet." : "尚未检查更新。";
}
export function UpdateCheckButton({ update, en, onResult }: { update?: UpdateState; en: boolean; onResult: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const locked = !update || busy || ["checking", "downloading", "verifying", "ready", "installing"].includes(update.phase);
  async function check() {
    setBusy(true);
    try { const next = await window.xiaowang.checkUpdate(); onResult(updateDescription(next, en)); }
    catch (error) { onResult(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const checked = update?.lastCheckedAt ? `${en ? "Last checked: " : "上次检查："}${new Date(update.lastCheckedAt).toLocaleString(en ? "en" : "zh-CN")}` : "";
  return <button type="button" className="update-check" disabled={locked} title={checked} onClick={() => void check()}><RefreshCw className={busy || update?.phase === "checking" ? "spin" : ""} size={13} />{en ? "Check for updates" : "检查更新"}</button>;
}
export function UpdateProgress({ update, en }: { update?: UpdateState; en: boolean }) {
  const [error, setError] = useState("");
  if (!update || ["idle", "checking"].includes(update.phase)) return null;
  const locked = ["downloading", "verifying", "ready", "installing"].includes(update.phase);
  const progress = ["downloading", "verifying", "ready", "installing"].includes(update.phase);
  async function download() {
    setError("");
    try { await window.xiaowang.updateApp(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  const bytes = (value: number) => `${(value / 1048576).toFixed(1)} MB`;
  return <section className="update-progress" aria-label={en ? "App updates" : "应用更新"}>
    <div className="update-progress-row"><p role="status">{updateDescription(update, en)}</p>{update.version && !locked ? <button type="button" className="update-download" onClick={() => void download()}><Download size={14} />{update.phase === "error" ? en ? "Retry update" : "重试更新" : `${en ? "Download and install" : "下载并安装"} v${update.version}`}</button> : null}</div>
    {progress ? <progress aria-label={en ? "Update progress" : "更新进度"} max={100} value={update.phase === "downloading" ? update.percent ?? 0 : update.phase === "ready" ? 100 : undefined} /> : null}
    {update.phase === "downloading" && update.total ? <small>{bytes(update.transferred ?? 0)} / {bytes(update.total)}{update.bytesPerSecond ? ` · ${bytes(update.bytesPerSecond)}/s` : ""}</small> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2 } from "lucide-react";
import { ModalDialog } from "./modal-dialog.tsx";
import type { BotRow } from "./types.ts";

export interface BotMenuTarget { bot: BotRow; x: number; y: number; trigger: HTMLButtonElement }

export function BotMenu({ target, locale, activeSlug, onClose, onDeleted }: {
  target: BotMenuTarget; locale: "zh" | "en"; activeSlug: string; onClose(): void; onDeleted(slug: string): void;
}) {
  const en = locale === "en";
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(target.bot.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const previousSlug = useRef(activeSlug);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (activeSlug !== previousSlug.current && !saving) close.current();
    previousSlug.current = activeSlug;
  }, [activeSlug, saving]);
  useLayoutEffect(() => () => { if (target.trigger.isConnected) target.trigger.focus(); }, [target]);
  useLayoutEffect(() => {
    if (action) { input.current?.select(); return; }
    const node = menu.current; if (!node) return;
    const place = () => {
      node.style.left = `${Math.max(8, Math.min(target.x, innerWidth - node.offsetWidth - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(target.y, innerHeight - node.offsetHeight - 8))}px`;
    };
    place(); node.querySelector<HTMLButtonElement>("button")?.focus();
    const ac = new AbortController();
    window.addEventListener("resize", () => close.current(), { signal: ac.signal });
    document.addEventListener("pointerdown", event => { if (!node.contains(event.target as Node)) close.current(); }, { signal: ac.signal, capture: true });
    document.addEventListener("scroll", event => { if (!node.contains(event.target as Node)) close.current(); }, { signal: ac.signal, capture: true });
    return () => ac.abort();
  }, [target, action]);
  async function save() {
    if (saving || (action === "rename" && !name.trim())) return;
    setSaving(true); setError("");
    try {
      if (action === "rename") await window.xiaowang.renameBot(target.bot.slug, name.trim());
      else { await window.xiaowang.deleteBot(target.bot.slug); onDeleted(target.bot.slug); }
      onClose();
    } catch (reason) {
      setError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error: /, ""));
      setSaving(false);
    }
  }
  const title = action === "rename" ? (en ? "Rename bot" : "重命名 Bot") : (en ? "Delete bot?" : "删除 Bot？");
  return createPortal(action ? <ModalDialog className="bot-action-dialog" label={title} onCancel={() => { if (!saving) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>{title}</h2>
      {action === "rename" ? <label>{en ? "Name" : "名称"}<input ref={input} autoFocus maxLength={80} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label> : <p>{en ? `“${target.bot.name}” will be removed from the app. Its calls and tasks will stop. Local history and files will remain on disk.` : `删除后将无法在应用中访问“${target.bot.name}”，其通话和任务会停止。本机历史记录与资料文件会保留。`}</p>}
      {error ? <p role="alert" className="action-error">{error}</p> : null}
      <div className="bot-action-buttons"><button type="button" disabled={saving} onClick={onClose}>{en ? "Cancel" : "取消"}</button><button type="submit" className={action === "delete" ? "danger" : "primary"} disabled={saving || (action === "rename" && !name.trim())}>{saving ? (en ? "Please wait…" : "正在处理…") : action === "rename" ? (en ? "Save" : "保存") : (en ? "Delete" : "删除")}</button></div>
    </form>
  </ModalDialog> : <div ref={menu} className="bot-context-menu" role="menu" aria-label={en ? "Bot actions" : "Bot 操作"} onKeyDown={event => {
    if (["Escape", "Tab"].includes(event.key)) { event.preventDefault(); onClose(); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>
    <button type="button" role="menuitem" onClick={() => setAction("rename")}><Pencil size={17} />{en ? "Rename" : "重命名"}</button>
    <div className="menu-divider" />
    <button type="button" role="menuitem" className="danger" disabled={target.bot.slug === "xiaowang"} title={target.bot.slug === "xiaowang" ? (en ? "The main assistant cannot be deleted" : "主助手不能删除") : undefined} onClick={() => setAction("delete")}><Trash2 size={17} />{en ? "Delete" : "删除"}</button>
  </div>, document.body);
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Plus, Square } from "lucide-react";
import type { Attachment } from "../../src/types.ts";
import { ATTACHMENT_ACCEPT, ATTACHMENT_BYTES, ATTACHMENT_COUNT, ATTACHMENT_TOTAL_BYTES } from "../../src/attachment-limits.ts";
import { AttachmentChip } from "./message-attachments.tsx";

interface Pending { id: number; name: string; bytes: number; attachment?: Attachment; error?: string }
export function MessageComposer({ slug, draft, placeholder, busy, inCall, ink, en, onDraft, onSend, onStop, onCall, onError }: {
  slug: string; draft: string; placeholder: string; busy: boolean; inCall: boolean; ink: string; en: boolean;
  onDraft: (text: string) => void; onSend: (attachments: Attachment[]) => Promise<boolean>; onStop: () => void; onCall: () => void; onError: (message: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null);
  const [byBot, setByBot] = useState<Record<string, Pending[]>>({});
  const pending = useRef<Record<string, Pending[]>>({}), sequence = useRef(0), sending = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pasteTimer.current), []);
  const files = byBot[slug] ?? [];
  const uploading = files.some(file => !file.attachment && !file.error);
  const ready = files.filter(file => file.attachment).map(file => file.attachment!);
  useLayoutEffect(() => {
    const node = textarea.current; if (!node) return;
    const resize = () => { node.style.height = "0px"; node.style.height = `${Math.min(144, Math.max(38, node.scrollHeight))}px`; };
    resize(); const observer = new ResizeObserver(resize); observer.observe(node.parentElement!);
    return () => observer.disconnect();
  }, [draft, slug]);
  function change(owner: string, transform: (value: Pending[]) => Pending[]) {
    const next = transform(pending.current[owner] ?? []); pending.current = { ...pending.current, [owner]: next };
    setByBot(previous => ({ ...previous, [owner]: next }));
  }
  function add(input: File[]) {
    const owner = slug;
    const old = pending.current[owner] ?? [];
    if (old.length + input.length > ATTACHMENT_COUNT || input.some(f => f.size > ATTACHMENT_BYTES) || old.reduce((n,f) => n + f.bytes, 0) + input.reduce((n,f) => n + f.size, 0) > ATTACHMENT_TOTAL_BYTES) { onError(en ? "Up to 8 files, 20 MB each and 40 MB total." : "每条消息最多 8 个附件，单个不超过 20 MB，合计不超过 40 MB。"); return; }
    const entries = input.map(file => ({ id: ++sequence.current, name: file.name, bytes: file.size }));
    change(owner, value => [...value, ...entries]);
    input.forEach((file, index) => {
      const entry = entries[index]!;
      void file.arrayBuffer().then(bytes => window.xiaowang.attach(owner, file.name, new Uint8Array(bytes))).then(attachment => {
        change(owner, value => value.some(f => f.id !== entry.id && f.attachment?.refId === attachment.refId) ? value.filter(f => f.id !== entry.id) : value.map(f => f.id === entry.id ? { ...f, attachment } : f));
      }).catch(error => { change(owner, value => value.map(f => f.id === entry.id ? { ...f, error: String(error).replace(/^Error: /, "") } : f)); });
    });
  }
  function pasteNative(owner: string) {
    if ((pending.current[owner]?.length ?? 0) >= ATTACHMENT_COUNT) { onError(en ? "Up to 8 attachments per message." : "每条消息最多 8 个附件。"); return; }
    const id = ++sequence.current;
    change(owner, value => [...value, { id, name: en ? "Image" : "图片", bytes: 0 }]);
    void window.xiaowang.pasteImage(owner).then(attachment => {
      change(owner, value => {
        if (!attachment || value.some(f => f.id !== id && f.attachment?.refId === attachment.refId)) return value.filter(f => f.id !== id);
        if (value.reduce((n, f) => n + f.bytes, 0) + attachment.byteSize > ATTACHMENT_TOTAL_BYTES) return value.map(f => f.id === id ? { ...f, error: en ? "Attachments exceed 40 MB." : "附件合计超过 40 MB。" } : f);
        return value.map(f => f.id === id ? { ...f, name: attachment.filename, bytes: attachment.byteSize, attachment } : f);
      });
    }).catch(error => change(owner, value => value.map(f => f.id === id ? { ...f, error: String(error) } : f)));
  }
  async function send() {
    const owner = slug;
    if (uploading || files.some(f => f.error) || (!draft.trim() && !ready.length) || sending.current.has(owner)) return;
    sending.current.add(owner);
    const sent = files;
    change(owner, () => []);
    try {
      const operation = onSend(ready);
      queueMicrotask(() => sending.current.delete(owner));
      if (!await operation) change(owner, value => [...sent, ...value]);
    }
    finally { sending.current.delete(owner); }
  }
  return <form className={`composer${dragging ? " dragging" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); add(Array.from(event.dataTransfer.files)); } }}
    onPaste={event => { clearTimeout(pasteTimer.current); const images = Array.from(event.clipboardData.files); const text = event.clipboardData.getData("text/plain"); if (!images.length) { if (!text) { event.preventDefault(); pasteNative(slug); } return; } event.preventDefault(); add(images); if (text) { const node = textarea.current; onDraft(draft.slice(0, node?.selectionStart ?? draft.length) + text + draft.slice(node?.selectionEnd ?? draft.length)); } }}>
    {files.length ? <div className="pending-attachments" aria-label={en ? "Pending attachments" : "待发送附件"}>{files.map(file => file.attachment ? <AttachmentChip key={file.id} slug={slug} attachment={file.attachment} onRemove={() => change(slug, value => value.filter(f => f.id !== file.id))} /> : <div className={`attachment-chip${file.error ? " failed" : ""}`} key={file.id}>{file.error ? <span role="alert">{file.name}<small>{file.error}</small></span> : <><LoaderCircle className="spin" size={16} /><span>{file.name}<small>{en ? "Importing…" : "正在添加…"}</small></span></>}<button className="icon" type="button" aria-label={`移除 ${file.name}`} onClick={() => change(slug, value => value.filter(f => f.id !== file.id))}>×</button></div>)}</div> : null}
    <div className="composer-row">
      <input ref={picker} className="attachment-picker" type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label={en ? "Choose attachments" : "选择附件"} onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <button className="icon" type="button" title={en ? "Add attachments" : "添加附件"} aria-label={en ? "Add attachments" : "添加附件"} onClick={() => picker.current?.click()}><Plus size={18} /></button>
      <textarea ref={textarea} rows={1} value={draft} placeholder={placeholder} onChange={event => onDraft(event.target.value)} onKeyDown={event => {
        if (event.key.toLowerCase() === "v" && (event.metaKey || event.ctrlKey) && !event.shiftKey) { clearTimeout(pasteTimer.current); const owner = slug; pasteTimer.current = setTimeout(() => pasteNative(owner), 200); }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} />
      {busy ? <button className="call stop" type="button" title={en ? "Stop" : "停止"} onClick={onStop}><Square size={14} /></button> : null}
      {draft.trim() || files.length ? <button className="call send-message" type="submit" aria-label={en ? "Send message" : "发送消息"} title={en ? "Send message" : "发送消息"} disabled={uploading || files.some(f => f.error)} style={{ background: ink }}><ArrowUp size={18} /></button> : !inCall ? <button className="call" style={{ background: ink }} type="button" title={en ? "Call" : "通话"} aria-label={en ? "Call" : "通话"} onClick={onCall}><span /><span /><span /><span /></button> : null}
    </div>
  </form>;
}

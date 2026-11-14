import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Clock, File, FileCode2, FileText, Folder, FolderOpen, Library, Search, X } from "lucide-react";
import type { BrowseOptions, FileEntry } from "../../src/file-browser.ts";
import { ModalDialog } from "./modal-dialog.tsx";
import type { Locale } from "./copy.ts";

const recentKey = (slug: string) => `xiaowang.recentFiles:${slug}`;
function recentFiles(slug: string): string[] { try { const saved: unknown = JSON.parse(localStorage.getItem(recentKey(slug)) || "[]"); return Array.isArray(saved) ? saved.filter(item => typeof item === "string").slice(0, 40) : []; } catch { return []; } }
export function rememberOpenedFile(slug: string, key: string): void { try { localStorage.setItem(recentKey(slug), JSON.stringify([key, ...recentFiles(slug).filter(item => item !== key)].slice(0,40))); } catch { /* Recent files are optional. */ } }
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1024/1024).toFixed(1)} MB`;
const iconFor = (entry: FileEntry, pixels=18) => entry.kind === "folder" ? <Folder size={pixels} /> : entry.preview === "canvas" ? <FileCode2 size={pixels} /> : entry.preview === "file" ? <FileText size={pixels} /> : <File size={pixels} />;

export function FileBrowser({ slug, name, mode, locale, onClose, onOpen }: { slug: string; name: string; mode: "file" | "canvas"; locale: Locale; onClose(): void; onOpen(entry: FileEntry): Promise<void> }) {
  const en = locale === "en"; const [location, setLocation] = useState<BrowseOptions["source"] | "recent">("all");
  const [directory, setDirectory] = useState("."); const [query, setQuery] = useState(""); const [needle, setNeedle] = useState("");
  const [type, setType] = useState<"all" | "canvas">(mode === "canvas" ? "canvas" : "all"); const [sort, setSort] = useState<BrowseOptions["sort"]>("name");
  const [entries, setEntries] = useState<FileEntry[]>([]); const [total, setTotal] = useState(0); const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true); const [opening, setOpening] = useState(false); const [error, setError] = useState("");
  const [selected, setSelected] = useState<FileEntry | null>(null); const [offset, setOffset] = useState(0);
  useEffect(() => { const timer = setTimeout(() => setNeedle(query.trim()), 180); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { setOffset(0); setSelected(null); setEntries([]); }, [location, directory, needle, type, sort]);
  useEffect(() => {
    let stopped = false; setLoading(true); setError("");
    void window.xiaowang.browseFiles(slug, { source: location === "recent" ? "all" : location, path: directory, query: needle, type, sort, offset, ...(location === "recent" ? { recentKeys: recentFiles(slug) } : {}) }).then(result => {
      if (stopped) return; setEntries(previous => offset ? [...previous.filter(old => !result.entries.some(item => item.key === old.key)), ...result.entries] : result.entries); setTotal(result.total); setTruncated(result.truncated); setLoading(false);
    }).catch(reason => { if (!stopped) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } });
    return () => { stopped = true; };
  }, [slug, location, directory, needle, type, sort, offset]);
  function changeLocation(next: typeof location) { setLocation(next); setDirectory("."); setQuery(""); }
  function enter(path: string) { setLocation("workspace"); setDirectory(path); setQuery(""); }
  async function open(entry: FileEntry) {
    if (entry.kind === "folder") { enter(entry.path); return; }
    if (entry.preview === "unsupported" || opening) return;
    setOpening(true); setError("");
    try { await onOpen(entry); rememberOpenedFile(slug, entry.key); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setOpening(false); }
  }
  const crumbs = directory === "." ? [] : directory.split("/");
  const sourceName = (entry: FileEntry) => entry.source === "library" ? (en ? "Imported original" : "导入原件") : (en ? "Workspace" : "工作区");
  return <ModalDialog className="file-browser-dialog" label={en ? "Browse bot files" : "浏览任务资料"} onCancel={onClose}>
    <header className="file-browser-header"><div><strong>{en ? "Files" : "资料库"}</strong><span>{name}</span></div><button type="button" aria-label={en ? "Close file browser" : "关闭资料浏览器"} onClick={onClose}><X size={18} /></button></header>
    <div className="file-browser-body"><nav aria-label={en ? "File locations" : "资料位置"}>
      {([{value:"all",label:en?"All files":"全部资料",icon:<FolderOpen size={17}/>},{value:"library",label:en?"Imported originals":"导入原件",icon:<Library size={17}/>},{value:"workspace",label:en?"Workspace":"工作区文件",icon:<Folder size={17}/>},{value:"recent",label:en?"Recent":"最近打开",icon:<Clock size={17}/>} ] as const).map(item=><button type="button" key={item.value} className={location===item.value?"on":""} onClick={()=>changeLocation(item.value)}>{item.icon}{item.label}</button>)}
    </nav><div className="file-browser-main"><div className="file-browser-tools"><button type="button" aria-label={en?"Parent folder":"上级目录"} disabled={directory==="."} onClick={()=>enter(crumbs.slice(0,-1).join("/")||".")}><ArrowLeft size={16}/></button><div className="file-breadcrumb"><button type="button" onClick={()=>changeLocation(location=== "workspace" ? "workspace" : "all")}>{location==="library"?(en?"Originals":"原件"):location==="recent"?(en?"Recent":"最近"):name}</button>{crumbs.map((part,index)=><span key={index}><ChevronRight size={12}/><button type="button" onClick={()=>enter(crumbs.slice(0,index+1).join("/"))}>{part}</button></span>)}</div><select aria-label={en?"File type":"文件类型"} value={type} onChange={event=>setType(event.target.value as typeof type)}><option value="all">{en?"All types":"全部类型"}</option><option value="canvas">Canvas / HTML</option></select></div>
      <label className="file-browser-search"><Search size={16}/><input autoFocus aria-label={en?"Search bot files":"搜索任务资料"} value={query} onChange={event=>setQuery(event.target.value)} placeholder={en?"Search names and paths…":"搜索文件名或路径…"}/>{query?<button type="button" aria-label={en?"Clear search":"清除搜索"} onClick={()=>setQuery("")}><X size={14}/></button>:null}</label>
      <div className="file-browser-list" aria-busy={loading || query.trim() !== needle}><table className="file-table"><thead><tr><th><button type="button" onClick={()=>setSort("name")}>{en?"Name":"名称"}{sort==="name"?" ↓":""}</button></th><th>{en?"Location":"位置"}</th><th><button type="button" onClick={()=>setSort("size")}>{en?"Size":"大小"}{sort==="size"?" ↓":""}</button></th><th><button type="button" onClick={()=>setSort("modified")}>{en?"Modified":"修改时间"}{sort==="modified"?" ↓":""}</button></th></tr></thead><tbody>{entries.map(entry=><tr key={entry.key} tabIndex={0} aria-selected={selected?.key===entry.key} onFocus={()=>setSelected(entry)} onClick={()=>setSelected(entry)} onDoubleClick={()=>void open(entry)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void open(entry);}else if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const next=event.key==="ArrowDown"?event.currentTarget.nextElementSibling:event.currentTarget.previousElementSibling;(next as HTMLElement|null)?.focus();}}}><td><span>{iconFor(entry)}<span>{entry.name}<small>{needle?entry.path:""}</small></span></span></td><td>{sourceName(entry)}</td><td>{entry.kind==="folder"?"—":size(entry.byteSize)}</td><td>{new Date(entry.modifiedAt).toLocaleDateString(en?"en-US":"zh-CN")}</td></tr>)}</tbody></table>{!entries.length?<p className="file-browser-empty">{loading?(en?"Loading…":"正在载入…"):needle?(en?"No matching files":"没有找到匹配的资料"):location==="recent"?(en?"Opened files appear here":"打开过的资料会出现在这里"):en?"This folder is empty":"这里还没有资料"}</p>:null}{entries.length<total?<button className="file-load-more" type="button" disabled={loading} onClick={()=>setOffset(entries.length)}>{en?"Show more":"显示更多"}</button>:null}</div>
    </div><aside className="file-details">{selected?<>{iconFor(selected,56)}<strong>{selected.name}</strong><span>{sourceName(selected)}</span><dl><dt>{en?"Path":"路径"}</dt><dd>{selected.path}</dd><dt>{en?"Size":"大小"}</dt><dd>{selected.kind==="folder"?(en?"Folder":"文件夹"):size(selected.byteSize)}</dd><dt>{en?"Modified":"修改时间"}</dt><dd>{new Date(selected.modifiedAt).toLocaleString(en?"en-US":"zh-CN")}</dd></dl>{selected.preview==="unsupported"&&selected.kind!=="folder"?<p>{en?"This format is listed but cannot be previewed yet.":"可以查看文件信息，暂不支持预览此格式。"}</p>:<p>{en?"Double-click or press Enter to open.":"双击或按 Enter 打开。"}</p>}</>:<><FolderOpen size={56}/><p>{en?"Select a file to see its details.":"选择资料，查看文件信息。"}</p></>}</aside></div>
    <footer className="file-browser-footer"><span role="status">{error || (truncated?(en?"Search limited to 10,000 entries; narrow the folder or query.":"搜索已达到一万项，请缩小目录或关键词。"):`${total} ${en?"items":"项"}`)}</span><button type="button" onClick={onClose}>{en?"Cancel":"取消"}</button><button className="primary" type="button" disabled={!selected||opening||(selected.kind!=="folder"&&selected.preview==="unsupported")} onClick={()=>selected&&void open(selected)}>{opening?(en?"Opening…":"正在打开…"):selected?.kind==="folder"?(en?"Open folder":"打开文件夹"):en?"Open":"打开"}</button></footer>
  </ModalDialog>;
}

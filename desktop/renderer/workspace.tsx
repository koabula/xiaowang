import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, ArrowRight, ChevronDown, FileText, Frame, Globe, Maximize2, Minimize2, Plus, UserRound, X } from "lucide-react";
import { withCanvasPager } from "./canvas-pager.ts";
import type { Copy, Locale } from "./copy.ts";
import type { CanvasPage, LibraryItem } from "./types.ts";

const DocumentReader = lazy(() => import("./document-reader.tsx").then(module => ({ default: module.DocumentReader })));

export interface StageSnap {
  mode: "file" | "browser" | "canvas" | "profile";
  open: boolean;
  file: { id: string; filename: string; page: number; requestId?: string; restore?: boolean } | null;
  canvas: { title: string; html: string; page: number; requestId?: string; restore?: boolean } | null;
}
export interface ResourceTab {
  key: string;
  kind: StageSnap["mode"];
  label: string;
  path: string;
  closable: boolean;
}

export function workspaceResources(
  stage: StageSnap,
  library: LibraryItem[],
  pages: CanvasPage[],
  files: string[],
  paths: string[],
  copy: Copy,
  browserTitle: string,
  profileName: string,
): ResourceTab[] {
  const byId = new Map(library.map(item => [item.id, item.filename]));
  if (stage.file) byId.set(stage.file.id, stage.file.filename);
  const fileIds = [...new Set([...files, ...(stage.file ? [stage.file.id] : [])])];
  const canvasPaths = [...new Set([...paths, ...(stage.canvas ? [stage.canvas.title] : [])])];
  const resources: ResourceTab[] = fileIds.filter(id => byId.has(id)).map(id => ({
    key: `file:${id}`, kind: "file", label: byId.get(id)!, path: id, closable: true,
  }));
  if (!resources.length) resources.push({ key: "file:", kind: "file", label: copy.files, path: "", closable: false });
  for (const path of canvasPaths) {
    const label = pages.find(item => item.path === path)?.name || path.split(/[\\/]/).pop() || path;
    resources.push({ key: `canvas:${path}`, kind: "canvas", label, path, closable: true });
  }
  if (!canvasPaths.length) resources.push({ key: "canvas:", kind: "canvas", label: copy.canvas, path: "", closable: false });
  resources.push({ key: "browser", kind: "browser", label: browserTitle || copy.browser, path: "", closable: false });
  if (stage.mode === "profile") resources.push({ key: "profile", kind: "profile", label: profileName, path: "", closable: true });
  return resources;
}

const resourceIcon = { file: FileText, canvas: Frame, browser: Globe, profile: UserRound };
export function Workspace({ stage, resources, copy, locale, wide, onWide, onSelect, onClose, onBrowse, onMenuOpen, children }: {
  stage: StageSnap; resources: ResourceTab[]; copy: Copy; locale: Locale; wide: boolean;
  onWide(): void; onSelect(resource: ResourceTab): void; onClose(resource: ResourceTab): void;
  onBrowse(mode: "file" | "canvas"): void; onMenuOpen(open: boolean): void; children: ReactNode;
}) {
  const activeKey = stage.mode === "file" ? `file:${stage.file?.id ?? ""}` : stage.mode === "canvas" ? `canvas:${stage.canvas?.title ?? ""}` : stage.mode;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    let frame = 0;
    const reveal = () => {
      const selected = node.querySelector<HTMLElement>('[data-state="active"]')?.parentElement;
      if (!selected) return;
      const tabBounds = selected.getBoundingClientRect();
      const listBounds = node.getBoundingClientRect();
      node.scrollTo({
        left: node.scrollLeft + tabBounds.left - listBounds.left - (node.clientWidth - tabBounds.width) / 2,
        behavior: "instant",
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [activeKey, resources.length, wide]);
  function close(resource: ResourceTab) {
    onClose(resource);
    if (resource.key === activeKey) {
      const remaining = resources.filter(item => item.key !== resource.key);
      const next = remaining[Math.max(0, resources.indexOf(resource) - 1)] ?? remaining[0];
      if (next) onSelect(next);
    }
  }
  function select(key: string) {
    const resource = resources.find(item => item.key === key);
    if (resource) onSelect(resource);
  }
  return <Tabs.Root className="workspace" value={activeKey} onValueChange={select}>
    <header className="workspace-header">
      <Tabs.List ref={list} className="resource-tabs" aria-label={locale === "en" ? "Open resources" : "打开的资源"}>
        {resources.map(resource => {
          const Icon = resourceIcon[resource.kind];
          return <span className="resource-tab" key={resource.key}>
            <Tabs.Trigger value={resource.key} className="resource-trigger" title={resource.label} aria-label={resource.kind === "browser" ? copy.browser : resource.label}><Icon size={15} /><span>{resource.label}</span></Tabs.Trigger>
            {resource.closable ? <button type="button" className="resource-close" aria-label={`${copy.closeTab} ${resource.label}`} onClick={() => close(resource)}><X size={12} /></button> : null}
          </span>;
        })}
      </Tabs.List>
      <div className="resource-actions">
        <button className="icon open-add" type="button" title={copy.openFromLibrary} aria-label={copy.openFromLibrary} onClick={() => onBrowse(stage.mode === "canvas" ? "canvas" : "file")}><Plus size={16} /></button>
        <DropdownMenu.Root onOpenChange={onMenuOpen}>
          <DropdownMenu.Trigger className="icon" aria-label={locale === "en" ? "Resource list" : "资源列表"} title={locale === "en" ? "Resource list" : "资源列表"}><ChevronDown size={16} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="resource-menu" sideOffset={5} align="end" collisionPadding={8}>
              {resources.map(resource => {
                const Icon = resourceIcon[resource.kind];
                return <DropdownMenu.Item className="menu-item" key={resource.key} onSelect={() => onSelect(resource)}><Icon size={15} /><span>{resource.label}</span></DropdownMenu.Item>;
              })}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item" onSelect={() => onBrowse("file")}><Plus size={15} />{copy.openFromLibrary}</DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => onBrowse("canvas")}><Frame size={15} />{copy.canvas}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button className="icon workspace-expand" type="button" aria-label={locale === "en" ? wide ? "Restore workspace" : "Expand workspace" : wide ? "还原阅读区" : "展开阅读区"} onClick={onWide}>{wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      </div>
    </header>
    <Tabs.Content className="workspace-content" value={activeKey}>{children}</Tabs.Content>
  </Tabs.Root>;
}

export function FileStage({ slug, file, locale, visualCallId, copy }: {
  slug: string; file: StageSnap["file"]; locale: Locale; visualCallId?: string; copy: Copy;
}) {
  return <div className="file-stage">{file && slug ? <Suspense fallback={<p className="empty">Loading…</p>}><DocumentReader slug={slug} file={file} locale={locale} visualCallId={visualCallId} /></Suspense> : <p className="empty">{copy.pickFile}</p>}</div>;
}

export function CanvasStage({ slug, canvas, copy }: { slug: string; canvas: StageSnap["canvas"]; copy: Copy }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState(canvas?.page ?? 1);
  const [totalPages, setTotalPages] = useState(0);
  const [pageError, setPageError] = useState("");
  useEffect(() => { setPage(canvas?.page ?? 1); setPageError(""); }, [canvas]);
  useEffect(() => { setTotalPages(0); }, [canvas?.title, canvas?.html]);
  useEffect(() => {
    if (!canvas) return;
    const listener = (event: MessageEvent) => {
      if (event.source === frameRef.current?.contentWindow && event.data?.type === "xiaowang:ready") {
        frameRef.current?.contentWindow?.postMessage({ type: "xiaowang:page", page: canvas.page, requestId: canvas.requestId }, "*");
        return;
      }
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== "xiaowang:position") return;
      const data = event.data as { page: number; totalPages: number; title?: string; requestId?: string; error?: string };
      if (!Number.isSafeInteger(data.page) || !Number.isSafeInteger(data.totalPages) || data.totalPages < 1) return;
      setTotalPages(data.totalPages); setPageError(data.error || "");
      if (!data.error && data.page >= 1 && data.page <= data.totalPages) {
        setPage(data.page);
        void window.xiaowang.stagePosition(slug, { path: canvas.title, page: data.page, totalPages: data.totalPages, mode: "canvas" });
      }
      if (data.requestId && data.requestId === canvas.requestId) void window.xiaowang.stageAck(slug, data.requestId, data);
    };
    window.addEventListener("message", listener); return () => window.removeEventListener("message", listener);
  }, [slug, canvas?.title, canvas?.requestId]);
  useEffect(() => {
    if (canvas) frameRef.current?.contentWindow?.postMessage({ type: "xiaowang:page", page, requestId: canvas.requestId }, "*");
  }, [canvas?.title, canvas?.html, canvas?.requestId, page]);
  return <div className="canvas-stage">
    {canvas ? <div className="reader-toolbar"><div className="reader-pager"><button type="button" aria-label="Previous page / 上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ArrowLeft size={15} /></button><span>{page} / {totalPages || "…"}</span><button type="button" aria-label="Next page / 下一页" disabled={!totalPages || page >= totalPages} onClick={() => setPage(page + 1)}><ArrowRight size={15} /></button></div></div> : null}
    {pageError ? <p className="reader-error" role="alert">{pageError}</p> : null}
    {canvas && slug ? <iframe key={canvas.title} ref={frameRef} className="canvas-frame" title={canvas.title} sandbox="allow-scripts" srcDoc={withCanvasPager(canvas.html)} onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: "xiaowang:page", page, requestId: canvas.requestId }, "*")} /> : <p className="empty">{copy.emptyCanvas}</p>}
  </div>;
}

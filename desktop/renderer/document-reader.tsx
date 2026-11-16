import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, Search, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, ScrollMode, RenderingStates } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
export interface ReaderFile { id: string; filename: string; page: number; requestId?: string; restore?: boolean }
export function DocumentReader({ slug, file, locale = "zh", visualCallId }: { slug: string; file: ReaderFile; locale?: "zh" | "en"; visualCallId?: string }) {
  return /\.(png|jpe?g|webp|gif)$/i.test(file.filename) ? <ImageReader key={`${slug}:${file.id}`} slug={slug} file={file} /> : /\.pdf$/i.test(file.filename) ? <PdfReader key={`${slug}:${file.id}`} slug={slug} file={file} locale={locale} visualCallId={visualCallId} /> : <TextReader key={`${slug}:${file.id}`} slug={slug} file={file} />;
}

function ImageReader({ slug, file }: { slug: string; file: ReaderFile }) {
  const [url, setUrl] = useState(""), [error, setError] = useState(""), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false, objectUrl = "";
    void window.xiaowang.readFile(slug, file.id).then(bytes => { if (disposed) return; objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)])); setUrl(objectUrl); }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [slug, file.id]);
  useEffect(() => {
    if (!loaded && !error) return;
    if (file.requestId) void window.xiaowang.stageAck(slug, file.requestId, { page: 1, totalPages: 1, error: error || undefined });
    if (!error) void window.xiaowang.stagePosition(slug, { path: file.id, page: 1, totalPages: 1, mode: "file" });
  }, [slug, file.id, file.requestId, loaded, error]);
  return <div className="document-reader image-reader" aria-label={file.filename}>{error ? <p className="reader-error" role="alert">{error}</p> : url ? <div className="image-scroll"><img src={url} alt={file.filename} onLoad={() => setLoaded(true)} onError={() => setError("图片无法显示。")} /></div> : <Loading />}</div>;
}

function TextReader({ slug, file }: { slug: string; file: ReaderFile }) {
  const [text, setText] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stopped = false;
    void window.xiaowang.readFile(slug, file.id).then(bytes => { if (!stopped) { setText(new TextDecoder().decode(new Uint8Array(bytes))); setLoading(false); } }).catch(reason => { if (!stopped) { setError(String(reason)); setLoading(false); } });
    return () => { stopped = true; };
  }, [slug, file.id]);
  useEffect(() => {
    if (loading) return;
    if (file.requestId) void window.xiaowang.stageAck(slug, file.requestId, { page: 1, totalPages: 1, error: error || undefined });
    if (!error) void window.xiaowang.stagePosition(slug, { path: file.id, page: 1, totalPages: 1, mode: "file" });
  }, [slug, file.id, file.requestId, error, loading]);
  return <div className="document-reader" aria-label={file.filename}>{loading ? <Loading /> : null}{error ? <p className="reader-error" role="alert">{error}</p> : null}{/\.(md|markdown)$/i.test(file.filename) ? <div className="prose"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div> : <pre className="plain">{text}</pre>}</div>;
}
function Loading() { return <div className="reader-loading" role="status" aria-label="Loading document / 正在载入文档"><LoaderCircle size={18} className="spin" /></div>; }

function PdfReader({ slug, file, locale, visualCallId }: { slug: string; file: ReaderFile; locale: "zh" | "en"; visualCallId?: string }) {
  const en = locale === "en";
  const container = useRef<HTMLDivElement>(null); const viewerElement = useRef<HTMLDivElement>(null);
  const engine = useRef<PDFViewer | null>(null); const bus = useRef<EventBus | null>(null);
  const latest = useRef(file); latest.current = file;
  const navigation = useRef<(file: ReaderFile) => void>(() => {});
  const [page, setPage] = useState(1); const [pages, setPages] = useState(0); const [zoom, setZoom] = useState("page-width");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [findOpen, setFindOpen] = useState(false); const [query, setQuery] = useState(""); const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [pageInput, setPageInput] = useState("1");
  const captureReady = useRef<{ page: number; done: Promise<boolean> } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!document || !pages) return;
    let stopped = false;
    let revision = -1;
    let finish!: (value: boolean) => void;
    captureReady.current = { page, done: new Promise<boolean>(resolve => { finish = resolve; }) };
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    // A separate bounded canvas avoids viewer recycling, zoom changes and blank-page captures.
    const timer = setTimeout(() => { void (async () => {
      revision = await window.xiaowang.stagePosition(slug, { path: file.id, page, totalPages: pages, mode: "file" });
      if (stopped || revision < 0) return;
      const pdfPage = await document.getPage(page); if (stopped) return;
      const original = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
      const canvas = window.document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      render = pdfPage.render({ canvas, viewport, background: "rgb(255,255,255)" }); await render.promise;
      if (!stopped) finish(await window.xiaowang.stageVisual(slug, { refId: file.id, page, revision, data: canvas.toDataURL("image/jpeg", .85).split(",")[1]!, ...(visualCallId ? { callId: visualCallId } : {}) }));
      canvas.width = canvas.height = 0;
    })().catch(() => {
      if (!stopped) void window.xiaowang.stageVisual(slug, { refId: file.id, page, revision, data: "", ...(visualCallId ? { callId: visualCallId } : {}) });
    }).finally(() => finish(false)); }, 350);
    return () => { stopped = true; clearTimeout(timer); render?.cancel(); finish(false); };
  }, [document, pages, page, slug, file.id, visualCallId]);
  const positionKey = `xiaowang.pdfPosition:${slug}:${file.id}`;
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => {
    const area = container.current; const element = viewerElement.current; if (!area || !element) return;
    const ac = new AbortController(); const events = new EventBus(); bus.current = events;
    const link = new PDFLinkService({ eventBus: events, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer" });
    const find = new PDFFindController({ linkService: link, eventBus: events });
    const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container: area, viewer: element, eventBus: events, linkService: link, findController: find,
      textLayerMode: 1, annotationMode: AnnotationMode.ENABLE, maxCanvasPixels: 12_000_000, abortSignal: ac.signal,
    };
    const viewer = new PDFViewer(options); engine.current = viewer; link.setViewer(viewer); viewer.scrollMode = ScrollMode.VERTICAL;
    let task: PDFDocumentLoadingTask | null = null; let ready = false; let pending: ReaderFile | null = null;
    const acknowledged = new Set<string>();
    let savedPage = 0; try { savedPage = Number(localStorage.getItem(positionKey)); } catch { /* Optional reading position. */ }
    const ack = async (requested: ReaderFile, reason?: string) => {
      if (!requested.requestId || acknowledged.has(requested.requestId)) return;
      acknowledged.add(requested.requestId);
      if (!reason) {
        for (let attempt = 0; attempt < 40 && !ac.signal.aborted && captureReady.current?.page !== requested.page; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        const capture = captureReady.current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const captured = capture?.page === requested.page && await Promise.race([capture.done, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 4000); })]);
        clearTimeout(timer);
        if (ac.signal.aborted) return;
        if (!captured) reason = "页面已显示，但视觉画面尚未共享；不要声称已经看到了页面图像。";
      }
      void window.xiaowang.stageAck(slug, requested.requestId, { page: requested.page, totalPages: viewer.pagesCount || 1, title: requested.filename, ...(reason ? { error: reason } : {}) });
    };
    const navigate = (requested: ReaderFile) => {
      pending = requested; if (!ready) return;
      let target = requested.page;
      if (requested.restore && !requested.requestId && savedPage >= 1 && savedPage <= viewer.pagesCount) target = savedPage;
      if (!Number.isSafeInteger(target) || target < 1 || target > viewer.pagesCount) { const message = `页码超出范围：${target} / ${viewer.pagesCount}`; setError(message); setLoading(false); ack(requested, message); return; }
      setError(""); viewer.scrollPageIntoView({ pageNumber: target });
      // A receipt means the requested page is painted, not just present as an empty placeholder.
      if (viewer.getPageView(target - 1)?.renderingState === RenderingStates.FINISHED) { setLoading(false); ack(requested); } else setLoading(true);
    };
    navigation.current = navigate;
    events.on("pagesinit", () => { if (ac.signal.aborted) return; ready = true; setPages(viewer.pagesCount); viewer.currentScaleValue = "page-width"; navigate(latest.current); }, { signal: ac.signal });
    events.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      if (!ready || ac.signal.aborted) return;
      setPage(pageNumber); try { localStorage.setItem(positionKey, String(pageNumber)); } catch { /* Optional reading position. */ }
      void window.xiaowang.stagePosition(slug, { path: file.id, page: pageNumber, totalPages: viewer.pagesCount, mode: "file" });
    }, { signal: ac.signal });
    events.on("pagerendered", ({ pageNumber, error: renderError }: { pageNumber: number; error?: Error }) => {
      if (ac.signal.aborted) return;
      if (renderError) { const message = renderError.message || String(renderError); setError(message); setLoading(false); if (pending?.page === pageNumber) ack(pending, message); return; }
      if (pageNumber === viewer.currentPageNumber) setLoading(false);
      if (pending?.page === pageNumber) ack(pending);
    }, { signal: ac.signal });
    events.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) => setZoom(presetValue || String(Math.round(scale * 100))), { signal: ac.signal });
    events.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setMatches(matchesCount), { signal: ac.signal });
    events.on("updatefindcontrolstate", ({ matchesCount }: { matchesCount?: { current: number; total: number } }) => { if (matchesCount) setMatches(matchesCount); }, { signal: ac.signal });
    // Route PDF links through the same deliberate external-link action as chat citations.
    const links = (event: MouseEvent) => { const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]"); if (!anchor || !/^https?:/i.test(anchor.href)) return; event.preventDefault(); event.stopPropagation(); void window.xiaowang.openLink(anchor.href); };
    area.addEventListener("click", links, { capture: true, signal: ac.signal });
    // Chromium reports trackpad pinches as Ctrl+wheel. Scale the PDF at the
    // gesture origin, leaving ordinary scrolling and the application's zoom alone.
    area.addEventListener("wheel", event => {
      if (!event.ctrlKey || !ready || !Number.isFinite(event.deltaY)) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? area.clientHeight : 1;
      const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
      const next = Math.max(.25, Math.min(4, viewer.currentScale * Math.exp(-delta * .01)));
      viewer.updateScale({ scaleFactor: next / viewer.currentScale, origin: [event.clientX, event.clientY], drawingDelay: 100 });
    }, { passive: false, signal: ac.signal });
    const resources = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
    void window.xiaowang.readFile(slug, file.id).then(async bytes => {
      if (ac.signal.aborted) return;
      task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, cMapUrl: `${resources}cmaps/`, cMapPacked: true, standardFontDataUrl: `${resources}standard_fonts/`, wasmUrl: `${resources}wasm/`, iccUrl: `${resources}iccs/` });
      const pdf = await task.promise; if (ac.signal.aborted) return;
      setDocument(pdf); link.setDocument(pdf); viewer.setDocument(pdf);
    }).catch(reason => { if (!ac.signal.aborted) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); setLoading(false); ack(latest.current, message); } });
    const resize = new ResizeObserver(() => { if (ready && ["page-width", "page-fit", "auto"].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue; });
    resize.observe(area);
    return () => { ac.abort(); resize.disconnect(); navigation.current = () => {}; engine.current = null; bus.current = null; viewer.setDocument(null as unknown as Parameters<PDFViewer["setDocument"]>[0]); link.setDocument(null as unknown as Parameters<PDFLinkService["setDocument"]>[0]); void task?.destroy(); void viewer.l10n?.destroy(); };
  }, [slug, file.id, positionKey]);
  useEffect(() => { navigation.current(file); }, [file]);
  function go(target: number) { const viewer = engine.current; if (viewer && target >= 1 && target <= pages) viewer.scrollPageIntoView({ pageNumber: target }); }
  function scale(value: string) { if (engine.current) engine.current.currentScaleValue = /^\d+$/.test(value) ? String(Number(value) / 100) : value; }
  function search(value: string, again = false, previous = false) { setQuery(value); bus.current?.dispatch("find", { source: container.current, type: again ? "again" : "", query: value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false }); }
  return <div className="document-reader">
    <div className="pdf-controls">
      <button type="button" aria-label="Previous page / 上一页" disabled={page <= 1} onClick={() => go(page - 1)}><ChevronLeft size={16} /></button>
      <form onSubmit={event => { event.preventDefault(); go(Number(pageInput)); }}><input aria-label="PDF page / PDF页码" inputMode="numeric" value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => { go(Number(pageInput)); setPageInput(String(engine.current?.currentPageNumber || page)); }} /><span>/ {pages || "…"}</span></form>
      <button type="button" aria-label="Next page / 下一页" disabled={!pages || page >= pages} onClick={() => go(page + 1)}><ChevronRight size={16} /></button><span className="control-divider" />
      <button type="button" aria-label="Zoom out / 缩小" onClick={() => scale(String(Math.max(25, Math.round((engine.current?.currentScale || 1) * 80))))}><Minus size={15} /></button>
      <select aria-label="PDF zoom / PDF缩放" value={zoom} onChange={event => scale(event.target.value)}><option value="page-width">{en ? "Fit width" : "适应宽度"}</option><option value="page-fit">{en ? "Fit page" : "适应页面"}</option>{!["page-width", "page-fit", "50", "75", "100", "125", "150", "200"].includes(zoom) ? <option value={zoom}>{zoom}%</option> : null}{[50,75,100,125,150,200].map(value => <option key={value} value={value}>{value}%</option>)}</select>
      <button type="button" aria-label="Zoom in / 放大" onClick={() => scale(String(Math.min(400, Math.round((engine.current?.currentScale || 1) * 125))))}><Plus size={15} /></button>
      <button className="pdf-search-toggle" type="button" aria-label="Search PDF / 搜索文档" aria-pressed={findOpen} onClick={() => setFindOpen(!findOpen)}><Search size={15} /></button>
    </div>
    {findOpen ? <form className="pdf-find" onSubmit={event => { event.preventDefault(); search(query, true); }}><input aria-label="Find in PDF / 在PDF中查找" autoFocus value={query} onChange={event => search(event.target.value)} placeholder={en ? "Find in document" : "搜索文档"} /><span aria-live="polite">{matches.current} / {matches.total}</span><button type="button" aria-label="Previous match / 上一个匹配" onClick={() => search(query, true, true)}><ChevronLeft size={14} /></button><button type="submit" aria-label="Next match / 下一个匹配"><ChevronRight size={14} /></button><button type="button" aria-label="Close PDF search / 关闭文档搜索" onClick={() => { setFindOpen(false); bus.current?.dispatch("findbarclose", {}); }}><X size={14} /></button></form> : null}
    {error ? <p className="reader-error" role="alert">{error}</p> : null}
    <div className="pdf-viewer-host"><div ref={container} className="pdf-scroll" tabIndex={0} aria-label={`PDF: ${file.filename}`}><div ref={viewerElement} className="pdfViewer" /></div></div>
    {loading ? <Loading /> : null}
  </div>;
}

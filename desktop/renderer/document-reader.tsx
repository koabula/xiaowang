import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
export function DocumentReader({ slug, file }: { slug: string; file: { id: string; filename: string; page: number; requestId?: string } }) {
  const [text, setText] = useState("");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(file.page);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const isPdf = /\.pdf$/i.test(file.filename);
  useEffect(() => { setPage(file.page); }, [file.page, file.requestId]);
  useEffect(() => {
    if (!area.current) return;
    const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next) setWidth(Math.max(200, next - 40)); });
    observer.observe(area.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stopped = false;
    let document: PDFDocumentProxy | null = null;
    let task: PDFDocumentLoadingTask | null = null;
    setLoading(true); setError(""); setPdf(null); setText("");
    void window.xiaowang.readFile(slug, file.id).then(async bytes => {
      const data = new Uint8Array(bytes);
      if (isPdf) {
        task = getDocument({ data, useSystemFonts: true });
        document = await task.promise;
        if (stopped) { await task.destroy(); return; }
        setPdf(document);
      } else if (!stopped) { setText(new TextDecoder().decode(data)); setLoading(false); }
    }).catch((reason: unknown) => { if (!stopped) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } });
    return () => { stopped = true; void task?.destroy(); };
  }, [slug, file.id, isPdf]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let stopped = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    setLoading(true); setError("");
    if (page < 1 || page > pdf.numPages) { setError(`页码超出范围：${page} / ${pdf.numPages}`); setLoading(false); return; }
    void pdf.getPage(page).then(item => {
      if (stopped || !canvas.current) return;
      const base = item.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = item.getViewport({ scale: scale * dpr });
      const node = canvas.current;
      node.width = viewport.width; node.height = viewport.height;
      node.style.width = `${viewport.width / dpr}px`; node.style.height = `${viewport.height / dpr}px`;
      task = item.render({ canvas: node, viewport });
      return task.promise;
    }).then(() => {
      if (stopped) return;
      setLoading(false);
      void window.xiaowang.stagePosition(slug, { path: file.id, page, totalPages: pdf.numPages, mode: "file" });
      if (file.requestId) void window.xiaowang.stageAck(slug, file.requestId, { page, totalPages: pdf.numPages, title: file.filename });
    }).catch((reason: unknown) => {
      if (stopped) return;
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false);
    });
    return () => { stopped = true; task?.cancel(); };
  }, [pdf, page, width, slug, file.id, file.requestId, file.filename]);
  useEffect(() => {
    if (!file.requestId) return;
    if (error) void window.xiaowang.stageAck(slug, file.requestId, { page, totalPages: pdf?.numPages ?? 1, error });
    else if (!isPdf && !loading) {
      void window.xiaowang.stagePosition(slug, { path: file.id, page: 1, totalPages: 1, mode: "file" });
      void window.xiaowang.stageAck(slug, file.requestId, { page: 1, totalPages: 1 });
    }
  }, [error, file.requestId, isPdf, loading, slug, file.id, page, pdf]);
  return <div className="document-reader" ref={area}>
    <div className="reader-toolbar"><FileText size={14} /><span>{file.filename}</span>{isPdf ? <div className="reader-pager"><button type="button" aria-label="Previous page / 上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pdf?.numPages || "…"}</span><button type="button" aria-label="Next page / 下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div> : null}</div>
    {loading ? <div className="reader-loading" role="status"><LoaderCircle size={18} className="spin" /></div> : null}
    {error ? <p className="reader-error" role="alert">{error}</p> : null}
    {isPdf ? <div className="pdf-scroll"><canvas ref={canvas} aria-label={`${file.filename}, page ${page}`} /></div> : /\.md|\.markdown$/i.test(file.filename) ? <div className="prose"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div> : <pre className="plain">{text}</pre>}
  </div>;
}

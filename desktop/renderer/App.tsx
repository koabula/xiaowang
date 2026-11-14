import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, ChevronUp, ExternalLink, Eye, FileText, Frame, Globe, Maximize2, MessageSquareText, Mic, MicOff, Minimize2, MousePointer2, PanelRight, Phone, PhoneOff, Play, Plus, RefreshCw, Search, Settings, Square, X } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar, nextAvatarSeed } from "./avatar.tsx";
import { INK_CHOICES, inkFor } from "./ink.ts";
import { createCallAudio } from "./call-audio.ts";
import { VoicePanel, type LiveCallView, type LiveCaption } from "./voice-panel.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { RichText } from "./rich-text.tsx";
const DocumentReader = lazy(() => import("./document-reader.tsx").then(module => ({ default: module.DocumentReader })));
import { withCanvasPager } from "./canvas-pager.ts";
import { copyFor, localeOf, type Copy, type Locale } from "./copy.ts";
import { REALTIME_SERVICES, modelsFor, resolveRealtime, voicesFor, type RealtimeRegion, type RealtimeServiceId } from "../../src/realtime-catalog.ts";
import { mergeUtterance } from "../../src/realtime.ts";
import type { AppState, BotRow, BrowserNote, CallNote, CanvasPage, ChatItem, LibraryItem, SettingsPatch, StageNote, TurnNote } from "./types.ts";

type StageSnap = {
  mode: "file" | "browser" | "canvas" | "profile";
  open: boolean;
  file: { id: string; filename: string; page: number; requestId?: string } | null;
  canvas: { title: string; html: string; page: number; requestId?: string } | null;
};

const EMPTY_STAGE: StageSnap = { mode: "file", open: true, file: null, canvas: null };
const TAB_STORE = "xiaowang.openTabs";

type OpenTabs = { files: string[]; pages: string[] };

function loadTabs(): Record<string, OpenTabs> {
  try {
    const raw = localStorage.getItem(TAB_STORE);
    const parsed = raw ? JSON.parse(raw) as Record<string, OpenTabs> : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTabs(tabs: Record<string, OpenTabs>): void {
  localStorage.setItem(TAB_STORE, JSON.stringify(tabs));
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [pages, setPages] = useState<CanvasPage[]>([]);
  const [openTabs, setOpenTabs] = useState<Record<string, OpenTabs>>(loadTabs);
  const [draftBySlug, setDraftBySlug] = useState<Record<string, string>>({});
  const [busyBySlug, setBusyBySlug] = useState<Record<string, boolean>>({});
  const [activityBySlug, setActivityBySlug] = useState<Record<string, string>>({});
  const [stageBySlug, setStageBySlug] = useState<Record<string, StageSnap>>({});
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [botName, setBotName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [call, setCall] = useState<LiveCallView | null>(null);
  const [streamBySlug, setStreamBySlug] = useState<Record<string, { jobId: string; text: string }>>({});
  const audioRef = useRef(createCallAudio(
    (audio) => window.xiaowang.callAudio(audio),
    (serial, callId) => window.xiaowang.callIdle(serial, callId),
    position => window.xiaowang.callPosition(position),
  ));
  const [toast, setToast] = useState("");
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(252);
  const [canvasWide, setCanvasWide] = useState(false);
  const [stageMenu, setStageMenu] = useState(true);
  const [browser, setBrowser] = useState<BrowserNote>({ url: "", title: "", holder: "bot", loading: false });
  const [address, setAddress] = useState("");
  const holeRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef("");
  const liveCallId = useRef("");
  const finishedJobs = useRef(new Set<string>());
  const active = state?.activeSlug ?? "";
  activeRef.current = active;
  const stage = stageBySlug[active] ?? EMPTY_STAGE;
  const mode = stage.mode;
  const file = stage.file;
  const canvas = stage.canvas;
  const stageOpen = stage.open;
  const copy = copyFor(localeOf(state?.settings.locale));
  const busy = Boolean(busyBySlug[active]) || Boolean(state?.jobs?.some(job => job.botId === state.bots.find(bot => bot.slug === active)?.id && (job.status === "running" || job.status === "queued")));
  const draft = draftBySlug[active] ?? "";
  const activity = activityBySlug[active] ?? "";
  const current = state?.bots.find((bot) => bot.slug === active);
  const steward = state?.bots.find((bot) => bot.slug === "xiaowang");
  const ink = current?.avatarInk || inkFor(active || "xiaowang");
  const covered = settingsOpen || (state !== null && !state.settings.ready);

  function patchStage(slug: string, patch: Partial<StageSnap>) {
    if (!slug) return;
    setStageBySlug((prev) => ({ ...prev, [slug]: { ...EMPTY_STAGE, ...prev[slug], ...patch } }));
  }

  useEffect(() => {
    void window.xiaowang.getState().then(setState);
    const stops = [
      window.xiaowang.onDelta(note => { if (!finishedJobs.current.has(note.jobId)) setStreamBySlug(prev => ({ ...prev, [note.slug]: { jobId: note.jobId, text: (prev[note.slug]?.jobId === note.jobId ? prev[note.slug]?.text || "" : "") + note.text } })); }),
      window.xiaowang.onJob(job => {
        if (["succeeded", "cancelled", "failed", "interrupted"].includes(job.status)) {
          finishedJobs.current.add(job.id);
          setStreamBySlug(prev => prev[job.slug]?.jobId === job.id ? { ...prev, [job.slug]: { jobId: job.id, text: "" } } : prev);
        } else finishedJobs.current.delete(job.id);
        setState(prev => prev ? { ...prev, jobs: [...(prev.jobs ?? []).filter(item => item.id !== job.id), job] } : prev);
      }),
      window.xiaowang.onState(setState),
      window.xiaowang.onBrowser((next) => {
        setBrowser(next);
        setAddress(next.url);
      }),
      window.xiaowang.onDownload((note) => {
        setToast(note.error ? note.error : `已放入资料库 ${note.filename ?? ""}`);
        if (note.slug && note.slug === activeRef.current) void window.xiaowang.library(note.slug).then(refs => { if (activeRef.current === note.slug) setLibrary(refs); });
      }),
      window.xiaowang.onStage((view) => rememberStage(view)),
      window.xiaowang.onCall((note) => {
        void hearCall(note);
      }),
      window.xiaowang.onStep((step) => {
        if (step.kind === "assistant") {
          if (step.slug === activeRef.current) void window.xiaowang.events(step.slug).then(items => { if (activeRef.current === step.slug) setItems(items); });
          setStreamBySlug(prev => ({ ...prev, [step.slug]: { jobId: step.jobId || "", text: "" } }));
        }
        if (!step.activity?.trim()) return;
        setActivityBySlug((prev) => ({ ...prev, [step.slug]: step.activity!.trim() }));
      }),
      window.xiaowang.onTurn((note: TurnNote) => {
        setBusyBySlug((prev) => ({ ...prev, [note.slug]: note.busy }));
        if (note.busy) {
          setActivityBySlug((prev) => ({ ...prev, [note.slug]: "" }));
          return;
        }
        if (note.error) setToast(note.error.length > 160 ? `${note.error.slice(0, 160)}…` : note.error);
        if (activeRef.current !== note.slug) return;
        void window.xiaowang.events(note.slug).then(items => { if (activeRef.current === note.slug) setItems(items); });
        void window.xiaowang.library(note.slug).then(refs => { if (activeRef.current === note.slug) setLibrary(refs); });
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([window.xiaowang.events(active), window.xiaowang.library(active), window.xiaowang.pages(active)]).then(([events, refs, pages]) => {
      if (!cancelled && activeRef.current === active) { setItems(events); setLibrary(refs); setPages(pages); }
    }).catch(error => { if (!cancelled) setToast(plainError(error)); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (!active || mode !== "canvas") return;
    void window.xiaowang.pages(active).then(setPages).catch(() => setPages([]));
  }, [active, mode, canvas?.title]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [items, busy]);

  useEffect(() => {
    if (mode !== "browser" || covered || !stageOpen) {
      void window.xiaowang.browserBounds(null);
      return;
    }
    const node = holeRef.current;
    if (!node) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      void window.xiaowang.browserBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [mode, covered, rightWidth, leftWidth, stageOpen]);

  useEffect(() => {
    if (!(canvasWide && mode === "canvas")) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCanvasWide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasWide, mode]);

  function pinTab(slug: string, kind: "files" | "pages", key: string) {
    if (!slug || !key) return;
    setOpenTabs((prev) => {
      const current = prev[slug] ?? { files: [], pages: [] };
      if (current[kind].includes(key)) return prev;
      const next = { ...prev, [slug]: { ...current, [kind]: [...current[kind], key] } };
      saveTabs(next);
      return next;
    });
  }

  function closeTab(slug: string, kind: "files" | "pages", key: string) {
    setOpenTabs((prev) => {
      const current = prev[slug] ?? { files: [], pages: [] };
      const next = { ...prev, [slug]: { ...current, [kind]: current[kind].filter((item) => item !== key) } };
      saveTabs(next);
      return next;
    });
  }

  function rememberStage(view: StageNote) {
    if (!view.slug) return;
    if (view.mode === "file") {
      pinTab(view.slug, "files", view.id);
      patchStage(view.slug, { mode: "file", open: true, file: { id: view.id, filename: view.filename, page: view.page, requestId: view.requestId } });
    } else if (view.mode === "browser") {
      patchStage(view.slug, { mode: "browser", open: true });
      if (view.url && view.slug === activeRef.current) setAddress(view.url);
    } else {
      pinTab(view.slug, "pages", view.title);
      patchStage(view.slug, { mode: "canvas", open: true, canvas: { title: view.title, html: view.html, page: view.page ?? 1, requestId: view.requestId } });
    }
  }

  async function sendMessage() {
    const slug = activeRef.current;
    const text = (draftBySlug[slug] ?? "").trim();
    if (!text || !slug) return;
    setDraftBySlug((prev) => ({ ...prev, [slug]: "" }));
    setBusyBySlug((prev) => ({ ...prev, [slug]: true }));
    setActivityBySlug((prev) => ({ ...prev, [slug]: "" }));
    setItems((currentItems) => [...currentItems, { id: -Date.now(), kind: "user", text }]);
    try {
      const next = await window.xiaowang.ask(slug, text);
      if (activeRef.current === slug) {
        setItems(next);
        setLibrary(await window.xiaowang.library(slug));
      }
    } catch (error) {
      setToast(plainError(error));
    } finally {
      setBusyBySlug(prev => ({ ...prev, [slug]: false }));
    }
  }

  function openProfile() {
    const slug = activeRef.current;
    const snap = stageBySlug[slug] ?? EMPTY_STAGE;
    if (snap.open && snap.mode === "profile") {
      patchStage(slug, { open: false });
      return;
    }
    const max = Math.max(360, window.innerWidth - leftWidth - 420);
    setRightWidth((width) => Math.min(Math.max(width, 360), max));
    patchStage(slug, { mode: "profile", open: true });
  }

  function toggleStage() {
    const slug = activeRef.current;
    const open = stageBySlug[slug]?.open ?? true;
    if (open) {
      patchStage(slug, { open: false });
      return;
    }
    const max = Math.max(360, window.innerWidth - leftWidth - 420);
    setRightWidth((width) => Math.min(Math.max(width, 360), max));
    patchStage(slug, { open: true });
  }

  async function hearCall(note: CallNote) {
    if (note.preview) return;
    if (note.callId && note.phase === "connecting") liveCallId.current = note.callId;
    if (note.callId && liveCallId.current && note.callId !== liveCallId.current) return;
    if (note.callId) liveCallId.current = note.callId;
    if (note.phase === "state" && note.state) {
      setCall(prev => prev ? { ...prev, state: note.state } : note.state?.phase !== "ended" ? { slug: note.slug, phase: "connecting", captions: [], muted: false, audioReady: false, state: note.state } : null);
      return;
    }
    if (note.phase === "live") {
      setCall(prev => ({ slug: note.slug, phase: "live", captions: prev?.captions ?? [], muted: false, audioReady: false, state: prev?.state }));
      try {
        await audioRef.current.start(note.inputRate || 16_000, note.outputRate || 24_000);
        setCall(prev => prev ? { ...prev, audioReady: true } : null);
      } catch (error) {
        audioRef.current.stop();
        setCall(null);
        setToast(plainError(error));
        void window.xiaowang.callStop();
      }
      return;
    }
    if (note.phase === "audio" && note.audio) {
      audioRef.current.play(note.audio, note.serial, note.identity);
      return;
    }
    if (note.phase === "interrupt") {
      audioRef.current.interrupt();
      return;
    }
    if (note.phase === "line" && note.text && note.who) {
      const who = note.who;
      const text = note.text;
      const partial = Boolean(note.partial);
      setCall((currentCall) => currentCall ? { ...currentCall, captions: foldCaption(currentCall.captions, who, text, partial, note.itemId, note.order) } : currentCall);
      return;
    }
    if (note.phase === "saved" && note.slug === activeRef.current) {
      setItems(await window.xiaowang.events(note.slug));
      return;
    }
    if (note.phase === "closed") {
      liveCallId.current = "";
      audioRef.current.stop();
      setCall(null);
      if (note.detail) setToast(note.detail);
    }
  }

  async function endCall() {
    audioRef.current.stop();
    await window.xiaowang.callStop();
    setCall(null);
  }

  function toggleMute() {
    setCall((currentCall) => {
      if (!currentCall) return currentCall;
      const muted = !currentCall.muted;
      audioRef.current.setMuted(muted);
      return { ...currentCall, muted };
    });
  }

  async function toggleCall() {
    if (call) {
      await endCall();
      return;
    }
    liveCallId.current = "";
    setCall({ slug: activeRef.current, phase: "connecting", captions: [], muted: false, audioReady: false });
    try {
      await window.xiaowang.callStart(activeRef.current);
    } catch (error) {
      setCall(null);
      setToast(plainError(error));
    }
  }

  async function createBot() {
    const name = botName.trim();
    if (!name) return;
    await window.xiaowang.createBot(name, `${name}的任务。`);
    setBotName("");
    setCreating(false);
  }

  const bots = (state?.bots ?? []).filter((bot) => `${bot.name}${bot.preview}`.includes(query.trim()));
  const wide = canvasWide && mode === "canvas" && stageOpen;

  return (
    <div className={wide ? "shell canvas-wide" : "shell"}>
      <aside className="rail" style={{ width: leftWidth }}>
        <div className="traffic-space">
          <button className="icon" title={copy.search} type="button"><Search size={16} /></button>
          <button className="icon" title={copy.newTask} type="button" onClick={() => setCreating(true)}><Plus size={16} /></button>
        </div>
        <button className={active === "xiaowang" ? "steward on" : "steward"} type="button" onClick={() => void window.xiaowang.setActive("xiaowang")}>
          <Avatar slug="xiaowang" seed={steward?.avatarSeed} ink={steward?.avatarInk} size={72} mood={busyBySlug.xiaowang ? "think" : "idle"} />
          <strong>{steward?.name ?? "小王同学"}</strong>
        </button>
        <div className="search-line">
          <input value={query} placeholder={copy.findTask} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {creating ? (
          <form className="new-bot" onSubmit={(event) => { event.preventDefault(); void createBot(); }}>
            <input autoFocus value={botName} placeholder={copy.taskName} onChange={(event) => setBotName(event.target.value)} />
          </form>
        ) : null}
        <nav>
          {bots.filter((bot) => bot.slug !== "xiaowang").map((bot) => (
            <button className={["bot", bot.slug === active ? "on" : "", busyBySlug[bot.slug] ? "working" : ""].filter(Boolean).join(" ")} key={bot.slug} type="button" onClick={() => void window.xiaowang.setActive(bot.slug)}>
              <Avatar slug={bot.slug} seed={bot.avatarSeed} ink={bot.avatarInk} mood={busyBySlug[bot.slug] ? "think" : "idle"} />
              <span>
                <strong>{bot.name}</strong>
                <em>{bot.preview}</em>
              </span>
            </button>
          ))}
        </nav>
        <footer>
          <button className="settings" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
            {copy.settings}
          </button>
        </footer>
      </aside>

      <div className="split" onPointerDown={(event) => dragSize(event, leftWidth, setLeftWidth, 1)} />

      <main className="thread">
        <header>
          <button className={mode === "profile" && stageOpen ? "pill on" : "pill"} type="button" onClick={openProfile}>
            <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={22} mood={busy ? "think" : "idle"} />
            {current?.name ?? "小王同学"}
            <ChevronRight size={14} />
          </button>
          <button className="icon stage-toggle" type="button" title={stageOpen ? copy.collapseStage : copy.expandStage} onClick={toggleStage}>
            <PanelRight size={16} />
          </button>
        </header>
        <div className="messages" ref={threadRef}>
          {items.filter(isConversation).length === 0 && !busy ? <div className="welcome"><Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={ink} size={56} /><h1>{localeOf(state?.settings.locale) === "en" ? "What shall we explore?" : "今天一起研究什么？"}</h1><p>{localeOf(state?.settings.locale) === "en" ? "Bring a paper, ask a question, or start a voice conversation." : "放入一篇论文，提出一个问题，或直接与小王聊聊。"}</p></div> : null}
          <TaskPanel slug={active} jobs={(state?.jobs ?? []).filter(job => job.botId === state?.bots.find(bot => bot.slug === active)?.id)} locale={localeOf(state?.settings.locale)} onError={setToast} />
          {items.filter(isConversation).map((item) => <Message key={item.id} slug={active} item={item} ink={ink} name={current?.name || "小王同学"} copy={copy} />)}
          {streamBySlug[active]?.text ? <article className="bubble assistant streaming"><RichText slug={active} text={streamBySlug[active]?.text || ""} /><span className="stream-caret" /></article> : null}
          {busy && !streamBySlug[active]?.text ? (
            <div className="thinking">
              <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={28} mood="think" />
              {activity ? <em key={activity}>{activity}</em> : <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
            </div>
          ) : null}
        </div>
        {call && call.slug === active ? <VoicePanel call={call} audio={audioRef.current} name={current?.name || "小王"} seed={current?.avatarSeed} ink={ink} locale={localeOf(state?.settings.locale)} onMute={toggleMute} onEnd={() => void endCall()} /> : call ? <button className="call-away" type="button" onClick={() => void window.xiaowang.setActive(call.slug)}><Phone size={14} />{localeOf(state?.settings.locale) === "en" ? "Return to your call" : "返回正在进行的通话"}</button> : null}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <button className="icon" type="button" title={copy.addToLibrary} onClick={() => void window.xiaowang.addFiles().then(async () => { if (active) setLibrary(await window.xiaowang.library(active)); })}><Plus size={18} /></button>
          <textarea
            rows={1}
            value={draft}
            placeholder={copy.message(current?.name ?? "")}
            onChange={(event) => {
              const slug = activeRef.current;
              const value = event.target.value;
              setDraftBySlug((prev) => ({ ...prev, [slug]: value }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          {busy ? <button className="call stop" type="button" title={copy.stop} onClick={() => void window.xiaowang.stop(active)}><Square size={14} /></button> : null}
          {!call ? <button className="call" style={{ background: ink }} type="button" title={copy.call} aria-label={copy.call} onClick={() => void toggleCall()}><span /><span /><span /><span /></button> : null}
        </form>
      </main>

      {stageOpen ? <div className="split" onPointerDown={(event) => dragSize(event, rightWidth, setRightWidth, -1)} /> : null}

      {stageOpen ? (
      <aside className="stage" style={wide ? undefined : { width: rightWidth }}>
        <div className={stageMenu ? "stage-tabs" : "stage-tabs shut"}>
          {stageMenu ? (
            <>
              <button className={mode === "file" ? "on" : ""} type="button" onClick={() => { setCanvasWide(false); patchStage(active, { mode: "file" }); }}><FileText size={15} /> {copy.files}</button>
              <button className={mode === "browser" ? "on" : ""} type="button" onClick={() => { setCanvasWide(false); patchStage(active, { mode: "browser" }); }}><Globe size={15} /> {copy.browser}</button>
              <button className={mode === "canvas" ? "on" : ""} type="button" onClick={() => patchStage(active, { mode: "canvas" })}><Frame size={15} /> {copy.canvas}</button>
            </>
          ) : null}
          <span className="stage-tab-end">
            {mode === "canvas" ? (
              <button className="fit" type="button" title={wide ? copy.shrinkCanvas : copy.fillCanvas} onClick={() => setCanvasWide((value) => !value)}>
                {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            ) : null}
            <button className="fit" type="button" title={stageMenu ? copy.collapseMenu : copy.expandMenu} onClick={() => setStageMenu((value) => !value)}>
              {stageMenu ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </span>
        </div>
        {mode === "profile" && current ? (
          <ProfileStage
            bot={current}
            personName={steward?.name ?? "小王同学"}
            copy={copy}
            library={library}
            onRefresh={async () => setLibrary(await window.xiaowang.library(current.slug))}
            onForgot={(id) => {
              closeTab(current.slug, "files", id);
              if (file?.id === id) patchStage(current.slug, { file: null });
            }}
          />
        ) : null}
        {mode === "file" ? (
          <FileStage
            slug={active}
            library={library}
            file={file}
            openIds={openTabs[active]?.files ?? []}
            menu={stageMenu}
            copy={copy}
            onPick={(entry) => {
              pinTab(active, "files", entry.id);
              patchStage(active, { file: { ...entry, page: 1 } });
            }}
            onClose={(id) => {
              closeTab(active, "files", id);
              if (file?.id === id) patchStage(active, { file: null });
            }}
          />
        ) : null}
        {mode === "canvas" ? (
          <CanvasStage
            slug={active}
            pages={pages}
            canvas={canvas}
            openPaths={openTabs[active]?.pages ?? []}
            menu={stageMenu}
            copy={copy}
            onPick={(path) => {
              pinTab(active, "pages", path);
              void window.xiaowang.openPage(active, path, 1).then((view) => {
                patchStage(active, { mode: "canvas", open: true, canvas: { title: view.title, html: view.html, page: view.page } });
              }).catch((error) => setToast(plainError(error)));
            }}
            onClose={(path) => {
              closeTab(active, "pages", path);
              if (canvas?.title === path) patchStage(active, { canvas: null });
            }}
          />
        ) : null}
        {mode === "browser" ? (
          <div className="browser-stage">
            <form className="url" onSubmit={(event) => { event.preventDefault(); void window.xiaowang.browserGo(address.startsWith("http") ? address : `https://${address}`); }}>
              <button type="button" disabled={browser.holder === "bot"} onClick={() => void window.xiaowang.browserBack()}><ArrowLeft size={15} /></button>
              <button type="button" disabled={browser.holder === "bot"} onClick={() => void window.xiaowang.browserForward()}><ArrowRight size={15} /></button>
              <input value={address} disabled={browser.holder === "bot"} placeholder="https://" onChange={(event) => setAddress(event.target.value)} />
            </form>
            <div className="hole" ref={holeRef} />
            <div className="capsule">
              {browser.holder === "bot" ? (
                <>
                  <span><Eye size={15} /> {copy.watching}</span>
                  <button type="button" onClick={() => void window.xiaowang.browserHolder("user")}>{copy.takeControl}</button>
                </>
              ) : (
                <>
                  <span><MousePointer2 size={15} /> {copy.youControl}</span>
                  <button className="quiet" type="button" onClick={() => void window.xiaowang.browserHolder("bot")}>{copy.release}</button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </aside>
      ) : null}

      {settingsOpen || (state !== null && !state.settings.ready) ? (
        <SettingsPanel
          settings={state?.settings}
          forced={state !== null && !state.settings.ready}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            const next = await window.xiaowang.saveSettings(patch);
            setState((currentState) => currentState ? { ...currentState, settings: next } : currentState);
            setSettingsOpen(false);
          }}
        />
      ) : null}
      {toast ? <button className="toast" type="button" onClick={() => setToast("")}>{toast}</button> : null}
    </div>
  );
}

function isConversation(item: ChatItem): boolean {
  return item.kind === "call" || ((item.kind === "user" || item.kind === "assistant") && item.text.trim().length > 0);
}

function plainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
  if (message.includes("content or tool_calls")) return "模型服务拒绝了一条空的助手记录。再发一次就可以。";
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

function Message({ item, ink, name, copy, slug }: { item: ChatItem; ink: string; name: string; copy: Copy; slug: string }) {
  if (item.kind === "call") return <CallCard item={item} name={name} ink={ink} copy={copy} />;
  if (item.kind === "user") return <div className="bubble user" style={{ background: ink }}>{item.text}</div>;
  return (
    <div className="bubble assistant">
      <RichText slug={slug} text={item.text} />
    </div>
  );
}

function CallCard({ item, name, ink, copy }: { item: ChatItem; name: string; ink: string; copy: Copy }) {
  const [open, setOpen] = useState(false);
  const seconds = item.seconds ?? 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <article className="call-card">
      <button type="button" title={open ? copy.collapseCall : copy.expandCall} onClick={() => setOpen((value) => !value)}>
        <Phone size={14} />
        <span>{name}</span>
        <span>{clock}</span>
        <ChevronDown size={14} />
      </button>
      {open ? <CallLines lines={item.lines ?? []} ink={ink} /> : null}
    </article>
  );
}

function CallLines({ lines, ink }: { lines: Array<{ who: "user" | "assistant"; text: string }>; ink: string }) {
  return (
    <div className="call-lines">
      {lines.map((line, index) => (
        <p key={`${line.who}-${index}`} className={line.who} style={line.who === "user" ? { background: ink } : undefined}>{line.text}</p>
      ))}
    </div>
  );
}

function foldCaption(captions: LiveCaption[], who: "user" | "assistant", text: string, partial: boolean, itemId?: string, order?: number): LiveCaption[] {
  if (itemId) {
    const index = captions.findIndex(line => line.itemId === itemId && line.who === who);
    const next = captions.map(line => ({ ...line }));
    const line: LiveCaption = { who, text, live: partial, itemId, order };
    if (index === -1) next.push(line); else next[index] = line;
    return next.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  }
  const clean = who === "user" ? mergeUtterance("", text) : text.trim();
  if (!clean) return captions;
  const next = captions.map(line => ({ ...line }));
  const last = next[next.length - 1];
  const merged = last && who === "user" ? mergeUtterance(last.text, clean) : clean;
  const revised = Boolean(last && who === "user" && merged === clean);
  const same = last?.who === who && (last.live || clean.startsWith(last.text) || last.text.startsWith(clean) || revised);
  if (last && same) {
    next[next.length - 1] = { who, text: who === "user" ? merged : clean, live: partial };
  } else {
    next.push({ who, text: clean, live: partial });
  }
  return next;
}

function leafName(label: string): string {
  const name = label.split(/[/\\]/).pop();
  return name || label;
}

function OpenStrip({
  openItems,
  catalog,
  activeKey,
  placeholder,
  addLabel,
  closeLabel,
  onOpen,
  onClose,
}: {
  openItems: Array<{ key: string; label: string }>;
  catalog: Array<{ key: string; label: string }>;
  activeKey: string | null;
  placeholder: string;
  addLabel: string;
  closeLabel: string;
  onOpen: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const openKeys = new Set(openItems.map((item) => item.key));
  const closed = catalog.filter((item) => !openKeys.has(item.key));
  const needle = query.trim().toLowerCase();
  const choices = needle
    ? closed.filter((item) => item.label.toLowerCase().includes(needle) || item.key.toLowerCase().includes(needle))
    : closed;
  return (
    <div className="open-strip">
      <div className="open-row">
        <div className="open-scroll">
          {openItems.map((item) => (
            <span className={item.key === activeKey ? "open-chip on" : "open-chip"} key={item.key}>
              <button className="name" type="button" title={item.label} onClick={() => onOpen(item.key)}>{leafName(item.label)}</button>
              <button className="close" type="button" title={closeLabel} onClick={() => onClose(item.key)}><X size={13} /></button>
            </span>
          ))}
          {picking ? (
            <input
              className="open-find"
              value={query}
              placeholder={placeholder}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {picking ? choices.map((item) => (
            <button
              className="open-choice"
              key={item.key}
              type="button"
              title={item.label}
              onClick={() => { onOpen(item.key); setPicking(false); setQuery(""); }}
            >{leafName(item.label)}</button>
          )) : null}
        </div>
        <button
          className={picking ? "open-add on" : "open-add"}
          type="button"
          title={addLabel}
          onClick={() => {
            if (picking) {
              setPicking(false);
              setQuery("");
              return;
            }
            if (closed.length === 0) return;
            setPicking(true);
          }}
        ><Plus size={15} /></button>
      </div>
    </div>
  );
}

function FileStage({
  slug,
  library,
  file,
  openIds,
  menu,
  copy,
  onPick,
  onClose,
}: {
  slug: string;
  library: LibraryItem[];
  file: { id: string; filename: string; page: number; requestId?: string } | null;
  openIds: string[];
  menu: boolean;
  copy: Copy;
  onPick: (file: LibraryItem) => void;
  onClose: (id: string) => void;
}) {
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  return (
    <div className="file-stage">
      {menu ? (
      <OpenStrip
        openItems={openIds.flatMap((id) => {
          const entry = byId.get(id);
          return entry ? [{ key: entry.id, label: entry.filename }] : [];
        })}
        catalog={library.map((entry) => ({ key: entry.id, label: entry.filename }))}
        activeKey={file?.id ?? null}
        placeholder={copy.findFile}
        addLabel={copy.openFromLibrary}
        closeLabel={copy.closeTab}
        onOpen={(key) => {
          const entry = byId.get(key);
          if (entry) onPick(entry);
        }}
        onClose={onClose}
      />
      ) : null}
      {file && slug ? <Suspense fallback={<p className="empty">Loading…</p>}><DocumentReader slug={slug} file={file} /></Suspense> : <p className="empty">{copy.pickFile}</p>}
    </div>
  );
}

function CanvasStage({
  slug,
  pages,
  canvas,
  openPaths,
  menu,
  copy,
  onPick,
  onClose,
}: {
  slug: string;
  pages: CanvasPage[];
  canvas: { title: string; html: string; page: number; requestId?: string } | null;
  openPaths: string[];
  menu: boolean;
  copy: Copy;
  onPick: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState(canvas?.page ?? 1);
  const [totalPages, setTotalPages] = useState(0);
  const [pageError, setPageError] = useState("");
  useEffect(() => { setPage(canvas?.page ?? 1); }, [canvas?.title, canvas?.page, canvas?.requestId]);
  useEffect(() => {
    if (!canvas) return;
    const listener = (event: MessageEvent) => {
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
  const openItems = openPaths.map((path) => ({ key: path, label: path }));
  return (
    <div className="canvas-stage">
      {menu ? (
      <OpenStrip
        openItems={openItems}
        catalog={pages.map((entry) => ({ key: entry.path, label: entry.path }))}
        activeKey={canvas?.title ?? null}
        placeholder={copy.findPage}
        addLabel={copy.openFromLibrary}
        closeLabel={copy.closeTab}
        onOpen={onPick}
        onClose={onClose}
      />
      ) : null}
      {canvas ? <div className="reader-toolbar"><Frame size={14} /><span>{canvas.title}</span><div className="reader-pager"><button type="button" aria-label="Previous page / 上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ArrowLeft size={15} /></button><span>{page} / {totalPages || "…"}</span><button type="button" aria-label="Next page / 下一页" disabled={!totalPages || page >= totalPages} onClick={() => setPage(page + 1)}><ArrowRight size={15} /></button></div></div> : null}
      {pageError ? <p className="reader-error" role="alert">{pageError}</p> : null}
      {canvas && slug ? (
        <iframe
          ref={frameRef}
          className="canvas-frame"
          title={canvas.title}
          sandbox="allow-scripts"
          srcDoc={withCanvasPager(canvas.html)}
          onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: "xiaowang:page", page, requestId: canvas.requestId }, "*")}
        />
      ) : (
        <p className="empty">{copy.emptyCanvas}</p>
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="field" aria-label={label}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={16} strokeWidth={1.75} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="menu" position="popper" sideOffset={6} collisionPadding={12}>
          <Select.Viewport className="menu-scroll">
            {options.map((option) => (
              <Select.Item className="menu-item" key={option.value} value={option.value}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={14} strokeWidth={1.75} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function SettingsPanel({
  settings,
  forced,
  onClose,
  onSave,
}: {
  settings: AppState["settings"] | undefined;
  forced: boolean;
  onClose: () => void;
  onSave: (patch: SettingsPatch) => Promise<void>;
}) {
  const saved = resolveRealtime({
    service: settings?.realtimeService,
    model: settings?.realtimeModel,
    voice: settings?.realtimeVoice,
    region: settings?.realtimeRegion,
    workspace: settings?.realtimeWorkspace,
    url: settings?.realtimeUrl,
  });
  const [model, setModel] = useState(settings?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? "");
  const [apiStyle, setApiStyle] = useState(settings?.apiStyle ?? "");
  const [apiKey, setApiKey] = useState("");
  const [service, setService] = useState<RealtimeServiceId>(saved.service);
  const [realtimeModel, setRealtimeModel] = useState(saved.model);
  const [voice, setVoice] = useState(saved.voice);
  const [region, setRegion] = useState<RealtimeRegion>(saved.region);
  const [workspace, setWorkspace] = useState(saved.workspace);
  const [realtimeKey, setRealtimeKey] = useState("");
  const [searchProvider, setSearchProvider] = useState(settings?.searchProvider || "none");
  const [searchUrl, setSearchUrl] = useState(settings?.searchUrl || "");
  const [searchKey, setSearchKey] = useState("");
  const [locale, setLocale] = useState<Locale>(localeOf(settings?.locale));
  const [notice, setNotice] = useState("");
  const copy = copyFor(locale);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewAudio = useRef(createCallAudio(() => {}, (serial, callId) => window.xiaowang.callIdle(serial, callId), position => window.xiaowang.callPosition(position)));
  const patch: SettingsPatch = {
    model,
    baseUrl,
    apiStyle,
    apiKey,
    realtimeService: service,
    realtimeModel,
    realtimeVoice: voice,
    realtimeRegion: region,
    realtimeWorkspace: workspace,
    realtimeKey,
    searchProvider,
    searchUrl, searchKey,
    locale,
  };
  const voiceChoices = voicesFor(service, realtimeModel);
  const modelChoices = modelsFor(service);
  const needsWorkspace = service === "qwen";

  useEffect(() => {
    const audio = previewAudio.current;
    return window.xiaowang.onCall((note) => {
      if (!note.preview) return;
      if (note.phase === "live") {
        setPreviewing(true);
        void audio.startPlayback(note.outputRate ?? 24_000);
      }
      if (note.phase === "audio" && note.audio) audio.play(note.audio, note.serial, note.identity);
      if (note.phase === "closed") {
        setPreviewing(false);
        if (note.detail) setNotice(note.detail);
      }
    });
  }, []);
  useEffect(() => () => previewAudio.current.stop(), []);

  function chooseService(next: RealtimeServiceId) {
    const nextModel = modelsFor(next)[0]?.id ?? "";
    setService(next);
    setRealtimeModel(nextModel);
    setVoice(voicesFor(next, nextModel)[0]?.id ?? "");
  }

  function chooseRealtimeModel(next: string) {
    setRealtimeModel(next);
    const nextVoices = voicesFor(service, next);
    if (!nextVoices.some((item) => item.id === voice)) setVoice(nextVoices[0]?.id ?? "");
  }

  async function preview() {
    if (previewing) {
      await window.xiaowang.callStop();
      previewAudio.current.interrupt();
      setPreviewing(false);
      return;
    }
    setNotice("");
    try {
      await window.xiaowang.previewVoice(patch);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadModels() {
    setBusy(true);
    setNotice("");
    try {
      const ids = await window.xiaowang.listModels(patch);
      setModels(ids);
      if (ids.length > 0 && !ids.includes(model)) setModel(ids[0] ?? "");
      setNotice(ids.length > 0 ? `拿到 ${ids.length} 个模型` : "这个接口没有返回模型列表，可以直接填写模型名。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setNotice("");
    try {
      setNotice(await window.xiaowang.checkSettings(patch));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal">
      <form onSubmit={(event) => { event.preventDefault(); void onSave(patch); }}>
        <header>
          <strong>{forced ? copy.connectModel : copy.settings}</strong>
          <div className="lang" role="group" aria-label={copy.language}>
            <button type="button" className={locale === "zh" ? "on" : ""} onClick={() => setLocale("zh")}>中文</button>
            <button type="button" className={locale === "en" ? "on" : ""} onClick={() => setLocale("en")}>English</button>
          </div>
          {forced ? null : <button type="button" aria-label={copy.close} onClick={onClose}><X size={16} strokeWidth={1.75} /></button>}
        </header>
        <div className="columns">
        <section>
          <h2><MessageSquareText size={16} strokeWidth={1.75} />{copy.text}</h2>
          <label>{copy.style}
            <FieldSelect label={copy.style} value={apiStyle || "auto"} onChange={(value) => setApiStyle(value === "auto" ? "" : value)} options={[
              { value: "auto", label: copy.auto },
              { value: "openai", label: copy.openai },
              { value: "anthropic", label: copy.anthropic },
            ]} />
          </label>
          <label>{copy.baseUrl}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" /></label>
          <label>{copy.modelKey}<input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.keyHint || "····"} /></label>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void loadModels()}><RefreshCw size={15} strokeWidth={1.75} />{copy.fetchModels}</button>
            <button type="button" disabled={busy} onClick={() => void check()}><Check size={15} strokeWidth={1.75} />{copy.check}</button>
          </div>
          <label>{copy.model}
            {models.length > 0 ? (
              <FieldSelect label={copy.model} value={model} onChange={setModel} options={models.map((id) => ({ value: id, label: id }))} />
            ) : (
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat" />
            )}
          </label>
          <div className="search-config">
            <h2><Search size={16} strokeWidth={1.75} />{locale === "en" ? "Web search" : "网页搜索"}</h2>
            <label>{locale === "en" ? "Provider" : "搜索服务"}<FieldSelect label="Search provider" value={searchProvider} onChange={setSearchProvider} options={[{ value: "none", label: locale === "en" ? "Not configured" : "暂不配置" }, { value: "brave", label: "Brave" }, { value: "searxng", label: "SearxNG" }]} /></label>
            {searchProvider !== "none" ? <><label>{locale === "en" ? "Search URL" : "搜索地址"}<input value={searchUrl} onChange={event => setSearchUrl(event.target.value)} placeholder={searchProvider === "brave" ? "https://api.search.brave.com/res/v1/web/search" : "https://your-searxng.example"} /></label><label>{locale === "en" ? "Search key" : "搜索密钥"}<input type="password" value={searchKey} onChange={event => setSearchKey(event.target.value)} placeholder={settings?.searchKeyHint || "····"} /></label></> : null}
          </div>
        </section>
        <section>
          <h2><AudioLines size={16} strokeWidth={1.75} />{copy.callSection}</h2>
          <div className="field-block">
            <span>{copy.service}</span>
            <div className="with-action">
              <FieldSelect label={copy.service} value={service} onChange={(value) => chooseService(value as RealtimeServiceId)} options={REALTIME_SERVICES.map((item) => ({ value: item.id, label: item.name }))} />
              <button type="button" onClick={() => void window.xiaowang.openKeyPage(service, region)}><ExternalLink size={15} strokeWidth={1.75} />{copy.getKey}</button>
            </div>
          </div>
          {service === "qwen" ? (
            <label>{copy.region}
              <FieldSelect label={copy.region} value={region} onChange={(value) => setRegion(value as RealtimeRegion)} options={[
                { value: "beijing", label: copy.beijing },
                { value: "singapore", label: copy.singapore },
              ]} />
            </label>
          ) : null}
          {needsWorkspace ? (
            <label>{copy.workspace}<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder={copy.workspacePlaceholder} /></label>
          ) : null}
          <label>{copy.key}<input value={realtimeKey} type="password" onChange={(event) => setRealtimeKey(event.target.value)} placeholder={settings?.realtimeKeyHint || "····"} /></label>
          <label>{copy.model}
            <FieldSelect label={copy.model} value={realtimeModel} onChange={chooseRealtimeModel} options={modelChoices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))} />
          </label>
          <div className="field-block">
            <span>{copy.voice}</span>
            <div className="with-action">
              <FieldSelect label={copy.voice} value={voice} onChange={setVoice} options={voiceChoices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))} />
              <button type="button" onClick={() => void preview()}>{previewing ? <Square size={14} strokeWidth={1.75} /> : <Play size={15} strokeWidth={1.75} />}{previewing ? copy.stopPreview : copy.preview}</button>
            </div>
          </div>
        </section>
        </div>
        <footer>
          {notice ? <p>{notice}</p> : null}
          <button className="primary" type="submit">{copy.save}</button>
        </footer>
      </form>
    </div>
  );
}

function ProfileStage({
  bot,
  personName,
  library,
  copy,
  onRefresh,
  onForgot,
}: {
  bot: BotRow;
  personName: string;
  library: LibraryItem[];
  copy: Copy;
  onRefresh: () => Promise<void>;
  onForgot: (id: string) => void;
}) {
  const [name, setName] = useState(bot.name);
  const [notice, setNotice] = useState("");
  useEffect(() => setName(bot.name), [bot.slug, bot.name]);
  const entrance = bot.slug === "xiaowang";
  const ink = bot.avatarInk || (entrance ? "#18181B" : inkFor(bot.slug));
  return (
    <form
      className="profile"
      onSubmit={(event) => {
        event.preventDefault();
        void window.xiaowang.renameBot(bot.slug, name).then(() => setNotice("")).catch((error: unknown) => setNotice(plainError(error)));
      }}
    >
      <div className="hero">
        <Avatar slug={bot.slug} seed={bot.avatarSeed} ink={bot.avatarInk} size={96} />
        <button type="button" onClick={() => void window.xiaowang.setAvatar(bot.slug, { seed: nextAvatarSeed(bot.slug) })}>{copy.anotherFace}</button>
      </div>
      <div className="inks">
        {INK_CHOICES.map((color) => (
          <button
            key={color}
            type="button"
            className={color.toUpperCase() === ink.toUpperCase() ? "on" : ""}
            style={{ background: color }}
            title={color}
            onClick={() => void window.xiaowang.setAvatar(bot.slug, { ink: color })}
          />
        ))}
      </div>
      <label>{copy.name}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button className="primary" type="submit">{copy.saveName}</button>
      {notice ? <p>{notice}</p> : <p>{entrance ? copy.nextRound(name.trim() || personName) : copy.taskDisplayName}</p>}
      <div className="library-edit">
        <strong>{copy.materials}</strong>
        {library.map((entry) => (
          <div key={entry.id}>
            <span>{entry.filename}</span>
            <button type="button" onClick={() => void window.xiaowang.forgetFile(bot.slug, entry.id).then(() => { onForgot(entry.id); return onRefresh(); })}>{copy.remove}</button>
          </div>
        ))}
        {library.length === 0 ? <p>{copy.noMaterials}</p> : null}
        <button type="button" onClick={() => void window.xiaowang.addFiles().then(onRefresh)}>{copy.addMaterials}</button>
      </div>
    </form>
  );
}

function dragSize(event: React.PointerEvent<HTMLDivElement>, startWidth: number, setWidth: (width: number) => void, direction: 1 | -1) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const move = (next: PointerEvent) => {
    const nextWidth = startWidth + direction * (next.clientX - startX);
    const max = direction === 1 ? 420 : Math.max(360, window.innerWidth - 520);
    setWidth(Math.min(max, Math.max(direction === 1 ? 200 : 320, nextWidth)));
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

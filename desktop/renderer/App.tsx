import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, Download, LoaderCircle, Eye, MousePointer2, PanelRight, Phone, Plus, Search, Settings } from "lucide-react";
import { Avatar, nextAvatarSeed } from "./avatar.tsx";
import { INK_CHOICES, inkFor } from "./ink.ts";
import { playHangupSound } from "./call-sounds.ts";
import { createCallAudio } from "./call-audio.ts";
import { VoicePanel, type LiveCallView, type LiveCaption } from "./voice-panel.tsx";
import { CallTasks, ConversationIssue } from "./task-panel.tsx";
import { taskLayout } from "./task-view.ts";
import { RichText } from "./rich-text.tsx";
import { FileBrowser, rememberOpenedFile } from "./file-browser.tsx";
import { BotMenu, type BotMenuTarget } from "./bot-menu.tsx";
import { MessageComposer } from "./message-composer.tsx";
import { AttachmentChip } from "./message-attachments.tsx";
import type { Attachment } from "../../src/types.ts";
import { SettingsPanel } from "./settings-panel.tsx";
import { plainError } from "./errors.ts";
import { Workspace, FileStage, CanvasStage, workspaceResources, type StageSnap, type ResourceTab } from "./workspace.tsx";
import { copyFor, localeOf, type Copy, type Locale } from "./copy.ts";
import { updateDescription } from "./update-panel.tsx";
import { mergeUtterance } from "../../src/realtime.ts";
import type { AppState, BotRow, BrowserNote, CallNote, CanvasPage, ChatItem, TaskJob, LibraryItem, StageNote, TurnNote } from "./types.ts";

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
  const [itemsSlug, setItemsSlug] = useState("");
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [pages, setPages] = useState<CanvasPage[]>([]);
  const [openTabs, setOpenTabs] = useState<Record<string, OpenTabs>>(loadTabs);
  const [draftBySlug, setDraftBySlug] = useState<Record<string, string>>({});
  const [busyBySlug, setBusyBySlug] = useState<Record<string, boolean>>({});
  const [activityBySlug, setActivityBySlug] = useState<Record<string, string>>({});
  const [stageBySlug, setStageBySlug] = useState<Record<string, StageSnap>>({});
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [botName, setBotName] = useState("");
  const [botMenu, setBotMenu] = useState<BotMenuTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileBrowser, setFileBrowser] = useState<{ slug: string; mode: "file" | "canvas" } | null>(null);
  const [call, setCall] = useState<LiveCallView | null>(null);
  const audioRef = useRef(createCallAudio(
    (audio) => window.xiaowang.callAudio(audio),
    (serial, callId) => window.xiaowang.callIdle(serial, callId),
    position => window.xiaowang.callPosition(position),
    position => window.xiaowang.callChunkPlayed(position),
  ));
  const [toastNotice, setToastNotice] = useState<{ text: string } | null>(null);
  const toast = toastNotice?.text ?? "";
  // A fresh notice also restarts the timer when its text matches the previous one.
  const setToast = useCallback((text: string) => setToastNotice(text ? { text } : null), []);
  useEffect(() => {
    if (!toastNotice) return;
    const timer = setTimeout(() => setToastNotice(current => current === toastNotice ? null : current), 3000);
    return () => clearTimeout(timer);
  }, [toastNotice]);
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(252);
  const [canvasWide, setCanvasWide] = useState(false);
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false);
  const [browserBySlug, setBrowserBySlug] = useState<Record<string, BrowserNote>>({});
  const [address, setAddress] = useState("");
  const holeRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followThread = useRef(true);
  const activeRef = useRef("");
  const liveCallId = useRef("");
  const endedSoundId = useRef("");
  const active = state?.activeSlug ?? "";
  activeRef.current = active;
  const browser = browserBySlug[active] ?? { url: "", title: "", holder: "bot", loading: false };
  useEffect(() => { setAddress(browser.url); }, [active, browser.url]);
  const stage = stageBySlug[active] ?? EMPTY_STAGE;
  const mode = stage.mode;
  const file = stage.file;
  const canvas = stage.canvas;
  const stageOpen = stage.open;
  useEffect(() => { setResourceMenuOpen(false); }, [active, stageOpen]);
  useEffect(() => {
    if (active && (!stageOpen || mode !== "file" && mode !== "canvas" || mode === "file" && !file || mode === "canvas" && !canvas)) void window.xiaowang.stageHide(active);
    return () => { if (active) void window.xiaowang.stageHide(active); };
  }, [active, stageOpen, mode, file?.id, canvas?.title]);
  const copy = copyFor(localeOf(state?.settings.locale));
  const busy = Boolean(busyBySlug[active]) || Boolean(state?.jobs?.some(job => job.botId === state.bots.find(bot => bot.slug === active)?.id && (job.status === "running" || job.status === "queued")));
  const draft = draftBySlug[active] ?? "";
  const activity = activityBySlug[active] ?? "";
  const current = state?.bots.find((bot) => bot.slug === active);
  const currentJobs = (state?.jobs ?? []).filter(job => job.botId === current?.id);
  const workingJob = currentJobs.find(job => job.status === "running") ?? currentJobs.find(job => job.status === "queued");
  const visibleItems = itemsSlug === active ? items : [];
  const taskView = taskLayout(currentJobs, visibleItems);
  const conversationItems = visibleItems.filter(item => isConversation(item) && !taskView.hidden.has(item.id));
  const conversationWorking = currentJobs.find(job => !job.originCallId && job.channel !== "voice" && ["queued", "running"].includes(job.status));
  const showThinking = busy && (Boolean(conversationWorking) || !workingJob);
  const botBusy = (bot: BotRow) => Boolean(busyBySlug[bot.slug]) || Boolean(state?.jobs?.some(job => job.botId === bot.id && ["queued", "running"].includes(job.status)));
  const steward = state?.bots.find((bot) => bot.slug === "xiaowang");
  const ink = current?.avatarInk || inkFor(active || "xiaowang");
  const covered = resourceMenuOpen || Boolean(fileBrowser) || Boolean(botMenu) || settingsOpen || (state !== null && !state.settings.ready);


  function openBotMenu(event: React.MouseEvent<HTMLButtonElement>, bot: BotRow) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setBotMenu({ bot, x: event.clientX || rect.left + 20, y: event.clientY || rect.bottom, trigger: event.currentTarget });
  }

  function botMenuKey(event: React.KeyboardEvent<HTMLButtonElement>, bot: BotRow | undefined) {
    if (!bot || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
    event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
    setBotMenu({ bot, x: rect.left + 20, y: rect.bottom, trigger: event.currentTarget });
  }

  function receiveItems(slug: string, next: ChatItem[]) {
    if (activeRef.current !== slug) return;
    setItems(next);
    setItemsSlug(slug);
  }

  function workspaceError(slug: string, error: unknown) {
    // A cancellation can schedule a refresh just before deletion revokes the
    // bot's IPC access. Recheck ownership rather than leaving a rejected promise
    // or showing an error for a workspace the user has already removed.
    void window.xiaowang.getState().then(latest => {
      if (activeRef.current === slug && latest.bots.some(bot => bot.slug === slug)) setToast(plainError(error));
    }).catch(() => {});
  }

  function patchStage(slug: string, patch: Partial<StageSnap>) {
    if (!slug) return;
    setStageBySlug((prev) => ({ ...prev, [slug]: { ...EMPTY_STAGE, ...prev[slug], ...patch } }));
  }

  useEffect(() => {
    void window.xiaowang.getState().then(initial => { setState(initial); if (initial.updateNotice) setToast(initial.updateNotice); if (initial.browser) { setBrowserBySlug(previous => ({ ...previous, [initial.activeSlug]: initial.browser! })); } });
    const stops = [
      window.xiaowang.onJob(job => {
        setState(prev => prev ? { ...prev, jobs: [...(prev.jobs ?? []).filter(item => item.id !== job.id), job] } : prev);
        if (job.slug === activeRef.current) {
          void window.xiaowang.events(job.slug).then(items => receiveItems(job.slug, items)).catch(error => workspaceError(job.slug, error));
        }
      }),
      window.xiaowang.onState(setState),
      window.xiaowang.onUpdate(update => setState(prev => prev ? { ...prev, update } : prev)),
      window.xiaowang.onBrowser((next) => {
        if (next.slug) setBrowserBySlug(previous => ({ ...previous, [next.slug!]: next }));
      }),
      window.xiaowang.onDownload((note) => {
        setToast(note.error ? note.error : `已放入资料库 ${note.filename ?? ""}`);
        if (note.slug && note.slug === activeRef.current) void window.xiaowang.library(note.slug).then(refs => { if (activeRef.current === note.slug) setLibrary(refs); }).catch(error => workspaceError(note.slug!, error));
      }),
      window.xiaowang.onStage((view) => rememberStage(view)),
      window.xiaowang.onCall((note) => {
        void hearCall(note).catch(error => workspaceError(note.slug, error));
      }),
      window.xiaowang.onStep((step) => {
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
        void window.xiaowang.library(note.slug).then(refs => { if (activeRef.current === note.slug) setLibrary(refs); }).catch(error => workspaceError(note.slug, error));
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (!active) return;
    followThread.current = true;
    let cancelled = false;
    void Promise.all([window.xiaowang.events(active), window.xiaowang.library(active), window.xiaowang.pages(active)]).then(([events, refs, pages]) => {
      if (!cancelled && activeRef.current === active) { receiveItems(active, events); setLibrary(refs); setPages(pages); }
    }).catch(error => { if (!cancelled) setToast(plainError(error)); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (!active || mode !== "canvas") return;
    void window.xiaowang.pages(active).then(setPages).catch(() => setPages([]));
  }, [active, mode, canvas?.title]);

  useEffect(() => {
    if (followThread.current) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [items, busy, activity]);

  useEffect(() => {
    if (mode !== "browser" || covered || !stageOpen) {
      void window.xiaowang.browserBounds(null, active);
      return;
    }
    const node = holeRef.current;
    if (!node) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      void window.xiaowang.browserBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, active);
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [active, mode, covered, rightWidth, leftWidth, stageOpen]);

  useEffect(() => {
    if (!canvasWide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCanvasWide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasWide]);

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

  async function selectResource(resource: ResourceTab) {
    const slug = active;
    if (resource.kind === "file") {
      const entry = library.find(item => item.id === resource.path);
      patchStage(slug, { mode: "file", ...(entry && file?.id !== entry.id ? { file: { ...entry, page: 1, restore: true } } : {}) });
      return;
    }
    if (resource.kind !== "canvas" || !resource.path || canvas?.title === resource.path) {
      patchStage(slug, { mode: resource.kind });
      return;
    }
    try {
      if (resource.path.startsWith("library:")) {
        await window.xiaowang.openReference(slug, resource.path.slice(8).split("/")[0]!, 1);
      } else {
        const view = await window.xiaowang.openPage(slug, resource.path, 1);
        patchStage(slug, { mode: "canvas", open: true, canvas: { title: view.title, html: view.html, page: view.page, restore: true } });
      }
    } catch (error) { setToast(plainError(error)); }
  }

  function closeResource(resource: ResourceTab) {
    if (resource.kind === "file") {
      closeTab(active, "files", resource.path);
      if (file?.id === resource.path) patchStage(active, { file: null });
    } else if (resource.kind === "canvas") {
      closeTab(active, "pages", resource.path);
      if (canvas?.title === resource.path) patchStage(active, { canvas: null });
    } else patchStage(active, { mode: "file" });
  }

  function rememberStage(view: StageNote) {
    if (!view.slug) return;
    if (view.mode === "file") {
      pinTab(view.slug, "files", view.id);
      rememberOpenedFile(view.slug, `library:${view.id}`);
      void window.xiaowang.library(view.slug).then(refs => { if (activeRef.current === view.slug) setLibrary(refs); }).catch(error => workspaceError(view.slug, error));
      patchStage(view.slug, { mode: "file", open: true, file: { id: view.id, filename: view.filename, page: view.page, requestId: view.requestId, restore: view.restore } });
    } else if (view.mode === "browser") {
      patchStage(view.slug, { mode: "browser", open: true });
      if (view.url && view.slug === activeRef.current) setAddress(view.url);
    } else {
      pinTab(view.slug, "pages", view.title);
      rememberOpenedFile(view.slug, view.title.startsWith("library:") ? `library:${view.title.slice(8).split("/")[0]}` : `workspace:${view.title}`);
      patchStage(view.slug, { mode: "canvas", open: true, canvas: { title: view.title, html: view.html, page: view.page ?? 1, requestId: view.requestId } });
    }
  }

  async function sendMessage(attachments: Attachment[] = [], queueNew = false): Promise<boolean> {
    const slug = activeRef.current;
    const text = (draftBySlug[slug] ?? "").trim();
    if ((!text && !attachments.length) || !slug) return false;
    followThread.current = true;
    setDraftBySlug((prev) => ({ ...prev, [slug]: "" }));
    setBusyBySlug((prev) => ({ ...prev, [slug]: true }));
    setActivityBySlug((prev) => ({ ...prev, [slug]: "" }));
    setItems((currentItems) => [...(itemsSlug === slug ? currentItems : []), { id: -Date.now(), kind: "user", text, attachments }]);
    setItemsSlug(slug);
    try {
      const next = await window.xiaowang.ask(slug, text, attachments.map(a => a.refId), queueNew);
      if (activeRef.current === slug) {
        receiveItems(slug, next);
        void window.xiaowang.library(slug).then(refs => { if (activeRef.current === slug) setLibrary(refs); }).catch(error => workspaceError(slug, error));
      }
      return true;
    } catch (error) {
      workspaceError(slug, error);
      setDraftBySlug(previous => ({ ...previous, [slug]: previous[slug] ? `${text}\n${previous[slug]}` : text }));
      return false;
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
    if (note.phase === "visual") { setCall(prev => prev ? { ...prev, visual: note.visual } : prev); return; }
    if (note.phase === "state" && note.state) {
      setCall(prev => prev ? { ...prev, callId: note.callId || prev.callId, state: note.state } : note.state?.phase !== "ended" ? { slug: note.slug, callId: note.callId, phase: "connecting", captions: [], muted: false, audioReady: false, state: note.state } : null);
      return;
    }
    if (note.phase === "live") {
      setCall(prev => ({ slug: note.slug, callId: note.callId || prev?.callId, phase: "live", captions: prev?.captions ?? [], muted: false, audioReady: false, state: prev?.state, visual: prev?.visual }));
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
      const position = audioRef.current.interrupt(note.interruption);
      if (note.interruption) window.xiaowang.callInterrupted({ callId: note.interruption.callId, playbackEpoch: note.interruption.playbackEpoch, position });
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
      receiveItems(note.slug, await window.xiaowang.events(note.slug));
      return;
    }
    if (note.phase === "closed") {
      const id = note.callId || liveCallId.current;
      if (id && endedSoundId.current !== id) {
        endedSoundId.current = id;
        void playHangupSound();
      }
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
      window.xiaowang.callMute(muted);
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
  const wide = canvasWide && stageOpen;

  return (
    <div className={wide ? "shell canvas-wide" : "shell"}>
      <aside className="rail" style={{ width: leftWidth }}>
        <div className="traffic-space">
          <button className="icon" title={copy.search} aria-label={copy.search} type="button" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}><Search size={16} /></button>
          <button className="icon" title={copy.newTask} type="button" onClick={() => setCreating(true)}><Plus size={16} /></button>
        </div>
        <button className={active === "xiaowang" ? "steward on" : "steward"} type="button" onKeyDown={event => botMenuKey(event, steward)} onContextMenu={event => { if (steward) openBotMenu(event, steward); }} onClick={() => void window.xiaowang.setActive("xiaowang")}>
          <Avatar slug="xiaowang" seed={steward?.avatarSeed} ink={steward?.avatarInk} size={72} mood={steward && botBusy(steward) ? "think" : "idle"} />
          <strong>{steward?.name ?? "小王同学"}</strong>
        </button>
        <div className={searchOpen ? "search-line expanded" : "search-line"}>
          <input ref={searchInput} value={query} aria-label={copy.findTask} placeholder={copy.findTask} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {creating ? (
          <form className="new-bot" onSubmit={(event) => { event.preventDefault(); void createBot(); }}>
            <input autoFocus value={botName} placeholder={copy.taskName} onChange={(event) => setBotName(event.target.value)} />
          </form>
        ) : null}
        <nav>
          {bots.filter((bot) => bot.slug !== "xiaowang").map((bot) => (
            <button className={["bot", bot.slug === active ? "on" : "", botBusy(bot) ? "working" : ""].filter(Boolean).join(" ")} key={bot.slug} type="button" onKeyDown={event => botMenuKey(event, bot)} onContextMenu={event => openBotMenu(event, bot)} onClick={() => void window.xiaowang.setActive(bot.slug)}>
              <Avatar slug={bot.slug} seed={bot.avatarSeed} ink={bot.avatarInk} mood={botBusy(bot) ? "think" : "idle"} />
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
          {state?.update?.version ? <UpdateButton update={state.update} locale={localeOf(state.settings.locale)} onError={setToast} /> : null}
        </footer>
      </aside>

      <div className="split" onPointerDown={(event) => dragSize(event, leftWidth, setLeftWidth, 1)} />

      <main className="thread">
        <header>
          <button className={mode === "profile" && stageOpen ? "pill bot-title on" : "pill bot-title"} aria-expanded={mode === "profile" && stageOpen} title={current?.name ?? "小王同学"} type="button" onClick={openProfile}>
            <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={22} mood={busy ? "think" : "idle"} />
            <span className="bot-title-name">{current?.name ?? "小王同学"}</span>
            <ChevronRight size={14} />
          </button>
          <button className="icon stage-toggle" type="button" title={stageOpen ? copy.collapseStage : copy.expandStage} onClick={toggleStage}>
            <PanelRight size={16} />
          </button>
        </header>
        <div className="messages" ref={threadRef} onScroll={event => { const node = event.currentTarget; followThread.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
          {conversationItems.length === 0 && !busy ? <div className="welcome"><Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={ink} size={56} /><h1>{localeOf(state?.settings.locale) === "en" ? "What shall we explore?" : "今天一起研究什么？"}</h1><p>{localeOf(state?.settings.locale) === "en" ? "Bring a paper, ask a question, or start a voice conversation." : "放入一篇论文，提出一个问题，或直接与小王聊聊。"}</p></div> : null}
          {conversationItems.map(item => <div key={item.id} id={`message-${item.id}`} className="conversation-entry">
            <Message slug={active} item={item} ink={ink} name={current?.name || "小王同学"} copy={copy} jobs={taskView.byCall.get(item.callId ?? "") ?? []} locale={localeOf(state?.settings.locale)} onError={setToast} />
            {(taskView.chatIssues.get(item.id) ?? []).map(job => <ConversationIssue key={job.id} job={job} locale={localeOf(state?.settings.locale)} onError={setToast} />)}
          </div>)}
          {taskView.pendingChatIssues.map(job => <ConversationIssue key={job.id} job={job} locale={localeOf(state?.settings.locale)} onError={setToast} />)}
          {showThinking ? (
            <div className="thinking" role="status" aria-label={localeOf(state?.settings.locale) === "en" ? "Working" : "正在处理任务"}>
              <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={28} mood="think" />
              {activity || workingJob?.activity ? <em key={activity || workingJob?.activity}>{activity || workingJob?.activity}</em> : <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
            </div>
          ) : null}
        </div>
        {call && call.slug === active ? <VoicePanel call={call} audio={audioRef.current} jobs={taskView.byCall.get(call.callId ?? "") ?? []} onError={setToast} name={current?.name || "小王"} seed={current?.avatarSeed} ink={ink} locale={localeOf(state?.settings.locale)} onMute={toggleMute} onEnd={() => void endCall()} /> : call ? <button className="call-away" type="button" onClick={() => void window.xiaowang.setActive(call.slug)}><Phone size={14} />{localeOf(state?.settings.locale) === "en" ? "Return to your call" : "返回正在进行的通话"}</button> : null}
        <MessageComposer slug={active} draft={draft} placeholder={copy.message(current?.name ?? "")} busy={busy} inCall={Boolean(call)} ink={ink} en={localeOf(state?.settings.locale) === "en"}
          onDraft={value => { const slug = activeRef.current; setDraftBySlug(previous => ({ ...previous, [slug]: value })); }}
          onSend={sendMessage} onStop={() => void window.xiaowang.stop(active)} onCall={() => void toggleCall()} onError={setToast} />
      </main>

      {stageOpen ? <div className="split" onPointerDown={(event) => dragSize(event, rightWidth, setRightWidth, -1)} /> : null}

      {stageOpen ? (
      <aside className="stage" style={wide ? undefined : { width: rightWidth }}>
        <Workspace key={active} stage={stage} resources={workspaceResources(stage, library, pages, openTabs[active]?.files ?? [], openTabs[active]?.pages ?? [], copy, browser.title, current?.name ?? "小王同学")}
          copy={copy} locale={localeOf(state?.settings.locale)} wide={wide} onWide={() => setCanvasWide(value => !value)}
          onSelect={resource => void selectResource(resource)} onClose={closeResource}
          onBrowse={mode => setFileBrowser({ slug: active, mode })} onMenuOpen={setResourceMenuOpen}>
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
        {mode === "file" ? <FileStage slug={active} file={file} copy={copy} locale={localeOf(state?.settings.locale)} visualCallId={call?.slug === active && call.phase === "live" ? call.callId : undefined} /> : null}
        {mode === "canvas" ? <CanvasStage slug={active} canvas={canvas} copy={copy} /> : null}
        {mode === "browser" ? (
          <div className="browser-stage">
            <div className="browser-toolbar">
            <form className="url" onSubmit={(event) => { event.preventDefault(); void window.xiaowang.browserGo(address.startsWith("http") ? address : `https://${address}`); }}>
              <button type="button" aria-label={localeOf(state?.settings.locale) === "en" ? "Back" : "后退"} disabled={browser.holder === "bot"} onClick={() => void window.xiaowang.browserBack()}><ArrowLeft size={15} /></button>
              <button type="button" aria-label={localeOf(state?.settings.locale) === "en" ? "Forward" : "前进"} disabled={browser.holder === "bot"} onClick={() => void window.xiaowang.browserForward()}><ArrowRight size={15} /></button>
              <input aria-label={localeOf(state?.settings.locale) === "en" ? "Address" : "网页地址"} value={address} disabled={browser.holder === "bot"} placeholder="https://" onChange={(event) => setAddress(event.target.value)} />
            </form>
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
            <div className="hole" ref={holeRef} />
          </div>
        ) : null}
        </Workspace>
      </aside>
      ) : null}

      {fileBrowser ? <FileBrowser key={`${fileBrowser.slug}:${fileBrowser.mode}`} slug={fileBrowser.slug} name={state?.bots.find(bot => bot.slug === fileBrowser.slug)?.name || fileBrowser.slug} mode={fileBrowser.mode} locale={localeOf(state?.settings.locale)} onClose={() => setFileBrowser(null)} onOpen={async entry => {
        if (entry.source === "library" && entry.refId) {
          if (entry.preview === "canvas") await window.xiaowang.openReference(fileBrowser.slug, entry.refId, 1);
          else { pinTab(fileBrowser.slug, "files", entry.refId); patchStage(fileBrowser.slug, { mode: "file", open: true, file: { id: entry.refId, filename: entry.name, page: 1, restore: true } }); }
        } else await window.xiaowang.openArtifact(fileBrowser.slug, entry.path);
      }} /> : null}

      {settingsOpen || (state !== null && !state.settings.ready) ? (
        <SettingsPanel
          settings={state?.settings}
          version={state?.version || ""}
          update={state?.update}
          forced={state !== null && !state.settings.ready}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            const next = await window.xiaowang.saveSettings(patch);
            setState((currentState) => currentState ? { ...currentState, settings: next } : currentState);
            setSettingsOpen(false);
          }}
        />
      ) : null}
      {botMenu ? <BotMenu key={botMenu.bot.id} target={botMenu} locale={localeOf(state?.settings.locale)} activeSlug={active} onClose={() => setBotMenu(null)} onDeleted={slug => {
        setOpenTabs(prev => { const next = { ...prev }; delete next[slug]; saveTabs(next); return next; });
        setDraftBySlug(prev => { const next = { ...prev }; delete next[slug]; return next; });
        setStageBySlug(prev => { const next = { ...prev }; delete next[slug]; return next; });
        setBusyBySlug(prev => { const next = { ...prev }; delete next[slug]; return next; });
        setActivityBySlug(prev => { const next = { ...prev }; delete next[slug]; return next; });
      }} /> : null}
      {toast ? <button className="toast" type="button" aria-live="polite" onClick={() => setToast("")}>{toast}</button> : null}
    </div>
  );
}

function UpdateButton({ update, locale, onError }: { update: import("./types.ts").UpdateState; locale: Locale; onError: (error: string) => void }) {
  const en = locale === "en";
  const active = ["checking", "downloading", "verifying", "installing"].includes(update.phase);
  const label = `${updateDescription(update, en)}${update.version ? ` · v${update.version}` : ""}`;
  async function install() {
    try { const next = await window.xiaowang.updateApp(); if (next.phase === "error") onError(next.error || (en ? "Update failed" : "更新失败")); }
    catch (error) { onError(plainError(error)); }
  }
  return <button className={`update-button${update.phase === "downloading" ? " has-progress" : ""}`} style={{ "--update-angle": `${(update.percent ?? 0) * 3.6}deg` } as React.CSSProperties} type="button" aria-label={label} title={label} disabled={active || update.phase === "ready"} onClick={() => void install()}>
    {active ? <LoaderCircle className="spin" size={17} /> : update.phase === "ready" ? <Check size={17} /> : <Download size={17} />}
  </button>;
}

function isConversation(item: ChatItem): boolean {
  return item.kind === "call" || (item.kind === "user" && Boolean(item.attachments?.length)) || ((item.kind === "user" || item.kind === "assistant") && item.text.trim().length > 0);
}

type MessageProps = { item: ChatItem; ink: string; name: string; copy: Copy; slug: string; jobs: TaskJob[]; locale: Locale; onError: (error: string) => void };

function Message({ item, ink, name, copy, slug, jobs, locale, onError }: MessageProps) {
  if (item.kind === "call") return <CallCard item={item} name={name} ink={ink} copy={copy} slug={slug} jobs={jobs} locale={locale} onError={onError} />;
  if (item.kind === "user") return item.attachments?.length ? <div className="user-message">
    <div className="message-attachments">{item.attachments.map(attachment => <AttachmentChip key={attachment.refId} slug={slug} attachment={attachment} onOpen={() => void window.xiaowang.openReference(slug, attachment.refId, 1).catch(error => onError(String(error)))} />)}</div>
    {item.text ? <div className="bubble user" style={{ background: ink }}>{item.text}</div> : null}
  </div> : <div className="bubble user" style={{ background: ink }}>{item.text}</div>;
  return (
    <div className="bubble assistant">
      <RichText slug={slug} text={item.text} />
    </div>
  );
}

function CallCard({ item, name, ink, copy, slug, jobs, locale, onError }: MessageProps) {
  const [open, setOpen] = useState(false);
  const seconds = item.seconds ?? 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <article className={`call-card${open ? " expanded" : ""}`} data-call-id={item.callId}>
      <button type="button" title={open ? copy.collapseCall : copy.expandCall} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Phone size={14} />
        <span>{name}</span>
        <span>{clock}</span>
        <ChevronDown size={14} />
      </button>
      {open ? <><CallLines lines={item.lines ?? []} ink={ink} /><CallTasks jobs={jobs} slug={slug} locale={locale} onError={onError} /></> : null}
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

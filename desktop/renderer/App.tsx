import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, ChevronUp, Download, LoaderCircle, ExternalLink, Eye, FileText, Frame, Globe, Maximize2, MessageSquareText, Mic, MicOff, Minimize2, MousePointer2, PanelRight, Phone, PhoneOff, Play, Plus, RefreshCw, Search, Settings, Square, X } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar, nextAvatarSeed } from "./avatar.tsx";
import { INK_CHOICES, inkFor } from "./ink.ts";
import { createCallAudio } from "./call-audio.ts";
import { VoicePanel, type LiveCallView, type LiveCaption } from "./voice-panel.tsx";
import { CallTasks, ConversationIssue } from "./task-panel.tsx";
import { taskLayout } from "./task-view.ts";
import { RichText } from "./rich-text.tsx";
import { FileBrowser, rememberOpenedFile } from "./file-browser.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { BotMenu, type BotMenuTarget } from "./bot-menu.tsx";
import { MessageComposer } from "./message-composer.tsx";
import { AttachmentChip } from "./message-attachments.tsx";
import type { Attachment } from "../../src/types.ts";
import { hasUnsavedSettings } from "./settings-draft.ts";
const DocumentReader = lazy(() => import("./document-reader.tsx").then(module => ({ default: module.DocumentReader })));
import { withCanvasPager } from "./canvas-pager.ts";
import { copyFor, localeOf, type Copy, type Locale } from "./copy.ts";
import { REALTIME_SERVICES, realtimeServicesForSettings, modelsFor, resolveRealtime, voicesFor, type RealtimeRegion, type RealtimeServiceId } from "../../src/realtime-catalog.ts";
import { UpdateCheckButton, UpdateProgress, updateDescription } from "./update-panel.tsx";
import { MossVoicePicker } from "./voice-picker.tsx";
import type { VoiceProfilePatch } from "../../src/settings.ts";
import { mergeUtterance } from "../../src/realtime.ts";
import type { AppState, BotRow, BrowserNote, CallNote, CanvasPage, ChatItem, TaskJob, LibraryItem, SettingsPatch, StageNote, TurnNote } from "./types.ts";

type StageSnap = {
  mode: "file" | "browser" | "canvas" | "profile";
  open: boolean;
  file: { id: string; filename: string; page: number; requestId?: string; restore?: boolean } | null;
  canvas: { title: string; html: string; page: number; requestId?: string; restore?: boolean } | null;
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
  const [itemsSlug, setItemsSlug] = useState("");
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
  const [toast, setToast] = useState("");
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(252);
  const [canvasWide, setCanvasWide] = useState(false);
  const [stageMenu, setStageMenu] = useState(true);
  const [browser, setBrowser] = useState<BrowserNote>({ url: "", title: "", holder: "bot", loading: false });
  const [address, setAddress] = useState("");
  const holeRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const followThread = useRef(true);
  const activeRef = useRef("");
  const liveCallId = useRef("");
  const active = state?.activeSlug ?? "";
  activeRef.current = active;
  const stage = stageBySlug[active] ?? EMPTY_STAGE;
  const mode = stage.mode;
  const file = stage.file;
  const canvas = stage.canvas;
  const stageOpen = stage.open;
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
  const covered = Boolean(fileBrowser) || Boolean(botMenu) || settingsOpen || (state !== null && !state.settings.ready);


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
    void window.xiaowang.getState().then(initial => { setState(initial); if (initial.updateNotice) setToast(initial.updateNotice); if (initial.browser) { setBrowser(initial.browser); setAddress(initial.browser.url); } });
    const stops = [
      window.xiaowang.onJob(job => {
        setState(prev => prev ? { ...prev, jobs: [...(prev.jobs ?? []).filter(item => item.id !== job.id), job] } : prev);
        if (["succeeded", "cancelled", "failed", "interrupted"].includes(job.status) && job.slug === activeRef.current) {
          void window.xiaowang.events(job.slug).then(items => receiveItems(job.slug, items)).catch(error => workspaceError(job.slug, error));
        }
      }),
      window.xiaowang.onState(setState),
      window.xiaowang.onUpdate(update => setState(prev => prev ? { ...prev, update } : prev)),
      window.xiaowang.onBrowser((next) => {
        setBrowser(next);
        setAddress(next.url);
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

  async function sendMessage(attachments: Attachment[] = []): Promise<boolean> {
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
      const next = await window.xiaowang.ask(slug, text, attachments.map(a => a.refId));
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
  const wide = canvasWide && mode === "canvas" && stageOpen;

  return (
    <div className={wide ? "shell canvas-wide" : "shell"}>
      <aside className="rail" style={{ width: leftWidth }}>
        <div className="traffic-space">
          <button className="icon" title={copy.search} type="button"><Search size={16} /></button>
          <button className="icon" title={copy.newTask} type="button" onClick={() => setCreating(true)}><Plus size={16} /></button>
        </div>
        <button className={active === "xiaowang" ? "steward on" : "steward"} type="button" onKeyDown={event => botMenuKey(event, steward)} onContextMenu={event => { if (steward) openBotMenu(event, steward); }} onClick={() => void window.xiaowang.setActive("xiaowang")}>
          <Avatar slug="xiaowang" seed={steward?.avatarSeed} ink={steward?.avatarInk} size={72} mood={steward && botBusy(steward) ? "think" : "idle"} />
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
            visualCallId={call?.slug === active && call.phase === "live" ? call.callId : undefined}
            slug={active}
            library={library}
            onBrowse={() => setFileBrowser({ slug: active, mode: "file" })}
            locale={localeOf(state?.settings.locale)}
            file={file}
            openIds={openTabs[active]?.files ?? []}
            menu={stageMenu}
            copy={copy}
            onPick={(entry) => {
              pinTab(active, "files", entry.id);
              patchStage(active, { file: { ...entry, page: 1, restore: true } });
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
            pages={[...pages, ...library.filter(item => /\.html?$/i.test(item.filename)).map(item => ({ path: `library:${item.id}/${item.filename}`, name: item.filename }))]}
            onBrowse={() => setFileBrowser({ slug: active, mode: "canvas" })}
            canvas={canvas}
            openPaths={openTabs[active]?.pages ?? []}
            menu={stageMenu}
            copy={copy}
            onPick={(path) => {
              pinTab(active, "pages", path);
              if (path.startsWith("library:")) { void window.xiaowang.openReference(active, path.slice(8).split("/")[0]!, 1).catch(error => setToast(plainError(error))); return; }
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
      {toast ? <button className="toast" type="button" onClick={() => setToast("")}>{toast}</button> : null}
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

function plainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': Error: /, "");
  if (message.includes("content or tool_calls")) return "模型服务拒绝了一条空的助手记录。再发一次就可以。";
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
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

function leafName(label: string): string {
  const name = label.split(/[/\\]/).pop();
  return name || label;
}

function OpenStrip({ openItems, activeKey, addLabel, closeLabel, onOpen, onClose, onBrowse }: {
  openItems: Array<{ key: string; label: string }>; activeKey: string | null;
  addLabel: string; closeLabel: string; onOpen(key: string): void; onClose(key: string): void; onBrowse(): void;
}) {
  return <div className="open-strip"><div className="open-row"><div className="open-scroll">{openItems.map(item => <span className={item.key === activeKey ? "open-chip on" : "open-chip"} key={item.key}><button className="name" type="button" title={item.label} onClick={() => onOpen(item.key)}>{leafName(item.label)}</button><button className="close" type="button" title={closeLabel} onClick={() => onClose(item.key)}><X size={13} /></button></span>)}</div><button className="open-add" type="button" title={addLabel} aria-label={addLabel} onClick={onBrowse}><Plus size={15} /></button></div></div>;
}

function FileStage({
  visualCallId,
  locale,
  slug,
  library,
  file,
  openIds,
  menu,
  copy,
  onPick,
  onBrowse,
  onClose,
}: {
  slug: string;
  library: LibraryItem[];
  file: { id: string; filename: string; page: number; requestId?: string; restore?: boolean } | null;
  openIds: string[];
  menu: boolean;
  copy: Copy;
  locale: Locale;
  visualCallId?: string;
  onPick: (file: LibraryItem) => void;
  onBrowse: () => void;
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
        activeKey={file?.id ?? null}
        onBrowse={onBrowse}
        addLabel={copy.openFromLibrary}
        closeLabel={copy.closeTab}
        onOpen={(key) => {
          const entry = byId.get(key);
          if (entry) onPick(entry);
        }}
        onClose={onClose}
      />
      ) : null}
      {file && slug ? <Suspense fallback={<p className="empty">Loading…</p>}><DocumentReader slug={slug} file={file} locale={locale} visualCallId={visualCallId} /></Suspense> : <p className="empty">{copy.pickFile}</p>}
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
  onBrowse,
  onClose,
}: {
  slug: string;
  pages: CanvasPage[];
  canvas: { title: string; html: string; page: number; requestId?: string; restore?: boolean } | null;
  openPaths: string[];
  menu: boolean;
  copy: Copy;
  onPick: (path: string) => void;
  onBrowse: () => void;
  onClose: (path: string) => void;
}) {
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
  const openItems = openPaths.map((path) => ({ key: path, label: pages.find(item => item.path === path)?.name || path }));
  return (
    <div className="canvas-stage">
      {menu ? (
      <OpenStrip
        openItems={openItems}
        activeKey={canvas?.title ?? null}
        onBrowse={onBrowse}
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
          key={canvas.title}
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
  version,
  update,
  forced,
  onClose,
  onSave,
}: {
  settings: AppState["settings"] | undefined;
  version: string;
  update?: import("./types.ts").UpdateState;
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
  const [clearVoiceKey, setClearVoiceKey] = useState(false);
  const [profileDrafts, setProfileDrafts] = useState<Partial<Record<RealtimeServiceId, VoiceProfilePatch>>>(() => Object.fromEntries(REALTIME_SERVICES.map(({ id }) => {
    const profile = settings?.realtimeProfiles?.[id];
    const choice = resolveRealtime({ service: id, ...(profile ?? (id === saved.service ? saved : {})) });
    return [id, { model: choice.model, voice: choice.voice, region: choice.region, workspace: choice.workspace, url: choice.url, key: "", clearKey: false }];
  })));
  const [locale, setLocale] = useState<Locale>(localeOf(settings?.locale));
  const [notice, setNotice] = useState("");
  const copy = copyFor(locale);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewAudio = useRef(createCallAudio(() => {}, (serial, callId) => window.xiaowang.callIdle(serial, callId), position => window.xiaowang.callPosition(position), position => window.xiaowang.callChunkPlayed(position)));
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
    locale,
    realtimeProfiles: { ...profileDrafts, [service]: { model: realtimeModel, voice, region, workspace, url: resolveRealtime({ service, model: realtimeModel, workspace, region }).url, key: realtimeKey, clearKey: clearVoiceKey } },
  };
  const initial = useRef(patch);
  const dirty = hasUnsavedSettings(patch, initial.current);
  const [exitIntent, setExitIntent] = useState<"panel" | "window" | "quit" | null>(null);
  const [saving, setSaving] = useState(false);
  const closeHandler = useRef<(intent: "panel" | "window" | "quit") => void>(() => {});
  closeHandler.current = requestClose;
  useEffect(() => { void window.xiaowang.settingsDirty(dirty); }, [dirty]);
  useEffect(() => {
    const stop = window.xiaowang.onSettingsClose(intent => closeHandler.current(intent));
    return () => { stop(); void window.xiaowang.settingsDirty(false); };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (exitIntent) { setExitIntent(null); return; }
      if (!forced) closeHandler.current("panel");
    };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [exitIntent, forced]);
  function requestClose(intent: "panel" | "window" | "quit") {
    if (saving) return;
    if (dirty) setExitIntent(intent);
    else void closeSettings(intent);
  }
  async function closeSettings(intent: "panel" | "window" | "quit") {
    await window.xiaowang.settingsDirty(false);
    if (intent !== "panel") await window.xiaowang.finishSettingsClose(intent);
    onClose();
  }
  async function save(intent: "panel" | "window" | "quit" = "panel") {
    setSaving(true); setNotice("");
    try {
      await onSave(patch);
      await window.xiaowang.settingsDirty(false);
      if (intent !== "panel") await window.xiaowang.finishSettingsClose(intent);
    } catch (reason) { setNotice(plainError(reason)); setExitIntent(null); }
    finally { setSaving(false); }
  }
  const voiceChoices = voicesFor(service, realtimeModel);
  const modelChoices = modelsFor(service);
  const needsWorkspace = service === "qwen";

  useEffect(() => {
    const audio = previewAudio.current;
    return window.xiaowang.onCall((note) => {
      if (!note.preview) return;
      if (note.phase === "live") {
        setPreviewing(true);
        audio.stop();
        void audio.startPlayback(note.outputRate ?? 24_000);
      }
      if (note.phase === "audio" && note.audio) audio.play(note.audio, note.serial, note.identity);
      if (note.phase === "interrupt") {
        const position = audio.interrupt(note.interruption);
        if (note.interruption) window.xiaowang.callInterrupted({ callId: note.interruption.callId, playbackEpoch: note.interruption.playbackEpoch, position });
      }
      if (note.phase === "closed") {
        setPreviewing(false);
        if (note.detail) setNotice(note.detail);
      }
    });
  }, []);
  useEffect(() => () => previewAudio.current.stop(), []);

  function chooseService(next: RealtimeServiceId) {
    const profiles = patch.realtimeProfiles!;
    setProfileDrafts(profiles);
    const profile = profiles[next] ?? {};
    const choice = resolveRealtime({ service: next, ...profile });
    setService(next);
    setRealtimeModel(choice.model); setVoice(choice.voice); setRegion(choice.region); setWorkspace(choice.workspace);
    setRealtimeKey(profile.key ?? ""); setClearVoiceKey(profile.clearKey === true);
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
    setPreviewing(true);
    try {
      await window.xiaowang.previewVoice(patch);
    } catch (error) {
      setPreviewing(false);
      setNotice(plainError(error));
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
    <div className="modal settings-modal" onMouseDown={event => { if (event.target === event.currentTarget && !forced) requestClose("panel"); }}>
      <form aria-label={copy.settings} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <header>
          <strong>{forced ? copy.connectModel : copy.settings}</strong>
          <span className="app-version">{locale === "en" ? "Version" : "版本"} {version}</span>
          <UpdateCheckButton update={update} en={locale === "en"} onResult={setNotice} />
          <div className="lang" role="group" aria-label={copy.language}>
            <button type="button" className={locale === "zh" ? "on" : ""} onClick={() => setLocale("zh")}>中文</button>
            <button type="button" className={locale === "en" ? "on" : ""} onClick={() => setLocale("en")}>English</button>
          </div>
          {forced ? null : <button type="button" aria-label={copy.close} onClick={() => requestClose("panel")}><X size={16} strokeWidth={1.75} /></button>}
        </header>
        <UpdateProgress update={update} en={locale === "en"} />
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
        </section>
        <section>
          <h2><AudioLines size={16} strokeWidth={1.75} />{copy.callSection}</h2>
          <div className="field-block">
            <span>{copy.service}</span>
            <div className="with-action">
              <FieldSelect label={copy.service} value={service} onChange={(value) => chooseService(value as RealtimeServiceId)} options={realtimeServicesForSettings(settings?.experimentalMossEnabled, settings?.geminiEnabled).map((item) => ({ value: item.id, label: item.name }))} />
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
          <div className="field-block"><div className="voice-key-heading"><label htmlFor="realtime-key">{copy.key}</label>{(settings?.realtimeProfiles?.[service]?.keyHint || (service === saved.service && settings?.realtimeKeyHint)) ? <button className="clear-voice-key" type="button" onClick={() => { setClearVoiceKey(!clearVoiceKey); setRealtimeKey(""); }}>{clearVoiceKey ? locale === "en" ? "Undo key removal" : "撤销密钥清除" : locale === "en" ? "Remove saved key" : "清除已保存密钥"}</button> : null}</div>
          <input id="realtime-key" data-testid="voice-key" value={realtimeKey} type="password" onChange={(event) => { setRealtimeKey(event.target.value); setClearVoiceKey(false); }} placeholder={clearVoiceKey ? "" : settings?.realtimeProfiles?.[service]?.keyHint || (service === saved.service ? settings?.realtimeKeyHint : "") || (locale === "en" ? "Not configured" : "未配置")} />
          {clearVoiceKey ? <small>{locale === "en" ? "Saving will remove this provider’s key." : "保存后将清除此服务的密钥。"}</small> : null}</div>
          <label>{copy.model}
            <FieldSelect label={copy.model} value={realtimeModel} onChange={chooseRealtimeModel} options={modelChoices.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))} />
          </label>
          <div className="field-block">
            <span>{copy.voice}</span>
            <div className="with-action">
              {service === "moss" ? <MossVoicePicker value={voice} onChange={setVoice} patch={patch} keyHint={clearVoiceKey ? "" : settings?.realtimeProfiles?.moss?.keyHint || (saved.service === "moss" ? settings?.realtimeKeyHint ?? "" : "")} en={locale === "en"} /> : <FieldSelect label={copy.voice} value={voice} onChange={setVoice} options={voiceChoices.map((item) => ({ value: item.id, label: item.name === item.id ? item.name : `${item.name} · ${item.id}` }))} />}
              <button className="voice-preview" type="button" aria-label={previewing ? copy.stopPreview : copy.preview} title={previewing ? copy.stopPreview : copy.preview} onClick={() => void preview()}>{previewing ? <Square size={14} strokeWidth={1.75} /> : <Play size={15} strokeWidth={1.75} />}</button>
            </div>
          </div>
        </section>
        </div>
        <footer>
          {notice ? <p>{notice}</p> : null}
          <button className="primary" type="submit" disabled={saving}>{saving ? (locale === "en" ? "Saving…" : "正在保存…") : copy.save}</button>
        </footer>
      </form>
      {exitIntent ? <ModalDialog className="unsaved-dialog" label={locale === "en" ? "Save your changes?" : "保存设置更改？"} onCancel={() => { if (!saving) setExitIntent(null); }}><div role="alertdialog" aria-labelledby="unsaved-title" aria-describedby="unsaved-description">
        <h2 id="unsaved-title">{locale === "en" ? "Save your changes?" : "保存设置更改？"}</h2>
        <p id="unsaved-description">{locale === "en" ? "Your settings have unsaved changes. You can save them before leaving, or keep editing." : "设置中有尚未保存的更改。你可以保存后退出，或返回继续编辑。"}</p>
        <div><button autoFocus type="button" disabled={saving} onClick={() => setExitIntent(null)}>{locale === "en" ? "Keep editing" : "继续编辑"}</button><button type="button" disabled={saving} onClick={() => void closeSettings(exitIntent)}>{locale === "en" ? "Discard changes" : "放弃修改"}</button><button className="primary" type="button" disabled={saving} onClick={() => void save(exitIntent)}>{locale === "en" ? "Save and close" : "保存并关闭"}</button></div>
      </div></ModalDialog> : null}
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

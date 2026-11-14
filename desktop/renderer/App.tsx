import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, ExternalLink, Eye, FileText, Frame, Globe, MessageSquareText, Mic, MicOff, MousePointer2, PanelRight, Phone, PhoneOff, Play, Plus, RefreshCw, Search, Settings, Square, X } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar, nextAvatarSeed } from "./avatar.tsx";
import { INK_CHOICES, inkFor } from "./ink.ts";
import { createCallAudio } from "./call-audio.ts";
import { copyFor, localeOf, type Copy, type Locale } from "./copy.ts";
import { REALTIME_SERVICES, modelsFor, resolveRealtime, voicesFor, type RealtimeRegion, type RealtimeServiceId } from "../../src/realtime-catalog.ts";
import { mergeUtterance } from "../../src/realtime.ts";
import type { AppState, BotRow, BrowserNote, CallNote, ChatItem, LibraryItem, SettingsPatch, StageNote } from "./types.ts";

type StageSnap = {
  mode: "file" | "browser" | "canvas" | "profile";
  open: boolean;
  file: { id: string; filename: string; page: number } | null;
  canvas: { title: string; html: string } | null;
};

const EMPTY_STAGE: StageSnap = { mode: "file", open: true, file: null, canvas: null };

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [draftBySlug, setDraftBySlug] = useState<Record<string, string>>({});
  const [busyBySlug, setBusyBySlug] = useState<Record<string, boolean>>({});
  const [activityBySlug, setActivityBySlug] = useState<Record<string, string>>({});
  const [stageBySlug, setStageBySlug] = useState<Record<string, StageSnap>>({});
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [botName, setBotName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [call, setCall] = useState<LiveCallView | null>(null);
  const audioRef = useRef(createCallAudio(
    (audio) => window.xiaowang.callAudio(audio),
    (serial) => window.xiaowang.callIdle(serial),
  ));
  const [toast, setToast] = useState("");
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(252);
  const [browser, setBrowser] = useState<BrowserNote>({ url: "", title: "", holder: "bot", loading: false });
  const [address, setAddress] = useState("");
  const holeRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef("");
  const active = state?.activeSlug ?? "";
  activeRef.current = active;
  const stage = stageBySlug[active] ?? EMPTY_STAGE;
  const mode = stage.mode;
  const file = stage.file;
  const canvas = stage.canvas;
  const stageOpen = stage.open;
  const copy = copyFor(localeOf(state?.settings.locale));
  const busy = Boolean(busyBySlug[active]);
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
      window.xiaowang.onState(setState),
      window.xiaowang.onBrowser((next) => {
        setBrowser(next);
        setAddress(next.url);
      }),
      window.xiaowang.onDownload((note) => {
        setToast(note.error ? note.error : `已放入资料库 ${note.filename ?? ""}`);
        if (note.slug && note.slug === activeRef.current) void window.xiaowang.library(note.slug).then(setLibrary);
      }),
      window.xiaowang.onStage((view) => rememberStage(view)),
      window.xiaowang.onCall((note) => {
        void hearCall(note);
      }),
      window.xiaowang.onStep((step) => {
        if (!step.activity?.trim()) return;
        setActivityBySlug((prev) => ({ ...prev, [step.slug]: step.activity!.trim() }));
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (!active) return;
    void window.xiaowang.events(active).then(setItems);
    void window.xiaowang.library(active).then(setLibrary);
  }, [active]);

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

  function rememberStage(view: StageNote) {
    if (!view.slug) return;
    if (view.mode === "file") patchStage(view.slug, { mode: "file", open: true, file: { id: view.id, filename: view.filename, page: view.page } });
    else if (view.mode === "browser") {
      patchStage(view.slug, { mode: "browser", open: true });
      if (view.url && view.slug === activeRef.current) setAddress(view.url);
    } else patchStage(view.slug, { mode: "canvas", open: true, canvas: { title: view.title, html: view.html } });
  }

  async function sendMessage() {
    const slug = activeRef.current;
    const text = (draftBySlug[slug] ?? "").trim();
    if (!text || !slug || busyBySlug[slug]) return;
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
      setBusyBySlug((prev) => ({ ...prev, [slug]: false }));
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
    if (note.phase === "live") {
      setCall({ phase: "live", captions: [], muted: false });
      try {
        await audioRef.current.start(note.inputRate || 16_000, note.outputRate || 24_000);
      } catch (error) {
        audioRef.current.stop();
        setCall(null);
        setToast(plainError(error));
        void window.xiaowang.callStop();
      }
      return;
    }
    if (note.phase === "audio" && note.audio) {
      audioRef.current.play(note.audio, note.serial);
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
      setCall((currentCall) => currentCall ? { ...currentCall, captions: foldCaption(currentCall.captions, who, text, partial) } : currentCall);
      return;
    }
    if (note.phase === "saved" && note.slug === activeRef.current) {
      setItems(await window.xiaowang.events(note.slug));
      return;
    }
    if (note.phase === "closed") {
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
    setCall({ phase: "connecting", captions: [], muted: false });
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

  return (
    <div className="shell">
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
        {call ? (
          <section className="call-stage">
            <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={88} mood={callMood(call)} />
            <p>{callStatus(call, copy)}</p>
            <CallLines lines={call.captions} ink={ink} />
            <div className="call-controls">
              <button type="button" title={call.muted ? copy.unmute : copy.mute} onClick={toggleMute}>
                {call.muted ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
              <button className="end" type="button" title={copy.hangup} onClick={() => void endCall()}><PhoneOff size={16} /></button>
            </div>
          </section>
        ) : null}
        <div className="messages" ref={threadRef}>
          {items.filter(isConversation).map((item) => <Message key={item.id} item={item} ink={ink} name={current?.name || "小王同学"} copy={copy} />)}
          {busy ? (
            <div className="thinking">
              <Avatar slug={active || "xiaowang"} seed={current?.avatarSeed} ink={current?.avatarInk} size={28} mood="think" />
              {activity ? <em key={activity}>{activity}</em> : <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
            </div>
          ) : null}
        </div>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <button className="icon" type="button" title={copy.addToLibrary} onClick={() => void window.xiaowang.addFiles().then(() => active && window.xiaowang.library(active).then(setLibrary))}><Plus size={18} /></button>
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
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <button className="icon" type="button" title={copy.dictateLater}><Mic size={18} /></button>
          {busy ? <button className="call stop" type="button" title={copy.stop} onClick={() => void window.xiaowang.stop(active)}><Square size={14} /></button> : null}
          <button className={call ? "call stop" : "call"} style={call ? undefined : { background: ink }} type="button" title={call ? copy.hangup : copy.call} onClick={() => void toggleCall()}>
            {call ? <PhoneOff size={16} /> : <><span /><span /><span /><span /></>}
          </button>
        </form>
      </main>

      {stageOpen ? <div className="split" onPointerDown={(event) => dragSize(event, rightWidth, setRightWidth, -1)} /> : null}

      {stageOpen ? (
      <aside className="stage" style={{ width: rightWidth }}>
        <div className="stage-tabs">
          <button className={mode === "file" ? "on" : ""} type="button" onClick={() => patchStage(active, { mode: "file" })}><FileText size={15} /> {copy.files}</button>
          <button className={mode === "browser" ? "on" : ""} type="button" onClick={() => patchStage(active, { mode: "browser" })}><Globe size={15} /> {copy.browser}</button>
          <button className={mode === "canvas" ? "on" : ""} type="button" onClick={() => patchStage(active, { mode: "canvas" })}><Frame size={15} /> {copy.canvas}</button>
        </div>
        {mode === "profile" && current ? (
          <ProfileStage
            bot={current}
            personName={steward?.name ?? "小王同学"}
            copy={copy}
            library={library}
            onRefresh={async () => setLibrary(await window.xiaowang.library(current.slug))}
            onForgot={(id) => {
              if (file?.id === id) patchStage(current.slug, { file: null });
            }}
          />
        ) : null}
        {mode === "file" ? (
          <FileStage slug={active} library={library} file={file} copy={copy} onPick={(entry) => patchStage(active, { file: { ...entry, page: 1 } })} />
        ) : null}
        {mode === "canvas" ? <CanvasStage canvas={canvas} copy={copy} /> : null}
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

function Message({ item, ink, name, copy }: { item: ChatItem; ink: string; name: string; copy: Copy }) {
  if (item.kind === "call") return <CallCard item={item} name={name} ink={ink} copy={copy} />;
  if (item.kind === "user") return <div className="bubble user" style={{ background: ink }}>{item.text}</div>;
  return (
    <div className="bubble assistant">
      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
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

interface LiveCaption {
  who: "user" | "assistant";
  text: string;
  live: boolean;
}

interface LiveCallView {
  phase: "connecting" | "live";
  captions: LiveCaption[];
  muted: boolean;
}

function foldCaption(captions: LiveCaption[], who: "user" | "assistant", text: string, partial: boolean): LiveCaption[] {
  const next = captions.slice(-6);
  const last = next[next.length - 1];
  const revised = Boolean(last && !last.live && !partial && mergeUtterance(last.text, text) === text);
  const same = last?.who === who && (last.live || text.startsWith(last.text) || last.text.startsWith(text) || revised);
  if (last && same) {
    next[next.length - 1] = { who, text, live: partial };
  } else {
    next.push({ who, text, live: partial });
  }
  return next.slice(-4);
}

function callStatus(call: LiveCallView, copy: Copy): string {
  if (call.phase === "connecting") return copy.connecting;
  const last = call.captions[call.captions.length - 1];
  if (last?.live && last.who === "user") return copy.listening;
  if (last?.live && last.who === "assistant") return copy.speaking;
  return copy.inCall;
}

function callMood(call: LiveCallView): "idle" | "think" {
  const last = call.captions[call.captions.length - 1];
  return last?.live && last.who === "assistant" ? "think" : "idle";
}

function FileStage({
  slug,
  library,
  file,
  copy,
  onPick,
}: {
  slug: string;
  library: LibraryItem[];
  file: { id: string; filename: string; page: number } | null;
  copy: Copy;
  onPick: (file: LibraryItem) => void;
}) {
  return (
    <div className="file-stage">
      <div className="file-list">
        {library.length === 0 ? <p>{copy.emptyLibrary}</p> : null}
        {library.map((entry) => (
          <button className={file?.id === entry.id ? "on" : ""} key={entry.id} type="button" onClick={() => onPick(entry)}>{entry.filename}</button>
        ))}
      </div>
      {file && slug ? <Reader slug={slug} file={file} /> : <p className="empty">{copy.pickFile}</p>}
    </div>
  );
}

function Reader({ slug, file }: { slug: string; file: { id: string; filename: string; page: number } }) {
  const [text, setText] = useState("");
  const isPdf = file.filename.toLowerCase().endsWith(".pdf");
  useEffect(() => {
    if (isPdf) return;
    let stop = false;
    void window.xiaowang.readFile(slug, file.id).then((bytes) => {
      if (stop) return;
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      setText(new TextDecoder().decode(data));
    });
    return () => {
      stop = true;
    };
  }, [slug, file.id, isPdf]);
  if (isPdf) {
    const src = `xwlib://view/${encodeURIComponent(slug)}/${encodeURIComponent(file.id)}#page=${file.page}`;
    return <iframe className="pdf-frame" title={file.filename} src={src} />;
  }
  if (file.filename.toLowerCase().endsWith(".md") || file.filename.toLowerCase().endsWith(".markdown")) {
    return <div className="prose"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;
  }
  return <pre className="plain">{text}</pre>;
}

function CanvasStage({ canvas, copy }: { canvas: { title: string; html: string } | null; copy: Copy }) {
  if (!canvas) return <p className="empty">{copy.emptyCanvas}</p>;
  return (
    <div className="canvas-stage">
      <iframe className="canvas-frame" title={canvas.title} sandbox="allow-scripts" srcDoc={canvas.html} />
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
  const [locale, setLocale] = useState<Locale>(localeOf(settings?.locale));
  const [notice, setNotice] = useState("");
  const copy = copyFor(locale);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewAudio = useRef(createCallAudio(() => {}));
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
  };
  const voiceChoices = voicesFor(service, realtimeModel);
  const modelChoices = modelsFor(service);
  const needsWorkspace = service === "qwen" && realtimeModel.startsWith("qwen3.8");

  useEffect(() => {
    const audio = previewAudio.current;
    return window.xiaowang.onCall((note) => {
      if (!note.preview) return;
      if (note.phase === "live") {
        setPreviewing(true);
        void audio.startPlayback(note.outputRate ?? 24_000);
      }
      if (note.phase === "audio" && note.audio) audio.play(note.audio);
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

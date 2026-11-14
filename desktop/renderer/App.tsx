import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Eye, FileText, Globe, Mic, MousePointer2, PanelRight, Plus, Presentation, Search, Settings, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar } from "./avatar.tsx";
import { inkFor } from "./ink.ts";
import type { AppState, BrowserNote, ChatItem, LibraryItem, SettingsPatch, StageNote } from "./types.ts";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [mode, setMode] = useState<"file" | "browser" | "slides">("file");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [botName, setBotName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(252);
  const [stageOpen, setStageOpen] = useState(true);
  const [file, setFile] = useState<{ id: string; filename: string; page: number } | null>(null);
  const [slides, setSlides] = useState<{ title: string; pages: string[]; index: number } | null>(null);
  const [browser, setBrowser] = useState<BrowserNote>({ url: "", title: "", holder: "bot", loading: false });
  const [address, setAddress] = useState("");
  const holeRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const active = state?.activeSlug ?? "";
  const current = state?.bots.find((bot) => bot.slug === active);
  const ink = inkFor(active || "xiaowang");
  const covered = settingsOpen || callOpen || (state !== null && !state.settings.ready);

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
        if (note.slug) void window.xiaowang.library(note.slug).then(setLibrary);
      }),
      window.xiaowang.onStage((view) => applyStage(view)),
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

  function applyStage(view: StageNote) {
    if (view.mode === "file") {
      setMode("file");
      setFile(view);
    } else if (view.mode === "browser") {
      setMode("browser");
      if (view.url) setAddress(view.url);
    } else {
      setMode("slides");
      setSlides({ title: view.title, pages: view.pages, index: 0 });
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !active || busy) return;
    setDraft("");
    setBusy(true);
    setItems((currentItems) => [...currentItems, { id: -Date.now(), kind: "user", text }]);
    try {
      const next = await window.xiaowang.ask(active, text);
      setItems(next);
      setLibrary(await window.xiaowang.library(active));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function toggleStage() {
    if (stageOpen) {
      setStageOpen(false);
      return;
    }
    const max = Math.max(360, window.innerWidth - leftWidth - 420);
    setRightWidth((width) => Math.min(Math.max(width, 360), max));
    setStageOpen(true);
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
          <button className="icon" title="搜索" type="button"><Search size={16} /></button>
          <button className="icon" title="新任务" type="button" onClick={() => setCreating(true)}><Plus size={16} /></button>
        </div>
        <button className={active === "xiaowang" ? "steward on" : "steward"} type="button" onClick={() => void window.xiaowang.setActive("xiaowang")}>
          <Avatar slug="xiaowang" size={72} live={active === "xiaowang"} />
          <strong>小王同学</strong>
        </button>
        <div className="search-line">
          <input value={query} placeholder="找任务" onChange={(event) => setQuery(event.target.value)} />
        </div>
        {creating ? (
          <form className="new-bot" onSubmit={(event) => { event.preventDefault(); void createBot(); }}>
            <input autoFocus value={botName} placeholder="任务名称" onChange={(event) => setBotName(event.target.value)} />
          </form>
        ) : null}
        <nav>
          {bots.filter((bot) => bot.slug !== "xiaowang").map((bot) => (
            <button className={bot.slug === active ? "bot on" : "bot"} key={bot.slug} type="button" onClick={() => void window.xiaowang.setActive(bot.slug)}>
              <Avatar slug={bot.slug} live={bot.slug === active} />
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
            设置
          </button>
        </footer>
      </aside>

      <div className="split" onPointerDown={(event) => dragSize(event, leftWidth, setLeftWidth, 1)} />

      <main className="thread">
        <header>
          <span className="pill"><Avatar slug={active || "xiaowang"} size={22} live />{current?.name ?? "小王同学"}</span>
          <button className="icon stage-toggle" type="button" title={stageOpen ? "收起右栏" : "展开右栏"} onClick={toggleStage}>
            <PanelRight size={16} />
          </button>
        </header>
        <div className="messages" ref={threadRef}>
          {items.filter(isConversation).map((item) => <Message key={item.id} item={item} ink={ink} />)}
          {busy ? (
            <div className="thinking">
              <Avatar slug={active || "xiaowang"} size={22} live />
              <span>思考中</span>
            </div>
          ) : null}
        </div>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          <button className="icon" type="button" title="放入资料库" onClick={() => void window.xiaowang.addFiles().then(() => active && window.xiaowang.library(active).then(setLibrary))}><Plus size={18} /></button>
          <textarea
            rows={1}
            value={draft}
            placeholder={current ? `给 ${current.name} 发消息` : "发消息"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
          />
          <button className="icon" type="button" title="听写还没接上"><Mic size={18} /></button>
          {busy ? (
            <button className="call stop" type="button" title="停下" onClick={() => void window.xiaowang.stop()}>停</button>
          ) : (
            <button className="call" style={{ background: ink }} type="button" title="通话" onClick={() => setCallOpen(true)}>
              <span /><span /><span /><span />
            </button>
          )}
        </form>
        {callOpen ? (
          <div className="popover">
            <p>实时通话下一阶段接通。文字、资料和浏览器现在就可以一起用。</p>
            <button type="button" onClick={() => setCallOpen(false)}>知道了</button>
          </div>
        ) : null}
      </main>

      {stageOpen ? <div className="split" onPointerDown={(event) => dragSize(event, rightWidth, setRightWidth, -1)} /> : null}

      {stageOpen ? (
      <aside className="stage" style={{ width: rightWidth }}>
        <div className="stage-tabs">
          <button className={mode === "file" ? "on" : ""} type="button" onClick={() => setMode("file")}><FileText size={15} /> 文件</button>
          <button className={mode === "browser" ? "on" : ""} type="button" onClick={() => setMode("browser")}><Globe size={15} /> 浏览器</button>
          <button className={mode === "slides" ? "on" : ""} type="button" onClick={() => setMode("slides")}><Presentation size={15} /> 幻灯片</button>
        </div>
        {mode === "file" ? (
          <FileStage slug={active} library={library} file={file} onPick={(entry) => setFile({ ...entry, page: 1 })} />
        ) : null}
        {mode === "slides" ? <SlideStage slides={slides} onIndex={(index) => setSlides((currentSlides) => currentSlides ? { ...currentSlides, index } : currentSlides)} /> : null}
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
                  <span><Eye size={15} /> 仅观看</span>
                  <button type="button" onClick={() => void window.xiaowang.browserHolder("user")}>取得控制权</button>
                </>
              ) : (
                <>
                  <span><MousePointer2 size={15} /> 你正在控制</span>
                  <button className="quiet" type="button" onClick={() => void window.xiaowang.browserHolder("bot")}>停止</button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </aside>
      ) : null}

      {toast ? <button className="toast" type="button" onClick={() => setToast("")}>{toast}</button> : null}
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
    </div>
  );
}

function isConversation(item: ChatItem): boolean {
  return (item.kind === "user" || item.kind === "assistant") && item.text.trim().length > 0;
}

function Message({ item, ink }: { item: ChatItem; ink: string }) {
  if (item.kind === "user") return <div className="bubble user" style={{ background: ink }}>{item.text}</div>;
  return (
    <div className="bubble assistant">
      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
    </div>
  );
}

function FileStage({
  slug,
  library,
  file,
  onPick,
}: {
  slug: string;
  library: LibraryItem[];
  file: { id: string; filename: string; page: number } | null;
  onPick: (file: LibraryItem) => void;
}) {
  return (
    <div className="file-stage">
      <div className="file-list">
        {library.length === 0 ? <p>把 PDF 或笔记放进这个任务。</p> : null}
        {library.map((entry) => (
          <button className={file?.id === entry.id ? "on" : ""} key={entry.id} type="button" onClick={() => onPick(entry)}>{entry.filename}</button>
        ))}
      </div>
      {file && slug ? <Reader slug={slug} file={file} /> : <p className="empty">选择一份资料。</p>}
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

function SlideStage({ slides, onIndex }: { slides: { title: string; pages: string[]; index: number } | null; onIndex: (index: number) => void }) {
  if (!slides) return <p className="empty">小王做好幻灯片后会出现在这里。</p>;
  const page = slides.pages[slides.index] ?? "";
  return (
    <div className="slides">
      <div className="pager">
        <button type="button" onClick={() => onIndex(Math.max(0, slides.index - 1))}><ChevronLeft size={16} /></button>
        <span>{slides.title} · {slides.index + 1} / {slides.pages.length}</span>
        <button type="button" onClick={() => onIndex(Math.min(slides.pages.length - 1, slides.index + 1))}><ChevronRight size={16} /></button>
      </div>
      <article>
        <Markdown remarkPlugins={[remarkGfm]}>{page}</Markdown>
      </article>
    </div>
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
  const [model, setModel] = useState(settings?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? "");
  const [apiStyle, setApiStyle] = useState(settings?.apiStyle ?? "");
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = { model, baseUrl, apiStyle, apiKey };

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
      <form onSubmit={(event) => { event.preventDefault(); void onSave({ model, baseUrl, apiStyle, apiKey }); }}>
        <header>
          <strong>{forced ? "先接上模型" : "设置"}</strong>
          {forced ? null : <button type="button" onClick={onClose}><X size={16} /></button>}
        </header>
        <label>接口风格
          <select value={apiStyle} onChange={(event) => setApiStyle(event.target.value)}>
            <option value="">自动</option>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>接口地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com/v1" /></label>
        <label>模型密钥<input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.keyHint || "只显示末四位"} /></label>
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void loadModels()}>获取模型</button>
          <button type="button" disabled={busy} onClick={() => void check()}>检查</button>
        </div>
        <label>模型
          {models.length > 0 ? (
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat" />
          )}
        </label>
        {notice ? <p>{notice}</p> : <p>密钥写入系统钥匙串，不会进入会话。</p>}
        <button className="primary" type="submit">保存并进入</button>
      </form>
    </div>
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

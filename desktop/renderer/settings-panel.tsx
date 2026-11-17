import { useEffect, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import { AudioLines, Check, ChevronDown, ExternalLink, MessageSquareText, Play, RefreshCw, Square, X } from "lucide-react";
import { copyFor, localeOf, type Locale } from "./copy.ts";
import { createCallAudio } from "./call-audio.ts";
import { hasUnsavedSettings } from "./settings-draft.ts";
import { UpdateCheckButton, UpdateProgress } from "./update-panel.tsx";
import { MossVoicePicker } from "./voice-picker.tsx";
import { ModalDialog } from "./modal-dialog.tsx";
import { plainError } from "./errors.ts";
import { REALTIME_SERVICES, realtimeServicesForSettings, modelsFor, resolveRealtime, voicesFor, type RealtimeRegion, type RealtimeServiceId } from "../../src/realtime-catalog.ts";
import { textServiceOrigin, type VoiceProfilePatch } from "../../src/settings.ts";
import type { AppState, SettingsPatch } from "./types.ts";

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

export function SettingsPanel({
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
  const initialVoice = saved.service === "qwen"
    ? resolveRealtime({ service: "openai", ...settings?.realtimeProfiles?.openai })
    : saved;
  const [model, setModel] = useState(settings?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? "");
  const [apiStyle, setApiStyle] = useState(settings?.apiStyle ?? "");
  const [textKeyDrafts, setTextKeyDrafts] = useState<Record<string, string>>({});
  const textOrigin = textServiceOrigin({ baseUrl, apiStyle, model });
  const apiKey = textKeyDrafts[textOrigin] ?? "";
  const setApiKey = (value: string) => setTextKeyDrafts(previous => ({ ...previous, [textOrigin]: value }));
  const [service, setService] = useState<RealtimeServiceId>(initialVoice.service);
  const [realtimeModel, setRealtimeModel] = useState(initialVoice.model);
  const [voice, setVoice] = useState(initialVoice.voice);
  const [region, setRegion] = useState<RealtimeRegion>(initialVoice.region);
  const [workspace, setWorkspace] = useState(initialVoice.workspace);
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
          <label>{copy.modelKey}<input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.textKeyHints?.[textOrigin] || "····"} /></label>
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
              <FieldSelect label={copy.service} value={service} onChange={(value) => chooseService(value as RealtimeServiceId)} options={realtimeServicesForSettings(settings?.experimentalMossEnabled, settings?.geminiEnabled).filter(item => item.id !== "qwen").map((item) => ({ value: item.id, label: item.name }))} />
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

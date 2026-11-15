import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { voicesFor, type RealtimeVoiceChoice } from "../../src/realtime-catalog.ts";
import type { SettingsPatch } from "./types.ts";

export function MossVoicePicker({ value, onChange, patch, keyHint, en }: { value: string; onChange: (value: string) => void; patch: SettingsPatch; keyHint: string; en: boolean }) {
  const [voices, setVoices] = useState<RealtimeVoiceChoice[]>([]), [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const generation = useRef(0), draft = useRef(patch); draft.current = patch;
  const key = patch.realtimeKey?.trim() || "";
  const hasKey = Boolean(key || keyHint);
  async function load(refresh: boolean, ticket: number) {
    setBusy(true); setNotice("");
    try {
      const result = await window.xiaowang.listVoices(draft.current, refresh);
      if (ticket !== generation.current) return;
      setVoices(result); setLoaded(true);
      setNotice(result.length ? `${en ? "Available voices" : "可用音色"}：${result.length}` : en ? "No voices are available for this account." : "当前账号没有可用音色。");
    } catch (error) { if (ticket === generation.current) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  useEffect(() => {
    const ticket = ++generation.current; setVoices([]); setLoaded(false); setNotice(""); setBusy(hasKey);
    const timer = hasKey ? setTimeout(() => void load(false, ticket), 600) : undefined;
    return () => { clearTimeout(timer); generation.current++; };
  }, [key, keyHint, hasKey]);
  const defaults = voicesFor("moss", "moss-live-1.0"), choices = loaded ? voices : defaults;
  const current = choices.find(voice => voice.id === value) ?? defaults.find(voice => voice.id === value) ?? { id: value, name: `${en ? "Current voice" : "当前音色"} · ${value.slice(0, 12)}` };
  const filtered = choices.filter(voice => `${voice.name} ${voice.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const options = filtered.some(voice => voice.id === value) ? filtered : [current, ...filtered];
  return <div className="voice-picker">
    <div className="with-action"><input type="search" aria-label={en ? "Search voices" : "搜索音色"} placeholder={en ? "Search by voice name or ID" : "搜索音色名称或 ID"} value={query} onChange={event => setQuery(event.target.value)} /><button type="button" disabled={busy || !hasKey} onClick={() => void load(true, ++generation.current)}><RefreshCw className={busy ? "spin" : ""} size={14} />{en ? "Refresh voices" : "刷新音色"}</button></div>
    <select className="field" aria-label={en ? "Voice" : "音色"} value={value} onChange={event => onChange(event.target.value)}>{options.map(voice => <option key={voice.id} value={voice.id} title={voice.id}>{voice.name}</option>)}</select>
    <small role="status">{busy ? en ? "Loading all available voices…" : "正在读取全部可用音色…" : notice || (hasKey ? "" : en ? "Enter a MOSS voice key to load its catalog." : "填写 MOSS 语音密钥后读取音色列表。")}</small>
    {loaded && !voices.some(voice => voice.id === value) ? <small>{en ? "Your current voice is not in this list; the selection has been preserved." : "当前音色未出现在列表中，已保留选择，可刷新或选择其他音色。"}</small> : null}
    {query && !filtered.length ? <small>{en ? "No matching voices." : "没有匹配的音色。"}</small> : null}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { AudioLines, ChevronDown, Mic, MicOff, Pause, PhoneOff, Play } from "lucide-react";
import { Avatar } from "./avatar.tsx";
import type { CallAudio } from "./call-audio.ts";
import type { VoiceState } from "./types.ts";
import type { Locale } from "./copy.ts";

export interface LiveCaption { who: "user" | "assistant"; text: string; live: boolean; itemId?: string; order?: number }
export interface LiveCallView { slug: string; phase: "connecting" | "live"; captions: LiveCaption[]; muted: boolean; state?: VoiceState; audioReady: boolean }

export function VoicePanel({ call, audio, name, seed, ink, locale, onMute, onEnd }: { call: LiveCallView; audio: CallAudio; name: string; seed?: string; ink: string; locale: Locale; onMute: () => void; onEnd: () => void }) {
  const en = locale === "en";
  const phase = !call.audioReady && call.state?.phase !== "error" ? "connecting" : call.state?.phase ?? (call.phase === "connecting" ? "connecting" : "listening");
  const labels = en ? { connecting: "Preparing microphone", reconnecting: "Reconnecting", listening: "Listening to you", thinking: "Preparing a response", speaking: "Speaking", working: "Checking information", paused: "Presentation paused", error: "Needs attention", ended: "Call ended" } : { connecting: "正在准备麦克风", reconnecting: "正在重新连接", listening: "正在听你说", thinking: "正在组织回答", speaking: "正在讲解", working: "正在查阅资料", paused: "讲解已暂停", error: "需要处理", ended: "通话已结束" };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const [expanded, setExpanded] = useState(false);
  const presentation = call.state?.presentation;
  const last = call.captions.at(-1);
  const paused = presentation?.status === "paused";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let smoothed = 0;
    let waveformColor = getComputedStyle(canvas).color;
    const draw = (input: number, output: number) => {
      const box = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(box.width * dpr)) canvas.width = Math.round(box.width * dpr);
      if (canvas.height !== Math.round(box.height * dpr)) canvas.height = Math.round(box.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, box.width, box.height);
      const value = phaseRef.current === "speaking" ? output : input;
      smoothed = smoothed * .45 + value * .55;
      const count = Math.min(48, Math.floor(box.width / 7));
      ctx.fillStyle = waveformColor;
      for (let i = 0; i < count; i++) {
        const envelope = .35 + .65 * Math.sin(Math.PI * i / Math.max(1, count - 1));
        const height = 3 + smoothed * envelope * 38;
        ctx.globalAlpha = .3 + smoothed * .7;
        ctx.beginPath(); ctx.roundRect((box.width - count * 7) / 2 + i * 7, (box.height - height) / 2, 3, height, 2); ctx.fill();
      }
    };
    draw(0, 0);
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    const updateAppearance = () => { waveformColor = getComputedStyle(canvas).color; draw(0, 0); };
    appearance.addEventListener("change", updateAppearance);
    const stop = audio.subscribeLevels(levels => draw(levels.input, levels.output));
    return () => { stop(); appearance.removeEventListener("change", updateAppearance); };
  }, [audio, ink]);
  const detail = call.state?.detail || (call.muted ? en ? "Microphone muted" : "麦克风已静音" : phase === "speaking" ? en ? "You can interrupt at any time" : "你可以随时打断" : en ? "Ready for your voice" : "麦克风已就绪，随时可以提问");
  return (
    <section className={`voice-panel phase-${phase}`} style={{ ["--voice-ink" as string]: ink }} aria-label={en ? "Voice call" : "语音通话"}>
      <div className="voice-heading"><Avatar slug={call.slug} seed={seed} ink={ink} size={42} mood={phase === "thinking" || phase === "working" ? "think" : "idle"} /><div><strong role="status">{labels[phase]}</strong><p>{detail}</p></div><span className="voice-connected"><span />{en ? "Live" : "语音"}</span></div>
      <canvas ref={canvasRef} className="voice-wave" role="img" aria-label={en ? "Live microphone and speaker audio levels" : "实际麦克风输入与扬声器输出音量"} />
      <div className="voice-caption" aria-live="polite" aria-atomic="true"><span>{last?.who === "user" ? en ? "You" : "你" : name}</span><p>{last?.text || (en ? "Say something to get started." : "说说你想做什么。")}</p></div>
      {presentation && presentation.status !== "idle" ? <div className="voice-progress"><AudioLines size={13} /><span>{paused ? en ? "Paused" : "已暂停" : presentation.status === "completed" ? en ? "Completed" : "已讲完" : en ? "Continuous walkthrough" : "连续讲解"}{presentation.path ? ` · ${en ? "Page" : "第"} ${presentation.page}${presentation.totalPages ? ` / ${presentation.totalPages}` : ""}${en ? "" : " 页"}` : ""}</span></div> : null}
      <div className="voice-actions">
        {presentation && (presentation.status === "active" || paused) ? <button type="button" onClick={() => void window.xiaowang.callControl(paused ? "resume" : "pause")}><span>{paused ? <Play size={15} /> : <Pause size={15} />}</span>{paused ? en ? "Resume" : "继续" : en ? "Pause" : "暂停"}</button> : null}
        <button type="button" aria-pressed={call.muted} onClick={onMute}>{call.muted ? <MicOff size={15} /> : <Mic size={15} />}{call.muted ? en ? "Unmute" : "取消静音" : en ? "Mute" : "静音"}</button>
        <button type="button" className="voice-hangup" onClick={onEnd}><PhoneOff size={15} />{en ? "Hang up" : "挂断"}</button>
        <button type="button" className="voice-history-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown size={15} />{en ? "Transcript" : "记录"}</button>
      </div>
      {expanded ? <div className="voice-history">{call.captions.map((line, i) => <p key={i}><strong>{line.who === "user" ? en ? "You" : "你" : name}</strong>{line.text}</p>)}</div> : null}
    </section>
  );
}

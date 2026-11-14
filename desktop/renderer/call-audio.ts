import { pcm16FromFloat } from "../../src/realtime.ts";
import type { AudioIdentity, PlaybackInterruption, PlaybackPosition } from "../main/call.ts";

export interface AudioLevels { input: number; output: number }
export interface CallAudio {
  start(inputRate: number, outputRate: number): Promise<void>;
  startPlayback(outputRate: number): Promise<void>;
  stop(): void;
  play(audio: string, serial?: number, identity?: AudioIdentity): void;
  interrupt(interruption?: PlaybackInterruption): PlaybackPosition | null;
  setMuted(muted: boolean): void;
  subscribeLevels(listener: (levels: AudioLevels) => void): () => void;
}
export const MIC_WORKLET_CODE = `class XiaoWangMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(960); this.off = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(this.buf.length - this.off, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.off); this.off += take; i += take;
      if (this.off >= this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.off = 0; }
    }
    return true;
  }
}
registerProcessor("xiaowang-mic", XiaoWangMic);`;

export function createCallAudio(send: (audio: string) => void, onIdle?: (serial: number, callId?: string) => void, onPosition?: (position: PlaybackPosition) => void): CallAudio {
  let mic: MediaStream | null = null;
  let capture: AudioContext | null = null;
  let processor: AudioNode | null = null;
  let playback: AudioContext | null = null;
  let inputMeter: AnalyserNode | null = null;
  let outputMeter: AnalyserNode | null = null;
  let outputGate: GainNode | null = null;
  let playbackEpoch = 0;
  let throughSerial = 0;
  const rejectedResponses = new Set<string>();
  const rejectedItems = new Set<string>();
  let outputRate = 24_000;
  let nextAt = 0;
  let muted = false;
  let heard = 0;
  let heardCallId: string | undefined;
  let generation = 0;
  let frame = 0;
  let lastTick = 0;
  const listeners = new Set<(levels: AudioLevels) => void>();
  const playing: Array<{ node: AudioBufferSourceNode; start: number; duration: number; serial: number; identity: AudioIdentity }> = [];
  const completed = new Map<string, number>();
  let pending: Array<{ audio: string; serial: number; identity?: AudioIdentity }> = [];
  const samples = new Float32Array(256);
  const itemKey = (identity: AudioIdentity) => `${identity.itemId || ""}:${identity.contentIndex ?? 0}`;
  function energy(meter: AnalyserNode | null): number {
    if (!meter) return 0;
    meter.getFloatTimeDomainData(samples);
    let sum = 0; for (const value of samples) sum += value * value;
    return Math.min(1, Math.sqrt(sum / samples.length) * 5);
  }
  function position(): PlaybackPosition | null {
    const now = playback?.currentTime ?? 0;
    const current = playing.find(item => item.start <= now && item.start + item.duration >= now) ?? playing[0];
    if (!current) return null;
    const key = itemKey(current.identity);
    let seconds = completed.get(key) ?? 0;
    for (const item of playing) if (itemKey(item.identity) === key) seconds += Math.max(0, Math.min(item.duration, now - item.start));
    const result = { serial: current.serial, ...current.identity, playedMs: Math.round(seconds * 1000) };
    onPosition?.(result); return result;
  }
  function tick(time: number): void {
    if (!playback) { frame = 0; return; }
    if (time - lastTick >= 32) {
      lastTick = time; position();
      const levels = { input: muted ? 0 : energy(inputMeter), output: energy(outputMeter) };
      listeners.forEach(listener => listener(levels));
    }
    frame = requestAnimationFrame(tick);
  }
  function meters(): void {
    if (!playback) return;
    outputMeter = playback.createAnalyser(); outputMeter.fftSize = 256;
    outputGate = playback.createGain(); outputMeter.connect(outputGate); outputGate.connect(playback.destination);
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function settled(): void { if (heard > 0 && !playing.length && !pending.length) onIdle?.(heard, heardCallId); }
  const api: CallAudio = {
    async start(inputRate, playbackRate) {
      this.stop(); const epoch = generation; outputRate = playbackRate; muted = false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (epoch !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
      mic = stream; capture = new AudioContext({ latencyHint: "interactive" });
      const context = capture;
      const source = context.createMediaStreamSource(stream);
      inputMeter = context.createAnalyser(); inputMeter.fftSize = 256;
      source.connect(inputMeter);
      const emit = (values: Float32Array) => {
        if (muted || epoch !== generation) return;
        const pcm = pcm16FromFloat(values, context.sampleRate, inputRate);
        if (pcm.length) send(base64FromBytes(pcm));
      };
      if (context.audioWorklet) {
        const url = URL.createObjectURL(new Blob([MIC_WORKLET_CODE], { type: "application/javascript" }));
        try {
          await context.audioWorklet.addModule(url);
          if (epoch !== generation) return;
          const worklet = new AudioWorkletNode(context, "xiaowang-mic", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          worklet.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data); processor = worklet;
        } finally { URL.revokeObjectURL(url); }
      } else {
        const script = context.createScriptProcessor(1024, 1, 1); script.onaudioprocess = event => emit(event.inputBuffer.getChannelData(0)); processor = script;
      }
      const silence = context.createGain(); silence.gain.value = 0;
      inputMeter.connect(processor); processor.connect(silence); silence.connect(context.destination);
      playback = context; await context.resume(); if (epoch !== generation) return;
      meters(); nextAt = context.currentTime;
      const queued = pending; pending = []; queued.forEach(item => this.play(item.audio, item.serial, item.identity));
    },
    async startPlayback(playbackRate) {
      outputRate = playbackRate;
      if (!playback || playback.state === "closed") { playback = new AudioContext(); meters(); }
      await playback.resume(); nextAt = playback.currentTime;
      const queued = pending; pending = []; queued.forEach(item => this.play(item.audio, item.serial, item.identity));
    },
    stop() {
      generation += 1; pending = []; heard = 0; heardCallId = undefined;
      this.interrupt(); processor?.disconnect(); processor = null;
      playbackEpoch = 0; throughSerial = 0; rejectedResponses.clear(); rejectedItems.clear();
      mic?.getTracks().forEach(track => track.stop()); mic = null;
      const shared = playback === capture;
      void capture?.close().catch(() => {}); if (!shared) void playback?.close().catch(() => {});
      capture = null; playback = null; inputMeter = null; outputMeter = null; outputGate = null;
      cancelAnimationFrame(frame); frame = 0; completed.clear();
      listeners.forEach(listener => listener({ input: 0, output: 0 }));
    },
    setMuted(value) { muted = value; mic?.getAudioTracks().forEach(track => { track.enabled = !value; }); if (value) listeners.forEach(listener => listener({ input: 0, output: energy(outputMeter) })); },
    subscribeLevels(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    play(audio, serial = 0, identity = {}) {
      if ((identity.playbackEpoch ?? 0) < playbackEpoch || (serial > 0 && serial <= throughSerial) || (identity.responseId && rejectedResponses.has(identity.responseId)) || (identity.itemId && rejectedItems.has(identity.itemId))) return;
      heard = Math.max(heard, serial);
      heardCallId = identity.callId;
      if (!playback || !outputMeter) { pending.push({ audio, serial, identity }); return; }
      const bytes = Uint8Array.from(atob(audio), char => char.charCodeAt(0));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const values = new Float32Array(Math.floor(bytes.byteLength / 2));
      for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true) / 0x8000;
      if (!values.length) return;
      // Let Web Audio resample from the source sample rate; avoid nearest-neighbor stretching.
      const buffer = playback.createBuffer(1, values.length, outputRate); buffer.copyToChannel(values, 0);
      const node = playback.createBufferSource(); node.buffer = buffer; node.connect(outputMeter);
      outputGate?.gain.setValueAtTime(1, playback.currentTime);
      const start = Math.max(playback.currentTime + 0.012, nextAt); nextAt = start + buffer.duration;
      const item = { node, start, duration: buffer.duration, serial, identity }; playing.push(item);
      node.onended = () => {
        const index = playing.indexOf(item); if (index < 0) return;
        position(); completed.set(itemKey(identity), (completed.get(itemKey(identity)) ?? 0) + buffer.duration);
        playing.splice(index, 1); node.disconnect(); settled();
      };
      node.start(start);
    },
    interrupt(interruption) {
      const stoppedAt = position();
      if (outputGate && playback) outputGate.gain.setValueAtTime(0, playback.currentTime);
      if (interruption) {
        playbackEpoch = Math.max(playbackEpoch, interruption.playbackEpoch);
        throughSerial = Math.max(throughSerial, interruption.throughSerial);
        if (interruption.responseId) rejectedResponses.add(interruption.responseId);
        if (interruption.itemId) rejectedItems.add(interruption.itemId);
      }
      const held = playing.splice(0);
      for (const item of [...held, ...pending]) {
        if (item.identity?.responseId) rejectedResponses.add(item.identity.responseId);
        if (item.identity?.itemId) rejectedItems.add(item.identity.itemId);
      }
      held.forEach(item => { item.node.onended = null; item.node.stop(); item.node.disconnect(); });
      pending = []; completed.clear(); nextAt = playback?.currentTime ?? 0;
      // Interruption is not a natural drain acknowledgement.
      return stoppedAt;
    },
  };
  return api;
}
function base64FromBytes(bytes: Uint8Array): string {
  let result = ""; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result);
}

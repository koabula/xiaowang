import { pcm16FromFloat } from "../../src/realtime.ts";

export interface CallAudio {
  start(inputRate: number, outputRate: number): Promise<void>;
  startPlayback(outputRate: number): Promise<void>;
  stop(): void;
  play(audio: string, serial?: number): void;
  interrupt(): void;
  setMuted(muted: boolean): void;
}

export function createCallAudio(send: (audio: string) => void, onIdle?: (serial: number) => void): CallAudio {
  let mic: MediaStream | null = null;
  let capture: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let playback: AudioContext | null = null;
  let outputRate = 24_000;
  let nextAt = 0;
  const playing: AudioBufferSourceNode[] = [];
  let pending: string[] = [];
  let micMuted = false;
  let heard = 0;

  function settled(): void {
    if (heard > 0 && playing.length === 0 && pending.length === 0) onIdle?.(heard);
  }

  return {
    async start(inputRate, playbackRate) {
      this.stop();
      outputRate = playbackRate;
      micMuted = false;
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      capture = new AudioContext();
      const source = capture.createMediaStreamSource(mic);
      processor = capture.createScriptProcessor(4096, 1, 1);
      const rate = capture.sampleRate;
      processor.onaudioprocess = (event) => {
        if (micMuted) return;
        const pcm = pcm16FromFloat(event.inputBuffer.getChannelData(0), rate, inputRate);
        if (pcm.length > 0) send(base64FromBytes(pcm));
      };
      const mute = capture.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(capture.destination);
      playback = capture;
      await playback.resume();
      nextAt = playback.currentTime;
      const queued = pending;
      pending = [];
      for (const item of queued) this.play(item);
    },
    async startPlayback(playbackRate) {
      outputRate = playbackRate;
      const held = pending;
      pending = [];
      this.interrupt();
      pending = held;
      if (!playback || playback.state === "closed") playback = new AudioContext();
      await playback.resume();
      nextAt = playback.currentTime;
      const queued = pending;
      pending = [];
      for (const item of queued) this.play(item);
    },
    stop() {
      pending = [];
      heard = 0;
      processor?.disconnect();
      processor = null;
      mic?.getTracks().forEach((track) => track.stop());
      mic = null;
      this.interrupt();
      const shared = playback === capture;
      void capture?.close();
      if (!shared) void playback?.close();
      capture = null;
      playback = null;
    },
    setMuted(muted) {
      micMuted = muted;
    },
    play(audio, serial = 0) {
      if (serial > 0) heard = serial;
      if (!playback) {
        pending.push(audio);
        return;
      }
      const bytes = Uint8Array.from(atob(audio), (char) => char.charCodeAt(0));
      const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const samples = new Float32Array(view.length);
      for (let index = 0; index < view.length; index += 1) samples[index] = (view[index] ?? 0) / 0x8000;
      const contextRate = playback.sampleRate;
      const stretched = stretch(samples, outputRate, contextRate);
      if (stretched.length === 0) return;
      const buffer = playback.createBuffer(1, stretched.length, contextRate);
      buffer.getChannelData(0).set(stretched);
      const node = playback.createBufferSource();
      node.buffer = buffer;
      node.connect(playback.destination);
      const start = Math.max(playback.currentTime + 0.05, nextAt);
      node.start(start);
      nextAt = start + buffer.duration;
      playing.push(node);
      node.onended = () => {
        const index = playing.indexOf(node);
        if (index >= 0) playing.splice(index, 1);
        settled();
      };
    },
    interrupt() {
      for (const node of playing) node.stop();
      playing.length = 0;
      pending = [];
      nextAt = playback?.currentTime ?? 0;
      settled();
    },
  };
}

function stretch(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(length);
  const ratio = fromRate / toRate;
  for (let index = 0; index < length; index += 1) {
    out[index] = samples[Math.min(samples.length - 1, Math.floor(index * ratio))] ?? 0;
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

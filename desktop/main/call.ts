import {
  TOOL_ACCEPTED,
  askTextResult,
  audioAppend,
  continueCue,
  functionOutput,
  foldTranscript,
  mergeUtterance,
  parseRealtimeEvent,
  previewCue,
  responseCancel,
  responseCreate,
  spokenResult,
  type RealtimeFamily,
  type RealtimeNotice,
} from "../../src/realtime.ts";

const DOUBAO_CHUNK = 3_200;
const CONTINUE_BREATH_MS = 350;

export interface CallHandlers {
  onPhase: (phase: "connecting" | "live" | "closed", detail?: string) => void;
  onAudio: (pcm: Buffer, serial: number) => void;
  onInterrupt: () => void;
  onLine: (who: "user" | "assistant", text: string, partial: boolean) => void;
  onTranscript: (who: "user" | "assistant", text: string) => void;
  runTool: (name: string, args: string) => Promise<string>;
}

interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export class LiveCall {
  private socket: SocketLike | null = null;
  private open = false;
  private configured = false;
  private speaking = false;
  private speakerBusy = false;
  private audioSerial = 0;
  private userTalking = false;
  private dropAudio = false;
  private closed = false;
  private readonly answered = new Set<string>();
  private readonly briefs: string[] = [];
  private assistantPartial = "";
  private userPartial = "";
  private openWho: "user" | "assistant" | "" = "";
  private sealUser = false;
  private ending = false;
  private endReady = false;
  private wantContinue = false;
  private continueTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lines: Array<{ who: "user" | "assistant"; text: string }> = [];
  private begunAt = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly key: string;
  private readonly session: Record<string, unknown>;
  private readonly handlers: CallHandlers;
  private readonly connect: (url: string, headers: Record<string, string>) => SocketLike;
  private readonly family: RealtimeFamily;
  private readonly previewText: string;

  constructor(
    url: string,
    key: string,
    session: Record<string, unknown>,
    handlers: CallHandlers,
    connect: (url: string, headers: Record<string, string>) => SocketLike = defaultSocket,
    previewText = "",
  ) {
    this.url = url;
    this.key = key;
    this.session = session;
    this.handlers = handlers;
    this.connect = connect ?? defaultSocket;
    this.previewText = previewText;
    this.family = session.type === "session.create" ? "doubao" : "openai";
  }

  start(): void {
    this.begunAt = new Date().toISOString();
    this.handlers.onPhase("connecting");
    this.timer = setTimeout(() => {
      if (!this.configured && !this.closed) this.fail("接通超时。核对地址、模型和密钥。");
    }, 8_000);
    const headers: Record<string, string> = {};
    if (this.family === "doubao") headers["X-Api-Key"] = this.key;
    else headers.Authorization = `Bearer ${this.key}`;
    const socket = this.connect(this.url, headers);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.open = true;
      if (this.family === "doubao") this.send(this.session);
    });
    socket.addEventListener("message", (event) => {
      this.open = true;
      const raw = messageText(event.data);
      if (!raw) return;
      for (const notice of parseRealtimeEvent(raw)) this.take(notice);
    });
    socket.addEventListener("error", () => {
      if (!this.closed) this.fail("实时连接没有建立。核对地址、模型和密钥。");
    });
    socket.addEventListener("close", () => {
      this.open = false;
      if (this.closed) return;
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.handlers.onPhase("closed");
    });
  }

  sendAudio(pcm: Buffer): void {
    if (!this.configured || !this.open || pcm.length === 0) return;
    if (this.family !== "doubao") {
      this.send(audioAppend(pcm.toString("base64")));
      return;
    }
    for (let offset = 0; offset < pcm.length; offset += DOUBAO_CHUNK) {
      const slice = pcm.subarray(offset, Math.min(pcm.length, offset + DOUBAO_CHUNK));
      this.send(audioAppend(Buffer.from(slice).toString("base64")));
    }
  }

  noteSpeakerIdle(serial: number): void {
    if (serial === this.audioSerial) this.speakerBusy = false;
    this.tryHangup();
    this.scheduleContinue();
  }

  transcript(): Array<{ who: "user" | "assistant"; text: string }> {
    const lines = [...this.lines];
    if (this.userPartial.trim()) lines.push({ who: "user", text: this.userPartial.trim() });
    if (this.assistantPartial.trim()) lines.push({ who: "assistant", text: this.assistantPartial.trim() });
    return lines;
  }

  startedAt(): string {
    return this.begunAt;
  }

  hangup(): void {
    if (this.closed) return;
    if (this.family === "doubao" && this.open) this.send({ type: "session.close" });
    this.closed = true;
    this.clearContinue();
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.handlers.onPhase("closed");
  }

  private take(notice: RealtimeNotice): void {
    if (this.closed) return;
    if (notice.kind === "session.created") {
      if (this.family === "doubao") this.markLive();
      else this.send(this.session);
      return;
    }
    if (notice.kind === "session.updated") {
      this.markLive();
      return;
    }
    if (notice.kind === "session.closed") {
      this.hangup();
      return;
    }
    if (notice.kind === "speech_started") {
      this.userTalking = true;
      this.sealUser = false;
      this.clearContinue();
      if (this.ending && this.speaking) {
        this.ending = false;
        this.endReady = false;
      }
      const cut = this.speaking || this.speakerBusy;
      if (!cut) return;
      this.dropAudio = true;
      const cancelServer = this.speaking;
      this.speaking = false;
      this.speakerBusy = false;
      this.handlers.onInterrupt();
      if (cancelServer) this.send(responseCancel());
      return;
    }
    if (notice.kind === "speech_stopped") {
      this.userTalking = false;
      this.sealUserLine();
      this.flush();
      return;
    }
    if (notice.kind === "response_started") {
      this.speaking = true;
      this.dropAudio = false;
      if (this.openWho === "assistant") this.openWho = "";
      this.assistantPartial = "";
      return;
    }
    if (notice.kind === "audio") {
      if (this.dropAudio) return;
      this.audioSerial += 1;
      this.speakerBusy = true;
      this.handlers.onAudio(notice.pcm, this.audioSerial);
      return;
    }
    if (notice.kind === "assistant_transcript") {
      this.remember("assistant", notice.text, notice.partial);
      return;
    }
    if (notice.kind === "user_transcript") {
      this.remember("user", notice.text, notice.partial);
      return;
    }
    if (notice.kind === "function_call") {
      this.acceptTool(notice.callId, notice.name, notice.arguments);
      return;
    }
    if (notice.kind === "response_done") {
      if (this.previewText) {
        this.hangup();
        return;
      }
      this.speaking = false;
      if (this.ending) {
        this.endReady = true;
        this.tryHangup();
        return;
      }
      this.flush();
      this.scheduleContinue();
      return;
    }
    if (notice.kind === "error") this.fail(notice.message);
  }

  private acceptTool(callId: string, name: string, args: string): void {
    if (this.answered.has(callId)) return;
    this.answered.add(callId);
    if (name === "end_call") {
      this.ending = true;
      this.clearContinue();
      if (!this.speaking) this.endReady = true;
      this.send(functionOutput(callId, "道别说完就挂断。", this.family));
      this.tryHangup();
      return;
    }
    if (name === "continue_speaking") {
      this.wantContinue = true;
      this.send(functionOutput(callId, "好。当前段播完后继续。", this.family));
      this.scheduleContinue();
      return;
    }
    if (name === "ask_text") {
      void this.handlers.runTool(name, args).then((output) => {
        if (this.closed) return;
        this.send(functionOutput(callId, output.trim() || askTextResult("started"), this.family));
        if (this.family !== "doubao") this.send(responseCreate());
        this.speaking = true;
      }).catch((error: unknown) => {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.send(functionOutput(callId, message, this.family));
        if (this.family !== "doubao") this.send(responseCreate());
        this.speaking = true;
      });
      return;
    }
    if (name === "show_stage") {
      void this.handlers.runTool(name, args).then((output) => {
        if (this.closed) return;
        this.send(functionOutput(callId, output.trim() || "右栏已更新。", this.family));
        if (this.family !== "doubao") this.send(responseCreate());
        this.speaking = true;
      }).catch((error: unknown) => {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.send(functionOutput(callId, message, this.family));
        if (this.family !== "doubao") this.send(responseCreate());
        this.speaking = true;
      });
      return;
    }
    this.send(functionOutput(callId, TOOL_ACCEPTED, this.family));
    if (this.family !== "doubao") this.send(responseCreate());
    this.speaking = true;
    void this.handlers.runTool(name, args).then((output) => {
      if (this.closed) return;
      this.briefs.push(output);
      this.flush();
    }).catch((error: unknown) => {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.briefs.push(message);
      this.flush();
    });
  }

  private clearContinue(): void {
    this.wantContinue = false;
    if (this.continueTimer) clearTimeout(this.continueTimer);
    this.continueTimer = null;
  }

  private scheduleContinue(): void {
    if (!this.wantContinue || this.closed || this.ending || this.userTalking || this.speaking || this.speakerBusy) return;
    if (this.continueTimer) clearTimeout(this.continueTimer);
    this.continueTimer = setTimeout(() => this.fireContinue(), CONTINUE_BREATH_MS);
  }

  private fireContinue(): void {
    this.continueTimer = null;
    if (!this.wantContinue || this.closed || this.ending || this.userTalking || this.speaking || this.speakerBusy) return;
    this.wantContinue = false;
    this.speaking = true;
    this.send(continueCue(this.family));
    this.send(this.family === "doubao" ? { type: "input_audio_buffer.commit" } : responseCreate());
  }

  private remember(who: "user" | "assistant", text: string, partial: boolean): void {
    if (partial) {
      const next = who === "user"
        ? mergeUtterance(this.userPartial, text)
        : foldTranscript(this.assistantPartial, text);
      if (who === "user") {
        this.userPartial = next;
        if (this.openWho !== "user") this.sealUser = false;
      } else {
        this.assistantPartial = next;
      }
      this.revise(who, next);
      this.handlers.onLine(who, next, true);
      return;
    }
    const finalText = mergeUtterance("", text);
    if (who === "user") this.userPartial = "";
    else this.assistantPartial = "";
    if (finalText) this.revise(who, finalText);
    if (who === "user") this.sealUser = false;
    this.openWho = "";
    this.handlers.onLine(who, finalText, false);
    this.handlers.onTranscript(who, finalText);
  }

  private sealUserLine(): void {
    this.sealUser = true;
    const text = this.userPartial.trim();
    if (!text) return;
    this.userPartial = "";
    this.revise("user", text);
    this.openWho = "";
    const spoken = this.lines[this.lines.length - 1]?.text ?? text;
    this.handlers.onLine("user", spoken, false);
  }

  private revise(who: "user" | "assistant", text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = this.lines[this.lines.length - 1];
    const sameTurn = last?.who === who && (this.openWho === who || (who === "user" && this.sealUser));
    if (last && sameTurn) {
      last.text = who === "user" && this.sealUser && this.openWho !== "user"
        ? trimmed
        : who === "user"
          ? mergeUtterance(last.text, trimmed)
          : foldTranscript(last.text, trimmed);
      return;
    }
    this.lines.push({ who, text: trimmed });
    this.openWho = who;
  }

  private tryHangup(): void {
    if (!this.ending || !this.endReady || this.closed || this.speaking || this.speakerBusy) return;
    this.hangup();
  }

  private flush(): void {
    if (this.closed || this.speaking || this.userTalking || this.briefs.length === 0) return;
    const next = this.briefs.shift();
    if (!next) return;
    this.speaking = true;
    this.send(spokenResult(next, this.family));
    this.send(this.family === "doubao" ? { type: "input_audio_buffer.commit" } : responseCreate());
  }

  private markLive(): void {
    this.configured = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.handlers.onPhase("live");
    if (!this.previewText) return;
    for (const event of previewCue(this.family, this.previewText)) this.send(event);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.open || this.closed) return;
    this.socket?.send(JSON.stringify(payload));
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearContinue();
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.handlers.onPhase("closed", message);
  }
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}

function defaultSocket(url: string, headers: Record<string, string>): SocketLike {
  const Socket = WebSocket as unknown as new (address: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(url, { headers });
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    addEventListener(type, listener) {
      socket.addEventListener(type, (event) => {
        const data = "data" in event ? (event as MessageEvent).data : undefined;
        listener({ data });
      });
    },
  };
}

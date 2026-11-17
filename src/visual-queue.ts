import type { VisualInput, VisualShare } from "./shared-context.ts";

/** Rate-limit frames without requesting a response. Page changes supersede stale pages. */
export class VisualQueue {
  private queue: Array<{ image: VisualInput; resolve(value: boolean): void }> = [];
  private readonly sent = new Set<string>();
  private readonly retained = new Map<string, VisualInput>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = -Infinity;
  private closed = false;
  private readonly ready: () => boolean;
  private readonly send: (image: VisualInput) => void;
  private readonly state: (state: VisualShare) => void;
  constructor(ready: () => boolean, send: (image: VisualInput) => void, state: (state: VisualShare) => void) { this.ready = ready; this.send = send; this.state = state; }
  add(images: VisualInput[]): Promise<boolean> {
    return Promise.all(images.map(image => new Promise<boolean>(resolve => {
      if (this.closed) { resolve(false); return; }
      if (image.key.startsWith("view:")) this.clearView(image.key);
      this.retained.set(image.key, image);
      while (this.retained.size > 9) this.retained.delete(this.retained.keys().next().value!);
      if (this.sent.has(image.key)) { resolve(true); return; }
      this.queue.push({ image, resolve });
      this.state({ phase: "pending", source: image.filename, page: image.page }); this.flush();
    }))).then(results => results.every(Boolean));
  }
  clearView(except = ""): void {
    for (const key of this.retained.keys()) if (key.startsWith("view:") && key !== except) this.retained.delete(key);
    this.queue = this.queue.filter(item => { if (item.image.key.startsWith("view:") && item.image.key !== except) { item.resolve(false); return false; } return true; });
  }
  forget(refId: string): void {
    for (const [key, image] of this.retained) if (image.refId === refId) { this.retained.delete(key); this.sent.delete(key); }
    this.queue = this.queue.filter(item => { if (item.image.refId === refId) { item.resolve(false); return false; } return true; });
  }
  replay(): void { this.sent.clear(); void this.add([...this.retained.values()]); }
  replayForSpeech(): void {
    const view = [...this.retained.values()].find(image => image.key.startsWith("view:"));
    const images = view ? [view] : [...this.retained.values()];
    void this.add(images.filter(image => this.sent.delete(image.key)));
  }
  close(): void { this.closed = true; clearTimeout(this.timer); for (const item of this.queue) item.resolve(false); this.queue = []; this.retained.clear(); }
  private flush(): void {
    clearTimeout(this.timer);
    if (this.closed || !this.queue.length) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.last));
    if (!this.ready() || wait) { this.timer = setTimeout(() => this.flush(), wait || 50); return; }
    const item = this.queue.shift()!;
    if (this.sent.has(item.image.key)) { item.resolve(true); this.flush(); return; }
    try {
      this.send(item.image); this.last = Date.now(); this.sent.add(item.image.key);
      if (this.sent.size > 64) this.sent.delete(this.sent.values().next().value!);
      this.state({ phase: "shared", source: item.image.filename, page: item.image.page }); item.resolve(true);
    } catch (error) { this.state({ phase: "error", source: item.image.filename, detail: error instanceof Error ? error.message : String(error) }); item.resolve(false); }
    this.flush();
  }
}

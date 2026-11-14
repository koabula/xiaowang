export interface PresentationState {
  status: "idle" | "active" | "paused" | "completed";
  path: string;
  mode: "canvas" | "file";
  page: number;
  totalPages: number;
  segments: number;
  goal: string;
}
export const EMPTY_PRESENTATION: PresentationState = { status: "idle", path: "", mode: "canvas", page: 1, totalPages: 0, segments: 0, goal: "" };

/** The presentation survives response boundaries and interruptions; it has a finite budget. */
export class Presentation {
  private state: PresentationState;
  constructor(initial: PresentationState = EMPTY_PRESENTATION) { this.state = { ...initial, status: initial.status === "active" ? "paused" : initial.status }; }
  snapshot(): PresentationState { return { ...this.state }; }
  start(goal = "", path = "", mode: "canvas" | "file" = "canvas"): void { this.state = { ...EMPTY_PRESENTATION, status: "active", goal, path, mode }; }
  pause(): void { if (this.state.status === "active") this.state.status = "paused"; }
  resume(): void { if (this.state.status === "paused") this.state.status = "active"; }
  finish(): void { this.state.status = "completed"; }
  locate(path: string, page: number, totalPages: number, mode: "canvas" | "file" = "canvas"): void {
    this.state = { ...this.state, path, mode, page: Math.max(1, Math.trunc(page)), totalPages: Math.max(0, Math.trunc(totalPages)) };
  }
  segmentPlayed(): void { this.state.segments += 1; if (this.state.segments >= 100) this.pause(); }
  shouldContinue(): boolean { return this.state.status === "active" && this.state.segments < 100; }
  userText(text: string): void {
    const clean = text.trim().replace(/[。！!?？.,，]/g, "").toLowerCase();
    if (/^(?:先|请|帮我)?(?:暂停|停一下|先停|等一下|pause|hold on)(?:讲解|一下|一会儿|please)?$/.test(clean)) this.pause();
    else if (/^(?:不用讲了|别讲了|停止讲解|结束讲解|stop presenting|stop the presentation)$/.test(clean)) this.finish();
    else if (/^(?:继续|接着讲|继续讲解|resume|continue|keep going)(?:吧|讲|说)?$/.test(clean)) this.resume();
    else if (/(?:逐页|一页一页).{0,8}(?:讲|介绍|解读)|(?:整份|全文|从头到尾|全部|完整).{0,12}(?:讲解|讲一遍|讲完)|讲完|讲一遍|带我.{0,20}(?:读|看|讲)|walk me through|present (?:the|this|these)|page by page.{0,20}(?:explain|present|walk)/i.test(text)) {
      if (this.state.status !== "active") this.start(text, this.state.path, this.state.mode);
    }
  }
  cue(): string {
    const s = this.state;
    const where = s.path ? `材料 ${s.path}，当前第 ${s.page} 页${s.totalPages ? `，共 ${s.totalPages} 页` : ""}。` : "";
    return `继续用户已经要求的讲解任务。${where}从刚才实际讲到的位置接上，不要重复开场。当前页讲完就用 show_stage 翻到下一页并讲解。没有读到内容先阅读。讲到最后一页且内容已经讲完，调用 manage_presentation(action='complete')，简短总结后停下。不要等待用户说继续。不要把本提示当成用户新说的话。`;
  }
}

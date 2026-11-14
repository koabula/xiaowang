import { randomUUID } from "node:crypto";
import type { StageReceipt, StageView } from "../../src/stage.ts";

export class StageRequests {
  private readonly pending = new Map<string, { slug: string; page: number; resolve(value: StageReceipt): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly send: (note: { slug: string; requestId: string } & StageView) => void;
  private readonly timeoutMs: number;
  constructor(send: (note: { slug: string; requestId: string } & StageView) => void, timeoutMs = 12_000) { this.send = send; this.timeoutMs = timeoutMs; }
  show(slug: string, view: StageView): Promise<StageReceipt | void> {
    if (view.mode === "browser") { this.send({ slug, requestId: "", ...view }); return Promise.resolve(); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("展示区没有确认页面已就绪。请先打开该任务的资料或 Canvas，再重试。")); }, this.timeoutMs);
      this.pending.set(requestId, { slug, page: view.page ?? 1, resolve, reject, timer });
      this.send({ slug, requestId, ...view });
    });
  }
  acknowledge(slug: string, requestId: string, receipt: StageReceipt & { error?: string }): boolean {
    const item = this.pending.get(requestId);
    if (!item || item.slug !== slug) return false;
    if (!receipt.error && Number.isSafeInteger(receipt.page) && receipt.page >= 1 && receipt.page <= receipt.totalPages && receipt.page !== item.page) return false;
    clearTimeout(item.timer); this.pending.delete(requestId);
    if (receipt.error) item.reject(new Error(receipt.error));
    else if (!Number.isSafeInteger(receipt.page) || !Number.isSafeInteger(receipt.totalPages) || receipt.page < 1 || receipt.totalPages < receipt.page) item.reject(new Error("展示区返回了无效页码。"));
    else item.resolve(receipt);
    return true;
  }
  dispose(): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("展示窗口已关闭。")); } this.pending.clear(); }
}

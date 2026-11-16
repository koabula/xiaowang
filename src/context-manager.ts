import { createHash } from "node:crypto";
import { hydrateImages } from "./attachments.ts";
import { projectContextUnits } from "./project.ts";
import { PROJECTOR_VERSION, rebuildProjection, renderEntry, type ProjectionEntry } from "./event-projection.ts";
import { DEFAULT_CONTEXT_POLICY, inputCapacity, measureRequest, validatePolicy, withoutImageBytes, type ContextPolicy, type TokenBudget } from "./token-budget.ts";
import type { Store } from "./store.ts";
import type { CompletionRequest, CompletionResult, LlmProvider, ModelMessage, StoredEvent, ToolSchema } from "./types.ts";

export interface ContextAddition { key: string; message: ModelMessage }
export interface PreparedContext { request: CompletionRequest; budget: TokenBudget }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Canonical events + versioned projection manifests. No inference occurs during projection. */
export class ContextManager {
  readonly scope: string;
  readonly policy: ContextPolicy;
  private epoch = 0;
  private entries: ProjectionEntry[] = [];
  private sources: Record<string, string> = {};
  private states: Record<string, number> = {};
  private pinned = new Set<string>();
  private throughEventId = 0;
  private events = new Map<number, StoredEvent>();
  private frames = new Map<number, ModelMessage["images"]>();
  private previous: Array<{ hash: string; tokens: number }> = [];
  private readonly store: Store;
  private readonly botId: string;
  private readonly system: string;
  private readonly tools: ToolSchema[];

  constructor(store: Store, botId: string, system: string, tools: ToolSchema[], provider: LlmProvider) {
    this.store = store; this.botId = botId; this.system = system; this.tools = tools;
    this.policy = { ...DEFAULT_CONTEXT_POLICY, ...provider.contextPolicy };
    validatePolicy(this.policy);
    this.scope = digest([PROJECTOR_VERSION, provider.contextKey ?? provider.model, system, tools, this.policy]);
    const events = store.getEvents(botId);
    if (!events.some(({ event }) => event.type === "context_scope" && event.scope === this.scope)) {
      events.push(store.append(botId, { type: "context_scope", scope: this.scope, projectorVersion: PROJECTOR_VERSION,
        system, tools, policy: this.policy, model: provider.model }));
    }
    this.events = new Map(events.map(event => [event.id, event]));
    for (const { event } of events) {
      if ((event.type !== "context_append" && event.type !== "context_checkpoint") || event.scope !== this.scope || event.projectorVersion !== PROJECTOR_VERSION) continue;
      if (event.type === "context_checkpoint") { this.entries = []; this.sources = {}; this.states = {}; }
      this.entries.push(...structuredClone(event.entries));
      Object.assign(this.sources, event.sources); Object.assign(this.states, event.states);
      this.epoch = event.epoch; this.throughEventId = event.throughEventId; this.pinned = new Set(event.pinned);
    }
  }

  ingest(events: StoredEvent[], boundaryIds: number[], additions: ContextAddition[]): void {
    for (const stored of events) {
      if (stored.botId !== this.botId) throw new Error("不能把其他 bot 的事件加入当前上下文。");
      this.events.set(stored.id, stored); this.throughEventId = Math.max(this.throughEventId, stored.id);
    }
    const incoming: ProjectionEntry[] = [];
    const changedSources: Record<string, string> = {};
    const changedStates: Record<string, number> = {};
    const states: ProjectionEntry[] = [];
    for (const item of additions) {
      const message = withoutImageBytes(item.message);
      if (item.message.images?.length) message.content += "\n本状态的临时页面画面只在当前进程内可用；没有实际图像时，不要声称已看过，可重新读取原件。";
      const previous = this.events.get(this.states[item.key] ?? -1)?.event;
      const unchanged = previous?.type === "context_state" && digest(previous.message) === digest(message) && previous.frameHash === (item.message.images?.length ? digest(item.message.images) : undefined);
      if (unchanged) {
        if (item.message.images?.length) this.frames.set(this.states[item.key]!, item.message.images);
        continue;
      }
      const stored = this.store.append(this.botId, { type: "context_state", scope: this.scope, key: item.key, message,
        ...(item.message.images?.length ? { transientImages: item.message.images.length, frameHash: digest(item.message.images) } : {}) });
      this.events.set(stored.id, stored); this.throughEventId = Math.max(this.throughEventId, stored.id);
      if (item.message.images?.length) this.frames.set(stored.id, structuredClone(item.message.images));
      changedStates[item.key] = stored.id;
      states.push({ source: `state:${stored.id}`, eventIds: [stored.id], kind: "state", stateKey: item.key, rendering: "full" });
    }
    const boundaries = new Set(boundaryIds.map(String));
    let inserted = false;
    for (const unit of projectContextUnits(events)) {
      const hash = digest([unit.eventIds, unit.messages]);
      const previous = this.sources[unit.source];
      const refocused = boundaries.has(unit.source) && !this.pinned.has(unit.source);
      if (previous === hash && !refocused) continue;
      if (boundaries.has(unit.source) && !inserted) { incoming.push(...states); inserted = true; }
      incoming.push({ source: unit.source, eventIds: unit.eventIds, kind: "conversation", rendering: "full", ...(unit.jobId ? { jobId: unit.jobId } : {}), ...(previous && previous !== hash ? { correction: true } : {}) });
      changedSources[unit.source] = hash;
    }
    if (!inserted) incoming.push(...states);
    if (!incoming.length && JSON.stringify([...this.pinned]) === JSON.stringify([...boundaries])) return;
    this.persist("context_append", incoming, changedSources, changedStates, boundaries);
    this.entries.push(...incoming); this.pinned = boundaries;
    Object.assign(this.sources, changedSources); Object.assign(this.states, changedStates);
  }

  private persist(type: "context_append" | "context_checkpoint", entries: ProjectionEntry[], sources: Record<string, string>, states: Record<string, number>, pinned: Set<string>, epoch = this.epoch): void {
    this.store.append(this.botId, { type, projectorVersion: PROJECTOR_VERSION, scope: this.scope, epoch,
      throughEventId: this.throughEventId, entries, sources, states, pinned: [...pinned] });
  }

  private resolve = (entry: ProjectionEntry): ModelMessage[] => {
    const messages = renderEntry(entry, this.events);
    if (entry.kind === "state" && this.frames.has(entry.eventIds[0]!)) messages[0]!.images = this.frames.get(entry.eventIds[0]!);
    return hydrateImages(this.store, this.botId, messages);
  };

  private request(entries: ProjectionEntry[], signal?: AbortSignal, epoch = this.epoch): CompletionRequest {
    return { system: this.system, tools: this.tools, messages: entries.flatMap(this.resolve),
      maxOutputTokens: this.policy.outputTokens, preserveMessageBlocks: true,
      cacheKey: digest([this.botId, this.scope, epoch]), signal };
  }

  private async measure(request: CompletionRequest, provider: LlmProvider): Promise<TokenBudget> {
    const budget = measureRequest(request, this.policy);
    if (provider.countTokens) {
      const count = await provider.countTokens(request);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("模型服务返回了无效 token 计数。");
      budget.input = count; budget.total = count + budget.output + budget.safety; budget.method = "provider-count";
    }
    return budget;
  }

  async prepare(provider: LlmProvider, signal?: AbortSignal): Promise<PreparedContext> {
    signal?.throwIfAborted();
    let request = this.request(this.entries, signal);
    let budget = await this.measure(request, provider);
    const capacity = inputCapacity(this.policy);
    if (budget.input > capacity * this.policy.highWater) {
      for (const target of [capacity * this.policy.lowWater, 0]) {
        const plan = rebuildProjection({ entries: this.entries, events: this.events, pinned: this.pinned,
          system: this.system, tools: this.tools, policy: this.policy, throughEventId: this.throughEventId, target, resolve: this.resolve });
        if (!plan.changed) continue;
        const nextRequest = this.request(plan.entries, signal, this.epoch + 1);
        const nextBudget = await this.measure(nextRequest, provider);
        signal?.throwIfAborted();
        if (nextBudget.total <= nextBudget.window && nextBudget.input < budget.input) {
          this.persist("context_checkpoint", plan.entries, { ...this.sources }, { ...this.states }, this.pinned, this.epoch + 1);
          this.epoch++; this.entries = plan.entries; this.previous = [];
          request = nextRequest; budget = nextBudget; break;
        }
        if (nextBudget.total <= nextBudget.window) break;
      }
    }
    signal?.throwIfAborted();
    if (budget.total > budget.window) throw new Error(`本次输入超出上下文预算（估计/计数输入 ${budget.input}，可用 ${capacity} tokens）。请减少单次附件或原文范围，或调整模型上下文配置。原始事件与当前投影已保留。`);
    return { request, budget };
  }

  async complete(provider: LlmProvider, prepared: PreparedContext): Promise<CompletionResult> {
    const { request, budget } = prepared;
    const current = request.messages.map(message => ({ hash: digest(message), tokens: measureRequest({ system: "", tools: [], messages: [message] }, this.policy).input }));
    let prefixTokens = 0;
    if (this.previous.length) {
      prefixTokens = budget.system + budget.tools;
      for (let i = 0; i < Math.min(current.length, this.previous.length); i++) {
        if (current[i]!.hash !== this.previous[i]!.hash) break;
        prefixTokens += current[i]!.tokens;
      }
    }
    const requestHash = digest([PROJECTOR_VERSION, this.scope, this.epoch, request.system, request.tools, request.messages, request.maxOutputTokens]);
    const started = Date.now();
    let result: CompletionResult | undefined;
    try {
      result = await provider.complete(request);
      request.signal?.throwIfAborted();
      this.store.append(this.botId, { type: "model_usage", scope: this.scope, epoch: this.epoch, requestHash,
        model: provider.model, budget, usage: result.usage, durationMs: Date.now() - started, prefixTokens: Math.min(prefixTokens, budget.input) });
      this.previous = current;
      return result;
    } catch (error) {
      this.store.append(this.botId, { type: "model_usage", scope: this.scope, epoch: this.epoch, requestHash,
        model: provider.model, budget, usage: result?.usage, durationMs: Date.now() - started, prefixTokens: 0, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
      throw error;
    }
  }
}

export function contextUsage(store: Store, botId: string) {
  const calls = store.getEvents(botId).flatMap(({ event }) => event.type === "model_usage" ? [event] : []);
  const reported = calls.filter(call => call.usage?.inputTokens !== undefined);
  const cacheReported = reported.filter(call => call.usage?.cacheReadTokens !== undefined);
  const cacheInput = cacheReported.reduce((sum, call) => sum + call.usage!.inputTokens!, 0);
  const read = cacheReported.reduce((sum, call) => sum + call.usage!.cacheReadTokens!, 0);
  return {
    requests: calls.length, failures: calls.filter(call => call.error).length,
    reportedRequests: reported.length, cacheReportedRequests: cacheReported.length,
    inputTokens: reported.length ? reported.reduce((sum, call) => sum + call.usage!.inputTokens!, 0) : null,
    outputTokens: calls.some(call => call.usage?.outputTokens !== undefined) ? calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0) : null,
    cacheReadTokens: cacheReported.length ? read : null,
    cacheWriteTokens: calls.some(call => call.usage?.cacheWriteTokens !== undefined) ? calls.reduce((sum, call) => sum + (call.usage?.cacheWriteTokens ?? 0), 0) : null,
    cacheReadRatio: cacheInput ? read / cacheInput : null,
    checkpoints: store.getEvents(botId).filter(({ event }) => event.type === "context_checkpoint").length,
  };
}

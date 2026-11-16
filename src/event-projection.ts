import { projectContextUnits } from "./project.ts";
import type { ModelMessage, StoredEvent, ToolSchema } from "./types.ts";
import { measureRequest, type ContextPolicy } from "./token-budget.ts";

export const PROJECTOR_VERSION = 2;
export interface ProjectionEntry {
  source: string;
  eventIds: number[];
  kind: "conversation" | "state" | "archive";
  stateKey?: string;
  jobId?: string;
  correction?: boolean;
  rendering: "full" | "excerpt" | "reference" | "index";
}

/** Pure rendering: only the exact event revisions named in a manifest participate. */
export function renderEntry(entry: ProjectionEntry, events: ReadonlyMap<number, StoredEvent>): ModelMessage[] {
  if (entry.kind === "archive") {
    const ids = entry.eventIds;
    return [{ role: "user", content: `较早历史未在本次输入展开（${ids.length} 个来源事件，编号范围 ${ids[0]}–${ids.at(-1)}）。原始事件保持完整。需要历史要求、结论或工具细节时，使用 search_memory 检索，再用 inspect_event 按编号分页读取。这里没有生成历史摘要。` }];
  }
  const selected = entry.eventIds.map(id => {
    const stored = events.get(id);
    if (!stored) throw new Error(`上下文来源事件 ${id} 不可用。`);
    return stored;
  });
  if (entry.kind === "state") {
    const event = selected[0]?.event;
    if (event?.type !== "context_state") throw new Error("上下文状态来源无效。");
    return [structuredClone(event.message)];
  }
  const units = projectContextUnits(selected);
  const messages = units.flatMap(unit => unit.messages);
  if (entry.rendering === "reference") {
    const first = selected[0]!;
    const names = first.event.type === "assistant_turn" ? first.event.toolCalls.map(call => call.name).join("、") : first.event.type;
    return [{ role: "user", content: `历史事件 ${entry.eventIds.join("、")}（${names}）未展开。用 inspect_event 读取原文，search_memory 查找相关记录。` }];
  }
  if (entry.rendering === "excerpt") {
    return messages.map(message => message.role === "tool" && message.content.length > 1200 ? {
      ...message, content: `${message.content.slice(0, 1200)}\n[固定首段摘录；完整结果见事件 ${selected.find(item => item.event.type === "tool_result" && item.event.callId === message.toolCallId)?.id}，用 inspect_event 分页读取。]`,
    } : message);
  }
  return entry.correction ? [{ role: "user", content: `先前记录的更新（来源事件 ${entry.eventIds.join("、")}）：${JSON.stringify(messages.map(({ protocol: _protocol, ...message }) => message))}` }] : messages;
}

export interface ProjectionPlan {
  entries: ProjectionEntry[];
  changed: boolean;
}

/** Deterministic budget selection. Rebuild only at a watermark; keep user requirements and latest states. */
export function rebuildProjection(options: {
  entries: ProjectionEntry[];
  events: ReadonlyMap<number, StoredEvent>;
  pinned: ReadonlySet<string>;
  system: string;
  tools: ToolSchema[];
  policy: ContextPolicy;
  throughEventId: number;
  target: number;
  resolve: (entry: ProjectionEntry) => ModelMessage[];
}): ProjectionPlan {
  const { entries, events, pinned, system, tools, policy, target, resolve } = options;
  let candidate = structuredClone(entries);
  const latestState = new Map<string, string>();
  for (const entry of entries) if (entry.kind === "state") latestState.set(entry.stateKey!, entry.source);
  const latestConversation = new Map<string, ProjectionEntry>();
  for (const entry of candidate) if (entry.kind === "conversation") latestConversation.set(entry.source, entry);
  const lastConversation = candidate.findLast(entry => entry.kind === "conversation");
  const implicitPinned = new Set<string>();
  if (!pinned.size) {
    const user = entries.findLastIndex(entry => entry.kind === "conversation" && resolve(entry)[0]?.role === "user");
    let start = user;
    while (start > 0 && !(entries[start - 1]!.kind === "conversation" && resolve(entries[start - 1]!)[0]?.role === "assistant")) start--;
    for (let i = start; i <= user; i++) if (entries[i]?.kind === "conversation") implicitPinned.add(entries[i]!.source);
  }
  const required = (entry: ProjectionEntry) => entry.kind === "state" ? latestState.get(entry.stateKey!) === entry.source
    : entry === lastConversation || ((pinned.has(entry.source) || implicitPinned.has(entry.source)) && latestConversation.get(entry.source) === entry);
  const archived = new Set(candidate.filter(entry => entry.kind === "archive").flatMap(entry => entry.eventIds));
  candidate = candidate.filter(entry => entry.kind !== "archive");
  const appendIndex = (list: ProjectionEntry[]) => archived.size ? [{ source: "archive", eventIds: [...archived].sort((a, b) => a - b), kind: "archive" as const, rendering: "index" as const }, ...list] : list;
  const cost = () => measureRequest({ system, tools, messages: appendIndex(candidate).flatMap(resolve) }, policy).input;
  // Superseded state is queryable in the log, while the latest exact state remains present.
  candidate = candidate.filter(entry => {
    if (entry.kind !== "state" || required(entry)) return true;
    entry.eventIds.forEach(id => archived.add(id)); return false;
  });
  // Fold complete old tool units, preserving valid tool-call/result pairs.
  for (const entry of candidate) {
    if (cost() <= target) break;
    if (required(entry) || entry.kind !== "conversation" || entry.correction) continue;
    const first = events.get(entry.eventIds[0]!)?.event;
    if (first?.type !== "assistant_turn" || !first.toolCalls.length) continue;
    // Opaque thinking/signature blocks are indivisible; archive the whole native unit instead.
    entry.rendering = first.protocol ? "reference" : "excerpt";
    if (cost() > target && first.toolCalls.some(call => JSON.stringify(call.input).length > 1200)) entry.rendering = "reference";
  }
  // Completed work is archived before other old conversation units. Order within each class is chronological.
  const jobs = new Map<string, string>();
  for (const { id, event } of events.values()) if (id <= options.throughEventId && event.type === "job") jobs.set(event.job.id, event.job.status);
  const optional = candidate.filter(entry => !required(entry));
  optional.sort((a, b) => Number(!["succeeded", "cancelled", "failed", "interrupted"].includes(jobs.get(a.jobId ?? "") ?? "")) - Number(!["succeeded", "cancelled", "failed", "interrupted"].includes(jobs.get(b.jobId ?? "") ?? "")));
  for (const entry of optional) {
    if (cost() <= target) break;
    candidate = candidate.filter(item => item !== entry);
    entry.eventIds.forEach(id => archived.add(id));
  }
  candidate = appendIndex(candidate);
  return { entries: candidate, changed: JSON.stringify(candidate) !== JSON.stringify(entries) };
}

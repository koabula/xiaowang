import type { ContextAddition } from "./context-manager.ts";
import { outputLimited } from "./protocol-history.ts";
import { createHash } from "node:crypto";
import type { Locale } from "./locale.ts";
import { stableLlmSystem, taskMetadata } from "./project.ts";
import { contextDescription, type WorkspaceContext } from "./shared-context.ts";
import type { Runtime } from "./runtime.ts";
import type { BrowserDriver, StageDriver } from "./stage.ts";
import { executeTool, toolSchemas } from "./tools.ts";
import type { Bot, Channel, CompletionResult, LlmProvider, StoredEvent, ToolCall } from "./types.ts";

const QUIET_STEP_CAP = 40;
const MAX_KICKOFFS = 5;

export interface StepEvent {
  bot: Bot;
  kind: "assistant" | "tool";
  text: string;
  name?: string;
  isError?: boolean;
  activity?: string;
  eventId?: number;
  final?: boolean;
}

export interface TurnResult {
  bot: Bot;
  finalText: string;
  steps: number;
  kickoffs: TurnResult[];
  skippedKickoffs: number;
}

export interface RunTurnOptions {
  sharedContext?: WorkspaceContext;
  sharedImages?: Array<{ mimeType: string; data: string }>;
  messageText?: string;
  attachments?: import("./types.ts").Attachment[];
  botId: string;
  input: string;
  provider: LlmProvider;
  channel?: Channel;
  maxSteps?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  browser?: BrowserDriver;
  stage?: StageDriver;
  locale?: Locale;
  signal?: AbortSignal;
  onStep?: (step: StepEvent) => void;
  onTextDelta?: (bot: Bot, text: string) => void;
  onKickoff?: (job: import("./types.ts").Kickoff) => void;
  jobId?: string;
  inputEventId?: number;
  excludeJobIds?: string[];
  readUpdates?: () => { events: StoredEvent[]; sharedContext?: WorkspaceContext; sharedImages?: Array<{ mimeType: string; data: string }> };
  onInput?: (eventId: number) => void;
}

/**
 * 一次用户发言唤醒执行循环：追加模型上下文，检查预算，调用模型，执行工具，再写回会话。
 * 模型连接本身不保存记忆。派生项目的首轮调研在当前轮结束后单独跑，避免嵌进同一次工具调用。
 */
export async function runTurn(runtime: Runtime, options: RunTurnOptions): Promise<TurnResult> {
  // Keep kickoffs local to this parent turn. The desktop queue may otherwise
  // dispatch a child between spawn_bot and a later share_file tool call.
  const pending: import("./types.ts").Kickoff[] = [];
  let finished = false;
  const primary = await runTurnOnce(runtime, { ...options, onKickoff: job => pending.push(job), onStep(step) { finished = Boolean(step.final); options.onStep?.(step); } });
  if (!options.signal?.aborted && finished) {
    for (const job of pending) {
      if (options.onKickoff) options.onKickoff(job);
      else runtime.enqueueKickoff(job);
    }
  }
  if (options.onKickoff) return primary;
  const kickoffs: TurnResult[] = [];
  let ran = 0;
  while (runtime.kickoffs.length > 0 && ran < MAX_KICKOFFS) {
    const job = runtime.kickoffs.shift();
    if (!job) break;
    ran += 1;
    kickoffs.push(
      await runTurnOnce(runtime, {
        ...options,
        botId: job.botId,
        input: job.task,
        jobId: undefined, inputEventId: undefined, excludeJobIds: undefined, readUpdates: undefined,
        attachments: undefined,
        messageText: undefined,
        sharedContext: undefined, sharedImages: undefined,
        channel: "system",
      }),
    );
  }
  const skipped = runtime.kickoffs.splice(0);
  for (const job of skipped) {
    runtime.store.append(job.botId, { type: "user_text", channel: "system", text: job.task });
  }
  return { ...primary, kickoffs, skippedKickoffs: skipped.length };
}

async function runTurnOnce(runtime: Runtime, options: RunTurnOptions): Promise<TurnResult> {
  await options.provider.resolveContextPolicy?.(options.signal);
  const bot = runtime.store.requireBot(options.botId);
  const maxSteps = options.maxSteps ?? QUIET_STEP_CAP;
  // Only explicitly addressed supplements enter this turn. Other calls and jobs stay isolated.
  const initialUpdates = options.readUpdates?.();
  const supplementIds = new Set(initialUpdates?.events.map(event => event.id));
  const history = runtime.store.getEvents(bot.id);
  const excluded = new Set(options.excludeJobIds);
  const context = history.filter(stored => !supplementIds.has(stored.id) && stored.id !== options.inputEventId
    && !(("jobId" in stored.event) && stored.event.jobId && excluded.has(stored.event.jobId)));
  let sharedContext = initialUpdates?.sharedContext ?? options.sharedContext;
  let sharedImages = initialUpdates?.sharedImages ?? options.sharedImages;
  function receiveUpdates(): number {
    const updates = options.readUpdates?.();
    const known = new Set(context.map(event => event.id));
    const incoming = updates?.events.filter(event => !known.has(event.id)) ?? [];
    context.push(...incoming);
    if (incoming.length) {
      sharedContext = updates?.sharedContext;
      sharedImages = updates?.sharedImages;
    }
    return incoming.length;
  }
  const inputEvent = history.find(event => event.id === options.inputEventId);
  context.push(inputEvent ?? runtime.store.append(bot.id, {
    type: "user_text",
    channel: options.channel ?? "text",
    text: options.messageText ?? options.input,
    jobId: options.jobId,
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
  }));
  options.onInput?.(context.at(-1)!.id);

  const allowSpawn = options.channel !== "voice";
  const tools = toolSchemas(allowSpawn);
  const manager = runtime.modelContext(bot, stableLlmSystem(bot, runtime.ensureSteward().name, options.locale), tools, options.provider);
  const boundaryIds = [context.at(-1)!.id, ...(initialUpdates?.events.map(event => event.id) ?? [])];
  let metadata = taskMetadata(bot, context, runtime.store.listLibrary(bot.id).map(ref => ({ id: ref.id, filename: ref.filename })));
  let lastText = "";
  for (let step = 1; step <= maxSteps; step += 1) {
    if (options.signal?.aborted) {
      return { bot: runtime.store.requireBot(bot.id), finalText: lastText, steps: step - 1, kickoffs: [], skippedKickoffs: 0 };
    }
    let received = receiveUpdates();
    const current = runtime.store.requireBot(bot.id);
    let prepared: Awaited<ReturnType<typeof manager.prepare>>;
    do {
      if (received) metadata = taskMetadata(current, context, runtime.store.listLibrary(bot.id).map(ref => ({ id: ref.id, filename: ref.filename })));
      const additions: ContextAddition[] = [{ key: "task", message: { role: "user" as const, content: metadata } }];
      if (sharedContext) {
        const attached = new Set(context.flatMap(({ event }) => event.type === "user_text" ? event.attachments?.map(item => item.refId) ?? [] : []));
        additions.push({ key: "workspace", message: {
          role: "user", content: contextDescription(sharedContext),
          attachments: (sharedContext.imageAttachments ?? sharedContext.message?.attachments)?.filter(item => !attached.has(item.refId)),
          images: sharedImages,
        } });
      }
      const updates = options.readUpdates?.();
      manager.ingest(context, [...boundaryIds, ...(updates?.events.map(event => event.id) ?? [])], additions);
      prepared = await manager.prepare(options.provider, options.signal);
      received = receiveUpdates();
    } while (received);
    prepared.request.onTextDelta = options.onTextDelta ? text => options.onTextDelta?.(current, text) : undefined;
    const result = await manager.complete(options.provider, prepared);
    options.signal?.throwIfAborted();
    lastText = result.text;
    if (outputLimited(result.stopReason)) {
      runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: result.text, toolCalls: [],
        protocol: result.protocol, stopReason: result.stopReason, jobId: options.jobId });
      throw new Error("这次回答达到长度上限，尚未完成。可以先让小王整理方法，再继续整理实验结果。");
    }
    const toolCalls = normalizeToolCalls(result, step, boundaryIds[0]!);
    const knownIds = new Set(context.map(event => event.id));
    const hasUpdates = toolCalls.length === 0 && Boolean(options.readUpdates?.().events.some(event => !knownIds.has(event.id)));
    if (!result.text.trim() && toolCalls.length === 0 && !hasUpdates) {
      if (result.protocol) {
        runtime.store.append(bot.id, { type: "assistant_turn", channel: "text", text: result.text, toolCalls: [], protocol: result.protocol, stopReason: result.stopReason, jobId: options.jobId });
        throw new Error("模型没有返回可用的正文或工具调用，协议记录已保存，请重试。");
      }
      return {
        bot: runtime.store.requireBot(bot.id),
        finalText: lastText,
        steps: step,
        kickoffs: [],
        skippedKickoffs: 0,
      };
    }
    context.push(runtime.store.append(bot.id, {
      type: "assistant_turn",
      channel: "text",
      text: result.text,
      protocol: result.protocol, stopReason: result.stopReason,
      toolCalls,
      jobId: options.jobId,
    }));
    const assistantEventId = context.at(-1)!.id;
    options.onStep?.({
      bot: current,
      kind: "assistant",
      text: result.text,
      activity: toolCalls.length > 0 ? result.text.trim() || undefined : undefined,
      eventId: context.at(-1)!.id,
      final: toolCalls.length === 0 && !hasUpdates,
    });

    if (options.signal?.aborted || (toolCalls.length === 0 && !hasUpdates)) {
      return {
        bot: runtime.store.requireBot(bot.id),
        finalText: result.text,
        steps: step,
        kickoffs: [],
        skippedKickoffs: 0,
      };
    }

    for (const call of toolCalls) {
      if (options.signal?.aborted) {
        return {
          bot: runtime.store.requireBot(bot.id),
          finalText: lastText,
          steps: step,
          kickoffs: [],
          skippedKickoffs: 0,
        };
      }
      const outcome = await executeTool(call.name, call.input, {
        allowSpawn,
        store: runtime.store,
        bot: runtime.store.requireBot(bot.id),
        enqueueKickoff: (job) => options.onKickoff ? options.onKickoff(job) : runtime.enqueueKickoff(job),
        fetchImpl: options.fetchImpl,
        env: options.env ?? process.env,
        browser: options.browser,
        stage: options.stage,
        signal: options.signal,
      });
      context.push(runtime.store.append(bot.id, {
        type: "tool_result",
        assistantEventId, jobId: options.jobId,
        callId: call.id,
        name: call.name,
        output: outcome.output,
        isError: outcome.isError,
      }));
      if (outcome.artifact) {
        context.push(runtime.store.append(bot.id, { type: "artifact", ...outcome.artifact }));
      }
      options.onStep?.({
        bot: runtime.store.requireBot(bot.id),
        kind: "tool",
        text: outcome.output,
        name: call.name,
        isError: outcome.isError,
      });
    }
  }

  if (receiveUpdates() > 0 || options.readUpdates) throw new Error("本轮达到处理步数上限。已有输出和补充信息已保存，可重试继续。");
  return {
    bot: runtime.store.requireBot(bot.id),
    finalText: lastText,
    steps: maxSteps,
    kickoffs: [],
    skippedKickoffs: 0,
  };
}

function normalizeToolCalls(result: CompletionResult, step: number, inputEventId: number): ToolCall[] {
  return result.toolCalls.map((call, index) => ({
    id: `xw_${createHash("sha256").update(JSON.stringify([inputEventId, step, index, call.id])).digest("hex").slice(0, 28)}`,
    ...(result.protocol ? { wireId: call.id, arguments: call.arguments } : {}),
    name: call.name,
    input: parseInput(call.arguments),
  }));
}

function parseInput(raw: string): unknown {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

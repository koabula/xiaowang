import type { Locale } from "./locale.ts";
import { projectLlmContext } from "./project.ts";
import type { Runtime } from "./runtime.ts";
import type { BrowserDriver, StageDriver } from "./stage.ts";
import { executeTool, toolSchemas } from "./tools.ts";
import type { Bot, Channel, CompletionResult, LlmProvider, ToolCall } from "./types.ts";

const QUIET_STEP_CAP = 40;
const MAX_KICKOFFS = 5;

export interface StepEvent {
  bot: Bot;
  kind: "assistant" | "tool";
  text: string;
  name?: string;
  isError?: boolean;
  activity?: string;
}

export interface TurnResult {
  bot: Bot;
  finalText: string;
  steps: number;
  kickoffs: TurnResult[];
  skippedKickoffs: number;
}

export interface RunTurnOptions {
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
}

/**
 * 一次用户发言对应一轮无状态循环：从会话投影上下文，调用模型，执行工具，再写回会话。
 * 模型连接本身不保存记忆。派生项目的首轮调研在当前轮结束后单独跑，避免嵌进同一次工具调用。
 */
export async function runTurn(runtime: Runtime, options: RunTurnOptions): Promise<TurnResult> {
  const primary = await runTurnOnce(runtime, options);
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
  const bot = runtime.store.requireBot(options.botId);
  const maxSteps = options.maxSteps ?? QUIET_STEP_CAP;
  runtime.store.append(bot.id, {
    type: "user_text",
    channel: options.channel ?? "text",
    text: options.input,
  });

  let lastText = "";
  for (let step = 1; step <= maxSteps; step += 1) {
    if (options.signal?.aborted) {
      return { bot: runtime.store.requireBot(bot.id), finalText: lastText, steps: step - 1, kickoffs: [], skippedKickoffs: 0 };
    }
    const current = runtime.store.requireBot(bot.id);
    const library = runtime.store.listLibrary(bot.id).map((ref) => ({ id: ref.id, filename: ref.filename }));
    const personName = runtime.ensureSteward().name;
    const projected = projectLlmContext(current, runtime.store.getEvents(bot.id), { library, personName, locale: options.locale });
    const result = await options.provider.complete({
      system: projected.system,
      messages: projected.messages,
      tools: toolSchemas(),
    });
    lastText = result.text;
    const toolCalls = normalizeToolCalls(result, step);
    if (!result.text.trim() && toolCalls.length === 0) {
      return {
        bot: runtime.store.requireBot(bot.id),
        finalText: lastText,
        steps: step,
        kickoffs: [],
        skippedKickoffs: 0,
      };
    }
    runtime.store.append(bot.id, {
      type: "assistant_turn",
      channel: "text",
      text: result.text,
      toolCalls,
    });
    options.onStep?.({
      bot: current,
      kind: "assistant",
      text: result.text,
      activity: toolCalls.length > 0 ? result.text.trim() || undefined : undefined,
    });

    if (options.signal?.aborted || toolCalls.length === 0) {
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
        store: runtime.store,
        bot: runtime.store.requireBot(bot.id),
        enqueueKickoff: (job) => runtime.enqueueKickoff(job),
        fetchImpl: options.fetchImpl,
        env: options.env ?? process.env,
        browser: options.browser,
        stage: options.stage,
      });
      runtime.store.append(bot.id, {
        type: "tool_result",
        callId: call.id,
        name: call.name,
        output: outcome.output,
        isError: outcome.isError,
      });
      if (outcome.artifact) {
        runtime.store.append(bot.id, { type: "artifact", ...outcome.artifact });
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

  return {
    bot: runtime.store.requireBot(bot.id),
    finalText: lastText,
    steps: maxSteps,
    kickoffs: [],
    skippedKickoffs: 0,
  };
}

function normalizeToolCalls(result: CompletionResult, step: number): ToolCall[] {
  return result.toolCalls.map((call, index) => ({
    id: call.id || `call_${step}_${index}`,
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

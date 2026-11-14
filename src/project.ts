import { SHARED_PERSONA } from "./persona.ts";
import type { Bot, ModelMessage, StoredEvent, Term } from "./types.ts";

const TOOL_OUTPUT_CAP = 8_000;
const DEFAULT_BUDGET = 60_000;

export interface LlmProjection {
  system: string;
  messages: ModelMessage[];
  droppedTurns: number;
}

export interface CatalogItem {
  id: string;
  filename: string;
}

export interface VoiceBrief {
  botName: string;
  slug: string;
  goal: string;
  glossary: Term[];
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
  artifacts: string[];
  library?: string[];
}

interface Unit {
  messages: ModelMessage[];
  chars: number;
}

/** 后台 LLM 看到的厚上下文。完整事件仍留在会话记录里。 */
export function projectLlmContext(
  bot: Bot,
  events: StoredEvent[],
  options?: { budget?: number; library?: CatalogItem[] },
): LlmProjection {
  const budget = options?.budget ?? DEFAULT_BUDGET;
  const system = buildSystem(bot, events, options?.library);
  const units = groupUnits(events);
  let dropped = 0;
  while (units.length > 1 && system.length + charCount(units) > budget) {
    units.shift();
    dropped += 1;
  }
  const messages: ModelMessage[] = [];
  if (dropped > 0) {
    messages.push({
      role: "user",
      content: `更早的 ${dropped} 段对话仍在会话记录里，这次没有放进上下文。需要细节时去工作区读笔记，或根据课题基线继续。`,
    });
  }
  for (const unit of units) messages.push(...unit.messages);
  return { system, messages, droppedTurns: dropped };
}

/** 给以后的实时语音用的薄快照。不包含工具原文和长摘要。 */
export function projectVoiceBrief(
  bot: Bot,
  events: StoredEvent[],
  options?: { library?: CatalogItem[] },
): VoiceBrief {
  const turns: VoiceBrief["recentTurns"] = [];
  for (const stored of events) {
    const event = stored.event;
    if (event.type === "user_text" && event.text.trim()) {
      turns.push({ role: "user", text: clip(event.text, 180) });
    } else if (event.type === "assistant_turn" && event.text.trim()) {
      turns.push({ role: "assistant", text: clip(event.text, 180) });
    }
  }
  const artifacts = events
    .filter((stored) => stored.event.type === "artifact")
    .map((stored) => (stored.event.type === "artifact" ? stored.event.path : ""))
    .filter(Boolean);
  const brief: VoiceBrief = {
    botName: bot.name,
    slug: bot.slug,
    goal: clip(bot.systemPrompt || baselinesOf(events).join("\n"), 500),
    glossary: bot.glossary,
    recentTurns: turns.slice(-6),
    artifacts: artifacts.slice(-8),
  };
  if (options?.library) brief.library = catalogLines(options.library);
  return brief;
}

export function formatVoiceBrief(brief: VoiceBrief): string {
  const lines = [
    `项目：${brief.botName}（${brief.slug}）`,
    `目标：${brief.goal || "还没有写下课题目标。"}`,
  ];
  if (brief.glossary.length > 0) {
    lines.push(
      `术语：${brief.glossary
        .map((term) => (term.alias ? `${term.term}（${term.alias}）` : term.term))
        .join("、")}`,
    );
  }
  if (brief.artifacts.length > 0) {
    lines.push(`已有文件：${brief.artifacts.join("、")}`);
  }
  if (brief.library) {
    lines.push(brief.library.length > 0 ? `资料库：${brief.library.join("、")}` : "资料库：还没有引用。");
  }
  if (brief.recentTurns.length === 0) {
    lines.push("最近对话：还没有。");
  } else {
    lines.push("最近对话：");
    for (const turn of brief.recentTurns) {
      const who = turn.role === "user" ? "用户" : "小王";
      lines.push(`- ${who}：${turn.text}`);
    }
  }
  return lines.join("\n");
}

function buildSystem(bot: Bot, events: StoredEvent[], library?: CatalogItem[]): string {
  const parts = [
    SHARED_PERSONA,
    "",
    `当前项目：${bot.name}（${bot.slug}）`,
    `工作区根目录：${bot.workspaceDir}`,
    "文件工具只接受这个工作区内的相对路径，例如 notes/reading.md。不要使用 ..，也不要读写别的 Bot 的目录。",
  ];
  if (library) {
    const shown = catalogLines(library);
    parts.push(
      "",
      shown.length > 0
        ? `本项目资料库：\n${shown.map((line) => `- ${line}`).join("\n")}`
        : "本项目资料库还没有引用。用户交给这个项目的 PDF 会出现在这里，用 read_document 阅读。",
    );
    if (library.length > shown.length) parts.push(`还有 ${library.length - shown.length} 份引用没有列在这里。需要时用 list_library。`);
  }
  const baselines = baselinesOf(events);
  const prompt = bot.systemPrompt.trim();
  if (prompt && !baselines.includes(prompt)) {
    parts.push("", "项目要求：", prompt);
  }
  if (baselines.length > 0) {
    parts.push("", "课题基线：");
    for (const baseline of baselines) parts.push(`- ${baseline}`);
  }
  if (bot.glossary.length > 0) {
    parts.push("", "课题术语：");
    for (const term of bot.glossary) {
      parts.push(term.alias ? `- ${term.term}：${term.alias}` : `- ${term.term}`);
    }
  }
  return parts.join("\n");
}

function baselinesOf(events: StoredEvent[]): string[] {
  const lines: string[] = [];
  for (const stored of events) {
    if (stored.event.type === "baseline" && stored.event.text.trim()) {
      lines.push(stored.event.text.trim());
    }
  }
  return lines;
}

function groupUnits(events: StoredEvent[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]?.event;
    if (!event) continue;
    if (event.type === "user_text") {
      units.push(toUnit([{ role: "user", content: event.text }]));
      continue;
    }
    if (event.type !== "assistant_turn") continue;

    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: event.text,
        toolCalls:
          event.toolCalls.length > 0
            ? event.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.input ?? {}),
              }))
            : undefined,
      },
    ];
    if (event.toolCalls.length > 0) {
      const seen = new Set<string>();
      while (i + 1 < events.length) {
        const next = events[i + 1]?.event;
        if (!next || next.type === "user_text" || next.type === "assistant_turn") break;
        i += 1;
        if (next.type !== "tool_result") continue;
        seen.add(next.callId);
        messages.push({
          role: "tool",
          toolCallId: next.callId,
          content: capToolOutput(next.output),
        });
      }
      for (const call of event.toolCalls) {
        if (seen.has(call.id)) continue;
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: "工具执行被中断，没有结果。请重新调用。",
        });
      }
    }
    units.push(toUnit(messages));
  }
  return units;
}

function toUnit(messages: ModelMessage[]): Unit {
  const chars = messages.reduce((sum, message) => {
    const args = message.toolCalls?.reduce((inner, call) => inner + call.arguments.length, 0) ?? 0;
    return sum + message.content.length + args;
  }, 0);
  return { messages, chars };
}

function charCount(units: Unit[]): number {
  return units.reduce((sum, unit) => sum + unit.chars, 0);
}

function capToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_CAP) return output;
  return `${output.slice(0, TOOL_OUTPUT_CAP)}\n…[已截断。会话记录里仍保留全文 ${output.length} 字；需要时请读工作区里的笔记，或重新检索。]`;
}

function catalogLines(library: CatalogItem[]): string[] {
  return library.slice(0, 40).map((item) => `${item.id} ${item.filename}`);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

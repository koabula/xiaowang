import type { StoredEvent } from "./types.ts";

// Derived manifests and usage records are deliberately excluded from model-facing history retrieval.
export const MEMORY_TYPES = ["user_text", "assistant_turn", "tool_result", "voice_line", "call", "baseline", "artifact", "context_state"] as const;
export function memoryText(stored: StoredEvent): string {
  const event = stored.event;
  switch (event.type) {
    case "user_text": return event.text + (event.attachments?.length ? `\n附件引用：${JSON.stringify(event.attachments)}` : "");
    case "assistant_turn": return event.text + (event.toolCalls.length ? `\n工具调用：${JSON.stringify(event.toolCalls)}` : "");
    case "tool_result": return event.output;
    case "voice_line": return `${event.who}：${event.text}`;
    case "call": return event.lines.map(line => `${line.who}：${line.text}`).join("\n");
    case "baseline": return event.text;
    case "artifact": return `${event.path} (${event.bytes} bytes)`;
    case "context_state": return event.message.content;
    default: throw new Error("此类内部事件不提供历史反查。");
  }
}

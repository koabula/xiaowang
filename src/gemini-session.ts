import type { ToolSchema } from "./types.ts";
import type { GeminiTool } from "./gemini-live.ts";

/** Convert the common tool schema to Gemini's protobuf Schema. Local executors
 * still validate inputs; OpenAI-only strictness fields must not cross the wire. */
function schema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["additionalProperties", "$schema"].includes(key)).map(([key, item]) => [key, key === "type" && typeof item === "string" ? item.toUpperCase() : schema(item)]));
}
export function geminiSession(instructions: string, tools: ToolSchema[], voice: string, model: string): Record<string, unknown> {
  const declarations: GeminiTool[] = tools.filter(tool => tool.name !== "continue_speaking").map(tool => ({ name: tool.name,
    description: tool.name === "manage_presentation" ? "管理讲解目标：完整讲解时 start，用户要求时 pause/resume，所有内容覆盖后 complete。应用负责在播放结束后续讲，不需要逐段申请继续。" : tool.description,
    parameters: schema(tool.parameters) as Record<string, unknown>, ...(["delegate_task", "ask_text"].includes(tool.name) ? { behavior: "NON_BLOCKING" as const } : {}) }));
  return { type: "gemini.session", model, voice, instructions: `${instructions}\nGemini 通话约定：后台任务通过 delegate_task 非阻塞执行，尚未返回前不要编造结果。任务完成时要说出最重要的实际结论；涉及核验数值时应说出该数值，不能只说已完成或已保存文件。notify=silent 时不主动播报。连续讲解由应用调度：一次回复只讲当前一页，讲完停下。第一次用 show_stage 显示起始页，以后不要在同一轮请求或讲下一页。应用会在音频实际播放完成后自动翻页并驱动下一轮。不要要求用户反复说继续，也不需要续讲工具。应用发出的阅读位置与后台结果是控制消息，不是新的用户发言。`, tools: declarations };
}

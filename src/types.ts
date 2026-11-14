export type Channel = "text" | "voice" | "system";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface TaskJob {
  id: string;
  botId: string;
  task: string;
  channel: Channel;
  notify: "silent" | "when_idle";
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  activity: string;
  result: string;
  error: string;
  attempts: number;
  sourceCallId?: string;
  artifacts: string[];
}

export interface Term {
  term: string;
  alias?: string;
}

export interface Bot {
  id: string;
  slug: string;
  name: string;
  systemPrompt: string;
  glossary: Term[];
  workspaceDir: string;
  parentBotId: string | null;
  avatarSeed: string;
  avatarInk: string;
  createdAt: string;
}

/** 一次模型决定调用的工具。input 是已经解析的参数。 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * 会话事件。事件一旦写入就不再修改。
 * 模型看到的 messages 只是这些事件的投影，不是记忆本身。
 */
export type SessionEvent =
  | { type: "user_text"; channel: Channel; text: string }
  | { type: "assistant_turn"; channel: Channel; text: string; toolCalls: ToolCall[] }
  | { type: "call"; callId?: string; startedAt: string; endedAt: string; lines: Array<{ who: "user" | "assistant"; text: string }> }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean }
  | { type: "baseline"; text: string; fromBotId?: string }
  | { type: "artifact"; path: string; bytes: number }
  | { type: "job"; job: TaskJob }
  | { type: "voice_line"; callId: string; who: "user" | "assistant"; text: string }
  | { type: "presentation"; state: import("./presentation.ts").PresentationState };

export interface StoredEvent {
  id: number;
  botId: string;
  createdAt: string;
  event: SessionEvent;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export interface CompletionResult {
  text: string;
  toolCalls: ModelToolCall[];
}

export interface LlmProvider {
  model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface Kickoff {
  botId: string;
  task: string;
}

export type Channel = "text" | "voice" | "system";

/** References only: image bytes live in the local library, never in event logs. */
export interface Attachment { refId: string; filename: string; mimeType: string; byteSize: number }
export interface ModelImage { mimeType: string; data: string }

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface TaskJob {
  sharedContext?: import("./shared-context.ts").WorkspaceContext;
  messageText?: string;
  attachments?: Attachment[];
  id: string;
  botId: string;
  task: string;
  channel: Channel;
  notify: "silent" | "when_idle";
  status: JobStatus;
  createdAt: string;
  queuedAt?: string;
  updatedAt: string;
  activity: string;
  result: string;
  error: string;
  attempts: number;
  sourceCallId?: string;
  display?: "conversation" | "background";
  title?: string;
  originEventId?: number;
  originCallId?: string;
  resultEventId?: number;
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
  | { type: "user_text"; channel: Channel; text: string; jobId?: string; attachments?: Attachment[] }
  | { type: "assistant_turn"; channel: Channel; text: string; toolCalls: ToolCall[]; jobId?: string }
  | { type: "call"; callId?: string; startedAt: string; endedAt: string; lines: Array<{ who: "user" | "assistant"; text: string }> }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean }
  | { type: "baseline"; text: string; fromBotId?: string }
  | { type: "artifact"; path: string; bytes: number }
  | { type: "job"; job: TaskJob }
  | { type: "voice_line"; callId: string; who: "user" | "assistant"; text: string; itemId?: string }
  | { type: "voice_tool_output"; callId: string; toolCallId: string }
  | { type: "presentation"; state: import("./presentation.ts").PresentationState }
  | { type: "workspace_context"; state: import("./shared-context.ts").WorkspaceContext };

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
  attachments?: Attachment[];
  images?: ModelImage[];
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

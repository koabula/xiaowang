import type { CompletionRequest, CompletionResult, LlmProvider, ModelMessage, ModelUsage, ToolSchema } from "./types.ts";
import { contextPolicy, type ContextPolicy } from "./token-budget.ts";
import { createHash } from "node:crypto";
import { readEventStream, requestSignal } from "./stream.ts";

export type ApiStyle = "openai" | "anthropic";

export interface ProviderConfig {
  contextPolicy?: ContextPolicy;
  promptCaching?: boolean;
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const model = env.XIAOWANG_MODEL?.trim() ?? "";
  const baseUrl = env.XIAOWANG_BASE_URL?.trim() ?? "";
  const requested = env.XIAOWANG_API_STYLE?.trim().toLowerCase();
  const apiStyle = inferStyle(requested, baseUrl, model);
  const apiKey = env.XIAOWANG_API_KEY?.trim() ?? "";
  const resolvedBase =
    baseUrl || (apiStyle === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  if (!model) {
    throw new Error(
      "请设置 XIAOWANG_MODEL。例如 deepseek-chat、qwen-plus、gpt-4.1、gemini-2.5-pro、claude-sonnet-4-5。",
    );
  }
  if (!apiKey && !isLocalBase(resolvedBase)) {
    throw new Error("请设置 XIAOWANG_API_KEY。密钥只留在环境变量里，不会写入会话或工作区。");
  }
  return {
    apiStyle,
    baseUrl: resolvedBase,
    apiKey: apiKey || "ollama",
    contextPolicy: contextPolicy(env),
    promptCaching: env.XIAOWANG_PROMPT_CACHE !== "off",
    model,
  };
}

export function createProvider(config: ProviderConfig): LlmProvider {
  return {
    model: config.model,
    contextKey: createHash("sha256").update(JSON.stringify([config.apiStyle, config.baseUrl, config.model])).digest("hex"),
    contextPolicy: config.contextPolicy,
    ...(config.apiStyle === "anthropic" && new URL(config.baseUrl).hostname === "api.anthropic.com" ? {
      async countTokens(request: CompletionRequest) {
        const response = await fetch(anthropicMessagesUrl(config.baseUrl) + "/count_tokens", {
          method: "POST", headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: config.model, system: request.system, messages: toAnthropicMessages(request.messages, request.preserveMessageBlocks), tools: toAnthropicTools(request.tools) }),
          signal: requestSignal(request.signal),
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(formatHttpError(response.status, raw, config.apiKey));
        const tokens = JSON.parse(raw).input_tokens;
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("模型服务返回了无效 token 计数。");
        return tokens as number;
      },
    } : {}),
    async complete(request) {
      try {
        return await (config.apiStyle === "anthropic"
          ? completeAnthropic(config, request)
          : completeOpenAI(config, request));
      } catch (error) {
        if (request.messages.some(message => message.images?.length) && error instanceof Error && /(?:image|vision|multimodal).*(?:support|invalid)|(?:support|invalid).*(?:image|vision|multimodal)/i.test(error.message)) {
          throw new Error(`当前文字模型不接受图片，请在设置中选择支持视觉输入的模型。图片未被忽略。${error.message}`, { cause: error });
        }
        throw error;
      }
    },
  };
}

export function openaiChatUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (base.endsWith("/messages")) return base;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function toOpenAIMessages(system: string, messages: ModelMessage[], preserveBlocks = false): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const message of preserveBlocks ? messages : mergeUserText(messages)) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      const text = message.content.trim();
      if (!text && calls.length === 0) continue;
      const body: Record<string, unknown> = {
        role: "assistant",
        content: text,
      };
      if (calls.length > 0) {
        body.tool_calls = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      out.push(body);
      continue;
    }
    out.push({ role: "user", content: message.images?.length ? [{ type: "text", text: message.content }, ...message.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))] : message.content });
  }
  return out;
}

export function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function toAnthropicMessages(messages: ModelMessage[], preserveBlocks = false): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const message of preserveBlocks ? messages : mergeUserText(messages)) {
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: false,
      };
      const prev = out.at(-1);
      if (prev?.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content.trim()) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseObject(call.arguments),
        });
      }
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: "user", content: message.images?.length ? [...message.images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })), { type: "text", text: message.content }] : message.content });
  }
  return out;
}

export function toAnthropicTools(tools: ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

async function completeOpenAI(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAIMessages(request.system, request.messages, request.preserveMessageBlocks),
    max_tokens: request.maxOutputTokens ?? (request.tools.length === 0 ? 32 : 4096),
    ...(request.onTextDelta ? { stream: true } : {}),
  };
  if (request.cacheKey && config.promptCaching !== false && new URL(config.baseUrl).hostname === "api.openai.com") body.prompt_cache_key = request.cacheKey;
  if (request.onTextDelta) body.stream_options = { include_usage: true };
  if (request.tools.length > 0) {
    body.tools = toOpenAITools(request.tools);
    body.tool_choice = "auto";
  }
  const response = await fetch(openaiChatUrl(config.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: requestSignal(request.signal),
  });
  if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
    let text = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finished = false;
    let usage: ModelUsage | undefined;
    for await (const event of readEventStream(response)) {
      if (event.data === "[DONE]") { finished = true; break; }
      const chunk = JSON.parse(event.data) as { usage?: Record<string, any>; error?: { message?: string }; choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
      usage = mergeUsage(usage, openAIUsage(chunk.usage));
      if (chunk.error) throw new Error(formatHttpError(502, chunk.error.message || "模型流中断", config.apiKey));
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finished = true;
      const delta = choice?.delta;
      if (delta?.content) { text += delta.content; request.onTextDelta?.(delta.content); }
      for (const call of delta?.tool_calls ?? []) {
        const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
        current.id ||= call.id || "";
        current.name += call.function?.name || "";
        current.arguments += call.function?.arguments || "";
        calls.set(call.index, current);
      }
    }
    if (!finished) throw new Error("模型响应提前断开，请重试。未完成的工具不会执行。");
    return { text, ...(usage ? { usage } : {}), toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({ ...call, id: call.id || `call_${index}` })) };
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(formatHttpError(response.status, raw, config.apiKey));
  const json = JSON.parse(raw) as {
    usage?: Record<string, any>;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
    }>;
  };
  const message = json.choices?.[0]?.message;
  return {
    ...(openAIUsage(json.usage) ? { usage: openAIUsage(json.usage) } : {}),
    text: typeof message?.content === "string" ? message.content : "",
    toolCalls: (message?.tool_calls ?? []).map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name || "",
      arguments: argumentString(call.function?.arguments),
    })),
  };
}

async function completeAnthropic(config: ProviderConfig, request: CompletionRequest): Promise<CompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    system: request.system,
    messages: toAnthropicMessages(request.messages, request.preserveMessageBlocks),
    max_tokens: request.maxOutputTokens ?? (request.tools.length === 0 ? 32 : 4096),
    ...(request.onTextDelta ? { stream: true } : {}),
  };
  if (request.tools.length > 0) body.tools = toAnthropicTools(request.tools);
  if (request.preserveMessageBlocks && config.promptCaching !== false) body.cache_control = { type: "ephemeral" };
  const response = await fetch(anthropicMessagesUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: requestSignal(request.signal),
  });
  if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
    let text = "";
    let finished = false;
    let usage: ModelUsage | undefined;
    const rawUsage: Record<string, any> = {};
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const event of readEventStream(response)) {
      const chunk = JSON.parse(event.data) as { usage?: Record<string, any>; message?: { usage?: Record<string, any> }; type: string; index: number; error?: { message?: string }; content_block?: { type?: string; id?: string; name?: string; text?: string; input?: unknown }; delta?: { type?: string; text?: string; partial_json?: string } };
      Object.assign(rawUsage, chunk.message?.usage ?? chunk.usage ?? {});
      usage = anthropicUsage(rawUsage);
      if (chunk.type === "error") throw new Error(formatHttpError(502, chunk.error?.message || "模型流中断", config.apiKey));
      if (chunk.type === "message_stop") finished = true;
      if (chunk.type === "content_block_start") {
        const block = chunk.content_block;
        if (block?.type === "tool_use") calls.set(chunk.index, { id: block.id || `tool_${chunk.index}`, name: block.name || "", arguments: block.input && Object.keys(block.input as object).length ? JSON.stringify(block.input) : "" });
        if (block?.type === "text" && block.text) { text += block.text; request.onTextDelta?.(block.text); }
      }
      if (chunk.delta?.type === "text_delta" && chunk.delta.text) { text += chunk.delta.text; request.onTextDelta?.(chunk.delta.text); }
      if (chunk.delta?.type === "input_json_delta") {
        const call = calls.get(chunk.index);
        if (call) call.arguments += chunk.delta.partial_json || "";
      }
    }
    if (!finished) throw new Error("模型响应提前断开，请重试。未完成的工具不会执行。");
    return { text, ...(usage ? { usage } : {}), toolCalls: [...calls.values()].map(call => ({ ...call, arguments: call.arguments || "{}" })) };
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(formatHttpError(response.status, raw, config.apiKey));
  const json = JSON.parse(raw) as {
    usage?: Record<string, any>;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  };
  let text = "";
  const toolCalls: CompletionResult["toolCalls"] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `tool_${toolCalls.length}`,
        name: block.name || "",
        arguments: argumentString(block.input),
      });
    }
  }
  return { text, toolCalls, ...(anthropicUsage(json.usage) ? { usage: anthropicUsage(json.usage) } : {}) };
}

function numberToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function mergeUsage(previous: ModelUsage | undefined, incoming: ModelUsage | undefined): ModelUsage | undefined {
  if (!incoming) return previous;
  return { ...previous, ...incoming };
}
function openAIUsage(raw?: Record<string, any>): ModelUsage | undefined {
  if (!raw) return undefined;
  const result = {
    inputTokens: numberToken(raw.prompt_tokens), outputTokens: numberToken(raw.completion_tokens),
    cacheReadTokens: numberToken(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens),
    cacheWriteTokens: numberToken(raw.prompt_cache_write_tokens),
  };
  const known = Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  return Object.keys(known).length ? known : undefined;
}
function anthropicUsage(raw?: Record<string, any>): ModelUsage | undefined {
  if (!raw) return undefined;
  const input = numberToken(raw.input_tokens);
  const read = numberToken(raw.cache_read_input_tokens), write = numberToken(raw.cache_creation_input_tokens);
  const result = {
    ...(input !== undefined ? { inputTokens: input + (read ?? 0) + (write ?? 0) } : {}),
    ...(numberToken(raw.output_tokens) !== undefined ? { outputTokens: raw.output_tokens as number } : {}),
    ...(read !== undefined ? { cacheReadTokens: read } : {}), ...(write !== undefined ? { cacheWriteTokens: write } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function mergeUserText(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const message of messages) {
    const prev = merged.at(-1);
    if (message.role === "user" && prev?.role === "user" && !prev.toolCallId) {
      prev.content = `${prev.content}\n\n${message.content}`;
      if (message.images?.length) prev.images = [...(prev.images ?? []), ...message.images];
      continue;
    }
    merged.push({ ...message, toolCalls: message.toolCalls ? [...message.toolCalls] : undefined });
  }
  return merged;
}

function parseObject(raw: string): unknown {
  try {
    return raw.trim() ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return { _raw: raw };
  }
}

function argumentString(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function formatHttpError(status: number, body: string, apiKey: string): string {
  let snippet = body.replace(/\s+/g, " ").slice(0, 500);
  if (apiKey) snippet = snippet.replaceAll(apiKey, "[redacted]");
  if (snippet.includes("content or tool_calls must be set")) {
    return "模型服务拒绝了一条空的助手记录。再发一次就可以。";
  }
  if (status === 401 || status === 403) {
    return `模型服务拒绝了密钥（HTTP ${status}）。请检查 XIAOWANG_API_KEY。响应：${snippet}`;
  }
  return `模型服务返回 HTTP ${status}。响应：${snippet}`;
}

function inferStyle(requested: string | undefined, baseUrl: string, model: string): ApiStyle {
  if (requested === "openai" || requested === "anthropic") return requested;
  if (requested) {
    throw new Error("XIAOWANG_API_STYLE 只能是 openai 或 anthropic。");
  }
  if (baseUrl.includes("anthropic.com") || model.startsWith("claude")) return "anthropic";
  return "openai";
}

function isLocalBase(baseUrl: string): boolean {
  return /:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(baseUrl);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function listModels(input: { baseUrl: string; apiKey: string; apiStyle?: string }): Promise<string[]> {
  const style = inferStyle(input.apiStyle?.trim() || undefined, input.baseUrl, "");
  const base = trimSlash(input.baseUrl || (style === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"));
  const url = style === "anthropic" ? (base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`) : `${base}/models`;
  const headers: Record<string, string> =
    style === "anthropic"
      ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${input.apiKey}` };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(formatHttpError(response.status, raw, input.apiKey));
  const json = JSON.parse(raw) as { data?: Array<{ id?: string }> };
  return [...new Set((json.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)))];
}

export async function checkModel(config: ProviderConfig): Promise<string> {
  const result = await createProvider(config).complete({
    system: "连通性检查。",
    messages: [{ role: "user", content: "只回复一个字：好" }],
    tools: [],
  });
  return result.text.trim() || "已接通";
}

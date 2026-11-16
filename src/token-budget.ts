import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import type { CompletionRequest, ModelMessage } from "./types.ts";

export interface ContextPolicy {
  windowTokens: number;
  outputTokens: number;
  safetyTokens: number;
  imageTokens: number;
  highWater: number;
  lowWater: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  windowTokens: 32_768, outputTokens: 4_096, safetyTokens: 2_048,
  imageTokens: 8_192, highWater: 0.85, lowWater: 0.55,
};

export interface TokenBudget {
  system: number;
  tools: number;
  messages: number;
  images: number;
  input: number;
  output: number;
  safety: number;
  window: number;
  total: number;
  method: "local-estimate" | "provider-count";
}

let tokenizer: Tiktoken | undefined;
const tokenChunks = new Map<string, number>();
export function textTokens(text: string): number {
  tokenizer ??= new Tiktoken(ranks);
  let count = 0;
  for (let offset = 0; offset < text.length;) {
    // Bound BPE work on long unbroken strings, and reuse unchanged transcript chunks.
    let end = Math.min(offset + 128, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
    const chunk = text.slice(offset, end);
    let tokens = tokenChunks.get(chunk);
    if (tokens === undefined) {
      tokens = tokenizer.encode(chunk, [], []).length + 1;
      if (tokenChunks.size >= 2048) tokenChunks.delete(tokenChunks.keys().next().value!);
      tokenChunks.set(chunk, tokens);
    }
    count += tokens;
    offset = end;
  }
  return count;
}

export function contextPolicy(env: NodeJS.ProcessEnv = process.env): ContextPolicy {
  const policy = { ...DEFAULT_CONTEXT_POLICY };
  for (const [field, variable] of [
    ["windowTokens", "XIAOWANG_CONTEXT_WINDOW"], ["outputTokens", "XIAOWANG_MAX_OUTPUT_TOKENS"],
    ["safetyTokens", "XIAOWANG_CONTEXT_SAFETY_TOKENS"], ["imageTokens", "XIAOWANG_IMAGE_TOKEN_BUDGET"],
  ] as const) {
    if (env[variable] === undefined) continue;
    const value = Number(env[variable]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${variable} 必须是正整数。`);
    policy[field] = value;
  }
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy: ContextPolicy): void {
  if (Object.values(policy).some(value => !Number.isFinite(value) || value <= 0)
    || policy.lowWater >= policy.highWater || policy.highWater >= 1
    || policy.outputTokens + policy.safetyTokens >= policy.windowTokens) {
    throw new Error("上下文预算配置无效，请为输入、输出和安全余量留出空间。");
  }
}

export function inputCapacity(policy: ContextPolicy): number {
  return policy.windowTokens - policy.outputTokens - policy.safetyTokens;
}

/** Full request accounting. Text uses local BPE with a margin; vision uses an explicit reserve. */
export function measureRequest(request: CompletionRequest, policy: ContextPolicy): TokenBudget {
  const count = (value: unknown) => Math.ceil(textTokens(JSON.stringify(value)) * 1.2);
  const images = request.messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0) * policy.imageTokens;
  const messages = request.messages.map(({ images: _images, attachments: _attachments, ...message }) => message);
  const system = count(request.system) + 16;
  const tools = count(request.tools) + (request.tools.length ? 32 : 0);
  const messageTokens = count(messages) + messages.length * 16 + 16;
  const output = request.maxOutputTokens ?? policy.outputTokens;
  const input = system + tools + messageTokens + images;
  return { system, tools, messages: messageTokens, images, input, output, safety: policy.safetyTokens,
    window: policy.windowTokens, total: input + output + policy.safetyTokens, method: "local-estimate" };
}

export function withoutImageBytes(message: ModelMessage): ModelMessage {
  const { images: _images, ...rest } = message;
  return structuredClone(rest);
}

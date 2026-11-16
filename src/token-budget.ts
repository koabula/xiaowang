import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import type { CompletionRequest, ModelMessage } from "./types.ts";

export interface ContextPolicy {
  highWaterTokens?: number;
  lowWaterTokens?: number;
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
  const profile = env.XIAOWANG_CONTEXT_PROFILE || "conservative";
  if (profile !== "conservative" && profile !== "research") throw new Error("XIAOWANG_CONTEXT_PROFILE 只能是 conservative 或 research。");
  const policy: ContextPolicy = profile === "research"
    ? { ...DEFAULT_CONTEXT_POLICY, windowTokens: 131_072, outputTokens: 8_192, safetyTokens: 4_096 }
    : { ...DEFAULT_CONTEXT_POLICY };
  for (const [field, variable] of [
    ["windowTokens", "XIAOWANG_CONTEXT_WINDOW"], ["outputTokens", "XIAOWANG_MAX_OUTPUT_TOKENS"],
    ["safetyTokens", "XIAOWANG_CONTEXT_SAFETY_TOKENS"], ["imageTokens", "XIAOWANG_IMAGE_TOKEN_BUDGET"],
    ["highWaterTokens", "XIAOWANG_CONTEXT_HIGH_WATER_TOKENS"], ["lowWaterTokens", "XIAOWANG_CONTEXT_LOW_WATER_TOKENS"],
  ] as const) {
    if (!env[variable]?.trim()) continue;
    const value = Number(env[variable]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${variable} 必须是正整数。`);
    policy[field] = value;
  }
  if (env.XIAOWANG_MODEL_CONTEXT_WINDOW?.trim()) {
    const cap = Number(env.XIAOWANG_MODEL_CONTEXT_WINDOW);
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("XIAOWANG_MODEL_CONTEXT_WINDOW 必须是正整数。");
    policy.windowTokens = Math.min(policy.windowTokens, cap);
  }
  if (profile === "research") {
    const capacity = inputCapacity(policy);
    policy.highWaterTokens ??= capacity >= 98_304 ? 98_304 : Math.floor(capacity * policy.highWater);
    policy.lowWaterTokens ??= 32_768 < policy.highWaterTokens ? 32_768 : Math.floor(policy.highWaterTokens * policy.lowWater);
  }
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy: ContextPolicy): void {
  if (Object.values(policy).some(value => !Number.isFinite(value) || value <= 0)
    || policy.lowWater >= policy.highWater || policy.highWater >= 1
    || policy.outputTokens + policy.safetyTokens >= policy.windowTokens
    || watermarks(policy).low >= watermarks(policy).high || watermarks(policy).high > inputCapacity(policy)) {
    throw new Error("上下文预算配置无效，请为输入、输出和安全余量留出空间。");
  }
}

/** Absolute watermarks are independent of output reserves; ratios support old/custom policies. */
export function watermarks(policy: ContextPolicy): { high: number; low: number } {
  return { high: policy.highWaterTokens ?? inputCapacity(policy) * policy.highWater,
    low: policy.lowWaterTokens ?? inputCapacity(policy) * policy.lowWater };
}

export function inputCapacity(policy: ContextPolicy): number {
  return policy.windowTokens - policy.outputTokens - policy.safetyTokens;
}

/** Full request accounting. Text uses local BPE with a margin; vision uses an explicit reserve. */
export function measureRequest(request: CompletionRequest, policy: ContextPolicy): TokenBudget {
  const count = (value: unknown) => Math.ceil(textTokens(JSON.stringify(value)) * 1.2);
  const images = request.messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0) * policy.imageTokens;
  const messages = request.messages.map(({ images: _images, attachments: _attachments, protocol, stopReason: _stop, ...message }) => {
    if (protocol?.format === "anthropic" && protocol.contentBlocks?.length) return { role: "assistant", content: protocol.contentBlocks };
    return { ...message, ...(protocol && Object.hasOwn(protocol, "reasoningContent") ? { reasoning_content: protocol.reasoningContent } : {}),
      ...(protocol?.reasoningDetails ? { reasoning_details: protocol.reasoningDetails } : {}) };
  });
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

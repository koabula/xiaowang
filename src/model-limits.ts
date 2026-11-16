import { createHash } from "node:crypto";
import type { ModelLimits } from "./token-budget.ts";

interface Endpoint { baseUrl: string; model: string; apiKey: string; apiStyle: string }
const cache = new Map<string, { until: number; pending: Promise<ModelLimits> }>();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function positive(...values: unknown[]): number | undefined {
  return values.find(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0) as number | undefined;
}
export function limitsFromMetadata(value: unknown): ModelLimits | undefined {
  const item = object(value), provider = object(item.top_provider), limits = object(item.limits);
  const context = positive(item.context_length, item.context_window, item.max_model_len, provider.context_length, limits.context_window);
  const input = positive(item.inputTokenLimit, item.max_input_tokens, limits.max_input_tokens);
  const output = positive(item.outputTokenLimit, item.max_output_tokens, provider.max_completion_tokens, limits.max_output_tokens);
  return context || input ? { context, input, output } : undefined;
}
/** Exact official model families only; custom deployments rely on their own metadata. */
function officialLimits(endpoint: Endpoint): ModelLimits | undefined {
  const host = new URL(endpoint.baseUrl).hostname;
  if (host === "api.openai.com") {
    if (/^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(endpoint.model)) return { context: 1_047_576, output: 32_768 };
    if (/^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/.test(endpoint.model)) return { context: 128_000, output: endpoint.model === "gpt-4o-2024-05-13" ? 4096 : 16384 };
  }
  if (host === "api.deepseek.com" && ["deepseek-flash", "deepseek-v4-pro"].includes(endpoint.model)) return { context: 1_048_576, output: 393_216 };
  if (host === "api.anthropic.com" && ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].includes(endpoint.model)) return { context: 1_000_000, output: 128_000 };
  return undefined;
}
export async function resolveModelLimits(endpoint: Endpoint, signal?: AbortSignal): Promise<ModelLimits> {
  signal?.throwIfAborted();
  const key = createHash("sha256").update(JSON.stringify(endpoint)).digest("hex");
  let entry = cache.get(key);
  if (!entry || entry.until < Date.now()) {
    const pending = discover(endpoint);
    entry = { until: Date.now() + 5 * 60_000, pending };
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
  }
  const result = await entry.pending;
  signal?.throwIfAborted();
  return result;
}
async function discover(endpoint: Endpoint): Promise<ModelLimits> {
  const base = endpoint.baseUrl.replace(/\/(?:chat\/completions|messages)\/?$/, "").replace(/\/$/, "");
  const headers: Record<string, string> = endpoint.apiStyle === "anthropic"
    ? { "x-api-key": endpoint.apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${endpoint.apiKey}` };
  if (new URL(base).port === "11434") {
    try {
      const response = await fetch(new URL("/api/ps", base), { headers, signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const rows = object(await response.json()).models;
        const model = Array.isArray(rows) ? rows.find(row => [object(row).name, object(row).model].includes(endpoint.model)) : undefined;
        const limits = limitsFromMetadata(model);
        if (limits) return limits;
      }
    } catch { /* An unloaded or non-Ollama model can still expose /models metadata. */ }
  }
  try {
    const url = endpoint.apiStyle === "anthropic" && !base.endsWith("/v1") ? `${base}/v1/models` : `${base}/models`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const body = object(await response.json());
      const rows = Array.isArray(body.data) ? body.data : [];
      const model = rows.find(row => object(row).id === endpoint.model);
      const limits = limitsFromMetadata(model);
      if (limits) return limits;
    }
  } catch { /* Metadata is optional on compatible endpoints. */ }
  return officialLimits(endpoint) ?? { context: 32_768 };
}

import { requestSignal } from "./stream.ts";

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchConfig {
  provider: "brave" | "searxng" | "none";
  url: string;
  apiKey: string;
}

export function searchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  const provider = env.XIAOWANG_SEARCH_PROVIDER?.trim().toLowerCase() ?? "";
  const url = env.XIAOWANG_SEARCH_URL?.trim().replace(/\/+$/, "") ?? "";
  const apiKey = env.XIAOWANG_SEARCH_KEY?.trim() ?? "";
  if (provider === "none") return { provider: "none", url: "", apiKey: "" };
  if (provider === "searxng" || (url && !url.includes("api.search.brave.com") && provider !== "brave")) {
    return { provider: url ? "searxng" : "none", url, apiKey };
  }
  if (provider === "brave" || apiKey || url.includes("api.search.brave.com")) {
    return {
      provider: "brave",
      url: url || "https://api.search.brave.com/res/v1/web/search",
      apiKey,
    };
  }
  return { provider: "none", url: "", apiKey: "" };
}

export function missingSearchConfigMessage(): string {
  return "快捷网络搜索还没有配置。请设置 XIAOWANG_SEARCH_KEY（Brave）或 XIAOWANG_SEARCH_URL（SearxNG）。文献检索不需要这个密钥。不要编造链接。";
}

export async function webSearch(
  query: string,
  config: SearchConfig,
  options?: { maxResults?: number; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string> {
  if (config.provider === "none" || (config.provider === "brave" && !config.apiKey) || (config.provider === "searxng" && !config.url)) {
    return missingSearchConfigMessage();
  }
  const max = Math.min(8, Math.max(1, options?.maxResults ?? 5));
  const baseFetch = options?.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (url, init) => baseFetch(url, { ...init, signal: requestSignal(options?.signal, 20_000) });
  try {
    const hits =
      config.provider === "brave"
        ? await searchBrave(query, max, config, fetchImpl)
        : await searchSearxng(query, max, config, fetchImpl);
    return formatWebHits(query, hits);
  } catch (error) {
    options?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return `网络搜索失败：${redact(message, config.apiKey)}。可以换关键词或稍后重试。不要编造链接。`;
  }
}

export function parseBraveResults(payload: unknown): WebHit[] {
  const results = asRecord(asRecord(payload)?.web)?.results;
  if (!Array.isArray(results)) return [];
  return results.map(readHit);
}

export function parseSearxResults(payload: unknown): WebHit[] {
  const results = asRecord(payload)?.results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const hit = readHit(item);
    const record = asRecord(item);
    if (!hit.snippet && typeof record?.content === "string") hit.snippet = record.content;
    return hit;
  });
}

export function formatWebHits(query: string, hits: WebHit[]): string {
  if (hits.length === 0) {
    return `没有检索到与「${query}」匹配的网页。可以换关键词。不要编造链接。`;
  }
  const lines = [`网络搜索「${query}」，得到 ${hits.length} 条。页面内容只是线索。`, ""];
  hits.forEach((hit, index) => {
    const snippet = hit.snippet.length > 280 ? `${hit.snippet.slice(0, 280)}…` : hit.snippet;
    lines.push(`${index + 1}. ${hit.title || "（无标题）"}`, `   ${hit.url}`, snippet ? `   ${snippet}` : "", "");
  });
  return lines.join("\n").trimEnd();
}

async function searchBrave(query: string, max: number, config: SearchConfig, fetchImpl: typeof fetch): Promise<WebHit[]> {
  const params = new URLSearchParams({ q: query, count: String(max) });
  const payload = await getJson(`${config.url}?${params}`, fetchImpl, {
    accept: "application/json",
    "x-subscription-token": config.apiKey,
  }, config.apiKey);
  return parseBraveResults(payload).slice(0, max);
}

async function searchSearxng(query: string, max: number, config: SearchConfig, fetchImpl: typeof fetch): Promise<WebHit[]> {
  const params = new URLSearchParams({ q: query, format: "json", categories: "general" });
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const payload = await getJson(`${config.url}/search?${params}`, fetchImpl, headers, config.apiKey);
  return parseSearxResults(payload).slice(0, max);
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  apiKey: string,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${redact(text.replace(/\s+/g, " ").slice(0, 180), apiKey)}`);
  }
  return JSON.parse(text) as unknown;
}

function readHit(value: unknown): WebHit {
  const record = asRecord(value);
  return {
    title: typeof record?.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "",
    url: typeof record?.url === "string" ? record.url.trim() : "",
    snippet: typeof record?.description === "string" ? record.description.replace(/\s+/g, " ").trim() : "",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.replaceAll(apiKey, "[redacted]") : text;
}

import { searchArxiv } from "./arxiv.ts";
import { requestSignal } from "./stream.ts";

export type LiteratureSource = "openalex" | "arxiv" | "crossref" | "pubmed";

export interface LiteratureHit {
  title: string;
  authors: string[];
  year: string;
  venue: string;
  url: string;
  summary: string;
}

const SOURCES = new Set<LiteratureSource>(["openalex", "arxiv", "crossref", "pubmed"]);

export function parseLiteratureSource(value: string | undefined): LiteratureSource | { error: string } {
  const source = (value?.trim().toLowerCase() || "openalex") as LiteratureSource;
  if (!SOURCES.has(source)) {
    return { error: "source 只能是 openalex、arxiv、crossref、pubmed 之一。省略时用 openalex。" };
  }
  return source;
}

export async function searchLiterature(
  query: string,
  source: LiteratureSource,
  options?: { maxResults?: number; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string> {
  const max = Math.min(8, Math.max(1, options?.maxResults ?? 5));
  const baseFetch = options?.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (url, init) => baseFetch(url, { ...init, signal: requestSignal(options?.signal, 20_000) });
  if (source === "arxiv") {
    return searchArxiv(query, { maxResults: max, fetchImpl });
  }
  try {
    if (source === "openalex") return formatLiteratureHits(source, query, await searchOpenAlex(query, max, fetchImpl));
    if (source === "crossref") return formatLiteratureHits(source, query, await searchCrossref(query, max, fetchImpl));
    return formatLiteratureHits(source, query, await searchPubmed(query, max, fetchImpl));
  } catch (error) {
    options?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return `${source} 检索失败：${message}。可以换关键词、改用来源，或稍后重试。不要编造没有检索到的论文。`;
  }
}

export function formatLiteratureHits(source: string, query: string, hits: LiteratureHit[]): string {
  if (hits.length === 0) {
    return `在 ${source} 没有检索到与「${query}」匹配的作品。可以换关键词，或改用 source=openalex、arxiv、crossref、pubmed。不要编造没有检索到的论文。`;
  }
  const lines = [
    `在 ${source} 检索「${query}」，得到 ${hits.length} 条。摘要只是线索，没有写到的数字不要补。`,
    "",
  ];
  hits.forEach((hit, index) => {
    const authors = hit.authors.length > 3 ? `${hit.authors.slice(0, 3).join(", ")} 等` : hit.authors.join(", ") || "（无作者）";
    const summary = hit.summary.length > 500 ? `${hit.summary.slice(0, 500)}…` : hit.summary;
    lines.push(
      `${index + 1}. ${hit.title}`,
      `   作者：${authors}`,
      `   时间：${hit.year || "未知"}`,
      `   出处：${hit.venue || "未知"}`,
      `   链接：${hit.url || "无"}`,
      summary ? `   摘要：${summary}` : "   摘要：这个来源没有给摘要。",
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

export function reconstructOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter((word) => word !== undefined).join(" ");
}

export function parseOpenAlexWorks(payload: unknown): LiteratureHit[] {
  const results = asRecord(payload)?.results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const work = asRecord(item) ?? {};
    const authorships = Array.isArray(work.authorships) ? work.authorships : [];
    const authors = authorships.map((entry) => {
      const author = asRecord(asRecord(entry)?.author);
      return typeof author?.display_name === "string" ? author.display_name : "";
    });
    const location = asRecord(asRecord(work.primary_location)?.source);
    const openAccess = asRecord(work.open_access);
    const doi = typeof work.doi === "string" ? work.doi : "";
    const oaUrl = typeof openAccess?.oa_url === "string" ? openAccess.oa_url : "";
    return {
      title: stringOf(work.display_name) || "（无题名）",
      authors: authors.filter(Boolean),
      year: work.publication_year ? String(work.publication_year) : "",
      venue: stringOf(location?.display_name),
      url: oaUrl || doi,
      summary: reconstructOpenAlexAbstract(asInvertedIndex(work.abstract_inverted_index)),
    };
  });
}

export function parseCrossrefWorks(payload: unknown): LiteratureHit[] {
  const items = asRecord(asRecord(payload)?.message)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const work = asRecord(item) ?? {};
    const title = Array.isArray(work.title) ? stringOf(work.title[0]) : "";
    const authors = Array.isArray(work.author)
      ? work.author.map((person) => {
          const record = asRecord(person);
          const name = [stringOf(record?.given), stringOf(record?.family)].filter(Boolean).join(" ");
          return name || stringOf(record?.name);
        })
      : [];
    const issued = asRecord(work.issued);
    const dateParts = Array.isArray(issued?.["date-parts"]) ? issued["date-parts"][0] : undefined;
    const year = Array.isArray(dateParts) && dateParts[0] ? String(dateParts[0]) : "";
    const venue = Array.isArray(work["container-title"]) ? stringOf(work["container-title"][0]) : "";
    const doi = stringOf(work.DOI);
    return {
      title: title || "（无题名）",
      authors: authors.filter(Boolean),
      year,
      venue,
      url: doi ? `https://doi.org/${doi}` : stringOf(work.URL),
      summary: stripTags(stringOf(work.abstract)),
    };
  });
}

export function parsePubmedSummary(payload: unknown): LiteratureHit[] {
  const result = asRecord(asRecord(payload)?.result);
  const uids = result?.uids;
  if (!Array.isArray(uids)) return [];
  return uids.map((uid) => {
    const paper = asRecord(result?.[String(uid)]) ?? {};
    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((person) => stringOf(asRecord(person)?.name))
      : [];
    const doi = stringOf(paper.elocationid).replace(/^doi:\s*/i, "");
    return {
      title: stringOf(paper.title) || "（无题名）",
      authors: authors.filter(Boolean),
      year: stringOf(paper.pubdate).slice(0, 4),
      venue: stringOf(paper.source),
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${String(uid)}/`,
      summary: "",
    };
  });
}

async function searchOpenAlex(query: string, max: number, fetchImpl: typeof fetch): Promise<LiteratureHit[]> {
  const params = new URLSearchParams({
    search: query,
    "per-page": String(max),
    mailto: "xiaowang@localhost",
  });
  const payload = await getJson(`https://api.openalex.org/works?${params}`, fetchImpl);
  return parseOpenAlexWorks(payload);
}

async function searchCrossref(query: string, max: number, fetchImpl: typeof fetch): Promise<LiteratureHit[]> {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: String(max),
  });
  const payload = await getJson(`https://api.crossref.org/works?${params}`, fetchImpl, {
    "user-agent": "XiaoWang/0.1 (mailto:xiaowang@localhost)",
  });
  return parseCrossrefWorks(payload);
}

async function searchPubmed(query: string, max: number, fetchImpl: typeof fetch): Promise<LiteratureHit[]> {
  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(max),
    retmode: "json",
    tool: "xiaowang",
    email: "xiaowang@localhost",
  });
  const found = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams}`,
    fetchImpl,
  );
  const ids = asRecord(asRecord(found)?.esearchresult)?.idlist;
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const summaryParams = new URLSearchParams({
    db: "pubmed",
    id: ids.map((id) => String(id)).join(","),
    retmode: "json",
    tool: "xiaowang",
    email: "xiaowang@localhost",
  });
  const summary = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams}`,
    fetchImpl,
  );
  return parsePubmedSummary(summary);
}

async function getJson(url: string, fetchImpl: typeof fetch, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asInvertedIndex(value: unknown): Record<string, number[]> | null {
  const record = asRecord(value);
  if (!record) return null;
  const index: Record<string, number[]> = {};
  for (const [word, positions] of Object.entries(record)) {
    if (Array.isArray(positions)) index[word] = positions.filter((item): item is number => typeof item === "number");
  }
  return index;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

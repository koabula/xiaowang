import { requestSignal } from "./stream.ts";

export interface ArxivPaper {
  title: string;
  authors: string[];
  published: string;
  url: string;
  categories: string[];
  summary: string;
}

export function normalizeArxivQuery(query: string): string {
  const q = query.trim();
  if (/^(all|ti|au|abs|cat|id):/i.test(q)) return q;
  return `all:"${q.replace(/"/g, "")}"`;
}

export function parseArxivAtom(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1] ?? "";
    const title = collapse(decodeXml(textOf(block, "title")));
    const summary = collapse(decodeXml(textOf(block, "summary")));
    const published = textOf(block, "published").slice(0, 10);
    const id = textOf(block, "id").trim();
    if (!title || !id) continue;
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((item) =>
      collapse(decodeXml(item[1] ?? "")),
    );
    const categories = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((item) => item[1] ?? "");
    papers.push({
      title,
      authors: authors.filter(Boolean),
      published,
      url: id.replace(/^http:\/\//, "https://"),
      categories: categories.filter(Boolean),
      summary,
    });
  }
  return papers;
}

export function formatArxivPapers(query: string, papers: ArxivPaper[]): string {
  if (papers.length === 0) {
    return `没有检索到与「${query}」匹配的 arXiv 论文。可以换一组英文关键词，或改用 ti:、au: 这样的字段。不要编造没有检索到的论文。`;
  }
  const lines = [`检索「${query}」，得到 ${papers.length} 篇 arXiv 论文。摘要只是线索，没有写到的数字不要补。`, ""];
  papers.forEach((paper, index) => {
    const authors =
      paper.authors.length > 3
        ? `${paper.authors.slice(0, 3).join(", ")} 等`
        : paper.authors.join(", ") || "（无作者）";
    const summary = paper.summary.length > 700 ? `${paper.summary.slice(0, 700)}…` : paper.summary;
    lines.push(
      `${index + 1}. ${paper.title}`,
      `   作者：${authors}`,
      `   时间：${paper.published || "未知"}`,
      `   链接：${paper.url}`,
      `   分类：${paper.categories.join(", ") || "无"}`,
      `   摘要：${summary}`,
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

export async function searchArxiv(
  query: string,
  options?: { maxResults?: number; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string> {
  const max = Math.min(8, Math.max(1, options?.maxResults ?? 5));
  const searchQuery = normalizeArxivQuery(query);
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(max),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://export.arxiv.org/api/query?${params}`, {
    headers: { "user-agent": "XiaoWang/0.1 (research assistant; mailto:local)" },
    signal: requestSignal(options?.signal, 20_000),
  });
  const xml = await response.text();
  if (!response.ok) {
    return `arXiv 请求失败（HTTP ${response.status}）。可以稍后重试。响应开头：${xml.slice(0, 180)}`;
  }
  if (!xml.includes("<feed")) {
    return `arXiv 没有返回论文列表。响应开头：${xml.slice(0, 180)}`;
  }
  return formatArxivPapers(query, parseArxivAtom(xml));
}

function textOf(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1] ?? "";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

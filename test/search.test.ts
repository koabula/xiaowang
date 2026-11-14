import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatLiteratureHits,
  parseCrossrefWorks,
  parseLiteratureSource,
  parseOpenAlexWorks,
  parsePubmedSummary,
  reconstructOpenAlexAbstract,
  searchLiterature,
} from "../src/literature.ts";
import { toolSchemas } from "../src/tools.ts";

test("literature parsers keep titles from openalex, crossref and pubmed", () => {
  assert.equal(reconstructOpenAlexAbstract({ Hello: [0], world: [1] }), "Hello world");
  const openalex = parseOpenAlexWorks({
    results: [
      {
        display_name: "Hybrid Spark",
        publication_year: 2026,
        doi: "https://doi.org/10.0000/spark",
        authorships: [{ author: { display_name: "Ada" } }],
        primary_location: { source: { display_name: "arXiv" } },
        abstract_inverted_index: { Spark: [1], A: [0] },
      },
    ],
  });
  assert.equal(openalex[0]?.title, "Hybrid Spark");
  assert.equal(openalex[0]?.year, "2026");
  assert.equal(openalex[0]?.summary, "A Spark");
  assert.match(formatLiteratureHits("openalex", "spark", openalex), /Hybrid Spark/);

  const crossref = parseCrossrefWorks({
    message: {
      items: [
        {
          title: ["Attention Is All You Need"],
          author: [{ given: "Ashish", family: "Vaswani" }],
          issued: { "date-parts": [[2017]] },
          DOI: "10.0000/attention",
          abstract: "<jats:p>We propose &amp; test.</jats:p>",
        },
      ],
    },
  });
  assert.equal(crossref[0]?.year, "2017");
  assert.equal(crossref[0]?.authors[0], "Ashish Vaswani");
  assert.equal(crossref[0]?.summary, "We propose & test.");

  const pubmed = parsePubmedSummary({
    result: {
      uids: ["123"],
      "123": { title: "A trial", authors: [{ name: "Lin" }], pubdate: "2024 Jan", source: "Nature", elocationid: "doi: 10.1/x" },
    },
  });
  assert.equal(pubmed[0]?.title, "A trial");
  assert.equal(pubmed[0]?.url, "https://doi.org/10.1/x");
  assert.equal(formatLiteratureHits("pubmed", "nothing", []).includes("不要编造"), true);
  assert.deepEqual(parseLiteratureSource("PubMed"), "pubmed");
  assert.equal("error" in (parseLiteratureSource("cnki") as { error: string }), true);
});

test("search_literature uses one source and reports an empty result", async () => {
  const calls: string[] = [];
  const output = await searchLiterature("speculative decoding", "openalex", {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /api\.openalex\.org/);
  assert.match(output, /没有检索到/);
  assert.match(output, /不要编造/);
});

test("browser and academic tools remain available without a dedicated web search provider", () => {
  const names = toolSchemas().map(item => item.name);
  assert.ok(names.includes("search_literature"));
  assert.ok(names.includes("browser_navigate"));
  assert.equal(names.includes("search_web"), false);
  assert.equal(names.includes("web_search"), false);
});

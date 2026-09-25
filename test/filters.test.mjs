import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

test("languages are normalized across sources", () => {
  const { Records: R } = load();
  for (const [v, want] of [["en", "en"], ["eng", "en"], ["ger", "de"], ["deu", "de"], ["en-US", "en"], [["fre"], "fr"], ["", ""], ["xyz", ""]]) {
    assert.equal(R.normLang(v), want, JSON.stringify(v));
  }
  assert.equal(R.make("x", { title: "t", language: "eng" }).language, "en");
});

test("post-filters drop only known values that fail", () => {
  const ZR = load();
  const R = ZR.Records;
  const recs = [
    R.make("a", { title: "English journal", language: "en", itemType: "journalArticle", citationCount: 10, doi: "10.1234/a", abstract: "x".repeat(80) }),
    R.make("a", { title: "German preprint", language: "de", itemType: "preprint", citationCount: 1 }),
    R.make("a", { title: "Unknown language conference", itemType: "conferencePaper", abstract: "y".repeat(80) }),
  ];
  const f = (o) => ZR.Search.applyFilters(recs, o).records.map((r) => r.title);
  eq(f({ languages: ["en"] }), ["English journal", "Unknown language conference"], "unknown language kept");
  eq(f({ types: ["journal", "conference"] }), ["English journal", "Unknown language conference"]);
  eq(f({ minCitations: 5 }), ["English journal", "Unknown language conference"], "unknown citation count kept");
  eq(f({ hasAbstract: true, hasDOI: true }), ["English journal"]);
  eq(ZR.Search.applyFilters(recs, { languages: ["en"], hasDOI: true }).removed, { language: 1, type: 0, citations: 0, abstract: 0, doi: 1 });
  const sorted = (k) => recs.slice().sort(ZR.Search.SORTS[k]).map((r) => r.title[0]);
  eq(sorted("cited"), ["E", "G", "U"]);
  eq(sorted("title"), ["E", "G", "U"]);
});

test("OpenAlex and Semantic Scholar receive the filters server-side", async () => {
  const urls = [];
  const http = mockHTTP((url) => {
    urls.push(url);
    return url.includes("openalex") ? { meta: { count: 0 }, results: [] } : { total: 0, data: [] };
  });
  const ZR = load({ http });
  ZR.Sources.throttle = async () => {};
  const o = { ast: ZR.Query.parse("BIM"), limit: 5, languages: ["en", "de"], types: ["journal", "conference"], minCitations: 10 };
  await ZR.Sources.get("openalex").search(o);
  await ZR.Sources.get("semanticscholar").search(o);
  assert.equal(new URL(urls[0]).searchParams.get("filter"), "language:en|de,cited_by_count:>9");
  const s2 = new URL(urls[1]).searchParams;
  assert.equal(s2.get("minCitationCount"), "10");
  assert.equal(s2.get("publicationTypes"), "JournalArticle,Conference");
});

test("a hanging source is skipped after the deadline, others still return", async () => {
  const ZR = load();
  ZR.Sources.get("arxiv").search = () => new Promise(() => {}); // never answers
  ZR.Sources.get("doaj").search = async () => ({ records: [ZR.Records.make("doaj", { title: "A fast result about BIM" })], query: "BIM", total: 1 });
  const t0 = Date.now();
  const run = await ZR.Search.run({ mode: "structured", query: "BIM", sources: ["arxiv", "doaj"], limit: 5, sourceTimeout: 80 });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(run.perSource.arxiv.error, /no answer within/);
  assert.equal(run.perSource.doaj.count, 1);
  assert.equal(run.records.length, 1);
  assert.ok(run.perSource.doaj.ms >= 0);
});

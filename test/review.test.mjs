import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

test("ledger serializes to note HTML and parses back, sharded when large", () => {
  const ZR = load();
  const S = ZR.Store;
  const ledger = S.emptyLedger();
  ledger.decisions["doi:10.1234/x"] = { t: 'A <b>"quoted"</b> & title', ta: { d: "exclude", r: "Weak / low quality", by: "me", at: "2026-09-25" } };
  ledger.reviews.ABCD1234 = { question: "Q?", reasons: ["Off topic"], runs: [{ query: 'a AND "b"', identified: 3 }] };
  const [html] = S.serialize(ledger);
  assert.match(html, /<pre>/);
  assert.ok(!html.includes('<b>"quoted"</b>'), "content is escaped");
  eq(S.parse([html]), JSON.parse(JSON.stringify(ledger)));

  // Force sharding
  for (let i = 0; i < 1500; i++) ledger.decisions["t:paper " + i] = { t: "x".repeat(100), ta: { d: "include", r: "", by: "me", at: "2026-09-25" } };
  const shards = S.serialize(ledger);
  assert.ok(shards.length >= 2, "sharded");
  assert.match(shards[1], /Part 2 of \d+/);
  eq(S.parse(shards.slice().reverse()), JSON.parse(JSON.stringify(ledger)), "order-independent");
  eq(S.parse([]), JSON.parse(JSON.stringify(S.emptyLedger())));
  eq(S.parse(["<p>broken</p><pre>{not json</pre>"]), JSON.parse(JSON.stringify(S.emptyLedger())));
});

test("paper keys are stable across sources", () => {
  const { Store: S } = load();
  assert.equal(S.keyForRecord({ doi: "https://doi.org/10.1234/ABC" }), "doi:10.1234/abc");
  assert.equal(S.keyForRecord({ ids: { arxiv: "1706.03762v5" }, title: "x" }), "arxiv:1706.03762");
  assert.equal(S.keyForRecord({ title: "Attention Is All You Need!" }), "t:attention is all you need");
  assert.equal(S.describe({ ta: { d: "exclude", r: "Off topic", at: "2026-09-25", by: "llm" } }), "Excluded 2026-09-25 — Off topic · by AI");
});

test("PRISMA counts follow the 2020 flow", () => {
  const { Prisma: P } = load();
  const runs = [
    { mode: "structured", perSource: { openalex: { count: 40 }, arxiv: { count: 10 } }, identified: 50, deduped: 42, inLibrary: 2, imported: 40 },
    { mode: "related", perSource: { openalex: { count: 5 } }, identified: 5, deduped: 5, inLibrary: 0, imported: 5 },
  ];
  const items = [
    ...Array(20).fill({ ta: "exclude", reason: "Off topic" }),
    ...Array(5).fill({ ta: "exclude", reason: "Language" }),
    ...Array(3).fill({ ta: "maybe" }),
    ...Array(4).fill({ ta: null }),
    { ta: "include", ft: "include", hasPDF: true },
    { ta: "include", ft: "include", hasPDF: true },
    { ta: "include", ft: "exclude", reason: "Wrong context or population", hasPDF: true },
    { ta: "include", ft: null, hasPDF: false },
    { ta: "include", ft: null, hasPDF: true },
  ];
  const c = P.countsFromData(runs, items, (id) => ({ openalex: "OpenAlex", arxiv: "arXiv" })[id]);
  eq(c.bySource, { OpenAlex: 40, arXiv: 10 });
  assert.equal(c.identified, 50);
  assert.equal(c.otherMethods.citation, 5);
  assert.equal(c.removedDuplicates, 8);
  assert.equal(c.removedInLibrary, 2);
  assert.equal(c.screened, 37);
  assert.equal(c.excludedTA, 25);
  eq(c.excludedTAReasons, { "Off topic": 20, Language: 5 });
  assert.equal(c.maybeTA, 3);
  assert.equal(c.pendingTA, 4);
  assert.equal(c.sought, 5);
  assert.equal(c.notRetrieved, 1);
  assert.equal(c.assessed, 3);
  assert.equal(c.pendingFT, 1);
  eq(c.excludedFT, { "Wrong context or population": 1 });
  assert.equal(c.included, 2);

  const svg = P.svg(c, { title: "PRISMA 2020 — test & more" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /Studies included in review \(n = 2\)/);
  assert.match(svg, /test &amp; more/);
  assert.ok(!/<text[^>]*>[^<]*&(?!amp;|lt;|gt;)/.test(svg), "text is XML-escaped");
  assert.match(P.noteHTML(c, { question: "Q" }, "My Library › test"), /Studies included in review: <strong>2<\/strong>/);
});

test("citation edges from OpenAlex, Semantic Scholar and OpenCitations payloads", () => {
  const { Citations: C } = load();
  const a = { id: 1, doi: "10.1111/a" };
  const b = { id: 2, doi: "10.1111/b" };
  const c = { id: 3, doi: "", arxiv: "1706.03762" };
  const byDOI = new Map([[a.doi, a], [b.doi, b]]);
  const byArxiv = new Map([[c.arxiv, c]]);
  const oa = C.edgesFromOpenAlex(
    [
      { id: "https://openalex.org/W1", doi: "https://doi.org/10.1111/A", referenced_works: ["https://openalex.org/W2", "https://openalex.org/W9", "https://openalex.org/W9"] },
      { id: "https://openalex.org/W2", doi: "https://doi.org/10.1111/b", referenced_works: [] },
    ],
    byDOI
  );
  eq(oa.edges, [[1, 2]]);
  assert.equal(oa.external.get("https://openalex.org/W9"), 2);
  assert.equal(oa.found.size, 2);

  const s2 = C.edgesFromS2([{ references: [{ externalIds: { ArXiv: "1706.03762" } }, { externalIds: { DOI: "10.1111/A" } }] }, null], [b, a], byDOI, byArxiv);
  eq(s2.edges, [[2, 3], [2, 1]]);
  eq([...s2.found], [2]);

  eq(C.doisFromOpenCitations([{ cited: "omid:br/1 doi:10.1111/B openalex:W2" }, { cited: "omid:br/2" }]), ["10.1111/b"]);
});

test("research areas hide sources (medicine off by default)", () => {
  const ZR = load();
  const S = ZR.Sources;
  const visible = S.visibleSearchable().map((s) => s.id);
  assert.ok(!visible.includes("pubmed") && !visible.includes("europepmc"), "medicine hidden by default");
  assert.ok(visible.includes("openalex") && visible.includes("ieee"));
  assert.equal(S.isEnabled("pubmed"), false);
  S.setDisciplineEnabled("medicine", true);
  assert.ok(S.visibleSearchable().some((s) => s.id === "pubmed"));
  S.setDisciplineEnabled("engineering", false);
  S.setDisciplineEnabled("physics", false);
  const v2 = S.visibleSearchable().map((s) => s.id);
  assert.ok(!v2.includes("arxiv") && !v2.includes("ieee"));
  assert.ok(v2.includes("sciencedirect"), "multi-area source stays while one area is on");
  S.setDisciplineEnabled("multi", false);
  assert.ok(S.disciplineEnabled("multi"), "multidisciplinary cannot be switched off");
});

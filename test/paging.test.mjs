import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

const reply = (data) => ({ status: 200, text: JSON.stringify(data), json: () => data });

test("no limit: OpenAlex is paged with its cursor until the last result", async () => {
  const ZR = load();
  const cursors = [];
  ZR.http = async (m, url) => {
    const u = new URL(url);
    cursors.push(u.searchParams.get("cursor"));
    const page = cursors.length;
    const results = Array.from({ length: page < 3 ? 200 : 37 }, (_, i) => ({ id: `W${page}-${i}`, title: `Paper ${page}-${i}`, publication_year: 2020 }));
    return reply({ meta: { count: 437, next_cursor: page < 3 ? "c" + page : null }, results });
  };
  const pages = [];
  const out = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("BIM"), limit: 0, onPage: (n, total) => pages.push(`${n}/${total}`) });
  eq(cursors, ["*", "c1", "c2"]);
  assert.equal(out.records.length, 437);
  assert.equal(out.total, 437);
  assert.equal(out.capped, 0);
  eq(pages, ["200/437", "400/437", "437/437"]);
});

test("a limit still stops early; the last page asks only for what is missing", async () => {
  const ZR = load();
  const sizes = [];
  ZR.http = async (m, url) => {
    const n = Number(new URL(url).searchParams.get("per_page"));
    sizes.push(n);
    return reply({ meta: { count: 5000, next_cursor: "next" + sizes.length }, results: Array.from({ length: n }, (_, i) => ({ id: `W${sizes.length}-${i}`, title: "T" })) });
  };
  const out = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("BIM"), limit: 250 });
  eq(sizes, [200, 50]);
  assert.equal(out.records.length, 250);
});

test("no limit: Scopus stops at what its API hands out (5,000) and says so", async () => {
  const ZR = load();
  const starts = [];
  ZR.http = async (m, url) => {
    const u = new URL(url);
    const start = Number(u.searchParams.get("start"));
    const count = Number(u.searchParams.get("count"));
    starts.push(start);
    if (u.searchParams.get("view") === "COMPLETE") throw new ZR.Util.HTTPError(401, url, "unauthorized");
    const entry = Array.from({ length: count }, (_, i) => ({ "dc:title": `S${start + i}`, "prism:doi": `10.1/s${start + i}` }));
    return reply({ "search-results": { "opensearch:totalResults": "12345", entry } });
  };
  const out = await ZR.Sources.get("scopus").search({ ast: ZR.Query.parse("BIM"), limit: 0, key: "K", secret: () => "" });
  assert.equal(out.records.length, 5000);
  assert.equal(out.capped, 5000);
  assert.equal(out.total, 12345);
  assert.equal(starts.at(-1), 4800);
});

test("an error on a later page keeps the results so far", async () => {
  const ZR = load();
  let calls = 0;
  ZR.http = async () => {
    calls++;
    if (calls === 3) throw new ZR.Util.HTTPError(429, "https://api.openalex.org/works", "rate limit");
    return reply({ meta: { count: 1000, next_cursor: "c" + calls }, results: Array.from({ length: 200 }, (_, i) => ({ id: `W${calls}-${i}`, title: "T" })) });
  };
  const out = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("BIM"), limit: 0 });
  assert.equal(out.records.length, 400);
  assert.match(out.note, /stopped after 400: HTTP 429/);
  // and the search log says the source was cut short
  const run = ZR.Prisma.runRecord({ perSource: { openalex: { count: 400, total: 1000, note: out.note } } });
  assert.match(run.perSource.openalex.note, /stopped after 400/);
  assert.equal(run.perSource.openalex.total, 1000);
});

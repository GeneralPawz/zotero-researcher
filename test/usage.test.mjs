import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

const reply = (data) => ({ status: 200, text: JSON.stringify(data), json: () => data });

test("tokens from every provider's report; the autopilot's calls are tagged with session and step", async () => {
  const http = mockHTTP((url) =>
    url.includes("anthropic")
      ? { model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 } }
      : { model: "gpt-6-astra", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } } }
  );
  const ZR = load({ http });
  const got = [];
  ZR.Usage.setSink((r) => got.push(r));
  ZR.Usage.setContext({ session: "s1", stage: "protocol" });
  await ZR.LLM.chat({ id: "a", name: "Claude", provider: "anthropic", model: "claude-opus-5-5", apiKey: "k" }, [{ role: "user", content: "Which methodology?" }]);
  ZR.Usage.setContext({ session: "s1", stage: "screen" });
  await ZR.LLM.chat({ id: "o", name: "OpenAI", provider: "openai", model: "gpt-6-astra", apiKey: "k", effort: "low" }, [{ role: "user", content: "Rate these" }]);
  ZR.Usage.setContext(null);
  await ZR.LLM.chat({ id: "o", name: "OpenAI", provider: "openai", model: "gpt-6-astra", apiKey: "k" }, [{ role: "user", content: "outside" }]);
  assert.equal(got.length, 2, "only calls inside a session are kept for it");
  eq([got[0].input, got[0].cached, got[0].output, got[0].stage], [1000, 900, 40, "protocol"]);
  eq([got[1].input, got[1].cached, got[1].output, got[1].reasoning, got[1].effort, got[1].stage], [1200, 1000, 300, 250, "low", "screen"]);
  const sum = ZR.Usage.summarize(got);
  eq([sum.total.calls, sum.total.input, sum.total.output], [2, 2200, 340]);
  eq(sum.byModel.map((m) => m.key), ["OpenAI · gpt-6-astra · low", "Claude · claude-opus-5-5"]);
  eq(sum.byStage.map((m) => m.key).sort(), ["protocol", "screen"]);
});

test("CLI reports: Codex --json events and Claude Code's result", () => {
  const { Usage: U } = load();
  const codex = U.parse.codex(['{"type":"thread.started"}', '{"type":"turn.completed","usage":{"input_tokens":13764,"cached_input_tokens":11776,"output_tokens":5,"reasoning_output_tokens":2}}', "not json"].join("\n"), "gpt-6-astra");
  eq([codex.input, codex.cached, codex.output, codex.reasoning, codex.model], [13764, 11776, 5, 2, "gpt-6-astra"]);
  const claude = U.parse.claude({ usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 80 }, total_cost_usd: 0.0123, modelUsage: { "claude-opus-5-5": {} } }, "opus");
  eq([claude.input, claude.cached, claude.output, claude.cost, claude.model], [5210, 5000, 80, 0.0123, "claude-opus-5-5"]);
});

test("an interrupted search continues where it stopped; nothing is fetched twice", async () => {
  const ZR = load();
  const asked = [];
  ZR.http = async (m, url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get("cursor"));
    const c = u.searchParams.get("cursor");
    const page = c === "*" ? 1 : Number(c.slice(1)) + 1;
    return reply({ meta: { count: 600, next_cursor: page < 3 ? "c" + page : null }, results: Array.from({ length: 200 }, (_, i) => ({ id: `W${page}-${i}`, title: `P ${page}-${i}` })) });
  };
  const first = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("BIM"), limit: 200 });
  eq(first.pos, { offset: 200, cursor: "c1" });
  const done = ZR.Search.completeness(first, { limit: 200 }, { count: 200 });
  assert.equal(done.reason, "limit");
  const rest = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("BIM"), limit: 0, resume: first.pos });
  eq(asked, ["*", "c1", "c2"], "the second search starts at the cursor where the first stopped");
  assert.equal(rest.records.length, 400);
  assert.equal(rest.pos, null, "nothing left");
  assert.equal(new Set([...first.records, ...rest.records].map((r) => r.ids.openalex)).size, 600);
});

test("Crossref continues each OR-branch by offset (its cursors expire)", async () => {
  const ZR = load();
  ZR.Sources.throttle = async () => {};
  const calls = [];
  ZR.http = async (m, url) => {
    const u = new URL(url);
    calls.push({ q: u.searchParams.get("query.bibliographic"), offset: u.searchParams.get("offset"), cursor: u.searchParams.get("cursor") });
    return reply({ message: { "total-results": 30, items: Array.from({ length: Number(u.searchParams.get("rows")) }, (_, i) => ({ DOI: `10.1/${u.searchParams.get("query.bibliographic")}-${u.searchParams.get("offset") || 0}-${i}`, title: ["T"] })), "next-cursor": "x" } });
  };
  const out = await ZR.Sources.get("crossref").search({ ast: ZR.Query.parse("BIM OR IFC"), limit: 10 });
  assert.equal(out.pos.branches.length, 2);
  eq(out.pos.branches.map((b) => b.offset), [5, 5]);
  calls.length = 0;
  await ZR.Sources.get("crossref").search({ ast: ZR.Query.parse("BIM OR IFC"), limit: 10, resume: { branches: [{ offset: 5 }, null] } });
  eq(calls.map((c) => [c.q, c.offset, c.cursor]), [["BIM", "5", null]], "only the unfinished branch, from its offset");
});

test("the project lists databases that did not deliver every hit, until fetched or dismissed; when to retry", () => {
  const ZR = load();
  const run = ZR.Prisma.runRecord({
    id: "r1",
    perSource: {
      scopus: { count: 5000, total: 12000, reason: "cap", retryHint: "not by trying again" },
      openalex: { count: 25, total: 900, reason: "limit", pos: { offset: 25, cursor: "c1" }, retryHint: "any time" },
      core: { count: 0, error: "HTTP 429 (rate limit) from api.core.ac.uk", reason: "error", pos: { offset: 0 }, ...ZR.Search.retryHint("HTTP 429 (rate limit or daily quota exceeded)") },
      arxiv: { count: 12, total: 12 },
    },
  });
  const p = { runs: [run] };
  const list = ZR.Projects.incomplete(p);
  eq(list.map((x) => [x.source, x.fetched, x.total, x.reason]), [["scopus", 5000, 12000, "cap"], ["openalex", 25, 900, "limit"], ["core", 0, 0, "error"]]);
  assert.ok(new Date(list[2].retryAt) > new Date(), "a quota: later");
  run.perSource.openalex.done = "r2";
  run.perSource.scopus.dismissed = true;
  eq(ZR.Projects.incomplete(p).map((x) => x.source), ["core"]);
  assert.match(ZR.Search.retryHint("HTTP 403 (access denied: key invalid)").retryHint, /API key/);
});

test("fixed-size pages: a limit inside a page is remembered, the rest continues right after it", async () => {
  const ZR = load();
  ZR.Sources.throttle = async () => {};
  // DOAJ: page numbers of 100
  const pages = [];
  ZR.http = async (m, url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return reply({ total: 250, results: Array.from({ length: page < 3 ? 100 : 50 }, (_, i) => ({ bibjson: { title: `D${(page - 1) * 100 + i}`, identifier: [{ type: "doi", id: `10.1/d${(page - 1) * 100 + i}` }] } })) });
  };
  const first = await ZR.Sources.get("doaj").search({ ast: ZR.Query.parse("BIM"), limit: 5 });
  eq(first.pos, { offset: 5 }, "5 kept, not the whole page of 100");
  const rest = await ZR.Sources.get("doaj").search({ ast: ZR.Query.parse("BIM"), limit: 0, resume: first.pos });
  eq(pages, [1, 1, 2, 3]);
  eq(rest.records.map((r) => r.title).slice(0, 2), ["D5", "D6"], "continues with the 6th");
  assert.equal(rest.records.length, 245);
  assert.equal(rest.pos, null);
  // Semantic Scholar: a token per page of 1000
  const tokens = [];
  ZR.http = async (m, url) => {
    const t = new URL(url).searchParams.get("token");
    tokens.push(t);
    const k = t ? Number(t.slice(1)) : 0;
    return reply({ total: 1500, token: k === 0 ? "t1" : null, data: Array.from({ length: k === 0 ? 1000 : 500 }, (_, i) => ({ paperId: `P${k * 1000 + i}`, title: `S${k * 1000 + i}` })) });
  };
  const s1 = await ZR.Sources.get("semanticscholar").search({ ast: ZR.Query.parse("BIM"), limit: 5 });
  eq(s1.pos, { offset: 5, skip: 5 });
  const s2 = await ZR.Sources.get("semanticscholar").search({ ast: ZR.Query.parse("BIM"), limit: 0, resume: s1.pos });
  eq(tokens, [null, null, "t1"]);
  eq(s2.records[0].title, "S5");
  assert.equal(s2.records.length, 1495);
});

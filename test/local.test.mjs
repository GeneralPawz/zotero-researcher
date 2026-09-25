import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP } from "./harness.mjs";

// Deterministic stand-in for an embedding model: hashed bag of words (256 dims).
// Texts sharing words get similar vectors — enough to test ranking, learning,
// duplicates, passages and clustering without a real model.
const STOP = new Set(["the", "a", "of", "and", "in", "on", "for", "with", "to", "is", "we"]);
function bow(text) {
  const v = new Array(256).fill(0);
  const clean = text.replace(/^(search_document|search_query): /, "").toLowerCase();
  for (const w of clean.split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    let h = 7;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    v[h % 256] += 1;
  }
  v[255] += 0.01; // never all-zero
  return v;
}

function ollama({ onEmbed } = {}) {
  return mockHTTP((url, method, o) => {
    if (url.endsWith("/api/version")) return { version: "0.30.7" };
    if (url.endsWith("/api/tags")) return { models: [{ name: "nomic-embed-text:latest" }] };
    if (url.endsWith("/api/embed")) {
      onEmbed?.(o.body.input);
      return { model: o.body.model, embeddings: o.body.input.map(bow) };
    }
    if (url === "https://api.typesafe.ai/v1/systemone") {
      const answers = {};
      for (const id of Object.keys(o.body.questions)) answers[id] = { type: "noul", noul: id.startsWith("exc_") ? 0.02 : 0.5 };
      return { model: "jev-test", answers };
    }
    throw new Error("unexpected " + url);
  });
}

const IFC = (i) => ({ key: "ifc" + i, title: `IFC schema data exchange between BIM tools ${i}`, abstract: "industry foundation classes interoperability BIM exchange schema model view definition" });
const BRIDGE = (i) => ({ key: "br" + i, title: `Corrosion fatigue of steel bridge girders ${i}`, abstract: "corrosion fatigue steel bridge girders inspection cracks welding" });

test("local server check, task prefixes, normalized vectors and the vector cache", async () => {
  const inputs = [];
  const ZR = load({ http: ollama({ onEmbed: (i) => inputs.push(...i) }) });
  const s = await ZR.Embed.check();
  assert.equal(s.ok, true);
  assert.equal(s.version, "0.30.7");
  assert.equal(s.dim, 256);
  assert.equal(ZR.Embed.isAvailable(), true);
  inputs.length = 0;
  const papers = [IFC(1), BRIDGE(1)];
  const v1 = await ZR.Embed.paperVectors(papers);
  assert.ok(inputs.every((t) => t.startsWith("search_document: ")), "nomic document prefix");
  const n = Math.sqrt([...v1.get("ifc1")].reduce((a, b) => a + b * b, 0));
  assert.ok(Math.abs(n - 1) < 1e-6, "unit length");
  inputs.length = 0;
  await ZR.Embed.paperVectors(papers);
  assert.equal(inputs.length, 0, "cached — nothing embedded twice");
  await ZR.Embed.paperVectors([Object.assign(IFC(1), { abstract: "changed abstract" })]);
  assert.equal(inputs.length, 1, "re-embedded when the text changed");
  const [q] = await ZR.Embed.embed(["IFC exchange"], "query");
  assert.ok(ZR.Embed.dot(q, v1.get("ifc1")) > ZR.Embed.dot(q, v1.get("br1")));
  // base64 round trip used by the on-disk cache
  const back = ZR.Embed.fromB64(ZR.Embed.toB64(v1.get("br1")));
  assert.deepEqual([...back], [...v1.get("br1")]);
});

test("an unreachable or refusing server is explained, not fatal", async () => {
  const refuse = async () => {
    const e = new Error("HTTP 403");
    e.status = 403;
    throw e;
  };
  const ZR = load({ http: refuse });
  const s = await ZR.Embed.check();
  assert.equal(s.ok, false);
  assert.match(s.error, /OLLAMA_ORIGINS/);
  assert.equal(ZR.System1.engine(), "rules", "falls back when nothing else is set up");
  const down = load({
    http: async () => {
      throw Object.assign(new Error("connection refused"), { status: 0 });
    },
  });
  assert.match((await down.Embed.check()).error, /not running/);
});

test("local System 1: similarity at first, then it learns from your own decisions", async () => {
  const ZR = load({ http: ollama() });
  await ZR.Embed.check();
  assert.equal(ZR.System1.engine(), "local", "auto-picked when available and no TypeSafe key");
  const protocol = { questions: ["How is IFC used for BIM data exchange?"], framework: "none", frameworkFields: {}, inclusion: ["Studies IFC-based exchange"], exclusion: [], reasons: ["Off topic"] };
  const pool = [IFC(1), IFC(2), BRIDGE(1), BRIDGE(2)];
  const cold = await ZR.System1.score(pool, protocol, { engine: "local" });
  assert.ok(cold.ifc1.p > cold.br1.p, "ranked by similarity to the protocol");
  assert.equal(cold.ifc1.trained, false);
  assert.match(cold.ifc1.model, /similarity to the protocol/);

  // The reviewer turns out to want bridges (the protocol wording is misleading): the
  // learned model must follow the decisions, not the protocol text.
  const decided = [
    ...[3, 4, 5].map((i) => Object.assign(BRIDGE(i), { ta: "include", by: "me" })),
    ...[3, 4, 5].map((i) => Object.assign(IFC(i), { ta: "exclude", by: "me" })),
    ...[6, 7].map((i) => Object.assign(IFC(i), { ta: "include", by: "s1" })), // System 1's own decisions are not labels
  ];
  const all = [...pool, ...decided];
  const learned = await ZR.System1.score(pool, protocol, { engine: "local", all });
  assert.equal(learned.br1.trained, true);
  assert.equal(learned.br1.labels, 6);
  assert.ok(learned.br1.p > 0.5 && learned.ifc1.p < 0.5, JSON.stringify({ br: learned.br1.p, ifc: learned.ifc1.p }));
  assert.equal(learned.br1.suggest.d === "exclude", false);

  // relearn: re-rank rated papers after more decisions, from cached vectors only
  const cands = pool.map((c) => Object.assign({}, c, { s1: cold[c.key] }));
  const { results, trained } = await ZR.System1.relearn(cands, protocol, [...cands, ...decided]);
  assert.equal(trained, true);
  assert.ok(results.br2.p > results.ifc2.p);
});

test("TypeSafe ratings are blended with the learned local model", async () => {
  const ZR = load({ http: ollama() });
  await ZR.Embed.check();
  await ZR.Secrets.set("s1:typesafe", "k");
  const protocol = { questions: ["Bridges?"], framework: "none", frameworkFields: {}, inclusion: [], exclusion: [], reasons: [] };
  const decided = [...[3, 4, 5].map((i) => Object.assign(BRIDGE(i), { ta: "include", by: "me" })), ...[3, 4, 5].map((i) => Object.assign(IFC(i), { ta: "exclude", by: "me" }))];
  const pool = [IFC(1), BRIDGE(1)];
  const res = await ZR.System1.score(pool, protocol, { engine: "typesafe", all: [...pool, ...decided] });
  assert.equal(res.br1.base, 0.5, "TypeSafe's own probability is kept");
  assert.ok(res.br1.learned > 0.5 && res.ifc1.learned < 0.5);
  assert.ok(Math.abs(res.br1.p - (0.5 + res.br1.learned) / 2) < 1e-9);
  // switched off in Settings
  ZR.Prefs.set("s1Blend", false);
  const plain = await ZR.System1.score(pool, protocol, { engine: "typesafe", all: [...pool, ...decided] });
  assert.equal(plain.br1.learned, undefined);
});

test("duplicates: preprint vs. journal version is found, different papers are not", async () => {
  const ZR = load({ http: ollama() });
  const papers = [
    { key: "a", title: "IFC schema data exchange between BIM tools", abstract: "We study industry foundation classes interoperability in BIM exchange." },
    { key: "b", title: "IFC Schema Data Exchange Between BIM Tools (preprint)", abstract: "We study industry foundation classes interoperability in BIM exchange." },
    { key: "c", title: "Corrosion fatigue of steel bridge girders", abstract: "corrosion fatigue steel bridge girders" },
  ];
  const vecs = await ZR.Embed.paperVectors(papers);
  const pairs = ZR.Embed.duplicates(papers, vecs);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ["a", "b"]);
});

test("passages: long full texts are cut to the parts that matter, in document order", async () => {
  const ZR = load({ http: ollama() });
  const filler = (w) => Array.from({ length: 40 }, (_, i) => `The weather ${w} section talks about unrelated matters number ${i}.`).join(" ");
  const text = ["Abstract: an opening paragraph about this paper.", filler("alpha"), "Results: the IFC exchange between Revit and ArchiCAD lost 12 percent of property sets.", filler("beta"), filler("gamma")].join("\n\n");
  assert.ok(text.length > 3000);
  const out = await ZR.Embed.passages("att:1/X", text, ["IFC exchange results property sets"], { budget: 3000 });
  assert.ok(out.length <= 3000 + 40, "within budget");
  assert.match(out, /Abstract: an opening paragraph/, "keeps the opening for context");
  assert.match(out, /lost 12 percent of property sets/, "finds the relevant passage");
  assert.ok(out.indexOf("Abstract") < out.indexOf("lost 12 percent"), "document order");
  assert.equal(await ZR.Embed.passages("att:1/Y", "short text", ["x"]), "short text", "short texts unchanged");
});

test("k-means groups papers by topic", async () => {
  const ZR = load({ http: ollama() });
  const papers = [1, 2, 3, 4].map(IFC).concat([1, 2, 3, 4].map(BRIDGE));
  const vecs = await ZR.Embed.paperVectors(papers);
  const { assign } = ZR.Embed.kmeans(papers.map((p) => vecs.get(p.key)), 2);
  assert.equal(new Set(assign.slice(0, 4)).size, 1);
  assert.equal(new Set(assign.slice(4)).size, 1);
  assert.notEqual(assign[0], assign[4]);
});

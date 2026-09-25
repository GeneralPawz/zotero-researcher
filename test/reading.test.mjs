import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

test("search terms: positions in the original text, negated terms left out", () => {
  const { Query } = load();
  const ast = Query.parse('("IFC 5" OR IFC5 OR "industry foundation classes") AND build* NOT title:survey');
  const terms = Query.termNodes(ast);
  eq(terms.map((t) => t.text), ["IFC 5", "IFC5", "industry foundation classes", "build*"]);
  const text = "Die Entwicklung von IFC5 — Industry Foundation Classes für Gebäude-Building models; IFC 5.";
  const r = Query.termRanges(text, terms);
  eq(r.map((x) => text.slice(x.start, x.end)), ["IFC5", "Industry Foundation Classes", "Building", "IFC 5"]);
  // accents and case do not shift offsets
  const t2 = "Überblick: ÉTUDE of IFC5";
  const r2 = Query.termRanges(t2, [{ text: "etude" }, { text: "ifc5" }]);
  eq(r2.map((x) => t2.slice(x.start, x.end)), ["ÉTUDE", "IFC5"]);
});

test("years and languages are checked in code, not asked to the System 1 model", async () => {
  const bodies = [];
  const http = mockHTTP((url, m, o) => {
    bodies.push(o.body);
    const answers = {};
    for (const id of Object.keys(o.body.questions)) answers[id] = { type: "noul", noul: id.startsWith("exc_") ? 0.05 : 0.9 };
    return { model: "jev", answers };
  });
  const ZR = load({ http });
  await ZR.Secrets.set("s1:typesafe", "k");
  const protocol = {
    questions: ["How has IFC5 developed?"],
    framework: "none",
    frameworkFields: {},
    inclusion: ["Reports on IFC5 development", "The publication was published between 2020 and 2026 inclusive."],
    exclusion: ["The publication is written in a language other than English or German.", "Is a product advertisement"],
    reasons: ["Off topic", "Language"],
    yearFrom: 2020,
    yearTo: 2026,
    languages: ["en", "de"],
  };
  const cands = [
    { key: "new", title: "IFC5 in 2024", abstract: "…", year: 2024, language: "English" },
    { key: "old", title: "IFC 2x3 in 2012", abstract: "…", year: 2012, language: "en" },
    { key: "fr", title: "IFC5 en France", abstract: "…", year: 2025, language: "fr" },
  ];
  const res = await ZR.System1.score(cands, protocol, { engine: "typesafe" });
  eq(Object.keys(bodies[0].questions).sort(), ["exc_1", "inc_0", "relevant"], "date and language criteria are not sent to the model");
  assert.ok(res.new.p > 0.5);
  assert.ok(res.new.criteria.some((k) => k.code && k.p === 0), "checks shown as passed");
  assert.equal(res.old.p, 0);
  assert.equal(res.old.suggest.d, "exclude");
  assert.match(res.old.suggest.r, /Published outside 2020–2026/);
  assert.equal(res.fr.p, 0);
  assert.equal(res.fr.suggest.r, "Language", "mapped to the protocol's own reason");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

test("every methodology has a valid form, framework and funnel", () => {
  const { Methodologies: M } = load();
  assert.ok(M.LIST.length >= 6);
  for (const m of M.LIST) {
    assert.ok(M.FRAMEWORKS[m.framework], m.id + " framework");
    for (const f of m.frameworks) assert.ok(M.FRAMEWORKS[f], `${m.id}: ${f}`);
    for (const f of m.fields) assert.ok(M.FIELDS[f], `${m.id}: field ${f}`);
    for (const s of m.stages) assert.ok(M.STAGES[s], `${m.id}: stage ${s}`);
    assert.equal(m.stages[0], "protocol");
    assert.equal(m.stages.at(-1), "report");
    assert.ok(m.stages.includes("screen"));
  }
});

test("protocols are normalized against the methodology (LLM output is not trusted blindly)", () => {
  const { Methodologies: M } = load();
  const p = M.normalizeProtocol("scoping", {
    title: " Title ",
    questions: "RQ1\n\nRQ2",
    framework: "PICO", // not allowed for scoping → falls back to PCC
    frameworkFields: { population: "BIM users", concept: "IFC 5", context: "construction", bogus: "x" },
    inclusion: ["a", "", "b"],
    yearFrom: "2019",
    yearTo: 99999,
    languages: ["English", "de", "xx"],
    types: ["journal", "nonsense"],
    quality: ["Q1"], // scoping has no quality appraisal
    extraction: ["Method"],
  });
  assert.equal(p.title, "Title");
  eq(p.questions, ["RQ1", "RQ2"]);
  assert.equal(p.framework, "PCC");
  eq(p.frameworkFields, { population: "BIM users", concept: "IFC 5", context: "construction" });
  eq(p.inclusion, ["a", "b"]);
  assert.equal(p.yearFrom, 2019);
  assert.equal(p.yearTo, null);
  eq(p.languages, ["en", "de"]);
  eq(p.types, ["journal"]);
  eq(p.quality, []);
  eq(p.extraction, ["Method"]);
  assert.ok(p.reasons.length > 3, "default exclusion reasons");
});

test("System 1 (TypeSafe Jev): one literal question per criterion, probabilities combined in code", async () => {
  const bodies = [];
  const http = mockHTTP((url, method, o) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(o.headers.Authorization, "Bearer ts-key");
    bodies.push(o.body);
    const title = o.body.state.title;
    const onTopic = /IFC/.test(title);
    return {
      model: "jev-1.13.0",
      answers: {
        relevant: { type: "noul", noul: onTopic ? 0.9 : 0.05 },
        inc_0: { type: "noul", noul: onTopic ? 0.8 : 0.1 },
        exc_0: { type: "noul", noul: /survey/i.test(title) ? 0.95 : 0.02 },
      },
      usage: { input_tokens: 300, output_tokens: 10 },
    };
  });
  const ZR = load({ http });
  await ZR.Secrets.set("s1:typesafe", "ts-key");
  const protocol = { questions: ["How is IFC 5 used for data exchange?"], framework: "none", frameworkFields: {}, inclusion: ["Studies IFC-based data exchange"], exclusion: ["Is a literature survey"], reasons: ["Off topic", "Wrong study type"] };
  const cands = [
    { key: "k1", title: "IFC 5 exchange in practice", abstract: "We evaluate …", venue: "AutoCon" },
    { key: "k2", title: "A survey of IFC tools", abstract: "Survey …" },
    { key: "k3", title: "Bridge corrosion", abstract: "…" },
  ];
  const res = await ZR.System1.score(cands, protocol, { engine: "typesafe" });
  // request shape
  const q = bodies[0].questions;
  assert.equal(bodies[0].model, "jev-latest");
  assert.equal(q.relevant.type, "noul");
  eq(q.relevant.instructions.review.research_questions, protocol.questions);
  assert.match(q.inc_0.instructions, /inclusion criterion: "Studies IFC-based data exchange"/);
  assert.match(q.exc_0.instructions, /exclusion criterion: "Is a literature survey"/);
  eq(Object.keys(bodies[0].state).sort(), ["abstract", "title", "venue"]);
  // combination
  assert.ok(Math.abs(res.k1.p - 0.9 * 0.98) < 1e-9);
  assert.equal(res.k1.suggest.d, "include");
  assert.equal(res.k2.suggest.d, "exclude");
  assert.equal(res.k2.suggest.r, "Is a literature survey");
  assert.equal(res.k3.suggest.d, "exclude");
  assert.equal(res.k3.suggest.r, "Off topic");
  assert.equal(res.k1.model, "jev-1.13.0");
});

test("System 1 falls back to keyword rules without any AI", async () => {
  const ZR = load();
  const res = await ZR.System1.score([{ key: "a", title: "IFC in BIM", abstract: "" }, { key: "b", title: "Corrosion", abstract: "" }], { query: "IFC AND BIM", inclusion: [], exclusion: [] }, { engine: "rules" });
  assert.ok(res.a.p > res.b.p);
  assert.equal(res.b.suggest.d, "exclude");
});

test("the LLM fills a methodology's protocol from a plain description", async () => {
  const http = mockHTTP((url, m, o) => {
    const prompt = o.body.messages.at(-1).content;
    assert.match(prompt, /Methodology: Scoping review/);
    assert.match(prompt, /PCC: population/);
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "IFC 5 scoping review",
              objective: "Map uses of IFC 5",
              questions: ["RQ1: Which uses of IFC 5 are reported?"],
              framework: "PCC",
              frameworkFields: { population: "AEC practitioners", concept: "IFC 5 / IFCX", context: "BIM data exchange" },
              inclusion: ["Reports a use of IFC 5 or IFCX"],
              exclusion: ["Only mentions IFC in passing"],
              query: '("IFC 5" OR IFCX) AND BIM',
              yearFrom: 2019,
              languages: ["en"],
              extraction: ["Use case", "Tooling"],
              recommendedMethodology: "scoping",
              recommendationWhy: "broad mapping question",
            }),
          },
        },
      ],
    };
  });
  const ZR = load({ http });
  const out = await ZR.Assist.fillProtocol({ id: "x", name: "X", provider: "groq", model: "m", apiKey: "k" }, "scoping", "I want to see how IFC 5 is used");
  assert.equal(out.protocol.framework, "PCC");
  assert.equal(out.protocol.frameworkFields.concept, "IFC 5 / IFCX");
  assert.equal(out.protocol.query, '("IFC 5" OR IFCX) AND BIM');
  eq(out.protocol.extraction, ["Use case", "Tooling"]);
  assert.equal(out.recommended.methodology, "scoping");
});

test("funnel stages follow the methodology", () => {
  const ZR = load();
  const P = ZR.Projects;
  const project = { methodology: "prisma2020", runs: [{ identified: 120 }] };
  const cands = [
    { ta: "include", ft: "include" },
    { ta: "include", ft: null },
    { ta: "exclude" },
    { ta: null },
  ];
  assert.equal(cands.filter((c) => P.inStage(project, "fulltext", c)).length, 2);
  assert.equal(cands.filter((c) => P.inStage(project, "extract", c)).length, 1);
  eq(P.funnel(project, cands).map((s) => s.n), [120, 4, 2, 1]);
  // narrative review has no full-text stage: title/abstract inclusion is final
  const narrative = { methodology: "narrative", runs: [] };
  assert.equal(cands.filter((c) => P.inStage(narrative, "extract", c)).length, 2);
  const rec = P.poolRecord(Object.assign(ZR.Records.make("x", { title: "T", abstract: "a".repeat(9000) }), { llmScore: 5 }));
  assert.equal(rec.abstract.length, 4000);
  assert.equal(rec.llmScore, undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

const protocol = { questions: ["Has IFC 5 development progressed?"], framework: "none", frameworkFields: {}, inclusion: ["Reports on IFC 5 development"], exclusion: ["Does not identify IFC 5"], reasons: ["Off topic", "Wrong study type"], query: "IFC5 AND develop*" };
const cand = (i, p, d = p > 0.7 ? "include" : p < 0.3 ? "exclude" : "maybe") => ({ key: "k" + i, title: `Paper ${i}`, abstract: "…", s1: { p, suggest: { d, r: d === "exclude" ? "Does not identify IFC 5" : "" }, criteria: [{ kind: "exclude", text: "Does not identify IFC 5", p: 1 - p }] } });

test("the harness sees condensed numbers, not papers", () => {
  const { Autopilot: A } = load();
  const cands = [0.02, 0.05, 0.1, 0.5, 0.9].map((p, i) => cand(i, p));
  const s = A.screeningSummary(cands, { excludeBelow: 0.15, includeAbove: 0.85 });
  eq([s.pool, s.rated, s.belowExclude, s.middle, s.aboveInclude], [5, 5, 3, 1, 1]);
  eq(s.suggest, { include: 1, maybe: 1, exclude: 3 });
  eq(s.topExclusionReasons, [["Does not identify IFC 5", 3]]);
  assert.equal(s.criteriaMean["exclude: Does not identify IFC 5"], 0.69);
  assert.equal(s.histogram.reduce((a, b) => a + b, 0), 5);
  assert.equal(s.highest[0].title, "Paper 4");
  assert.ok(!JSON.stringify(s).includes("abstract"), "no abstracts in the summary");
});

test("screening check: drill-down on request, then a validated proposal", async () => {
  const prompts = [];
  const http = mockHTTP((url, m, o) => {
    const prompt = o.body.messages.at(-1).content;
    prompts.push(prompt);
    const reply =
      prompts.length === 1
        ? { drilldown: true, verdict: "adjust", explanation: "", message: "" }
        : {
            drilldown: false,
            verdict: "adjust",
            explanation: "All papers fail the exclusion criterion, which negates the inclusion criterion.",
            message: "Drop the negated exclusion criterion and widen the query.",
            changes: { query: "(IFC5 OR \"IFC 5\") AND (develop* OR roadmap)", exclusion: [], thresholds: { excludeBelow: 0.1, includeAbove: 0.8 }, inclusion: "not a list" },
          };
    return { choices: [{ message: { content: JSON.stringify(reply) } }] };
  });
  const ZR = load({ http });
  const profile = { id: "h", name: "H", provider: "groq", model: "m", apiKey: "k" };
  const cands = [0.01, 0.02, 0.03].map((p, i) => cand(i, p));
  const a = await ZR.Autopilot.assessScreening(profile, protocol, ZR.Autopilot.screeningSummary(cands, { excludeBelow: 0.15, includeAbove: 0.85 }), () => ZR.Autopilot.screeningSample(cands));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Sample papers with their System 1 ratings/);
  assert.equal(a.drilldown, true);
  assert.equal(a.verdict, "adjust");
  eq(a.changes, { query: '(IFC5 OR "IFC 5") AND (develop* OR roadmap)', exclusion: [], thresholds: { excludeBelow: 0.1, includeAbove: 0.8 } }, "invalid parts dropped");
});

test("an unusable query or thresholds are not proposed", () => {
  const { Autopilot: A } = load();
  eq(A.normalizeChanges({ query: "((IFC", thresholds: { excludeBelow: 0.9, includeAbove: 0.2 } }, protocol), {});
  eq(A.normalizeChanges({ query: protocol.query }, protocol), {}, "same query is no change");
});

test("System 1 flags annotation verdicts it disagrees with", () => {
  const { Autopilot: A } = load();
  const anns = [
    { key: "a", kind: "include", text: "x" },
    { key: "b", kind: "include", text: "y" },
    { key: "c", kind: "exclude", text: "z" },
    { key: "d", kind: "maybe", text: "w" },
    { key: "e", kind: "exclude", text: "v" },
  ];
  const flagged = A.discrepancies(anns, { a: 0.9, b: 0.1, c: 0.8, d: 0.9, e: 0.2 });
  eq(flagged.map((f) => [f.key, f.p]), [["b", 0.1], ["c", 0.8]]);
});

test("full-text decisions map back to papers; papers without PDF stay open", async () => {
  const http = mockHTTP(() => ({ choices: [{ message: { content: JSON.stringify({ decisions: [{ i: 0, decision: "include", why: "reports IFC 5 milestones" }, { i: 1, decision: "exclude", reason: "wrong study type", why: "opinion" }, { i: 2, decision: "none" }], summary: "One of two fits." }) } }] }));
  const ZR = load({ http });
  const papers = [
    { key: "p0", title: "A", hasPDF: true, annotations: [{ kind: "include", text: "IFC 5 milestone", isBot: true }] },
    { key: "p1", title: "B", hasPDF: true, annotations: [{ kind: "exclude", text: "opinion piece", isBot: false }] },
    { key: "p2", title: "C", hasPDF: false, annotations: [] },
  ];
  const out = await ZR.Autopilot.decideFullText({ id: "h", name: "H", provider: "groq", model: "m", apiKey: "k" }, protocol, papers);
  eq(out.decisions.map((d) => [d.key, d.d, d.r]), [["p0", "include", ""], ["p1", "exclude", "Wrong study type"]], "reason matched to the protocol's list");
  assert.match(http.calls[0].options.body.messages.at(-1).content, /\[exclude, human\]/, "human annotations are marked");
});

test("System 1 rates passages (TypeSafe) for the annotation check", async () => {
  const http = mockHTTP((url, m, o) => ({ model: "jev", answers: { supports: { type: "noul", noul: /milestone/.test(o.body.state.passage) ? 0.9 : 0.1 } } }));
  const ZR = load({ http });
  await ZR.Secrets.set("s1:typesafe", "k");
  const out = await ZR.System1.scorePassages([{ key: "a", text: "An IFC 5 milestone was reached." }, { key: "b", text: "The weather was fine." }], protocol, { engine: "typesafe" });
  eq(out, { a: 0.9, b: 0.1 });
});

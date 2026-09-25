import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

test("searches are numbered; refinements get sub-versions and follow their parent", () => {
  const { Projects: P } = load();
  const runs = [{ id: "a" }, { id: "b" }, { id: "c", parent: "a" }, { id: "d", parent: "a" }, { id: "e", parent: "c" }, { id: "f" }, {}];
  const labels = P.runLabels(runs);
  eq(runs.map((r) => labels.get(r.id)), ["#1", "#2", "#1.1", "#1.2", "#1.1.1", "#3", "#4"]);
  assert.equal(runs[6].id, "legacy6", "older runs get an id");
  eq(P.runTree(runs).map((x) => [x.label, x.depth]), [["#1", 0], ["#1.1", 1], ["#1.1.1", 2], ["#1.2", 1], ["#2", 0], ["#3", 0], ["#4", 0]]);
});

test("filters say why each paper was dropped", () => {
  const ZR = load();
  const { dropped, records } = ZR.Search.applyFilters(
    [
      { title: "A", language: "de", abstract: "x".repeat(80), doi: "10.1/a" },
      { title: "B", language: "en", abstract: "short", doi: "10.1/b" },
      { title: "C", language: "en", abstract: "x".repeat(80) },
      { title: "D", language: "en", abstract: "x".repeat(80), doi: "10.1/d", citationCount: 2 },
      { title: "E", language: "en", abstract: "x".repeat(80), doi: "10.1/e", citationCount: 9 },
    ],
    { languages: ["en"], hasAbstract: true, hasDOI: true, minCitations: 5 }
  );
  eq(records.map((r) => r.title), ["E"]);
  eq(dropped.map((d) => [d.r.title, d.reason]), [
    ["A", "Language filter: de is not en"],
    ["B", "Filter: no abstract"],
    ["C", "Filter: no DOI"],
    ["D", "Citation filter: 2 < 5 citations"],
  ]);
});

test("audit rows keep what is needed to show and export a paper's fate", () => {
  const ZR = load();
  const row = ZR.Projects.auditRow({ title: "IFC 5", creators: [{ lastName: "A" }, { lastName: "B" }, { lastName: "C" }, { lastName: "D" }], year: 2025, doi: "10.1/x", sources: ["openalex", "crossref"], abstract: "y".repeat(2000) }, "removed", "library", "Already in your library");
  eq([row.fate, row.stage, row.reason, row.creators.length, row.sources], ["removed", "library", "Already in your library", 3, ["openalex", "crossref"]]);
  assert.ok(row.abstract.length <= 600);
  assert.ok(row.key);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

const ZR = load();
const B = ZR.QueryBuilder;
const Q = ZR.Query;
const hit = (q, title) => Q.matches(Q.parse(q), { title });

test("rows compile to valid boolean text", () => {
  eq(B.toQuery([{ field: "any", terms: ['"IFC5"', "IFCX"] }, { op: "AND", field: "any", terms: ["BIM"] }]), '("IFC5" OR IFCX) AND BIM');
  assert.equal(B.toQuery([{ field: "title", terms: ["digital twin"] }, { op: "NOT", field: "title", terms: ["review"] }]), 'title:"digital twin" NOT title:review');
  assert.equal(B.toQuery([{ field: "any", terms: [] }, { op: "AND", field: "any", terms: ["BIM"] }]), "BIM", "empty rows are skipped");
  assert.equal(B.toQuery([{ field: "any", terms: ["and"] }]), '"and"', "operator words are quoted");
  // mixed operators get parentheses so precedence follows row order
  const q = B.toQuery([{ field: "any", terms: ["a"] }, { op: "OR", field: "any", terms: ["b"] }, { op: "AND", field: "any", terms: ["c"] }]);
  assert.equal(q, "(a OR b) AND c");
  assert.ok(!hit(q, "a"), "(a OR b) AND c needs c");
  assert.ok(hit(q, "b c"));
});

test("XOR means one but not both", () => {
  const q = B.toQuery([{ field: "any", terms: ["IFC"] }, { op: "XOR", field: "any", terms: ["BIM"] }]);
  Q.parse(q); // valid syntax
  assert.ok(hit(q, "IFC only"));
  assert.ok(hit(q, "BIM only"));
  assert.ok(!hit(q, "IFC and BIM"));
  assert.ok(!hit(q, "neither"));
});

test("text converts back to rows when the shape allows", () => {
  eq(B.fromQuery('("IFC5" OR IFCX) AND BIM NOT title:survey'), [
    { op: "AND", field: "any", terms: ['"IFC5"', "IFCX"] },
    { op: "AND", field: "any", terms: ["BIM"] },
    { op: "NOT", field: "title", terms: ["survey"] },
  ]);
  eq(B.fromQuery('"digital twin" OR bridge'), [{ op: "AND", field: "any", terms: ["digital twin", "bridge"] }]);
  assert.equal(B.fromQuery("(a AND b) OR c"), null, "nested groups stay text");
  assert.equal(B.fromQuery("(a OR"), null, "invalid text stays text");
  for (const text of ['("IFC5" OR IFCX) AND BIM', 'title:"digital twin" NOT title:review', "a OR b OR c"]) {
    assert.equal(Q.toCanonical(Q.parse(B.toQuery(B.fromQuery(text)))), Q.toCanonical(Q.parse(text)), "round trip: " + text);
  }
});

test("XOR output has no redundant parentheses", () => {
  assert.equal(B.toQuery([{ field: "any", terms: ["IFC"] }, { op: "XOR", field: "any", terms: ["BIM"] }]), "(IFC OR BIM) AND NOT (IFC AND BIM)");
  assert.equal(
    B.toQuery([{ field: "any", terms: ['"IFC5"', "IFCX"] }, { op: "XOR", field: "any", terms: ["BIM"] }]),
    '(("IFC5" OR IFCX) OR BIM) AND NOT (("IFC5" OR IFCX) AND BIM)'
  );
});

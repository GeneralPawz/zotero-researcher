import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

const Zotero = {
  Search: class {
    addCondition() {}
    async search() {
      return [];
    }
  },
  Items: { getAsync: async () => [] },
  Libraries: { get: () => ({ editable: false }) }, // the ledger stays in memory
  logError() {},
};

test("two projects on one collection: the second keeps its own decisions; each gets its tag", async () => {
  const ZR = load({ globals: { Zotero } });
  const P = ZR.Projects;
  const a = await P.create(1, { name: "BIM in der Bauausführung", kind: "review", collectionKey: "COL1" });
  const b = await P.create(1, { name: "BIM in der Bauausführung", kind: "review", collectionKey: "COL1" });
  const q = await P.create(1, { name: "IFC / quick #1", kind: "quick", collectionKey: "COL2" });
  assert.equal(P.reviewKey(a), "COL1", "the first project keeps the collection as its key (as before)");
  assert.equal(P.reviewKey(b), "p:" + b.id, "a project sharing the collection gets a key of its own");
  assert.equal(a.tag, "#review/BIM-in-der-Bauausführung");
  assert.equal(b.tag, "#review/BIM-in-der-Bauausführung-2", "tags stay unique");
  assert.equal(q.tag, "#project/IFC-quick-1");
  const S = ZR.Store;
  const key = "doi:10.1/x";
  await S.decide({ libraryID: 1, key, stage: "ta", d: "include", collectionKey: P.reviewKey(a) });
  await S.decide({ libraryID: 1, key, stage: "ta", d: "exclude", r: "Off topic", collectionKey: P.reviewKey(b) });
  eq((await S.prior(1, { key, collectionKey: P.reviewKey(a) })).ta.d, "include");
  eq((await S.prior(1, { key, collectionKey: P.reviewKey(b) })).ta.d, "exclude");
  // a renamed project keeps its tag
  a.name = "Something else";
  assert.equal(await P.ensureTag(1, a), "#review/BIM-in-der-Bauausführung");
  S._reset();
  P._reset?.();
});

test("nested tags become a tree: groups first, a tag can also be a group", () => {
  const { TagTree: T } = load();
  const tree = T.build(["#review/BIM-in-der-Bauausführung", "#review/IFC review", "#source/query/googleScholar", "#source/query/scopus", "BIM", "Bibliometrics", "#review", "zr:include"]);
  eq(tree.map((n) => n.name), ["#review", "#source", "Bibliometrics", "BIM", "zr:include"]);
  const review = tree[0];
  assert.equal(review.tag, "#review", "a tag that is also a group is selectable");
  eq(review.children.map((c) => c.name), ["BIM-in-der-Bauausführung", "IFC review"]);
  assert.equal(review.leaves, 3);
  const query = tree[1].children[0];
  assert.equal(query.path, "#source/query");
  assert.equal(query.tag, null, "#source/query is only a group");
  eq(query.children.map((c) => c.tag), ["#source/query/googleScholar", "#source/query/scopus"]);
  eq(T.build(["a//b", "/x"]).map((n) => n.path), ["a", "x"]);
  assert.equal(T.build(["/x"])[0].tag, "/x", "the tag itself is kept for selecting it");
});

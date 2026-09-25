import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

// A library without ledger notes yet (the ledger lives in memory for the test)
const Zotero = {
  Search: class {
    addCondition() {}
    async search() {
      return [];
    }
  },
  Items: { getAsync: async () => [] },
  logError() {},
};

test("each review has its own decisions for the same paper", async () => {
  const ZR = load({ globals: { Zotero } });
  const S = ZR.Store;
  const key = "doi:10.1/shared";
  await S.decide({ libraryID: 1, key, title: "Shared paper", stage: "ta", d: "include", by: "me", collectionKey: "REVIEW_A" });
  await S.decide({ libraryID: 1, key, title: "Shared paper", stage: "ta", d: "exclude", r: "Off topic", by: "s1", collectionKey: "REVIEW_B" });
  eq((await S.prior(1, { key, collectionKey: "REVIEW_A" })).ta.d, "include");
  eq((await S.prior(1, { key, collectionKey: "REVIEW_B" })).ta.d, "exclude");
  assert.equal(await S.prior(1, { key, collectionKey: "REVIEW_C" }), null, "undecided in a review that never saw it");
  // Outside a review (search results) the latest judgement is still remembered as a hint
  eq((await S.prior(1, { key })).ta.d, "exclude");
  // Clearing a decision in one review leaves the other alone
  await S.decide({ libraryID: 1, key, stage: "ta", d: null, collectionKey: "REVIEW_B" });
  assert.equal(await S.prior(1, { key, collectionKey: "REVIEW_B" }), null);
  eq((await S.prior(1, { key, collectionKey: "REVIEW_A" })).ta.d, "include");
  S._reset();
});

test("decisions made before per-review storage still count in the review they were made in", async () => {
  const ZR = load({ globals: { Zotero } });
  const S = ZR.Store;
  const ledger = await S.load(1);
  ledger.decisions["doi:10.1/old"] = { t: "Old", c: "REVIEW_A", ta: { d: "exclude", r: "Weak", by: "me", at: "2026-01-01" } };
  eq((await S.prior(1, { key: "doi:10.1/old", collectionKey: "REVIEW_A" })).ta.r, "Weak");
  assert.equal(await S.prior(1, { key: "doi:10.1/old", collectionKey: "REVIEW_B" }), null);
  S._reset();
});

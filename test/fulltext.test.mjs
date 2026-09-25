import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

// A two-page document in Zotero's structured-text shape: text nodes with a textMap of
// runs [header, pageIndex, minX, minY, maxX, maxY, ...char widths]; 5 pt per character.
function run(page, x, y, word) {
  return [0, page, x, y, x + word.length * 5, y + 10, ...Array(word.length).fill(5)];
}
function line(page, y, words, x0 = 50) {
  let x = x0;
  const runs = [];
  for (const w of words) {
    runs.push(run(page, x, y, w));
    x += (w.length + 1) * 5;
  }
  return { text: words.join(" "), anchor: { textMap: JSON.stringify(runs) } };
}
const structure = {
  content: [
    { type: "heading", content: [line(0, 700, ["Introduction"])] },
    { type: "paragraph", content: [line(0, 680, ["IFC", "5", "is", "the", "next", "version."]), { text: " " }, line(0, 668, ["It", "changes", "data", "exchange."])] },
    { type: "paragraph", content: [line(1, 700, ["We", "found", "no", "evi-"]), line(1, 688, ["dence", "of", "stalled", "development."])] },
  ],
};

test("structured text → plain text with a rectangle per character", () => {
  const { FullText: F } = load();
  const doc = F.buildDocument(structure);
  assert.match(doc.text, /^Introduction\n\nIFC 5 is the next version\. It changes data exchange\.\n\nWe found no evi-dence/);
  const i = doc.text.indexOf("IFC");
  eq(doc.pos[i], { pageIndex: 0, rect: [50, 680, 55, 690] });
  assert.equal(doc.pos[i + 3], null, "whitespace has no position");
  // soft-hyphen flag drops the last character's position
  eq(F.runRects(JSON.stringify([[1, 0, 0, 0, 15, 10, 5, 5, 5]])).length, 2);
});

test("a quote is found despite whitespace, case and line-break hyphenation, and gets exact rectangles", () => {
  const { FullText: F } = load();
  const doc = F.buildDocument(structure);
  const hit = F.locate(doc, "it changes   data exchange.");
  assert.equal(doc.text.slice(hit.start, hit.end), "It changes data exchange.");
  const pos = F.position(doc, hit.start, hit.end);
  eq(pos.position, { pageIndex: 0, rects: [[50, 668, 175, 678]] }, "one merged rectangle per line");
  assert.match(pos.sortIndex, /^00000\|\d{6}\|\d{5}$/);
  // across lines and pages, with the hyphenated word joined
  const hit2 = F.locate(doc, "next version. It changes");
  const p2 = F.position(doc, hit2.start, hit2.end).position;
  assert.equal(p2.rects.length, 2, "two lines");
  const hit3 = F.locate(doc, "We found no evidence of stalled development.");
  assert.ok(hit3, "hyphenation at the line end is tolerated");
  eq(F.position(doc, hit3.start, hit3.end).position.pageIndex, 1);
  assert.equal(F.locate(doc, "a sentence that is not in the paper"), null);
});

test("verdict tags are read case-insensitively and in common spellings", () => {
  const { FullText: F } = load();
  eq(["include", "Exclude", "#maybe", "zr:include", "review:exclude", "important"].map(F.kindOfTag), ["include", "exclude", "maybe", "include", "exclude", null]);
  eq(Object.fromEntries(Object.entries(F.KINDS).map(([k, v]) => [k, v.color])), { include: "#5fb236", maybe: "#ffd400", exclude: "#ff6666" }, "Zotero's green / yellow / red");
});

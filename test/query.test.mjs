import { test } from "node:test";
import assert from "node:assert/strict";
import { load, eq } from "./harness.mjs";

const ZR = load();
const Q = ZR.Query;
const canon = (s) => Q.toCanonical(Q.parse(s));

test("parses operators, phrases, implicit AND and precedence", () => {
  assert.equal(canon('("IFC5" OR IFCX) AND BIM'), '("IFC5" OR IFCX) AND BIM');
  assert.equal(canon("BIM IFC"), "BIM AND IFC");
  assert.equal(canon("a OR b AND c"), "a OR (b AND c)");
  assert.equal(canon('"building information modeling" -survey'), '"building information modeling" AND NOT survey');
  assert.equal(canon("a && (b || c) && !d"), "a AND (b OR c) AND NOT d");
  assert.equal(canon("bim and ifc or ifcx"), "(bim AND ifc) OR ifcx");
  assert.equal(canon("title:BIM author:Borrmann"), "title:BIM AND author:Borrmann");
  assert.equal(canon("NOT NOT a"), "a");
  assert.equal(canon("BIM AND"), "BIM", "dangling operator tolerated");
});

test("hyphenated words are terms, not negation", () => {
  assert.equal(canon("IFC-5 BIM"), "IFC-5 AND BIM");
  assert.equal(canon("state-of-the-art"), "state-of-the-art");
});

test("syntax errors are reported", () => {
  assert.throws(() => Q.parse("(a OR b"), /parenthesis/);
  assert.throws(() => Q.parse("a OR b)"), /parenthesis/);
  assert.equal(Q.parse("   "), null);
});

test("compiles to database dialects", () => {
  const ast = Q.parse('("IFC 5" OR IFCX) AND BIM NOT title:survey');
  assert.equal(Q.compile(ast, "openalex"), '("IFC 5" OR IFCX) AND BIM AND NOT survey');
  assert.equal(Q.compile(ast, "scopus"), '(TITLE-ABS-KEY("IFC 5") OR TITLE-ABS-KEY(IFCX)) AND TITLE-ABS-KEY(BIM) AND NOT TITLE(survey)');
  assert.equal(Q.compile(ast, "arxiv"), '(all:"IFC 5" OR all:IFCX) AND all:BIM ANDNOT ti:survey');
  assert.equal(Q.compile(ast, "s2bulk"), '("IFC 5" | IFCX) + BIM + -survey');
  assert.equal(Q.compile(ast, "pubmed"), '("IFC 5"[tiab] OR IFCX[tiab]) AND BIM[tiab] AND NOT survey[ti]');
  assert.equal(Q.compile(ast, "wos"), '(TS=("IFC 5") OR TS=(IFCX)) AND TS=(BIM) NOT TI=(survey)');
  assert.equal(Q.compile(ast, "europepmc"), '("IFC 5" OR IFCX) AND BIM AND NOT TITLE:survey');
});

test("arXiv drops NOT it cannot express", () => {
  assert.equal(Q.compile(Q.parse("a OR NOT b"), "arxiv"), "all:a");
  assert.equal(Q.compile(Q.parse("NOT b"), "arxiv"), "");
});

test("DNF expansion for keyword-only sources", () => {
  eq(Q.keywordQueries(Q.parse('("IFC5" OR IFCX) AND BIM')), ["IFC5 BIM", "IFCX BIM"]);
  eq(Q.keywordQueries(Q.parse("a NOT b")), ["a"]);
  // explosion falls back to the union of positive terms
  const big = Q.parse("(a OR b OR c) AND (d OR e OR f)");
  assert.equal(Q.toDNF(big, 4), null);
  eq(Q.keywordQueries(big, 4), ["a b c d e f"]);
});

test("local matcher honours fields, phrases, wildcards and NOT", () => {
  const rec = {
    title: "IFC 5 and IFCX: towards JSON-based BIM exchange",
    abstract: "We study building information modelling workflows.",
    creators: [{ firstName: "André", lastName: "Borrmann" }],
    keywords: ["openBIM"],
  };
  const m = (q) => Q.matches(Q.parse(q), rec);
  assert.ok(m("IFCX AND BIM"));
  assert.ok(m('"IFC 5"'));
  assert.ok(!m('"IFC 6"'));
  assert.ok(m("build* AND model*"));
  assert.ok(!m("bim NOT json"));
  assert.ok(m("author:borrmann"));
  assert.ok(m("author:andre"), "diacritics folded");
  assert.ok(!m("title:workflows"));
  assert.ok(m("abstract:workflows"));
  assert.ok(!m("IFC5"), "IFC5 is not IFC 5");
  assert.ok(m("openbim"));
});

test("wildcards are stripped only for APIs that reject them", () => {
  const ast = Q.parse('IFC AND "building information model*" AND build*');
  assert.equal(Q.compile(ast, "openalex"), 'IFC AND "building information model" AND build');
  assert.equal(Q.compile(ast, "doaj"), 'IFC AND "building information model" AND build');
  assert.equal(Q.compile(ast, "arxiv"), 'all:IFC AND all:"building information model" AND all:build');
  assert.equal(Q.compile(ast, "europepmc"), 'IFC AND "building information model*" AND build*');
  assert.equal(Q.compile(ast, "scopus"), 'TITLE-ABS-KEY(IFC) AND TITLE-ABS-KEY("building information model*") AND TITLE-ABS-KEY(build*)');
  eq(Q.keywordQueries(ast), ["IFC building information model build"]);
});

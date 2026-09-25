import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

test("util helpers", () => {
  const { Util: U } = load();
  assert.equal(U.cleanDOI("https://doi.org/10.1016/J.AUTCON.2020.103.")," 10.1016/j.autcon.2020.103".trim());
  assert.equal(U.cleanDOI("no doi"), "");
  eq(U.parseName("Ludwig van Beethoven"), { firstName: "Ludwig", lastName: "van Beethoven" });
  eq(U.parseName("Borrmann, André"), { firstName: "André", lastName: "Borrmann" });
  eq(U.parseName("OpenAI"), { name: "OpenAI", fieldMode: 1 });
  assert.equal(U.invertedIndexToText({ hello: [0], world: [1, 3], big: [2] }), "hello world big world");
  assert.equal(U.titleSimilarity("Deep Residual Learning for Image Recognition", "Deep residual learning for image recognition."), 1);
  assert.ok(U.titleSimilarity("Deep Residual Learning", "Attention is all you need") < 0.2);
  eq(U.extractJSON('Sure! ```json\n{"a": [1, "}"]}\n``` done'), { a: [1, "}"] });
  eq(U.extractJSON('Result: [{"i":0,"score":7}] thanks'), [{ i: 0, score: 7 }]);
  assert.equal(U.stripTags("<jats:p>Hello &amp; <b>bye</b></jats:p>"), "Hello & bye");
});

test("records dedupe merges across sources", () => {
  const { Records: R } = load();
  const a = R.make("crossref", { title: "A Study of BIM", doi: "10.1234/ABC", creators: [{ lastName: "X" }], year: 2020 });
  const b = R.make("openalex", { title: "A study of BIM.", doi: "10.1234/abc", abstract: "long abstract", pdfURL: "https://x/a.pdf", year: 2020 });
  const c = R.make("arxiv", { title: "A Study of BIM", ids: { arxiv: "2001.00001" }, itemType: "preprint", year: 2019 });
  const d = R.make("doaj", { title: "Completely different paper title", year: 2020 });
  const out = R.dedupe([a, b, c, d]);
  assert.equal(out.length, 2);
  eq(out[0].sources, ["crossref", "openalex", "arxiv"]);
  assert.equal(out[0].abstract, "long abstract");
  eq(out[0].pdfURLs, ["https://x/a.pdf"]);
  assert.equal(out[0].ids.arxiv, "2001.00001");
  assert.equal(out[0].itemType, "journalArticle");
});

test("source catalog: access classes and availability", () => {
  const ZR = load();
  const S = ZR.Sources;
  assert.ok(S.all().length >= 20);
  for (const s of S.all()) assert.ok(["free", "free-key", "paid"].includes(s.access), s.id);
  const searchable = S.searchable().map((s) => s.id);
  for (const id of ["openalex", "crossref", "semanticscholar", "arxiv", "europepmc", "pubmed", "doaj", "hal", "zenodo", "osti", "dblp", "core", "springer", "ieee", "wos", "scopus", "sciencedirect"]) {
    assert.ok(searchable.includes(id), id);
  }
  assert.equal(S.unavailableReason("openalex"), "");
  assert.match(S.unavailableReason("springer"), /key missing/);
  assert.equal(S.unavailableReason("core"), "", "CORE works keyless");
  assert.match(S.unavailableReason("lens"), /no search adapter/);
});

test("OpenAlex adapter builds request and maps works", async () => {
  const http = mockHTTP((url) => {
    assert.match(url, /^https:\/\/api\.openalex\.org\/works\?/);
    const u = new URL(url);
    assert.equal(u.searchParams.get("search"), "(IFC5 OR IFCX) AND BIM");
    assert.equal(u.searchParams.get("filter"), "from_publication_date:2019-01-01,is_oa:true");
    assert.equal(u.searchParams.get("api_key"), null);
    assert.equal(u.searchParams.get("mailto"), "me@x.org");
    return {
      meta: { count: 1 },
      results: [
        {
          id: "https://openalex.org/W1",
          doi: "https://doi.org/10.1234/XYZ",
          title: "IFCX in practice",
          publication_year: 2024,
          publication_date: "2024-03-01",
          authorships: [{ author: { display_name: "Jane Q Doe" } }],
          primary_location: { source: { display_name: "Automation in Construction", issn_l: "0926-5805", type: "journal" }, landing_page_url: "https://x" },
          best_oa_location: { pdf_url: "https://x/p.pdf" },
          open_access: { is_oa: true },
          abstract_inverted_index: { IFCX: [0], rocks: [1] },
          biblio: { volume: "1", issue: "2", first_page: "10", last_page: "20" },
          type: "article",
          cited_by_count: 5,
        },
      ],
    };
  });
  const ZR = load({ http, prefs: {} });
  const out = await ZR.Sources.get("openalex").search({ ast: ZR.Query.parse("(IFC5 OR IFCX) AND BIM"), limit: 10, yearFrom: 2019, oaOnly: true, email: "me@x.org", key: "" });
  assert.equal(out.records.length, 1);
  const r = out.records[0];
  assert.equal(r.doi, "10.1234/xyz");
  assert.equal(r.abstract, "IFCX rocks");
  assert.equal(r.pages, "10-20");
  eq(r.creators, [{ firstName: "Jane Q", lastName: "Doe" }]);
  eq(r.pdfURLs, ["https://x/p.pdf"]);
  assert.equal(r.itemType, "journalArticle");
});

test("Crossref adapter sends one request per OR-branch", async () => {
  const http = mockHTTP((url) => {
    const q = new URL(url).searchParams.get("query.bibliographic");
    return { message: { "total-results": 1, items: [{ DOI: `10.9999/${q.replace(/\s/g, "")}`, title: [`Paper about ${q}`], author: [{ given: "A", family: "B" }], issued: { "date-parts": [[2021, 5]] }, type: "proceedings-article", "container-title": ["Proc"] }] } };
  });
  const ZR = load({ http });
  ZR.Sources.throttle = async () => {};
  const out = await ZR.Sources.get("crossref").search({ ast: ZR.Query.parse("(IFC5 OR IFCX) AND BIM"), limit: 10, email: "" });
  assert.equal(http.calls.length, 2);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].itemType, "conferencePaper");
  assert.equal(out.records[0].date, "2021-05");
  assert.equal(out.query, "[IFC5 BIM] ∪ [IFCX BIM]");
});

test("Semantic Scholar uses bulk boolean syntax and key header", async () => {
  const http = mockHTTP((url, m, o) => {
    assert.match(url, /paper\/search\/bulk\?/);
    assert.equal(new URL(url).searchParams.get("query"), "(IFC5 | IFCX) + BIM");
    assert.equal(o.headers["x-api-key"], "K");
    assert.match(url, /&openAccessPdf$/);
    return { total: 1, data: [{ paperId: "p1", title: "T", year: 2022, authors: [{ name: "A B" }], externalIds: { DOI: "10.2222/X", ArXiv: "2201.1" }, publicationTypes: ["Conference"], openAccessPdf: { url: "https://pdf" } }] };
  });
  const ZR = load({ http });
  ZR.Sources.throttle = async () => {};
  const out = await ZR.Sources.get("semanticscholar").search({ ast: ZR.Query.parse("(IFC5 OR IFCX) AND BIM"), limit: 5, key: "K", fulltextOnly: true });
  assert.equal(out.records[0].itemType, "conferencePaper");
  assert.equal(out.records[0].ids.arxiv, "2201.1");
});

test("Scopus falls back to STANDARD view without entitlement", async () => {
  const views = [];
  const ZR = load();
  ZR.http = async (method, url, o) => {
    const view = new URL(url).searchParams.get("view");
    views.push(view);
    assert.equal(o.headers["X-ELS-APIKey"], "EK");
    assert.equal(o.headers["X-ELS-Insttoken"], "IT");
    if (view === "COMPLETE") throw new ZR.Util.HTTPError(401, url, "unauthorized");
    const data = { "search-results": { "opensearch:totalResults": "1", entry: [{ "dc:title": "S", "dc:creator": "Doe J.", "prism:doi": "10.3333/S", "prism:coverDate": "2020-01-01", subtypeDescription: "Conference Paper", link: [{ "@ref": "scopus", "@href": "https://scopus/x" }] }] } };
    return { status: 200, text: JSON.stringify(data), json: () => data };
  };
  const out = await ZR.Sources.get("scopus").search({ ast: ZR.Query.parse("BIM AND IFC"), limit: 5, yearFrom: 2020, key: "EK", secret: () => "IT" });
  eq(views, ["COMPLETE", "STANDARD"]);
  assert.equal(out.query, "TITLE-ABS-KEY(BIM) AND TITLE-ABS-KEY(IFC) AND PUBYEAR > 2019");
  assert.equal(out.records[0].itemType, "conferencePaper");
  assert.equal(out.records[0].creators[0].lastName, "Doe");
});

test("dblp HTML bot-check is reported, not mis-parsed", async () => {
  const http = mockHTTP(() => "<!doctype html><title>Making sure you're not a bot!</title>");
  const ZR = load({ http });
  ZR.Sources.throttle = async () => {};
  await assert.rejects(ZR.Sources.get("dblp").search({ ast: ZR.Query.parse("BIM"), limit: 5 }), /HTML page/);
});

test("Europe PMC, DOAJ, CORE, Springer, HAL map correctly", async () => {
  const responses = {
    "ebi.ac.uk": { hitCount: 1, resultList: { result: [{ title: "E", pmid: "1", pmcid: "PMC9", isOpenAccess: "Y", doi: "10.4444/E", pubYear: "2021", authorList: { author: [{ firstName: "Ann", lastName: "Lee" }] }, journalInfo: { journal: { title: "J" }, volume: "3" }, fullTextUrlList: { fullTextUrl: [{ documentStyle: "pdf", availabilityCode: "OA", url: "https://e/pdf" }] } }] } },
    "doaj.org": { total: 1, results: [{ bibjson: { title: "D", year: "2020", author: [{ name: "Zoe Ray" }], identifier: [{ type: "doi", id: "10.5555/D" }], journal: { title: "OJ", issns: ["1234-5678"] }, link: [{ type: "fulltext", url: "https://d/article.pdf" }] } }] },
    "core.ac.uk": { totalHits: 1, results: [{ id: 7, title: "C", yearPublished: 2022, authors: [{ name: "Kim, Min" }], downloadUrl: "https://core/pdf", doi: "10.6666/C" }] },
    "springernature.com": { result: [{ total: "1" }], records: [{ title: "SP", creators: [{ creator: "Smith, John" }], publicationDate: "2023-02-01", doi: "10.7777/S", publicationName: "Sp J", contentType: "Chapter", openaccess: "true", url: [{ format: "pdf", value: "https://sp/pdf" }, { format: "html", value: "https://sp/html" }] }] },
    "archives-ouvertes.fr": { response: { numFound: 1, docs: [{ title_s: ["H"], authFullName_s: ["Marie Curie"], publicationDateY_i: 2019, doiId_s: "10.8888/H", docType_s: "COMM", fileMain_s: "https://hal/pdf", uri_s: "https://hal/x" }] } },
  };
  const http = mockHTTP((url) => {
    const host = Object.keys(responses).find((h) => url.includes(h));
    if (url.includes("doaj.org")) assert.match(decodeURIComponent(url), /bibjson\.year:\[2019 TO 3000\]/);
    return responses[host];
  });
  const ZR = load({ http });
  ZR.Sources.throttle = async () => {};
  const opts = { ast: ZR.Query.parse("BIM"), limit: 5, yearFrom: 2019, key: "k", secret: () => "", email: "" };
  const e = (await ZR.Sources.get("europepmc").search(opts)).records[0];
  eq(e.pdfURLs, ["https://e/pdf", "https://europepmc.org/articles/PMC9?pdf=render"]);
  const d = (await ZR.Sources.get("doaj").search(opts)).records[0];
  assert.equal(d.doi, "10.5555/d");
  eq(d.pdfURLs, ["https://d/article.pdf"]);
  const c = (await ZR.Sources.get("core").search(opts)).records[0];
  eq(c.creators[0], { firstName: "Min", lastName: "Kim" });
  const s = (await ZR.Sources.get("springer").search(opts)).records[0];
  assert.equal(s.itemType, "bookSection");
  eq(s.pdfURLs, ["https://sp/pdf"]);
  assert.equal(s.url, "https://sp/html");
  const h = (await ZR.Sources.get("hal").search(opts)).records[0];
  assert.equal(h.itemType, "conferencePaper");
  assert.ok(http.calls.find((c) => c.url.includes("core.ac.uk")).options.headers.Authorization === "Bearer k");
});

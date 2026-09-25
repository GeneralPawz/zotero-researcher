/* global ZR */
// Source-independent paper record, plus cross-source deduplication.

ZR.Records = (() => {
  const U = ZR.Util;

  const TYPE_MAP = {
    // OpenAlex
    article: "journalArticle",
    "book-chapter": "bookSection",
    book: "book",
    dissertation: "thesis",
    dataset: "dataset",
    preprint: "preprint",
    report: "report",
    review: "journalArticle",
    standard: "standard",
    // Crossref
    "journal-article": "journalArticle",
    "proceedings-article": "conferencePaper",
    "posted-content": "preprint",
    monograph: "book",
    "edited-book": "book",
    "reference-book": "book",
    "book-section": "bookSection",
    "book-part": "bookSection",
    // Semantic Scholar publicationTypes
    journalarticle: "journalArticle",
    conference: "conferencePaper",
    booksection: "bookSection",
    // DBLP
    "journal articles": "journalArticle",
    "conference and workshop papers": "conferencePaper",
    "informal and other publications": "preprint",
    "books and theses": "book",
    "parts in books or collections": "bookSection",
    // misc
    conferencepaper: "conferencePaper",
    "conference paper": "conferencePaper",
    "conference-paper": "conferencePaper",
    inproceedings: "conferencePaper",
    thesis: "thesis",
    "journal article": "journalArticle",
    "research-article": "journalArticle",
    ART: "journalArticle",
    COMM: "conferencePaper",
    COUV: "bookSection",
    OUV: "book",
    THESE: "thesis",
    UNDEFINED: "preprint",
    REPORT: "report",
  };

  // Languages offered as filters; sources report ISO 639-1 ("en") or 639-2 ("eng"/"ger").
  const LANGUAGES = [
    { code: "en", name: "English" },
    { code: "de", name: "German" },
    { code: "fr", name: "French" },
    { code: "es", name: "Spanish" },
    { code: "it", name: "Italian" },
    { code: "pt", name: "Portuguese" },
    { code: "nl", name: "Dutch" },
    { code: "pl", name: "Polish" },
    { code: "zh", name: "Chinese" },
    { code: "ja", name: "Japanese" },
    { code: "ko", name: "Korean" },
    { code: "ru", name: "Russian" },
  ];
  const LANG_ALIASES = {
    eng: "en", english: "en", ger: "de", deu: "de", german: "de", deutsch: "de", fre: "fr", fra: "fr", french: "fr",
    spa: "es", spanish: "es", ita: "it", italian: "it", por: "pt", portuguese: "pt", dut: "nl", nld: "nl", dutch: "nl",
    pol: "pl", polish: "pl", chi: "zh", zho: "zh", chinese: "zh", jpn: "ja", japanese: "ja", kor: "ko", korean: "ko", rus: "ru", russian: "ru",
  };

  /** Normalize a language value to ISO 639-1 ("en"), or "" if unknown. */
  function normLang(v) {
    const s = String(Array.isArray(v) ? v[0] || "" : v || "").trim().toLowerCase().split(/[-_]/)[0];
    if (!s) return "";
    if (s.length === 2) return s;
    return LANG_ALIASES[s] || "";
  }

  // Publication-type filters, as groups of Zotero item types
  const TYPE_FILTERS = [
    { id: "journal", label: "Journal articles", types: ["journalArticle", "magazineArticle"] },
    { id: "conference", label: "Conference papers", types: ["conferencePaper"] },
    { id: "preprint", label: "Preprints", types: ["preprint"] },
    { id: "book", label: "Books & chapters", types: ["book", "bookSection"] },
    { id: "thesis", label: "Theses", types: ["thesis"] },
    { id: "report", label: "Reports & standards", types: ["report", "standard", "document"] },
  ];

  function mapType(t, fallback = "journalArticle") {
    if (!t) return fallback;
    return TYPE_MAP[t] || TYPE_MAP[String(t).toLowerCase()] || fallback;
  }

  function make(source, f) {
    const doi = U.cleanDOI(f.doi || "");
    const title = U.stripTags(Array.isArray(f.title) ? f.title[0] : f.title || "").replace(/\.$/, "");
    const pdfURLs = [...new Set([f.pdfURL, ...(f.pdfURLs || [])].filter(Boolean))];
    const rec = {
      sources: [source],
      ids: Object.assign({}, f.ids || {}),
      title,
      creators: (f.creators || []).filter((c) => c && (c.lastName || c.name)),
      date: f.date ? String(f.date) : f.year ? String(f.year) : "",
      year: f.year ? parseInt(f.year, 10) : U.yearOf(f.date),
      venue: U.stripTags(f.venue || ""),
      volume: f.volume ? String(f.volume) : "",
      issue: f.issue ? String(f.issue) : "",
      pages: f.pages ? String(f.pages) : "",
      issn: f.issn || "",
      isbn: f.isbn || "",
      publisher: f.publisher || "",
      abstract: U.stripTags(f.abstract || ""),
      keywords: (f.keywords || []).filter(Boolean),
      itemType: f.itemType || "journalArticle",
      url: f.url || (doi ? `https://doi.org/${doi}` : ""),
      pdfURLs,
      isOA: !!f.isOA || pdfURLs.length > 0,
      language: normLang(f.language),
      citationCount: typeof f.citationCount === "number" ? f.citationCount : null,
      doi,
    };
    if (doi) rec.ids.doi = doi;
    return rec;
  }

  function hasFullText(r) {
    return r.pdfURLs.length > 0 || r.isOA;
  }

  const fill = (a, b, k) => {
    if ((a[k] === "" || a[k] == null || (Array.isArray(a[k]) && !a[k].length)) && b[k] != null && b[k] !== "") a[k] = b[k];
  };

  function mergeInto(a, b) {
    for (const s of b.sources) if (!a.sources.includes(s)) a.sources.push(s);
    Object.assign(a.ids, Object.fromEntries(Object.entries(b.ids).filter(([k]) => !a.ids[k])));
    for (const k of ["title", "date", "year", "venue", "volume", "issue", "pages", "issn", "isbn", "publisher", "url", "language", "doi"]) {
      fill(a, b, k);
    }
    if (b.abstract.length > a.abstract.length) a.abstract = b.abstract;
    if (b.creators.length > a.creators.length) a.creators = b.creators;
    a.keywords = [...new Set([...a.keywords, ...b.keywords])];
    a.pdfURLs = [...new Set([...a.pdfURLs, ...b.pdfURLs])];
    a.isOA = a.isOA || b.isOA;
    if (b.citationCount != null) a.citationCount = Math.max(a.citationCount ?? 0, b.citationCount);
    // A peer-reviewed type beats "preprint" when both copies describe the same work
    if (a.itemType === "preprint" && b.itemType !== "preprint") a.itemType = b.itemType;
    return a;
  }

  /** Merge duplicates found across sources (same DOI, arXiv id, or near-identical title+year). */
  function dedupe(records) {
    const out = [];
    const byDOI = new Map();
    const byArxiv = new Map();
    const byTitle = new Map();
    for (const r of records) {
      const tkey = U.normalizeTitle(r.title);
      let hit =
        (r.doi && byDOI.get(r.doi)) ||
        (r.ids.arxiv && byArxiv.get(r.ids.arxiv)) ||
        (tkey.length > 12 && byTitle.get(tkey));
      if (hit && !r.doi && hit.doi && hit.year && r.year && Math.abs(hit.year - r.year) > 1 && hit.itemType !== "preprint" && r.itemType !== "preprint") {
        hit = null;
      }
      if (hit) {
        mergeInto(hit, r);
      } else {
        hit = r;
        out.push(r);
      }
      if (hit.doi) byDOI.set(hit.doi, hit);
      if (hit.ids.arxiv) byArxiv.set(hit.ids.arxiv, hit);
      if (tkey.length > 12) byTitle.set(tkey, hit);
    }
    return out;
  }

  function creatorsToString(creators, max = 3) {
    const names = creators.map((c) => c.lastName || c.name).filter(Boolean);
    if (names.length <= max) return names.join(", ");
    return names.slice(0, max).join(", ") + " et al.";
  }

  return { make, mapType, dedupe, mergeInto, hasFullText, creatorsToString, normLang, LANGUAGES, TYPE_FILTERS };
})();

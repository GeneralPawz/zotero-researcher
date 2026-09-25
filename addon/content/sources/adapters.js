/* global ZR, DOMParser */
// Search adapters. Each receives
//   { ast, limit, yearFrom, yearTo, oaOnly, fulltextOnly, key, secret(id), email }
// and resolves to { records, query, total }. `query` is the exact string sent, which
// goes into the search protocol so runs are reproducible.

(() => {
  const U = ZR.Util;
  const R = ZR.Records;
  const Q = ZR.Query;

  const attach = (id, search) => {
    const s = ZR.Sources.get(id);
    if (!s) throw new Error(`No catalog entry for adapter ${id}`);
    s.search = search;
  };

  const yearClause = (o, fmt) => (o.yearFrom || o.yearTo ? fmt(o.yearFrom || 1000, o.yearTo || 3000) : "");
  const withYear = (q, clause) => (clause ? `(${q}) AND ${clause}` : q);
  const pages = (a, b) => (a && b && a !== b ? `${a}-${b}` : a || "");
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const parseXML = (text) => {
    if (typeof DOMParser === "undefined") throw new Error("XML parsing not available in this environment");
    return new DOMParser().parseFromString(text, "application/xml");
  };

  function assertJSONResponse(res, name) {
    const t = res.text.trimStart();
    if (t.startsWith("<")) throw new Error(`${name} returned an HTML page instead of JSON (bot check or outage)`);
    return res.json();
  }

  // --- OpenAlex ------------------------------------------------------------
  function mapOpenAlex(w) {
    const loc = w.primary_location || {};
    const src = loc.source || {};
    const pdf = [w.best_oa_location?.pdf_url, loc.pdf_url].filter(Boolean);
    const ids = { openalex: (w.id || "").replace("https://openalex.org/", "") };
    if (w.ids?.pmid) ids.pmid = String(w.ids.pmid).replace(/\D/g, "");
    if (w.ids?.pmcid) ids.pmcid = "PMC" + String(w.ids.pmcid).replace(/\D/g, "");
    const arx = (w.locations || []).map((l) => l.landing_page_url || "").find((u) => /arxiv\.org\/abs\//.test(u));
    if (arx) ids.arxiv = arx.replace(/.*arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    return R.make("openalex", {
      ids,
      title: w.title || w.display_name,
      creators: (w.authorships || []).map((a) => U.parseName(a.author?.display_name || a.raw_author_name)),
      date: w.publication_date,
      year: w.publication_year,
      doi: w.doi,
      venue: src.display_name,
      issn: src.issn_l || first(src.issn) || "",
      volume: w.biblio?.volume,
      issue: w.biblio?.issue,
      pages: pages(w.biblio?.first_page, w.biblio?.last_page),
      abstract: U.invertedIndexToText(w.abstract_inverted_index),
      keywords: (w.keywords || []).map((k) => k.display_name),
      itemType: src.type === "conference" ? "conferencePaper" : R.mapType(w.type),
      url: loc.landing_page_url,
      pdfURLs: pdf,
      isOA: !!w.open_access?.is_oa,
      language: w.language,
      citationCount: w.cited_by_count,
    });
  }

  attach("openalex", async (o) => {
    const query = Q.compile(o.ast, "openalex");
    const filters = [];
    if (o.yearFrom) filters.push(`from_publication_date:${o.yearFrom}-01-01`);
    if (o.yearTo) filters.push(`to_publication_date:${o.yearTo}-12-31`);
    if (o.oaOnly || o.fulltextOnly) filters.push("is_oa:true");
    if (o.languages?.length) filters.push("language:" + o.languages.join("|"));
    if (o.minCitations > 0) filters.push(`cited_by_count:>${o.minCitations - 1}`);
    const select =
      "id,doi,title,display_name,publication_year,publication_date,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index,biblio,type,language,cited_by_count,keywords,ids,locations";
    const records = [];
    let total = 0;
    for (let page = 1; records.length < o.limit && page <= 5; page++) {
      const url =
        "https://api.openalex.org/works?" +
        U.qs({ search: query, filter: filters.join(","), per_page: Math.min(o.limit, 100), page, select, api_key: o.key, mailto: o.key ? "" : o.email });
      const data = await U.getJSON(url, { retryAfterMax: 45000 });
      total = data.meta?.count ?? 0;
      records.push(...(data.results || []).map(mapOpenAlex));
      if (!data.results?.length || records.length >= total) break;
    }
    return { records: records.slice(0, o.limit), query, total };
  });
  ZR.Sources.get("openalex").mapWork = mapOpenAlex;

  // --- Crossref ------------------------------------------------------------
  function mapCrossref(it) {
    const dp = (it.issued || it.published || it["published-print"] || it["published-online"])?.["date-parts"]?.[0] || [];
    const date = dp.filter((x) => x != null).map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-");
    const ccLicensed = (it.license || []).some((l) => /creativecommons\.org/.test(l.URL || ""));
    const pdfs = ccLicensed ? (it.link || []).filter((l) => /pdf/i.test(l["content-type"] || "")).map((l) => l.URL) : [];
    return R.make("crossref", {
      title: first(it.title),
      creators: (it.author || []).map((a) => (a.family ? { firstName: a.given || "", lastName: a.family } : { name: a.name })),
      date,
      doi: it.DOI,
      venue: first(it["container-title"]),
      volume: it.volume,
      issue: it.issue,
      pages: it.page,
      issn: first(it.ISSN),
      isbn: first(it.ISBN),
      publisher: it.publisher,
      abstract: it.abstract,
      keywords: it.subject || [],
      itemType: R.mapType(it.type),
      url: it.URL,
      pdfURLs: pdfs,
      isOA: ccLicensed,
      language: it.language,
      citationCount: it["is-referenced-by-count"],
    });
  }

  attach("crossref", async (o) => {
    const queries = Q.keywordQueries(o.ast, 4);
    const filters = [];
    if (o.yearFrom) filters.push(`from-pub-date:${o.yearFrom}`);
    if (o.yearTo) filters.push(`until-pub-date:${o.yearTo}`);
    if (o.fulltextOnly) filters.push("has-full-text:true");
    const per = Math.max(5, Math.ceil(o.limit / queries.length));
    const select = "DOI,title,author,container-title,issued,published,volume,issue,page,ISSN,ISBN,abstract,type,URL,link,publisher,is-referenced-by-count,license,subject";
    const records = [];
    let total = 0;
    for (const q of queries) {
      await ZR.Sources.throttle("crossref", o.email ? 400 : 1100);
      const url = "https://api.crossref.org/works?" + U.qs({ "query.bibliographic": q, rows: per, filter: filters.join(","), select, mailto: o.email });
      const data = await U.getJSON(url);
      total += data.message?.["total-results"] || 0;
      records.push(...(data.message?.items || []).map(mapCrossref));
    }
    return { records, query: queries.map((q) => `[${q}]`).join(" ∪ "), total };
  });

  // --- Semantic Scholar (bulk search: boolean syntax, stable without a key) ---
  function mapS2(p) {
    const types = p.publicationTypes || [];
    const itemType = types.includes("Conference") ? "conferencePaper" : types.includes("JournalArticle") || types.includes("Review") ? "journalArticle" : types.includes("Book") ? "book" : types.includes("BookSection") ? "bookSection" : p.externalIds?.ArXiv && !p.journal?.name ? "preprint" : "journalArticle";
    const ids = { s2: p.paperId };
    if (p.externalIds?.ArXiv) ids.arxiv = p.externalIds.ArXiv;
    if (p.externalIds?.PubMed) ids.pmid = p.externalIds.PubMed;
    if (p.externalIds?.PubMedCentral) ids.pmcid = "PMC" + p.externalIds.PubMedCentral;
    return R.make("semanticscholar", {
      ids,
      title: p.title,
      creators: (p.authors || []).map((a) => U.parseName(a.name)),
      date: p.publicationDate || p.year,
      year: p.year,
      doi: p.externalIds?.DOI,
      venue: p.journal?.name || p.venue,
      volume: p.journal?.volume,
      pages: p.journal?.pages,
      abstract: p.abstract,
      itemType,
      url: p.url,
      pdfURLs: p.openAccessPdf?.url ? [p.openAccessPdf.url] : [],
      isOA: !!p.isOpenAccess,
      citationCount: p.citationCount,
    });
  }

  attach("semanticscholar", async (o) => {
    const query = Q.compile(o.ast, "s2bulk");
    const fields = "title,abstract,year,publicationDate,authors,externalIds,venue,journal,publicationTypes,openAccessPdf,isOpenAccess,url,citationCount";
    let year = "";
    if (o.yearFrom || o.yearTo) year = `${o.yearFrom || ""}-${o.yearTo || ""}`;
    const S2_TYPES = { journal: "JournalArticle", conference: "Conference", book: "Book,BookSection" };
    const publicationTypes = (o.types || []).map((t) => S2_TYPES[t]).filter(Boolean).join(",");
    const onlyS2Types = (o.types || []).every((t) => S2_TYPES[t]);
    const params = { query, fields, year, sort: "citationCount:desc", minCitationCount: o.minCitations > 0 ? o.minCitations : "", publicationTypes: onlyS2Types ? publicationTypes : "" };
    let url = "https://api.semanticscholar.org/graph/v1/paper/search/bulk?" + U.qs(params);
    if (o.oaOnly || o.fulltextOnly) url += "&openAccessPdf";
    await ZR.Sources.throttle("semanticscholar", 1100);
    const headers = o.key ? { "x-api-key": o.key } : {};
    const data = await U.getJSON(url, { headers, retryAfterMax: 20000 });
    return { records: (data.data || []).slice(0, o.limit).map(mapS2), query: query + " (sorted by citations)", total: data.total || 0 };
  });
  ZR.Sources.get("semanticscholar").mapWork = mapS2;

  // --- arXiv (Atom XML) ------------------------------------------------------
  function mapArxivEntry(e) {
    const t = (sel) => e.getElementsByTagName(sel)[0]?.textContent?.trim() || "";
    const absURL = t("id");
    const idm = absURL.match(/arxiv\.org\/abs\/(.+?)(v\d+)?$/);
    const doi = e.getElementsByTagNameNS("http://arxiv.org/schemas/atom", "doi")[0]?.textContent || "";
    const journalRef = e.getElementsByTagNameNS("http://arxiv.org/schemas/atom", "journal_ref")[0]?.textContent || "";
    const pdf = Array.from(e.getElementsByTagName("link")).find((l) => l.getAttribute("title") === "pdf")?.getAttribute("href");
    return R.make("arxiv", {
      ids: idm ? { arxiv: idm[1] } : {},
      title: t("title").replace(/\s+/g, " "),
      creators: Array.from(e.getElementsByTagName("author")).map((a) => U.parseName(a.getElementsByTagName("name")[0]?.textContent)),
      date: t("published").slice(0, 10),
      doi,
      venue: journalRef || "arXiv",
      abstract: t("summary").replace(/\s+/g, " "),
      keywords: Array.from(e.getElementsByTagName("category")).map((c) => c.getAttribute("term")),
      itemType: journalRef && doi ? "journalArticle" : "preprint",
      url: absURL,
      pdfURLs: pdf ? [pdf.replace(/^http:/, "https:")] : idm ? [`https://arxiv.org/pdf/${idm[1]}`] : [],
      isOA: true,
    });
  }

  attach("arxiv", async (o) => {
    let query = Q.compile(o.ast, "arxiv");
    if (!query) throw new Error("Query has no positive terms arXiv can search for");
    const yc = yearClause(o, (a, b) => `submittedDate:[${a}01010000 TO ${b}12312359]`);
    if (yc) query = `(${query}) AND ${yc}`;
    await ZR.Sources.throttle("arxiv", 3100);
    const url = "https://export.arxiv.org/api/query?" + U.qs({ search_query: query, start: 0, max_results: Math.min(o.limit, 200), sortBy: "relevance" });
    const doc = parseXML(await U.getText(url));
    const entries = Array.from(doc.getElementsByTagName("entry")).filter((e) => e.getElementsByTagName("title")[0]?.textContent !== "Error");
    const total = parseInt(doc.getElementsByTagNameNS("http://a9.com/-/spec/opensearch/1.1/", "totalResults")[0]?.textContent || "0", 10);
    return { records: entries.map(mapArxivEntry), query, total };
  });

  // --- Europe PMC ----------------------------------------------------------
  function mapEPMC(r) {
    const ft = r.fullTextUrlList?.fullTextUrl || [];
    const pdfs = ft.filter((f) => f.documentStyle === "pdf" && f.availabilityCode === "OA").map((f) => f.url);
    if (r.pmcid && r.isOpenAccess === "Y") pdfs.push(`https://europepmc.org/articles/${r.pmcid}?pdf=render`);
    const pubTypes = (r.pubTypeList?.pubType || []).map((x) => String(x).toLowerCase());
    const authors = r.authorList?.author || [];
    return R.make("europepmc", {
      ids: Object.assign({}, r.pmid ? { pmid: r.pmid } : {}, r.pmcid ? { pmcid: r.pmcid } : {}),
      title: r.title,
      creators: authors.length
        ? authors.map((a) => (a.lastName ? { firstName: a.firstName || a.initials || "", lastName: a.lastName } : a.collectiveName ? { name: a.collectiveName } : U.parseName(a.fullName)))
        : (r.authorString || "").split(/,\s*/).map((n) => U.parseName(n)),
      date: r.firstPublicationDate || r.pubYear,
      year: r.pubYear,
      doi: r.doi,
      venue: r.journalInfo?.journal?.title || r.bookOrReportDetails?.publisher,
      volume: r.journalInfo?.volume,
      issue: r.journalInfo?.issue,
      pages: r.pageInfo,
      issn: r.journalInfo?.journal?.issn || r.journalInfo?.journal?.essn,
      abstract: r.abstractText,
      keywords: r.keywordList?.keyword || [],
      itemType: r.source === "PPR" || pubTypes.includes("preprint") ? "preprint" : "journalArticle",
      url: r.pmid ? `https://europepmc.org/article/MED/${r.pmid}` : r.doi ? `https://doi.org/${r.doi}` : "",
      pdfURLs: pdfs,
      isOA: r.isOpenAccess === "Y",
      language: r.language,
      citationCount: r.citedByCount,
    });
  }

  attach("europepmc", async (o) => {
    let query = withYear(Q.compile(o.ast, "europepmc"), yearClause(o, (a, b) => `PUB_YEAR:[${a} TO ${b}]`));
    if (o.oaOnly || o.fulltextOnly) query = `(${query}) AND OPEN_ACCESS:y`;
    const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + U.qs({ query, resultType: "core", format: "json", pageSize: Math.min(o.limit, 1000) });
    const data = await U.getJSON(url);
    return { records: (data.resultList?.result || []).map(mapEPMC), query, total: data.hitCount || 0 };
  });

  // --- PubMed --------------------------------------------------------------
  attach("pubmed", async (o) => {
    let term = withYear(Q.compile(o.ast, "pubmed"), yearClause(o, (a, b) => `${a}:${b}[dp]`));
    if (o.oaOnly || o.fulltextOnly) term = `(${term}) AND free full text[sb]`;
    const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
    const common = { api_key: o.key, tool: "zotero-researcher", email: o.email };
    const gap = o.key ? 120 : 350;
    await ZR.Sources.throttle("pubmed", gap);
    const search = await U.getJSON(base + "esearch.fcgi?" + U.qs({ db: "pubmed", term, retmode: "json", retmax: Math.min(o.limit, 200), ...common }));
    const ids = search.esearchresult?.idlist || [];
    if (!ids.length) return { records: [], query: term, total: 0 };
    await ZR.Sources.throttle("pubmed", gap);
    const sum = await U.getJSON(base + "esummary.fcgi?" + U.qs({ db: "pubmed", id: ids.join(","), retmode: "json", ...common }));
    // Abstracts only come via efetch (XML); best effort.
    const abstracts = {};
    try {
      await ZR.Sources.throttle("pubmed", gap);
      const doc = parseXML(await U.getText(base + "efetch.fcgi?" + U.qs({ db: "pubmed", id: ids.join(","), rettype: "abstract", retmode: "xml", ...common })));
      for (const art of Array.from(doc.getElementsByTagName("PubmedArticle"))) {
        const pmid = art.getElementsByTagName("PMID")[0]?.textContent;
        abstracts[pmid] = Array.from(art.getElementsByTagName("AbstractText")).map((a) => (a.getAttribute("Label") ? a.getAttribute("Label") + ": " : "") + a.textContent).join(" ");
      }
    } catch (e) {
      U.log("PubMed efetch failed", e.message);
    }
    const records = ids
      .map((id) => sum.result?.[id])
      .filter(Boolean)
      .map((r) => {
        const aid = (t) => (r.articleids || []).find((x) => x.idtype === t)?.value || "";
        const pmcid = aid("pmc");
        return R.make("pubmed", {
          ids: Object.assign({ pmid: r.uid }, pmcid ? { pmcid } : {}),
          title: r.title,
          creators: (r.authors || []).filter((a) => a.authtype !== "CollectiveName").map((a) => {
            const m = String(a.name).match(/^(.+?)\s+([A-Z]{1,4})$/);
            return m ? { firstName: m[2], lastName: m[1] } : { name: a.name };
          }),
          date: r.sortpubdate ? r.sortpubdate.slice(0, 10).replace(/\//g, "-") : r.pubdate,
          doi: aid("doi"),
          venue: r.fulljournalname || r.source,
          volume: r.volume,
          issue: r.issue,
          pages: r.pages,
          issn: r.issn || r.essn,
          abstract: abstracts[r.uid] || "",
          itemType: "journalArticle",
          url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
          pdfURLs: pmcid ? [`https://europepmc.org/articles/${pmcid}?pdf=render`] : [],
          isOA: !!pmcid,
          language: first(r.lang),
        });
      });
    return { records, query: term, total: parseInt(search.esearchresult?.count || "0", 10) };
  });

  // --- DOAJ ----------------------------------------------------------------
  attach("doaj", async (o) => {
    const query = withYear(Q.compile(o.ast, "doaj"), yearClause(o, (a, b) => `bibjson.year:[${a} TO ${b}]`));
    await ZR.Sources.throttle("doaj", 550);
    const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?` + U.qs({ page: 1, pageSize: Math.min(o.limit, 100) });
    const data = await U.getJSON(url);
    const records = (data.results || []).map((r) => {
      const b = r.bibjson || {};
      const doi = (b.identifier || []).find((i) => String(i.type).toLowerCase() === "doi")?.id;
      const ft = (b.link || []).filter((l) => l.type === "fulltext").map((l) => l.url);
      return R.make("doaj", {
        title: b.title,
        creators: (b.author || []).map((a) => U.parseName(a.name)),
        date: [b.year, b.month].filter(Boolean).join("-"),
        year: b.year,
        doi,
        venue: b.journal?.title,
        volume: b.journal?.volume,
        issue: b.journal?.number,
        pages: pages(b.start_page, b.end_page),
        issn: first(b.journal?.issns),
        publisher: b.journal?.publisher,
        abstract: b.abstract,
        keywords: b.keywords || [],
        itemType: "journalArticle",
        url: ft[0] || (doi ? `https://doi.org/${doi}` : ""),
        pdfURLs: ft.filter((u) => /\.pdf($|\?)|\/pdf\b|download/i.test(u)),
        isOA: true,
        language: first(b.journal?.language),
      });
    });
    return { records, query, total: data.total || 0 };
  });

  // --- HAL -----------------------------------------------------------------
  attach("hal", async (o) => {
    const q = Q.compile(o.ast, "hal");
    const fq = [];
    if (o.yearFrom || o.yearTo) fq.push(`publicationDateY_i:[${o.yearFrom || "*"} TO ${o.yearTo || "*"}]`);
    if (o.oaOnly || o.fulltextOnly) fq.push("submitType_s:file");
    const fl = "halId_s,title_s,authFullName_s,publicationDateY_i,producedDate_s,doiId_s,journalTitle_s,conferenceTitle_s,bookTitle_s,abstract_s,volume_s,issue_s,page_s,journalIssn_s,docType_s,uri_s,fileMain_s,openAccess_bool,language_s,keyword_s,publisher_s";
    let url = "https://api.archives-ouvertes.fr/search/?" + U.qs({ q, rows: Math.min(o.limit, 500), wt: "json", fl });
    for (const f of fq) url += "&fq=" + encodeURIComponent(f);
    const data = await U.getJSON(url);
    const records = (data.response?.docs || []).map((d) =>
      R.make("hal", {
        ids: { hal: d.halId_s },
        title: first(d.title_s),
        creators: (d.authFullName_s || []).map((n) => U.parseName(n)),
        date: d.producedDate_s || d.publicationDateY_i,
        year: d.publicationDateY_i,
        doi: d.doiId_s,
        venue: d.journalTitle_s || d.conferenceTitle_s || d.bookTitle_s,
        volume: d.volume_s,
        issue: first(d.issue_s),
        pages: d.page_s,
        issn: d.journalIssn_s,
        publisher: first(d.publisher_s),
        abstract: first(d.abstract_s),
        keywords: d.keyword_s || [],
        itemType: R.mapType(d.docType_s, "document"),
        url: d.uri_s,
        pdfURLs: d.fileMain_s ? [d.fileMain_s] : [],
        isOA: !!d.openAccess_bool || !!d.fileMain_s,
        language: first(d.language_s),
      })
    );
    return { records, query: q + (fq.length ? ` | fq: ${fq.join("; ")}` : ""), total: data.response?.numFound || 0 };
  });

  // --- Zenodo --------------------------------------------------------------
  const ZENODO_TYPES = { article: "journalArticle", conferencepaper: "conferencePaper", preprint: "preprint", report: "report", thesis: "thesis", book: "book", section: "bookSection", workingpaper: "report", technicalnote: "report", deliverable: "report", proposal: "report", other: "document" };
  attach("zenodo", async (o) => {
    const query = withYear(Q.compile(o.ast, "zenodo"), yearClause(o, (a, b) => `publication_date:[${a}-01-01 TO ${b}-12-31]`));
    const url = "https://zenodo.org/api/records?" + U.qs({ q: query, size: Math.min(o.limit, 25), page: 1, type: "publication", sort: "bestmatch" });
    const data = await U.getJSON(url, { headers: { Accept: "application/json" } });
    let records = (data.hits?.hits || []).map((h) => {
      const m = h.metadata || {};
      const files = (h.files || []).filter((f) => /\.pdf$/i.test(f.key || "")).map((f) => f.links?.self);
      return R.make("zenodo", {
        ids: { zenodo: String(h.id) },
        title: m.title,
        creators: (m.creators || []).map((c) => U.parseName(c.name)),
        date: m.publication_date,
        doi: h.doi || m.doi,
        venue: m.journal?.title || m.imprint?.publisher || "Zenodo",
        volume: m.journal?.volume,
        issue: m.journal?.issue,
        pages: m.journal?.pages,
        abstract: m.description,
        keywords: m.keywords || [],
        itemType: ZENODO_TYPES[m.resource_type?.subtype] || "preprint",
        url: h.links?.self_html || h.links?.html,
        pdfURLs: files.filter(Boolean),
        isOA: (m.access_right || "open") === "open",
        language: m.language,
      });
    });
    if (o.oaOnly || o.fulltextOnly) records = records.filter((r) => r.pdfURLs.length);
    return { records, query, total: data.hits?.total ?? records.length };
  });

  // --- OSTI ----------------------------------------------------------------
  attach("osti", async (o) => {
    const q = Q.compile(o.ast, "lucene");
    const params = { q, rows: Math.min(o.limit, 100) };
    if (o.yearFrom) params.publication_date_start = `01/01/${o.yearFrom}`;
    if (o.yearTo) params.publication_date_end = `12/31/${o.yearTo}`;
    if (o.oaOnly || o.fulltextOnly) params.has_fulltext = "true";
    const data = await U.getJSON("https://www.osti.gov/api/v1/records?" + U.qs(params), { headers: { Accept: "application/json" } });
    const list = Array.isArray(data) ? data : data.records || [];
    const typeMap = { "Journal Article": "journalArticle", "Technical Report": "report", Conference: "conferencePaper", Thesis: "thesis", Book: "book", "Thesis/Dissertation": "thesis" };
    const records = list.map((r) => {
      const links = r.links || [];
      const ft = links.filter((l) => l.rel === "fulltext").map((l) => l.href);
      return R.make("osti", {
        ids: { osti: String(r.osti_id || "") },
        title: r.title,
        creators: (r.authors || []).map((a) => U.parseName(String(a).replace(/\s*\[.*?\]\s*/g, ""))),
        date: (r.publication_date || "").slice(0, 10),
        doi: r.doi,
        venue: r.journal_name,
        volume: r.journal_volume,
        issue: r.journal_issue,
        abstract: r.description,
        keywords: String(r.subjects || "").split(/;\s*/).filter(Boolean),
        itemType: typeMap[r.product_type] || "report",
        url: links.find((l) => l.rel === "citation")?.href,
        pdfURLs: ft,
        isOA: ft.length > 0,
        publisher: r.publisher,
      });
    });
    return { records, query: q, total: records.length };
  });

  // --- dblp ----------------------------------------------------------------
  attach("dblp", async (o) => {
    const queries = Q.keywordQueries(o.ast, 3);
    const records = [];
    for (const q of queries) {
      await ZR.Sources.throttle("dblp", 1000);
      const res = await ZR.http("GET", "https://dblp.org/search/publ/api?" + U.qs({ q, format: "json", h: Math.min(o.limit, 200) }), {});
      const data = assertJSONResponse(res, "dblp");
      for (const h of data.result?.hits?.hit || []) {
        const i = h.info || {};
        let authors = i.authors?.author || [];
        if (!Array.isArray(authors)) authors = [authors];
        const year = parseInt(i.year, 10);
        if ((o.yearFrom && year < o.yearFrom) || (o.yearTo && year > o.yearTo)) continue;
        records.push(
          R.make("dblp", {
            title: i.title,
            creators: authors.map((a) => U.parseName(String(a.text || a).replace(/\s\d{4}$/, ""))),
            year,
            doi: i.doi,
            venue: i.venue,
            volume: i.volume,
            issue: i.number,
            pages: i.pages,
            itemType: R.mapType(String(i.type || "").toLowerCase()),
            url: i.ee || i.url,
          })
        );
      }
    }
    return { records, query: queries.map((q) => `[${q}]`).join(" ∪ "), total: records.length };
  });

  // --- CORE ----------------------------------------------------------------
  attach("core", async (o) => {
    let q = Q.compile(o.ast, "core");
    if (o.yearFrom) q = `(${q}) AND yearPublished>=${o.yearFrom}`;
    if (o.yearTo) q = `(${q}) AND yearPublished<=${o.yearTo}`;
    await ZR.Sources.throttle("core", o.key ? 2500 : 6500);
    const headers = o.key ? { Authorization: `Bearer ${o.key}` } : {};
    const data = await U.getJSON("https://api.core.ac.uk/v3/search/works/?" + U.qs({ q, limit: Math.min(o.limit, 100), exclude: "fullText" }), { headers });
    let records = (data.results || []).map((r) =>
      R.make("core", {
        ids: { core: String(r.id) },
        title: r.title,
        creators: (r.authors || []).map((a) => U.parseName(a.name)),
        date: r.publishedDate ? r.publishedDate.slice(0, 10) : r.yearPublished,
        year: r.yearPublished,
        doi: r.doi,
        venue: r.journals?.[0]?.title,
        publisher: r.publisher,
        abstract: r.abstract,
        itemType: R.mapType(r.documentType === "research" ? "article" : r.documentType, "journalArticle"),
        url: (r.links || []).find((l) => l.type === "display")?.url || (r.doi ? `https://doi.org/${r.doi}` : ""),
        pdfURLs: r.downloadUrl ? [r.downloadUrl] : [],
        isOA: !!r.downloadUrl,
        language: r.language?.code,
      })
    );
    if (o.oaOnly || o.fulltextOnly) records = records.filter((r) => r.pdfURLs.length);
    return { records, query: q, total: data.totalHits || 0 };
  });

  // --- Springer Nature -----------------------------------------------------
  attach("springer", async (o) => {
    let q = Q.compile(o.ast, "springer");
    if (o.yearFrom) q += ` AND datefrom:${o.yearFrom}-01-01`;
    if (o.yearTo) q += ` AND dateto:${o.yearTo}-12-31`;
    if (o.oaOnly || o.fulltextOnly) q += " AND openaccess:true";
    const records = [];
    let total = 0;
    for (let s = 1; records.length < o.limit && s < 200; s += 25) {
      await ZR.Sources.throttle("springer", 700);
      const data = await U.getJSON("https://api.springernature.com/meta/v2/json?" + U.qs({ q, api_key: o.key, s, p: Math.min(25, o.limit - records.length) }));
      total = parseInt(data.result?.[0]?.total || "0", 10);
      const recs = data.records || [];
      for (const r of recs) {
        const oa = String(r.openaccess) === "true";
        const pdf = (r.url || []).find((u) => u.format === "pdf")?.value;
        records.push(
          R.make("springer", {
            title: r.title,
            creators: (r.creators || []).map((c) => U.parseName(c.creator)),
            date: r.publicationDate,
            doi: r.doi,
            venue: r.publicationName,
            volume: r.volume,
            issue: r.number,
            pages: pages(r.startingPage, r.endingPage),
            issn: r.issn || r.eIssn,
            isbn: r.isbn || r.electronicIsbn,
            publisher: r.publisher,
            abstract: typeof r.abstract === "object" ? JSON.stringify(r.abstract) : r.abstract,
            keywords: r.keyword || [],
            itemType: /chapter/i.test(r.contentType) ? "bookSection" : /book/i.test(r.contentType) ? "book" : /conference/i.test(r.contentType) ? "conferencePaper" : "journalArticle",
            url: (r.url || []).find((u) => u.format === "html" || u.format === "")?.value,
            pdfURLs: oa && pdf ? [pdf] : [],
            isOA: oa,
            language: r.language,
          })
        );
      }
      if (recs.length < 25) break;
    }
    return { records, query: q, total };
  });

  // --- IEEE Xplore ---------------------------------------------------------
  attach("ieee", async (o) => {
    const querytext = Q.compile(o.ast, "ieee");
    const params = { apikey: o.key, querytext, max_records: Math.min(o.limit, 200), start_record: 1, start_year: o.yearFrom, end_year: o.yearTo, format: "json" };
    if (o.oaOnly || o.fulltextOnly) params.open_access = "True";
    const data = await U.getJSON("https://ieeexploreapi.ieee.org/api/v1/search/articles?" + U.qs(params));
    const records = (data.articles || []).map((a) =>
      R.make("ieee", {
        title: a.title,
        creators: (a.authors?.authors || []).map((x) => U.parseName(x.full_name)),
        date: a.publication_date || a.publication_year,
        year: a.publication_year,
        doi: a.doi,
        venue: a.publication_title,
        volume: a.volume,
        issue: a.issue,
        pages: pages(a.start_page, a.end_page),
        issn: a.issn,
        isbn: a.isbn,
        publisher: a.publisher,
        abstract: a.abstract,
        keywords: [...(a.index_terms?.author_terms?.terms || []), ...(a.index_terms?.ieee_terms?.terms || [])],
        itemType: /conference/i.test(a.content_type) ? "conferencePaper" : /standard/i.test(a.content_type) ? "standard" : /book/i.test(a.content_type) ? "bookSection" : "journalArticle",
        url: a.html_url,
        pdfURLs: a.access_type === "Open Access" && a.pdf_url ? [a.pdf_url] : [],
        isOA: a.access_type === "Open Access",
        citationCount: a.citing_paper_count,
      })
    );
    return { records, query: querytext, total: data.total_records || 0 };
  });

  // --- Web of Science Starter ----------------------------------------------
  attach("wos", async (o) => {
    let q = Q.compile(o.ast, "wos");
    if (o.yearFrom || o.yearTo) q = `(${q}) AND PY=(${o.yearFrom || 1900}-${o.yearTo || new Date().getFullYear()})`;
    await ZR.Sources.throttle("wos", 1100);
    const data = await U.getJSON("https://api.clarivate.com/apis/wos-starter/v1/documents?" + U.qs({ db: "WOS", q, limit: Math.min(o.limit, 50), page: 1 }), { headers: { "X-ApiKey": o.key } });
    const records = (data.hits || []).map((h) => {
      const src = h.source || {};
      const types = (h.types || []).map((t) => t.toLowerCase());
      return R.make("wos", {
        ids: { wos: h.uid },
        title: h.title,
        creators: (h.names?.authors || []).map((a) => U.parseName(a.wosStandard || a.displayName)),
        date: [src.publishYear, src.publishMonth].filter(Boolean).join(" "),
        year: src.publishYear,
        doi: h.identifiers?.doi,
        venue: src.sourceTitle,
        volume: src.volume,
        issue: src.issue,
        pages: src.pages?.range,
        issn: h.identifiers?.issn || h.identifiers?.eissn,
        keywords: h.keywords?.authorKeywords || [],
        itemType: types.some((t) => t.includes("proceeding")) ? "conferencePaper" : types.some((t) => t.includes("book")) ? "bookSection" : "journalArticle",
        url: h.links?.record,
        citationCount: h.citations?.[0]?.count,
      });
    });
    return { records, query: q, total: data.metadata?.total || 0 };
  });

  // --- Elsevier: Scopus & ScienceDirect ------------------------------------
  function elsevierHeaders(o) {
    const h = { "X-ELS-APIKey": o.key, Accept: "application/json" };
    const tok = o.secret("insttoken");
    if (tok) h["X-ELS-Insttoken"] = tok;
    return h;
  }

  attach("scopus", async (o) => {
    let query = Q.compile(o.ast, "scopus");
    if (o.yearFrom) query += ` AND PUBYEAR > ${o.yearFrom - 1}`;
    if (o.yearTo) query += ` AND PUBYEAR < ${o.yearTo + 1}`;
    if (o.oaOnly || o.fulltextOnly) query += " AND OPENACCESS(1)";
    const fetchView = (view) =>
      U.getJSON("https://api.elsevier.com/content/search/scopus?" + U.qs({ query, count: Math.min(o.limit, view === "COMPLETE" ? 25 : 200), start: 0, view }), { headers: elsevierHeaders(o), noRetry: true });
    let data;
    try {
      data = await fetchView("COMPLETE");
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      data = await fetchView("STANDARD"); // no institutional entitlement: first author only, no abstract
    }
    const sr = data["search-results"] || {};
    const entries = (sr.entry || []).filter((e) => !e.error);
    const records = entries.map((e) =>
      R.make("scopus", {
        ids: { scopus: e.eid },
        title: e["dc:title"],
        creators: e.author?.length
          ? e.author.map((a) => (a.surname ? { firstName: a["given-name"] || "", lastName: a.surname } : U.parseName(a.authname)))
          : e["dc:creator"]
            ? [U.parseName(e["dc:creator"].replace(/\s+([A-Z]\.)+$/, (m) => "," + m))]
            : [],
        date: e["prism:coverDate"],
        doi: e["prism:doi"],
        venue: e["prism:publicationName"],
        volume: e["prism:volume"],
        issue: e["prism:issueIdentifier"],
        pages: e["prism:pageRange"],
        issn: e["prism:issn"] || e["prism:eIssn"],
        isbn: first(e["prism:isbn"])?.$,
        abstract: e["dc:description"],
        keywords: e.authkeywords ? String(e.authkeywords).split(/\s*\|\s*/) : [],
        itemType: /conference/i.test(e.subtypeDescription) ? "conferencePaper" : /chapter/i.test(e.subtypeDescription) ? "bookSection" : /book/i.test(e.subtypeDescription) ? "book" : "journalArticle",
        url: (e.link || []).find((l) => l["@ref"] === "scopus")?.["@href"],
        isOA: e.openaccessFlag === true || e.openaccess === "1",
        citationCount: e["citedby-count"] ? parseInt(e["citedby-count"], 10) : null,
      })
    );
    return { records, query, total: parseInt(sr["opensearch:totalResults"] || "0", 10) };
  });

  attach("sciencedirect", async (o) => {
    const qs = Q.compile(o.ast, "sciencedirect");
    const body = { qs, display: { offset: 0, show: Math.min(o.limit, 100), sortBy: "relevance" } };
    if (o.yearFrom || o.yearTo) body.date = `${o.yearFrom || 1823}-${o.yearTo || new Date().getFullYear()}`;
    if (o.oaOnly || o.fulltextOnly) body.filters = { openAccess: true };
    const res = await ZR.http("PUT", "https://api.elsevier.com/content/search/sciencedirect", { headers: elsevierHeaders(o), body, noRetry: true });
    const data = res.json();
    const records = (data.results || []).map((r) =>
      R.make("sciencedirect", {
        ids: { pii: r.pii },
        title: r.title,
        creators: (r.authors || []).map((a) => U.parseName(a.name)),
        date: r.publicationDate,
        doi: r.doi,
        venue: r.sourceTitle,
        volume: String(r.volumeIssue || "").match(/Volume\s+(\S+?),?\s/)?.[1] || "",
        issue: String(r.volumeIssue || "").match(/Issue\s+(\S+?)(,|$)/)?.[1] || "",
        pages: pages(r.pages?.first, r.pages?.last),
        itemType: "journalArticle",
        url: r.uri,
        isOA: !!r.openAccess,
      })
    );
    return { records, query: JSON.stringify({ qs: body.qs, date: body.date, filters: body.filters }), total: data.resultsFound || 0 };
  });
})();

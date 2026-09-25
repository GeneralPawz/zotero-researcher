/* global ZR, Zotero */
// Orchestrates a search run across sources and the subsequent import.
//
// Modes
//   structured – the boolean query is sent as-is; no LLM involved (fully deterministic)
//   llm        – an LLM turns the request into a boolean query (editable), optionally
//                screens results for relevance; the user reviews before importing
//   yolo       – LLM plans, searches all selected sources, screens, and imports the
//                results at/above the score threshold without a review step

ZR.Search = (() => {
  const U = ZR.Util;

  function describeFilters(o) {
    const parts = [];
    if (o.yearFrom || o.yearTo) parts.push(`years ${o.yearFrom || "…"}–${o.yearTo || "…"}`);
    if (o.languages?.length) parts.push("language: " + o.languages.join("/"));
    if (o.types?.length) parts.push("types: " + o.types.join("/"));
    if (o.minCitations > 0) parts.push(`≥ ${o.minCitations} citations`);
    if (o.hasAbstract) parts.push("with abstract");
    if (o.hasDOI) parts.push("with DOI");
    if (o.oaOnly) parts.push("open access only");
    if (o.fulltextOnly) parts.push("full-text PDF required");
    if (o.strict) parts.push("strict boolean match on title/abstract/keywords");
    if (o.skipExisting) parts.push("skip items already in library");
    if (o.screen) parts.push(`LLM screening ≥ ${o.minScore}`);
    parts.push(`≤ ${o.limit} per source`);
    return parts.join("; ");
  }

  /**
   * Deterministic post-filters. Values a source doesn't report (language, citations)
   * never cause removal — only known values that fail a filter do.
   * @returns {{records: object[], removed: object}}
   */
  function applyFilters(recs, o) {
    const removed = { language: 0, type: 0, citations: 0, abstract: 0, doi: 0 };
    const langs = new Set(o.languages || []);
    const types = new Set((o.types || []).flatMap((id) => ZR.Records.TYPE_FILTERS.find((t) => t.id === id)?.types || []));
    const drop = (reason) => {
      removed[reason]++;
      return false;
    };
    const records = recs.filter((r) => {
      if (langs.size && r.language && !langs.has(r.language)) return drop("language");
      if (types.size && !types.has(r.itemType)) return drop("type");
      if (o.minCitations > 0 && r.citationCount != null && r.citationCount < o.minCitations) return drop("citations");
      if (o.hasAbstract && (r.abstract || "").length < 50) return drop("abstract");
      if (o.hasDOI && !r.doi) return drop("doi");
      return true;
    });
    return { records, removed };
  }

  /** Result orderings offered in the results header. */
  const SORTS = {
    relevance: null,
    cited: (a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1),
    newest: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    oldest: (a, b) => (a.year ?? 9999) - (b.year ?? 9999),
    title: (a, b) => a.title.localeCompare(b.title),
  };

  function sortRecords(recs, screened) {
    return recs.sort(
      (a, b) =>
        (screened ? (b.llmScore ?? -1) - (a.llmScore ?? -1) : 0) ||
        b.sources.length - a.sources.length ||
        (b.citationCount ?? 0) - (a.citationCount ?? 0) ||
        (b.year ?? 0) - (a.year ?? 0) ||
        a.title.localeCompare(b.title)
    );
  }

  /**
   * @param {object} o  {mode, query, request, sources[], limit, yearFrom, yearTo, oaOnly,
   *                     fulltextOnly, strict, screen, minScore, llmProfile, libraryID}
   * @param {(msg:string)=>void} status
   */
  async function run(o, status = () => {}) {
    const runInfo = {
      started: new Date().toISOString().replace("T", " ").slice(0, 19),
      mode: o.mode,
      request: o.request || "",
      llmProfile: o.llmProfile ? `${o.llmProfile.name} · ${o.llmProfile.model}` : "",
      perSource: {},
    };

    if ((o.mode === "llm" || o.mode === "yolo") && !o.query) {
      if (!o.request) throw new Error("Enter a research request for the LLM");
      status("Asking the LLM to plan a boolean query…");
      const plan = await ZR.Assist.planQuery(o.llmProfile, o.request);
      o.query = plan.query;
      if (!o.yearFrom && plan.yearFrom) o.yearFrom = plan.yearFrom;
      if (!o.yearTo && plan.yearTo) o.yearTo = plan.yearTo;
      runInfo.plan = plan;
    }
    const ast = ZR.Query.parse(o.query);
    if (!ast) throw new Error("The query is empty");
    runInfo.query = ZR.Query.toCanonical(ast);
    runInfo.filtersText = describeFilters(o);

    const email = ZR.Prefs.get("email", "");
    status(`Searching ${o.sources.length} source(s)…`);
    const results = await U.mapLimit(o.sources, 4, async (id) => {
      const src = ZR.Sources.get(id);
      const stat = (runInfo.perSource[id] = { count: 0, query: "", error: "" });
      const why = ZR.Sources.unavailableReason(id);
      if (why) {
        stat.error = why;
        return [];
      }
      const t0 = Date.now();
      try {
        const out = await withDeadline(src.search({
          ast,
          limit: o.limit,
          yearFrom: o.yearFrom,
          yearTo: o.yearTo,
          oaOnly: o.oaOnly,
          fulltextOnly: o.fulltextOnly,
          languages: o.languages,
          types: o.types,
          minCitations: o.minCitations,
          key: ZR.Sources.keyFor(id),
          secret: (sid) => ZR.Sources.secretFor(id, sid),
          email,
        }), o.sourceTimeout || SOURCE_TIMEOUT);
        stat.ms = Date.now() - t0;
        stat.count = out.records.length;
        stat.total = out.total;
        stat.query = out.query;
        status(`${src.name}: ${out.records.length} result(s)`);
        return out.records;
      } catch (e) {
        stat.ms = Date.now() - t0;
        stat.error = e.message || String(e);
        U.log(`Source ${id} failed`, stat.error);
        status(`${src.name}: ${stat.error}`);
        return [];
      }
    });

    const all = results.flat();
    runInfo.identified = all.length;
    let recs = ZR.Records.dedupe(all);
    runInfo.deduped = recs.length;

    if (o.strict) recs = recs.filter((r) => ZR.Query.matches(ast, r));
    const filtered = applyFilters(recs, o);
    recs = filtered.records;
    runInfo.removedByFilters = filtered.removed;
    if (o.oaOnly || o.fulltextOnly) recs = recs.filter(ZR.Records.hasFullText);

    if (o.libraryID != null && typeof Zotero !== "undefined") {
      status("Checking which results are already in your library…");
      await U.mapLimit(recs, 6, async (r) => {
        const hit = await ZR.Importer.findExisting(o.libraryID, r);
        r.existingItemID = hit ? hit.id : null;
      });
      runInfo.inLibraryCount = recs.filter((r) => r.existingItemID).length;
      if (o.skipExisting) recs = recs.filter((r) => !r.existingItemID);
      // Remembered decisions (tags on items + ledger) and "seen in an earlier search"
      await ZR.Store.annotateRecords(o.libraryID, recs);
      if (o.hideExcluded) recs = recs.filter((r) => !isExcluded(r));
    }

    if (o.screen && o.llmProfile && recs.length) {
      const req = o.request || runInfo.query;
      await ZR.Assist.screen(o.llmProfile, req, recs, { onProgress: (d, n) => status(`LLM screening ${d}/${n}…`) });
    }
    sortRecords(recs, !!o.screen);
    for (const r of recs) r.selected = !r.existingItemID && !isExcluded(r) && (!o.screen || (r.llmScore ?? 0) >= o.minScore);
    runInfo.eligible = recs.filter((r) => r.selected).length;
    runInfo.records = recs;
    if (typeof Zotero !== "undefined") ZR.Store.markSeen(recs).catch((e) => U.log("markSeen failed", e.message));
    status(`${recs.length} unique result(s) after de-duplication and filters`);
    return runInfo;
  }

  // One slow or hanging database must not hold up the whole search.
  const SOURCE_TIMEOUT = 45000;
  function withDeadline(promise, ms) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s — skipped`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  const isExcluded = (r) => (r.prior?.ft?.d || r.prior?.ta?.d) === "exclude";

  /**
   * Import selected records into a collection.
   * @param {object} runInfo  from run()
   * @param {object[]} records
   * @param {{libraryID, collectionID, attachPDFs, fulltextOnly, tags, protocolNote}} o
   */
  async function importRecords(runInfo, records, o, status = () => {}) {
    const stats = { imported: 0, existing: 0, withPDF: 0, droppedNoPDF: 0, failed: 0, items: [] };
    const tags = o.tags || [];
    let done = 0;
    await U.mapLimit(records, 3, async (rec) => {
      try {
        const { item, existing } = await ZR.Importer.importRecord(rec, {
          libraryID: o.libraryID,
          collectionID: o.collectionID,
          tags,
          skipExisting: true,
        });
        rec.existingItemID = item.id;
        if (existing) {
          stats.existing++;
        } else {
          stats.imported++;
          stats.items.push(item);
          if (o.attachPDFs || o.fulltextOnly) {
            status(`Finding PDF: ${U.truncate(rec.title, 60)}`);
            const att = await ZR.Importer.attachFullText(item, rec);
            if (att) stats.withPDF++;
            else if (o.fulltextOnly) {
              await item.eraseTx();
              stats.imported--;
              stats.items.splice(stats.items.indexOf(item), 1);
              rec.existingItemID = null;
              stats.droppedNoPDF++;
            }
          }
        }
      } catch (e) {
        stats.failed++;
        U.log("Import failed", rec.title, e.message);
      }
      done++;
      status(`Imported ${done}/${records.length}`);
    });
    Object.assign(runInfo, { imported: stats.imported, existing: stats.existing, withPDF: stats.withPDF });
    if (o.protocolNote) {
      await ZR.Importer.createNote(ZR.Importer.protocolHTML(runInfo), { libraryID: o.libraryID, collectionID: o.collectionID });
    }
    return stats;
  }

  /** Deterministic "related papers" via OpenAlex: references + related works of seed DOIs. */
  async function related(items, { limit = 50 } = {}) {
    const email = ZR.Prefs.get("email", "");
    const key = ZR.Sources.keyFor("openalex");
    const ids = new Map();
    for (const item of items) {
      const doi = U.cleanDOI(item.getField("DOI") || item.getField("extra") || item.getField("url"));
      if (!doi) continue;
      try {
        const w = await U.getJSON(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?` + U.qs({ select: "id,referenced_works,related_works", api_key: key, mailto: key ? "" : email }));
        for (const r of [...(w.referenced_works || []), ...(w.related_works || [])]) ids.set(r, (ids.get(r) || 0) + 1);
      } catch (e) {
        U.log("OpenAlex seed lookup failed", doi, e.message);
      }
    }
    // Prefer works connected to several seeds.
    const ranked = [...ids.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id.replace("https://openalex.org/", ""));
    const records = [];
    for (let i = 0; i < ranked.length; i += 50) {
      const batch = ranked.slice(i, i + 50);
      const data = await U.getJSON("https://api.openalex.org/works?" + U.qs({ filter: `openalex:${batch.join("|")}`, per_page: 50, api_key: key, mailto: key ? "" : email }));
      records.push(...(data.results || []).map(ZR.Sources.get("openalex").mapWork));
    }
    return records;
  }

  return { run, importRecords, related, describeFilters, sortRecords, applyFilters, SORTS };
})();

/* global ZR, Zotero, IOUtils, PathUtils */
// Persistent research projects.
//
// A project is bound to a Zotero collection and remembers its search settings and
// search history. Two kinds:
//   quick  – "get me papers on X": search settings + history; results go straight into
//            the collection.
//   review – a methodology-based pipeline (PRISMA, scoping, Kitchenham, …) with a
//            protocol and a funnel. Search results first enter a *candidate pool*
//            outside Zotero; only papers that pass title/abstract screening are added
//            to the collection. A quick project can be converted into a review.
//
// Storage: project settings live in the library's ledger note (synced, shared in
// groups, survive uninstalling). The candidate pool and per-paper model outputs
// (System 1 scores, AI suggestions, quality answers, extracted data) live in a local
// file per project, since they can be large: <data dir>/zotero-researcher/projects/.
// Screening decisions themselves are always stored in the library (tags + ledger).

ZR.Projects = (() => {
  const U = ZR.Util;
  const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");
  const newID = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ------------------------------------------------------------- settings ----
  async function ledger(libraryID) {
    const l = await ZR.Store.load(libraryID);
    l.projects = l.projects || {};
    await migrateReviews(libraryID, l);
    return l;
  }

  /** Reviews created before projects existed become PRISMA review projects. */
  async function migrateReviews(libraryID, l) {
    for (const [collectionKey, r] of Object.entries(l.reviews || {})) {
      if (Object.values(l.projects).some((p) => p.collectionKey === collectionKey)) continue;
      const col = Zotero.Collections.getByLibraryAndKey?.(libraryID, collectionKey);
      const split = (s) => String(s || "").split(/\n|;\s*/).map((x) => x.trim()).filter(Boolean);
      const protocol = ZR.Methodologies.normalizeProtocol("prisma2020", {
        title: col?.name || "",
        objective: r.question,
        questions: r.question ? [r.question] : [],
        inclusion: split(r.include),
        exclusion: split(r.exclude),
        reasons: r.reasons,
      });
      const id = newID();
      l.projects[id] = { id, name: col?.name || "Review", kind: "review", methodology: "prisma2020", protocol, collectionKey, created: r.created || now(), updated: now(), search: {}, runs: r.runs || [], funnel: defaultFunnel() };
      ZR.Store.scheduleSave?.(libraryID);
    }
  }

  const defaultFunnel = () => ({ excludeBelow: 0.15, includeAbove: 0.85 });

  async function list(libraryID) {
    const l = await ledger(libraryID);
    return Object.values(l.projects).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  async function get(libraryID, id) {
    return (await ledger(libraryID)).projects[id] || null;
  }

  async function byCollection(libraryID, collectionKey) {
    if (!collectionKey) return null;
    return (await list(libraryID)).find((p) => p.collectionKey === collectionKey) || null;
  }

  async function save(libraryID, project) {
    const l = await ledger(libraryID);
    project.updated = now();
    l.projects[project.id] = project;
    await ZR.Store.flush(libraryID);
    return project;
  }

  /**
   * @param {{name, kind: "quick"|"review", collectionKey, methodology?, protocol?, search?}} o
   */
  async function create(libraryID, o) {
    const project = {
      id: newID(),
      name: o.name || "Untitled project",
      kind: o.kind === "review" ? "review" : "quick",
      collectionKey: o.collectionKey || null,
      methodology: o.kind === "review" ? o.methodology || "prisma2020" : null,
      protocol: o.kind === "review" ? o.protocol || ZR.Methodologies.emptyProtocol(o.methodology || "prisma2020") : null,
      search: o.search || {},
      runs: [],
      funnel: defaultFunnel(),
      created: now(),
      updated: now(),
    };
    return save(libraryID, project);
  }

  /** Quick → review: keep search settings and history, add methodology + protocol. */
  async function convert(libraryID, id, methodology, protocol) {
    const p = await get(libraryID, id);
    if (!p) throw new Error("Project not found");
    p.kind = "review";
    p.methodology = methodology;
    p.protocol = ZR.Methodologies.normalizeProtocol(methodology, Object.assign({ query: p.search?.query }, protocol || {}));
    p.funnel = p.funnel || defaultFunnel();
    return save(libraryID, p);
  }

  async function remove(libraryID, id) {
    const l = await ledger(libraryID);
    delete l.projects[id];
    await ZR.Store.flush(libraryID);
    await IOUtils.remove(poolPath(libraryID, id), { ignoreAbsent: true }).catch(() => {});
  }

  /** Remember the settings of the last search on the project. */
  async function rememberSearch(libraryID, id, search) {
    const p = await get(libraryID, id);
    if (!p) return;
    p.search = Object.assign({}, p.search, search);
    await save(libraryID, p);
  }

  async function addRun(libraryID, id, run) {
    const p = await get(libraryID, id);
    if (!p) return;
    p.runs = p.runs || [];
    p.runs.push(run);
    await save(libraryID, p);
  }

  // ------------------------------------------------------ candidate pool ----
  const pools = new Map(); // `${libraryID}/${id}` -> pool
  const poolPath = (libraryID, id) => PathUtils.join(Zotero.DataDirectory.dir, "zotero-researcher", "projects", `L${libraryID}-${id}.json`);
  const emptyPool = () => ({ records: {}, s1: {}, llm: {}, qa: {}, extract: {}, dups: {} });

  async function loadPool(libraryID, id) {
    const k = `${libraryID}/${id}`;
    if (pools.has(k)) return pools.get(k);
    let pool = emptyPool();
    try {
      pool = Object.assign(emptyPool(), JSON.parse(await IOUtils.readUTF8(poolPath(libraryID, id))));
    } catch (e) {
      /* new project */
    }
    pools.set(k, pool);
    return pool;
  }

  async function savePool(libraryID, id) {
    const pool = await loadPool(libraryID, id);
    const path = poolPath(libraryID, id);
    await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeUTF8(path, JSON.stringify(pool), { tmpPath: path + ".tmp" });
  }

  /** Slim copy of a search record for the pool (keeps what screening and import need). */
  function poolRecord(r) {
    const keep = ["sources", "ids", "title", "creators", "date", "year", "venue", "volume", "issue", "pages", "issn", "isbn", "publisher", "keywords", "itemType", "url", "pdfURLs", "isOA", "language", "citationCount", "doi"];
    const out = {};
    for (const k of keep) out[k] = r[k];
    out.abstract = U.truncate(r.abstract || "", 4000);
    out.creators = (r.creators || []).slice(0, 30);
    out.keywords = (r.keywords || []).slice(0, 20);
    return out;
  }

  /** Add search results to a review's pool. Returns {added, known}. */
  async function addToPool(libraryID, id, records) {
    const pool = await loadPool(libraryID, id);
    let added = 0;
    let known = 0;
    for (const r of records) {
      const key = r.key || ZR.Store.keyForRecord(r);
      if (!key) continue;
      if (pool.records[key]) {
        known++;
        continue;
      }
      pool.records[key] = poolRecord(r);
      added++;
    }
    await savePool(libraryID, id);
    return { added, known };
  }

  /**
   * Every paper in a review: pool records plus items in the project's collection.
   * A paper that was added to Zotero appears once, as the item.
   * @returns {Promise<object[]>} candidates {key, title, abstract, year, venue, authors, doi, itemID, record, ta, ft, reason, by, s1, llm, qa, extract}
   */
  async function candidates(libraryID, project) {
    const pool = await loadPool(libraryID, project.id);
    const out = new Map();
    const col = project.collectionKey ? Zotero.Collections.getByLibraryAndKey(libraryID, project.collectionKey) : null;
    for (const item of col ? col.getChildItems(false).filter((i) => i.isRegularItem()) : []) {
      const key = ZR.Store.keyForItem(item);
      if (!key || out.has(key)) continue;
      const prior = await ZR.Store.prior(libraryID, { key, item });
      out.set(key, {
        key,
        itemID: item.id,
        title: item.getField("title"),
        abstract: item.getField("abstractNote"),
        year: U.yearOf(item.getField("date")),
        venue: item.getField("publicationTitle") || item.getField("proceedingsTitle") || "",
        authors: item.getCreators().map((c) => c.lastName).filter(Boolean).slice(0, 4).join(", "),
        doi: item.getField("DOI"),
        itemType: Zotero.ItemTypes.getName(item.itemTypeID),
        hasPDF: ZR.Prisma.itemHasPDF(item),
        ta: prior?.ta?.d || null,
        ft: prior?.ft?.d || null,
        reason: prior?.ft?.r || prior?.ta?.r || "",
        by: (prior?.ft || prior?.ta)?.by || "",
      });
    }
    for (const [key, r] of Object.entries(pool.records)) {
      if (out.has(key)) continue;
      const prior = await ZR.Store.prior(libraryID, { key });
      out.set(key, {
        key,
        itemID: null,
        record: r,
        title: r.title,
        abstract: r.abstract,
        year: r.year,
        venue: r.venue,
        authors: (r.creators || []).map((c) => c.lastName || c.name).filter(Boolean).slice(0, 4).join(", "),
        doi: r.doi,
        itemType: r.itemType,
        hasPDF: false,
        ta: prior?.ta?.d || null,
        ft: prior?.ft?.d || null,
        reason: prior?.ft?.r || prior?.ta?.r || "",
        by: (prior?.ft || prior?.ta)?.by || "",
      });
    }
    for (const c of out.values()) {
      c.s1 = pool.s1[c.key] || null;
      c.llm = pool.llm[c.key] || null;
      c.qa = pool.qa[c.key] || null;
      c.extract = pool.extract[c.key] || null;
      c.dup = pool.dups[c.key] || null; // {of: key of the paper it duplicates, sim}
    }
    return [...out.values()];
  }

  /** Which candidates belong to a stage of the methodology's funnel. */
  function inStage(project, stage, c) {
    const m = ZR.Methodologies.get(project.methodology);
    const hasFT = m?.stages.includes("fulltext");
    const included = hasFT ? c.ft === "include" : c.ta === "include";
    switch (stage) {
      case "screen":
        return true;
      case "fulltext":
        return c.ta === "include";
      case "quality":
      case "extract":
      case "classify":
        return included;
      default:
        return false;
    }
  }

  /** Funnel counts for the header bar. */
  function funnel(project, cands) {
    const m = ZR.Methodologies.get(project.methodology);
    const identified = (project.runs || []).reduce((n, r) => n + (r.identified || 0), 0);
    const stages = [{ id: "search", label: "Found", n: Math.max(identified, cands.length) }, { id: "screen", label: "In pool", n: cands.length }];
    stages.push({ id: "screen", label: "Passed screening", n: cands.filter((c) => c.ta === "include").length });
    if (m.stages.includes("fulltext")) stages.push({ id: "fulltext", label: "Passed full text", n: cands.filter((c) => c.ft === "include").length });
    return stages;
  }

  // Per-paper model outputs in the pool file
  async function setScores(libraryID, id, field, map) {
    const pool = await loadPool(libraryID, id);
    Object.assign(pool[field], map);
    await savePool(libraryID, id);
  }

  /** Bring a pool record into Zotero (on inclusion). Returns the item. */
  async function importCandidate(libraryID, project, c, tags = []) {
    if (c.itemID) return Zotero.Items.get(c.itemID);
    const col = Zotero.Collections.getByLibraryAndKey(libraryID, project.collectionKey);
    const rec = Object.assign({ abstract: "", keywords: [], pdfURLs: [], ids: {}, creators: [], sources: [] }, c.record);
    const { item } = await ZR.Importer.importRecord(rec, { libraryID, collectionID: col?.id, tags, skipExisting: true });
    c.itemID = item.id;
    return item;
  }

  function _reset() {
    pools.clear();
  }

  return {
    list,
    get,
    byCollection,
    create,
    save,
    convert,
    remove,
    rememberSearch,
    addRun,
    loadPool,
    savePool,
    addToPool,
    candidates,
    inStage,
    funnel,
    setScores,
    importCandidate,
    poolRecord,
    defaultFunnel,
    _reset,
  };
})();

/* global ZR, Zotero, IOUtils, PathUtils */
// Persistent research projects.
//
// A project is bound to a Zotero collection and remembers its search settings and
// search history. Two kinds:
//   quick  - "get me papers on X": search settings + history; results go straight into
//            the collection.
//   review - a methodology-based pipeline (PRISMA, scoping, Kitchenham, …) with a
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

  /** The most recently used project on a collection (several may share one). */
  async function byCollection(libraryID, collectionKey) {
    if (!collectionKey) return null;
    return (await list(libraryID)).find((p) => p.collectionKey === collectionKey) || null;
  }

  /**
   * Where a project's decisions are kept. Normally its collection; a project that shares
   * its collection with another one keeps its own (so the same paper can be included in
   * one and excluded in the other).
   */
  const reviewKey = (p) => p?.decisionKey || p?.collectionKey || null;

  /** Tag name part from a project name: "BIM in der Bauausführung" → "BIM-in-der-Bauausführung". */
  function slug(name) {
    return (
      String(name || "")
        .normalize("NFC")
        .replace(/[#/\\,;"']+/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60) || "project"
    );
  }

  /**
   * The Zotero tag of a project's papers: #review/<name> for reviews, #project/<name> for
   * quick searches (nested tags, shown as a tree in Zotero's tag pane). Fixed at first use,
   * so it stays when the project is renamed; unique in the library.
   */
  function tagFor(project, others = []) {
    if (project.tag) return project.tag;
    const base = `#${project.kind === "review" ? "review" : "project"}/${slug(project.name)}`;
    let tag = base;
    for (let n = 2; others.some((o) => o.id !== project.id && o.tag === tag); n++) tag = `${base}-${n}`;
    return tag;
  }

  /** The project's tag, stored with the project on first use. */
  async function ensureTag(libraryID, project) {
    if (!project.tag) {
      project.tag = tagFor(project, await list(libraryID));
      await save(libraryID, project);
    }
    return project.tag;
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
   * A collection that already belongs to a project can be used again: the new project
   * then keeps its decisions under its own key.
   */
  async function create(libraryID, o) {
    const id = newID();
    const others = await list(libraryID);
    const shared = !!o.collectionKey && others.some((p) => p.collectionKey === o.collectionKey);
    const project = {
      id,
      ...(shared ? { decisionKey: "p:" + id } : {}),
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
    project.tag = tagFor(project, others);
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
    pools.delete(`${libraryID}/${id}`);
    await IOUtils.remove(poolPath(libraryID, id), { ignoreAbsent: true }).catch(() => {});
  }

  /** Remember the settings of the last search on the project. */
  async function rememberSearch(libraryID, id, search) {
    const p = await get(libraryID, id);
    if (!p) return;
    p.search = Object.assign({}, p.search, search);
    await save(libraryID, p);
  }

  /**
   * Databases that did not deliver every hit in a logged search, not yet fetched later
   * or set aside: [{runID, source, fetched, total, reason, pos, retryAt, retryHint, error}]
   */
  function incomplete(project) {
    const out = [];
    for (const run of project?.runs || []) {
      for (const [source, s] of Object.entries(run.perSource || {})) {
        if (!s.reason || s.done || s.dismissed) continue;
        const fetched = s.pos?.offset ?? (s.pos?.branches ? s.pos.branches.reduce((n, b) => n + (b?.offset || 0), 0) : s.count || 0);
        out.push({ runID: run.id, source, fetched, total: s.total || 0, reason: s.reason, pos: s.pos || null, retryAt: s.retryAt || null, retryHint: s.retryHint || "", error: s.error || s.note || "" });
      }
    }
    return out;
  }

  /** Change the completeness entry of databases in a logged search (done by a later search, dismissed). */
  async function markSources(libraryID, projectID, runID, sources, patch) {
    const p = await get(libraryID, projectID);
    const run = p?.runs?.find((r) => r.id === runID);
    if (!run) return null;
    for (const id of sources) if (run.perSource?.[id]) Object.assign(run.perSource[id], patch);
    return save(libraryID, p);
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
  const emptyPool = () => ({ records: {}, s1: {}, llm: {}, qa: {}, extract: {}, dups: {}, notes: {} });

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

  /** Add search results to a review's pool. Returns {added, known, knownKeys}. */
  async function addToPool(libraryID, id, records) {
    const pool = await loadPool(libraryID, id);
    let added = 0;
    let known = 0;
    const knownKeys = new Set();
    for (const r of records) {
      const key = r.key || ZR.Store.keyForRecord(r);
      if (!key) continue;
      if (pool.records[key]) {
        known++;
        knownKeys.add(key);
        continue;
      }
      pool.records[key] = poolRecord(r);
      added++;
    }
    await savePool(libraryID, id);
    return { added, known, knownKeys };
  }

  // ----------------------------------------------------------- audit trail ----
  /** Slim copy of a record for a search's audit list (enough to show it and export it). */
  function auditRow(r, fate, stage, reason) {
    return {
      key: r.key || ZR.Store.keyForRecord(r),
      title: r.title,
      creators: (r.creators || []).slice(0, 3),
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      url: r.url,
      sources: r.sources,
      abstract: U.truncate(r.abstract || "", 600),
      fate, // "pool" | "known" | "removed" | "unselected"
      stage, // where it was decided: dedupe, strict, filter, library, excluded, pool, selection
      reason,
    };
  }

  /** Store what happened to every record of a search (in the local pool file). */
  async function saveRunAudit(libraryID, id, runID, rows) {
    const pool = await loadPool(libraryID, id);
    pool.audit = pool.audit || {};
    pool.audit[runID] = rows;
    await savePool(libraryID, id);
  }

  async function runAudit(libraryID, id) {
    return (await loadPool(libraryID, id)).audit || {};
  }

  /**
   * Version labels for a project's searches: new searches are #1, #2, …; refinements of
   * a search are #2.1, #2.2 (and #2.1.1 …). Older runs without an id get one here.
   * @returns {Map<string, string>} run id → label
   */
  function runLabels(runs) {
    runs.forEach((r, i) => (r.id = r.id || `legacy${i}`));
    const labels = new Map();
    const children = new Map();
    let top = 0;
    for (const r of runs) {
      const parent = r.parent && labels.get(r.parent);
      if (parent) {
        const n = (children.get(r.parent) || 0) + 1;
        children.set(r.parent, n);
        labels.set(r.id, `${parent}.${n}`);
      } else labels.set(r.id, `#${++top}`);
    }
    return labels;
  }

  /** Runs in display order: each search followed by its refinements. */
  function runTree(runs) {
    const labels = runLabels(runs);
    return runs
      .map((r) => ({ run: r, label: labels.get(r.id), depth: labels.get(r.id).split(".").length - 1 }))
      .sort((a, b) => {
        const pa = a.label.slice(1).split(".").map(Number);
        const pb = b.label.slice(1).split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) - (pb[i] ?? -1);
        return 0;
      });
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
      const prior = await ZR.Store.prior(libraryID, { key, item, collectionKey: reviewKey(project) });
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
        language: item.getField("language"),
        hasPDF: ZR.Prisma.itemHasPDF(item),
        ta: prior?.ta?.d || null,
        ft: prior?.ft?.d || null,
        reason: prior?.ft?.r || prior?.ta?.r || "",
        by: (prior?.ft || prior?.ta)?.by || "",
        taInfo: prior?.ta || null,
        ftInfo: prior?.ft || null,
      });
    }
    for (const [key, r] of Object.entries(pool.records)) {
      if (out.has(key)) continue;
      const prior = await ZR.Store.prior(libraryID, { key, collectionKey: reviewKey(project) });
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
        language: r.language,
        hasPDF: false,
        ta: prior?.ta?.d || null,
        ft: prior?.ft?.d || null,
        reason: prior?.ft?.r || prior?.ta?.r || "",
        by: (prior?.ft || prior?.ta)?.by || "",
        taInfo: prior?.ta || null,
        ftInfo: prior?.ft || null,
      });
    }
    for (const c of out.values()) {
      c.s1 = pool.s1[c.key] || null;
      c.llm = pool.llm[c.key] || null;
      c.qa = pool.qa[c.key] || null;
      c.extract = pool.extract[c.key] || null;
      c.dup = pool.dups[c.key] || null; // {of: key of the paper it duplicates, sim}
      c.highlights = (pool.notes || {})[c.key] || []; // your marks in the abstract
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
    // a paper that is already in Zotero is reused (added to the collection, tagged), not duplicated
    const { item } = await ZR.Importer.importRecord(rec, { libraryID, collectionID: col?.id, tags: [...tags, ...(ZR.Prefs.get("projectTags", true) ? [await ensureTag(libraryID, project)] : [])], skipExisting: true, tagExisting: true });
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
    incomplete,
    markSources,
    reviewKey,
    slug,
    tagFor,
    ensureTag,
    create,
    save,
    convert,
    remove,
    rememberSearch,
    addRun,
    loadPool,
    savePool,
    addToPool,
    auditRow,
    saveRunAudit,
    runAudit,
    runLabels,
    runTree,
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

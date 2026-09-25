/* global ZR, Zotero, IOUtils, PathUtils */
// Durable plugin memory that lives in the Zotero library itself, so it syncs (group
// libraries share it) and survives uninstalling/reinstalling the plugin:
//
//  • Tags on items — the source of truth for screening decisions on library items:
//      zr:include / zr:exclude / zr:maybe        title/abstract screening
//      zr:ft:include / zr:ft:exclude             full-text screening
//      zr:why:<reason>                           exclusion reason
//      zr:unscreened                             added to a review, not yet screened
//  • A "ledger" note per library (tag zr:ledger, JSON in <pre>, sharded across notes if
//    large) for data with no item to hang on: decisions on papers never imported,
//    PRISMA review setups and search runs, LLM suggestions, citation directions.
//  • A local cache file (<Zotero data dir>/zotero-researcher/cache.json) for bulky,
//    non-essential data: which search results were seen before.

ZR.Store = (() => {
  const U = ZR.Util;

  const TAG = {
    include: "zr:include",
    exclude: "zr:exclude",
    maybe: "zr:maybe",
    ftInclude: "zr:ft:include",
    ftExclude: "zr:ft:exclude",
    unscreened: "zr:unscreened",
    why: "zr:why:",
    ledger: "zr:ledger",
  };
  const STAGE_TAGS = {
    ta: { include: TAG.include, exclude: TAG.exclude, maybe: TAG.maybe },
    ft: { include: TAG.ftInclude, exclude: TAG.ftExclude },
  };
  const LEDGER_TITLE = "Zotero Researcher — data ledger";
  const SHARD_CHARS = 120000; // Zotero notes sync up to ~250k chars; stay well below
  const today = () => new Date().toISOString().slice(0, 10);

  // ------------------------------------------------------------ pure helpers ----
  function emptyLedger() {
    return { v: 1, decisions: {}, projects: {}, reviews: {}, llm: {}, cites: {} };
  }

  /** Stable identity of a paper across sources and sessions. */
  function keyForRecord(r) {
    const doi = U.cleanDOI(r.doi || r.DOI || "");
    if (doi) return "doi:" + doi;
    const arxiv = r.ids?.arxiv || r.arxiv;
    if (arxiv) return "arxiv:" + String(arxiv).toLowerCase().replace(/v\d+$/, "");
    const t = U.normalizeTitle(r.title).slice(0, 100);
    return t ? "t:" + t : "";
  }

  const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unescapeText = (s) =>
    s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");

  /** Ledger → one or more note HTML bodies. */
  function serialize(ledger) {
    const json = JSON.stringify(ledger);
    const parts = [];
    for (let i = 0; i < json.length || i === 0; i += SHARD_CHARS) parts.push(json.slice(i, i + SHARD_CHARS));
    return parts.map(
      (chunk, i) =>
        `<h1>${LEDGER_TITLE}</h1>` +
        `<p>Screening decisions, PRISMA reviews and citation links stored by the Zotero Researcher plugin. ` +
        `This note is kept (and synced) if the plugin is removed, so a reinstall picks up where you left off. Please don't edit it.</p>` +
        `<p>Part ${i + 1} of ${parts.length} · updated ${today()}</p>` +
        `<pre>${escapeText(chunk)}</pre>`
    );
  }

  /** Note HTML bodies (any order) → ledger. */
  function parse(htmls) {
    const parts = htmls
      .map((h) => {
        const n = parseInt(String(h).match(/Part (\d+) of \d+/)?.[1] || "1", 10);
        const pre = String(h).match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        return { n, text: pre ? unescapeText(pre[1]) : "" };
      })
      .sort((a, b) => a.n - b.n);
    const json = parts.map((p) => p.text).join("");
    if (!json.trim()) return emptyLedger();
    try {
      return Object.assign(emptyLedger(), JSON.parse(json));
    } catch (e) {
      U.log("Ledger JSON unreadable, starting fresh", e.message);
      return emptyLedger();
    }
  }

  function describe(prior) {
    if (!prior) return "";
    const s = prior.ft || prior.ta;
    if (!s) return "";
    const label = { include: "Included", exclude: "Excluded", maybe: "Marked maybe" }[s.d] || s.d;
    return `${label}${prior.ft ? " (full text)" : ""}${s.at ? " " + s.at : ""}${s.r ? " — " + s.r : ""}${s.by === "llm" ? " · by AI" : s.by === "s1" ? " · by System 1" : s.by === "dup" ? " · duplicate check" : ""}`;
  }

  // ---------------------------------------------------------- ledger storage ----
  const libs = new Map(); // libraryID -> {ledger, notes, timer, loading}

  async function findLedgerNotes(libraryID) {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "is", "note");
    s.addCondition("tag", "is", TAG.ledger);
    s.addCondition("deleted", "false");
    const ids = await s.search();
    return (await Zotero.Items.getAsync(ids)).filter(Boolean);
  }

  async function load(libraryID) {
    let st = libs.get(libraryID);
    if (st?.ledger) return st.ledger;
    if (st?.loading) return st.loading;
    st = st || {};
    libs.set(libraryID, st);
    st.loading = (async () => {
      st.notes = await findLedgerNotes(libraryID);
      st.ledger = parse(st.notes.map((n) => n.getNote()));
      st.loading = null;
      return st.ledger;
    })();
    return st.loading;
  }

  function scheduleSave(libraryID) {
    const st = libs.get(libraryID);
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => flush(libraryID).catch((e) => Zotero.logError(e)), 800);
  }

  /** Write the ledger. Saves are chained per library so concurrent callers never race. */
  function flush(libraryID) {
    const st = libs.get(libraryID);
    if (!st?.ledger) return Promise.resolve();
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.saving = (st.saving || Promise.resolve()).catch(() => {}).then(() => writeLedger(libraryID, st));
    return st.saving;
  }

  async function writeLedger(libraryID, st) {
    const library = Zotero.Libraries.get(libraryID);
    if (!library?.editable) return;
    const bodies = serialize(st.ledger);
    st.notes = st.notes || [];
    for (let i = 0; i < bodies.length; i++) {
      let note = st.notes[i];
      if (!note || note.deleted) {
        note = new Zotero.Item("note");
        note.libraryID = libraryID;
        note.addTag(TAG.ledger);
        st.notes[i] = note;
      }
      if (note.getNote() !== bodies[i]) {
        note.setNote(bodies[i]);
        await note.saveTx({ skipSelect: true, skipNotifier: false });
      }
    }
    // Drop surplus shards (ledger shrank)
    for (const extra of st.notes.splice(bodies.length)) await extra.eraseTx();
  }

  async function flushAll() {
    for (const id of libs.keys()) await flush(id);
  }

  // ------------------------------------------------------------- decisions ----
  function tagsOf(item) {
    return new Set(item.getTags().map((t) => t.tag));
  }

  /** Screening state stored as tags on a library item. */
  function decisionFromItem(item) {
    if (!item?.isRegularItem?.()) return null;
    const tags = tagsOf(item);
    const reason = [...tags].find((t) => t.startsWith(TAG.why))?.slice(TAG.why.length) || "";
    const out = {};
    for (const [stage, map] of Object.entries(STAGE_TAGS)) {
      for (const [d, tag] of Object.entries(map)) if (tags.has(tag)) out[stage] = { d, r: d === "exclude" ? reason : "" };
    }
    if (tags.has(TAG.unscreened) && !out.ta) out.unscreened = true;
    return Object.keys(out).length ? out : null;
  }

  /**
   * Record a screening decision. Writes tags when the paper is a library item and a
   * ledger entry in every case (so the decision is remembered even if the item is
   * deleted, or was never imported).
   * @param {{libraryID, key?, item?, title?, stage: "ta"|"ft", d: "include"|"exclude"|"maybe"|null,
   *          r?, by?: "me"|"llm", collectionKey?}} o   d=null clears the decision
   */
  async function decide(o) {
    const ledger = await load(o.libraryID);
    const item = o.item || null;
    const key = o.key || (item ? keyForItem(item) : "");
    if (item) {
      const map = STAGE_TAGS[o.stage];
      for (const tag of Object.values(map)) item.removeTag(tag);
      for (const t of item.getTags()) if (t.tag.startsWith(TAG.why)) item.removeTag(t.tag);
      if (o.stage === "ta") item.removeTag(TAG.unscreened);
      if (o.d) item.addTag(map[o.d]);
      if (o.d === "exclude" && o.r) item.addTag(TAG.why + o.r);
      await item.saveTx();
    }
    if (key) {
      const e = (ledger.decisions[key] = ledger.decisions[key] || {});
      e.t = U.truncate(o.title || item?.getField("title") || e.t || "", 120);
      if (item) e.i = item.key;
      if (o.collectionKey) e.c = o.collectionKey;
      if (o.d) e[o.stage] = { d: o.d, r: o.r || "", by: o.by || "me", at: today() };
      else delete e[o.stage];
      scheduleSave(o.libraryID);
    }
  }

  function keyForItem(item) {
    if (!item?.isRegularItem?.()) return "";
    const get = (f) => {
      try {
        return item.getField(f) || "";
      } catch (e) {
        return "";
      }
    };
    const arx = (get("archiveID") + " " + get("extra") + " " + get("url")).match(/arxiv(?:\.org\/abs\/|:\s*)(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    return keyForRecord({ doi: get("DOI") || get("extra"), arxiv: arx?.[1], title: get("title") });
  }

  /** Prior decision for a paper: item tags win, ledger fills in (reason, date, by). */
  async function prior(libraryID, { key, item }) {
    const ledger = await load(libraryID);
    key = key || (item ? keyForItem(item) : "");
    const fromLedger = key ? ledger.decisions[key] : null;
    const fromTags = item ? decisionFromItem(item) : null;
    if (!fromLedger && !fromTags) return null;
    const out = {};
    for (const stage of ["ta", "ft"]) {
      const t = fromTags?.[stage];
      const l = fromLedger?.[stage];
      if (t) out[stage] = Object.assign({}, l && l.d === t.d ? l : {}, t, { r: t.r || l?.r || "" });
      else if (l && !item) out[stage] = l;
    }
    if (fromTags?.unscreened) out.unscreened = true;
    return Object.keys(out).length ? out : null;
  }

  /** Annotate search records with prior decisions (`rec.prior`) and "seen before" dates. */
  async function annotateRecords(libraryID, records) {
    await load(libraryID);
    const seen = await loadCache();
    for (const r of records) {
      r.key = keyForRecord(r);
      const item = r.existingItemID ? Zotero.Items.get(r.existingItemID) : null;
      r.prior = await prior(libraryID, { key: r.key, item });
      r.seenBefore = seen.seen[r.key] || null;
    }
  }

  // ------------------------------------------------------- reviews & runs ----
  async function getReview(libraryID, collectionKey) {
    const ledger = await load(libraryID);
    return ledger.reviews[collectionKey] || null;
  }

  async function saveReview(libraryID, collectionKey, review) {
    const ledger = await load(libraryID);
    ledger.reviews[collectionKey] = review;
    scheduleSave(libraryID);
    return review;
  }

  async function addRun(libraryID, collectionKey, run) {
    const review = await getReview(libraryID, collectionKey);
    if (!review) return;
    review.runs = review.runs || [];
    review.runs.push(run);
    scheduleSave(libraryID);
  }

  // ---------------------------------------------------------- LLM suggestions ----
  async function setSuggestion(libraryID, itemKey, stage, s) {
    const ledger = await load(libraryID);
    ledger.llm[`${itemKey}|${stage}`] = { d: s.d, r: s.r || "", c: s.c ?? null, at: today() };
    scheduleSave(libraryID);
  }

  async function getSuggestion(libraryID, itemKey, stage) {
    const ledger = await load(libraryID);
    return ledger.llm[`${itemKey}|${stage}`] || null;
  }

  // --------------------------------------------------------------- citations ----
  async function setCitations(libraryID, map) {
    const ledger = await load(libraryID);
    Object.assign(ledger.cites, map);
    scheduleSave(libraryID);
  }

  async function getCitations(libraryID) {
    return (await load(libraryID)).cites;
  }

  // ------------------------------------------------------------ local cache ----
  let cache = null;
  const cachePath = () => PathUtils.join(Zotero.DataDirectory.dir, "zotero-researcher", "cache.json");

  async function loadCache() {
    if (cache) return cache;
    cache = { seen: {} };
    if (typeof IOUtils === "undefined") return cache;
    try {
      cache = Object.assign(cache, JSON.parse(await IOUtils.readUTF8(cachePath())));
    } catch (e) {
      /* first run */
    }
    return cache;
  }

  async function markSeen(records) {
    const c = await loadCache();
    const d = today();
    for (const r of records) {
      const k = r.key || keyForRecord(r);
      if (k && !c.seen[k]) c.seen[k] = d;
    }
    const keys = Object.keys(c.seen);
    if (keys.length > 50000) for (const k of keys.slice(0, keys.length - 50000)) delete c.seen[k];
    if (typeof IOUtils === "undefined") return;
    await IOUtils.makeDirectory(PathUtils.parent(cachePath()), { ignoreExisting: true });
    await IOUtils.writeUTF8(cachePath(), JSON.stringify(c));
  }

  function _reset() {
    libs.clear();
    cache = null;
  }

  return {
    TAG,
    LEDGER_TITLE,
    emptyLedger,
    keyForRecord,
    keyForItem,
    serialize,
    parse,
    describe,
    load,
    flush,
    scheduleSave,
    flushAll,
    decisionFromItem,
    decide,
    prior,
    annotateRecords,
    getReview,
    saveReview,
    addRun,
    setSuggestion,
    getSuggestion,
    setCitations,
    getCitations,
    markSeen,
    _reset,
  };
})();

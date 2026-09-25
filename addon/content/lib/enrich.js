/* global ZR, Zotero */
// Metadata enrichment for existing items.
//
// Deterministic path: identifier (DOI/ISBN/arXiv/PMID) → Zotero's own search
// translators; without an identifier, title lookup in Crossref, OpenAlex, Semantic
// Scholar and arXiv, accepted only on a near-exact title match.
// LLM path: the model extracts metadata from the item's fields and attachment text,
// then the result is *verified* through the deterministic path wherever possible.
//
// Both produce a Proposal: a temporary unsaved item plus a list of field changes the
// user can accept individually. Nothing is written until apply().

ZR.Enrich = (() => {
  const U = ZR.Util;

  const IGNORED_FIELDS = new Set(["accessDate", "dateAdded", "dateModified"]);
  const KEY_FIELDS = ["title", "creators", "date", "publicationTitle", "DOI", "abstractNote", "volume", "pages", "url"];

  function isValid(field, itemTypeID) {
    const id = Zotero.ItemFields.getID(field);
    return !!id && Zotero.ItemFields.isValidForType(id, itemTypeID);
  }

  function getFieldSafe(item, field) {
    if (field === "creators") return item.numCreators() ? "yes" : "";
    let id = Zotero.ItemFields.getID(field);
    if (!id) return "";
    if (!Zotero.ItemFields.isValidForType(id, item.itemTypeID)) {
      try {
        id = Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, field);
      } catch (e) {
        id = false;
      }
      if (!id) return null; // not applicable to this type
    }
    return item.getField(Zotero.ItemFields.getName(id));
  }

  /** How complete an item's metadata is: {score 0..1, missing: [fieldLabel]} */
  function completeness(item) {
    if (!item?.isRegularItem()) return { score: 0, missing: [], applicable: 0 };
    let applicable = 0;
    const missing = [];
    for (const f of KEY_FIELDS) {
      const v = getFieldSafe(item, f);
      if (v === null) continue;
      if (f === "DOI" && !isValid("DOI", item.itemTypeID)) continue;
      applicable++;
      if (!v) missing.push(f === "creators" ? "creators" : f);
    }
    if (isValid("ISBN", item.itemTypeID) && !isValid("DOI", item.itemTypeID)) {
      applicable++;
      if (!item.getField("ISBN")) missing.push("ISBN");
    }
    return { score: applicable ? (applicable - missing.length) / applicable : 0, missing, applicable };
  }

  function identifiers(item) {
    const g = (f) => {
      try {
        return item.getField(f) || "";
      } catch (e) {
        return "";
      }
    };
    const extra = g("extra");
    const url = g("url");
    const ids = {};
    ids.DOI = U.cleanDOI(g("DOI")) || U.cleanDOI(extra.match(/^DOI:\s*(\S+)/im)?.[1] || "") || U.cleanDOI(url.match(/doi\.org\/(10\.\S+)/)?.[1] || "");
    const isbn = g("ISBN") || extra.match(/^ISBN:\s*([\dXx -]+)/m)?.[1] || "";
    if (isbn && Zotero.Utilities.cleanISBN) ids.ISBN = Zotero.Utilities.cleanISBN(isbn) || "";
    const arx = (g("archiveID") + " " + url + " " + extra).match(/arxiv(?:\.org\/(?:abs|pdf)\/|:\s*)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i);
    if (arx) ids.arXiv = arx[1];
    const pmid = extra.match(/^PMID:\s*(\d+)/m);
    if (pmid) ids.PMID = pmid[1];
    for (const k of Object.keys(ids)) if (!ids[k]) delete ids[k];
    return ids;
  }

  /** Run Zotero's search translators for one identifier; returns translator JSON or null. */
  async function translateIdentifier(identifier) {
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier(identifier);
    const translators = await translate.getTranslators();
    if (!translators.length) return null;
    translate.setTranslator(translators);
    try {
      const items = await translate.translate({ libraryID: false, saveAttachments: false });
      return items?.[0] || null;
    } catch (e) {
      U.log("Translation failed", JSON.stringify(identifier), String(e));
      return null;
    }
  }

  function tempItemFromJSON(json, libraryID) {
    const clean = Object.assign({}, json);
    for (const k of ["notes", "attachments", "seeAlso", "complete", "itemID", "id", "key", "version", "tags", "collections", "relations"]) delete clean[k];
    const tmp = new Zotero.Item(Zotero.ItemTypes.getID(clean.itemType) ? clean.itemType : "journalArticle");
    tmp.libraryID = libraryID;
    tmp.fromJSON(clean);
    return tmp;
  }

  /** Title(+author) lookup in Crossref, OpenAlex, Semantic Scholar and arXiv; sorted by similarity. */
  async function titleCandidates(title, { author = "", year = null } = {}) {
    const email = ZR.Prefs.get("email", "");
    const out = [];
    const q = [title, author].filter(Boolean).join(" ");
    const tasks = [
      (async () => {
        const data = await U.getJSON(
          "https://api.crossref.org/works?" +
            U.qs({ "query.bibliographic": q, rows: 5, select: "DOI,title,author,container-title,issued,type,volume,issue,page,ISSN,publisher,abstract,URL", mailto: email })
        );
        for (const it of data.message?.items || []) {
          const dp = it.issued?.["date-parts"]?.[0] || [];
          out.push(
            ZR.Records.make("crossref", {
              title: it.title?.[0],
              creators: (it.author || []).map((a) => (a.family ? { firstName: a.given || "", lastName: a.family } : { name: a.name })),
              date: dp.filter(Boolean).join("-"),
              doi: it.DOI,
              venue: it["container-title"]?.[0],
              itemType: ZR.Records.mapType(it.type),
              volume: it.volume,
              issue: it.issue,
              pages: it.page,
              issn: it.ISSN?.[0],
              publisher: it.publisher,
              abstract: it.abstract,
              url: it.URL,
            })
          );
        }
      })(),
      (async () => {
        const key = ZR.Sources.keyFor("openalex");
        const phrase = '"' + title.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim() + '"';
        const data = await U.getJSON("https://api.openalex.org/works?" + U.qs({ search: phrase, per_page: 5, api_key: key, mailto: key ? "" : email }), { retryAfterMax: 45000 });
        out.push(...(data.results || []).map(ZR.Sources.get("openalex").mapWork));
      })(),
      // Semantic Scholar's title matcher covers conference papers without DOIs (NeurIPS, ICML, …)
      (async () => {
        const key = ZR.Sources.keyFor("semanticscholar");
        const fields = "title,abstract,year,publicationDate,authors,externalIds,venue,journal,publicationTypes,openAccessPdf,isOpenAccess,url,citationCount";
        const data = await U.getJSON("https://api.semanticscholar.org/graph/v1/paper/search/match?" + U.qs({ query: title, fields }), { headers: key ? { "x-api-key": key } : {}, noRetry: true });
        out.push(...(data.data || []).map(ZR.Sources.get("semanticscholar").mapWork));
      })(),
      (async () => {
        const arxiv = ZR.Sources.get("arxiv");
        const res = await arxiv.search({ ast: ZR.Query.parse(`title:"${title.replace(/["()]/g, " ")}"`), limit: 3 });
        out.push(...res.records);
      })(),
    ];
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) if (s.status === "rejected") U.log("Candidate lookup failed", s.reason?.message);
    for (const r of out) {
      r.similarity = U.titleSimilarity(title, r.title);
      if (year && r.year && Math.abs(year - r.year) > 1) r.similarity -= 0.15;
    }
    return ZR.Records.dedupe(out).sort((a, b) => b.similarity - a.similarity);
  }

  /** Diff a temporary (unsaved) item against the real one. */
  function diff(item, tmp, { overwrite = false } = {}) {
    const changes = [];
    const typeChange = item.itemTypeID !== tmp.itemTypeID && ["document", "webpage"].includes(Zotero.ItemTypes.getName(item.itemTypeID));
    const targetTypeID = typeChange ? tmp.itemTypeID : item.itemTypeID;
    for (const fieldID of Zotero.ItemFields.getItemTypeFields(tmp.itemTypeID)) {
      const name = Zotero.ItemFields.getName(fieldID);
      if (IGNORED_FIELDS.has(name)) continue;
      const nv = tmp.getField(name);
      if (!nv) continue;
      // Where does this value go on the target type?
      let targetField = name;
      if (!isValid(name, targetTypeID)) {
        const base = Zotero.ItemFields.getBaseIDFromTypeAndField(tmp.itemTypeID, fieldID);
        const mapped = base && Zotero.ItemFields.getFieldIDFromTypeAndBase(targetTypeID, base);
        if (!mapped) continue;
        targetField = Zotero.ItemFields.getName(mapped);
      }
      const ov = isValid(targetField, item.itemTypeID) ? item.getField(targetField) : "";
      if (String(ov).trim() === String(nv).trim()) continue;
      if (targetField === "title" && ov && U.titleSimilarity(ov, nv) > 0.97) continue;
      const kind = ov ? "overwrite" : "fill";
      if (targetField === "extra" && ov) continue;
      changes.push({ field: targetField, label: Zotero.ItemFields.getLocalizedString(targetField), old: ov, new: nv, kind, selected: kind === "fill" || overwrite });
    }
    const newCreators = tmp.getCreators();
    if (newCreators.length) {
      const oldCreators = item.getCreators();
      const fmt = (cs) => cs.map((c) => [c.lastName, c.firstName].filter(Boolean).join(", ")).join("; ");
      if (fmt(oldCreators) !== fmt(newCreators)) {
        const kind = oldCreators.length ? "overwrite" : "fill";
        changes.push({ field: "creators", label: "Creators", old: fmt(oldCreators), new: fmt(newCreators), kind, selected: kind === "fill" || overwrite, creators: newCreators });
      }
    }
    return {
      typeChange: typeChange ? { from: Zotero.ItemTypes.getName(item.itemTypeID), to: Zotero.ItemTypes.getName(tmp.itemTypeID), selected: true } : null,
      changes,
    };
  }

  function makeProposal(item, tmp, source, opts, confidence = 1) {
    const d = diff(item, tmp, opts);
    return { itemID: item.id, source, confidence, typeChange: d.typeChange, changes: d.changes, tmp };
  }

  function mainItemOf(item) {
    if (item.isAttachment() && item.parentItemID) return Zotero.Items.get(item.parentItemID);
    return item;
  }

  /**
   * Deterministic enrichment.
   * @returns {Promise<object>} proposal | {itemID, recognize:true} | {itemID, error}
   */
  async function deterministic(item, opts = {}) {
    item = mainItemOf(item);
    if (item.isAttachment()) {
      if (Zotero.RecognizeDocument?.canRecognize(item)) return { itemID: item.id, recognize: true, source: "Zotero “Retrieve Metadata for PDF”" };
      return { itemID: item.id, error: "Standalone attachment cannot be recognized" };
    }
    if (!item.isRegularItem()) return { itemID: item.id, error: "Not a regular item" };

    const ids = identifiers(item);
    for (const key of ["DOI", "ISBN", "arXiv", "PMID"]) {
      if (!ids[key]) continue;
      const json = await translateIdentifier({ [key]: ids[key] });
      if (json) return makeProposal(item, tempItemFromJSON(json, item.libraryID), `${key} ${ids[key]} via Zotero translators`, opts);
    }

    const title = item.getField("title");
    if (!title || title.length < 8) return { itemID: item.id, error: "No identifier and no usable title. Try LLM-assisted retrieval" };
    const firstCreator = item.getCreators()[0];
    const cands = await titleCandidates(title, { author: firstCreator?.lastName || "", year: U.yearOf(item.getField("date")) });
    const best = cands[0];
    if (!best || best.similarity < 0.9) {
      return { itemID: item.id, error: `No confident title match${best ? ` (best: “${U.truncate(best.title, 60)}”, ${Math.round(best.similarity * 100)}%)` : ""}`, candidates: cands.slice(0, 5) };
    }
    const pct = Math.round(best.similarity * 100);
    for (const [key, val] of [["DOI", best.doi], ["arXiv", best.ids.arxiv]]) {
      if (!val) continue;
      const json = await translateIdentifier({ [key]: val });
      if (json) return makeProposal(item, tempItemFromJSON(json, item.libraryID), `title match (${pct}%) → ${key} ${val}`, opts, best.similarity);
    }
    return makeProposal(item, ZR.Importer.recordToItem(best, item.libraryID), `title match in ${best.sources.join("+")} (${pct}%)`, opts, best.similarity);
  }

  /** Text context for LLM extraction: current fields plus attachment full text. */
  async function itemContext(item) {
    const lines = [`Item type: ${Zotero.ItemTypes.getName(item.itemTypeID)}`];
    if (item.isRegularItem()) {
      for (const name of item.getUsedFields(true)) {
        const v = item.getField(name);
        if (v) lines.push(`${name}: ${U.truncate(v, 1500)}`);
      }
      const cs = item.getCreators();
      if (cs.length) lines.push("creators: " + cs.map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join("; "));
    }
    const atts = item.isAttachment() ? [item] : item.getAttachments().map((id) => Zotero.Items.get(id));
    for (const att of atts) {
      if (!att?.isFileAttachment()) continue;
      lines.push(`Attachment: ${att.getField("title")} (${att.attachmentFilename || ""})`);
      try {
        const text = await att.attachmentText;
        if (text) {
          lines.push("Attachment text (first pages):\n" + text.slice(0, 7000));
          break;
        }
      } catch (e) {
        U.log("attachmentText failed", e.message);
      }
    }
    return lines.join("\n");
  }

  async function llmAssisted(item, profile, opts = {}) {
    item = mainItemOf(item);
    if (item.isAttachment()) {
      // Standalone file: the LLM reads it, and a new parent item is created from the result.
      opts = Object.assign({}, opts, { createParent: true });
    }
    const context = await itemContext(item);
    const meta = await ZR.Assist.extractMetadata(profile, context);
    const llmTitle = meta.title || (item.isRegularItem() ? item.getField("title") : "");

    // 1) The LLM found an identifier: verify through translators.
    const doi = U.cleanDOI(meta.DOI || "");
    for (const [key, val] of [["DOI", doi], ["ISBN", meta.ISBN]]) {
      if (!val) continue;
      const json = await translateIdentifier({ [key]: val });
      if (json && (!llmTitle || U.titleSimilarity(json.title, llmTitle) > 0.75)) {
        return withParent(item, makeProposal(item, tempItemFromJSON(json, item.libraryID), `LLM found ${key} ${val}, verified via Zotero translators`, opts), opts);
      }
    }
    // 2) Search by the LLM's title, let the LLM pick the matching candidate.
    if (llmTitle) {
      const firstAuthor = meta.authors?.[0]?.lastName || "";
      const cands = (await titleCandidates(llmTitle, { author: firstAuthor, year: U.yearOf(meta.date) })).slice(0, 6);
      let pick = cands[0] && cands[0].similarity >= 0.93 ? { record: cands[0], confidence: cands[0].similarity, reason: "near-exact title" } : null;
      if (!pick && cands.length) pick = await ZR.Assist.pickCandidate(profile, context.slice(0, 3000), cands);
      if (pick && pick.confidence >= 0.6) {
        const rec = pick.record;
        const json = rec.doi ? await translateIdentifier({ DOI: rec.doi }) : null;
        const tmp = json ? tempItemFromJSON(json, item.libraryID) : ZR.Importer.recordToItem(rec, item.libraryID);
        return withParent(item, makeProposal(item, tmp, `LLM-matched ${rec.sources.join("+")} record${rec.doi ? ` (DOI ${rec.doi})` : ""}: ${pick.reason}`, opts, pick.confidence), opts);
      }
    }
    // 3) Fall back to the LLM's own extraction - flagged as unverified.
    const rec = ZR.Records.make("llm", {
      title: meta.title,
      creators: (meta.authors || []).map((a) => (a.lastName ? { firstName: a.firstName || "", lastName: a.lastName } : null)),
      date: meta.date,
      doi: "",
      venue: meta.venue,
      volume: meta.volume,
      issue: meta.issue,
      pages: meta.pages,
      publisher: meta.publisher,
      isbn: meta.ISBN,
      abstract: meta.abstract,
      itemType: meta.itemType && Zotero.ItemTypes.getID(meta.itemType) ? meta.itemType : "journalArticle",
      url: meta.url,
      language: meta.language,
    });
    const p = makeProposal(item, ZR.Importer.recordToItem(rec, item.libraryID), "LLM extraction (UNVERIFIED, check before applying)", opts, 0.4);
    for (const c of p.changes) if (c.kind === "overwrite") c.selected = false;
    return withParent(item, p, opts);
  }

  function withParent(item, proposal, opts) {
    if (opts.createParent) {
      proposal.createParentFor = item.id;
      // Everything is new for the parent-to-be.
      const tmp = proposal.tmp;
      proposal.typeChange = null;
      proposal.changes = [];
      for (const name of tmp.getUsedFields(true)) {
        proposal.changes.push({ field: name, label: Zotero.ItemFields.getLocalizedString(name), old: "", new: tmp.getField(name), kind: "fill", selected: true });
      }
      if (tmp.numCreators()) {
        const cs = tmp.getCreators();
        proposal.changes.push({ field: "creators", label: "Creators", old: "", new: cs.map((c) => [c.lastName, c.firstName].filter(Boolean).join(", ")).join("; "), kind: "fill", selected: true, creators: cs });
      }
    }
    return proposal;
  }

  /** Write the selected changes of a proposal. Returns the updated (or new parent) item. */
  async function apply(proposal) {
    let item = Zotero.Items.get(proposal.itemID);
    if (proposal.recognize) {
      await Zotero.RecognizeDocument.recognizeItems([item]);
      return item;
    }
    const selected = proposal.changes.filter((c) => c.selected);
    if (proposal.createParentFor) {
      const att = item;
      const parent = new Zotero.Item(Zotero.ItemTypes.getName(proposal.tmp.itemTypeID));
      parent.libraryID = att.libraryID;
      parent.setCollections(att.getCollections());
      item = parent;
      await applyChanges(item, selected);
      att.parentID = item.id;
      await att.saveTx();
      return item;
    }
    if (proposal.typeChange?.selected) item.setType(Zotero.ItemTypes.getID(proposal.typeChange.to));
    await applyChanges(item, selected);
    return item;
  }

  async function applyChanges(item, changes) {
    for (const c of changes) {
      if (c.field === "creators") item.setCreators(c.creators);
      else if (isValid(c.field, item.itemTypeID)) item.setField(c.field, c.new);
      else ZR.Importer.setFieldFlexible(item, c.field, c.new);
    }
    item.addTag("zr:enriched");
    await item.saveTx();
  }

  return { completeness, identifiers, deterministic, llmAssisted, apply, titleCandidates, itemContext, translateIdentifier };
})();

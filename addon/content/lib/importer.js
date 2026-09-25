/* global ZR, Zotero */
// Writes records into the Zotero library: item creation, duplicate detection,
// full-text PDF retrieval, and search-protocol notes.

ZR.Importer = (() => {
  const U = ZR.Util;

  /** Find an existing regular item in the library with the same DOI or title. */
  async function findExisting(libraryID, rec) {
    if (rec.doi) {
      for (const cond of [["DOI", rec.doi], ["extra", rec.doi]]) {
        const s = new Zotero.Search();
        s.libraryID = libraryID;
        s.addCondition(cond[0], "contains", cond[1]);
        s.addCondition("deleted", "false");
        const ids = await s.search();
        for (const id of ids) {
          const item = await Zotero.Items.getAsync(id);
          if (!item?.isRegularItem()) continue;
          const doi = U.cleanDOI(item.getField("DOI") || item.getField("extra"));
          if (doi === rec.doi) return item;
        }
      }
    }
    if (rec.title && rec.title.length > 12) {
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("title", "contains", rec.title.slice(0, 60));
      s.addCondition("deleted", "false");
      const ids = await s.search();
      for (const id of ids) {
        const item = await Zotero.Items.getAsync(id);
        if (item?.isRegularItem() && U.titleSimilarity(item.getField("title"), rec.title) > 0.92) return item;
      }
    }
    return null;
  }

  /**
   * Set a field by name, falling back to the type-specific field mapped from a base
   * field (publicationTitle → proceedingsTitle/bookTitle, publisher → university …).
   * Returns false when the item type has no such field.
   */
  function setFieldFlexible(item, field, value) {
    if (value === undefined || value === null || value === "") return false;
    let fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID) return false;
    if (!Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
      try {
        fieldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, field);
      } catch (e) {
        fieldID = false;
      }
    }
    if (!fieldID) return false;
    item.setField(Zotero.ItemFields.getName(fieldID), String(value));
    return true;
  }

  function venueField(itemType) {
    return itemType === "preprint" ? "repository" : itemType === "thesis" ? "university" : itemType === "report" ? "institution" : "publicationTitle";
  }

  function toCreators(creators, creatorType) {
    return creators.slice(0, 100).map((c) =>
      c.lastName
        ? { firstName: c.firstName || "", lastName: c.lastName, creatorType }
        : { lastName: c.name, fieldMode: 1, creatorType }
    );
  }

  /** Build (unsaved) Zotero.Item from a record. */
  function recordToItem(rec, libraryID) {
    let itemType = rec.itemType;
    if (!Zotero.ItemTypes.getID(itemType)) itemType = "journalArticle";
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID;
    const extra = [];

    setFieldFlexible(item, "title", rec.title);
    const creatorType = Zotero.CreatorTypes.getName(Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID));
    if (rec.creators.length) item.setCreators(toCreators(rec.creators, creatorType));
    setFieldFlexible(item, "date", rec.date || (rec.year ? String(rec.year) : ""));
    if (!setFieldFlexible(item, venueField(itemType), rec.venue) && rec.venue) extra.push(`Venue: ${rec.venue}`);
    setFieldFlexible(item, "volume", rec.volume);
    setFieldFlexible(item, "issue", rec.issue);
    setFieldFlexible(item, "pages", rec.pages);
    setFieldFlexible(item, "ISSN", rec.issn);
    setFieldFlexible(item, "ISBN", rec.isbn);
    if (itemType !== "thesis" && itemType !== "report") setFieldFlexible(item, "publisher", rec.publisher);
    setFieldFlexible(item, "language", rec.language);
    setFieldFlexible(item, "abstractNote", rec.abstract);
    setFieldFlexible(item, "url", rec.url);
    if (rec.doi && !setFieldFlexible(item, "DOI", rec.doi)) extra.push(`DOI: ${rec.doi}`);
    if (rec.ids.arxiv) {
      if (!(itemType === "preprint" && setFieldFlexible(item, "archiveID", `arXiv:${rec.ids.arxiv}`))) extra.push(`arXiv: ${rec.ids.arxiv}`);
    }
    if (rec.ids.pmid) extra.push(`PMID: ${rec.ids.pmid}`);
    if (rec.ids.pmcid) {
      if (!setFieldFlexible(item, "PMCID", rec.ids.pmcid)) extra.push(`PMCID: ${rec.ids.pmcid}`);
    }
    if (rec.ids.openalex) extra.push(`OpenAlex: ${rec.ids.openalex}`);
    if (extra.length) item.setField("extra", extra.join("\n"));
    item.setField("libraryCatalog", rec.sources.map((s) => ZR.Sources.get(s)?.name || s).join(", "));
    return item;
  }

  /**
   * @returns {Promise<{item: Zotero.Item, existing: boolean}>}
   */
  async function importRecord(rec, { libraryID, collectionID, tags = [], skipExisting = true, addExistingToCollection = true }) {
    if (skipExisting) {
      const existing = await findExisting(libraryID, rec);
      if (existing) {
        if (addExistingToCollection && collectionID && !existing.inCollection(collectionID)) {
          existing.addToCollection(collectionID);
          await existing.saveTx();
        }
        return { item: existing, existing: true };
      }
    }
    const item = recordToItem(rec, libraryID);
    if (collectionID) item.setCollections([collectionID]);
    for (const t of tags) if (t) item.addTag(t);
    await item.saveTx();
    return { item, existing: false };
  }

  function hasFile(item) {
    return item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .some((a) => a && a.isFileAttachment() && ["application/pdf", "application/epub+zip"].includes(a.attachmentContentType));
  }

  /** Unpaywall lookup as a lazy resolver (only runs if earlier resolvers failed). */
  function unpaywallResolver(doi) {
    const email = ZR.Prefs.get("email", "");
    if (!doi || !email) return null;
    return async () => {
      try {
        const data = await U.getJSON(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, { timeout: 20000, noRetry: true });
        const locs = [data.best_oa_location, ...(data.oa_locations || [])].filter(Boolean);
        return [...new Set(locs.map((l) => l.url_for_pdf).filter(Boolean))].slice(0, 4).map((url) => ({ url, accessMethod: "unpaywall" }));
      } catch (e) {
        return [];
      }
    };
  }

  /**
   * Try to attach a PDF: source-provided OA links first, then Unpaywall, then Zotero's
   * own resolvers (DOI landing page, URL, Zotero OA lookup, custom resolvers).
   * @returns {Promise<Zotero.Item|false>} attachment
   */
  async function attachFullText(item, rec = null) {
    if (hasFile(item)) return true;
    const doi = U.cleanDOI(item.getField("DOI") || item.getField("extra"));
    const resolvers = [];
    for (const url of rec?.pdfURLs || []) resolvers.push({ url, accessMethod: "researcher" });
    const arxiv = (item.getField("archiveID") || item.getField("extra") || "").match(/arXiv:\s*([\w.\/-]+?\d)(v\d+)?\b/i);
    if (arxiv) resolvers.push({ url: `https://arxiv.org/pdf/${arxiv[1]}`, accessMethod: "arxiv" });
    const up = unpaywallResolver(doi);
    if (up) resolvers.push(up);
    try {
      resolvers.push(...Zotero.Attachments.getFileResolvers(item, ["doi", "url", "oa", "custom"]));
    } catch (e) {
      U.log("getFileResolvers failed", e.message);
    }
    if (!resolvers.length) return false;
    try {
      return await Zotero.Attachments.addFileFromURLs(item, resolvers);
    } catch (e) {
      U.log("PDF retrieval failed for", item.getField("title"), e.message);
      return false;
    }
  }

  async function createNote(html, { libraryID, collectionID, parentItemID }) {
    const note = new Zotero.Item("note");
    note.libraryID = libraryID;
    if (parentItemID) note.parentID = parentItemID;
    else if (collectionID) note.setCollections([collectionID]);
    note.setNote(html);
    await note.saveTx();
    return note;
  }

  /** Human-readable, reproducible record of a search run (PRISMA-style identification log). */
  function protocolHTML(run) {
    const e = U.escapeHTML;
    const rows = Object.entries(run.perSource || {})
      .map(([id, s]) => `<tr><td>${e(ZR.Sources.get(id)?.name || id)}</td><td><code>${e(s.query || "")}</code></td><td>${s.count ?? 0}</td><td>${e(s.error || "")}</td></tr>`)
      .join("");
    return (
      `<h2>Search protocol — ${e(run.started)}</h2>` +
      `<p><strong>Mode:</strong> ${e(run.mode)}${run.llmProfile ? ` (LLM: ${e(run.llmProfile)})` : ""}</p>` +
      (run.request ? `<p><strong>Request:</strong> ${e(run.request)}</p>` : "") +
      `<p><strong>Boolean query:</strong> <code>${e(run.query)}</code></p>` +
      `<p><strong>Filters:</strong> ${e(run.filtersText || "none")}</p>` +
      `<table><thead><tr><th>Source</th><th>Query sent</th><th>Hits</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p><strong>Identified:</strong> ${run.identified ?? 0} · <strong>after de-duplication:</strong> ${run.deduped ?? 0} · <strong>after filters/screening:</strong> ${run.eligible ?? 0} · <strong>imported:</strong> ${run.imported ?? 0} (already in library: ${run.existing ?? 0}) · <strong>with PDF:</strong> ${run.withPDF ?? 0}</p>` +
      `<p><em>Generated by Zotero Researcher ${e(ZR.version || "")}</em></p>`
    );
  }

  return { findExisting, recordToItem, importRecord, attachFullText, hasFile, createNote, protocolHTML, setFieldFlexible };
})();

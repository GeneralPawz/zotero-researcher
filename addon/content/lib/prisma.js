/* global ZR, Zotero */
// PRISMA 2020 support: a review is bound to a collection. Search runs made while the
// collection is a review are logged (identification); items in the collection are
// screened on title/abstract, then full text; the flow diagram is computed from runs
// and item tags, so it always reflects the library's current state.

ZR.Prisma = (() => {
  const U = ZR.Util;

  const DEFAULT_REASONS = [
    "Off topic",
    "Wrong study type (not research)",
    "Wrong context or population",
    "Weak / low quality",
    "Not peer-reviewed",
    "Language",
    "Duplicate",
    "Full text not available",
  ];

  function newReview({ question = "", include = "", exclude = "" } = {}) {
    return { question, include, exclude, reasons: DEFAULT_REASONS.slice(), created: new Date().toISOString().slice(0, 10), runs: [] };
  }

  /**
   * Pure count computation.
   * @param {object[]} runs   logged search runs ({mode, perSource:{id:{count}}, identified, deduped, inLibrary, imported})
   * @param {object[]} items  [{ta: "include"|"exclude"|"maybe"|null, ft: "include"|"exclude"|null, reason, hasPDF}]
   * @param {(id:string)=>string} sourceName
   */
  function countsFromData(runs, items, sourceName = (id) => id) {
    const bySource = {};
    let citation = 0;
    let removedDuplicates = 0;
    let removedInLibrary = 0;
    let importedByRuns = 0;
    for (const run of runs || []) {
      if (run.mode === "related") {
        citation += run.identified || 0;
      } else {
        for (const [id, s] of Object.entries(run.perSource || {})) {
          if (s.count) bySource[sourceName(id)] = (bySource[sourceName(id)] || 0) + s.count;
        }
      }
      removedDuplicates += Math.max(0, (run.identified || 0) - (run.deduped || 0));
      removedInLibrary += run.inLibrary || 0;
      importedByRuns += run.imported || 0;
    }
    const identified = Object.values(bySource).reduce((a, b) => a + b, 0);
    const screened = items.length;
    const ta = (d) => items.filter((i) => i.ta === d).length;
    const includedTA = items.filter((i) => i.ta === "include");
    const assessedItems = includedTA.filter((i) => i.ft);
    const excludedFT = {};
    for (const i of assessedItems.filter((x) => x.ft === "exclude")) {
      const r = i.reason || "No reason given";
      excludedFT[r] = (excludedFT[r] || 0) + 1;
    }
    const excludedTAReasons = {};
    for (const i of items.filter((x) => x.ta === "exclude")) {
      const r = i.reason || "No reason given";
      excludedTAReasons[r] = (excludedTAReasons[r] || 0) + 1;
    }
    const notRetrieved = includedTA.filter((i) => !i.ft && !i.hasPDF).length;
    return {
      identified,
      bySource,
      otherMethods: { citation, manual: Math.max(0, screened - importedByRuns - citation) },
      removedDuplicates,
      removedInLibrary,
      screened,
      excludedTA: ta("exclude"),
      excludedTAReasons,
      maybeTA: ta("maybe"),
      pendingTA: items.filter((i) => !i.ta).length,
      sought: includedTA.length,
      notRetrieved,
      assessed: assessedItems.length,
      pendingFT: includedTA.filter((i) => !i.ft && i.hasPDF).length,
      excludedFT,
      excludedFTTotal: Object.values(excludedFT).reduce((a, b) => a + b, 0),
      included: assessedItems.filter((i) => i.ft === "include").length,
    };
  }

  function itemHasPDF(item) {
    return item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .some((a) => a?.isFileAttachment() && ["application/pdf", "application/epub+zip", "text/html"].includes(a.attachmentContentType));
  }

  /** Screening population: regular items in the review collection (not the ledger or notes). */
  function reviewItems(collection) {
    return collection.getChildItems(false).filter((i) => i.isRegularItem());
  }

  function itemState(item) {
    const s = ZR.Store.decisionFromItem(item) || {};
    return { item, ta: s.ta?.d || null, ft: s.ft?.d || null, reason: s.ft?.r || s.ta?.r || "", hasPDF: itemHasPDF(item) };
  }

  async function counts(libraryID, collection) {
    const review = await ZR.Store.getReview(libraryID, collection.key);
    const items = reviewItems(collection).map(itemState);
    return countsFromData(review?.runs || [], items, (id) => ZR.Sources.get(id)?.name || id);
  }

  // ------------------------------------------------------------- rendering ----
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** PRISMA 2020 flow diagram (databases + other methods) as a standalone SVG string. */
  function svg(c, { title = "" } = {}) {
    const W = 860;
    const boxW = 330;
    const lx = 60;
    const rx = 470;
    const lineH = 17;
    let y = title ? 50 : 20;
    const parts = [];
    const box = (x, yy, lines, opts = {}) => {
      const h = 16 + lines.length * lineH;
      parts.push(`<rect x="${x}" y="${yy}" width="${boxW}" height="${h}" rx="6" fill="${opts.fill || "#ffffff"}" stroke="#4a5568" stroke-width="1.2"/>`);
      lines.forEach((l, i) => {
        const bold = i === 0 ? ' font-weight="600"' : "";
        parts.push(`<text x="${x + 12}" y="${yy + 22 + i * lineH}" font-size="13"${bold}>${esc(l)}</text>`);
      });
      return h;
    };
    const arrowDown = (x, y1, y2) => parts.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 4}" stroke="#4a5568" stroke-width="1.4" marker-end="url(#a)"/>`);
    const arrowRight = (y1) => parts.push(`<line x1="${lx + boxW}" y1="${y1}" x2="${rx - 4}" y2="${y1}" stroke="#4a5568" stroke-width="1.4" marker-end="url(#a)"/>`);
    const band = (label, y1, y2, color) => {
      parts.push(`<rect x="8" y="${y1}" width="34" height="${y2 - y1}" rx="4" fill="${color}"/>`);
      parts.push(`<text transform="translate(29 ${(y1 + y2) / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="600" fill="#1a202c">${esc(label)}</text>`);
    };

    if (title) parts.push(`<text x="${W / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700">${esc(title)}</text>`);

    // Identification
    const idTop = y;
    const srcLines = Object.entries(c.bySource).map(([n, v]) => `   ${n} (n = ${v})`);
    const other = c.otherMethods.citation + c.otherMethods.manual;
    const h1 = box(lx, y, [`Records identified from databases (n = ${c.identified})`, ...srcLines, ...(other ? [`Other methods: citation searching (n = ${c.otherMethods.citation}),`, `   added manually (n = ${c.otherMethods.manual})`] : [])], { fill: "#f7fafc" });
    const h1r = box(rx, y, ["Records removed before screening:", `   Duplicates removed (n = ${c.removedDuplicates})`, `   Already in library (n = ${c.removedInLibrary})`]);
    arrowRight(y + Math.min(h1, h1r) / 2);
    y += Math.max(h1, h1r) + 30;
    band("Identification", idTop, y - 15, "#bee3f8");

    // Screening
    const scTop = y;
    arrowDown(lx + boxW / 2, y - 30, y);
    const reasonsTA = Object.entries(c.excludedTAReasons).map(([r, n]) => `   ${r} (n = ${n})`);
    const h2 = box(lx, y, [`Records screened (n = ${c.screened})`, ...(c.pendingTA ? [`   not yet screened (n = ${c.pendingTA})`] : []), ...(c.maybeTA ? [`   undecided / maybe (n = ${c.maybeTA})`] : [])]);
    const h2r = box(rx, y, [`Records excluded (n = ${c.excludedTA})`, ...reasonsTA.slice(0, 6)]);
    arrowRight(y + Math.min(h2, h2r) / 2);
    y += Math.max(h2, h2r) + 30;

    arrowDown(lx + boxW / 2, y - 30, y);
    const h3 = box(lx, y, [`Reports sought for retrieval (n = ${c.sought})`]);
    const h3r = box(rx, y, [`Reports not retrieved (n = ${c.notRetrieved})`]);
    arrowRight(y + Math.min(h3, h3r) / 2);
    y += Math.max(h3, h3r) + 30;

    arrowDown(lx + boxW / 2, y - 30, y);
    const reasonsFT = Object.entries(c.excludedFT).map(([r, n]) => `   ${r} (n = ${n})`);
    const h4 = box(lx, y, [`Reports assessed for eligibility (n = ${c.assessed})`, ...(c.pendingFT ? [`   awaiting full-text screening (n = ${c.pendingFT})`] : [])]);
    const h4r = box(rx, y, [`Reports excluded (n = ${c.excludedFTTotal})`, ...reasonsFT]);
    arrowRight(y + Math.min(h4, h4r) / 2);
    y += Math.max(h4, h4r) + 30;
    band("Screening", scTop, y - 15, "#c6f6d5");

    // Included
    const inTop = y;
    arrowDown(lx + boxW / 2, y - 30, y);
    const h5 = box(lx, y, [`Studies included in review (n = ${c.included})`], { fill: "#f0fff4" });
    y += h5 + 20;
    band("Included", inTop, y - 5, "#fefcbf");

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="Segoe UI, Helvetica, Arial, sans-serif" fill="#1a202c">` +
      `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#4a5568"/></marker></defs>` +
      `<rect width="100%" height="100%" fill="#ffffff"/>` +
      parts.join("") +
      `</svg>`
    );
  }

  /** Text version for a Zotero note (notes can't hold SVG). */
  function noteHTML(c, review, title) {
    const li = (obj) => Object.entries(obj).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join("");
    return (
      `<h1>PRISMA 2020 flow — ${esc(title)}</h1>` +
      `<p><em>Generated ${new Date().toISOString().slice(0, 10)} by Zotero Researcher. Counts reflect the collection's tags at that time.</em></p>` +
      (review?.question ? `<p><strong>Review question:</strong> ${esc(review.question)}</p>` : "") +
      (review?.include ? `<p><strong>Inclusion criteria:</strong> ${esc(review.include)}</p>` : "") +
      (review?.exclude ? `<p><strong>Exclusion criteria:</strong> ${esc(review.exclude)}</p>` : "") +
      `<h2>Identification</h2><p>Records identified from databases: <strong>${c.identified}</strong></p><ul>${li(c.bySource)}</ul>` +
      `<p>Other methods — citation searching: ${c.otherMethods.citation}; added manually: ${c.otherMethods.manual}</p>` +
      `<p>Removed before screening — duplicates: ${c.removedDuplicates}; already in library: ${c.removedInLibrary}</p>` +
      `<h2>Screening</h2><p>Records screened: <strong>${c.screened}</strong> (not yet screened: ${c.pendingTA}; maybe: ${c.maybeTA})</p>` +
      `<p>Records excluded: <strong>${c.excludedTA}</strong></p><ul>${li(c.excludedTAReasons)}</ul>` +
      `<p>Reports sought for retrieval: ${c.sought}; not retrieved: ${c.notRetrieved}</p>` +
      `<p>Reports assessed for eligibility: <strong>${c.assessed}</strong>; excluded: ${c.excludedFTTotal}</p><ul>${li(c.excludedFT)}</ul>` +
      `<h2>Included</h2><p>Studies included in review: <strong>${c.included}</strong></p>` +
      (review?.runs?.length
        ? `<h2>Searches</h2><table><tr><th>Date</th><th>Mode</th><th>Query</th><th>Identified</th><th>Imported</th></tr>${review.runs
            .map((r) => `<tr><td>${esc(r.at || "")}</td><td>${esc(r.mode || "")}</td><td><code>${esc(r.query || "")}</code></td><td>${r.identified ?? ""}</td><td>${r.imported ?? ""}</td></tr>`)
            .join("")}</table>`
        : "")
    );
  }

  /** Compact run record for the review log. */
  function runRecord(runInfo) {
    const perSource = {};
    for (const [id, s] of Object.entries(runInfo.perSource || {})) perSource[id] = { count: s.count || 0, ...(s.error ? { error: U.truncate(s.error, 120) } : {}) };
    return {
      id: runInfo.id || "r" + Date.now().toString(36),
      parent: runInfo.parent || null, // the search this one refines
      settings: runInfo.settings || null, // to reopen it in the Search tab
      removed: (runInfo.dropped || []).length,
      at: runInfo.started,
      mode: runInfo.mode?.startsWith("related") ? "related" : runInfo.mode,
      query: runInfo.query,
      filters: runInfo.filtersText,
      perSource,
      identified: runInfo.identified || 0,
      deduped: runInfo.deduped || 0,
      inLibrary: runInfo.inLibraryCount || 0,
      imported: runInfo.imported || 0,
    };
  }

  return { DEFAULT_REASONS, newReview, countsFromData, counts, reviewItems, itemState, itemHasPDF, svg, noteHTML, runRecord };
})();

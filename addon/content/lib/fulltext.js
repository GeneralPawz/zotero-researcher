/* global ZR, Zotero */
// Full-text annotations for the review's full-text step.
//
// The AI reads a paper's PDF and writes real Zotero annotations: a highlight on a
// verbatim passage, a short comment, and a tag - include / maybe / exclude - coloured
// green / yellow / red. They carry a separate author name ("Bot" by default), so they
// are told apart from yours. Your own annotations with one of these tags count too;
// both are read back into the review.
//
// Positions come from Zotero's structured document text (Zotero.SDT): every text node
// carries a textMap of runs [header, pageIndex, minX, minY, maxX, maxY, ...widths] from
// which each non-whitespace character's rectangle is reconstructed. A quote found in
// the text therefore maps to exact highlight rectangles, as when you select text.

ZR.FullText = (() => {
  const U = ZR.Util;

  const KINDS = {
    include: { color: "#5fb236", label: "include" },
    maybe: { color: "#ffd400", label: "maybe" },
    exclude: { color: "#ff6666", label: "exclude" },
  };
  // Tags that mark an annotation's verdict (case-insensitive; "#include", "zr:include" also work)
  const kindOfTag = (tag) => {
    const t = String(tag || "").toLowerCase().replace(/^(#|zr:|review:)/, "").trim();
    return KINDS[t] ? t : null;
  };
  const botName = () => ZR.Prefs.get("botName", "Bot") || "Bot";

  // ------------------------------------------------------ text and positions ----
  const SOFT_HYPHEN_LAST = 1;
  const isVertical = (header) => {
    const dir = (header >> 1) & 3;
    return dir === 1 || dir === 3;
  };

  /** Character rectangles of one text node's runs (whitespace has none). */
  function runRects(textMap) {
    let runs;
    try {
      runs = JSON.parse(textMap || "[]");
    } catch (e) {
      return [];
    }
    const out = [];
    for (const run of Array.isArray(runs) ? runs : []) {
      if (!Array.isArray(run) || run.length < 6) continue;
      const [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run;
      const vertical = isVertical(header);
      let pos = vertical ? minY : minX;
      const spans = [];
      if (!widths.length) spans.push([pos, vertical ? maxY : maxX]);
      for (const w of widths) {
        if (Array.isArray(w)) {
          pos += w[0];
          spans.push([pos, pos + w[1]]);
          pos += w[1];
        } else {
          spans.push([pos, pos + w]);
          pos += w;
        }
      }
      if (header & SOFT_HYPHEN_LAST) spans.pop();
      for (const [a, b] of spans) {
        if (Number.isFinite(a) && Number.isFinite(b)) out.push({ pageIndex, rect: vertical ? [minX, a, maxX, b] : [a, minY, b, maxY] });
      }
    }
    return out;
  }

  /**
   * Flatten a structured document ({content: [...blocks]}) into plain text plus a
   * position for every character (null for whitespace and block breaks).
   * @returns {{text: string, pos: ({pageIndex, rect}|null)[], pages: Map<number, {maxY}>}}
   */
  function buildDocument(structure) {
    let text = "";
    const pos = [];
    const pages = new Map();
    const nodeEnds = new Set(); // offsets where a text node (usually a line) ends
    const push = (s, p) => {
      text += s;
      for (let i = 0; i < s.length; i++) pos.push(p ? p[i] || null : null);
    };
    function textNode(node) {
      const t = String(node.text || "");
      const runs = node.anchor?.textMap ? runRects(node.anchor.textMap) : [];
      const fallback = node.anchor?.pageRects?.[0];
      const p = [];
      let r = 0;
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) p.push(null);
        else if (runs.length) p.push(runs[r++] || null);
        else p.push(fallback ? { pageIndex: fallback[0], rect: fallback.slice(1, 5) } : null);
      }
      for (const x of p) if (x) pages.set(x.pageIndex, { maxY: Math.max(pages.get(x.pageIndex)?.maxY || 0, x.rect[3]) });
      push(t, p);
      nodeEnds.add(text.length);
    }
    function block(node) {
      if (typeof node?.text === "string") return textNode(node);
      const kids = Array.isArray(node?.content) ? node.content : [];
      const leaf = kids.every((k) => typeof k?.text === "string");
      if (leaf) {
        for (const k of kids) textNode(k);
        push("\n\n");
      } else for (const k of kids) block(k);
    }
    for (const b of structure?.content || []) block(b);
    return { text, pos, pages, nodeEnds };
  }

  /** Whitespace-, case- and hyphenation-tolerant search. Returns {start, end} or null. */
  function locate(doc, quote) {
    const q = String(quote || "").trim();
    if (q.length < 8) return null;
    // Normalized copy of the document with a map back to original offsets
    if (!doc._norm) {
      let s = "";
      const map = [];
      const t = doc.text;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        // "exam-\nple" → "example"
        if (c === "-" && (/\s/.test(t[i + 1] || "") || doc.nodeEnds?.has(i + 1)) && /[a-zäöüß]/i.test(t[i - 1] || "")) {
          let j = i + 1;
          while (j < t.length && /\s/.test(t[j])) j++;
          if (/[a-zäöüß]/.test(t[j] || "")) {
            i = j - 1;
            continue;
          }
        }
        if (/\s/.test(c)) {
          if (s.endsWith(" ")) continue;
          s += " ";
        } else s += c.toLowerCase();
        map.push(i);
      }
      doc._norm = { s, map };
    }
    const { s, map } = doc._norm;
    const nq = q.replace(/\s+/g, " ").replace(/-\s(?=[a-zäöüß])/gi, "").toLowerCase().replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
    const ns = s.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
    let at = ns.indexOf(nq);
    let len = nq.length;
    if (at < 0 && nq.length > 60) {
      // quotes are sometimes shortened with "…": anchor on the beginning and the end
      const head = nq.slice(0, 40).replace(/[….]+$/, "");
      const tail = nq.slice(-30).replace(/^[….]+/, "");
      const h = ns.indexOf(head);
      const t = h >= 0 ? ns.indexOf(tail, h + head.length) : -1;
      if (h >= 0 && t >= 0 && t - h < nq.length * 1.6) {
        at = h;
        len = t + tail.length - h;
      }
    }
    if (at < 0) return null;
    return { start: map[at], end: map[Math.min(at + len - 1, map.length - 1)] + 1 };
  }

  function sameLine(a, b) {
    const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const minH = Math.max(0.001, Math.min(a[3] - a[1], b[3] - b[1]));
    return overlap / minH >= 0.6;
  }
  function mergeLines(rects) {
    const out = [];
    let cur = null;
    for (const r of rects) {
      if (cur && sameLine(cur, r)) {
        cur[0] = Math.min(cur[0], r[0]);
        cur[1] = Math.min(cur[1], r[1]);
        cur[2] = Math.max(cur[2], r[2]);
        cur[3] = Math.max(cur[3], r[3]);
      } else {
        cur = r.slice();
        out.push(cur);
      }
    }
    return out.map((r) => r.map((v) => Math.round(v * 1000) / 1000));
  }

  /** Annotation position for [start, end): {pageIndex, rects, nextPageRects?} plus sortIndex. */
  function position(doc, start, end) {
    const byPage = new Map();
    for (let i = start; i < end; i++) {
      const p = doc.pos[i];
      if (!p) continue;
      if (!byPage.has(p.pageIndex)) byPage.set(p.pageIndex, []);
      byPage.get(p.pageIndex).push(p.rect);
    }
    if (!byPage.size) return null;
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    const pageIndex = pages[0];
    const position = { pageIndex, rects: mergeLines(byPage.get(pageIndex)) };
    if (pages.length > 1 && pages[1] === pageIndex + 1) position.nextPageRects = mergeLines(byPage.get(pages[1]));
    // Sort index as Zotero computes it: page | character offset on the page | distance from the top
    let offset = 0;
    for (let i = 0; i < start; i++) if (doc.pos[i]?.pageIndex === pageIndex) offset++;
    const topRect = position.rects.reduce((a, b) => (b[3] > a[3] ? b : a));
    const pageTop = (doc.pages.get(pageIndex)?.maxY || topRect[3]) + 40;
    const top = Math.max(0, Math.floor(pageTop - topRect[3]));
    const sortIndex = [String(pageIndex).slice(0, 5).padStart(5, "0"), String(offset).slice(0, 6).padStart(6, "0"), String(top).slice(0, 5).padStart(5, "0")].join("|");
    return { position, sortIndex };
  }

  // ------------------------------------------------------------------ Zotero ----
  /** The paper's PDF attachment (or null). */
  function pdfOf(item) {
    if (!item) return null;
    if (item.isPDFAttachment?.()) return item;
    const atts = item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .filter((a) => a?.isPDFAttachment?.());
    return atts.find((a) => a.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL) || atts[0] || null;
  }

  const docs = new Map(); // attachment key → document (per session)

  /** Structured text of an attachment with character positions (Zotero's own extraction, cached by Zotero). */
  async function documentOf(attachment, { onProgress } = {}) {
    const cacheKey = attachment.key + ":" + (attachment.attachmentSyncedHash || attachment.dateModified);
    if (docs.has(cacheKey)) return docs.get(cacheKey);
    if (!Zotero.SDT?.getReader) throw new Error("This Zotero version cannot map text to PDF positions (needs Zotero's structured document text)");
    const reader = await Zotero.SDT.getReader(attachment.id, { isPriority: true, onProgress });
    if (!reader) throw new Error("Zotero could not read the PDF's text (scanned without OCR, or password-protected?)");
    const doc = buildDocument(await reader.materialize());
    if (!doc.text.trim()) throw new Error("The PDF has no text layer");
    docs.set(cacheKey, doc);
    return doc;
  }

  /** Save one highlight annotation. */
  async function saveAnnotation(attachment, doc, { quote, kind, comment, author = botName() }) {
    const loc = locate(doc, quote);
    if (!loc) return null;
    const pos = position(doc, loc.start, loc.end);
    if (!pos) return null;
    const json = {
      key: Zotero.DataObjectUtilities.generateKey(),
      type: "highlight",
      text: doc.text.slice(loc.start, loc.end).replace(/\s+/g, " ").trim(),
      comment: comment || "",
      color: KINDS[kind]?.color || KINDS.maybe.color,
      pageLabel: String(pos.position.pageIndex + 1),
      sortIndex: pos.sortIndex,
      position: pos.position,
      tags: kind ? [{ name: kind }] : [],
    };
    if (author) json.authorName = author;
    return Zotero.Annotations.saveFromJSON(attachment, json);
  }

  /** Annotations of a paper that the review uses: [{key, kind, text, comment, page, isBot, author, color, sortIndex, attachmentID}] */
  function annotationsOf(item) {
    const att = pdfOf(item);
    if (!att) return [];
    const bot = botName();
    return att
      .getAnnotations()
      .filter((a) => ["highlight", "underline", "note", "text"].includes(a.annotationType))
      .map((a) => {
        const kind = a.getTags().map((t) => kindOfTag(t.tag)).find(Boolean) || null;
        return {
          key: a.key,
          id: a.id,
          kind,
          text: a.annotationText || "",
          comment: a.annotationComment || "",
          page: a.annotationPageLabel || "",
          color: a.annotationColor,
          isBot: !!a.annotationAuthorName && a.annotationAuthorName === bot,
          author: a.annotationAuthorName || "",
          sortIndex: a.annotationSortIndex || "",
          attachmentID: att.id,
        };
      })
      .sort((x, y) => (x.sortIndex < y.sortIndex ? -1 : x.sortIndex > y.sortIndex ? 1 : 0));
  }

  /** Set an annotation's verdict: replaces verdict tags and sets the matching colour. kind null clears. */
  async function setKind(annotationKeyOrItem, libraryID, kind) {
    const a = typeof annotationKeyOrItem === "object" ? annotationKeyOrItem : Zotero.Items.getByLibraryAndKey(libraryID, annotationKeyOrItem);
    if (!a?.isAnnotation?.()) throw new Error("Annotation not found");
    for (const t of a.getTags()) if (kindOfTag(t.tag)) a.removeTag(t.tag);
    if (kind) {
      a.addTag(kind);
      a.annotationColor = KINDS[kind].color;
    }
    await a.saveTx();
    return a;
  }

  /** Open the PDF at an annotation. */
  function open(annotation) {
    return Zotero.Reader.open(annotation.attachmentID, { annotationID: annotation.key });
  }

  // The reference list says nothing about eligibility but is often a fifth of a paper
  const BACK = /\n[ \t]*(?:\d{1,2}\.?|[IVX]{1,4}\.)?[ \t]*(references|bibliography|literature cited|works cited|reference list|literatur|literaturverzeichnis|quellen|quellenverzeichnis|références|bibliographie|referencias|bibliografía|riferimenti bibliografici)[ \t]*:?[ \t]*\n/gi;

  /** The text without its reference list (cut at the last such heading in the second half). */
  function withoutReferences(text) {
    let cut = -1;
    for (const m of String(text).matchAll(BACK)) if (m.index > text.length * 0.5) cut = m.index;
    return cut > 0 ? { text: text.slice(0, cut), dropped: text.length - cut } : { text, dropped: 0 };
  }

  /**
   * Let the AI annotate a paper's full text for a review. Writes Zotero annotations and
   * returns {created, notFound, total, summary}.
   */
  async function annotateWithAI({ item, protocol, profile, max = 10, onStatus = () => {} }) {
    const att = pdfOf(item);
    if (!att) throw new Error("No PDF attached");
    onStatus("Reading the PDF's text…");
    const doc = await documentOf(att, { onProgress: (p) => onStatus(`Zotero is analysing the PDF… ${Math.round(p)}%`) });
    // Long texts: the passages that matter for the criteria (local model), else the beginning
    const budget = 45000;
    // quotes are still found in the whole document; the AI just does not read the references
    let text = withoutReferences(doc.text.replace(/\n{3,}/g, "\n\n")).text;
    if (text.length > budget) {
      const queries = [...(protocol.inclusion || []), ...(protocol.exclusion || []), ...(protocol.questions || [])];
      text = ZR.Embed?.isAvailable() && queries.length ? await ZR.Embed.passages(`sdt:${att.libraryID}/${att.key}`, text, queries, { budget }) : text.slice(0, budget);
    }
    onStatus("The AI is reading the paper…");
    const out = await ZR.Assist.annotateFullText(profile, protocol, { title: item.getField("title"), text }, { max });
    let created = 0;
    const notFound = [];
    const existing = annotationsOf(item);
    for (const a of out.annotations) {
      // don't annotate the same passage twice
      if (existing.some((e) => e.text && a.quote && U.titleSimilarity(e.text, a.quote) > 0.9)) continue;
      const saved = await saveAnnotation(att, doc, { quote: a.quote, kind: a.kind, comment: a.comment });
      if (saved) created++;
      else notFound.push(a.quote);
    }
    return { created, notFound, total: out.annotations.length, summary: out.summary };
  }

  // -------------------------------------------------------------- the reader ----
  /** Review projects a paper belongs to (by collection). */
  async function projectsFor(item) {
    const parent = item.isAttachment?.() && item.parentItem ? item.parentItem : item;
    const keys = new Set(parent.getCollections().map((id) => Zotero.Collections.get(id)?.key));
    return (await ZR.Projects.list(parent.libraryID)).filter((p) => p.kind === "review" && keys.has(p.collectionKey));
  }

  function _reset() {
    docs.clear();
  }

  return { KINDS, kindOfTag, botName, runRects, buildDocument, locate, position, pdfOf, documentOf, saveAnnotation, annotationsOf, setKind, open, annotateWithAI, withoutReferences, projectsFor, _reset };
})();

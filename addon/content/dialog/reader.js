/* global App, el, document, window, Zotero */
"use strict";

// Reading a paper while screening: text with overlapping marks (your highlights, search
// terms), one sentence per paragraph (optional), mapping a selection back to character
// offsets, the right-click menu, the note editor, and the "Screening highlights" note
// that carries your highlights into Zotero.

const PaperView = (window.PaperView = (() => {
  const KINDS = {
    include: { label: "include", bg: "rgba(46, 160, 67, 0.38)" },
    maybe: { label: "maybe", bg: "rgba(234, 179, 8, 0.42)" },
    exclude: { label: "exclude", bg: "rgba(220, 38, 38, 0.32)" },
    note: { label: "note", bg: "rgba(59, 130, 246, 0.32)" },
  };
  const NOTE_TAG = "zr:highlights";

  // Abbreviations that end with a period but do not end a sentence
  const ABBREV = /(^|\s)(e\.g|i\.e|et al|al|fig|figs|vs|cf|etc|no|vol|approx|ca|resp|eq|ref|refs|incl|dr|prof|st|z\.b|d\.h|u\.a|bzw|vgl|ggf|[A-Z])\.$/i;

  /** Sentence ranges [start, end) of a text. */
  function sentences(text) {
    const out = [];
    let start = 0;
    const re = /[.!?…](["”’)\]]*)\s+(?=[\p{Lu}\p{N}"“(\[])/gu;
    for (let m; (m = re.exec(text)); ) {
      const end = m.index + 1 + m[1].length;
      if (ABBREV.test(text.slice(Math.max(start, m.index - 12), m.index + 1))) continue;
      out.push([start, end]);
      start = m.index + m[0].length;
    }
    if (start < text.length) out.push([start, text.length]);
    return out;
  }

  /**
   * Render text with overlapping ranges ({start, end, cls, title?, attrs?}). Every piece of
   * text sits in a span whose data-o is its offset in `text`, so selections map back.
   */
  function render(container, text, ranges = [], { paragraphs = false } = {}) {
    container.replaceChildren();
    text = String(text || "");
    const blocks = paragraphs ? sentences(text) : [[0, text.length]];
    for (const [bs, be] of blocks) {
      const block = paragraphs ? el("p", { class: "sentence" }) : container;
      const points = new Set([bs, be]);
      for (const r of ranges) {
        if (r.end <= bs || r.start >= be) continue;
        points.add(Math.max(bs, r.start));
        points.add(Math.min(be, r.end));
      }
      const sorted = [...points].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (b <= a) continue;
        const span = el("span", { "data-o": String(a) });
        span.textContent = text.slice(a, b);
        const cover = ranges.filter((r) => r.start < b && r.end > a);
        if (cover.length) {
          span.className = [...new Set(cover.map((r) => r.cls))].join(" ");
          for (const r of cover) for (const [k, v] of Object.entries(r.attrs || {})) span.setAttribute(k, v);
          const titles = cover.map((r) => r.title).filter(Boolean);
          if (titles.length) span.title = titles.join("\n");
        }
        block.append(span);
      }
      if (paragraphs) container.append(block);
    }
  }

  function offsetOf(container, node, off) {
    if (node.nodeType === 3) {
      const span = node.parentElement?.closest("[data-o]");
      return span && container.contains(span) ? Number(span.dataset.o) + off : null;
    }
    const child = node.childNodes[off];
    if (child) {
      const span = child.nodeType === 1 ? (child.matches("[data-o]") ? child : child.querySelector("[data-o]")) : child.parentElement?.closest("[data-o]");
      if (span) return Number(span.dataset.o);
    }
    const inside = [...container.querySelectorAll("[data-o]")].filter((s) => node.contains(s));
    const last = inside[inside.length - 1];
    return last ? Number(last.dataset.o) + last.textContent.length : null;
  }

  /** The selection inside container as {start, end, text}, or null. */
  function selection(container, text) {
    const sel = container.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!container.contains(r.commonAncestorContainer)) return null;
    let start = offsetOf(container, r.startContainer, r.startOffset);
    let end = offsetOf(container, r.endContainer, r.endOffset);
    if (start == null || end == null || end <= start) return null;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return end > start ? { start, end, text: text.slice(start, end) } : null;
  }

  // ------------------------------------------------------------ context menu ----
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function place(node, x, y) {
    document.body.append(node);
    const r = node.getBoundingClientRect();
    node.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    node.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }

  /** items: [{label, kind?, run}] or "-" for a separator */
  function openMenu(x, y, items) {
    closeMenu();
    menu = el(
      "div",
      { class: "ctx-menu", role: "menu" },
      items.map((it) =>
        it === "-"
          ? el("div", { class: "ctx-sep" })
          : el("button", { class: "ctx-item", role: "menuitem", "data-kind": it.kind || "", onclick: () => (closeMenu(), it.run()) }, [el("span", { class: "ctx-dot" + (it.kind ? " hl-" + it.kind : "") }), it.label])
      )
    );
    place(menu, x, y);
  }

  // ---------------------------------------------------------------- note editor ----
  let pop = null;
  function closePop() {
    pop?.remove();
    pop = null;
  }

  /** Small in-window editor for a highlight's note (no modal dialogs). */
  function editNote(x, y, initial, onSave) {
    closePop();
    const ta = el("textarea", { rows: "3", placeholder: "Your note on this passage… (Ctrl+Enter saves)" });
    ta.value = initial || "";
    const save = () => {
      const v = ta.value.trim();
      closePop();
      onSave(v);
    };
    pop = el("div", { class: "note-pop" }, [ta, el("div", { class: "actions" }, [el("button", { class: "primary", text: "Save note", onclick: save }), el("button", { text: "Cancel", onclick: closePop })])]);
    ta.addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), save()));
    place(pop, x, y);
    setTimeout(() => ta.focus(), 0);
  }

  document.addEventListener("mousedown", (e) => menu && !menu.contains(e.target) && closeMenu(), true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && (menu || pop) && (closeMenu(), closePop()));
  window.addEventListener("blur", closeMenu);

  // --------------------------------------------------------------- search terms ----
  /** Positive terms of every query that fed the project (protocol, searches). */
  function queryTerms(project) {
    const ZR = App.ZR;
    const queries = [...new Set([project?.protocol?.query, project?.search?.query, ...(project?.runs || []).map((r) => r.query)].filter(Boolean))];
    const terms = [];
    for (const q of queries) {
      try {
        for (const t of ZR.Query.termNodes(ZR.Query.parse(q))) if (!terms.some((x) => x.text.toLowerCase() === t.text.toLowerCase() && x.field === t.field)) terms.push(t);
      } catch (e) {
        /* an AI-mode request, not a query */
      }
    }
    return terms;
  }

  /** Ranges of the terms that apply to a field (unfielded terms: title and abstract). */
  function termRanges(text, terms, field) {
    const applicable = terms.filter((t) => (field === "author" ? t.field === "author" : !t.field || t.field === field));
    return applicable.length ? App.ZR.Query.termRanges(text || "", applicable) : [];
  }

  // ----------------------------------------------------------- note in Zotero ----
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function noteHTML(title, highlights) {
    const rows = highlights
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((h) => `<p><span style="background-color: ${KINDS[h.kind].bg}">“${esc(h.text)}”</span><br/><strong>${esc(KINDS[h.kind].label)}</strong>${h.note ? ": " + esc(h.note) : ""}</p>`)
      .join("");
    return `<h2>Screening highlights</h2><p><em>Marked in the abstract of “${esc(title)}” while screening (Zotero Researcher).</em></p>${rows}`;
  }

  /** Create, update or remove the item's "Screening highlights" child note. */
  async function syncNote(itemID, title, highlights) {
    const item = Zotero.Items.get(itemID);
    if (!item?.isRegularItem()) return;
    let note = item
      .getNotes()
      .map((id) => Zotero.Items.get(id))
      .find((n) => n?.hasTag(NOTE_TAG));
    if (!highlights.length) {
      if (note) await note.eraseTx();
      return;
    }
    if (!note) {
      note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentID = item.id;
      note.addTag(NOTE_TAG);
    }
    note.setNote(noteHTML(title, highlights));
    await note.saveTx();
  }

  return { KINDS, NOTE_TAG, sentences, render, selection, openMenu, closeMenu, editNote, closePop, queryTerms, termRanges, noteHTML, syncNote };
})());

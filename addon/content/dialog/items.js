/* global Zotero, App, $, el */
"use strict";

// "Selected items" tab: fix metadata (deterministic or AI), find PDFs, AI comparison,
// related papers.

App.panels.items = (() => {
  let ZR;
  const selState = new Map(); // itemID -> {status, message, proposal, open, error, ok}
  let compareHTML = "";
  const st = (m) => App.status("items", m);

  function init() {
    ZR = App.ZR;
    App.fillProfileSelect($("llm-profile-2"));
    $("fix-meta").addEventListener("click", () => runEnrich("det"));
    $("fix-meta-ai").addEventListener("click", () => runEnrich("llm"));
    $("find-pdfs").addEventListener("click", runFindPDFs);
    $("find-related").addEventListener("click", () => App.panels.search.runRelated(App.selectedItems()));
    $("compare-open").addEventListener("click", openCompare);
    $("find-similar").addEventListener("click", runSimilar);
    $("similar-close").addEventListener("click", () => ($("similar-box").hidden = true));
    $("compare-close").addEventListener("click", () => ($("compare-box").hidden = true));
    $("compare-run").addEventListener("click", runCompare);
    $("compare-save").addEventListener("click", saveCompare);
    $("apply-all").addEventListener("click", applyAll);
    $("overwrite").checked = ZR.Prefs.get("enrichOverwrite", false);
    $("overwrite").addEventListener("change", () => {
      ZR.Prefs.set("enrichOverwrite", $("overwrite").checked);
      for (const s of selState.values()) for (const c of s.proposal?.changes || []) if (c.kind === "overwrite") c.selected = $("overwrite").checked;
      render();
    });
  }

  function onShow() {
    render();
  }

  function hasSelectedChanges() {
    for (const s of selState.values()) {
      const p = s.proposal;
      if (p && (p.recognize || p.changes.some((c) => c.selected) || p.typeChange?.selected)) return true;
    }
    return false;
  }

  function render() {
    const list = $("selected-list");
    list.replaceChildren();
    const items = App.selectedItems();
    $("apply-bar").hidden = !hasSelectedChanges();
    if (!items.length) {
      list.append(
        el("div", { class: "empty-state" }, [
          el("div", { class: "empty-title", text: "No papers selected" }),
          el("div", { text: "Select one or more papers in Zotero’s item list, then click the Researcher button again. Here you can fill in missing metadata, find PDFs, compare papers with AI, or look for related work." }),
        ])
      );
      return;
    }
    for (const item of items) {
      const s = selState.get(item.id) || {};
      const c = ZR.Enrich.completeness(item);
      const pct = Math.round(c.score * 100);
      const title = item.isRegularItem() ? item.getField("title") || "(untitled)" : `📄 ${item.getField("title")} (file without parent item)`;
      const n = s.proposal?.changes?.length ?? 0;
      const statusText =
        s.status === "running"
          ? "working…"
          : s.message ||
            (s.proposal ? (s.proposal.recognize ? "will run Zotero’s PDF recognizer" : n || s.proposal.typeChange ? `${n} change(s) found. Click to review` : "already up to date") : c.missing.length ? "missing: " + c.missing.slice(0, 3).join(", ") : "complete");
      const head = el("div", { class: "sel-head", onclick: () => ((s.open = !s.open), selState.set(item.id, s), render()) }, [
        el("div", { class: "meter", title: `${pct}% of key metadata present${c.missing.length ? "\nMissing: " + c.missing.join(", ") : ""}` }, el("div", { class: pct >= 80 ? "good" : pct >= 50 ? "mid" : "low", style: `width:${pct}%` })),
        el("div", { class: "t", text: title, title }),
        el("div", { class: "st " + (s.error ? "error" : s.proposal || s.ok ? "ok" : ""), text: statusText }),
      ]);
      const wrap = el("div", { class: "sel-item" }, head);
      if (s.proposal && !s.proposal.recognize) {
        const p = s.proposal;
        const body = el("div", { class: "sel-body", hidden: !s.open });
        body.append(el("div", { class: "src-line", text: "Source: " + p.source }));
        const t = el("table", { class: "diff" });
        if (p.typeChange) t.append(diffRow(p.typeChange, "Item Type", p.typeChange.from, p.typeChange.to, "overwrite"));
        for (const ch of p.changes) t.append(diffRow(ch, ch.label, ch.old, ch.new, ch.kind));
        if (!p.changes.length && !p.typeChange) t.append(el("tr", {}, el("td", { colspan: 4, text: "No differences found." })));
        body.append(t);
        wrap.append(body);
      }
      list.append(wrap);
    }
  }

  function diffRow(obj, label, oldV, newV, kind) {
    return el("tr", { class: kind }, [
      el("td", {}, el("input", { type: "checkbox", checked: obj.selected, onchange: (e) => ((obj.selected = e.target.checked), ($("apply-bar").hidden = !hasSelectedChanges())) })),
      el("td", { text: label }),
      el("td", { class: "old", text: ZR.Util.truncate(oldV || "-", 300) }),
      el("td", { class: "new", text: ZR.Util.truncate(newV, 600) }),
    ]);
  }

  async function runEnrich(kind) {
    App.showTab("items");
    const items = App.selectedItems();
    if (!items.length) return st("Select papers first.");
    let profile = null;
    if (kind === "llm") {
      try {
        profile = App.profile();
      } catch (e) {
        return st(e.message);
      }
    }
    App.setBusy("items", true);
    const overwrite = $("overwrite").checked;
    let done = 0;
    let found = 0;
    await ZR.Util.mapLimit(items, 2, async (item) => {
      selState.set(item.id, { status: "running", open: selState.get(item.id)?.open });
      render();
      let s;
      try {
        const p = kind === "llm" ? await ZR.Enrich.llmAssisted(item, profile, { overwrite }) : await ZR.Enrich.deterministic(item, { overwrite });
        if (p.error) s = { error: true, message: p.error };
        else {
          s = { proposal: p, open: items.length <= 3 };
          found++;
        }
      } catch (e) {
        Zotero.logError(e);
        s = { error: true, message: e.message };
      }
      selState.set(item.id, s);
      done++;
      st(`Looked up ${done} of ${items.length}…`);
      render();
    });
    App.setBusy("items", false);
    render();
    st(found ? `Found metadata for ${found} of ${items.length}. Review the changes (click a paper), then “Apply checked changes”.` : `No new metadata found for ${items.length} paper(s).`);
  }

  async function applyAll() {
    App.setBusy("items", true);
    let n = 0;
    let failed = 0;
    for (const [id, s] of selState) {
      const p = s.proposal;
      if (!p || !(p.recognize || p.changes.some((c) => c.selected) || p.typeChange?.selected)) continue;
      try {
        await ZR.Enrich.apply(p);
        selState.set(id, { ok: true, message: "updated" });
        n++;
      } catch (e) {
        Zotero.logError(e);
        selState.set(id, { error: true, message: "could not apply: " + e.message });
        failed++;
      }
    }
    App.setBusy("items", false);
    render();
    st(`Updated ${n} paper(s)${failed ? `, ${failed} failed` : ""}.`);
  }

  async function runFindPDFs() {
    App.showTab("items");
    const items = App.selectedItems().filter((i) => i.isRegularItem());
    if (!items.length) return st("Select papers (not notes or files) first.");
    App.setBusy("items", true);
    let got = 0;
    let had = 0;
    let done = 0;
    await ZR.Util.mapLimit(items, 2, async (item) => {
      if (ZR.Importer.hasFile(item)) {
        had++;
        selState.set(item.id, { ok: true, message: "already has a PDF" });
      } else {
        selState.set(item.id, { status: "running" });
        render();
        const att = await ZR.Importer.attachFullText(item);
        if (att) got++;
        selState.set(item.id, att ? { ok: true, message: "PDF attached" } : { error: true, message: "no legally accessible PDF found" });
      }
      done++;
      st(`Checked ${done} of ${items.length}…`);
      render();
    });
    App.setBusy("items", false);
    st(`PDFs added: ${got} · already had one: ${had} · not found: ${items.length - got - had}`);
  }

  function openCompare() {
    App.showTab("items");
    $("compare-box").hidden = false;
    $("compare-instruction").focus();
  }

  async function runCompare() {
    const items = App.selectedItems().filter((i) => i.isRegularItem());
    if (items.length < 2) return st("Select at least two papers to compare.");
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    App.setBusy("items", true);
    try {
      const papers = [];
      for (const item of items.slice(0, 20)) {
        let fulltext = "";
        if ($("compare-fulltext").checked) {
          for (const id of item.getAttachments()) {
            const att = Zotero.Items.get(id);
            if (!att?.isFileAttachment()) continue;
            try {
              fulltext = (await att.attachmentText) || "";
            } catch (e) {
              /* not indexed */
            }
            // Long texts: the passages that matter for the comparison (local model)
            if (fulltext.length > 5000 && ZR.Embed.isAvailable()) {
              try {
                fulltext = await ZR.Embed.passages(`att:${att.libraryID}/${att.key}`, fulltext, [$("compare-instruction").value.trim(), "research question and method", "findings and limitations"], { budget: 5000 });
              } catch (e) {
                ZR.Util.log("Passage retrieval failed", e.message);
              }
            }
            if (fulltext) break;
          }
        }
        papers.push({
          title: item.getField("title"),
          authors: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join(", "),
          year: ZR.Util.yearOf(item.getField("date")),
          venue: item.getField("publicationTitle") || "",
          doi: item.getField("DOI") || "",
          abstract: item.getField("abstractNote"),
          fulltext,
        });
      }
      st(`Asking ${profile.name} to compare ${papers.length} papers…`);
      compareHTML = await ZR.Assist.compare(profile, papers, $("compare-instruction").value.trim());
      $("compare-output").innerHTML = compareHTML;
      $("compare-save").disabled = !App.target.editable;
      st("Comparison ready. Save it as a note to keep it with the collection.");
    } catch (e) {
      Zotero.logError(e);
      st("Comparison failed: " + e.message);
    } finally {
      App.setBusy("items", false);
    }
  }

  /** Papers in the library most similar to the selected ones (local embeddings). */
  async function runSimilar() {
    const selected = App.selectedItems().filter((i) => i.isRegularItem());
    if (!selected.length) return st("Select one or more papers in Zotero first.");
    App.setBusy("items", true);
    try {
      if (!(await ZR.Embed.available())) {
        const s = ZR.Embed.status;
        return st(`The local model is not available: ${s?.error || "turned off in Settings"}. See Settings → Local models.`);
      }
      const all = (await Zotero.Items.getAll(App.target.libraryID, true, false)).filter((i) => i.isRegularItem() && (i.getField("title") || i.getField("abstractNote")));
      const papers = all.map(ZR.Embed.itemPaper);
      const vecs = await ZR.Embed.paperVectors(papers, { onProgress: (d, n) => st(`The local model is reading your library: ${d}/${n} (first time only)…`) });
      const selKeys = new Set(selected.map((i) => ZR.Embed.itemPaper(i).key));
      const byKey = new Map(papers.map((p) => [p.key, p]));
      const best = new Map();
      for (const key of selKeys) {
        const v = vecs.get(key);
        if (!v) continue;
        for (const hit of ZR.Embed.nearest(v, vecs, 12, selKeys)) if (!best.has(hit.key) || best.get(hit.key) < hit.sim) best.set(hit.key, hit.sim);
      }
      const hits = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      $("similar-title").textContent = `Most similar to ${selected.length === 1 ? "“" + ZR.Util.truncate(selected[0].getField("title"), 70) + "”" : selected.length + " selected papers"} in ${Zotero.Libraries.get(App.target.libraryID).name}`;
      $("similar-list").replaceChildren(
        ...(hits.length
          ? hits.map(([key, sim]) => {
              const p = byKey.get(key);
              const item = Zotero.Items.get(p.itemID);
              const cols = App.ZR.UI.collectionsOf(item).map((c) => c.label.split(" › ").pop());
              return el("div", { class: "similar-row" }, [
                el("span", { class: "sim " + (sim >= 0.8 ? "hi" : sim >= 0.65 ? "md" : "lo"), text: Math.round(sim * 100) + "%", title: "Content similarity (cosine)" }),
                el("div", {}, [
                  el("a", { href: "#", text: p.title || "(untitled)", onclick: (e) => (e.preventDefault(), App.ZR.UI.revealItem(p.itemID, { preferCollectionID: App.target.collectionID })) }),
                  el("div", { class: "hint", text: [item.getCreators()[0]?.lastName, ZR.Util.yearOf(item.getField("date")), cols.length ? "in " + cols.join(", ") : "unfiled"].filter(Boolean).join(" · ") }),
                ]),
              ]);
            })
          : [el("div", { class: "hint", text: "No other papers with a title or abstract in this library." })])
      );
      $("similar-box").hidden = false;
      st(`${hits.length} similar paper(s): computed on this computer by ${ZR.Embed.config().model}. Click one to show it in Zotero.`);
    } catch (e) {
      Zotero.logError(e);
      st("Similar papers failed: " + e.message);
    } finally {
      App.setBusy("items", false);
    }
  }

  async function saveCompare() {
    if (!compareHTML) return;
    const items = App.selectedItems().filter((i) => i.isRegularItem());
    const e = ZR.Util.escapeHTML;
    const header =
      `<h1>AI comparison: ${e(new Date().toISOString().slice(0, 10))}</h1>` +
      `<p><em>Instruction:</em> ${e($("compare-instruction").value.trim())}</p>` +
      `<p><em>Papers:</em></p><ul>${items.map((i) => `<li>${e(i.getField("title"))}</li>`).join("")}</ul>`;
    const note = await ZR.Importer.createNote(header + compareHTML, { libraryID: App.target.libraryID, collectionID: App.target.collectionID });
    // Relations are stored on both sides.
    for (const item of items) {
      note.addRelatedItem(item);
      item.addRelatedItem(note);
      await item.saveTx();
    }
    await note.saveTx();
    st("Saved as a note in " + App.target.label);
  }

  return { init, onShow, runEnrich, runFindPDFs, openCompare, runSimilar };
})();

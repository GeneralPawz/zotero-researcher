/* global Zotero, App, $, el, document, DOMParser */
"use strict";

// Review tab: PRISMA 2020 workflow bound to the target collection.
//   1 Find papers  — logged searches (Search tab adds papers as zr:unscreened)
//   2 Screen       — title/abstract: include / maybe / exclude (+ reason)
//   3 Full text    — included papers: include / exclude (+ reason), PDF at hand
//   4 PRISMA       — flow diagram from runs + tags; save as note / export SVG
// Decisions are tags on the items (see lib/store.js), so they survive the plugin.

App.panels.review = (() => {
  let ZR;
  let step = "identify";
  let currentID = null;
  const suggestions = new Map(); // `${itemKey}|${stage}` -> {d, r, c, why}
  const st = (m) => App.status("review", m);

  function init() {
    ZR = App.ZR;
    $("rv-create").addEventListener("click", createOrSave);
    $("rv-edit").addEventListener("click", () => showSetup(true));
    $("rv-cancel-edit").addEventListener("click", () => refresh());
    $("rv-add-search").addEventListener("click", () => App.showTab("search"));
    for (const b of $("review-steps").children) b.addEventListener("click", () => go(b.dataset.step));
    $("queue-filter").addEventListener("change", () => renderScreen());
    $("ai-suggest").addEventListener("click", aiSuggest);
    $("ai-accept").addEventListener("click", aiAccept);
    $("prisma-note").addEventListener("click", saveNote);
    $("prisma-svg").addEventListener("click", exportSVG);
    document.addEventListener("keydown", onKey);
  }

  const collection = () => App.collection();
  const stage = () => (step === "ft" ? "ft" : "ta");

  async function onShow() {
    await refresh();
  }

  async function refresh() {
    await App.refreshReview();
    const col = collection();
    $("review-setup").hidden = true;
    $("review-main").hidden = true;
    if (!col) {
      $("review-setup").hidden = false;
      $("review-setup").querySelector(".card").replaceChildren(
        el("h2", { text: "Reviews live in a collection" }),
        el("p", { class: "hint", text: "Select (or create) a collection in Zotero, then open Researcher again to start a PRISMA review for it." })
      );
      return;
    }
    if (!App.review) return showSetup(false);
    $("review-main").hidden = false;
    await updateSteps();
    await go(step);
  }

  function showSetup(editing) {
    const r = App.review || ZR.Prisma.newReview();
    $("review-setup").hidden = false;
    $("review-main").hidden = true;
    for (const t of document.querySelectorAll(".review-target")) t.textContent = `“${App.target.label.split(" › ").pop()}”`;
    $("rv-question").value = r.question || "";
    $("rv-include").value = r.include || "";
    $("rv-exclude").value = r.exclude || "";
    $("rv-reasons").value = (r.reasons || ZR.Prisma.DEFAULT_REASONS).join("\n");
    $("rv-create").textContent = editing ? "Save changes" : "Start review";
    $("rv-cancel-edit").hidden = !editing;
  }

  async function createOrSave() {
    if (!App.target.editable) return st("This library is read-only.");
    const review = App.review || ZR.Prisma.newReview();
    review.question = $("rv-question").value.trim();
    review.include = $("rv-include").value.trim();
    review.exclude = $("rv-exclude").value.trim();
    review.reasons = $("rv-reasons").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!review.reasons.length) review.reasons = ZR.Prisma.DEFAULT_REASONS.slice();
    await ZR.Store.saveReview(App.target.libraryID, App.target.collectionKey, review);
    await ZR.Store.flush(App.target.libraryID);
    st("Review saved. Papers already in this collection are part of the screening list.");
    await refresh();
  }

  async function updateSteps() {
    const col = collection();
    const items = ZR.Prisma.reviewItems(col).map(ZR.Prisma.itemState);
    const decidedTA = items.filter((i) => i.ta).length;
    const incl = items.filter((i) => i.ta === "include");
    $("st-identify").textContent = `${(App.review.runs || []).length} searches`;
    $("st-ta").textContent = `${decidedTA}/${items.length}`;
    $("st-ft").textContent = `${incl.filter((i) => i.ft).length}/${incl.length}`;
    $("st-prisma").textContent = `${incl.filter((i) => i.ft === "include").length} included`;
  }

  async function go(s) {
    step = s;
    for (const b of $("review-steps").children) b.classList.toggle("on", b.dataset.step === s);
    $("step-identify").hidden = s !== "identify";
    $("step-screen").hidden = s !== "ta" && s !== "ft";
    $("step-prisma").hidden = s !== "prisma";
    if (s === "identify") renderIdentify();
    else if (s === "prisma") await renderPrisma();
    else {
      currentID = null;
      await loadSuggestions();
      renderScreen();
    }
  }

  // ------------------------------------------------------------ identify ----
  function renderIdentify() {
    const r = App.review;
    $("rv-question-view").textContent = r.question || "(no question written — click Edit setup)";
    const runs = r.runs || [];
    const box = $("rv-runs");
    box.replaceChildren();
    if (!runs.length) {
      box.append(el("p", { class: "hint", text: "No searches logged yet. Click “Search & add papers”: every search you add from will be recorded here for the PRISMA report." }));
      return;
    }
    box.append(
      el("table", { class: "runs" }, [
        el("tr", {}, ["When", "How", "Query", "Found", "Added"].map((t) => el("th", { text: t }))),
        ...runs.map((x) =>
          el("tr", {}, [
            el("td", { text: x.at || "" }),
            el("td", { text: x.mode === "related" ? "citations" : x.mode }),
            el("td", {}, el("code", { text: ZR.Util.truncate(x.query || "", 120) })),
            el("td", { text: String(x.identified ?? "") }),
            el("td", { text: String(x.imported ?? "") }),
          ])
        ),
      ])
    );
  }

  // ------------------------------------------------------------- screening ----
  function population() {
    const items = ZR.Prisma.reviewItems(collection()).map(ZR.Prisma.itemState);
    return stage() === "ft" ? items.filter((i) => i.ta === "include") : items;
  }

  function filtered() {
    const f = $("queue-filter").value;
    const s = stage();
    return population().filter((i) => {
      const d = i[s];
      if (f === "todo") return !d;
      if (f === "all") return true;
      return d === f;
    });
  }

  async function loadSuggestions() {
    for (const i of population()) {
      const k = `${i.item.key}|${stage()}`;
      if (!suggestions.has(k)) {
        const sg = await ZR.Store.getSuggestion(App.target.libraryID, i.item.key, stage());
        if (sg) suggestions.set(k, sg);
      }
    }
  }

  function renderScreen() {
    // "Maybe" only exists at title/abstract stage
    $("queue-filter").querySelector('option[value="maybe"]').hidden = stage() === "ft";
    const list = filtered();
    const box = $("queue");
    box.replaceChildren();
    $("queue-count").textContent = `${list.length} paper(s)`;
    if (!list.some((i) => i.item.id === currentID)) currentID = list[0]?.item.id ?? null;
    for (const i of list) {
      const sg = suggestions.get(`${i.item.key}|${stage()}`);
      const d = i[stage()];
      box.append(
        el("div", { class: "q-item" + (i.item.id === currentID ? " current" : ""), onclick: () => ((currentID = i.item.id), renderScreen()) }, [
          el("span", { class: `dot ${d || ""}${!d && sg ? " ai" : ""}`, title: d || (sg ? `AI suggests ${sg.d}` : "not decided") }),
          el("span", { class: "q-t", text: i.item.getField("title") || "(untitled)" }),
        ])
      );
    }
    renderCard(list.find((i) => i.item.id === currentID));
    $("ai-suggest").textContent = `✦ AI suggestions for ${list.filter((i) => !i[stage()]).length} undecided`;
    updateSteps();
  }

  function renderCard(state) {
    const box = $("screen-card");
    box.replaceChildren();
    if (!state) {
      const pop = population();
      box.append(
        el("div", { class: "empty-state" }, [
          el("div", { class: "empty-title", text: pop.length ? "Nothing left in this list 🎉" : stage() === "ft" ? "No papers included yet" : "No papers to screen yet" }),
          el("div", {
            text: pop.length
              ? stage() === "ta"
                ? "Continue with step 3 to check the full texts of included papers."
                : "Open step 4 for the PRISMA flow diagram."
              : stage() === "ft"
                ? "Include papers in step 2 first."
                : "Add papers from the Search tab — they are queued here automatically.",
          }),
        ])
      );
      return;
    }
    const item = state.item;
    const s = stage();
    const reasons = App.review.reasons || ZR.Prisma.DEFAULT_REASONS;
    const doi = item.getField("DOI");
    const sg = suggestions.get(`${item.key}|${s}`);
    const current = state[s];
    const reasonSel = el("select", { id: "reason-select", title: "Exclusion reason (keys 1–9)" }, reasons.map((r, i) => el("option", { value: r, text: `${i + 1}. ${r}`, selected: state.reason === r || (!state.reason && sg?.r === r) })));
    const card = el("div", { class: "paper-card" }, [
      el("h2", { text: item.getField("title") || "(untitled)" }),
      el("div", { class: "meta", text: [item.getCreators().map((c) => c.lastName).slice(0, 4).join(", "), ZR.Util.yearOf(item.getField("date")), item.getField("publicationTitle") || item.getField("proceedingsTitle") || ""].filter(Boolean).join(" · ") }),
      el("div", { class: "actions" }, [
        doi ? el("button", { class: "link", text: "doi:" + doi, onclick: () => Zotero.launchURL("https://doi.org/" + doi) }) : null,
        el("button", { class: "link", text: "Show in Zotero", onclick: () => Zotero.getMainWindow()?.ZoteroPane.selectItem(item.id) }),
        s === "ft" ? pdfButton(state) : null,
      ]),
      sg
        ? el("div", { class: "ai-box" }, [
            el("span", {}, [el("b", { text: `AI suggests: ${sg.d}` }), sg.r ? ` — ${sg.r}` : "", sg.c != null ? ` (${Math.round(sg.c * 100)}% sure)` : ""]),
            el("span", { class: "hint", text: sg.why || "" }),
            el("span", { class: "spacer" }),
            el("button", { text: "Accept", onclick: () => decide(state, sg.d, sg.r, "llm") }),
          ])
        : null,
      el("div", { class: "abstract", text: item.getField("abstractNote") || "No abstract. Use “Fix metadata” in the Selected items tab, or open the paper." }),
      el("div", { class: "decide" }, [
        el("button", { class: "inc" + (current === "include" ? " on" : ""), onclick: () => decide(state, "include") }, ["Include", el("kbd", { text: "I" })]),
        s === "ta" ? el("button", { class: "may" + (current === "maybe" ? " on" : ""), onclick: () => decide(state, "maybe") }, ["Maybe", el("kbd", { text: "M" })]) : null,
        el("button", { class: "exc" + (current === "exclude" ? " on" : ""), onclick: () => decide(state, "exclude", reasonSel.value) }, ["Exclude", el("kbd", { text: "E" })]),
        reasonSel,
        el("span", { class: "spacer" }),
        current ? el("button", { class: "link", text: "undo decision", onclick: () => decide(state, null) }) : null,
        el("span", { class: "hint", text: "↑/↓ to move" }),
      ]),
    ]);
    box.append(card);
  }

  function pdfButton(state) {
    const att = state.item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .find((a) => a?.isFileAttachment());
    if (att) return el("button", { text: "Open PDF", onclick: () => Zotero.Reader.open(att.id) });
    return el("button", {
      text: "Find PDF",
      onclick: async (e) => {
        e.target.disabled = true;
        st("Looking for a PDF…");
        const ok = await ZR.Importer.attachFullText(state.item);
        st(ok ? "PDF attached." : "No legally accessible PDF found — you can attach one by hand.");
        renderScreen();
      },
    });
  }

  async function decide(state, d, reason = "", by = "me") {
    if (!App.target.editable) return st("This library is read-only.");
    await ZR.Store.decide({
      libraryID: App.target.libraryID,
      item: state.item,
      stage: stage(),
      d,
      r: d === "exclude" ? reason || $("reason-select")?.value || "" : "",
      by,
      collectionKey: App.target.collectionKey,
    });
    // Advance to the next undecided paper in the list
    if (d) {
      const list = filtered();
      const idx = list.findIndex((i) => i.item.id === state.item.id);
      const next = list.slice(idx + 1).find((i) => !i[stage()]) || list.find((i) => !i[stage()] && i.item.id !== state.item.id);
      currentID = next ? next.item.id : state.item.id;
    }
    renderScreen();
  }

  function onKey(e) {
    if (App.currentTab !== "review" || (step !== "ta" && step !== "ft")) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const list = filtered();
    const state = list.find((i) => i.item.id === currentID);
    const key = e.key.toLowerCase();
    if (key === "arrowdown" || key === "j" || key === "arrowup" || key === "k") {
      const idx = list.findIndex((i) => i.item.id === currentID);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + (key === "arrowdown" || key === "j" ? 1 : -1)))];
      if (next) {
        currentID = next.item.id;
        renderScreen();
      }
      e.preventDefault();
      return;
    }
    if (!state) return;
    if (/^[1-9]$/.test(key)) {
      const sel = $("reason-select");
      if (sel && sel.options[Number(key) - 1]) sel.selectedIndex = Number(key) - 1;
      e.preventDefault();
    } else if (key === "i") decide(state, "include");
    else if (key === "m" && stage() === "ta") decide(state, "maybe");
    else if (key === "e") decide(state, "exclude", $("reason-select")?.value);
  }

  async function aiSuggest() {
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    const todo = filtered().filter((i) => !i[stage()]);
    if (!todo.length) return st("Nothing undecided in this list.");
    App.setBusy("review", true);
    try {
      const papers = [];
      for (const i of todo) {
        const item = i.item;
        let fulltext = "";
        if (stage() === "ft") {
          const att = item.getAttachments().map((id) => Zotero.Items.get(id)).find((a) => a?.isFileAttachment());
          try {
            fulltext = att ? (await att.attachmentText) || "" : "";
          } catch (e) {
            /* not indexed yet */
          }
        }
        papers.push({ title: item.getField("title"), year: ZR.Util.yearOf(item.getField("date")), venue: item.getField("publicationTitle"), abstract: item.getField("abstractNote"), fulltext });
      }
      const out = await ZR.Assist.screenCriteria(profile, App.review, papers, stage(), { onProgress: (d, n) => st(`AI is reading ${d}/${n}…`) });
      let n = 0;
      for (let k = 0; k < todo.length; k++) {
        if (!out[k]) continue;
        suggestions.set(`${todo[k].item.key}|${stage()}`, out[k]);
        await ZR.Store.setSuggestion(App.target.libraryID, todo[k].item.key, stage(), out[k]);
        n++;
      }
      st(`AI suggested decisions for ${n} of ${todo.length} papers — they are marked with a ring. Review them, or accept the confident ones.`);
    } catch (e) {
      st("AI suggestions failed: " + e.message);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  async function aiAccept() {
    const todo = filtered().filter((i) => !i[stage()]);
    let n = 0;
    for (const i of todo) {
      const sg = suggestions.get(`${i.item.key}|${stage()}`);
      if (!sg || (sg.c ?? 0) < 0.8) continue;
      await ZR.Store.decide({ libraryID: App.target.libraryID, item: i.item, stage: stage(), d: sg.d, r: sg.r, by: "llm", collectionKey: App.target.collectionKey });
      n++;
    }
    st(n ? `Accepted ${n} confident AI suggestion(s). They are recorded as “by AI”.` : "No undecided suggestions with ≥ 80 % confidence.");
    renderScreen();
  }

  // --------------------------------------------------------------- PRISMA ----
  let lastSVG = "";
  async function renderPrisma() {
    const c = await ZR.Prisma.counts(App.target.libraryID, collection());
    lastSVG = ZR.Prisma.svg(c, { title: `PRISMA 2020 — ${App.target.label.split(" › ").pop()}` });
    const doc = new DOMParser().parseFromString(lastSVG, "image/svg+xml");
    $("prisma-view").replaceChildren(document.importNode(doc.documentElement, true));
    st(c.pendingTA || c.pendingFT ? `Still to do: ${c.pendingTA} title/abstract and ${c.pendingFT} full-text decision(s).` : "All papers screened.");
  }

  async function saveNote() {
    const c = await ZR.Prisma.counts(App.target.libraryID, collection());
    await ZR.Importer.createNote(ZR.Prisma.noteHTML(c, App.review, App.target.label), { libraryID: App.target.libraryID, collectionID: App.target.collectionID });
    st("PRISMA summary saved as a note in the collection.");
  }

  async function exportSVG() {
    if (!lastSVG) await renderPrisma();
    const f = await App.saveFile(lastSVG, "prisma-flow.svg", "SVG image", "*.svg");
    if (f) st("Saved " + f);
  }

  return { init, onShow, refresh };
})();

/* global Zotero, App, $, el, document, window, DOMParser, PaperView, Autopilot */
"use strict";

// Review tab: a methodology-based pipeline for the current project.
//   Protocol  – choose a methodology, then describe the goal in plain words (the AI fills
//               the form) or fill the form by hand. The form depends on the methodology.
//   Search    – logged searches; results go into the project's candidate pool.
//   Screen    – the funnel: a System 1 model estimates for every paper how likely it is
//               to be relevant; thresholds settle the clear cases in bulk, the AI reasons
//               about the uncertain middle, you decide the rest. Included papers are
//               added to the Zotero collection.
//   Full text / quality / extraction / classification – as the methodology requires.
//   Report    – PRISMA flow diagram from the logged searches and every decision.
// Decisions are item tags plus the library ledger (lib/store.js), so they survive the plugin.

App.panels.review = (() => {
  let ZR;
  let step = null;
  let cands = [];
  let currentKey = null;
  let protocolMode = null; // "describe" | "form"; null = pick automatically
  let draft = null; // protocol being edited: {id, methodology, protocol, full, recommended}
  let lastSVG = "";
  const st = (m) => App.status("review", m);
  const project = () => (App.project?.kind === "review" ? App.project : null);
  const method = () => ZR.Methodologies.get(project()?.methodology);
  const libraryID = () => App.target.libraryID;
  const dstage = () => (step === "fulltext" ? "ft" : "ta"); // decision stage
  const today = () => new Date().toISOString().slice(0, 10);
  const pct = (p) => (p == null ? "–" : Math.round(p * 100) + "%");
  const ENGINE_NAMES = { typesafe: "TypeSafe Jev", local: "the local model", llm: "your AI provider", rules: "keyword rules" };

  function init() {
    ZR = App.ZR;
    $("rv-start-btn").addEventListener("click", startReview);
    for (const b of $("rv-protocol-mode").children) b.addEventListener("click", () => setProtocolMode(b.dataset.mode));
    $("rv-fill").addEventListener("click", fillWithAI);
    $("rv-description").addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !App.busy && fillWithAI());
    $("rv-save").addEventListener("click", saveProtocol);
    $("rv-next").addEventListener("click", () => nextStage() && go(nextStage()));
    $("rv-add-search").addEventListener("click", () => {
      App.reviewFlow = true; // adding to the pool continues with screening
      App.panels.search.loadProject();
      App.showTab("search");
    });
    $("queue-filter").addEventListener("change", () => renderScreen());
    $("queue-sort").addEventListener("change", () => renderScreen());
    $("s1-rate").addEventListener("click", () => rateS1());
    $("s1-low").addEventListener("change", saveThresholds);
    $("s1-high").addEventListener("change", saveThresholds);
    $("s1-exclude").addEventListener("click", (e) => armed(e.target, () => bulk("exclude")));
    $("s1-include").addEventListener("click", (e) => armed(e.target, () => bulk("include")));
    $("ai-uncertain").addEventListener("click", aiUncertain);
    $("ai-accept").addEventListener("click", aiAccept);
    $("rv-table-ai").addEventListener("click", tableAI);
    $("rv-table-csv").addEventListener("click", tableCSV);
    $("rv-table-cluster").addEventListener("click", clusterFacet);
    $("rv-table-full").addEventListener("click", () => (ZR.Prefs.set("tableFullHeaders", !ZR.Prefs.get("tableFullHeaders", false)), renderTable()));
    $("prisma-note").addEventListener("click", saveNote);
    $("prisma-svg").addEventListener("click", exportSVG);
    document.addEventListener("keydown", onKey);
  }

  async function onShow() {
    await refresh();
  }

  /** Forget per-project UI state (after switching or creating a project). */
  function reset() {
    step = null;
    draft = null;
    protocolMode = null;
    currentKey = null;
    cands = [];
  }

  async function refresh() {
    const p = project();
    $("rv-start").hidden = !!p;
    $("rv-main").hidden = !p;
    if (!p) return renderStart();
    if (draft && draft.id !== p.id) reset();
    await ZR.Embed.available().catch(() => false); // local model on this computer? (checked at most once a minute)
    cands = await ZR.Projects.candidates(libraryID(), p);
    if (!step || !method().stages.includes(step)) step = firstOpenStage();
    renderFunnel();
    await go(step);
  }

  const protocolFilled = (pr) => !!(pr && (pr.questions?.length || pr.objective || pr.inclusion?.length));

  function firstOpenStage() {
    const p = project();
    if (!protocolFilled(p.protocol)) return "protocol";
    if (!cands.length) return "search";
    return "screen";
  }

  // ---------------------------------------------------------------- start ----
  function renderStart() {
    const q = App.project;
    const col = App.target.collectionKey ? App.target.label.split(" › ").pop() : "";
    if (q && q.kind === "quick") {
      $("rv-start-title").textContent = `Turn “${q.name}” into a structured review`;
      $("rv-start-btn").textContent = "Convert to a structured review";
    } else {
      $("rv-start-title").textContent = col ? `Start a structured review for “${col}”` : "Start a structured review";
      $("rv-start-btn").textContent = "New review project…";
    }
  }

  async function startReview() {
    const q = App.project;
    if (!(q && q.kind === "quick")) return App.newProject("review");
    if (!App.target.editable) return st("This library is read-only.");
    const s = q.search || {};
    const protocol = { title: q.name, query: s.query, yearFrom: s.yearFrom, yearTo: s.yearTo, languages: s.languages, types: s.types };
    App.project = await ZR.Projects.convert(libraryID(), q.id, "prisma2020", protocol);
    if (s.request) App.project.description = s.request;
    await App.loadProjects(App.project.id);
    reset();
    st(`“${q.name}” is now a structured review — its search settings and history are kept. Choose a methodology and describe what you want to achieve.`);
    await refresh();
  }

  // --------------------------------------------------------------- funnel ----
  function renderFunnel() {
    const p = project();
    const box = $("rv-funnel");
    box.replaceChildren(el("span", { class: "funnel-name", title: method().reference, text: method().name }));
    ZR.Projects.funnel(p, cands).forEach((s, i) => {
      if (i) box.append(el("span", { class: "funnel-arrow", text: "›" }));
      box.append(el("span", { class: "funnel-stage" }, [el("b", { text: s.n.toLocaleString() }), " " + s.label]));
    });
    const rated = cands.filter((c) => c.s1).length;
    if (cands.length) box.append(el("span", { class: "hint funnel-s1", text: `System 1 rated ${rated}/${cands.length}` }));
    const ap = p.autopilot;
    box.append(
      el("button", {
        id: "ap-open",
        class: "ap-open-btn" + (ap?.on ? " on" : ""),
        title: "An AI runs the review with you, step by step",
        text: ap?.on ? (Autopilot.isRunning() ? "✦ Autopilot running" : "✦ Autopilot (paused)") : "✦ Autopilot",
        onclick: () => Autopilot.show(),
      })
    );
    renderSteps();
  }

  function stepInfo(s) {
    const p = project();
    const pop = cands.filter((c) => ZR.Projects.inStage(p, s, c));
    switch (s) {
      case "protocol":
        return protocolFilled(p.protocol) ? "✓" : "to do";
      case "search":
        return String((p.runs || []).length);
      case "screen":
        return `${cands.filter((c) => c.ta).length}/${cands.length}`;
      case "fulltext":
        return `${pop.filter((c) => c.ft).length}/${pop.length}`;
      case "quality":
        return `${pop.filter((c) => c.qa?.some(Boolean)).length}/${pop.length}`;
      case "extract":
      case "classify":
        return `${pop.filter((c) => c.extract && Object.values(c.extract).some(Boolean)).length}/${pop.length}`;
      default:
        return "";
    }
  }

  function renderSteps() {
    $("rv-steps").replaceChildren(
      ...method().stages.map((s, i) =>
        el("button", { "data-step": s, class: s === step ? "on" : "", title: ZR.Methodologies.STAGES[s].label, onclick: () => go(s) }, [el("span", { class: "num", text: String(i + 1) }), el("span", { class: "st-label", text: ZR.Methodologies.STAGES[s].short }), el("small", { text: stepInfo(s) })])
      )
    );
  }

  async function go(s) {
    if (step === "protocol" && s !== "protocol" && protocolMode === "form") readForm(); // keep unsaved edits
    step = s;
    for (const b of $("rv-steps").children) b.classList.toggle("on", b.dataset.step === s);
    $("rv-protocol").hidden = s !== "protocol";
    $("rv-search").hidden = s !== "search";
    $("rv-screen").hidden = s !== "screen" && s !== "fulltext";
    $("rv-table").hidden = !["quality", "extract", "classify"].includes(s);
    $("rv-report").hidden = s !== "report";
    if (s === "protocol") renderProtocol();
    else if (s === "search") renderSearch();
    else if (s === "screen" || s === "fulltext") {
      currentKey = null;
      renderScreen();
    } else if (s === "report") await renderReport();
    else renderTable();
  }

  // ------------------------------------------------------------- protocol ----
  function ensureDraft() {
    const p = project();
    if (!draft || draft.id !== p.id) {
      draft = { id: p.id, methodology: p.methodology, protocol: JSON.parse(JSON.stringify(p.protocol || ZR.Methodologies.emptyProtocol(p.methodology))), full: null, recommended: null };
      $("rv-description").value = p.description || "";
      $("rv-fill-note").textContent = "";
      $("rv-save-note").textContent = "";
    }
    return draft;
  }

  const nextStage = () => {
    const stages = method()?.stages || [];
    return stages[stages.indexOf(step) + 1] || null;
  };

  function renderNext() {
    const next = nextStage();
    const saved = protocolFilled(project().protocol) && draft?.methodology === project().methodology;
    $("rv-next").hidden = !next || !saved;
    if (next) $("rv-next").textContent = `Next: ${ZR.Methodologies.STAGES[next].label} →`;
  }

  function renderProtocol() {
    ensureDraft();
    renderMethods();
    renderNext();
    setProtocolMode(protocolMode || (protocolFilled(draft.protocol) ? "form" : "describe"));
  }

  function setProtocolMode(mode) {
    if (protocolMode === "form" && mode !== "form") readForm();
    protocolMode = mode;
    for (const b of $("rv-protocol-mode").children) b.classList.toggle("on", b.dataset.mode === mode);
    $("rv-describe").hidden = mode !== "describe";
    $("rv-form").hidden = mode !== "form";
    $("rv-save").closest(".rv-save-row").hidden = mode !== "form";
    if (mode === "form") renderForm();
    else setTimeout(() => $("rv-description").focus(), 0);
  }

  function renderMethods() {
    // Once a protocol exists, show only the chosen methodology (changing it stays one click away)
    const collapsed = protocolFilled(project().protocol) && !draft.showAll;
    const list = collapsed ? ZR.Methodologies.LIST.filter((m) => m.id === draft.methodology) : ZR.Methodologies.LIST;
    $("rv-methods").replaceChildren(
      ...list.map((m) =>
        el("button", { class: "method" + (m.id === draft.methodology ? " on" : ""), "data-method": m.id, title: m.reference, onclick: () => chooseMethod(m.id) }, [
          el("b", { text: m.name }),
          el("span", { text: m.short }),
          el("small", { text: m.stages.slice(1, -1).map((s) => ZR.Methodologies.STAGES[s].label).join(" → ") }),
        ])
      ),
      ...(collapsed ? [el("button", { class: "link method-change", text: "Change methodology…", onclick: () => ((draft.showAll = true), renderMethods()) })] : [])
    );
    $("rv-method-current").textContent = draft.methodology !== project().methodology ? "Changed — save the protocol to apply it." : "";
    renderNext();
  }

  function chooseMethod(id) {
    if (protocolMode === "form") readForm();
    // Keep what was entered for fields the new methodology doesn't use, in case of switching back
    const full = Object.assign({}, draft.full, draft.protocol);
    // A framework left at the methodology's default follows the new methodology's default
    if (full.framework === ZR.Methodologies.get(draft.methodology).framework) full.framework = ZR.Methodologies.get(id).framework;
    draft.full = full;
    draft.methodology = id;
    draft.protocol = ZR.Methodologies.normalizeProtocol(id, draft.full);
    if (draft.recommended?.methodology === id) draft.recommended = null;
    renderMethods();
    if (protocolMode === "form") renderForm();
  }

  function picks(id, items, chosen) {
    return el(
      "div",
      { class: "picks", id },
      items.map((it) =>
        el("button", {
          class: "pick",
          "data-v": it.id,
          "aria-pressed": String(chosen.includes(it.id)),
          text: it.label,
          onclick: (e) => e.target.setAttribute("aria-pressed", String(e.target.getAttribute("aria-pressed") !== "true")),
        })
      )
    );
  }

  function renderForm() {
    const M = ZR.Methodologies;
    const m = M.get(draft.methodology);
    const P = draft.protocol;
    const box = $("rv-form");
    box.replaceChildren();
    const row = (id, label, hint, controls) => el("div", { class: "pf-row", "data-field": id }, [el("span", { class: "pf-label", text: label }), el("div", { class: "pf-controls" }, controls), hint ? el("span", { class: "hint pf-hint", text: hint }) : null]);
    const textarea = (id, value, rows, cls = "") => {
      const t = el("textarea", { id, rows: String(rows), class: cls, spellcheck: "true" });
      t.value = value || "";
      return t;
    };
    if (draft.recommended) {
      const rec = M.get(draft.recommended.methodology);
      box.append(
        el("div", { class: "ai-box" }, [
          el("span", {}, [el("b", { text: `The AI suggests: ${rec.name}` }), draft.recommended.why ? ` — ${draft.recommended.why}` : ""]),
          el("span", { class: "spacer" }),
          el("button", { text: "Switch and re-fill", onclick: () => (chooseMethod(rec.id), fillWithAI()) }),
          el("button", { class: "link", text: "keep", onclick: () => ((draft.recommended = null), renderForm()) }),
        ])
      );
    }
    for (const f of m.fields) {
      const F = M.FIELDS[f];
      if (F.type === "text") box.append(row(f, F.label, F.hint, [el("input", { type: "text", id: `pf-${f}`, value: P[f] || "" })]));
      else if (F.type === "textarea") box.append(row(f, F.label, F.hint, [textarea(`pf-${f}`, P[f], 2)]));
      else if (F.type === "list") box.append(row(f, F.label, F.hint, [textarea(`pf-${f}`, (P[f] || []).join("\n"), Math.min(8, Math.max(2, (P[f] || []).length + 1)))]));
      else if (F.type === "query") {
        const fb = el("span", { class: "hint", id: "pf-query-fb" });
        const t = textarea("pf-query", P.query, 2, "mono");
        const check = () => {
          const q = t.value.trim();
          fb.className = "hint";
          if (!q) return (fb.textContent = "Used as the default query in the Search tab.");
          try {
            fb.textContent = "✓ " + ZR.Query.toCanonical(ZR.Query.parse(q));
            fb.classList.add("ok");
          } catch (e) {
            fb.textContent = "Query problem: " + e.message;
            fb.classList.add("error");
          }
        };
        t.addEventListener("input", check);
        check();
        box.append(row(f, F.label, F.hint, [t, fb]));
      } else if (F.type === "years")
        box.append(
          row(f, F.label, "", [
            el("input", { type: "number", id: "pf-yearFrom", min: "1900", max: "2100", placeholder: "from", value: P.yearFrom ?? "" }),
            el("span", { text: "–" }),
            el("input", { type: "number", id: "pf-yearTo", min: "1900", max: "2100", placeholder: "to", value: P.yearTo ?? "" }),
          ])
        );
      else if (F.type === "languages") box.append(row(f, F.label, "None selected = any language", [picks("pf-languages", ZR.Records.LANGUAGES.map((l) => ({ id: l.code, label: l.name })), P.languages || [])]));
      else if (F.type === "types") box.append(row(f, F.label, "None selected = any type", [picks("pf-types", ZR.Records.TYPE_FILTERS.map((t) => ({ id: t.id, label: t.label })), P.types || [])]));

      // The question framework (PICO, PCC, …) right after the research questions
      if (f === "questions") {
        const sel = el(
          "select",
          { id: "pf-framework", onchange: () => (readForm(), renderForm()) },
          m.frameworks.map((id) => el("option", { value: id, text: M.FRAMEWORKS[id].name, selected: id === P.framework }))
        );
        box.append(row("framework", "Question framework", "Breaks the question into parts that the screening models check", [sel]));
        for (const x of M.FRAMEWORKS[P.framework]?.fields || []) {
          box.append(row("fw-" + x.id, x.label, "", [el("input", { type: "text", id: `pf-fw-${x.id}`, "data-fw": x.id, value: P.frameworkFields?.[x.id] || "" })]));
        }
      }
    }
  }

  /** Read the form back into the draft protocol. */
  function readForm() {
    if (!draft || !$("rv-form").children.length) return;
    const M = ZR.Methodologies;
    const P = draft.protocol;
    const val = (id) => $(id)?.value ?? "";
    for (const f of M.get(draft.methodology).fields) {
      const t = M.FIELDS[f].type;
      if (t === "years") {
        P.yearFrom = parseInt(val("pf-yearFrom"), 10) || null;
        P.yearTo = parseInt(val("pf-yearTo"), 10) || null;
      } else if (!$(`pf-${f}`)) continue;
      else if (t === "text" || t === "textarea" || t === "query") P[f] = val(`pf-${f}`).trim();
      else if (t === "list")
        P[f] = val(`pf-${f}`)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      else if (t === "languages" || t === "types") P[f] = [...$(`pf-${f}`).querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.v);
    }
    const fw = {};
    for (const i of $("rv-form").querySelectorAll("[data-fw]")) fw[i.dataset.fw] = i.value.trim();
    P.frameworkFields = Object.assign({}, P.frameworkFields, fw);
    if ($("pf-framework")) P.framework = $("pf-framework").value;
  }

  async function fillWithAI() {
    ensureDraft();
    const text = $("rv-description").value.trim();
    if (!text) {
      setProtocolMode("describe");
      return st("Describe your review first: what you want to find out, why, and what counts.");
    }
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    App.setBusy("review", true);
    $("rv-fill-note").textContent = "The AI is drafting the protocol…";
    st(`The AI is drafting a ${ZR.Methodologies.get(draft.methodology).name} protocol…`);
    try {
      const p = project();
      const out = await ZR.Assist.fillProtocol(profile, draft.methodology, text, { query: p.search?.query, titles: cands.map((c) => c.title) });
      draft.protocol = out.protocol;
      draft.full = null;
      draft.recommended = out.recommended.methodology !== draft.methodology ? out.recommended : null;
      $("rv-fill-note").textContent = "";
      setProtocolMode("form");
      $("rv-save-note").textContent = "Filled in by the AI — check every field, then save.";
      st(out.rationale || "Protocol drafted. Review it, then save.");
    } catch (e) {
      $("rv-fill-note").textContent = "";
      st("The AI could not fill in the form: " + e.message);
    } finally {
      App.setBusy("review", false);
    }
  }

  async function saveProtocol() {
    if (!App.target.editable) return st("This library is read-only.");
    readForm();
    const protocol = ZR.Methodologies.normalizeProtocol(draft.methodology, draft.protocol);
    if (protocol.query) {
      try {
        ZR.Query.parse(protocol.query);
      } catch (e) {
        return st("Search query problem: " + e.message);
      }
    }
    await persistProtocol(draft.methodology, protocol, $("rv-description").value.trim());
    $("rv-save-note").textContent = `Saved ${new Date().toLocaleTimeString()}.`;
    st(cands.length ? "Protocol saved. Re-rate papers with System 1 if the criteria changed." : "Protocol saved. Next: find papers (step 2) — the search tab is pre-filled from the protocol.");
  }

  /** Save methodology + protocol; its search settings become the project's search settings. */
  async function persistProtocol(methodology, protocol, description) {
    const p = project();
    protocol = ZR.Methodologies.normalizeProtocol(methodology, protocol);
    p.methodology = methodology;
    p.protocol = protocol;
    if (description != null) p.description = description;
    p.search = Object.assign({}, p.search, { mode: "structured", query: protocol.query || p.search?.query || "", yearFrom: protocol.yearFrom, yearTo: protocol.yearTo, languages: protocol.languages, types: protocol.types });
    App.project = await ZR.Projects.save(libraryID(), p);
    draft = null;
    App.renderProjects();
    App.panels.search.loadProject();
    await refresh();
    return App.project;
  }

  // ------------------------------------------------------------ autopilot API ----
  /** Accept the AI's screening suggestions (any confidence); "maybe" goes on to full text by default. */
  async function acceptAll({ maybeAs = "include" } = {}) {
    const s = dstage();
    const list = population().filter((c) => !c[s] && suggestion(c));
    for (const c of list) {
      const d = c.llm.d === "maybe" && s === "ta" ? maybeAs : c.llm.d;
      await decide(c, d, c.llm.r, "llm", { advance: false, render: false });
    }
    renderScreen();
    return list.length;
  }

  /** Papers still undecided after thresholds and AI: follow System 1's suggestion (maybe → include). */
  async function decideRest() {
    const list = population().filter((c) => !c.ta && c.s1?.suggest);
    for (const c of list) await decide(c, c.s1.suggest.d === "exclude" ? "exclude" : "include", c.s1.suggest.r, "s1", { advance: false, render: false });
    renderScreen();
    return list.length;
  }

  async function decideByKey(key, stage, d, reason, by = "llm") {
    const c = cands.find((x) => x.key === key);
    if (!c) return false;
    const was = step;
    step = stage === "ft" ? "fulltext" : "screen";
    try {
      await decide(c, d, reason, by, { advance: false, render: false });
    } finally {
      step = was;
    }
    return true;
  }

  async function setThresholds({ excludeBelow, includeAbove }) {
    const p = project();
    p.funnel = { excludeBelow, includeAbove };
    await ZR.Projects.save(libraryID(), p);
  }

  const api = {
    persistProtocol,
    rate: (all) => rateS1(all),
    bulk,
    aiUncertain,
    acceptAll,
    decideRest,
    decideByKey,
    setThresholds,
    thresholds: () => thresholds(),
    population: () => population(),
    candidates: () => cands,
    method: () => method(),
    findPDFs,
    annotateAll,
    tableAI,
    saveNote,
    counts: () => counts(),
  };

  // --------------------------------------------------------------- search ----
  function renderSearch() {
    const p = project();
    const runs = p.runs || [];
    const box = $("rv-runs");
    box.replaceChildren();
    if (!runs.length) {
      box.append(el("p", { class: "hint", text: "No searches logged yet. The Search tab is pre-filled with the protocol's query and filters." }));
      return;
    }
    const open = (r, label) => App.panels.search.showRun(p, r, label);
    const stop = (fn) => (e) => (e.preventDefault(), e.stopPropagation(), fn());
    box.append(
      el("table", { class: "runs runs-click" }, [
        el("tr", {}, ["", "When", "How", "Query", "Found", "Not added", "Into pool"].map((t) => el("th", { text: t }))),
        ...ZR.Projects.runTree(runs).map(({ run: x, label, depth }) => {
          const notAdded = x.identified != null && x.imported != null ? Math.max(0, x.identified - x.imported) : null;
          return el("tr", { "data-run": x.id, title: "Click for every paper of this search and what happened to it", onclick: () => openAudit(x.id) }, [
            el("td", { class: "run-label", style: `padding-left:${6 + depth * 14}px`, title: x.parent ? "Refinement of an earlier search" : "Search" }, [depth ? "↳ " : "", el("b", { text: label })]),
            el("td", { text: x.at || "" }),
            el("td", { text: x.mode === "related" ? "citations" : x.mode }),
            el(
              "td",
              { title: "Open this search in the Search tab (read-only; you can edit and run it again)\n\n" + Object.entries(x.perSource || {}).map(([id, s]) => `${ZR.Sources.get(id)?.name || id}: ${s.error ? "⚠ " + s.error : s.count}`).join("\n") },
              el("a", { href: "#", class: "run-query", onclick: stop(() => open(x, label)) }, el("code", { text: ZR.Util.truncate(x.query || "(AI request)", 160) }))
            ),
            el("td", { text: String(x.identified ?? "") }),
            el("td", {}, notAdded ? el("a", { href: "#", class: "run-why", text: String(notAdded), title: "Why were these not added? Every paper of this search and what happened to it", onclick: stop(() => openAudit(x.id)) }) : el("span", { class: "hint", text: notAdded === 0 ? "0" : "" })),
            el("td", {}, x.imported ? el("a", { href: "#", class: "run-pool", text: String(x.imported), title: "Screen them (step 3)", onclick: stop(() => go("screen")) }) : el("span", { text: String(x.imported ?? "") })),
          ]);
        }),
      ])
    );
  }

  // ---------------------------------------------------------------- audit trail ----
  const STAGE_LABEL = { strict: "strict matching", filter: "filter", library: "already in library", excluded: "excluded earlier", selection: "not selected", pool: "pool" };
  const BY_LABEL = { me: "you", s1: "System 1", llm: "AI", dup: "duplicate check" };

  /** Where a paper ended up: the latest step of its chain. */
  function outcomeOf(row, c) {
    if (row.fate === "removed") return { outcome: "Not added", step: "search", reason: row.reason };
    if (row.fate === "unselected") return { outcome: "Not added", step: "search", reason: row.reason };
    if (!c) return { outcome: "In pool", step: "pool", reason: row.fate === "known" ? row.reason : "" };
    const hasFT = method().stages.includes("fulltext");
    const info = (d) => ({ reason: d.r || "", by: BY_LABEL[d.by] || d.by || "", at: d.at || "" });
    if (c.ftInfo?.d) return Object.assign({ outcome: c.ftInfo.d === "include" ? "Included" : "Excluded at full text", step: "full text" }, info(c.ftInfo));
    if (c.taInfo?.d) {
      const d = c.taInfo.d;
      const outcome = d === "exclude" ? "Excluded at screening" : d === "maybe" ? "Maybe (screening)" : hasFT ? "Passed screening" : "Included";
      return Object.assign({ outcome, step: "screening" }, info(c.taInfo));
    }
    return { outcome: "In pool — not screened yet", step: "pool", reason: row.fate === "known" ? row.reason : "" };
  }

  async function auditRows() {
    const p = project();
    const audit = await ZR.Projects.runAudit(libraryID(), p.id);
    const labels = ZR.Projects.runLabels(p.runs || []);
    // Fresh from the library: decisions carry who decided and when
    const fresh = await ZR.Projects.candidates(libraryID(), p);
    const byKey = new Map(fresh.map((c) => [c.key, c]));
    const rows = [];
    const seen = new Set();
    for (const run of p.runs || []) {
      for (const r of audit[run.id] || []) {
        const c = r.fate === "pool" || r.fate === "known" ? byKey.get(r.key) : null;
        if (c) seen.add(c.key);
        rows.push(Object.assign({ run: labels.get(run.id), runID: run.id, searchResult: r.fate === "removed" ? `not added: ${STAGE_LABEL[r.stage] || r.stage}` : r.fate === "unselected" ? "not selected" : r.fate === "known" ? "already in pool" : "added to pool" }, r, outcomeOf(r, c)));
      }
    }
    // Papers of the review that no recorded search brought in (in the collection already, older searches)
    for (const c of fresh) {
      if (seen.has(c.key)) continue;
      rows.push(Object.assign({ run: "—", runID: "", searchResult: c.itemID ? "in the collection" : "in pool (earlier search)", key: c.key, title: c.title, year: c.year, venue: c.venue, doi: c.doi, sources: c.record?.sources || [], creators: [] }, outcomeOf({ fate: "known" }, c)));
    }
    return rows;
  }

  async function openAudit(runID = "all") {
    const p = project();
    const rows = await auditRows();
    const runsWithoutAudit = (p.runs || []).filter((r) => !rows.some((x) => x.runID === r.id)).length;
    let fRun = runID;
    let fOutcome = "all";
    let fText = "";
    const OUT = [
      ["all", "All outcomes"],
      ["notadded", "Not added (search)"],
      ["excluded", "Excluded (screening / full text)"],
      ["included", "Included / passed"],
      ["open", "Not decided yet"],
    ];
    const matchOutcome = (r) =>
      fOutcome === "all" ||
      (fOutcome === "notadded" && r.outcome === "Not added") ||
      (fOutcome === "excluded" && /^Excluded/.test(r.outcome)) ||
      (fOutcome === "included" && /^(Included|Passed)/.test(r.outcome)) ||
      (fOutcome === "open" && /^(In pool|Maybe)/.test(r.outcome));
    const shown = () => rows.filter((r) => (fRun === "all" || r.runID === fRun) && matchOutcome(r) && (!fText || `${r.title} ${r.reason} ${r.outcome}`.toLowerCase().includes(fText)));
    const labels = ZR.Projects.runLabels(p.runs || []);
    const runSel = el(
      "select",
      { id: "audit-run", onchange: (e) => ((fRun = e.target.value), render()) },
      [el("option", { value: "all", text: "All searches" }), ...ZR.Projects.runTree(p.runs || []).map(({ run, label }) => el("option", { value: run.id, text: `${label} · ${run.at}`, selected: run.id === runID }))]
    );
    const outSel = el("select", { id: "audit-outcome", onchange: (e) => ((fOutcome = e.target.value), render()) }, OUT.map(([v, t]) => el("option", { value: v, text: t })));
    const search = el("input", { type: "search", placeholder: "filter…", oninput: (e) => ((fText = e.target.value.trim().toLowerCase()), render()) });
    const summary = el("div", { class: "audit-summary" });
    const table = el("div", { class: "audit-table scroll" });

    function render() {
      const list = shown();
      const runs = fRun === "all" ? p.runs || [] : (p.runs || []).filter((r) => r.id === fRun);
      const found = runs.reduce((n, r) => n + (r.identified || 0), 0);
      const merged = runs.reduce((n, r) => n + Math.max(0, (r.identified || 0) - (r.deduped || r.identified || 0)), 0);
      const count = (pred) => list.filter(pred).length;
      const byStage = {};
      for (const r of list.filter((x) => x.fate === "removed" || x.fate === "unselected")) byStage[STAGE_LABEL[r.stage] || r.stage] = (byStage[STAGE_LABEL[r.stage] || r.stage] || 0) + 1;
      summary.replaceChildren(
        el("span", {}, [el("b", { text: String(found) }), " found"]),
        el("span", { class: "hint", text: "›" }),
        el("span", { title: "The same paper found in several databases counts once" }, [el("b", { text: String(merged) }), " duplicates merged"]),
        el("span", { class: "hint", text: "›" }),
        el("span", { title: Object.entries(byStage).map(([k, v]) => `${k}: ${v}`).join("\n") }, [el("b", { text: String(count((r) => r.outcome === "Not added")) }), " not added (" + (Object.entries(byStage).map(([k, v]) => `${v} ${k}`).join(", ") || "—") + ")"]),
        el("span", { class: "hint", text: "›" }),
        el("span", {}, [el("b", { text: String(count((r) => r.outcome !== "Not added")) }), " in the review"]),
        el("span", { class: "hint", text: "›" }),
        el("span", { class: "k-exclude" }, [el("b", { text: String(count((r) => /^Excluded/.test(r.outcome))) }), " excluded"]),
        el("span", { class: "hint", text: "›" }),
        el("span", { class: "k-include" }, [el("b", { text: String(count((r) => /^(Included|Passed)/.test(r.outcome))) }), " included / passed"])
      );
      table.replaceChildren(
        el("table", { class: "runs audit" }, [
          el("tr", {}, ["Search", "Paper", "Year", "Found in", "Search result", "Outcome", "Reason", "By", "Date"].map((t) => el("th", { text: t }))),
          ...list.slice(0, 1500).map((r) =>
            el("tr", { class: /^Excluded|Not added/.test(r.outcome) ? "o-out" : /^(Included|Passed)/.test(r.outcome) ? "o-in" : "" }, [
              el("td", { text: r.run }),
              el("td", { class: "a-title", title: r.title }, [r.title || "(untitled)", r.doi ? el("div", { class: "hint", text: "doi:" + r.doi }) : null]),
              el("td", { text: String(r.year || "") }),
              el("td", { text: (r.sources || []).map((s) => ZR.Sources.get(s)?.name || s).join(", ") }),
              el("td", { text: r.searchResult }),
              el("td", { class: "a-outcome", text: r.outcome }),
              el("td", { text: r.reason || "" }),
              el("td", { text: r.by || "" }),
              el("td", { text: r.at || "" }),
            ])
          ),
        ]),
        list.length > 1500 ? el("div", { class: "hint", text: `…and ${list.length - 1500} more — export the CSV for the full list` }) : null
      );
      $("audit-count").textContent = `${list.length} of ${rows.length} rows`;
    }

    async function exportCSV() {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const head = ["Search", "Search date", "Title", "Authors", "Year", "Venue", "DOI", "Found in", "Search result", "Outcome", "Step", "Reason", "Decided by", "Decision date"];
      const at = new Map((p.runs || []).map((r) => [r.id, r.at]));
      const lines = [head.map(q).join(",")];
      for (const r of shown()) {
        lines.push(
          [r.run, at.get(r.runID) || "", r.title, (r.creators || []).map((c) => c.lastName || c.name).filter(Boolean).join("; "), r.year, r.venue, r.doi, (r.sources || []).map((s) => ZR.Sources.get(s)?.name || s).join("; "), r.searchResult, r.outcome, r.step, r.reason, r.by, r.at]
            .map(q)
            .join(",")
        );
      }
      const f = await App.saveFile("﻿" + lines.join("\r\n"), `${p.name.replace(/[^\w-]+/g, "_")}-audit-trail.csv`, "CSV", "*.csv");
      if (f) st("Saved " + f);
    }

    const layer = el("div", { class: "modal-layer", id: "audit-layer" }, [
      el("div", { class: "modal audit-modal", role: "dialog" }, [
        el("div", { class: "row-between" }, [
          el("h2", { text: `Audit trail — ${p.name}` }),
          el("button", { class: "icon-btn", text: "×", title: "Close", onclick: () => layer.remove() }),
        ]),
        el("p", { class: "hint", text: "Every paper your searches found and what happened to it: removed by a filter or option, added to the pool, and then screened, excluded or included — with the reason, who decided and when." + (runsWithoutAudit ? ` ${runsWithoutAudit} search(es) logged before version 0.7 have counts only.` : "") }),
        summary,
        el("div", { class: "audit-filters" }, [runSel, outSel, search, el("span", { class: "hint", id: "audit-count" }), el("span", { class: "spacer" }), el("button", { class: "primary", id: "audit-csv", text: "Export CSV", onclick: exportCSV })]),
        table,
      ]),
    ]);
    layer.addEventListener("keydown", (e) => e.key === "Escape" && layer.remove());
    document.body.append(layer);
    render();
  }

  // ------------------------------------------------------------ screening ----
  function population() {
    const p = project();
    return step === "fulltext" ? cands.filter((c) => ZR.Projects.inStage(p, "fulltext", c)) : cands;
  }

  const suggestion = (c) => (c.llm && c.llm.stage === dstage() ? c.llm : null);

  function filtered() {
    const f = $("queue-filter").value;
    const s = dstage();
    const list = population().filter((c) => (f === "todo" ? !c[s] : f === "all" ? true : c[s] === f));
    const sort = $("queue-sort").value;
    if (sort === "title") return list.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    const v = (c) => (c.s1 ? c.s1.p : sort === "p" ? -1 : 2); // unrated papers last
    return list.sort((a, b) => (sort === "p" ? v(b) - v(a) : v(a) - v(b)));
  }

  const thresholds = () => Object.assign(ZR.Projects.defaultFunnel(), project().funnel);
  function uncertain() {
    const s = dstage();
    const { excludeBelow, includeAbove } = thresholds();
    return population().filter((c) => !c[s] && (s === "ft" || !c.s1 || (c.s1.p >= excludeBelow && c.s1.p < includeAbove)));
  }

  function renderScreen() {
    const s = dstage();
    $("queue-filter").querySelector('option[value="maybe"]').hidden = s === "ft";
    const list = filtered();
    $("queue-count").textContent = `${list.length} paper(s)`;
    if (pendingFocus) {
      const hit = population().find((c) => c.itemID === pendingFocus);
      if (hit) {
        currentKey = hit.key;
        if (!list.includes(hit)) list.unshift(hit);
      }
      pendingFocus = null;
    }
    if (!list.some((c) => c.key === currentKey)) currentKey = list[0]?.key ?? null;
    const box = $("queue");
    box.replaceChildren();
    for (const c of list) {
      const d = c[s];
      const sg = suggestion(c);
      box.append(
        el("div", { class: "q-item" + (c.key === currentKey ? " current" : ""), "data-key": c.key, onclick: () => ((currentKey = c.key), renderScreen()) }, [
          el("span", { class: `dot ${d || ""}${!d && sg ? " ai" : ""}`, title: d ? `${d}${c.by === "s1" ? " (System 1)" : c.by === "llm" ? " (AI)" : ""}` : sg ? `AI suggests ${sg.d}` : "not decided" }),
          el("span", { class: "q-t", text: c.title || "(untitled)" }),
          c.dup && !d && s === "ta" ? el("span", { class: "q-dup", text: "⧉", title: "Possible duplicate" }) : null,
          s === "ft" ? annoCounts(c) : c.s1 ? el("span", { class: "q-p " + band(c.s1.p), text: pct(c.s1.p), title: "System 1: probability of relevance" }) : null,
        ])
      );
    }
    box.querySelector(".current")?.scrollIntoView({ block: "nearest" });
    renderCard(list.find((c) => c.key === currentKey));
    renderS1();
    renderFunnel();
  }

  /** ✓2 ?1 ✗1 — the verdicts of a paper's full-text annotations, for the queue. */
  function annoCounts(c) {
    if (!c.itemID) return null;
    const list = ZR.FullText.annotationsOf(Zotero.Items.get(c.itemID));
    if (!list.length) return null;
    const n = (k) => list.filter((a) => a.kind === k).length;
    return el("span", { class: "q-anno", title: `${list.length} annotation(s): ${n("include")} for, ${n("maybe")} maybe, ${n("exclude")} against` }, [
      n("include") ? el("span", { class: "k-include", text: "✓" + n("include") }) : null,
      n("maybe") ? el("span", { class: "k-maybe", text: "?" + n("maybe") }) : null,
      n("exclude") ? el("span", { class: "k-exclude", text: "✗" + n("exclude") }) : null,
    ]);
  }

  function band(p) {
    const { excludeBelow, includeAbove } = thresholds();
    return p < excludeBelow ? "lo" : p >= includeAbove ? "hi" : "md";
  }

  function renderS1() {
    const s = dstage();
    const ft = s === "ft";
    const pop = population();
    const todo = pop.filter((c) => !c[s]);
    const rated = pop.filter((c) => c.s1);
    const { excludeBelow, includeAbove } = thresholds();
    const eng = ZR.System1.engine();
    $("s1-engine").textContent = ft ? "" : `via ${ENGINE_NAMES[eng]}`;
    $("s1-engine").title = eng === "rules" ? "No System 1 model or AI is set up: papers are rated by whether they match the protocol's query. Add a TypeSafe key in Settings for real probabilities." : "";
    $("s1-panel").querySelector(".s1-head").hidden = ft;
    $("s1-rate").hidden = ft;
    const unrated = pop.filter((c) => !c.s1).length;
    $("s1-rate").textContent = unrated ? `Rate ${unrated} paper(s)` : "Re-rate all papers";
    $("s1-hist").hidden = ft || !rated.length;
    $("s1-thresholds").hidden = ft || !rated.length;
    if (!ft && rated.length) {
      // Histogram of the undecided papers' probabilities, coloured by threshold band
      const bins = new Array(10).fill(0);
      for (const c of todo) if (c.s1) bins[Math.min(9, Math.floor(c.s1.p * 10))]++;
      const max = Math.max(1, ...bins);
      $("s1-hist").replaceChildren(
        ...bins.map((n, i) =>
          el("div", { class: "bin " + band((i + 0.5) / 10), title: `${i * 10}–${i * 10 + 10}%: ${n} undecided paper(s)` }, el("div", { class: "bar", style: `height:${Math.round((n / max) * 100)}%` }))
        ),
        el("div", { class: "axis" }, [el("span", { text: "0%" }), el("span", { text: "not relevant ← → relevant" }), el("span", { text: "100%" })])
      );
      if (document.activeElement !== $("s1-low")) $("s1-low").value = Math.round(excludeBelow * 100);
      if (document.activeElement !== $("s1-high")) $("s1-high").value = Math.round(includeAbove * 100);
      const nLow = todo.filter((c) => c.s1 && c.s1.p < excludeBelow).length;
      const nHigh = todo.filter((c) => c.s1 && c.s1.p >= includeAbove).length;
      if (!$("s1-exclude").classList.contains("armed")) $("s1-exclude").textContent = `Exclude ${nLow}`;
      if (!$("s1-include").classList.contains("armed")) $("s1-include").textContent = `Include ${nHigh}`;
      $("s1-exclude").disabled = App.busy || !nLow;
      $("s1-include").disabled = App.busy || !nHigh;
    }
    const nUnc = uncertain().length;
    $("ai-uncertain").textContent = ft ? `✦ AI: check ${nUnc} full text(s)` : `✦ Ask AI about ${nUnc} uncertain`;
    $("ai-uncertain").title = ft ? "The AI reads the full texts (where Zotero has indexed them) and suggests a decision" : "The AI reasons about the papers between the thresholds (and unrated ones) and suggests a decision with a reason";
    $("ai-uncertain").disabled = App.busy || !nUnc;
    const nConf = todo.filter((c) => (suggestion(c)?.c ?? 0) >= 0.8).length;
    $("ai-accept").textContent = `accept ${nConf} confident AI suggestion(s)`;
    $("ai-accept").hidden = !nConf;
    let pdfs = $("ft-pdfs");
    if (!pdfs) {
      pdfs = el("button", { id: "ft-pdfs", onclick: findPDFs });
      $("s1-panel").append(pdfs);
    }
    const missing = pop.filter((c) => c.itemID && !c.hasPDF && !c.ft).length;
    pdfs.hidden = !ft || !missing;
    pdfs.textContent = `Find PDFs for ${missing} paper(s)`;
    let annoAll = $("ft-annotate");
    if (!annoAll) {
      annoAll = el("button", { id: "ft-annotate", "data-busy": "1", onclick: annotateAll, title: "The AI annotates every full text that has a PDF and no AI annotations yet" });
      $("s1-panel").append(annoAll);
    }
    const unannotated = ft ? pop.filter((c) => c.itemID && c.hasPDF && !c.ft).length : 0;
    annoAll.hidden = !ft || !unannotated;
    annoAll.textContent = "✦ AI: annotate the full texts";

    // Local model: duplicates and what it has learned from your decisions
    const local = ZR.Embed.isAvailable();
    let dup = $("dup-find");
    if (!dup) {
      dup = el("button", { id: "dup-find", onclick: (e) => (openDuplicates().length ? armed(e.target, excludeDuplicates, `Click again to exclude ${openDuplicates().length}`) : findDuplicates()) });
      $("s1-panel").append(dup);
    }
    dup.hidden = ft || !local || !pop.length;
    if (!dup.classList.contains("armed")) {
      const n = openDuplicates().length;
      dup.textContent = n ? `⧉ Exclude ${n} duplicate(s)` : "⧉ Find duplicates";
      dup.title = n ? "Excludes the less complete version of each pair (reason: Duplicate); the better-documented one stays" : "The local model looks for the same paper under different titles or versions (preprint vs. journal)";
    }
    let learn = $("s1-learn");
    if (!learn) {
      learn = el("div", { id: "s1-learn", class: "hint" });
      $("s1-panel").querySelector(".s1-head").after(learn);
    }
    learn.hidden = ft || !local || (eng !== "local" && ZR.Prefs.get("s1Blend", true) === false) || eng === "rules";
    if (!learn.hidden) {
      const labels = cands.filter(ZR.System1.isLabel);
      const pos = labels.filter((c) => c.ta === "include").length;
      const need = ZR.System1.MIN_LABELS;
      learn.textContent =
        pos >= need && labels.length - pos >= need
          ? `Learns from your ${labels.length} decisions and re-ranks as you screen.`
          : `Learns from your decisions once you have included ${need} and excluded ${need} papers yourself (now ${pos} / ${labels.length - pos}).`;
    }
  }

  // ------------------------------------------------ local model: learn, dedupe ----
  let relearnTimer = null;
  let relearning = false;

  /** After your own decisions: retrain the local model and re-rank what is left (active learning). */
  function scheduleRelearn() {
    clearTimeout(relearnTimer);
    relearnTimer = setTimeout(relearnNow, 600);
  }

  async function relearnNow() {
    const p = project();
    if (relearning || !p || !ZR.Embed.isAvailable()) return;
    relearning = true;
    try {
      const todo = cands.filter((c) => !c.ta && c.s1);
      const { results, trained, labels } = await ZR.System1.relearn(todo, p.protocol, cands);
      const n = Object.keys(results).length;
      if (!n) return;
      await ZR.Projects.setScores(libraryID(), p.id, "s1", results);
      for (const c of todo) if (results[c.key]) c.s1 = results[c.key];
      if (trained) st(`Re-ranked ${n} paper(s) with what the local model learned from ${labels} of your decisions.`);
      if (step === "screen" && App.currentTab === "review") renderScreen();
    } catch (e) {
      ZR.Util.log("Re-ranking failed", e.message);
    } finally {
      relearning = false;
    }
  }

  const openDuplicates = () => (dstage() === "ta" ? population().filter((c) => c.dup && !c.ta && cands.some((x) => x.key === c.dup.of)) : []);
  const dupReason = () => (project().protocol.reasons || []).find((r) => /duplicate/i.test(r)) || "Duplicate";

  /** Of two versions, which one to keep: in the library, not a preprint, with DOI, fuller abstract. */
  function completeness(c) {
    return (c.itemID ? 4 : 0) + (c.itemType && c.itemType !== "preprint" ? 2 : 0) + (c.doi ? 1 : 0) + Math.min(1, (c.abstract || "").length / 1500);
  }

  async function findDuplicates({ quiet = false } = {}) {
    const p = project();
    if (!quiet) App.setBusy("review", true);
    try {
      const vecs = await ZR.Embed.paperVectors(cands, { onProgress: (d, n) => st(`The local model is reading ${d}/${n} abstract(s) (first time only)…`) });
      const byKey = new Map(cands.map((c) => [c.key, c]));
      const dups = {};
      for (const { a, b, sim } of ZR.Embed.duplicates(cands, vecs)) {
        const [keep, drop] = completeness(byKey.get(a)) >= completeness(byKey.get(b)) ? [a, b] : [b, a];
        if (dups[keep] || dups[drop]) continue; // chains: one pair at a time
        dups[drop] = { of: keep, sim: Math.round(sim * 1000) / 1000 };
      }
      const pool = await ZR.Projects.loadPool(libraryID(), p.id);
      pool.dups = dups;
      await ZR.Projects.savePool(libraryID(), p.id);
      for (const c of cands) c.dup = dups[c.key] || null;
      const n = openDuplicates().length;
      if (!quiet) st(n ? `Found ${n} possible duplicate(s) — marked ⧉. Check them one by one, or exclude them all (the better-documented version stays).` : "No duplicates found.");
      return n;
    } catch (e) {
      if (!quiet) st("Duplicate check failed: " + e.message);
      return 0;
    } finally {
      if (!quiet) {
        App.setBusy("review", false);
        renderScreen();
      }
    }
  }

  async function excludeDuplicates() {
    const list = openDuplicates();
    App.setBusy("review", true);
    try {
      for (const c of list) await decide(c, "exclude", dupReason(), "dup", { advance: false, render: false });
      st(`Excluded ${list.length} duplicate(s) — reason “${dupReason()}”, recorded as “duplicate check”.`);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  async function notDuplicate(c) {
    const pool = await ZR.Projects.loadPool(libraryID(), project().id);
    delete pool.dups[c.key];
    await ZR.Projects.savePool(libraryID(), project().id);
    c.dup = null;
    renderScreen();
  }

  function dupBox(c, s) {
    if (!c.dup || c[s] || s !== "ta") return null;
    const other = cands.find((x) => x.key === c.dup.of);
    if (!other) return null;
    return el("div", { class: "dup-box" }, [
      el("span", {}, [el("b", { text: "⧉ Possible duplicate" }), ` of “${ZR.Util.truncate(other.title, 90)}” (${[other.year, other.venue].filter(Boolean).join(", ") || "n.d."}) — ${pct(c.dup.sim)} similar`]),
      el("span", { class: "spacer" }),
      el("button", { text: "Exclude as duplicate", onclick: () => decide(c, "exclude", dupReason(), "dup") }),
      el("button", { class: "link", text: "not a duplicate", onclick: () => notDuplicate(c) }),
    ]);
  }

  /** Two-click confirmation for bulk actions (no modal dialogs). */
  const arming = new Map();
  function armed(btn, fn, text) {
    if (arming.has(btn)) {
      clearTimeout(arming.get(btn));
      arming.delete(btn);
      btn.classList.remove("armed");
      return fn();
    }
    btn.textContent = text || `Click again to ${btn.id === "s1-include" ? "include" : "exclude"} ${btn.textContent.replace(/\D+/g, "")}`;
    btn.classList.add("armed");
    arming.set(
      btn,
      setTimeout(() => {
        arming.delete(btn);
        btn.classList.remove("armed");
        renderS1();
      }, 5000)
    );
  }

  async function saveThresholds() {
    const p = project();
    let low = Math.max(0, Math.min(100, parseInt($("s1-low").value, 10) || 0)) / 100;
    let high = Math.max(0, Math.min(100, parseInt($("s1-high").value, 10) || 100)) / 100;
    if (low > high) [low, high] = [high, low];
    p.funnel = { excludeBelow: low, includeAbove: high };
    await ZR.Projects.save(libraryID(), p);
    renderScreen();
  }

  /** Rate the pool with System 1: the unrated papers, or everything when all is set (or nothing is unrated). */
  async function rateS1(all = false) {
    const p = project();
    if (!protocolFilled(p.protocol)) return st("Write the protocol first (step 1): System 1 rates each paper against your research questions and criteria.");
    const pop = population();
    const unrated = pop.filter((c) => !c.s1);
    const list = all || !unrated.length ? pop : unrated;
    if (!list.length) return st("The pool is empty — add papers in step 2 first.");
    const eng = ZR.System1.engine();
    App.setBusy("review", true);
    let failed = 0;
    let lastError = "";
    try {
      st(`System 1 (${ENGINE_NAMES[eng]}) is rating ${list.length} paper(s)…`);
      const res = await ZR.System1.score(list, p.protocol, {
        engine: eng,
        all: cands,
        onProgress: (d, n, what) => st(what === "embedding" ? `The local model is reading ${d}/${n} abstract(s) (first time only)…` : `System 1 (${ENGINE_NAMES[eng]}) rated ${d}/${n}…`),
        onError: (c, e) => (failed++, (lastError = e.message)),
      });
      await ZR.Projects.setScores(libraryID(), p.id, "s1", res);
      for (const c of list) if (res[c.key]) c.s1 = res[c.key];
      const n = Object.keys(res).length;
      const learned = Object.values(res).find((r) => r.learned != null || r.trained);
      let dupNote = "";
      if (ZR.Embed.isAvailable()) {
        const found = await findDuplicates({ quiet: true });
        if (found) dupNote = ` Found ${found} possible duplicate(s) — marked ⧉.`;
      }
      st(
        `Rated ${n} paper(s) with ${ENGINE_NAMES[eng]}${learned ? ` (with what the local model learned from ${learned.labels} of your decisions)` : ""}${failed ? ` — ${failed} failed: ${lastError}` : ""}. Papers are sorted by probability; set the thresholds to settle the clear cases.${dupNote}`
      );
    } catch (e) {
      st("Rating failed: " + e.message);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  async function bulk(kind) {
    const p = project();
    const { excludeBelow, includeAbove } = thresholds();
    const todo = population().filter((c) => !c.ta && c.s1);
    const list = kind === "exclude" ? todo.filter((c) => c.s1.p < excludeBelow) : todo.filter((c) => c.s1.p >= includeAbove);
    if (!list.length) return;
    if (!App.target.editable) return st("This library is read-only.");
    App.setBusy("review", true);
    let n = 0;
    try {
      for (const c of list) {
        const r = kind === "exclude" ? (c.s1.suggest?.d === "exclude" && c.s1.suggest.r) || p.protocol.reasons?.[0] || "Off topic" : "";
        await decide(c, kind, r, "s1", { advance: false, render: false });
        if (++n % 5 === 0) st(`${kind === "exclude" ? "Excluding" : "Including"} ${n}/${list.length}…`);
      }
      st(`${kind === "exclude" ? "Excluded" : "Included"} ${n} paper(s) by System 1 threshold — marked “by System 1”; you can change any of them.${kind === "include" ? " They were added to the collection." : ""}`);
    } catch (e) {
      Zotero.logError(e);
      st(`Stopped after ${n}: ${e.message}`);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  /**
   * Full text of a paper's attachment. Long texts are cut down to the passages that
   * matter for `queries` (criteria, checklist, fields) when the local model is available;
   * otherwise the reader gets the beginning of the text.
   */
  async function fullText(c, queries = []) {
    if (!c.itemID) return "";
    const item = Zotero.Items.get(c.itemID);
    const att = item
      ?.getAttachments()
      .map((id) => Zotero.Items.get(id))
      .find((a) => a?.isFileAttachment());
    let text = "";
    try {
      text = att ? (await att.attachmentText) || "" : "";
    } catch (e) {
      return ""; // not indexed yet
    }
    if (text.length > 9000 && queries.length && ZR.Embed.isAvailable()) {
      try {
        return await ZR.Embed.passages(`att:${att.libraryID}/${att.key}`, text, queries);
      } catch (e) {
        ZR.Util.log("Passage retrieval failed", e.message);
      }
    }
    return text;
  }

  /** The protocol in the shape Assist.screenCriteria expects. */
  function criteriaOf(protocol) {
    const fw = ZR.Methodologies.FRAMEWORKS[protocol.framework];
    const parts = (fw?.fields || []).filter((f) => protocol.frameworkFields?.[f.id]).map((f) => `${f.label}: ${protocol.frameworkFields[f.id]}`);
    return {
      question: [(protocol.questions || []).join(" "), protocol.objective, parts.join("; ")].filter(Boolean).join(" — "),
      include: (protocol.inclusion || []).join("; "),
      exclude: (protocol.exclusion || []).join("; "),
      reasons: protocol.reasons,
    };
  }

  async function aiUncertain() {
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    const p = project();
    const s = dstage();
    const todo = uncertain();
    if (!todo.length) return st("No uncertain papers left in this step.");
    App.setBusy("review", true);
    try {
      const papers = [];
      const queries = [...(p.protocol.inclusion || []), ...(p.protocol.exclusion || []), ...(p.protocol.questions || [])];
      for (const c of todo) papers.push({ title: c.title, year: c.year, venue: c.venue, abstract: c.abstract, fulltext: s === "ft" ? await fullText(c, queries) : "" });
      const out = await ZR.Assist.screenCriteria(profile, criteriaOf(p.protocol), papers, s, { onProgress: (d, n) => st(`The AI is reading ${d}/${n}…`) });
      const map = {};
      todo.forEach((c, k) => {
        if (!out[k]) return;
        c.llm = map[c.key] = Object.assign({ stage: s, at: today(), model: profile.model }, out[k]);
      });
      await ZR.Projects.setScores(libraryID(), p.id, "llm", map);
      st(`The AI suggested decisions for ${Object.keys(map).length} of ${todo.length} paper(s) — marked with a ring. Check them, or accept the confident ones.`);
    } catch (e) {
      st("AI suggestions failed: " + e.message);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  async function aiAccept() {
    const s = dstage();
    const list = population().filter((c) => !c[s] && (suggestion(c)?.c ?? 0) >= 0.8);
    App.setBusy("review", true);
    let n = 0;
    try {
      for (const c of list) {
        await decide(c, c.llm.d, c.llm.r, "llm", { advance: false, render: false });
        n++;
      }
    } finally {
      App.setBusy("review", false);
    }
    st(n ? `Accepted ${n} confident AI suggestion(s) — recorded as “by AI”.` : "No undecided suggestions with ≥ 80 % confidence.");
    renderScreen();
  }

  async function findPDFs() {
    const list = population().filter((c) => c.itemID && !c.hasPDF && !c.ft);
    App.setBusy("review", true);
    let found = 0;
    try {
      for (const [i, c] of list.entries()) {
        st(`Looking for PDFs ${i + 1}/${list.length}…`);
        if (await ZR.Importer.attachFullText(Zotero.Items.get(c.itemID))) {
          c.hasPDF = true;
          found++;
        }
      }
      st(`Found ${found} of ${list.length} PDF(s). For the rest, attach the file by hand or exclude with “Full text not available”.`);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  function renderCard(c) {
    const box = $("screen-card");
    box.replaceChildren();
    PaperView.closeMenu();
    const s = dstage();
    if (!c) {
      const pop = population();
      box.append(
        el("div", { class: "empty-state" }, [
          el("div", { class: "empty-title", text: pop.length ? "Nothing left in this list 🎉" : s === "ft" ? "No papers passed screening yet" : "The pool is empty" }),
          el("div", {
            text: pop.length
              ? "Pick another filter, or continue with the next step."
              : s === "ft"
                ? "Include papers in the screening step first."
                : "Find papers in step 2 — search results are collected here for screening.",
          }),
        ])
      );
      return;
    }
    const p = project();
    const reasons = (p.protocol.reasons?.length ? p.protocol.reasons : ZR.Methodologies.DEFAULT_REASONS).slice();
    const sg = suggestion(c);
    const s1r = c.s1?.suggest?.d === "exclude" ? c.s1.suggest.r : "";
    const pre = c.reason || (sg?.d === "exclude" && sg.r) || s1r || "";
    if (pre && !reasons.includes(pre)) reasons.push(pre);
    const current = c[s];
    const reasonSel = el("select", { id: "reason-select", title: "Exclusion reason (keys 1–9)" }, reasons.map((r, i) => el("option", { value: r, text: `${i + 1}. ${ZR.Util.truncate(r, 70)}`, title: r, selected: r === pre })));
    const link = c.doi ? "https://doi.org/" + c.doi : c.record?.url || "";
    const showTerms = ZR.Prefs.get("showQueryTerms", true);
    const terms = showTerms ? termsOfProject() : [];
    const kw = (text, field) =>
      PaperView.termRanges(text, terms, field).map((r) => ({ start: r.start, end: r.end, cls: "kw" + (termFocus.has(r.term.toLowerCase()) ? " kw-focus" : ""), title: `search term: ${r.term}`, attrs: { style: `--kw-h:${termHue(terms, r.term)}`, "data-term": r.term.toLowerCase() } }));

    const title = el("h2");
    PaperView.render(title, c.title || "(untitled)", kw(c.title, "title"));
    const authors = el("span");
    PaperView.render(authors, c.authors || "", kw(c.authors, "author"));

    box.append(
      el("div", { class: "paper-card" }, [
        title,
        el("div", { class: "meta" }, [authors, [c.year, c.venue].filter(Boolean).map((x) => " · " + x).join("")]),
        el("div", { class: "actions" }, [
          link ? el("button", { class: "link", text: c.doi ? "doi:" + c.doi : "web page ↗", onclick: () => Zotero.launchURL(link) }) : null,
          c.itemID
            ? el("button", { class: "link", text: "Show in Zotero", onclick: () => App.ZR.UI.revealItem(c.itemID, { preferCollectionID: App.target.collectionID }) })
            : el("span", { class: "tag", text: "in the pool — added to Zotero when included", title: "Pool papers stay outside your library until they pass screening" }),
          s === "ft" && c.itemID && !ZR.FullText.pdfOf(Zotero.Items.get(c.itemID)) ? pdfButton(c) : null,
          el("span", { class: "spacer" }),
          el("button", {
            class: "toggle",
            "aria-pressed": String(showTerms),
            title: "Mark where the search terms of this project occur in title, authors and abstract",
            text: "Search terms",
            onclick: () => (ZR.Prefs.set("showQueryTerms", !showTerms), renderScreen()),
          }),
        ]),
        el("div", { class: "decide" }, [
          el("button", { class: "inc" + (current === "include" ? " on" : ""), onclick: () => decide(c, "include") }, ["Include", el("kbd", { text: "I" })]),
          s === "ta" ? el("button", { class: "may" + (current === "maybe" ? " on" : ""), onclick: () => decide(c, "maybe") }, ["Maybe", el("kbd", { text: "M" })]) : null,
          el("button", { class: "exc" + (current === "exclude" ? " on" : ""), onclick: () => decide(c, "exclude", reasonSel.value) }, ["Exclude", el("kbd", { text: "E" })]),
          reasonSel,
          el("span", { class: "spacer" }),
          current ? el("button", { class: "link", text: `undo${c.by === "s1" ? " (System 1)" : c.by === "llm" ? " (AI)" : ""}`, onclick: () => decide(c, null) }) : null,
          el("span", { class: "hint", text: "↑/↓ move" }),
        ]),
        annotationsPanel(c),
        dupBox(c, s),
        s1Box(c, s),
        sg
          ? el("div", { class: "ai-box" }, [
              el("span", {}, [el("b", { text: `AI suggests: ${sg.d}` }), sg.r ? ` — ${sg.r}` : "", sg.c != null ? ` (${Math.round(sg.c * 100)}% sure)` : ""]),
              el("span", { class: "hint", text: sg.why || "" }),
              el("span", { class: "spacer" }),
              el("button", { text: "Accept", onclick: () => decide(c, sg.d, sg.r, "llm") }),
            ])
          : null,
        foundBy(c, terms),
        abstractView(c, kw),
        highlightList(c),
      ])
    );
  }

  // ------------------------------------------------ full-text annotations (step 4) ----
  const KIND_LABEL = { include: "for inclusion", maybe: "maybe", exclude: "against" };

  /** Annotations in the PDF (the AI's and yours), with their verdict tags. */
  function annotationsPanel(c) {
    if (dstage() !== "ft") return null;
    const item = c.itemID && Zotero.Items.get(c.itemID);
    const att = item && ZR.FullText.pdfOf(item);
    const head = (extra) => el("div", { class: "anno-head" }, [el("b", { text: "Full-text annotations" }), ...extra]);
    if (!att) return el("div", { class: "anno-box" }, [head([]), el("div", { class: "hint", text: "No PDF attached yet — use Find PDF above, or attach the file in Zotero." })]);
    const list = ZR.FullText.annotationsOf(item);
    const n = (k) => list.filter((a) => a.kind === k).length;
    const untagged = list.filter((a) => !a.kind).length;
    const summary = list.length
      ? el("span", { class: "anno-sum" }, [
          el("span", { class: "k-include", text: `${n("include")} for` }),
          el("span", { class: "k-maybe", text: `${n("maybe")} maybe` }),
          el("span", { class: "k-exclude", text: `${n("exclude")} against` }),
          untagged ? el("span", { class: "hint", text: `${untagged} without verdict` }) : null,
        ])
      : null;
    return el("div", { class: "anno-box" }, [
      head([
        summary,
        el("span", { class: "spacer" }),
        el("button", { class: "anno-ai", "data-busy": "1", text: "✦ Annotate with AI", title: `The AI marks passages for and against inclusion as real Zotero annotations (author “${ZR.FullText.botName()}”)`, onclick: () => annotateAI(c) }),
        el("button", { text: "Open PDF", onclick: () => Zotero.Reader.open(att.id) }),
      ]),
      list.length
        ? el(
            "div",
            { class: "anno-list" },
            list.map((a) =>
              el("div", { class: `anno-row k-${a.kind || "none"}`, "data-key": a.key, title: "Click to show it in the PDF", onclick: () => ZR.FullText.open(a) }, [
                el("span", { class: "anno-who", title: a.isBot ? `${a.author} — written by the AI` : `${a.author || "You"}`, text: a.isBot ? "🤖" : "👤" }),
                el("div", { class: "anno-main" }, [
                  el("div", { class: "anno-text", text: a.text ? `“${ZR.Util.truncate(a.text, 300)}”` : "(note without text)" }),
                  a.comment ? el("div", { class: "anno-comment", text: a.comment }) : null,
                ]),
                el("span", { class: "anno-page", text: a.page ? "p. " + a.page : "" }),
                el(
                  "div",
                  { class: "anno-kind", onclick: (e) => e.stopPropagation() },
                  ["include", "maybe", "exclude"].map((k) =>
                    el("button", {
                      class: `kind-btn ${k}${a.kind === k ? " on" : ""}`,
                      title: a.kind === k ? "Remove the verdict" : `Mark as ${KIND_LABEL[k]} — sets the tag and the colour in Zotero`,
                      text: k === "include" ? "✓" : k === "maybe" ? "?" : "✗",
                      onclick: () => setAnnotationKind(a, a.kind === k ? null : k),
                    })
                  )
                ),
              ])
            )
          )
        : el("div", { class: "hint", text: "No annotations yet. Let the AI annotate the PDF, or annotate it yourself in Zotero." }),
      el("div", {
        class: "hint anno-help",
        text: "Your own annotations count too: tag them include, maybe or exclude (in the reader: right-click an annotation → Review). Changes in the PDF appear here right away.",
      }),
    ]);
  }

  async function setAnnotationKind(a, kind) {
    if (!App.target.editable) return st("This library is read-only.");
    try {
      await ZR.FullText.setKind(a.key, libraryID(), kind);
    } catch (e) {
      st("Could not change the annotation: " + e.message);
    }
    renderScreen();
  }

  async function annotateAI(c, { quiet = false } = {}) {
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    if (!App.target.editable) return st("This library is read-only.");
    const item = Zotero.Items.get(c.itemID);
    if (!quiet) App.setBusy("review", true);
    try {
      const r = await ZR.FullText.annotateWithAI({ item, protocol: project().protocol, profile, max: ZR.Prefs.get("annoMax", 10), onStatus: (m) => st(`${ZR.Util.truncate(c.title, 50)}: ${m}`) });
      const msg = `The AI added ${r.created} annotation(s) to “${ZR.Util.truncate(c.title, 60)}”${r.notFound.length ? ` — ${r.notFound.length} quote(s) were not found verbatim in the PDF and skipped` : ""}.${r.summary ? " " + r.summary : ""}`;
      if (!quiet) st(msg);
      return r;
    } catch (e) {
      if (!quiet) st("Annotating failed: " + e.message);
      throw e;
    } finally {
      if (!quiet) {
        App.setBusy("review", false);
        renderScreen();
      }
    }
  }

  /** All full texts with a PDF and no AI annotations yet. */
  async function annotateAll() {
    const todo = population().filter((c) => c.itemID && ZR.FullText.pdfOf(Zotero.Items.get(c.itemID)) && !ZR.FullText.annotationsOf(Zotero.Items.get(c.itemID)).some((a) => a.isBot));
    if (!todo.length) return st("Every full text with a PDF has AI annotations already.");
    App.setBusy("review", true);
    let made = 0;
    let failed = 0;
    try {
      for (const [i, c] of todo.entries()) {
        st(`Annotating ${i + 1}/${todo.length}: ${ZR.Util.truncate(c.title, 60)}…`);
        try {
          made += (await annotateAI(c, { quiet: true })).created;
        } catch (e) {
          failed++;
          ZR.Util.log("Annotating failed", c.title, e.message);
        }
      }
      st(`The AI added ${made} annotation(s) to ${todo.length - failed} full text(s)${failed ? `; ${failed} failed (see Log)` : ""}.`);
    } finally {
      App.setBusy("review", false);
      renderScreen();
    }
  }

  // Annotations edited in the PDF (by you or on another device) show up right away
  let annoTimer = null;
  const notifierID = Zotero.Notifier.registerObserver(
    {
      notify(event, type, ids) {
        if (step !== "fulltext" || App.currentTab !== "review") return;
        if (!ids.some((id) => Zotero.Items.get(id)?.isAnnotation?.() || event === "delete")) return;
        clearTimeout(annoTimer);
        annoTimer = setTimeout(() => renderScreen(), 400);
      },
    },
    ["item"],
    "zotero-researcher-review"
  );
  window.addEventListener("unload", () => Zotero.Notifier.unregisterObserver(notifierID));

  /** Open a paper at a step (from the reader's Review menu). */
  let pendingFocus = null;
  function focusItem(itemID) {
    pendingFocus = itemID;
  }

  // ---------------------------------------------------------- reading the abstract ----
  let termsCache = { id: null, runs: -1, query: null, terms: [] };
  function termsOfProject() {
    const p = project();
    if (termsCache.id !== p.id || termsCache.runs !== (p.runs || []).length || termsCache.query !== p.protocol?.query) {
      termsCache = { id: p.id, runs: (p.runs || []).length, query: p.protocol?.query, terms: PaperView.queryTerms(p) };
    }
    return termsCache.terms;
  }

  /** Hue of a search term: golden-angle steps, so every term differs as much as possible from the others. */
  function termHue(terms, text) {
    const i = Math.max(0, terms.findIndex((t) => t.text.toLowerCase() === String(text).toLowerCase()));
    return Math.round((i * 137.508 + 205) % 360);
  }

  // Terms picked in the chips stay marked from paper to paper
  const termFocus = new Set();
  const termSpans = (term) => [...$("screen-card").querySelectorAll(".kw")].filter((s) => s.dataset.term === term);

  function termChip(t, fields) {
    const term = t.text.toLowerCase();
    const chip = el("button", { class: "kw-chip" + (termFocus.has(term) ? " on" : ""), style: `--kw-h:${termHue(termsOfProject(), t.text)}`, "aria-pressed": String(termFocus.has(term)), title: `Found in ${fields.join(", ")} — hover to see where, click to keep it marked (several at once)` }, [el("b", { text: t.text }), " " + fields.join(", ")]);
    chip.addEventListener("mouseenter", () => termSpans(term).forEach((s) => s.classList.add("kw-hover")));
    chip.addEventListener("mouseleave", () => termSpans(term).forEach((s) => s.classList.remove("kw-hover")));
    chip.addEventListener("click", () => {
      if (termFocus.has(term)) termFocus.delete(term);
      else termFocus.add(term);
      const on = termFocus.has(term);
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", String(on));
      termSpans(term).forEach((s) => s.classList.toggle("kw-focus", on));
    });
    return chip;
  }

  /** Which search terms occur where — "why is this paper here?" */
  function foundBy(c, terms) {
    if (!terms.length) return null;
    const where = terms.map((t) => ({
      t,
      fields: [
        ["title", c.title],
        ["abstract", c.abstract],
        ["author", c.authors],
      ]
        .filter(([f, text]) => PaperView.termRanges(text, [t], f).length)
        .map(([f]) => f),
    }));
    const hit = where.filter((w) => w.fields.length);
    const miss = where.filter((w) => !w.fields.length);
    return el("div", { class: "found-by" }, [
      el("span", { class: "hint", text: hit.length ? "Search terms here:" : "No search term in title, authors or abstract" }),
      ...hit.map((w) => termChip(w.t, w.fields)),
      miss.length
        ? el("span", { class: "hint", title: "These terms of your searches do not occur here — the database may have matched keywords or the full text, or the paper came from another alternative of an OR", text: ` · not here: ${miss.map((w) => w.t.text).join(", ")}` })
        : null,
    ]);
  }

  function abstractView(c, kw) {
    const text = c.abstract || "";
    if (!text) return el("div", { class: "abstract empty", text: "No abstract available. Open the paper, or use “Fix metadata” in the Selected items tab once it is in Zotero." });
    const lang = ZR.Records.normLang(c.language || "") || (/\b(und|der|die|das|mit)\b/.test(text) ? "de" : "en");
    const abs = el("div", { class: "abstract", lang });
    const marks = (c.highlights || []).map((h) => ({ start: h.start, end: h.end, cls: `hl hl-${h.kind}`, title: h.note ? `${h.kind}: ${h.note}` : h.kind, attrs: { "data-hl": h.id } }));
    PaperView.render(abs, text, [...kw(text, "abstract"), ...marks], { paragraphs: ZR.Prefs.get("abstractSentences", false) });
    abs.addEventListener("contextmenu", (e) => {
      const onMark = e.target.closest?.("[data-hl]");
      const sel = PaperView.selection(abs, text);
      if (!sel && !onMark) return; // the normal menu (copy, …)
      e.preventDefault();
      const items = [];
      if (sel) {
        for (const k of ["include", "maybe", "exclude"]) items.push({ kind: k, label: `Highlight: speaks for ${k === "maybe" ? "maybe" : k === "include" ? "inclusion" : "exclusion"}`, run: () => addHighlight(c, sel, k) });
        items.push("-", { kind: "note", label: "Highlight with a note…", run: () => PaperView.editNote(e.clientX, e.clientY, "", (note) => addHighlight(c, sel, "note", note)) });
      } else {
        const h = c.highlights.find((x) => x.id === onMark.dataset.hl);
        if (!h) return;
        items.push({ label: h.note ? "Edit note…" : "Add a note…", run: () => PaperView.editNote(e.clientX, e.clientY, h.note, (note) => updateHighlight(c, h, { note })) });
        for (const k of ["include", "maybe", "exclude", "note"]) if (k !== h.kind) items.push({ kind: k, label: `Change to ${k}`, run: () => updateHighlight(c, h, { kind: k }) });
        items.push("-", { label: "Remove highlight", run: () => removeHighlight(c, h) });
      }
      PaperView.openMenu(e.clientX, e.clientY, items);
    });
    return el("div", { class: "abstract-wrap" }, [abs, el("div", { class: "hint abstract-hint", text: "Select text and right-click to highlight it (include / maybe / exclude) or add a note." })]);
  }

  function highlightList(c) {
    const list = (c.highlights || []).slice().sort((a, b) => a.start - b.start);
    if (!list.length) return null;
    return el("div", { class: "hl-list" }, [
      el("div", { class: "hl-head", text: `Your highlights (${list.length}) — ${c.itemID ? "kept as a note on the Zotero item" : "added to Zotero as a note when you include the paper"}` }),
      ...list.map((h) =>
        el("div", { class: "hl-row" }, [
          el("span", { class: `hl hl-${h.kind} hl-quote`, text: `“${ZR.Util.truncate(h.text, 200)}”` }),
          h.note ? el("span", { class: "hl-notetext", text: h.note }) : null,
          el("span", { class: "spacer" }),
          iconButton("note", h.note ? "Edit the note" : "Add a note", (e) => PaperView.editNote(e.clientX - 240, e.clientY + 10, h.note, (note) => updateHighlight(c, h, { note }))),
          iconButton("trash", "Remove the highlight", () => removeHighlight(c, h), "danger"),
        ])
      ),
    ]);
  }

  const ICONS = {
    note: "M3 10h11v2H3v-2zm0-2h11V6H3v2zm0 8h7v-2H3v2zm15.01-3.13.71-.71a1 1 0 0 1 1.41 0l.71.71a1 1 0 0 1 0 1.41l-.71.71-2.12-2.12zm-.71.71-5.3 5.3V21h2.12l5.3-5.3-2.12-2.12z",
    trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  };
  function iconButton(name, title, onclick, cls = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return el("button", { class: `icon-action ${cls}`, title, "aria-label": title, onclick }, svg);
  }

  async function saveHighlights(c) {
    const pool = await ZR.Projects.loadPool(libraryID(), project().id);
    pool.notes = pool.notes || {};
    if (c.highlights.length) pool.notes[c.key] = c.highlights;
    else delete pool.notes[c.key];
    await ZR.Projects.savePool(libraryID(), project().id);
    if (c.itemID && App.target.editable) await PaperView.syncNote(c.itemID, c.title, c.highlights).catch((e) => ZR.Util.log("Highlight note failed", e.message));
    renderScreen();
  }

  function addHighlight(c, sel, kind, note = "") {
    c.highlights = (c.highlights || []).filter((h) => h.end <= sel.start || h.start >= sel.end); // a new mark replaces overlapping ones
    c.highlights.push({ id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), start: sel.start, end: sel.end, text: sel.text, kind, note, at: today() });
    document.getSelection()?.removeAllRanges();
    return saveHighlights(c);
  }

  function updateHighlight(c, h, change) {
    Object.assign(h, change);
    return saveHighlights(c);
  }

  function removeHighlight(c, h) {
    c.highlights = c.highlights.filter((x) => x !== h);
    return saveHighlights(c);
  }

  function s1Box(c, s) {
    if (!c.s1 || s === "ft") return null;
    const r = c.s1;
    return el("div", { class: "s1-box" }, [
      el("div", { class: "s1-top" }, [
        el("b", { text: `System 1: ${pct(r.p)} likely to pass` }),
        el("span", { class: "hint", text: `${ENGINE_NAMES[r.engine] || r.engine}${r.model ? " · " + r.model : ""}${r.at ? " · " + r.at : ""}` }),
        el("span", { class: "spacer" }),
        r.suggest && !c[s] ? el("button", { text: `Accept: ${r.suggest.d}`, title: r.suggest.r || "", onclick: () => decide(c, r.suggest.d, r.suggest.r, "s1") }) : null,
      ]),
      el("div", { class: "pbar" }, el("div", { class: band(r.p), style: `width:${Math.round(r.p * 100)}%` })),
      r.criteria?.length || r.relevance != null
        ? el("div", { class: "s1-crit" }, [
            el("div", { class: "crit crit-head" }, [el("span", { text: "" }), el("span", { text: "Question to the model" }), el("span", { text: "Yes" })]),
            r.relevance != null && r.criteria?.length ? critRow("topic", "Relevant to the review question", r.relevance) : null,
            ...(r.criteria || []).map((k) => critRow(k.kind, k.text, k.p, k.note)),
            r.learned != null ? critRow("learned", `What the local model learned from your ${r.labels || ""} decisions`, r.learned) : null,
          ])
        : null,
      r.why ? el("div", { class: "hint", text: r.why }) : null,
    ]);
  }

  /** One criterion; the row is tinted by what it says about the paper (include / maybe / exclude). */
  function critRow(kind, text, p, note) {
    const label = { topic: "topic", include: "meets", exclude: "excl.", learned: "you" }[kind];
    const good = kind === "exclude" ? p != null && p < 0.3 : p != null && p >= 0.6;
    const bad = kind === "exclude" ? p != null && p >= 0.6 : p != null && p < 0.3;
    const verdict = p == null ? "" : good ? "v-inc" : bad ? "v-exc" : "v-may";
    return el("div", { class: `crit ${verdict}`, title: note || "" }, [el("span", { class: "crit-k", text: label }), el("span", { class: "crit-t" }, [text, note ? el("span", { class: "hint", text: ` (${note})` }) : null]), el("span", { class: "crit-p", text: pct(p) })]);
  }

  function pdfButton(c) {
    const item = Zotero.Items.get(c.itemID);
    const att = item
      .getAttachments()
      .map((id) => Zotero.Items.get(id))
      .find((a) => a?.isFileAttachment());
    if (att) return el("button", { text: "Open PDF", onclick: () => Zotero.Reader.open(att.id) });
    return el("button", {
      text: "Find PDF",
      onclick: async (e) => {
        e.target.disabled = true;
        st("Looking for a PDF…");
        const ok = await ZR.Importer.attachFullText(item);
        c.hasPDF = !!ok;
        st(ok ? "PDF attached." : "No legally accessible PDF found — attach one by hand, or exclude with “Full text not available”.");
        renderScreen();
      },
    });
  }

  /**
   * Record a decision. Including a pool paper at title/abstract stage adds it to Zotero.
   * @param {"include"|"exclude"|"maybe"|null} d
   */
  async function decide(c, d, reason = "", by = "me", { advance = true, render = true } = {}) {
    if (!App.target.editable) return st("This library is read-only.");
    const p = project();
    const s = dstage();
    let item = c.itemID ? Zotero.Items.get(c.itemID) : null;
    if (!item && d === "include" && s === "ta") {
      const tag = ZR.Prefs.get("tagImported", true) ? ZR.Prefs.get("importTag", "zr:imported") : "";
      item = await ZR.Projects.importCandidate(libraryID(), p, c, tag ? [tag] : []);
      c.hasPDF = ZR.Prisma.itemHasPDF(item);
      if (c.highlights?.length) await PaperView.syncNote(item.id, c.title, c.highlights).catch((e) => ZR.Util.log("Highlight note failed", e.message));
    }
    const r = d === "exclude" ? reason || $("reason-select")?.value || "" : "";
    await ZR.Store.decide({ libraryID: libraryID(), key: c.key, item, title: c.title, stage: s, d, r, by, collectionKey: p.collectionKey });
    c[s] = d;
    c.reason = r;
    c.by = d ? by : "";
    c[s + "Info"] = d ? { d, r, by, at: today() } : null; // keeps the audit trail current
    if (by === "me" && s === "ta" && ZR.Embed.isAvailable() && cands.some((x) => x.s1 && x.s1.engine !== "rules")) scheduleRelearn();
    if (advance && d) {
      const list = filtered();
      const idx = list.findIndex((x) => x.key === c.key);
      const next = list.slice(idx + 1).find((x) => !x[s]) || list.find((x) => !x[s] && x.key !== c.key);
      currentKey = next ? next.key : c.key;
    }
    if (render) renderScreen();
  }

  function onKey(e) {
    if (App.currentTab !== "review" || (step !== "screen" && step !== "fulltext") || !project()) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey || !$("np-layer").hidden) return;
    const list = filtered();
    const c = list.find((x) => x.key === currentKey);
    const key = e.key.toLowerCase();
    if (key === "arrowdown" || key === "j" || key === "arrowup" || key === "k") {
      const idx = list.findIndex((x) => x.key === currentKey);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + (key === "arrowdown" || key === "j" ? 1 : -1)))];
      if (next) {
        currentKey = next.key;
        renderScreen();
      }
      e.preventDefault();
      return;
    }
    if (!c) return;
    if (/^[1-9]$/.test(key)) {
      const sel = $("reason-select");
      if (sel && sel.options[Number(key) - 1]) sel.selectedIndex = Number(key) - 1;
      e.preventDefault();
    } else if (key === "i") decide(c, "include");
    else if (key === "m" && dstage() === "ta") decide(c, "maybe");
    else if (key === "e") decide(c, "exclude", $("reason-select")?.value);
  }

  // ------------------------------------------ quality / extraction / classify ----
  function facetOf(line) {
    const i = line.indexOf(":");
    if (i < 0) return { name: line.trim(), options: [] };
    return { name: line.slice(0, i).trim(), options: line.slice(i + 1).split(/[,;]/).map((s) => s.trim()).filter(Boolean) };
  }

  function tableSpec() {
    const P = project().protocol;
    if (step === "quality") return { field: "qa", prefix: "Q", cols: P.quality || [], title: "Answer each checklist question for every included paper: yes / partly / no.", empty: "quality checklist" };
    if (step === "extract") return { field: "extract", prefix: "E", cols: P.extraction || [], title: "Record the data extraction fields for every included paper.", empty: "data extraction fields" };
    const facets = (P.facets || []).map(facetOf);
    return { field: "extract", prefix: "C", cols: facets.map((f) => f.name), facets, title: "Classify every included paper along the facets of your map.", empty: "classification facets" };
  }

  const tableRows = () => cands.filter((c) => ZR.Projects.inStage(project(), step, c));

  let fullHeaders = ZR?.Prefs?.get("tableFullHeaders", false) || false;

  function renderTable() {
    const spec = tableSpec();
    fullHeaders = ZR.Prefs.get("tableFullHeaders", false);
    $("rv-table-full").setAttribute("aria-pressed", String(fullHeaders));
    $("rv-table-full").textContent = spec.field === "qa" ? "Full questions" : "Full field names";
    const rows = tableRows();
    const body = $("rv-table-body");
    $("rv-table-title").textContent = spec.title;
    body.replaceChildren();
    $("rv-table-ai").disabled = App.busy || !spec.cols.length || !rows.length;
    $("rv-table-csv").disabled = !rows.length;
    $("rv-table-cluster").hidden = step !== "classify" || !ZR.Embed.isAvailable();
    $("rv-table-cluster").disabled = App.busy || rows.length < 4;
    if (!spec.cols.length) {
      body.append(el("div", { class: "empty-state" }, [el("div", { class: "empty-title", text: `No ${spec.empty} in the protocol yet` }), el("div", {}, el("button", { class: "primary", text: "Edit the protocol", onclick: () => ((protocolMode = "form"), go("protocol")) }))]));
      return;
    }
    if (!rows.length) {
      body.append(el("div", { class: "empty-state" }, [el("div", { class: "empty-title", text: "No papers have reached this step yet" }), el("div", { text: "Papers appear here once they pass screening." })]));
      return;
    }
    const cell = (c, i) => {
      const col = spec.cols[i];
      if (spec.field === "qa") {
        const a = c.qa?.[i];
        return el("td", { title: a?.why ? `${a.why}${a.by === "llm" ? " (AI)" : ""}` : "" }, el("select", { class: "qa " + (a?.a || ""), onchange: (e) => setCell(c, spec, i, e.target.value) }, ["", "yes", "partly", "no"].map((v) => el("option", { value: v, text: v || "–", selected: (a?.a || "") === v }))));
      }
      const v = c.extract?.[col] || "";
      const options = spec.facets?.[i]?.options || [];
      if (options.length) {
        const opts = v && !options.includes(v) ? [...options, v] : options;
        return el("td", {}, el("select", { onchange: (e) => setCell(c, spec, i, e.target.value) }, ["", ...opts].map((o) => el("option", { value: o, text: o || "–", selected: o === v }))));
      }
      const t = el("textarea", { rows: "2", onchange: (e) => setCell(c, spec, i, e.target.value.trim()) });
      t.value = v;
      return el("td", {}, t);
    };
    body.append(
      el("table", { class: "grid" }, [
        el("thead", {}, el("tr", {}, [el("th", { text: "Paper" }), ...spec.cols.map((x, i) => el("th", { class: fullHeaders ? "full" : "", title: `${spec.prefix}${i + 1}: ${x}` }, fullHeaders ? [el("b", { text: `${spec.prefix}${i + 1}` }), " " + x] : `${spec.prefix}${i + 1}`))])),
        el(
          "tbody",
          {},
          rows.map((c) =>
            el("tr", {}, [
              el("td", { class: "g-paper" }, [
                c.itemID ? el("a", { href: "#", text: c.title, onclick: (e) => (e.preventDefault(), App.ZR.UI.revealItem(c.itemID, { preferCollectionID: App.target.collectionID })) }) : el("span", { text: c.title }),
                el("div", { class: "hint", text: [c.authors, c.year].filter(Boolean).join(" · ") }),
              ]),
              ...spec.cols.map((_, i) => cell(c, i)),
            ])
          )
        ),
      ])
    );
  }

  let poolTimer = null;
  function savePoolSoon() {
    clearTimeout(poolTimer);
    poolTimer = setTimeout(() => ZR.Projects.savePool(libraryID(), project().id).catch((e) => Zotero.logError(e)), 400);
  }

  async function setCell(c, spec, i, value, by = "me") {
    const pool = await ZR.Projects.loadPool(libraryID(), project().id);
    if (spec.field === "qa") {
      const arr = (pool.qa[c.key] = pool.qa[c.key] || spec.cols.map(() => null));
      arr[i] = value ? { a: value, why: typeof by === "object" ? by.why : "", by: typeof by === "object" ? "llm" : by } : null;
      c.qa = arr;
    } else {
      const o = (pool.extract[c.key] = pool.extract[c.key] || {});
      o[spec.cols[i]] = value;
      c.extract = o;
    }
    savePoolSoon();
    renderSteps();
  }

  async function paperFor(c, queries = []) {
    return { title: c.title, year: c.year, abstract: c.abstract, fulltext: await fullText(c, queries) };
  }

  async function tableAI() {
    let profile;
    try {
      profile = App.profile();
    } catch (e) {
      return st(e.message);
    }
    const spec = tableSpec();
    const filled = (c) => (spec.field === "qa" ? spec.cols.every((_, i) => c.qa?.[i]) : spec.cols.every((x) => c.extract?.[x]));
    const rows = tableRows().filter((c) => !filled(c));
    if (!rows.length) return st("Every cell is filled already. Clear a cell to have the AI fill it again.");
    App.setBusy("review", true);
    let done = 0;
    let failed = 0;
    try {
      await ZR.Util.mapLimit(rows, 3, async (c) => {
        try {
          const paper = await paperFor(c, spec.cols);
          if (spec.field === "qa") {
            const answers = await ZR.Assist.assessQuality(profile, spec.cols, paper);
            for (const [i, a] of answers.entries()) if (a && !c.qa?.[i]) await setCell(c, spec, i, a.a, { why: a.why });
          } else {
            // Facets with categories become "Name (one of: a, b, c)" so the answer is a category
            const asked = spec.cols.map((x, i) => (spec.facets?.[i]?.options.length ? `${x} (one of: ${spec.facets[i].options.join(", ")})` : x));
            const out = await ZR.Assist.extractFields(profile, asked, paper);
            for (const [i, q] of asked.entries()) if (out[q] && !c.extract?.[spec.cols[i]]) await setCell(c, spec, i, out[q]);
          }
        } catch (e) {
          failed++;
          ZR.Util.log("Table AI failed", c.title, e.message);
        }
        st(`The AI filled ${++done}/${rows.length} paper(s)…`);
      });
      st(`The AI filled ${done - failed} paper(s)${failed ? `, ${failed} failed` : ""}. It used the full text where Zotero has indexed it, otherwise the abstract — check the values.`);
    } finally {
      App.setBusy("review", false);
      renderTable();
    }
  }

  const STOP = new Set("a an and are as at based by for from in into is of on or the to using via with towards toward its their this that these we our study analysis approach case new".split(" "));

  /** Fallback cluster name: words frequent in the cluster's titles but not overall. */
  function keywordName(group, all) {
    const words = (list) => {
      const n = new Map();
      for (const c of list) for (const w of new Set(ZR.Util.normalizeTitle(c.title).split(" "))) if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) n.set(w, (n.get(w) || 0) + 1);
      return n;
    };
    const g = words(group);
    const a = words(all);
    const top = [...g.entries()].map(([w, n]) => [w, n / group.length - (a.get(w) || 0) / all.length]).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([w]) => w);
    return top.length ? top.map((w) => w[0].toUpperCase() + w.slice(1)).join(" / ") : "Other";
  }

  /** Mapping studies: group the included papers by topic (local model) into a new facet. */
  async function clusterFacet() {
    const p = project();
    const rows = tableRows();
    if (rows.length < 4) return st("Topic clusters need at least 4 included papers.");
    App.setBusy("review", true);
    try {
      const vecs = await ZR.Embed.paperVectors(rows, { onProgress: (d, n) => st(`The local model is reading ${d}/${n} abstract(s)…`) });
      const list = rows.filter((c) => vecs.has(c.key));
      const k = Math.max(2, Math.min(8, Math.round(Math.sqrt(list.length / 2))));
      const { assign } = ZR.Embed.kmeans(
        list.map((c) => vecs.get(c.key)),
        k
      );
      const groups = Array.from({ length: k }, () => []);
      list.forEach((c, i) => groups[assign[i]].push(c));
      const clusters = groups.filter((g) => g.length);
      let names = clusters.map((g) => keywordName(g, list));
      let profile = null;
      try {
        profile = App.profile();
      } catch (e) {
        /* keyword names only */
      }
      if (profile) {
        try {
          st("The AI is naming the topic clusters…");
          const ai = await ZR.Assist.nameClusters(profile, clusters.map((g) => g.map((c) => c.title)), p.protocol.objective || (p.protocol.questions || []).join(" "));
          names = names.map((n, i) => ai[i] || n);
        } catch (e) {
          ZR.Util.log("Naming clusters failed", e.message);
        }
      }
      // Category names must survive the "Facet: a, b, c" notation and be distinct
      const seen = new Map();
      names = names.map((n) => {
        n = n.replace(/[,;:]+/g, " ").replace(/\s+/g, " ").trim() || "Other";
        const k2 = (seen.get(n) || 0) + 1;
        seen.set(n, k2);
        return k2 > 1 ? `${n} ${k2}` : n;
      });
      const facet = "Topic (clusters)";
      p.protocol.facets = [...(p.protocol.facets || []).filter((f) => !f.startsWith(facet + ":")), `${facet}: ${names.join(", ")}`];
      await ZR.Projects.save(libraryID(), p);
      draft = null;
      const pool = await ZR.Projects.loadPool(libraryID(), p.id);
      clusters.forEach((g, i) =>
        g.forEach((c) => {
          const o = (pool.extract[c.key] = pool.extract[c.key] || {});
          o[facet] = names[i];
          c.extract = o;
        })
      );
      await ZR.Projects.savePool(libraryID(), p.id);
      st(`Grouped ${list.length} papers into ${clusters.length} topic clusters (local model${profile ? ", named by the AI" : ""}) as the facet “${facet}”. Change a paper's topic in the table, or rename the categories in the protocol.`);
    } catch (e) {
      st("Clustering failed: " + e.message);
    } finally {
      App.setBusy("review", false);
      renderTable();
    }
  }

  async function tableCSV() {
    const spec = tableSpec();
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Title", "Authors", "Year", "DOI", ...spec.cols].map(q).join(",")];
    for (const c of tableRows()) {
      const vals = spec.field === "qa" ? spec.cols.map((_, i) => c.qa?.[i]?.a || "") : spec.cols.map((x) => c.extract?.[x] || "");
      lines.push([c.title, c.authors, c.year, c.doi, ...vals].map(q).join(","));
    }
    const name = `${project().name.replace(/[^\w-]+/g, "_")}-${step}.csv`;
    const f = await App.saveFile("﻿" + lines.join("\r\n"), name, "CSV", "*.csv");
    if (f) st("Saved " + f);
  }

  // --------------------------------------------------------------- report ----
  function counts() {
    const p = project();
    const hasFT = method().stages.includes("fulltext");
    // Without a full-text step, title/abstract inclusion is the final decision
    const items = cands.map((c) => ({ ta: c.ta, ft: hasFT ? c.ft : c.ta === "include" ? "include" : null, reason: c.reason, hasPDF: hasFT ? c.hasPDF : true }));
    return ZR.Prisma.countsFromData(p.runs || [], items, (id) => ZR.Sources.get(id)?.name || id);
  }

  async function renderReport() {
    const c = counts();
    lastSVG = ZR.Prisma.svg(c, { title: `${method().name} — ${project().name}` });
    const doc = new DOMParser().parseFromString(lastSVG, "image/svg+xml");
    const view = $("prisma-view");
    view.replaceChildren(document.importNode(doc.documentElement, true));
    if (method().stages.includes("classify")) view.append(facetSummary());
    st(c.pendingTA || c.pendingFT ? `Still to do: ${c.pendingTA} title/abstract and ${c.pendingFT} full-text decision(s).` : "All papers screened.");
  }

  function facetSummary() {
    const facets = (project().protocol.facets || []).map(facetOf);
    const rows = cands.filter((c) => ZR.Projects.inStage(project(), "classify", c));
    const box = el("div", { class: "facet-summary" });
    for (const f of facets) {
      const n = {};
      for (const c of rows) {
        const v = c.extract?.[f.name] || "(not classified)";
        n[v] = (n[v] || 0) + 1;
      }
      box.append(el("h3", { text: f.name }), el("table", { class: "runs" }, Object.entries(n).sort((a, b) => b[1] - a[1]).map(([k, v]) => el("tr", {}, [el("td", { text: k }), el("td", { text: String(v) })]))));
    }
    return box;
  }

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** The protocol as note HTML — the documented method for the paper or thesis. */
  function protocolHTML(p) {
    const P = p.protocol;
    const m = method();
    const list = (a) => (a?.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p>—</p>");
    const fw = ZR.Methodologies.FRAMEWORKS[P.framework];
    return (
      `<h1>${esc(P.title || p.name)}</h1>` +
      `<p><strong>Methodology:</strong> ${esc(m.name)} (${esc(m.reference)})</p>` +
      (P.objective ? `<p><strong>Objective:</strong> ${esc(P.objective)}</p>` : "") +
      `<h2>Research questions</h2>${list(P.questions)}` +
      (fw?.fields.length ? `<h2>${esc(fw.name)}</h2><ul>${fw.fields.map((f) => `<li><strong>${esc(f.label)}:</strong> ${esc(P.frameworkFields?.[f.id] || "—")}</li>`).join("")}</ul>` : "") +
      `<h2>Inclusion criteria</h2>${list(P.inclusion)}<h2>Exclusion criteria</h2>${list(P.exclusion)}` +
      `<h2>Search</h2><p><code>${esc(P.query || "—")}</code></p><p>Years: ${P.yearFrom || "…"}–${P.yearTo || "…"}; languages: ${esc(P.languages.join(", ") || "any")}; types: ${esc(P.types.join(", ") || "any")}</p>` +
      `<p><em>Screening support: System 1 relevance probabilities (${esc(ENGINE_NAMES[ZR.System1.engine()])}) with thresholds ${Math.round(thresholds().excludeBelow * 100)}% / ${Math.round(thresholds().includeAbove * 100)}%; decisions by System 1, the AI or the reviewer are recorded per paper.</em></p>`
    );
  }

  async function saveNote() {
    if (!App.target.editable) return st("This library is read-only.");
    const p = project();
    const c = counts();
    const legacy = Object.assign(criteriaOf(p.protocol), { runs: p.runs });
    await ZR.Importer.createNote(protocolHTML(p) + ZR.Prisma.noteHTML(c, legacy, p.name), { libraryID: libraryID(), collectionID: App.target.collectionID });
    st("Protocol and flow summary saved as a note in the collection.");
  }

  async function exportSVG() {
    if (!lastSVG) await renderReport();
    const f = await App.saveFile(lastSVG, "prisma-flow.svg", "SVG image", "*.svg");
    if (f) st("Saved " + f);
  }

  /** Open this step the next time the tab is shown. */
  const setStep = (s) => (step = s);

  return { init, onShow, refresh, reset, go, setStep, focusItem, api, get step() { return step; }, get candidates() { return cands; } };
})();

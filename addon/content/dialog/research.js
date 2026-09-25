/* global Zotero, document, window, ChromeUtils, ZRDropdown */
"use strict";

// Researcher window: shell + Search tab. Other tabs live in items.js, review.js,
// citations.js; the guided tour in tour.js. All engine code is in Zotero.Researcher.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c != null && c !== false) e.append(c);
  return e;
}

const App = (window.App = {
  ZR: null,
  args: null,
  target: null,
  project: null, // current project (lib/projects.js): remembers search settings, history and review
  projects: [],
  busy: false,
  panels: {}, // name -> {init(), onShow()}
  currentTab: "search",

  status(which, msg) {
    const s = $(`${which}-status`);
    if (s) s.textContent = msg;
  },

  setBusy(which, on) {
    App.busy = on;
    for (const b of document.querySelectorAll("button[data-busy]")) b.disabled = on;
    for (const id of ["run", "import", "fix-meta", "fix-meta-ai", "find-pdfs", "find-related", "compare-run", "apply-all", "cite-scan", "cite-missing", "ai-uncertain", "ai-accept", "s1-rate", "rv-fill", "rv-save", "rv-start-btn", "rv-table-ai", "np-create"]) {
      const b = $(id);
      if (b) b.disabled = on || (b.dataset.disabledReason ? true : false);
    }
    for (const p of document.querySelectorAll("progress")) p.hidden = !(on && p.id.startsWith(which));
  },

  showTab(name) {
    App.currentTab = name;
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === name);
    for (const p of ["search", "review", "items", "citations"]) $("panel-" + p).hidden = p !== name;
    App.panels[name]?.onShow?.();
  },

  profiles() {
    return App.ZR.Prefs.getLLMProfiles();
  },

  fillProfileSelect(select) {
    const profiles = App.profiles();
    const active = App.ZR.Prefs.getActiveLLMProfile();
    select.replaceChildren();
    if (!profiles.length) select.append(el("option", { value: "", text: "No AI set up yet" }));
    for (const p of profiles) select.append(el("option", { value: p.id, text: `${p.name} · ${p.model}`, selected: active && p.id === active.id }));
    select.disabled = !profiles.length;
    select.onchange = () => {
      App.ZR.Prefs.set("activeLLMProfile", select.value);
      for (const s of document.querySelectorAll("select[data-llm]")) if (s !== select) s.value = select.value;
    };
    select.dataset.llm = "1";
  },

  /** Active profile or a clear error that points to Settings. */
  profile() {
    const p = App.ZR.Prefs.getActiveLLMProfile();
    if (!p) throw new Error("No AI is set up yet — add one under ⚙ Settings → AI providers.");
    return p;
  },

  selectedItems() {
    return App.args.itemIDs.map((id) => Zotero.Items.get(id)).filter(Boolean);
  },

  collection() {
    return App.target.collectionID ? Zotero.Collections.get(App.target.collectionID) : null;
  },

  /** Where papers go. Changes when a project bound to another collection is chosen. */
  setTarget(t) {
    App.target = t;
    $("target").replaceChildren("Adding to ", el("b", { text: t.label }));
    $("target").classList.toggle("readonly", !t.editable);
    $("target").title = t.editable ? "Where papers are added" : "This library or collection is read-only — adding papers is disabled";
    const empty = $("empty-target");
    if (empty) empty.textContent = t.label;
  },

  /** Load the library's projects and pick the one for the current collection. */
  async loadProjects(preferID) {
    App.projects = await App.ZR.Projects.list(App.target.libraryID);
    let p = preferID ? App.projects.find((x) => x.id === preferID) : null;
    if (!p && App.project) p = App.projects.find((x) => x.id === App.project.id);
    if (!p && App.target.collectionKey) p = App.projects.find((x) => x.collectionKey === App.target.collectionKey);
    App.project = p || null;
    App.renderProjects();
  },

  renderProjects() {
    const sel = $("project-select");
    const opts = [el("option", { value: "", text: "No project", title: "Search without remembering settings in a project" })];
    for (const p of App.projects) {
      const m = p.kind === "review" ? App.ZR.Methodologies.get(p.methodology) : null;
      opts.push(el("option", { value: p.id, text: `${p.kind === "review" ? "◆" : "○"} ${p.name}`, title: m ? `Structured review · ${m.name}` : "Quick search project" }));
    }
    opts.push(el("option", { value: "__new", text: "+ New project…" }));
    sel.replaceChildren(...opts);
    sel.value = App.project?.id || "";
    const review = App.project?.kind === "review";
    $("review-pill").hidden = !review;
    $("review-pill").textContent = review ? App.ZR.Methodologies.get(App.project.methodology)?.id.replace("prisma2020", "PRISMA") || "on" : "";
    App.panels.search?.updateImportBar?.();
  },

  async switchProject(id) {
    if (id === "__new") {
      $("project-select").value = App.project?.id || "";
      return App.newProject();
    }
    const p = App.projects.find((x) => x.id === id) || null;
    App.project = p;
    if (p?.collectionKey && p.collectionKey !== App.target.collectionKey) {
      const t = App.ZR.UI.targetFor(App.target.libraryID, p.collectionKey);
      if (t) App.setTarget(t);
      else App.status("search", `The collection of “${p.name}” no longer exists — papers go to ${App.target.label}.`);
    }
    App.renderProjects();
    App.panels.review.reset();
    App.panels.search.loadProject();
    await App.panels[App.currentTab]?.onShow?.();
  },

  /** New-project dialog (in-window, no modal window). */
  newProject(kind = "quick") {
    const t = App.target;
    const col = t.collectionKey ? t.label.split(" › ").pop() : "";
    const taken = col && App.projects.find((p) => p.collectionKey === t.collectionKey);
    $("np-name").value = col && !taken ? col : "";
    for (const r of document.querySelectorAll('input[name="np-kind"]')) r.checked = r.value === kind;
    const use = document.querySelector('input[name="np-col"][value="use"]');
    use.disabled = !col || !!taken;
    use.checked = !use.disabled;
    document.querySelector('input[name="np-col"][value="new"]').checked = use.disabled;
    $("np-use-label").textContent = !col ? "Use the current collection (none selected — you are in the library root)" : taken ? `Use “${col}” (already belongs to project “${taken.name}”)` : `Use the current collection “${col}”`;
    $("np-layer").hidden = false;
    setTimeout(() => $("np-name").focus(), 0);
  },

  async createProject() {
    const ZR = App.ZR;
    const name = $("np-name").value.trim();
    if (!name) return $("np-name").focus();
    const kind = document.querySelector('input[name="np-kind"]:checked').value;
    const newCol = document.querySelector('input[name="np-col"]:checked').value === "new";
    const library = Zotero.Libraries.get(App.target.libraryID);
    if (!library.editable) return App.status("search", "This library is read-only.");
    let collectionKey = App.target.collectionKey;
    if (newCol) {
      const col = new Zotero.Collection();
      col.libraryID = App.target.libraryID;
      col.name = name;
      await col.saveTx();
      collectionKey = col.key;
    }
    const p = await ZR.Projects.create(App.target.libraryID, {
      name,
      kind,
      collectionKey,
      methodology: "prisma2020",
      // a new quick project starts from the current search settings
      search: kind === "quick" ? App.panels.search.currentState() : {},
    });
    if (newCol) App.setTarget(ZR.UI.targetFor(App.target.libraryID, collectionKey));
    $("np-layer").hidden = true;
    await App.loadProjects(p.id);
    App.panels.review.reset();
    App.panels.search.loadProject();
    if (kind === "review") return App.showTab("review");
    App.status("search", `Project “${name}” created: its search settings and history are remembered.`);
    await App.panels[App.currentTab]?.onShow?.();
  },

  // ------------------------------------------------------------ activity log ----
  /** The Log panel: every web request, AI call, CLI run and local-model call, live. */
  toggleLog() {
    const existing = $("log-panel");
    if (existing) return App.closeLog();
    const Act = App.ZR.Activity;
    let filter = "all";
    const open = new Set();
    const list = el("div", { class: "log-list" });
    const kinds = [
      ["all", "All"],
      ["ai", "AI"],
      ["web", "Web"],
      ["cli", "CLI"],
      ["local", "Local"],
    ];
    const seg = el(
      "div",
      { class: "seg small" },
      kinds.map(([k, label]) => el("button", { "data-k": k, class: k === filter ? "on" : "", text: label, onclick: () => ((filter = k), [...seg.children].forEach((b) => b.classList.toggle("on", b.dataset.k === k)), render()) }))
    );
    const secs = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + " s";
    const clock = (t) => new Date(t).toTimeString().slice(0, 8);
    function render() {
      const now = Date.now();
      const rows = Act.list()
        .filter((e) => filter === "all" || e.kind === filter)
        .reverse()
        .slice(0, 250);
      list.replaceChildren(
        ...(rows.length
          ? rows.map((e) => {
              const ms = (e.ended || now) - e.started;
              const slow = !e.ended && ms > 60000;
              const state = !e.ended ? (slow ? `running ${secs(ms)} — no answer yet` : `running ${secs(ms)}`) : e.ok ? secs(ms) : "failed";
              const row = el("div", { class: `log-row ${e.ended ? (e.ok ? "ok" : "err") : "run"}${slow ? " slow" : ""}`, onclick: () => (open.has(e.id) ? open.delete(e.id) : open.add(e.id), render()) }, [
                el("span", { class: "log-time", text: clock(e.started) }),
                el("span", { class: "log-kind k-" + e.kind, text: e.kind }),
                el("span", { class: "log-label", text: e.label }),
                el("span", { class: "log-state", text: state }),
              ]);
              if (!open.has(e.id)) return row;
              return el("div", {}, [row, el("pre", { class: "log-detail", text: [e.detail, e.result ? (e.ok === false ? "Error: " : "Result: ") + e.result : ""].filter(Boolean).join("\n\n") || "(no details)" })]);
            })
          : [el("div", { class: "hint log-empty", text: "Nothing yet — requests to databases, AI models, CLIs and the local model appear here while they run." })])
      );
    }
    const panel = el("div", { id: "log-panel", class: "log-panel", role: "dialog", "aria-label": "Activity log" }, [
      el("div", { class: "log-head" }, [
        el("b", { text: "Activity" }),
        seg,
        el("span", { class: "spacer" }),
        el("button", { text: "Copy", title: "Copy the log as text (for a bug report)", onclick: () => Zotero.Utilities.Internal.copyTextToClipboard(Act.text()) }),
        el("button", { text: "Clear finished", onclick: () => Act.clear() }),
        el("button", { class: "icon-btn", text: "×", title: "Close", onclick: () => App.closeLog() }),
      ]),
      el("div", { class: "hint log-sub", text: "Click an entry for the request and the answer. Running entries count up; long-running AI calls can take a minute or more." }),
      list,
    ]);
    document.body.append(panel);
    render();
    App._logOff = Act.subscribe(render);
    App._logTimer = setInterval(() => Act.running().length && render(), 500);
  },

  closeLog() {
    $("log-panel")?.remove();
    App._logOff?.();
    clearInterval(App._logTimer);
  },

  /** Running-count badge on the Log buttons. */
  updateLogBadges() {
    const n = App.ZR.Activity.running().length;
    for (const b of document.querySelectorAll(".log-count")) {
      b.hidden = !n;
      b.textContent = String(n);
    }
    for (const b of document.querySelectorAll(".log-btn")) b.classList.toggle("busy", !!n);
  },

  async saveFile(content, defaultName, filterTitle, pattern) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(window, "Save", fp.modeSave);
    fp.appendFilter(filterTitle, pattern);
    fp.defaultString = defaultName;
    const rv = await fp.show();
    if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;
    await Zotero.File.putContentsAsync(fp.file, content);
    return fp.file;
  },
});

window.addEventListener("load", () => {
  init().catch((e) => {
    Zotero.logError(e);
    App.status("search", "Could not start: " + e.message);
  });
});

async function init() {
  App.ZR = Zotero.Researcher;
  if (!App.ZR) throw new Error("Zotero Researcher is not loaded");
  ZRDropdown.observe(document); // native <select> popups don't work in chrome HTML windows
  const raw = window.arguments?.[0];
  App.args = raw?.wrappedJSObject || raw || { target: App.ZR.UI.getTarget(Zotero.getMainWindow()), itemIDs: [], tab: "search" };
  App.target = App.args.target;

  App.setTarget(App.target);
  $("sel-count").textContent = String(App.args.itemIDs.length);
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => App.showTab(b.dataset.tab));
  $("open-prefs").addEventListener("click", () => App.ZR.UI.openPreferences());
  $("help").addEventListener("click", () => Tour.start());
  $("project-select").addEventListener("change", (e) => App.switchProject(e.target.value).catch((err) => (Zotero.logError(err), App.status("search", err.message))));
  $("np-cancel").addEventListener("click", () => ($("np-layer").hidden = true));
  $("np-create").addEventListener("click", () => App.createProject().catch((err) => (Zotero.logError(err), App.status("search", "Could not create the project: " + err.message))));
  $("np-name").addEventListener("keydown", (e) => e.key === "Enter" && $("np-create").click());
  document.addEventListener("keydown", (e) => e.key === "Escape" && !$("np-layer").hidden && ($("np-layer").hidden = true));
  for (const b of document.querySelectorAll(".log-btn")) b.addEventListener("click", () => App.toggleLog());
  const offBadges = App.ZR.Activity.subscribe(() => App.updateLogBadges());
  window.addEventListener("unload", () => (offBadges(), App.closeLog()));

  await App.loadProjects();
  for (const p of Object.values(App.panels)) await p.init?.();

  // Pick up settings changes (new AI profile, research areas, keys) when the window regains focus.
  window.addEventListener("focus", () => {
    for (const s of document.querySelectorAll("select[data-llm]")) App.fillProfileSelect(s);
    App.panels.search.renderSources?.();
  });

  const tab = { find: "search", selected: "items", compare: "items" }[App.args.tab] || App.args.tab || "search";
  App.showTab(tab);
  if (App.args.tab === "compare") App.panels.items.openCompare();
  const auto = App.args.autoRun;
  if (auto === "enrich-det") App.panels.items.runEnrich("det");
  else if (auto === "enrich-llm") App.panels.items.runEnrich("llm");
  else if (auto === "find-pdf") App.panels.items.runFindPDFs();
  else if (auto === "related") App.panels.search.runRelated(App.selectedItems());

  if (App.args.tour || !App.ZR.Prefs.get("tourSeen", false)) setTimeout(() => Tour.start(), 250);
}

// ================================================================ SEARCH ====
App.panels.search = (() => {
  let ZR;
  let lastRun = null;
  const st = (m) => App.status("search", m);
  const pickedLangs = new Set();
  const pickedTypes = new Set();

  /** Toggle chips for multi-select filters (languages, publication types). */
  function renderPicks(boxID, items, picked) {
    const box = $(boxID);
    box.replaceChildren(
      ...items.map((it) =>
        el("button", {
          class: "pick",
          "aria-pressed": String(picked.has(it.id)),
          text: it.label,
          onclick: (e) => {
            if (picked.has(it.id)) picked.delete(it.id);
            else picked.add(it.id);
            e.target.setAttribute("aria-pressed", String(picked.has(it.id)));
            updateChips();
          },
        })
      )
    );
  }

  /** Put saved search settings (last dialog state, or a project's) into the form. */
  function applyState(s) {
    const lastMode = s.mode || ZR.Prefs.get("defaultMode", "structured");
    setMode(lastMode === "structured" ? "structured" : "llm");
    $("query").value = s.query || "";
    lastCompiled = null;
    $("request").value = s.request || "";
    $("year-from").value = s.yearFrom || "";
    $("year-to").value = s.yearTo || "";
    $("limit").value = s.limit || ZR.Prefs.get("maxPerSource", 25);
    $("fulltext-only").checked = s.fulltextOnly ?? ZR.Prefs.get("fulltextOnly", false);
    $("oa-only").checked = !!s.oaOnly;
    $("strict").checked = !!s.strict;
    $("skip-existing").checked = s.skipExisting ?? true;
    $("hide-excluded").checked = !!s.hideExcluded;
    $("screen").checked = s.screen ?? true;
    $("auto-import").checked = s.mode === "yolo";
    pickedLangs.clear();
    pickedTypes.clear();
    for (const l of s.languages || []) pickedLangs.add(l);
    for (const t of s.types || []) pickedTypes.add(t);
    renderPicks("lang-picks", ZR.Records.LANGUAGES.map((l) => ({ id: l.code, label: l.name })), pickedLangs);
    renderPicks("type-picks", ZR.Records.TYPE_FILTERS.map((t) => ({ id: t.id, label: t.label })), pickedTypes);
    $("min-cites").value = s.minCitations || "";
    $("has-abstract").checked = !!s.hasAbstract;
    $("has-doi").checked = !!s.hasDOI;
    $("res-sort").value = s.sort || "relevance";
    renderSources(s.sources);
    setView(s.kwView || kwView || "builder");
    $("run").textContent = getMode() === "llm" && $("auto-import").checked ? "Search & add" : "Search";
    validateQuery();
    updateChips();
  }

  /** Search settings of the current project on top of the last dialog state. */
  function stateForProject() {
    const s = ZR.Prefs.getJSON("dialogState", {});
    const ps = App.project?.search;
    return ps && Object.keys(ps).length ? Object.assign({}, s, ps) : s;
  }

  /** Called when the project changes: load its search settings. */
  function loadProject() {
    if (!ZR) return;
    applyState(stateForProject());
    updateImportBar();
  }

  function init() {
    ZR = App.ZR;
    for (const b of $("mode-seg").children) b.addEventListener("click", () => setMode(b.dataset.mode));
    $("attach-pdfs").checked = ZR.Prefs.get("attachPDFs", true);
    $("protocol").checked = ZR.Prefs.get("searchProtocolNote", true);
    $("tag").value = ZR.Prefs.get("tagImported", true) ? ZR.Prefs.get("importTag", "zr:imported") : "";
    $("min-score").value = ZR.Prefs.get("llmScreeningMinScore", 6);
    $("res-sort").addEventListener("change", () => (renderResults(), ZR.Prefs.setJSON("dialogState", Object.assign(ZR.Prefs.getJSON("dialogState", {}), { sort: $("res-sort").value }))));
    $("empty-target").textContent = App.target.label;
    App.fillProfileSelect($("llm-profile"));
    for (const b of $("kw-view").children) b.addEventListener("click", () => setView(b.dataset.view));
    applyState(stateForProject());

    $("query").addEventListener("input", validateQuery);
    $("query").addEventListener("keydown", (e) => e.key === "Enter" && !App.busy && run());
    $("request").addEventListener("keydown", (e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !App.busy && run());
    $("syntax-toggle").addEventListener("click", () => ($("syntax").hidden = !$("syntax").hidden));
    for (const ex of document.querySelectorAll(".example")) ex.addEventListener("click", () => useQueryText(ex.textContent));
    $("run").addEventListener("click", run);
    $("import").addEventListener("click", () => importSelected(false));
    $("sources-chip").addEventListener("click", () => toggleDrawer("sources"));
    $("options-chip").addEventListener("click", () => toggleDrawer("options"));
    $("areas-link").addEventListener("click", () => ZR.UI.openPreferences());
    $("src-all").addEventListener("click", () => setSources(() => true));
    $("src-none").addEventListener("click", () => setSources(() => false));
    $("src-free").addEventListener("click", () => setSources((x) => x.access === "free"));
    $("res-all").addEventListener("click", () => selectAll(true));
    $("res-none").addEventListener("click", () => selectAll(false));
    $("res-filter").addEventListener("input", renderResults);
    for (const id of ["year-from", "year-to", "limit", "fulltext-only", "oa-only", "strict", "skip-existing", "hide-excluded", "attach-pdfs", "screen", "auto-import", "min-cites", "has-abstract", "has-doi"]) {
      $(id).addEventListener("change", updateChips);
    }
    $("fulltext-only").addEventListener("change", () => $("fulltext-only").checked && ($("attach-pdfs").checked = true));
    $("auto-import").addEventListener("change", () => ($("run").textContent = $("auto-import").checked && getMode() === "llm" ? "Search & add" : "Search"));
    validateQuery();
    updateChips();
    updateImportBar();
  }

  // ------------------------------------------------------ query builder ----
  // Builder rows and the text query are two views of the same query; #query always
  // holds the text that is actually searched.
  let kwView = "builder";
  let blocks = [];
  let lastCompiled = null;
  const QB = () => ZR.QueryBuilder;
  const emptyRow = () => ({ op: "AND", field: "any", terms: [] });

  function setView(view) {
    if (view === "builder") {
      const q = $("query").value.trim();
      if (q !== lastCompiled) {
        const b = QB().fromQuery(q);
        if (!b) {
          view = "text";
          st("This query has nested groups the builder can't show — keep editing it as text.");
        } else blocks = b;
      }
      if (!blocks.length) blocks = [emptyRow()];
    }
    kwView = view;
    for (const b of $("kw-view").children) {
      b.classList.toggle("on", b.dataset.view === view);
      b.setAttribute("aria-checked", String(b.dataset.view === view));
    }
    $("builder").hidden = view !== "builder";
    $("query").hidden = view !== "text";
    $("syntax-toggle").hidden = view !== "text";
    if (view === "builder") renderBuilder();
    else $("query").focus();
  }

  /** Put query text into whichever view is active. */
  function useQueryText(text) {
    $("query").value = text;
    lastCompiled = null;
    validateQuery();
    setView(kwView);
  }

  function syncFromBuilder() {
    lastCompiled = QB().toQuery(blocks);
    $("query").value = lastCompiled;
    validateQuery();
  }

  function renderBuilder(focusRow = -1) {
    const box = $("builder");
    box.replaceChildren();
    box.title = "Terms in one row are alternatives (OR). Rows combine with AND, OR, NOT or XOR. Multi-word terms are exact phrases; build* matches word endings.";
    const multi = blocks.length > 1;
    blocks.forEach((b, i) => {
      const input = el("input", {
        type: "text",
        class: "qb-input",
        spellcheck: "false",
        placeholder: b.terms.length ? "or…" : i === 0 ? "Type a term and press Enter — e.g. IFC5" : "Type a term and press Enter",
      });
      const addTerms = (text) => {
        const parts = String(text).split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
        if (!parts.length) return false;
        b.terms.push(...parts);
        syncFromBuilder();
        renderBuilder(i);
        return true;
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!addTerms(input.value) && !App.busy) run();
        } else if (e.key === "," || e.key === ";") {
          e.preventDefault();
          addTerms(input.value);
        } else if (e.key === "Backspace" && !input.value && b.terms.length) {
          b.terms.pop();
          syncFromBuilder();
          renderBuilder(i);
        }
      });
      input.addEventListener("paste", (e) => {
        const text = e.clipboardData.getData("text");
        if (/[,;\n]/.test(text)) {
          e.preventDefault();
          addTerms(text);
        }
      });
      input.addEventListener("blur", () => input.value.trim() && addTerms(input.value));
      const chips = el("div", { class: "qb-chips", onclick: (e) => e.target === chips && input.focus() });
      b.terms.forEach((t, k) => {
        if (k) chips.append(el("span", { class: "qb-or", text: "or" }));
        chips.append(el("span", { class: "qb-chip" }, [t, el("button", { title: "Remove term", text: "×", onclick: () => (b.terms.splice(k, 1), syncFromBuilder(), renderBuilder(i)) })]));
      });
      chips.append(input);
      let lead = null;
      if (i > 0) {
        lead = el(
          "span",
          { class: "qb-lead" },
          el("select", { class: "qb-op", title: "How this row combines with the rows above", onchange: (e) => ((b.op = e.target.value), syncFromBuilder()) }, QB().OPS.map((o) => el("option", { value: o.id, text: o.label, title: o.hint, selected: b.op === o.id })))
        );
      } else if (multi) {
        lead = el("span", { class: "qb-lead qb-first", text: "Find" });
      }
      box.append(
        el("div", { class: "qb-row" }, [
          lead,
          el("select", { class: "qb-field", title: "Where the terms must appear", onchange: (e) => ((b.field = e.target.value), syncFromBuilder()) }, QB().FIELDS.map((x) => el("option", { value: x.id, text: x.label, selected: b.field === x.id }))),
          chips,
          multi ? el("button", { class: "qb-remove", title: "Remove this row", text: "×", onclick: () => (blocks.splice(i, 1), syncFromBuilder(), renderBuilder()) }) : null,
        ])
      );
      if (i === focusRow) setTimeout(() => input.focus(), 0);
    });
    box.append(el("button", { class: "link qb-add", text: "+ Add condition", title: "Add a row combined with AND, OR, NOT or XOR", onclick: () => (blocks.push(emptyRow()), renderBuilder(blocks.length - 1)) }));
  }

  function setMode(mode) {
    document.body.dataset.mode = mode;
    for (const b of $("mode-seg").children) {
      b.classList.toggle("on", b.dataset.mode === mode);
      b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    }
    $("run").textContent = mode === "llm" && $("auto-import").checked ? "Search & add" : "Search";
    validateQuery();
    updateChips();
  }
  const getMode = () => document.body.dataset.mode;

  function toggleDrawer(name) {
    const panel = $(`${name}-panel`);
    const other = $(name === "sources" ? "options-panel" : "sources-panel");
    panel.hidden = !panel.hidden;
    other.hidden = true;
    $("sources-chip").setAttribute("aria-expanded", String(!$("sources-panel").hidden));
    $("options-chip").setAttribute("aria-expanded", String(!$("options-panel").hidden));
  }

  function updateChips() {
    const chosen = selectedSources().map((id) => ZR.Sources.get(id).name);
    $("sources-chip").textContent = chosen.length ? `📚 ${chosen.length} source${chosen.length > 1 ? "s" : ""}: ${chosen.slice(0, 3).join(", ")}${chosen.length > 3 ? " …" : ""} ▾` : "📚 No source selected ▾";
    const parts = [];
    const yf = $("year-from").value;
    const yt = $("year-to").value;
    parts.push(yf || yt ? `${yf || "…"}–${yt || "…"}` : "any year");
    parts.push(`${$("limit").value || 25} per source`);
    if (pickedLangs.size) parts.push([...pickedLangs].map((l) => l.toUpperCase()).join("/"));
    if (pickedTypes.size) parts.push(pickedTypes.size === 1 ? ZR.Records.TYPE_FILTERS.find((t) => pickedTypes.has(t.id)).label.toLowerCase() : `${pickedTypes.size} types`);
    if (parseInt($("min-cites").value, 10) > 0) parts.push(`≥${parseInt($("min-cites").value, 10)} citations`);
    if ($("has-abstract").checked) parts.push("with abstract");
    if ($("has-doi").checked) parts.push("with DOI");
    if ($("fulltext-only").checked) parts.push("full text only");
    else if ($("oa-only").checked) parts.push("open access");
    if ($("hide-excluded").checked) parts.push("hide excluded");
    if ($("attach-pdfs").checked) parts.push("PDFs");
    if (getMode() === "llm" && $("screen").checked) parts.push("AI rating");
    if (getMode() === "llm" && $("auto-import").checked) parts.push("auto-add");
    $("options-chip").textContent = `⚙ ${parts.join(" · ")} ▾`;
  }

  function renderSources(preferred) {
    const box = $("sources");
    const prev = new Set(preferred || [...box.querySelectorAll("input:checked")].map((i) => i.value));
    const hadPrev = preferred ? true : box.children.length > 0;
    box.replaceChildren();
    for (const s of ZR.Sources.visibleSearchable()) {
      const why = ZR.Sources.unavailableReason(s.id);
      const checked = !why && (hadPrev ? prev.has(s.id) : ZR.Sources.isEnabled(s.id));
      box.append(
        el("label", { class: "src" + (why ? " unavailable" : ""), title: why ? `${s.name}: ${why}` : s.coverage }, [
          el("input", { type: "checkbox", value: s.id, checked, disabled: !!why, onchange: updateChips }),
          el("span", { text: s.name }),
          el("span", { class: "badge " + s.access, text: s.access === "free" ? "free" : s.access === "free-key" ? "key" : "paid" }),
        ])
      );
    }
    updateChips();
  }

  function setSources(pred) {
    for (const input of $("sources").querySelectorAll("input")) if (!input.disabled) input.checked = !!pred(ZR.Sources.get(input.value));
    updateChips();
  }
  const selectedSources = () => [...$("sources").querySelectorAll("input:checked")].map((i) => i.value);

  function validateQuery() {
    const fb = $("query-feedback");
    fb.className = "hint";
    fb.title = "";
    if (getMode() === "llm") {
      fb.textContent = App.profiles().length ? "The AI turns your description into a search query — you'll see it before anything is added." : "Set up an AI in ⚙ Settings to use this mode.";
      return true;
    }
    const q = $("query").value.trim();
    if (!q) {
      fb.textContent = "";
      return true;
    }
    try {
      const ast = ZR.Query.parse(q);
      fb.textContent = "✓ " + ZR.Query.toCanonical(ast);
      fb.title = "Sent to databases as:\n" + ["openalex", "scopus", "arxiv", "wos", "s2bulk", "pubmed"].map((d) => `${d}: ${ZR.Query.compile(ast, d)}`).join("\n");
      fb.classList.add("ok");
      return true;
    } catch (e) {
      fb.textContent = "Query problem: " + e.message;
      fb.classList.add("error");
      return false;
    }
  }

  function readOptions() {
    const int = (id) => {
      const v = parseInt($(id).value, 10);
      return Number.isFinite(v) ? v : null;
    };
    const llm = getMode() === "llm";
    return {
      mode: llm ? ($("auto-import").checked ? "yolo" : "llm") : "structured",
      query: llm ? "" : $("query").value.trim(),
      request: $("request").value.trim(),
      sources: selectedSources(),
      limit: Math.max(1, Math.min(500, int("limit") || 25)),
      yearFrom: int("year-from"),
      yearTo: int("year-to"),
      oaOnly: $("oa-only").checked,
      fulltextOnly: $("fulltext-only").checked,
      strict: $("strict").checked,
      skipExisting: $("skip-existing").checked,
      hideExcluded: $("hide-excluded").checked,
      screen: llm && $("screen").checked,
      minScore: int("min-score") ?? 6,
      languages: [...pickedLangs],
      types: [...pickedTypes],
      minCitations: Math.max(0, int("min-cites") || 0),
      hasAbstract: $("has-abstract").checked,
      hasDOI: $("has-doi").checked,
    };
  }

  /** Current search settings (what a project remembers). */
  function currentState() {
    return stateOf(readOptions());
  }

  /** Remember the settings of a search: globally, and on the current project. */
  function saveState(o) {
    const s = stateOf(o);
    ZR.Prefs.setJSON("dialogState", s);
    if (App.project) ZR.Projects.rememberSearch(App.target.libraryID, App.project.id, s).catch((e) => Zotero.logError(e));
  }

  function stateOf(o) {
    return {
      mode: o.mode,
      query: $("query").value.trim(),
      request: o.request,
      sources: o.sources,
      yearFrom: o.yearFrom,
      yearTo: o.yearTo,
      limit: o.limit,
      oaOnly: o.oaOnly,
      fulltextOnly: o.fulltextOnly,
      strict: o.strict,
      skipExisting: o.skipExisting,
      hideExcluded: o.hideExcluded,
      screen: $("screen").checked,
      kwView,
      languages: o.languages,
      types: o.types,
      minCitations: o.minCitations,
      hasAbstract: o.hasAbstract,
      hasDOI: o.hasDOI,
      sort: $("res-sort").value,
    };
  }

  async function run() {
    if (App.busy) return;
    const o = readOptions();
    if (o.mode === "structured" && !o.query) return st("Type a query first — for example: (\"IFC5\" OR IFCX) AND BIM");
    if (o.mode !== "structured" && !o.request) return st("Describe what you are looking for first.");
    if (o.query && !validateQuery()) return;
    if (!o.sources.length) return st("Choose at least one source (📚 chip).");
    saveState(o);
    if (o.mode !== "structured") {
      try {
        o.llmProfile = App.profile();
      } catch (e) {
        return st(e.message);
      }
    }
    o.libraryID = App.target.libraryID;
    App.setBusy("search", true);
    $("search-empty").hidden = true;
    $("results").replaceChildren();
    $("results-head").hidden = true;
    $("plan-box").hidden = true;
    try {
      lastRun = await ZR.Search.run(o, st);
      // A review screens everything it finds (that is what the flow diagram counts)
      if (App.project?.kind === "review") for (const r of lastRun.records) r.selected = true;
      if (lastRun.plan) showPlan(lastRun.plan);
      renderResults();
      const rm = Object.values(lastRun.removedByFilters || {}).reduce((a, b) => a + b, 0);
      st(`${lastRun.records.length} papers found · ` + Object.entries(lastRun.perSource).map(([id, s]) => `${ZR.Sources.get(id).name} ${s.error ? "⚠" : s.count}`).join(" · ") + (rm ? ` · ${rm} removed by filters` : ""));
      // Hover the status line for per-database counts, errors and response times
      $("search-status").title = Object.entries(lastRun.perSource)
        .map(([id, s]) => `${ZR.Sources.get(id).name}: ${s.error ? "⚠ " + s.error : s.count + " results"}${s.ms != null ? ` (${(s.ms / 1000).toFixed(1)} s)` : ""}`)
        .join("\n");
      if (o.mode === "yolo") {
        App.setBusy("search", false);
        await importSelected(true);
      }
    } catch (e) {
      Zotero.logError(e);
      st("Search failed: " + e.message);
    } finally {
      App.setBusy("search", false);
      updateImportBar();
    }
  }

  function showPlan(plan) {
    const box = $("plan-box");
    box.replaceChildren(
      el("div", {}, [el("b", { text: "The AI searched for: " }), el("code", { text: plan.query })]),
      plan.rationale ? el("div", { class: "hint", text: plan.rationale }) : null,
      el("div", {}, el("button", { class: "link", text: "Edit this query as keywords", onclick: () => (setMode("structured"), useQueryText(plan.query)) }))
    );
    box.hidden = false;
  }

  /** Show externally produced records (related papers, citation gaps) as results. */
  function showRecords(records, meta) {
    lastRun = Object.assign(
      { started: new Date().toISOString().replace("T", " ").slice(0, 19), filtersText: "", identified: records.length, deduped: records.length, perSource: { openalex: { count: records.length, query: meta.query } } },
      meta,
      { records }
    );
    $("search-empty").hidden = true;
    $("plan-box").replaceChildren(el("div", {}, [el("b", { text: meta.title || "Suggested papers" }), el("div", { class: "hint", text: meta.description || "" })]));
    $("plan-box").hidden = false;
    renderResults();
  }

  async function runRelated(items) {
    items = (items || []).filter((i) => i?.isRegularItem());
    App.showTab("search");
    if (!items.length) return st("Select papers with a DOI first.");
    App.setBusy("search", true);
    try {
      st(`Collecting what ${items.length} paper(s) cite and related works (OpenAlex)…`);
      const records = await ZR.Search.related(items, { limit: 60 });
      for (const r of records) {
        const hit = await ZR.Importer.findExisting(App.target.libraryID, r);
        r.existingItemID = hit ? hit.id : null;
      }
      await ZR.Store.annotateRecords(App.target.libraryID, records);
      for (const r of records) r.selected = !r.existingItemID && r.prior?.ta?.d !== "exclude";
      showRecords(records, {
        mode: "related",
        query: items.map((i) => i.getField("DOI") || i.getField("title")).join("; "),
        title: `Related to ${items.length} selected paper(s)`,
        description: "References and related works from OpenAlex, ranked by how many of your papers point to them.",
      });
      st(`${records.length} related papers`);
    } catch (e) {
      st("Could not collect related papers: " + e.message);
    } finally {
      App.setBusy("search", false);
    }
  }

  const scoreClass = (s) => (s >= 7 ? "hi" : s >= 4 ? "md" : "lo");

  function priorTag(r) {
    const p = r.prior;
    const s = p?.ft || p?.ta;
    if (!s) return p?.unscreened ? el("span", { class: "tag maybe", text: "in review, not screened" }) : null;
    const cls = { include: "included", exclude: "excluded", maybe: "maybe" }[s.d];
    return el("span", { class: "tag " + cls, text: ZR.Store.describe(p), title: "Remembered decision" });
  }

  async function mark(r, value) {
    const reasons = App.project?.protocol?.reasons?.length ? App.project.protocol.reasons : ZR.Prisma.DEFAULT_REASONS;
    const map = { relevant: ["include", ""], off: ["exclude", reasons[0]], weak: ["exclude", reasons.find((x) => /weak/i.test(x)) || "Weak / low quality"] };
    const [d, reason] = map[value] || [null, ""];
    await ZR.Store.decide({
      libraryID: App.target.libraryID,
      key: r.key || ZR.Store.keyForRecord(r),
      item: r.existingItemID ? Zotero.Items.get(r.existingItemID) : null,
      title: r.title,
      stage: "ta",
      d,
      r: reason,
      collectionKey: App.target.collectionKey,
    });
    r.prior = d ? { ta: { d, r: reason, by: "me", at: new Date().toISOString().slice(0, 10) } } : null;
    if (d === "exclude") r.selected = false;
    if (d === "include" && !r.existingItemID) r.selected = true;
    renderResults();
  }

  function renderResults() {
    const box = $("results");
    box.replaceChildren();
    if (!lastRun) return;
    const sortFn = ZR.Search.SORTS[$("res-sort").value];
    const recs = sortFn ? lastRun.records.slice().sort(sortFn) : lastRun.records;
    const filter = $("res-filter").value.trim().toLowerCase();
    $("results-head").hidden = false;
    if (!recs.length) {
      box.append(el("div", { class: "empty-state", text: "Nothing found. Try fewer or broader terms, more sources, or fewer filters." }));
    }
    for (const r of recs) {
      if (filter && !`${r.title} ${r.venue} ${r.abstract} ${ZR.Records.creatorsToString(r.creators, 20)}`.toLowerCase().includes(filter)) continue;
      const link = r.url || (r.doi ? `https://doi.org/${r.doi}` : "");
      const excluded = (r.prior?.ft || r.prior?.ta)?.d === "exclude";
      const row = el("div", { class: "result" + (r.existingItemID || excluded ? " muted" : "") }, [
        el("input", { type: "checkbox", checked: r.selected, onchange: (e) => ((r.selected = e.target.checked), updateImportBar()) }),
        el("div", { class: "r-main" }, [
          el("div", { class: "r-title" }, [
            r.existingItemID
              ? el("a", { href: "#", text: r.title, title: "In your library — click to show it in Zotero", onclick: (e) => (e.preventDefault(), openInLibrary(r, row)) })
              : link
                ? el("a", { href: "#", text: r.title, title: "Open the paper's web page", onclick: (e) => (e.preventDefault(), Zotero.launchURL(link)) })
                : r.title,
            r.existingItemID && link ? el("a", { href: "#", class: "web", text: "web ↗", title: link, onclick: (e) => (e.preventDefault(), Zotero.launchURL(link)) }) : null,
          ]),
          el("div", { class: "r-meta", text: [ZR.Records.creatorsToString(r.creators), r.year, r.venue].filter(Boolean).join(" · ") }),
          r.abstract ? el("div", { class: "r-abstract", text: r.abstract, title: "Click to expand", onclick: () => row.classList.toggle("expanded") }) : null,
          el("div", { class: "r-tags" }, [
            r.existingItemID ? el("span", { class: "tag lib", text: "in library" }) : null,
            priorTag(r),
            r.seenBefore && !r.prior && !r.existingItemID ? el("span", { class: "tag", text: `seen ${r.seenBefore}`, title: "Appeared in an earlier search" }) : null,
            r.pdfURLs.length ? el("span", { class: "tag pdf", text: "PDF" }) : r.isOA ? el("span", { class: "tag pdf", text: "open access" }) : null,
            r.citedByCollection ? el("span", { class: "tag", text: `cited by ${r.citedByCollection} of yours` }) : null,
            ...r.sources.map((s) => el("span", { class: "tag", text: ZR.Sources.get(s)?.name || s })),
          ]),
        ]),
        el("div", { class: "r-side" }, [
          el("div", { class: "r-side-row" }, [
            r.citationCount ? el("span", { class: "hint", text: `${r.citationCount} citations` }) : null,
            el("select", { class: "mark", title: "Remember your judgement for future searches", onchange: (e) => mark(r, e.target.value) }, [
            el("option", { value: "", text: "Judge" }),
            el("option", { value: "relevant", text: "👍 Relevant" }),
            el("option", { value: "off", text: "👎 Not relevant" }),
            el("option", { value: "weak", text: "👎 Weak / low quality" }),
            el("option", { value: "clear", text: "Forget judgement" }),
            ]),
          ]),
          r.llmScore != null ? el("span", { class: "score " + scoreClass(r.llmScore), text: String(r.llmScore), title: "AI relevance 0–10" }) : null,
          r.llmReason ? el("span", { class: "reason", text: r.llmReason }) : null,
        ]),
      ]);
      box.append(row);
    }
    updateImportBar();
  }

  /**
   * A result already in the library: jump to it in Zotero (default), or — if set in
   * Settings — list every collection it is in, each one clickable.
   */
  function openInLibrary(r, row) {
    const reveal = (opts) => App.ZR.UI.revealItem(r.existingItemID, Object.assign({ preferCollectionID: App.target.collectionID }, opts));
    if (ZR.Prefs.get("resultClick", "jump") !== "collections") return reveal();
    const existing = row.querySelector(".in-cols");
    if (existing) return existing.remove();
    const item = Zotero.Items.get(r.existingItemID);
    const cols = App.ZR.UI.collectionsOf(item);
    row.querySelector(".r-main").append(
      el("div", { class: "in-cols" }, [
        el("span", { class: "hint", text: cols.length ? "In:" : "In your library, not in any collection:" }),
        ...(cols.length
          ? cols.map((c) => el("a", { href: "#", text: c.label, onclick: (e) => (e.preventDefault(), reveal({ collectionID: c.id })) }))
          : [el("a", { href: "#", text: Zotero.Libraries.get(item.libraryID).name, onclick: (e) => (e.preventDefault(), reveal()) })]),
      ])
    );
  }

  function selectAll(on) {
    if (!lastRun) return;
    for (const r of lastRun.records) r.selected = on && !r.existingItemID;
    renderResults();
  }

  function updateImportBar() {
    if (!ZR) return;
    const n = lastRun ? lastRun.records.filter((r) => r.selected).length : 0;
    $("import-bar").hidden = !lastRun;
    $("results-count").textContent = lastRun ? `${lastRun.records.length} papers · ${n} selected` : "";
    const where = `“${App.target.label.split(" › ").pop()}”`;
    const review = App.project?.kind === "review";
    $("import").textContent = review ? `Add ${n} to the screening pool` : `Add ${n} to ${where}`;
    $("import-summary").textContent = review
      ? `“${App.project.name}” is a structured review: papers go into its screening pool (not your library yet) and the search is logged.`
      : $("attach-pdfs").checked
        ? "PDFs are downloaded where legally available."
        : "";
    $("import").dataset.disabledReason = !n || !App.target.editable ? "1" : "";
    $("import").disabled = App.busy || !n || !App.target.editable;
  }

  async function importSelected(auto) {
    if (!lastRun) return;
    if (!App.target.editable) return st("This library or collection is read-only.");
    const recs = lastRun.records.filter((r) => r.selected);
    if (!recs.length) return st(auto ? "Automatic mode: nothing scored high enough — nothing was added." : "Nothing selected.");
    App.setBusy("search", true);
    try {
      const libraryID = App.target.libraryID;
      if (App.project?.kind === "review") {
        // Review: into the candidate pool; papers reach Zotero when they pass screening
        const { added, known } = await ZR.Projects.addToPool(libraryID, App.project.id, recs);
        const run = ZR.Prisma.runRecord(Object.assign({}, lastRun, { imported: added, inLibraryCount: 0, deduped: Math.max(0, (lastRun.deduped ?? lastRun.records.length) - known) }));
        await ZR.Projects.addRun(libraryID, App.project.id, run);
        for (const r of recs) r.selected = false;
        renderResults();
        const msg = `${auto ? "Automatic mode: " : ""}Added ${added} paper(s) to the screening pool of “${App.project.name}”${known ? `, ${known} were already in it` : ""}.`;
        st(msg + " Screen them in the Review tab.");
        App.panels.review.reset();
        // Came here from the review's "Find papers" step: continue with screening
        if (App.reviewFlow) {
          App.reviewFlow = false;
          App.panels.review.setStep("screen");
          App.status("review", msg + " Next: rate them with System 1, then screen.");
          App.showTab("review");
        }
        return;
      }
      // Quick search: a collection remembers its searches in a project (created on first use)
      if (!App.project && App.target.collectionKey) {
        const name = App.target.label.split(" › ").pop();
        App.project = await ZR.Projects.create(libraryID, { name, kind: "quick", collectionKey: App.target.collectionKey, search: currentState() });
        await App.loadProjects(App.project.id);
      }
      const tag = $("tag").value.trim();
      const stats = await ZR.Search.importRecords(
        lastRun,
        recs,
        {
          libraryID,
          collectionID: App.target.collectionID,
          collectionKey: App.target.collectionKey,
          attachPDFs: $("attach-pdfs").checked,
          fulltextOnly: $("fulltext-only").checked,
          tags: tag ? [tag] : [],
          protocolNote: $("protocol").checked,
        },
        st
      );
      if (App.project) await ZR.Projects.addRun(libraryID, App.project.id, ZR.Prisma.runRecord(lastRun));
      for (const r of recs) r.selected = false;
      renderResults();
      st(
        `${auto ? "Automatic mode: " : ""}Added ${stats.imported} new paper(s)` +
          (stats.existing ? `, ${stats.existing} were already in the library (now in this collection)` : "") +
          (stats.withPDF ? `, ${stats.withPDF} with PDF` : "") +
          (stats.droppedNoPDF ? `, ${stats.droppedNoPDF} skipped (no PDF available)` : "") +
          (stats.failed ? `, ${stats.failed} failed (see Help → Debug Output)` : "") +
          (App.project ? ` · logged in project “${App.project.name}”` : "")
      );
    } catch (e) {
      Zotero.logError(e);
      st("Adding failed: " + e.message);
    } finally {
      App.setBusy("search", false);
      updateImportBar();
    }
  }

  return { init, renderSources, runRelated, showRecords, updateImportBar, setMode, setView, useQueryText, loadProject, currentState, onShow: updateImportBar };
})();

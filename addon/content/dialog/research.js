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

/**
 * The colour of Zotero's divider lines: from an element that draws one, else from
 * --material-panedivider, which may be a whole border ("1px solid …"), not a colour.
 */
function zoteroLine(mw, mdoc, cs) {
  for (const [sel, side] of [[".tag-selector-filter-container", "Top"], ["#zotero-collections-toolbar", "Bottom"], ["#zotero-items-toolbar", "Bottom"], ["#tab-bar-container", "Bottom"]]) {
    const node = mdoc.querySelector(sel);
    if (!node) continue;
    const st = mw.getComputedStyle(node);
    if (parseFloat(st["border" + side + "Width"]) > 0 && st["border" + side + "Style"] !== "none") return st["border" + side + "Color"];
  }
  const v = cs.getPropertyValue("--material-panedivider").trim();
  if (!v) return "";
  const probe = document.createElement("div");
  probe.style.borderTop = /^(#|rgb|hsl|color\(|[a-z]+$)/i.test(v) ? "1px solid " + v : v;
  if (!probe.style.borderTop) return "";
  document.body.append(probe);
  const c = window.getComputedStyle(probe).borderTopColor;
  probe.remove();
  return c;
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
    if (on && !window.Autopilot?.isStopping()) App.ZR.Activity.resume();
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
    const shown = App.panels[name]?.onShow?.();
    if (name === "search") App.grow($("query"));
    return shown;
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
    // The autopilot runs some steps with a model of its own
    if (App.profileOverride) return App.profileOverride;
    const p = App.ZR.Prefs.getActiveLLMProfile();
    if (!p) throw new Error("No AI is set up yet. Add one under ⚙ Settings → AI providers.");
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
    $("target").title = t.editable ? "Where papers are added" : "This library or collection is read-only: adding papers is disabled";
    // where papers go is in the project's right-click Info; the line only shows as a read-only warning
    $("target").hidden = t.editable;
    $("project-select").title = `Project: remembers its search settings, history and review. Adds papers to ${t.label}. Right-click: info, delete`;
    const empty = $("empty-target");
    if (empty) empty.textContent = t.label;
  },

  /** Load the library's projects and pick the one for the current collection. */
  async loadProjects(preferID) {
    App.projects = await App.ZR.Projects.list(App.target.libraryID);
    let p = preferID ? App.projects.find((x) => x.id === preferID) : null;
    if (!p && App.project) p = App.projects.find((x) => x.id === App.project.id);
    if (!p && App.target.collectionKey) {
      // several projects can share a collection: the one used last there, else the latest
      const last = App.ZR.Prefs.getJSON("lastProjects", {})[`${App.target.libraryID}:${App.target.collectionKey}`];
      p = App.projects.find((x) => x.id === last && x.collectionKey === App.target.collectionKey) || App.projects.find((x) => x.collectionKey === App.target.collectionKey);
    }
    App.rememberProject(p);
    App.project = p || null;
    App.renderProjects();
  },

  /** Remember which project was used on its collection (for the next time the window opens there). */
  rememberProject(p) {
    if (!p?.collectionKey) return;
    const map = App.ZR.Prefs.getJSON("lastProjects", {});
    const k = `${App.target.libraryID}:${p.collectionKey}`;
    if (map[k] === p.id) return;
    map[k] = p.id;
    App.ZR.Prefs.setJSON("lastProjects", map);
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
    // right-click on a project (the button or an entry of its menu)
    sel.zrContextMenu = (id, e) => {
      if (id === "__new") return PaperView.openMenu(e.clientX, e.clientY, [{ id: "ctx-new-project", icon: "add", label: "New project…", run: () => (ZRDropdown.close(), App.newProject()) }]);
      const p = App.projects.find((x) => x.id === id) || null;
      const items = [{ id: "ctx-project-info", icon: "info", label: p ? "Info" : "Where papers are added", run: () => (ZRDropdown.close(), App.projectInfo(p, e.clientX, e.clientY)) }];
      items.push({ id: "ctx-new-project", icon: "add", label: "New project…", run: () => (ZRDropdown.close(), App.newProject()) });
      if (p) items.push("-", { id: "ctx-delete-project", icon: "trash", danger: true, label: `Delete “${p.name}”…`, run: () => (ZRDropdown.close(), App.deleteProject(p.id)) });
      PaperView.openMenu(e.clientX, e.clientY, items);
    };
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
    if (window.Autopilot?.isRunning()) Autopilot.pause();
    window.Autopilot?.hide();
    App.project = p;
    App.rememberProject(p);
    if (p?.collectionKey && p.collectionKey !== App.target.collectionKey) {
      const t = App.ZR.UI.targetFor(App.target.libraryID, p.collectionKey);
      if (t) App.setTarget(t);
      else App.status("search", `The collection of “${p.name}” no longer exists: papers go to ${App.target.label}.`);
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
    // Any collection can be used, also one that another project works with: its papers are
    // reused, and each project keeps its own decisions.
    const sharedNote = (p) => (p ? `Shared with project “${p.name}”: its papers are reused, each project keeps its own decisions.` : "");
    const use = document.querySelector('input[name="np-col"][value="use"]');
    use.disabled = !col;
    use.checked = !!col && !taken;
    document.querySelector('input[name="np-col"][value="new"]').checked = !use.checked;
    $("np-use-label").textContent = col ? `Use the current collection “${col}”` : "Use the current collection (none selected: you are in the library root)";
    $("np-use-note").textContent = sharedNote(taken);
    const cols = App.collectionList(t.libraryID);
    const other = $("np-col-other");
    other.replaceChildren(...cols.map((c) => el("option", { value: c.key, text: c.label + (App.projects.some((p) => p.collectionKey === c.key) ? "  ◆" : ""), selected: c.key === t.collectionKey })));
    const showOther = () => ($("np-other-note").textContent = sharedNote(App.projects.find((p) => p.collectionKey === other.value)));
    other.onchange = () => ((document.querySelector('input[name="np-col"][value="other"]').checked = true), showOther());
    showOther();
    $("np-other-wrap").hidden = !cols.length;
    // Autopilot option for review projects
    const profiles = App.profiles();
    $("np-ap-profile").replaceChildren(...profiles.map((p) => el("option", { value: p.id, text: `${p.name}${p.model ? " · " + p.model : ""}` })));
    $("np-ap-on").checked = false;
    $("np-ap-on").disabled = !profiles.length;
    $("np-ap-fields").hidden = true;
    $("np-ap").hidden = kind !== "review";
    $("np-layer").hidden = false;
    setTimeout(() => $("np-name").focus(), 0);
  },

  async createProject() {
    const ZR = App.ZR;
    const name = $("np-name").value.trim();
    if (!name) return $("np-name").focus();
    const kind = document.querySelector('input[name="np-kind"]:checked').value;
    const choice = document.querySelector('input[name="np-col"]:checked').value;
    const newCol = choice === "new";
    const library = Zotero.Libraries.get(App.target.libraryID);
    if (!library.editable) return App.status("search", "This library is read-only.");
    let collectionKey = choice === "other" ? $("np-col-other").value : App.target.collectionKey;
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
    if (collectionKey !== App.target.collectionKey) App.setTarget(ZR.UI.targetFor(App.target.libraryID, collectionKey));
    $("np-layer").hidden = true;
    await App.loadProjects(p.id);
    App.panels.review.reset();
    App.panels.search.loadProject();
    if (kind === "review") {
      App.showTab("review");
      if ($("np-ap-on").checked && $("np-ap-question").value.trim()) Autopilot.start({ profileID: $("np-ap-profile").value, question: $("np-ap-question").value.trim(), stage: "protocol" });
      return;
    }
    App.status("search", `Project “${name}” created: its search settings and history are remembered.`);
    await App.panels[App.currentTab]?.onShow?.();
  },

  /** Every collection of a library as {key, label: "Parent › Child"}, in tree order. */
  collectionList(libraryID) {
    const out = [];
    const walk = (cols, path) => {
      for (const c of cols.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const label = path ? `${path} › ${c.name}` : c.name;
        out.push({ key: c.key, label });
        walk(Zotero.Collections.getByParent(c.id), label);
      }
    };
    walk(Zotero.Collections.getByLibrary(libraryID), "");
    return out;
  },

  /** Small SVG icons (Material paths). */
  icon(name) {
    const PATHS = {
      play: "M8 5v14l11-7z",
      pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
      stop: "M6 6h12v12H6z",
      collapse: "M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z",
      expand: "M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z",
      help: "M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z",
      settings:
        "M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.57.57 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.06.02.12.03.18.03.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zm-1.98-1.71c.04.31.05.52.05.73 0 .21-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7.14 1.13zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z",
      trash: "M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z",
      sparkle: "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z",
      pencil: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
      history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
      list: "M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z",
      text: "M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z",
      add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
      close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
      jump: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z",
      replay: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
      info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", PATHS[name] || "");
    svg.append(path);
    return svg;
  },

  /**
   * Line up with Zotero's main window: our header ends where its tab bar ends, and our
   * footer line sits where the line above its tag filter is (both measured from the
   * window edges, so it holds for any title bar or DPI). The autopilot header matches
   * the review's subheader.
   */
  syncLayout() {
    const root = document.documentElement.style;
    try {
      const mw = Zotero.getMainWindow();
      const mdoc = mw?.document;
      const top = (w) => w.mozInnerScreenY - w.screenY; // title bar above the content
      const tabs = mdoc?.getElementById("tab-bar-container") || mdoc?.getElementById("zotero-title-bar");
      const tr = tabs?.getBoundingClientRect();
      if (tr?.height) {
        const h = Math.round(top(mw) + tr.bottom - top(window));
        if (h >= 36 && h <= 120) root.setProperty("--header-h", h + "px");
      }
      const filter = mdoc?.querySelector(".tag-selector-filter-container");
      const fr = filter?.getBoundingClientRect();
      if (fr?.height) {
        const fromBottom = mw.screenY + mw.outerHeight - (mw.mozInnerScreenY + fr.top);
        const ourChrome = window.screenY + window.outerHeight - (window.mozInnerScreenY + window.innerHeight);
        const h = Math.round(fromBottom - ourChrome);
        if (h >= 24 && h <= 90) root.setProperty("--statusbar-h", h + "px");
      }
      // Zotero's grey for the chrome (its header and the library pane), light or dark
      const cs = mw.getComputedStyle(mdoc.documentElement);
      const paint = (node) => {
        const c = node && mw.getComputedStyle(node).backgroundColor;
        return c && c !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(c) ? c : "";
      };
      const side = cs.getPropertyValue("--material-sidepane").trim() || paint(mdoc.getElementById("zotero-collections-pane"));
      if (side) root.setProperty("--chrome-bg", side);
      const line = zoteroLine(mw, mdoc, cs);
      if (line) root.setProperty("--chrome-line", line);
    } catch (e) {
      /* main window closed: keep the defaults */
    }
    const f = $("rv-funnel");
    if (f?.offsetHeight) root.setProperty("--subheader-h", f.offsetHeight + "px");
    const log = document.querySelector("#panel-review > .statusbar .log-btn");
    if (log?.offsetWidth) root.setProperty("--log-w", log.offsetWidth + "px");
  },

  /** A text area as tall as its text (no scrollbar, no cut-off lines). */
  grow(t) {
    if (!t?.offsetParent) return;
    t.style.height = "auto";
    t.style.height = t.scrollHeight + 2 + "px";
  },

  /** A boolean query as a coloured code block; top-level AND / NOT start a new line. */
  queryCode(text, attrs = {}) {
    const pre = el("pre", Object.assign({ class: "q-code" }, attrs));
    const parts = App.ZR.Query.syntax(String(text || "").replace(/\s+/g, " ").trim());
    parts.forEach((p, i) => {
      if (p.kind === "ws") {
        const next = parts[i + 1];
        return pre.append(next?.kind === "op" && next.top ? "\n" : p.text);
      }
      const cls = p.kind === "paren" ? `qk-paren qk-d${p.depth % 4}` : "qk-" + p.kind;
      pre.append(el("span", { class: cls, text: p.text }));
    });
    return pre;
  },

  /**
   * Query builder rows (terms per row are alternatives, rows combine with AND / OR / NOT /
   * XOR) drawn into a box. The text query stays the source of truth: onChange gets it.
   */
  queryBuilder(box, { onChange = () => {}, onEnter = null } = {}) {
    const QB = () => App.ZR.QueryBuilder;
    const emptyRow = () => ({ op: "AND", field: "any", terms: [] });
    let blocks = [];
    let lastCompiled = null;
    const sync = () => {
      lastCompiled = QB().toQuery(blocks);
      onChange(lastCompiled);
    };
    /** Show a text query as rows; false when it has nesting the rows can't show. */
    function load(q) {
      q = String(q || "").trim();
      if (q !== lastCompiled || !blocks.length) {
        const b = QB().fromQuery(q);
        if (!b) return false;
        blocks = b;
        lastCompiled = q;
      }
      if (!blocks.length) blocks = [emptyRow()];
      return true;
    }
    function render(focusRow = -1) {
      box.replaceChildren();
      box.title = "Terms in one row are alternatives (OR). Rows combine with AND, OR, NOT or XOR. Multi-word terms are exact phrases; build* matches word endings.";
      const multi = blocks.length > 1;
      blocks.forEach((b, i) => {
        const input = el("input", { type: "text", class: "qb-input", spellcheck: "false", placeholder: b.terms.length ? "or…" : i === 0 ? "Type a term and press Enter, e.g. IFC5" : "Type a term and press Enter" });
        const addTerms = (text) => {
          const parts = String(text).split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
          if (!parts.length) return false;
          b.terms.push(...parts);
          sync();
          render(i);
          return true;
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!addTerms(input.value)) onEnter?.();
          } else if (e.key === "," || e.key === ";") {
            e.preventDefault();
            addTerms(input.value);
          } else if (e.key === "Backspace" && !input.value && b.terms.length) {
            b.terms.pop();
            sync();
            render(i);
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
          chips.append(el("span", { class: "qb-chip" }, [t, el("button", { title: "Remove term", text: "×", onclick: () => (b.terms.splice(k, 1), sync(), render(i)) })]));
        });
        chips.append(input);
        let lead = null;
        if (i > 0) lead = el("span", { class: "qb-lead" }, el("select", { class: "qb-op", title: "How this row combines with the rows above", onchange: (e) => ((b.op = e.target.value), sync()) }, QB().OPS.map((o) => el("option", { value: o.id, text: o.label, title: o.hint, selected: b.op === o.id }))));
        else if (multi) lead = el("span", { class: "qb-lead qb-first", text: "Find" });
        box.append(
          el("div", { class: "qb-row" }, [
            lead,
            el("select", { class: "qb-field", title: "Where the terms must appear", onchange: (e) => ((b.field = e.target.value), sync()) }, QB().FIELDS.map((x) => el("option", { value: x.id, text: x.label, selected: b.field === x.id }))),
            chips,
            multi ? el("button", { class: "qb-remove", title: "Remove this row", text: "×", onclick: () => (blocks.splice(i, 1), sync(), render()) }) : null,
          ])
        );
        if (i === focusRow) setTimeout(() => input.focus(), 0);
      });
      box.append(el("button", { class: "link qb-add", text: "+ Add condition", title: "Add a row combined with AND, OR, NOT or XOR", onclick: () => (blocks.push(emptyRow()), render(blocks.length - 1)) }));
    }
    return { load, render };
  },

  /** Scroll areas fade out under the edge they scroll under (only on the side with more content). */
  FADE: ".scroll, .queue-list, .ap-log, .ap-prompt, .anno-list, .audit-table, .ap-search-body",
  fade(s) {
    const more = s.scrollHeight - s.clientHeight > 2;
    s.classList.toggle("fade-top", more && s.scrollTop > 1);
    s.classList.toggle("fade-bottom", more && s.scrollTop + s.clientHeight < s.scrollHeight - 1);
  },
  fadeAll() {
    for (const s of document.querySelectorAll(App.FADE)) if (s.offsetParent) App.fade(s);
  },

  /** Right-click → Info: where the project adds papers, its kind and history. p = null: no project. */
  projectInfo(p, x, y) {
    $("project-info")?.remove();
    const t = !p || p.id === App.project?.id ? App.target : App.ZR.UI.targetFor(App.target.libraryID, p.collectionKey);
    const m = p?.kind === "review" ? App.ZR.Methodologies.get(p.methodology) : null;
    const date = (s) => (s ? new Date(s).toLocaleDateString() : "");
    const rows = [
      ["Adds papers to", t ? t.label : "(its collection no longer exists)"],
      ...(t && !t.editable ? [["Note", "Read-only: adding papers is disabled"]] : []),
      ...(p
        ? [
            ["Type", m ? `Structured review · ${m.name}` : "Quick search"],
            ["Searches", String((p.runs || []).length)],
            ["Created", date(p.created)],
            ["Last change", date(p.updated)],
          ]
        : [["Project", "none: searches are not remembered"]]),
    ].filter(([, v]) => v);
    const pop = el("div", { id: "project-info", class: "project-info", role: "dialog" }, [
      el("div", { class: "ap-pop-title", text: p ? p.name : "No project" }),
      el("div", { class: "ap-facts" }, rows.flatMap(([k, v]) => [el("span", { class: "ap-fk", text: k }), el("span", { class: "ap-fv", text: v })])),
    ]);
    document.body.append(pop);
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    pop.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
    const close = (e) => {
      if (e.type === "keydown" ? e.key !== "Escape" : pop.contains(e.target)) return;
      pop.remove();
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", close, true);
    };
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", close, true);
  },

  async deleteProject(id = App.project?.id) {
    const p = App.projects.find((x) => x.id === id);
    if (!p) return;
    const current = App.project?.id === p.id;
    const c = await App.ask(
      `Delete the project “${p.name}”?`,
      "The collection and its papers stay in Zotero, and so do your decisions on the papers. Removed: the project's settings, protocol, search log and audit trail, candidate pool, System 1 ratings, highlights and the autopilot conversation. This cannot be undone.",
      [
        { id: "cancel", label: "Cancel" },
        { id: "delete", label: "Delete project", danger: true },
      ]
    );
    if (c !== "delete") return;
    if (current) {
      if (window.Autopilot?.isRunning()) Autopilot.stop();
      window.Autopilot?.hide();
    }
    await App.ZR.Projects.remove(App.target.libraryID, p.id);
    if (current) App.project = null;
    await App.loadProjects(current ? null : App.project?.id);
    if (current) {
      App.project = null;
      App.renderProjects();
      App.panels.review.reset();
      App.panels.search.loadProject();
    }
    App.status(App.currentTab === "review" ? "review" : "search", `Project “${p.name}” deleted.`);
    await App.panels[App.currentTab]?.onShow?.();
  },

  /** Ask a question in the window (no modal dialog). choices: [{id, label, primary?}] → resolves the chosen id. */
  ask(title, text, choices) {
    return new Promise((resolve) => {
      const layer = el(
        "div",
        { class: "modal-layer", id: "ask-layer" },
        el("div", { class: "modal", role: "dialog" }, [
          el("h2", { text: title }),
          el("p", { class: "ask-text", text }),
          el("div", { class: "actions" }, [
            el("span", { class: "spacer" }),
            ...choices.map((c) => el("button", { class: c.danger ? "danger-solid" : c.primary ? "primary" : "", "data-choice": c.id, text: c.label, onclick: () => (layer.remove(), resolve(c.id)) })),
          ]),
        ])
      );
      document.body.append(layer);
      layer.querySelector("button.primary")?.focus();
    });
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
      ["crawler", "Crawlers"],
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
      const stopAllBtn = document.getElementById("log-stop-all");
      if (stopAllBtn) stopAllBtn.hidden = !Act.running().some((e) => e.cancel);
      const rows = Act.list()
        .filter((e) => filter === "all" || e.kind === filter)
        .reverse()
        .slice(0, 250);
      list.replaceChildren(
        ...(rows.length
          ? rows.map((e) => {
              const ms = (e.ended || now) - e.started;
              const slow = !e.ended && ms > 60000;
              const state = !e.ended ? (slow ? `running ${secs(ms)}: no answer yet` : `running ${secs(ms)}`) : e.ok ? secs(ms) : "failed";
              const row = el("div", { class: `log-row ${e.ended ? (e.ok ? "ok" : "err") : "run"}${slow ? " slow" : ""}`, onclick: () => (open.has(e.id) ? open.delete(e.id) : open.add(e.id), render()) }, [
                el("span", { class: "log-time", text: clock(e.started) }),
                el("span", { class: "log-kind k-" + e.kind, text: e.kind }),
                el("span", { class: "log-label", text: e.label }),
                el("span", { class: "log-state" }, [
                  state,
                  !e.ended && e.cancel ? el("button", { class: "log-stop", title: "Stop this request / program now", text: "Stop", onclick: (ev) => (ev.stopPropagation(), Act.cancel(e.id)) }) : null,
                ]),
              ]);
              if (!open.has(e.id)) return row;
              return el("div", {}, [row, el("pre", { class: "log-detail", text: [e.detail, e.result ? (e.ok === false ? "Error: " : "Result: ") + e.result : ""].filter(Boolean).join("\n\n") || "(no details)" })]);
            })
          : [el("div", { class: "hint log-empty", text: "Nothing yet: requests to databases, AI models, CLIs and the local model appear here while they run." })])
      );
    }
    const panel = el("div", { id: "log-panel", class: "log-panel", role: "dialog", "aria-label": "Activity log" }, [
      el("div", { class: "log-head" }, [
        el("b", { text: "Activity" }),
        seg,
        el("span", { class: "spacer" }),
        el("button", { id: "log-stop-all", class: "danger-soft", text: "Stop all", title: "Cancel every running request and CLI run now (the autopilot stops too)", onclick: () => (window.Autopilot?.isRunning() ? Autopilot.stop() : Act.stopAll()) }),
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
    const path = typeof fp.file === "string" ? fp.file : fp.file.path;
    if (content instanceof Uint8Array) await IOUtils.write(path, content); // images
    else await Zotero.File.putContentsAsync(path, content);
    return path;
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
  $("help").append(App.icon("help"));
  $("open-prefs").append(App.icon("settings"));
  // fading scroll edges: on scroll, and whenever content or size changes
  document.addEventListener("scroll", (e) => e.target.matches?.(App.FADE) && App.fade(e.target), true);
  let fadeQueued = false;
  const queueFade = () => fadeQueued || ((fadeQueued = true), requestAnimationFrame(() => ((fadeQueued = false), App.fadeAll())));
  new MutationObserver(queueFade).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  window.addEventListener("resize", queueFade);
  $("project-select").addEventListener("change", (e) => App.switchProject(e.target.value).catch((err) => (Zotero.logError(err), App.status("search", err.message))));
  $("np-cancel").addEventListener("click", () => ($("np-layer").hidden = true));
  $("np-create").addEventListener("click", () => App.createProject().catch((err) => (Zotero.logError(err), App.status("search", "Could not create the project: " + err.message))));
  $("np-name").addEventListener("keydown", (e) => e.key === "Enter" && $("np-create").click());
  for (const r of document.querySelectorAll('input[name="np-kind"]')) r.addEventListener("change", () => ($("np-ap").hidden = document.querySelector('input[name="np-kind"]:checked').value !== "review"));
  $("np-ap-on").addEventListener("change", () => ($("np-ap-fields").hidden = !$("np-ap-on").checked));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !$("np-layer").hidden && ($("np-layer").hidden = true));
  for (const b of document.querySelectorAll(".log-btn")) b.addEventListener("click", () => App.toggleLog());
  const offBadges = App.ZR.Activity.subscribe(() => App.updateLogBadges());
  window.addEventListener("unload", () => (offBadges(), App.closeLog()));

  await App.loadProjects();
  for (const p of Object.values(App.panels)) await p.init?.();
  App.syncLayout();
  window.addEventListener("resize", () => (App.syncLayout(), App.grow($("query"))));

  // Pick up settings changes (new AI profile, research areas, keys) when the window regains focus.
  window.addEventListener("focus", () => {
    App.syncLayout();
    for (const s of document.querySelectorAll("select[data-llm]")) App.fillProfileSelect(s);
    App.panels.search.renderSources?.();
  });

  // Opened from the PDF reader: go to the paper in its review
  if (App.args.projectID && App.projects.some((p) => p.id === App.args.projectID)) {
    await App.switchProject(App.args.projectID);
    if (App.args.step) App.panels.review.setStep(App.args.step);
    if (App.args.focusItemID) App.panels.review.focusItem(App.args.focusItemID);
  }
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
    $("request").value = s.request || "";
    $("year-from").value = s.yearFrom || "";
    $("year-to").value = s.yearTo || "";
    $("limit").value = s.limit || ZR.Prefs.get("maxPerSource", 25);
    $("no-limit").checked = s.limit === 0;
    $("limit").disabled = s.limit === 0;
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
    if (s.attachPDFs != null) $("attach-pdfs").checked = !!s.attachPDFs;
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
    if (viewing) {
      viewing = null;
      document.body.dataset.readonly = "";
      $("plan-box").hidden = true;
    }
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
    $("query").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault(); // Enter searches; the query wraps and grows instead of new lines
      if (!App.busy) run();
    });
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
    for (const id of ["year-from", "year-to", "limit", "no-limit", "fulltext-only", "oa-only", "strict", "skip-existing", "hide-excluded", "attach-pdfs", "screen", "auto-import", "min-cites", "has-abstract", "has-doi"]) {
      $(id).addEventListener("change", updateChips);
    }
    $("fulltext-only").addEventListener("change", () => $("fulltext-only").checked && ($("attach-pdfs").checked = true));
    $("no-limit").addEventListener("change", () => (($("limit").disabled = $("no-limit").checked), updateChips()));
    $("auto-import").addEventListener("change", () => ($("run").textContent = $("auto-import").checked && getMode() === "llm" ? "Search & add" : "Search"));
    validateQuery();
    updateChips();
    updateImportBar();
  }

  // ------------------------------------------------------ query builder ----
  // Builder rows and the text query are two views of the same query; #query always
  // holds the text that is actually searched.
  let kwView = "builder";
  let builder = null;

  function setView(view) {
    builder ||= App.queryBuilder($("builder"), {
      onChange: (q) => (($("query").value = q), validateQuery()),
      onEnter: () => !App.busy && run(),
    });
    if (view === "builder" && !builder.load($("query").value)) {
      view = "text";
      st("This query has nested groups the builder can't show. Keep editing it as text.");
    }
    kwView = view;
    for (const b of $("kw-view").children) {
      b.classList.toggle("on", b.dataset.view === view);
      b.setAttribute("aria-checked", String(b.dataset.view === view));
    }
    $("builder").hidden = view !== "builder";
    $("query").hidden = view !== "text";
    $("syntax-toggle").hidden = view !== "text";
    if (view === "builder") builder.render();
    else {
      App.grow($("query"));
      $("query").focus();
    }
  }

  /** Put query text into whichever view is active. */
  function useQueryText(text) {
    $("query").value = text;
    validateQuery();
    setView(kwView);
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
    parts.push(yf || yt ? `${yf || "…"}-${yt || "…"}` : "any year");
    parts.push($("no-limit").checked ? "no limit" : `${$("limit").value || 25} per source`);
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
    App.grow($("query"));
    const fb = $("query-feedback");
    fb.className = "hint";
    fb.title = "";
    if (getMode() === "llm") {
      fb.textContent = App.profiles().length ? "The AI turns your description into a search query: you'll see it before anything is added." : "Set up an AI in ⚙ Settings to use this mode.";
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
      limit: $("no-limit").checked ? 0 : Math.max(1, Math.min(500, int("limit") || 25)), // 0: no limit
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
      attachPDFs: $("attach-pdfs").checked,
    };
  }

  async function run() {
    if (App.busy) return;
    if (viewing && !viewing.editable) return st("This is a logged search, shown read-only. Click “Edit and run again” to change it.");
    const o = readOptions();
    if (o.mode === "structured" && !o.query) return st("Type a query first, for example: (\"IFC5\" OR IFCX) AND BIM");
    if (o.mode !== "structured" && !o.request) return st("Describe what you are looking for first.");
    if (o.query && !validateQuery()) return;
    if (!o.sources.length) return st("Choose at least one source (📚 chip).");
    let parent = null;
    if (viewing?.editable) {
      const choice = await App.ask(
        "New search or refinement?",
        `You changed search ${viewing.label}. Log this run as a refinement of ${viewing.label} (e.g. adjusted keywords or filters), or as a separate new search?`,
        [
          { id: "refine", label: `Refinement of ${viewing.label}`, primary: true },
          { id: "new", label: "New search" },
          { id: "cancel", label: "Cancel" },
        ]
      );
      if (choice === "cancel") return;
      if (choice === "refine") parent = viewing.run.id;
      closeRunView({ keepForm: true });
    }
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
      lastRun.id = "r" + Date.now().toString(36);
      lastRun.parent = parent;
      lastRun.settings = stateOf(o);
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
        el("input", { type: "checkbox", checked: r.selected, disabled: !!viewing && !viewing.editable, onchange: (e) => ((r.selected = e.target.checked), updateImportBar()) }),
        el("div", { class: "r-main" }, [
          el("div", { class: "r-title" }, [
            r.existingItemID
              ? el("a", { href: "#", text: r.title, title: "In your library. Click to show it in Zotero", onclick: (e) => (e.preventDefault(), openInLibrary(r, row)) })
              : link
                ? el("a", { href: "#", text: r.title, title: "Open the paper's web page", onclick: (e) => (e.preventDefault(), Zotero.launchURL(link)) })
                : r.title,
            r.existingItemID && link ? el("a", { href: "#", class: "web", text: "web ↗", title: link, onclick: (e) => (e.preventDefault(), Zotero.launchURL(link)) }) : null,
          ]),
          el("div", { class: "r-meta", text: [ZR.Records.creatorsToString(r.creators), r.year, r.venue].filter(Boolean).join(" · ") }),
          r.abstract ? el("div", { class: "r-abstract", text: r.abstract, title: "Click to expand", onclick: () => row.classList.toggle("expanded") }) : null,
          el("div", { class: "r-tags" }, [
            r.fate ? el("span", { class: "tag " + ({ pool: "included", known: "lib", removed: "excluded", unselected: "maybe" }[r.fate] || ""), text: { pool: "added to pool", known: "already in pool", removed: "not added", unselected: "not selected" }[r.fate], title: r.fateReason || "" }) : null,
            r.fate === "removed" ? el("span", { class: "tag", text: r.fateReason }) : null,
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
          r.llmScore != null ? el("span", { class: "score " + scoreClass(r.llmScore), text: String(r.llmScore), title: "AI relevance 0-10" }) : null,
          r.llmReason ? el("span", { class: "reason", text: r.llmReason }) : null,
        ]),
      ]);
      box.append(row);
    }
    updateImportBar();
  }

  /**
   * A result already in the library: jump to it in Zotero (default), or - if set in
   * Settings - list every collection it is in, each one clickable.
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

  /**
   * Run a search straight into the review's pool (the autopilot): the form shows the
   * settings, everything found goes into the pool and the search is logged.
   * @returns {{run, pool: {added, known, notAdded, runID}}}
   */
  /**
   * resume {sourceID: position} and continues (a run ID): fetch the rest of an earlier
   * search from where each database stopped, without asking for what came before.
   */
  async function searchIntoPool(settings, { parent = null, resume = null, continues = null } = {}) {
    if (viewing) closeRunView();
    applyState(Object.assign({}, ZR.Prefs.getJSON("dialogState", {}), settings));
    const o = Object.assign(readOptions(), { libraryID: App.target.libraryID });
    if (resume) Object.assign(o, { resume, sources: Object.keys(resume), limit: settings.limit ?? 0 });
    else saveState(o);
    App.setBusy("search", true);
    try {
      lastRun = await ZR.Search.run(o, st);
      lastRun.id = "r" + Date.now().toString(36);
      lastRun.parent = parent;
      lastRun.continues = continues;
      lastRun.settings = stateOf(o);
      for (const r of lastRun.records) r.selected = true;
      renderResults();
    } finally {
      App.setBusy("search", false);
    }
    const flow = App.reviewFlow;
    App.reviewFlow = false;
    try {
      await importSelected(false);
    } finally {
      App.reviewFlow = flow;
    }
    // the databases of the earlier search are handled by this one now (it may itself stop early)
    if (continues && App.project) App.project = (await ZR.Projects.markSources(App.target.libraryID, App.project.id, continues, Object.keys(resume || {}), { done: lastRun.id })) || App.project;
    return { run: lastRun, pool: lastPoolImport };
  }
  let lastPoolImport = null;

  // ------------------------------------------------------ logged searches ----
  // A search logged in a review can be opened again: read-only first (settings and the
  // list of what it found, with what happened to each paper), then editable. Running an
  // edited search asks whether it refines the original (#2 → #2.1) or is a new search.
  let viewing = null; // {run, label, editable}

  async function showRun(project, run, label) {
    App.showTab("search");
    const settings = Object.assign({}, run.settings || {}, { query: run.query || run.settings?.query || "" });
    if (!run.settings) settings.mode = run.mode === "structured" || !run.mode ? "structured" : "llm";
    applyState(settings);
    const audit = (await ZR.Projects.runAudit(App.target.libraryID, project.id))[run.id] || null;
    viewing = { run, label, editable: false };
    lastRun = audit
      ? {
          records: audit.map((a) => Object.assign({ pdfURLs: [], sources: [], creators: [] }, a, { fateReason: a.reason, selected: false })),
          perSource: run.perSource || {},
        }
      : null;
    $("results").replaceChildren();
    $("search-empty").hidden = true;
    renderRunBanner();
    renderResults();
    updateImportBar();
    if (!audit) $("results").append(el("div", { class: "empty-state", text: "The individual results of this search were not recorded (logged before version 0.7): only its settings and counts." }));
    st(`Search ${label} from ${run.at}: ${run.identified ?? "?"} found, ${run.imported ?? "?"} into the pool.`);
  }

  function renderRunBanner() {
    document.body.dataset.readonly = viewing && !viewing.editable ? "1" : "";
    const box = $("plan-box");
    if (!viewing) return (box.hidden = true);
    const r = viewing.run;
    box.replaceChildren(
      el("div", { class: "run-banner" }, [
        el("b", { text: viewing.editable ? `Editing a copy of search ${viewing.label}` : `Search ${viewing.label} · ${r.at}` }),
        el("span", { class: "hint", text: viewing.editable ? "Change keywords or filters and run it: you will be asked whether it refines the original or is a new search." : `${r.identified ?? "?"} found · ${r.imported ?? "?"} into the pool · read-only` }),
        el("span", { class: "spacer" }),
        viewing.editable ? null : el("button", { id: "run-edit", class: "primary", text: "Edit and run again", onclick: () => ((viewing.editable = true), renderRunBanner(), renderResults(), updateImportBar()) }),
        el("button", { id: "run-close", text: "Close", onclick: () => closeRunView() }),
      ])
    );
    box.hidden = false;
  }

  function closeRunView({ keepForm = false } = {}) {
    viewing = null;
    document.body.dataset.readonly = "";
    $("plan-box").hidden = true;
    if (!keepForm) {
      lastRun = null;
      $("results").replaceChildren();
      $("results-head").hidden = true;
      loadProject();
    }
    updateImportBar();
  }

  function updateImportBar() {
    if (!ZR) return;
    const n = lastRun ? lastRun.records.filter((r) => r.selected).length : 0;
    $("import-bar").hidden = !lastRun || !!viewing;
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
    if (!recs.length) return st(auto ? "Automatic mode: nothing scored high enough, so nothing was added." : "Nothing selected.");
    App.setBusy("search", true);
    try {
      const libraryID = App.target.libraryID;
      if (App.project?.kind === "review") {
        // Review: into the candidate pool; papers reach Zotero when they pass screening
        const P = ZR.Projects;
        const { added, known, knownKeys } = await P.addToPool(libraryID, App.project.id, recs);
        const run = ZR.Prisma.runRecord(Object.assign({}, lastRun, { imported: added, inLibraryCount: 0, deduped: Math.max(0, (lastRun.deduped ?? lastRun.records.length) - known) }));
        // Chain of proof: what happened to every paper this search found
        const keyOf = (r) => r.key || ZR.Store.keyForRecord(r);
        const audit = [
          ...(lastRun.dropped || []).map((x) => P.auditRow(x.r, "removed", x.stage, x.reason)),
          ...lastRun.records.map((r) =>
            !r.selected
              ? P.auditRow(r, "unselected", "selection", "Not selected when adding to the pool")
              : knownKeys.has(keyOf(r))
                ? P.auditRow(r, "known", "pool", "Already in the pool (found by an earlier search)")
                : P.auditRow(r, "pool", "pool", "Added to the pool")
          ),
        ];
        await P.saveRunAudit(libraryID, App.project.id, run.id, audit);
        await P.addRun(libraryID, App.project.id, run);
        lastPoolImport = { added, known, notAdded: audit.filter((a) => a.fate === "removed" || a.fate === "unselected").length, runID: run.id };
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
          tags: [tag, App.project && ZR.Prefs.get("projectTags", true) ? await ZR.Projects.ensureTag(libraryID, App.project) : ""].filter(Boolean),
          tagExisting: !!App.project, // a paper already in Zotero joins the project too
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

  return { init, renderSources, runRelated, showRecords, updateImportBar, setMode, setView, useQueryText, loadProject, currentState, showRun, closeRunView, searchIntoPool, onShow: updateImportBar };
})();

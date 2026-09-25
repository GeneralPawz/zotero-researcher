/* global ZR, Zotero */
// Main-window integration: toolbar button, multi-selection button, item-pane section,
// context menus, and the preference pane.

ZR.UI = (() => {
  const U = ZR.Util;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const ICON = "chrome://zotero-researcher/content/icons/researcher.svg";
  const state = { paneID: null, menuIDs: [], prefPaneID: null, section: new Map() };

  // --- lifecycle -----------------------------------------------------------
  async function startup() {
    state.prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: ZR.id,
      id: "zotero-researcher-prefs",
      src: ZR.rootURI + "content/preferences/prefs.xhtml",
      scripts: [ZR.rootURI + "content/preferences/prefs.js"],
      stylesheets: [ZR.rootURI + "content/preferences/prefs.css"],
      label: "Zotero Researcher",
      image: ICON,
    });
    registerItemPaneSection();
    registerMenus();
    announceUpdate();
  }

  /** After an update the old Settings pane is gone, so the new version confirms it. */
  function announceUpdate() {
    const last = ZR.Prefs.get("lastVersion", "");
    ZR.Prefs.set("lastVersion", ZR.version);
    if (!last || last === ZR.version) return;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Zotero Researcher updated");
    pw.addDescription(`Version ${last} → ${ZR.version}. Your settings and library data were kept.`);
    pw.show();
    pw.startCloseTimer(8000);
  }

  async function shutdown() {
    // Write pending ledger changes before the plugin scope goes away
    await ZR.Store.flushAll().catch((e) => U.log("Ledger flush on shutdown failed", e.message));
    for (const win of Zotero.getMainWindows()) onMainWindowUnload(win);
    if (state.paneID) Zotero.ItemPaneManager.unregisterSection(state.paneID);
    for (const id of state.menuIDs) Zotero.MenuManager.unregisterMenu(id);
    if (state.prefPaneID) Zotero.PreferencePanes.unregister(state.prefPaneID);
    for (const w of Services.wm.getEnumerator("zotero-researcher:dialog")) w.close();
  }

  function onMainWindowLoad(win) {
    const doc = win.document;
    win.MozXULElement.insertFTLIfNeeded("zotero-researcher.ftl");

    const css = doc.createElementNS(HTML_NS, "link");
    css.id = "zotero-researcher-css";
    css.rel = "stylesheet";
    css.href = "chrome://zotero-researcher/content/main.css";
    doc.documentElement.appendChild(css);

    // Toolbar button right after "New Note" in the items toolbar.
    const noteBtn = doc.getElementById("zotero-tb-note-add");
    if (noteBtn && !doc.getElementById("zotero-researcher-tb")) {
      const btn = doc.createXULElement("toolbarbutton");
      btn.id = "zotero-researcher-tb";
      btn.className = "zotero-tb-button";
      btn.setAttribute("tabindex", "-1");
      btn.setAttribute("tooltiptext", "Researcher — find papers for this collection, get full texts, retrieve metadata");
      btn.addEventListener("command", () => openDialog(win));
      noteBtn.after(btn);
    }

    addBatchButton(win, 0);
    if (!ZR.Prefs.get("welcomeShown", false) && !ZR.Prefs.get("selftest", "")) win.setTimeout(() => showWelcome(win), 2500);
  }

  /** One-time pointer at the toolbar button after install. */
  function showWelcome(win) {
    const doc = win.document;
    const anchor = doc.getElementById("zotero-researcher-tb");
    if (!anchor || doc.getElementById("zotero-researcher-welcome")) return;
    const panel = doc.createXULElement("panel");
    panel.id = "zotero-researcher-welcome";
    panel.setAttribute("type", "arrow");
    const box = doc.createElementNS(HTML_NS, "div");
    box.style.cssText = "max-width: 300px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; line-height: 1.45;";
    const title = doc.createElementNS(HTML_NS, "b");
    title.textContent = "Researcher is ready";
    const text = doc.createElementNS(HTML_NS, "div");
    text.textContent = "Select a collection, then click this button to find papers for it, run a systematic review, or improve the metadata of selected papers.";
    const row = doc.createElementNS(HTML_NS, "div");
    row.style.cssText = "display: flex; gap: 8px; justify-content: flex-end;";
    const later = doc.createXULElement("button");
    later.setAttribute("label", "Later");
    const tour = doc.createXULElement("button");
    tour.setAttribute("label", "Show me around");
    tour.classList.add("primary");
    later.addEventListener("command", () => panel.hidePopup());
    tour.addEventListener("command", () => {
      panel.hidePopup();
      openDialog(win, { tour: true });
    });
    row.append(later, tour);
    box.append(title, text, row);
    panel.append(box);
    panel.addEventListener("popuphidden", () => {
      ZR.Prefs.set("welcomeShown", true);
      panel.remove();
    });
    (doc.querySelector("popupset") || doc.documentElement).append(panel);
    panel.openPopup(anchor, "after_start", 0, 0, false, false);
  }

  // The multi-selection prompt ("N items selected [Edit Multiple Items]") lives inside
  // the <item-pane> custom element, which may render after window load.
  function addBatchButton(win, attempt) {
    const doc = win.document;
    if (doc.getElementById("zotero-researcher-batch-btn")) return;
    const box = doc.getElementById("batch-edit-prompt");
    if (!box) {
      if (attempt < 20) win.setTimeout(() => addBatchButton(win, attempt + 1), 500);
      return;
    }
    const btn = doc.createXULElement("button");
    btn.id = "zotero-researcher-batch-btn";
    btn.setAttribute("label", "Researcher: Metadata, PDFs & Compare…");
    btn.addEventListener("command", () => openDialog(win, { tab: "selected" }));
    box.appendChild(btn);
  }

  function onMainWindowUnload(win) {
    const doc = win.document;
    for (const id of ["zotero-researcher-tb", "zotero-researcher-batch-btn", "zotero-researcher-css", "zotero-researcher-welcome"]) doc.getElementById(id)?.remove();
    doc.querySelector('link[href="zotero-researcher.ftl"]')?.remove();
  }

  // --- context ---------------------------------------------------------------
  function collectionPath(col) {
    const parts = [];
    for (let c = col; c; c = c.parentID ? Zotero.Collections.get(c.parentID) : null) parts.unshift(c.name);
    return parts.join(" › ");
  }

  /** Where search results go: the selected collection (or library) in the main window. */
  function getTarget(win) {
    const zp = win.ZoteroPane;
    const row = zp.getCollectionTreeRows?.()[0];
    const libraryID = row?.ref?.libraryID ?? Zotero.Libraries.userLibraryID;
    const library = Zotero.Libraries.get(libraryID);
    const collection = row?.isCollection?.() ? row.ref : null;
    let editable = library.editable;
    try {
      // canEdit() inspects the current collection-tree selection
      if (row) editable = editable && zp.canEdit() !== false;
    } catch (e) {
      U.log("canEdit check failed", e.message);
    }
    return {
      libraryID,
      collectionID: collection?.id || null,
      collectionKey: collection?.key || null,
      label: library.name + (collection ? " › " + collectionPath(collection) : ""),
      editable,
    };
  }

  function openDialog(win, opts = {}) {
    win = win || Zotero.getMainWindow();
    const items = win.ZoteroPane.getSelectedItems().filter((i) => i.isRegularItem() || i.isAttachment());
    const args = {
      target: getTarget(win),
      itemIDs: opts.itemIDs || items.map((i) => i.id),
      tab: opts.tab || (items.length >= 2 ? "selected" : "find"),
      autoRun: opts.autoRun || null,
      tour: !!opts.tour,
    };
    args.wrappedJSObject = args;
    return win.openDialog("chrome://zotero-researcher/content/dialog/research.xhtml", "", "chrome,centerscreen,resizable,dialog=no,width=1100,height=780", args);
  }

  function openPreferences() {
    Zotero.Utilities.Internal.openPreferences("zotero-researcher-prefs");
  }

  // --- menus -----------------------------------------------------------------
  function registerMenus() {
    const itemAction = (autoRun, tab = "selected") => (ev, ctx) => {
      const win = ctx.menuElem?.ownerGlobal || Zotero.getMainWindow();
      openDialog(win, { tab, autoRun, itemIDs: (ctx.items || []).map((i) => i.id) });
    };
    // Remember a judgement on library items (tags + ledger), reused by later searches and reviews
    const judge = (d, reason) => async (ev, ctx) => {
      for (const item of (ctx.items || []).filter((i) => i.isRegularItem())) {
        await ZR.Store.decide({ libraryID: item.libraryID, item, stage: "ta", d, r: reason });
      }
    };
    const id1 = Zotero.MenuManager.registerMenu({
      menuID: "zotero-researcher-item",
      pluginID: ZR.id,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          l10nID: "zr-menu-submenu",
          icon: ICON,
          onShowing: (ev, ctx) => ctx.setVisible(!!ctx.items?.some((i) => i.isRegularItem() || i.isAttachment())),
          menus: [
            { menuType: "menuitem", l10nID: "zr-menu-enrich-det", onCommand: itemAction("enrich-det") },
            { menuType: "menuitem", l10nID: "zr-menu-enrich-llm", onCommand: itemAction("enrich-llm") },
            { menuType: "menuitem", l10nID: "zr-menu-find-pdf", onCommand: itemAction("find-pdf") },
            { menuType: "separator" },
            { menuType: "menuitem", l10nID: "zr-menu-compare", onCommand: itemAction(null, "compare") },
            { menuType: "menuitem", l10nID: "zr-menu-related", onCommand: itemAction("related", "find") },
            {
              menuType: "submenu",
              l10nID: "zr-menu-judge",
              menus: [
                { menuType: "menuitem", l10nID: "zr-menu-judge-relevant", onCommand: judge("include", "") },
                { menuType: "menuitem", l10nID: "zr-menu-judge-off", onCommand: judge("exclude", "Off topic") },
                { menuType: "menuitem", l10nID: "zr-menu-judge-weak", onCommand: judge("exclude", "Weak / low quality") },
                { menuType: "menuitem", l10nID: "zr-menu-judge-clear", onCommand: judge(null, "") },
              ],
            },
            { menuType: "separator" },
            { menuType: "menuitem", l10nID: "zr-menu-open", onCommand: itemAction(null) },
          ],
        },
      ],
    });
    const id2 = Zotero.MenuManager.registerMenu({
      menuID: "zotero-researcher-collection",
      pluginID: ZR.id,
      target: "main/library/collection",
      menus: [
        {
          menuType: "menuitem",
          l10nID: "zr-menu-collection-find",
          icon: ICON,
          onCommand: (ev, ctx) => openDialog(ctx.menuElem?.ownerGlobal, { tab: "find", itemIDs: [] }),
        },
      ],
    });
    state.menuIDs = [id1, id2].filter(Boolean);
  }

  // --- item pane section -----------------------------------------------------
  function registerItemPaneSection() {
    state.paneID = Zotero.ItemPaneManager.registerSection({
      paneID: "zotero-researcher-section",
      pluginID: ZR.id,
      header: { l10nID: "zr-section", icon: ICON },
      sidenav: { l10nID: "zr-section", icon: ICON },
      sectionButtons: [
        { type: "zr-det", icon: "chrome://zotero/skin/16/universal/retrieve-metadata.svg", l10nID: "zr-section-button-det", onClick: ({ body, item }) => runSectionAction(body, item, "det") },
        { type: "zr-llm", icon: "chrome://zotero-researcher/content/icons/llm.svg", l10nID: "zr-section-button-llm", onClick: ({ body, item }) => runSectionAction(body, item, "llm") },
      ],
      onItemChange: ({ item, setEnabled }) => {
        setEnabled(!!item && (item.isRegularItem() || (item.isAttachment() && !item.parentItemID)));
        return true;
      },
      onRender: ({ body, item, setSectionSummary }) => {
        renderSection(body, item);
        if (item?.isRegularItem()) setSectionSummary(`${Math.round(ZR.Enrich.completeness(item).score * 100)}% complete`);
      },
    });
  }

  function h(doc, tag, props = {}, children = []) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  }

  /** Remembered screening decision (tags), e.g. "Screening: excluded — Off topic". */
  function decisionLine(doc, item) {
    const d = ZR.Store.decisionFromItem(item);
    if (!d) return null;
    const s = d.ft || d.ta;
    const label = { include: "included", exclude: "excluded", maybe: "maybe" }[s?.d];
    const text = s ? `Screening${d.ft ? " (full text)" : ""}: ${label}${s.r ? " — " + s.r : ""}` : "Screening: waiting in a review";
    return h(doc, "div", { class: "zr-decision " + (s?.d || ""), text });
  }

  function renderSection(body, item) {
    const doc = body.ownerDocument;
    body.replaceChildren();
    body.classList.add("zr-section");
    if (!item) return;
    body.dataset.itemId = item.id;
    const st = state.section.get(item.id) || {};

    if (item.isRegularItem()) {
      const c = ZR.Enrich.completeness(item);
      const pct = Math.round(c.score * 100);
      body.append(
        h(doc, "div", { class: "zr-completeness" }, [
          h(doc, "div", { class: "zr-bar" }, h(doc, "div", { class: "zr-bar-fill " + (pct >= 80 ? "good" : pct >= 50 ? "mid" : "low"), style: `width:${pct}%` })),
          h(doc, "span", { text: `${pct}% of key metadata present` }),
        ]),
        c.missing.length ? h(doc, "div", { class: "zr-missing", text: "Missing: " + c.missing.join(", ") }) : null,
        decisionLine(doc, item)
      );
    } else {
      body.append(h(doc, "div", { class: "zr-missing", text: "Standalone file — retrieve metadata to create a parent item." }));
    }

    const profiles = ZR.Prefs.getLLMProfiles();
    const active = ZR.Prefs.getActiveLLMProfile();
    const busy = st.status === "running";
    const actions = h(doc, "div", { class: "zr-actions" }, [
      h(doc, "button", { disabled: busy, onclick: () => runSectionAction(body, item, "det"), title: "DOI/ISBN/arXiv/PMID via Zotero translators, or exact title match in Crossref/OpenAlex" }, "Retrieve metadata"),
      h(doc, "button", { disabled: busy || !active, onclick: () => runSectionAction(body, item, "llm"), title: active ? `LLM: ${active.name} (${active.model})` : "Configure an LLM in Settings → Zotero Researcher" }, "With LLM"),
      item.isRegularItem() ? h(doc, "button", { disabled: busy, onclick: () => runSectionAction(body, item, "pdf") }, "Find PDF") : null,
      profiles.length > 1
        ? h(
            doc,
            "select",
            {
              class: "zr-llm-select",
              title: "LLM profile",
              onchange: (e) => ZR.Prefs.set("activeLLMProfile", e.target.value),
            },
            profiles.map((p) => h(doc, "option", { value: p.id, selected: active && p.id === active.id, text: p.name }))
          )
        : null,
    ]);
    body.append(actions);

    if (st.message) body.append(h(doc, "div", { class: "zr-status " + (st.error ? "error" : ""), text: st.message }));
    if (st.proposal) body.append(renderProposal(doc, body, item, st.proposal));
  }

  function renderProposal(doc, body, item, p) {
    const wrap = h(doc, "div", { class: "zr-proposal" });
    wrap.append(h(doc, "div", { class: "zr-source", text: `Source: ${p.source}` }));
    if (!p.changes.length && !p.typeChange) {
      wrap.append(h(doc, "div", { text: "No differences — metadata already matches." }));
      return wrap;
    }
    const table = h(doc, "table", { class: "zr-diff" });
    if (p.typeChange) {
      table.append(
        h(doc, "tr", {}, [
          h(doc, "td", {}, h(doc, "input", { type: "checkbox", checked: p.typeChange.selected, onchange: (e) => (p.typeChange.selected = e.target.checked) })),
          h(doc, "td", { text: "Item Type" }),
          h(doc, "td", { class: "old", text: p.typeChange.from }),
          h(doc, "td", { class: "new", text: p.typeChange.to }),
        ])
      );
    }
    for (const c of p.changes) {
      table.append(
        h(doc, "tr", { class: c.kind }, [
          h(doc, "td", {}, h(doc, "input", { type: "checkbox", checked: c.selected, onchange: (e) => (c.selected = e.target.checked) })),
          h(doc, "td", { text: c.label }),
          h(doc, "td", { class: "old", text: U.truncate(c.old, 140) }),
          h(doc, "td", { class: "new", text: U.truncate(c.new, 240), title: c.new }),
        ])
      );
    }
    wrap.append(table);
    wrap.append(
      h(doc, "div", { class: "zr-actions" }, [
        h(doc, "button", {
          onclick: async () => {
            try {
              await ZR.Enrich.apply(p);
              state.section.set(item.id, { message: "Applied." });
            } catch (e) {
              state.section.set(item.id, { message: "Apply failed: " + e.message, error: true });
            }
            rerender(body, item);
          },
        }, "Apply selected"),
        h(doc, "button", { onclick: () => (state.section.delete(item.id), rerender(body, item)) }, "Discard"),
      ])
    );
    return wrap;
  }

  function rerender(body, item) {
    if (body.isConnected && body.dataset.itemId == item.id) renderSection(body, Zotero.Items.get(item.id));
  }

  async function runSectionAction(body, item, kind) {
    if (!item) return;
    state.section.set(item.id, { status: "running", message: kind === "pdf" ? "Looking for a full-text PDF…" : "Retrieving metadata…" });
    rerender(body, item);
    try {
      if (kind === "pdf") {
        const att = await ZR.Importer.attachFullText(item);
        state.section.set(item.id, { message: att ? "PDF attached." : "No accessible PDF found.", error: !att });
      } else {
        const p = kind === "llm" ? await ZR.Enrich.llmAssisted(item, ZR.Prefs.getActiveLLMProfile()) : await ZR.Enrich.deterministic(item);
        if (p.error) state.section.set(item.id, { message: p.error, error: true });
        else if (p.recognize) {
          await ZR.Enrich.apply(p);
          state.section.set(item.id, { message: "Ran Zotero’s PDF recognizer." });
        } else state.section.set(item.id, { proposal: p });
      }
    } catch (e) {
      U.log("Section action failed", e.message);
      state.section.set(item.id, { message: e.message, error: true });
    }
    rerender(body, item);
  }

  return { startup, shutdown, onMainWindowLoad, onMainWindowUnload, openDialog, openPreferences, getTarget, showWelcome };
})();

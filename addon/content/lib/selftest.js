/* global ZR, Zotero, IOUtils, PathUtils, ChromeUtils */
// In-app end-to-end self-test. Inert unless the pref
//   extensions.zotero-researcher.selftest = "<output directory>"
// is set (only done by scripts/e2e.mjs in a throwaway profile). Writes report.json and
// screenshots to that directory, then quits Zotero.

ZR.SelfTest = (() => {
  const U = ZR.Util;

  function maybeRun() {
    const out = ZR.Prefs.get("selftest", "");
    if (!out) return;
    const job = ZR.Prefs.get("selftestMode", "") === "update" ? runUpdate(out) : run(out);
    job.catch((e) => Zotero.logError(e));
  }

  /** Update test: an old build clicks "Check for updates" in Settings and must end up on the published release. */
  async function runUpdate(outDir) {
    const report = { started: new Date().toISOString(), zotero: Zotero.version, steps: [] };
    const save = () => IOUtils.writeUTF8(PathUtils.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    await Zotero.uiReadyPromise;
    const win = await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView && Zotero.getMainWindow(), 60000);
    await U.sleep(1500);
    const t0 = Date.now();
    const from = ZR.version;
    try {
      ZR.Prefs.set("selftest", ""); // the updated plugin must not start the self-test again
      const pw = Zotero.Utilities.Internal.openPreferences("zotero-researcher-prefs");
      const d = await waitFor(() => pw.document?.getElementById("zr-check-updates") && pw.document, 30000);
      await U.sleep(500);
      d.getElementById("zr-check-updates").click();
      // The plugin reloads itself during the update, which also rebuilds its Settings pane.
      let problem = "";
      await waitFor(() => {
        const t = d.getElementById("zr-update-status")?.textContent || "";
        if (/latest version|failed|code/.test(t)) problem = t;
        return problem || (Zotero.Researcher && Zotero.Researcher.version !== from);
      }, 180000);
      if (problem) throw new Error("update check said: " + problem);
      const toolbar = await waitFor(() => win.document.getElementById("zotero-researcher-tb"), 20000);
      // Zotero drops the plugin's pane while it reloads; reopen Settings like a user would.
      pw.close();
      await U.sleep(1000);
      const pw2 = Zotero.Utilities.Internal.openPreferences("zotero-researcher-prefs");
      const shown = await waitFor(() => /Installed: version/.test(pw2.document?.getElementById("zr-version")?.textContent) && pw2.document.getElementById("zr-version").textContent, 30000);
      await U.sleep(500);
      await screenshot(pw2, PathUtils.join(outDir, "update-settings.png"));
      const to = Zotero.Researcher.version;
      report.steps.push({
        name: "Check for updates installs the published release",
        ok: !!toolbar && to !== from && shown.includes(to),
        ms: Date.now() - t0,
        // lastVersion is only set by releases that include the update announcement (> 0.2.1)
        result: { from, to, settingsShows: shown, toolbarRestored: !!toolbar, announcedVersion: Zotero.Researcher.Prefs.get("lastVersion", "") },
      });
      pw2.close();
    } catch (e) {
      report.steps.push({ name: "Check for updates installs the published release", ok: false, ms: Date.now() - t0, error: String(e && e.stack ? e.message + "\n" + e.stack : e) });
    }
    report.finished = new Date().toISOString();
    report.passed = report.steps.filter((s) => s.ok).length;
    report.failed = report.steps.length - report.passed;
    await save();
    await U.sleep(500);
    Zotero.Utilities.Internal.quit();
  }

  async function waitFor(fn, timeout = 30000, step = 250) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error("timeout waiting for condition");
      await U.sleep(step);
    }
  }

  async function screenshot(win, file) {
    try {
      const bmp = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      await IOUtils.write(file, new Uint8Array(await blob.arrayBuffer()));
      return true;
    } catch (e) {
      return "screenshot failed: " + e.message;
    }
  }

  // Mock OpenAI-compatible LLM; only URLs under MOCK are intercepted.
  const MOCK = "http://mock-llm.invalid/v1";
  function mockLLM(realHTTP, calls) {
    return async (method, url, o = {}) => {
      if (!url.startsWith(MOCK)) return realHTTP(method, url, o);
      const prompt = o.body.messages[o.body.messages.length - 1].content;
      calls.push(prompt.slice(0, 50));
      const n = (prompt.match(/^\[\d+\]/gm) || []).length;
      let content;
      if (prompt.includes('{"query"')) content = JSON.stringify({ query: 'IFC AND ("building information model*" OR BIM)', yearFrom: 2015, yearTo: null, concepts: ["IFC", "BIM"], rationale: "IFC is the open BIM exchange schema." });
      else if (prompt.includes('"decision"')) content = JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, decision: i % 2 ? "exclude" : "include", reason: i % 2 ? "Off topic" : "", confidence: i % 3 === 2 ? 0.6 : 0.9, why: i % 2 ? "not about IFC" : "IFC exchange case study" })));
      else if (prompt.includes("Papers:\n")) content = JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, score: i % 2 ? 3 : 8, reason: i % 2 ? "tangential" : "directly about IFC-based BIM exchange" })));
      else if (prompt.includes("<h2>Comparison</h2>")) content = "<h2>Comparison</h2><table><tr><th>Paper</th><th>Method</th></tr><tr><td>A</td><td>Case study</td></tr></table><h2>Synthesis</h2><p>Both use IFC.</p><script>alert(1)</script>";
      else if (prompt.includes("Item data:")) content = JSON.stringify({ itemType: "journalArticle", title: "Deep learning", authors: [{ firstName: "Yann", lastName: "LeCun" }], date: "2015", DOI: null, venue: "Nature" });
      else if (prompt.includes("SAME work")) content = JSON.stringify({ index: 0, confidence: 0.9, reason: "same title and authors" });
      else content = "OK";
      const json = { choices: [{ message: { content } }] };
      return { status: 200, text: JSON.stringify(json), json: () => json };
    };
  }

  /** Choose an option through the in-document dropdown, the way a user clicks it. */
  async function pick(select, text) {
    const doc = select.ownerDocument;
    const button = select.zrDropdownButton;
    if (!button) throw new Error("select not enhanced: " + (select.id || select.className));
    button.scrollIntoView({ block: "center" });
    await U.sleep(150);
    button.click();
    const item = await waitFor(() => [...doc.querySelectorAll(".zr-dd-menu .zr-dd-item")].find((i) => i.textContent.includes(text)), 5000);
    const menu = item.parentElement;
    const style = doc.defaultView.getComputedStyle(menu);
    const visible = menu.getBoundingClientRect().height > 0 && style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
    item.click();
    await waitFor(() => !doc.querySelector(".zr-dd-menu"), 5000);
    return { visible, label: button.textContent };
  }

  async function openResearch(win, opts, readyCheck = (d) => d.getElementById("sources")?.children.length) {
    const w = ZR.UI.openDialog(win, opts);
    await waitFor(() => w.document.readyState === "complete" && w.App?.ZR && readyCheck(w.document), 20000);
    await U.sleep(300);
    return w;
  }

  async function run(outDir) {
    const report = { started: new Date().toISOString(), zotero: Zotero.version, steps: [] };
    const save = () => IOUtils.writeUTF8(PathUtils.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    const shot = (w, name) => screenshot(w, PathUtils.join(outDir, name));
    const step = async (name, fn) => {
      const t0 = Date.now();
      try {
        const result = await fn();
        report.steps.push({ name, ok: true, ms: Date.now() - t0, result });
      } catch (e) {
        report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack ? e.message + "\n" + e.stack : e) });
      }
      await save();
    };

    await Zotero.uiReadyPromise;
    const win = await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView && Zotero.getMainWindow(), 60000);
    await U.sleep(1500);
    const doc = win.document;
    const zp = win.ZoteroPane;
    const libraryID = Zotero.Libraries.userLibraryID;
    ZR.Prefs.set("tourSeen", true); // the tour gets its own step
    let collection;

    // ------------------------------------------------------------ main window
    await step("toolbar button placed after New Note", () => {
      const btn = doc.getElementById("zotero-researcher-tb");
      if (!btn) throw new Error("button missing");
      if (btn.previousElementSibling?.id !== "zotero-tb-note-add") throw new Error("wrong position: after " + btn.previousElementSibling?.id);
      return { visible: btn.getBoundingClientRect().width > 0 };
    });
    await step("multi-select prompt button present", () => {
      const b = doc.getElementById("zotero-researcher-batch-btn");
      if (!b || b.parentElement.id !== "batch-edit-prompt") throw new Error("missing");
      return true;
    });
    await step("item pane section + menus + pref pane registered", () => {
      const data = Zotero.ItemPaneManager.customSectionData;
      const list = Array.isArray(data) ? data : data?.options || [];
      const sections = list.map((s) => s.paneID);
      const panes = Zotero.PreferencePanes.pluginPanes.map((p) => p.id);
      if (!sections.some((s) => s.includes("zotero-researcher"))) throw new Error("section missing: " + sections);
      if (!panes.includes("zotero-researcher-prefs")) throw new Error("pref pane missing: " + panes);
      return { sections, panes };
    });
    await step("welcome pointer on the toolbar button (first run)", async () => {
      ZR.Prefs.set("welcomeShown", false);
      ZR.UI.showWelcome(win);
      const panel = await waitFor(() => doc.getElementById("zotero-researcher-welcome")?.state === "open" && doc.getElementById("zotero-researcher-welcome"), 5000);
      await U.sleep(400);
      await shot(win, "00-welcome.png");
      panel.hidePopup();
      await waitFor(() => !doc.getElementById("zotero-researcher-welcome"), 5000);
      return { remembered: ZR.Prefs.get("welcomeShown", false) };
    });

    await step("create + select test collection", async () => {
      collection = new Zotero.Collection({ name: "zr-selftest", libraryID });
      await collection.saveTx();
      await zp.collectionsView.selectCollection(collection.id);
      await U.sleep(800);
      const t = ZR.UI.getTarget(win);
      if (t.collectionID !== collection.id || t.collectionKey !== collection.key) throw new Error("target mismatch " + JSON.stringify(t));
      return t;
    });
    await shot(win, "01-main-window.png");

    // ------------------------------------------------------------- engine
    let runInfo;
    await step("structured search across live sources", async () => {
      runInfo = await ZR.Search.run({
        mode: "structured",
        query: '("industry foundation classes" OR IFC) AND BIM',
        sources: ["openalex", "crossref", "semanticscholar", "arxiv", "europepmc", "doaj", "hal", "zenodo", "osti", "core", "dblp"],
        limit: 5,
        yearFrom: 2018,
        libraryID,
        skipExisting: true,
      });
      const per = {};
      for (const [id, s] of Object.entries(runInfo.perSource)) per[id] = s.error ? "ERROR: " + s.error.slice(0, 110) : String(s.count);
      if (runInfo.records.length < 10) throw new Error("too few results: " + JSON.stringify(per));
      return { identified: runInfo.identified, deduped: runInfo.deduped, per };
    });

    await step("import 3 records with PDFs into collection", async () => {
      const recs = runInfo.records.filter((r) => r.pdfURLs.length).slice(0, 2).concat(runInfo.records.filter((r) => !r.pdfURLs.length).slice(0, 1));
      const stats = await ZR.Search.importRecords(runInfo, recs, { libraryID, collectionID: collection.id, attachPDFs: true, tags: ["zr:selftest"], protocolNote: true });
      return { imported: stats.imported, withPDF: stats.withPDF, failed: stats.failed };
    });

    let sparse;
    await step("deterministic enrichment: title-only and DOI-only items", async () => {
      sparse = new Zotero.Item("document");
      sparse.libraryID = libraryID;
      sparse.setField("title", "Deep Residual Learning for Image Recognition");
      sparse.setCollections([collection.id]);
      await sparse.saveTx();
      const p = await ZR.Enrich.deterministic(sparse);
      if (p.error) throw new Error(p.error);
      await ZR.Enrich.apply(p);
      const it = new Zotero.Item("journalArticle");
      it.libraryID = libraryID;
      it.setField("DOI", "10.1038/nature14539");
      it.setCollections([collection.id]);
      await it.saveTx();
      const p2 = await ZR.Enrich.deterministic(it);
      if (p2.error) throw new Error(p2.error);
      await ZR.Enrich.apply(p2);
      return { resnet: `${Zotero.ItemTypes.getName(sparse.itemTypeID)} · ${sparse.getField("DOI")}`, nature: `${Zotero.Items.get(it.id).getField("title")} · ${Zotero.Items.get(it.id).getField("publicationTitle")}` };
    });

    await step("item pane section renders", async () => {
      await zp.selectItem(sparse.id);
      const body = await waitFor(() => doc.querySelector(".zr-section .zr-completeness") && doc.querySelector(".zr-section"), 15000);
      return body.textContent.slice(0, 120);
    });
    await shot(win, "02-item-pane.png");

    await step("context menu: Researcher → Judge → Weak tags the paper", async () => {
      await zp.selectItem(sparse.id);
      const menu = doc.getElementById("zotero-itemmenu");
      await zp.buildItemContextMenu(); // what a right-click does before showing the menu
      const shown = new Promise((r) => menu.addEventListener("popupshown", r, { once: true }));
      menu.openPopupAtScreen(200, 200, true);
      await shown;
      const sub = await waitFor(() => menu.querySelector('menu[data-l10n-id="zr-menu-submenu"]'), 5000);
      const subShown = new Promise((r) => sub.menupopup.addEventListener("popupshown", r, { once: true }));
      sub.open = true;
      await subShown;
      const judgeMenu = await waitFor(() => sub.menupopup.querySelector('menu[data-l10n-id="zr-menu-judge"]'), 5000);
      const judgeShown = new Promise((r) => judgeMenu.menupopup.addEventListener("popupshown", r, { once: true }));
      judgeMenu.open = true;
      await judgeShown;
      judgeMenu.menupopup.querySelector('menuitem[data-l10n-id="zr-menu-judge-weak"]').doCommand();
      menu.hidePopup();
      await waitFor(() => Zotero.Items.get(sparse.id).hasTag("zr:exclude"), 5000);
      const tags = Zotero.Items.get(sparse.id).getTags().map((t) => t.tag).filter((t) => t.startsWith("zr:"));
      // restore so later steps see an unjudged paper
      await ZR.Store.decide({ libraryID, item: Zotero.Items.get(sparse.id), stage: "ta", d: null });
      return { tags };
    });

    // ------------------------------------------------------------- dialog
    await step("guided tour runs through all steps and is remembered", async () => {
      ZR.Prefs.set("tourSeen", false);
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      await waitFor(() => !d.getElementById("tour-layer").hidden, 5000);
      const n = w.Tour.STEPS.length;
      d.getElementById("tour-next").click();
      d.getElementById("tour-next").click();
      await U.sleep(300);
      await shot(w, "03-tour.png");
      const titles = [];
      for (let i = 2; i < n; i++) {
        titles.push(d.getElementById("tour-title").textContent);
        d.getElementById("tour-next").click();
      }
      const res = { steps: n, closed: d.getElementById("tour-layer").hidden, remembered: ZR.Prefs.get("tourSeen", false) };
      w.close();
      if (!res.closed || !res.remembered) throw new Error(JSON.stringify(res));
      return res;
    });

    await step("research areas: medicine hidden by default, can be enabled", async () => {
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const ids = [...w.document.querySelectorAll("#sources input")].map((i) => i.value);
      const hidden = !ids.includes("pubmed") && !ids.includes("europepmc");
      ZR.Sources.setDisciplineEnabled("medicine", true);
      w.App.panels.search.renderSources();
      const shown = !!w.document.querySelector('#sources input[value="pubmed"]');
      ZR.Sources.setDisciplineEnabled("medicine", false);
      w.close();
      if (!hidden || !shown) throw new Error(JSON.stringify({ ids, shown }));
      return { defaultSources: ids.length, pubmedAfterEnabling: shown };
    });

    await step("query builder: rows, chips, operators, fields ↔ text", async () => {
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      d.querySelector('#mode-seg button[data-mode="structured"]').click();
      d.querySelector('#kw-view button[data-view="text"]').click();
      w.App.panels.search.useQueryText("");
      d.querySelector('#kw-view button[data-view="builder"]').click();
      const type = (row, text) => {
        const input = d.querySelectorAll("#builder .qb-row")[row].querySelector(".qb-input");
        input.value = text;
        input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      };
      type(0, '"IFC5"');
      await U.sleep(50);
      type(0, "IFCX");
      await U.sleep(50);
      [...d.querySelectorAll("#builder .qb-foot button")].find((b) => /Add row/.test(b.textContent)).click();
      await U.sleep(50);
      type(1, "BIM");
      await U.sleep(50);
      const opPick = await pick(d.querySelectorAll("#builder select.qb-op")[0], "XOR");
      const xor = d.getElementById("query").value;
      await pick(d.querySelectorAll("#builder select.qb-op")[0], "AND");
      // screenshot with a menu open
      d.querySelectorAll("#builder select.qb-field")[1].zrDropdownButton.click();
      await U.sleep(200);
      await shot(w, "03b-builder-dropdown.png");
      [...d.querySelectorAll(".zr-dd-menu .zr-dd-item")].find((i) => i.textContent === "Title").click();
      await U.sleep(100);
      const built = d.getElementById("query").value;
      // text → builder round trip
      d.querySelector('#kw-view button[data-view="text"]').click();
      w.App.panels.search.useQueryText('"digital twin" NOT title:review');
      d.querySelector('#kw-view button[data-view="builder"]').click();
      const rows = [...d.querySelectorAll("#builder .qb-row")].map((r) => [...r.querySelectorAll(".zr-dd-label")].map((l) => l.textContent).concat([...r.querySelectorAll(".qb-chip")].map((c) => c.firstChild.textContent)).join(" · "));
      const res = { built, xor, feedback: d.getElementById("query-feedback").textContent, opMenuVisible: opPick.visible, rowsFromText: rows };
      w.close();
      if (built !== '("IFC5" OR IFCX) AND title:BIM') throw new Error("unexpected query " + JSON.stringify(res));
      if (!/AND NOT/.test(xor)) throw new Error("XOR not compiled " + xor);
      return res;
    });

    let judged;
    await step("search in dialog, judge a paper as weak, add others", async () => {
      await zp.collectionsView.selectCollection(collection.id);
      await U.sleep(500);
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      d.querySelector('#mode-seg button[data-mode="structured"]').click();
      w.App.panels.search.useQueryText('IFC AND "building information model*"');
      for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["crossref", "arxiv", "doaj"].includes(cb.value);
      d.getElementById("limit").value = "4";
      d.getElementById("attach-pdfs").checked = false;
      d.getElementById("run").click();
      await waitFor(() => d.querySelectorAll("#results .result").length > 2 && !d.getElementById("run").disabled, 90000);
      await shot(w, "04-search-results.png");
      // Judge the first result as weak via the row's "Judge…" menu
      const firstRow = d.querySelector("#results .result");
      judged = firstRow.querySelector(".r-title").textContent;
      const judgeRow = firstRow.querySelector(".r-side-row");
      const sameLine = !!judgeRow?.querySelector(".zr-dd.mark");
      const picked = await pick(firstRow.querySelector("select.mark"), "Weak");
      if (!picked.visible) throw new Error("dropdown menu has no opaque background");
      await U.sleep(300);
      const badge = d.querySelector("#results .result .tag.excluded")?.textContent;
      // Add two of the remaining results
      let n = 0;
      for (const cb of d.querySelectorAll("#results .result > input")) {
        if (cb.checked && n < 2) n++;
        else if (cb.checked) cb.click();
      }
      d.getElementById("import").click();
      await waitFor(() => /Added \d+ new|Adding failed/.test(d.getElementById("search-status").textContent), 90000);
      const res = { judged, badge, judgeBesideCitations: sameLine, status: d.getElementById("search-status").textContent, chips: d.getElementById("sources-chip").textContent };
      w.close();
      if (!badge) throw new Error("no excluded badge: " + JSON.stringify(res));
      return res;
    });

    await step("decision is stored in the library ledger and recognised in a new search", async () => {
      await ZR.Store.flush(libraryID);
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("tag", "is", ZR.Store.TAG.ledger);
      const ids = await s.search();
      if (!ids.length) throw new Error("no ledger note");
      const note = Zotero.Items.get(ids[0]).getNote();
      const run2 = await ZR.Search.run({ mode: "structured", query: 'IFC AND "building information model*"', sources: ["crossref", "arxiv", "doaj"], limit: 4, libraryID, skipExisting: true });
      const again = run2.records.find((r) => r.title === judged);
      return { ledgerNotes: ids.length, ledgerMentionsPaper: note.includes(judged.slice(0, 20).replace(/&/g, "&amp;")), priorInNewSearch: again ? ZR.Store.describe(again.prior) : "(not in results this time)", preselected: again?.selected };
    });

    await step("selected-items tab: fix metadata and apply", async () => {
      const it = new Zotero.Item("journalArticle");
      it.libraryID = libraryID;
      it.setField("title", "Attention Is All You Need");
      it.setCollections([collection.id]);
      await it.saveTx();
      const w = await openResearch(win, { tab: "selected", itemIDs: [it.id, sparse.id], autoRun: "enrich-det" });
      const d = w.document;
      await waitFor(() => /^(Found metadata|No new metadata)/.test(d.getElementById("items-status").textContent), 90000);
      for (const head of d.querySelectorAll(".sel-head")) head.click();
      await U.sleep(300);
      await shot(w, "05-selected-items.png");
      const status = d.getElementById("items-status").textContent;
      if (!d.getElementById("apply-bar").hidden) {
        d.getElementById("apply-all").click();
        await waitFor(() => /Updated/.test(d.getElementById("items-status").textContent), 30000);
      }
      const item = Zotero.Items.get(it.id);
      const res = { status, applied: d.getElementById("items-status").textContent, creators: item.numCreators(), url: item.getField("url") };
      w.close();
      return res;
    });

    await step("preferences: checklist, research areas, AI and databases render", async () => {
      const pw = Zotero.Utilities.Internal.openPreferences("zotero-researcher-prefs");
      await waitFor(() => pw.document?.querySelector("#zr-src-table table tr:nth-child(3)") && pw.document.querySelectorAll("#zr-areas .zr-area").length, 30000);
      await U.sleep(500);
      const d = pw.document;
      const rowsDefault = d.querySelectorAll("#zr-src-table tr").length - 1;
      const pubmedListed = [...d.querySelectorAll("#zr-src-table .zr-name")].some((n) => n.textContent.includes("PubMed"));
      await shot(pw, "06-preferences.png");
      d.querySelector("#zr-llm-list button")?.click();
      await U.sleep(300);
      const prov = await pick(d.getElementById("zr-llm-provider"), "Anthropic");
      const baseAfterPick = [...d.querySelectorAll("#zr-llm-editor input")].map((i) => i.value).find((v) => v.startsWith("http"));
      d.getElementById("zr-llm-provider").zrDropdownButton.click();
      await U.sleep(200);
      await shot(pw, "06b-preferences-dropdown.png");
      d.querySelector(".zr-dd-menu .zr-dd-item")?.click();
      const res = { checklist: d.querySelectorAll("#zr-checklist .zr-check-row").length, areas: d.querySelectorAll("#zr-areas .zr-area").length, databasesShown: rowsDefault, pubmedListed, aiEditor: !!d.querySelector("#zr-llm-editor .zr-editor"), providerMenuVisible: prov.visible, baseAfterPick };
      pw.close();
      if (pubmedListed) throw new Error("PubMed listed although medicine is off");
      return res;
    });

    // ------------------------------------------------ AI + review (mock LLM)
    const realHTTP = ZR.http;
    const llmCalls = [];
    ZR.http = mockLLM(realHTTP, llmCalls);
    ZR.Prefs.setLLMProfiles([{ id: "mock", name: "Mock AI", provider: "custom", baseURL: MOCK, model: "mock-1", temperature: "" }]);
    ZR.Prefs.set("activeLLMProfile", "mock");
    try {
      await step("AI mode: describe → drafted query → rated results", async () => {
        const w = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = w.document;
        d.querySelector('#mode-seg button[data-mode="llm"]').click();
        d.getElementById("request").value = "Papers about IFC-based data exchange in building information modelling";
        for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["arxiv", "doaj"].includes(cb.value);
        d.getElementById("limit").value = "4";
        d.getElementById("screen").checked = true;
        d.getElementById("auto-import").checked = false;
        d.getElementById("run").click();
        await waitFor(() => d.querySelectorAll("#results .result").length > 1 && !d.getElementById("run").disabled, 90000);
        await shot(w, "07-ai-search.png");
        const res = { plan: d.getElementById("plan-box").textContent.slice(0, 90), scores: [...d.querySelectorAll("#results .score")].map((s) => s.textContent).join(" ") };
        w.close();
        if (!res.scores) throw new Error("no scores " + JSON.stringify(res));
        return res;
      });

      await step("AI mode with automatic adding (YOLO)", async () => {
        const before = collection.getChildItems().length;
        const w = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = w.document;
        d.querySelector('#mode-seg button[data-mode="llm"]').click();
        d.getElementById("request").value = "Recent work on IFC and BIM interoperability";
        for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["doaj", "arxiv"].includes(cb.value);
        d.getElementById("limit").value = "3";
        d.getElementById("attach-pdfs").checked = false;
        d.getElementById("auto-import").checked = true;
        d.getElementById("auto-import").dispatchEvent(new w.Event("change"));
        d.getElementById("run").click();
        await waitFor(() => /Automatic mode:/.test(d.getElementById("search-status").textContent), 120000);
        const res = { status: d.getElementById("search-status").textContent, collectionGrowth: collection.getChildItems().length - before };
        w.close();
        return res;
      });

      await step("compare selected papers with AI and save note", async () => {
        const ids = collection.getChildItems().filter((i) => i.isRegularItem()).slice(0, 2).map((i) => i.id);
        const w = await openResearch(win, { tab: "compare", itemIDs: ids }, (d) => d.getElementById("compare-run"));
        const d = w.document;
        d.getElementById("compare-run").click();
        await waitFor(() => d.querySelector("#compare-output table"), 60000);
        const hasScript = !!d.querySelector("#compare-output script");
        d.getElementById("compare-save").click();
        await waitFor(() => /Saved/.test(d.getElementById("items-status").textContent), 20000);
        w.close();
        if (hasScript) throw new Error("script survived sanitization");
        return { saved: true };
      });

      // --- PRISMA review on a fresh collection
      const reviewCol = new Zotero.Collection({ name: "zr-review", libraryID });
      await reviewCol.saveTx();
      await zp.collectionsView.selectCollection(reviewCol.id);
      await U.sleep(600);
      let rw;
      await step("review: set up a PRISMA review for a collection", async () => {
        rw = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = rw.document;
        rw.App.showTab("review");
        await waitFor(() => !d.getElementById("review-setup").hidden, 10000);
        await shot(rw, "08-review-setup.png");
        d.getElementById("rv-question").value = "How is IFC used for BIM data exchange?";
        d.getElementById("rv-include").value = "Peer-reviewed studies on IFC-based exchange";
        d.getElementById("rv-exclude").value = "Papers that only mention IFC in passing";
        d.getElementById("rv-create").click();
        await waitFor(() => !d.getElementById("review-main").hidden, 10000);
        return { review: !!(await ZR.Store.getReview(libraryID, reviewCol.key)), pill: !d.getElementById("review-pill").hidden };
      });

      await step("review: search adds papers as unscreened and logs the search", async () => {
        const d = rw.document;
        rw.App.showTab("search");
        d.querySelector('#mode-seg button[data-mode="structured"]').click();
        rw.App.panels.search.useQueryText('("industry foundation classes" OR IFC) AND BIM');
        for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["crossref", "doaj", "arxiv"].includes(cb.value);
        d.getElementById("limit").value = "4";
        d.getElementById("hide-excluded").checked = false;
        d.getElementById("attach-pdfs").checked = true;
        d.getElementById("run").click();
        await waitFor(() => d.querySelectorAll("#results .result").length > 2 && !d.getElementById("run").disabled, 90000);
        const label = d.getElementById("import").textContent;
        d.getElementById("import").click();
        await waitFor(() => /Added \d+ new|Adding failed/.test(d.getElementById("search-status").textContent), 120000);
        const items = reviewCol.getChildItems().filter((i) => i.isRegularItem());
        const review = await ZR.Store.getReview(libraryID, reviewCol.key);
        return { importLabel: label, papers: items.length, unscreened: items.filter((i) => i.hasTag("zr:unscreened")).length, runsLogged: review.runs.length };
      });

      await step("review: screen titles/abstracts with keyboard + AI suggestions", async () => {
        const d = rw.document;
        rw.App.showTab("review");
        await U.sleep(300);
        d.querySelector('#review-steps button[data-step="ta"]').click();
        await waitFor(() => d.querySelector("#screen-card .paper-card"), 10000);
        await shot(rw, "09-screening.png");
        const key = (k) => d.dispatchEvent(new rw.KeyboardEvent("keydown", { key: k, bubbles: true }));
        key("i"); // include first
        await U.sleep(400);
        key("2"); // choose reason 2
        key("e"); // exclude second
        await U.sleep(400);
        d.getElementById("ai-suggest").click();
        await waitFor(() => /AI suggested decisions/.test(d.getElementById("review-status").textContent), 60000);
        const rings = d.querySelectorAll("#queue .dot.ai").length;
        d.getElementById("ai-accept").click();
        await U.sleep(800);
        const items = reviewCol.getChildItems().filter((i) => i.isRegularItem());
        const tags = (t) => items.filter((i) => i.hasTag(t)).length;
        return { included: tags("zr:include"), excluded: tags("zr:exclude"), reasonTags: items.filter((i) => i.getTags().some((t) => t.tag.startsWith("zr:why:"))).length, aiRings: rings, stillUnscreened: tags("zr:unscreened"), status: d.getElementById("review-status").textContent };
      });

      await step("review: full-text stage and PRISMA diagram", async () => {
        const d = rw.document;
        d.querySelector('#review-steps button[data-step="ft"]').click();
        // Wait for the full-text view (the "maybe" filter is hidden there) and its card
        await waitFor(() => d.querySelector('#queue-filter option[value="maybe"]').hidden && (d.querySelector("#screen-card .paper-card") || d.querySelector("#screen-card .empty-state")), 10000);
        await U.sleep(300);
        const hasCard = !!d.querySelector("#screen-card .paper-card");
        const pdfButton = d.querySelector("#screen-card .actions button:not(.link)")?.textContent || "";
        if (hasCard) {
          d.dispatchEvent(new rw.KeyboardEvent("keydown", { key: "i", bubbles: true }));
          await U.sleep(500);
        }
        d.querySelector('#review-steps button[data-step="prisma"]').click();
        await waitFor(() => d.querySelector("#prisma-view svg"), 10000);
        await U.sleep(300);
        await shot(rw, "10-prisma.png");
        const svgText = d.querySelector("#prisma-view svg").textContent;
        d.getElementById("prisma-note").click();
        await waitFor(() => /saved as a note/.test(d.getElementById("review-status").textContent), 10000);
        const note = reviewCol.getChildItems().find((i) => i.isNote() && i.getNote().includes("PRISMA 2020 flow"));
        return { ftCard: hasCard, pdfButton, included: (svgText.match(/Studies included in review \(n = (\d+)\)/) || [])[1], identified: (svgText.match(/Records identified from databases \(n = (\d+)\)/) || [])[1], note: !!note };
      });
      rw?.close();
    } finally {
      ZR.http = realHTTP;
      report.llmCalls = llmCalls.length;
    }

    // ---------------------------------------------------------- citations
    await step("citations: known links found and added as Zotero 'Related'", async () => {
      const citeCol = new Zotero.Collection({ name: "zr-citations", libraryID });
      await citeCol.saveTx();
      const mk = async (title, fields) => {
        const it = new Zotero.Item(fields.type || "conferencePaper");
        it.libraryID = libraryID;
        it.setField("title", title);
        for (const [k, v] of Object.entries(fields)) if (k !== "type") it.setField(k, v);
        it.setCollections([citeCol.id]);
        await it.saveTx();
        return it;
      };
      const googlenet = await mk("Going deeper with convolutions", { DOI: "10.1109/CVPR.2015.7298594" });
      const resnet = await mk("Deep Residual Learning for Image Recognition", { DOI: "10.1109/CVPR.2016.90" });
      const attention = await mk("Attention Is All You Need", { type: "preprint", url: "https://arxiv.org/abs/1706.03762" });
      await zp.collectionsView.selectCollection(citeCol.id);
      await U.sleep(500);
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      w.App.showTab("citations");
      await U.sleep(500);
      const scopeLabel = (await pick(d.getElementById("cite-scope"), "Whole library")).label;
      await pick(d.getElementById("cite-scope"), "Papers in this collection");
      d.getElementById("cite-scan").click();
      await waitFor(() => /citation links among/.test(d.getElementById("cite-status").textContent) || /failed/.test(d.getElementById("cite-status").textContent), 150000);
      await U.sleep(500);
      await shot(w, "11-citations.png");
      const status = d.getElementById("cite-status").textContent;
      const r1 = Zotero.Items.get(resnet.id);
      const res = {
        status,
        resnetRelatedToGoogLeNet: r1.relatedItems.includes(googlenet.key) && Zotero.Items.get(googlenet.id).relatedItems.includes(resnet.key),
        attentionRelatedToResNet: Zotero.Items.get(attention.id).relatedItems.includes(resnet.key),
        directionStored: ((await ZR.Store.getCitations(libraryID))[resnet.key] || []).includes(googlenet.key),
        graphShown: d.getElementById("graph-empty").hidden,
        scopeDropdown: scopeLabel,
      };
      w.close();
      if (!res.resnetRelatedToGoogLeNet || !res.directionStored) throw new Error(JSON.stringify(res));
      return res;
    });

    await step("disable/enable: UI removed and restored, decisions survive via the library", async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(ZR.id);
      const present = () => ({
        toolbar: !!doc.getElementById("zotero-researcher-tb"),
        batch: !!doc.getElementById("zotero-researcher-batch-btn"),
        api: !!Zotero.Researcher,
        prefPane: Zotero.PreferencePanes.pluginPanes.some((p) => p.id === "zotero-researcher-prefs"),
      });
      ZR.Prefs.set("selftest", ""); // don't re-run the self-test on re-enable
      await addon.disable();
      await U.sleep(1000);
      const afterDisable = present();
      await addon.enable();
      await waitFor(() => doc.getElementById("zotero-researcher-tb") && doc.getElementById("zotero-researcher-batch-btn") && Zotero.Researcher, 20000);
      const afterEnable = present();
      // A fresh plugin instance reads decisions back from the ledger note
      const fresh = Zotero.Researcher;
      const ledger = await fresh.Store.load(libraryID);
      const entry = Object.entries(ledger.decisions).find(([, e]) => e.t && judged.startsWith(e.t.replace(/…$/, "")));
      const prior = entry ? await fresh.Store.prior(libraryID, { key: entry[0] }) : null;
      if (!prior) throw new Error("judgement not found after reload");
      if (Object.values(afterDisable).some(Boolean)) throw new Error("left behind after disable: " + JSON.stringify(afterDisable));
      if (!Object.values(afterEnable).every(Boolean)) throw new Error("not restored: " + JSON.stringify(afterEnable));
      return { afterDisable, afterEnable, rememberedAfterReload: fresh.Store.describe(prior) };
    });

    report.finished = new Date().toISOString();
    report.passed = report.steps.filter((s) => s.ok).length;
    report.failed = report.steps.filter((s) => !s.ok).length;
    await save();
    try {
      const debug = await Zotero.Debug.get();
      const relevant = debug.split("\n").filter((l) => /Researcher|zotero-researcher|Error|error:/i.test(l));
      await IOUtils.writeUTF8(PathUtils.join(outDir, "debug.txt"), relevant.join("\n"));
    } catch (e) {
      /* debug store disabled */
    }
    if (ZR.Prefs.get("selftestQuit", true)) {
      await U.sleep(500);
      Zotero.Utilities.Internal.quit();
    }
  }

  return { maybeRun, run };
})();

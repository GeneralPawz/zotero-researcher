/* global ZR, Zotero, IOUtils, PathUtils, ChromeUtils, Services */
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
  // Mock TypeSafe System 1 endpoint: probabilities cycle through the high, uncertain and
  // low bands so every threshold path is exercised.
  const TYPESAFE_BANDS = [0.92, 0.55, 0.08];
  function mockTypeSafe(o, tsCalls) {
    const band = TYPESAFE_BANDS[tsCalls.length % 3];
    tsCalls.push(o.body);
    const answers = {};
    for (const id of Object.keys(o.body.questions)) answers[id] = { type: "noul", noul: id.startsWith("exc_") ? 0.02 : band };
    const json = { model: "jev-mock", answers, usage: { input_tokens: 200, output_tokens: 5 } };
    return { status: 200, text: JSON.stringify(json), json: () => json };
  }

  // Mock local embedding server (Ollama API): hashed bag of words, so papers that share
  // words are similar - deterministic stand-in for a real embedding model.
  const MOCK_EMBED = "http://mock-embed.invalid";
  function bagOfWords(text) {
    const v = new Array(256).fill(0);
    for (const w of text.replace(/^search_(document|query): /, "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 3) continue;
      let h = 7;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 9973;
      v[h % 256] += 1;
    }
    v[255] += 0.01;
    return v;
  }
  function mockEmbed(url, o) {
    let json;
    if (url.endsWith("/api/version")) json = { version: "mock" };
    else if (url.endsWith("/api/tags")) json = { models: [{ name: "nomic-embed-text:latest" }] };
    else json = { model: o.body.model, embeddings: o.body.input.map(bagOfWords) };
    return { status: 200, text: JSON.stringify(json), json: () => json };
  }

  function mockLLM(realHTTP, calls, tsCalls = []) {
    return async (method, url, o = {}) => {
      if (mockLLM.delayMs && url.startsWith(MOCK)) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, mockLLM.delayMs);
          o.cancellerReceiver?.(() => (clearTimeout(t), reject(Object.assign(new Error("cancelled"), { status: 0 }))));
        });
      }
      if (url === "https://api.typesafe.ai/v1/systemone") return mockTypeSafe(o, tsCalls);
      if (url.startsWith("https://api.firecrawl.dev/")) {
        mockLLM.crawlerCalls = (mockLLM.crawlerCalls || 0) + 1;
        if (mockLLM.crawlerDelay) await new Promise((r) => setTimeout(r, mockLLM.crawlerDelay));
        const json = { success: true, data: [] };
        return { status: 200, text: JSON.stringify(json), json: () => json };
      }
      if (url.startsWith(MOCK_EMBED)) return mockEmbed(url, o);
      if (!url.startsWith(MOCK)) return realHTTP(method, url, o);
      const last = o.body.messages[o.body.messages.length - 1].content;
      const prompt = Array.isArray(last) ? last.filter((p) => p.type === "text").map((p) => p.text).join(" ") : last;
      if (Array.isArray(last)) mockLLM.images = (mockLLM.images || 0) + last.filter((p) => p.type === "image_url").length;
      calls.push(prompt.slice(0, 50));
      const n = (prompt.match(/^\[\d+\]/gm) || []).length;
      let content;
      if (prompt.includes("Which review methodology fits")) content = JSON.stringify({ methodology: "kitchenham", why: "A software-engineering style question about tools and data exchange." });
      else if (prompt.includes("Design a style for flow diagrams")) content = JSON.stringify({ name: "Journal of Mock Engineering", font: "serif", fontSize: 11, radius: 0, bands: false, arrow: "open", boxStroke: "#000000", line: "#000000", text: "#000000", showTitle: false });
      else if (prompt.includes('{"sources"')) content = JSON.stringify({ sources: ["crossref", "doaj", "arxiv"], limit: 5, why: "Multidisciplinary coverage of BIM research." });
      else if (prompt.includes('"verdict": "ok"|"adjust"|"hopeless"')) {
        // first check: too strict → propose a change; second: fine
        mockLLM.assessCalls = (mockLLM.assessCalls || 0) + 1;
        content = JSON.stringify(
          mockLLM.assessCalls === 1
            ? { drilldown: false, verdict: "adjust", explanation: "Almost everything is below the exclude threshold, which looks too strict.", message: "Lower the include threshold and drop the negated exclusion criterion.", changes: { exclusion: [], thresholds: { excludeBelow: 0.1, includeAbove: 0.8 } } }
            : { drilldown: false, verdict: "ok", explanation: "The spread now looks plausible.", message: "", changes: {} }
        );
      } else if (prompt.includes('{"decisions"')) {
        const n = (prompt.match(/"i": \d+/g) || []).length;
        content = JSON.stringify({ decisions: Array.from({ length: n }, (_, i) => ({ i, decision: i % 2 ? "exclude" : "include", reason: i % 2 ? "Off topic" : "", why: "from the annotations" })), summary: "Half of the papers fit." });
      } else if (prompt.includes('{"corrections"')) {
        const n = (prompt.match(/"i": \d+/g) || []).length;
        content = JSON.stringify({ corrections: Array.from({ length: n }, (_, i) => ({ i, verdict: i === 0 ? "maybe" : "keep", why: "ambiguous" })) });
      } else if (prompt.includes('{"annotations"')) {
        const text = (prompt.split('Text:\n"""\n')[1] || "").split('\n"""')[0];
        const sentences = text.split(/(?<=\.)\s+/).map((x) => x.trim()).filter((x) => x.length > 40 && /[.]$/.test(x));
        const pick = (re) => sentences.find((x) => re.test(x));
        content = JSON.stringify({
          annotations: [
            { quote: pick(/modular JSON/), kind: "include", comment: "Reports a concrete change to the IFC 5 schema." },
            { quote: pick(/no releases/), kind: "maybe", comment: "Suggests development may have slowed." },
            { quote: pick(/opinion piece/), kind: "exclude", comment: "Not empirical research." },
          ].filter((a) => a.quote),
          summary: "Partly meets the criteria.",
        });
      } else if (prompt.includes('"recommendedMethodology"'))
        content = JSON.stringify({
          title: "IFC-based BIM data exchange: a systematic review",
          objective: "Establish how IFC is used for data exchange between BIM tools",
          questions: ["RQ1: For which exchange scenarios is IFC used?", "RQ2: Which problems are reported?"],
          framework: "PICO",
          frameworkFields: { population: "BIM authoring and analysis tools", intervention: "IFC-based data exchange", comparison: "", outcome: "Exchange quality and problems" },
          inclusion: ["Studies IFC-based data exchange", "Is a research paper"],
          exclusion: ["Mentions IFC only in passing"],
          query: '("industry foundation classes" OR IFC) AND BIM',
          yearFrom: 2015,
          yearTo: null,
          languages: ["en"],
          types: [],
          quality: ["Is the research method described?", "Is the result evaluated?"],
          extraction: ["Method", "Exchange scenario"],
          recommendedMethodology: "kitchenham",
          recommendationWhy: "an engineering topic",
          rationale: "Drafted from your description.",
        });
      else if (prompt.includes('{"names"')) content = JSON.stringify({ names: (prompt.match(/^\[\d+\]$/gm) || []).map((_, i) => ["Exchange quality", "Model views", "Infrastructure", "Facility management"][i] || "Topic " + i) });
      else if (prompt.includes("\nChecklist:\n")) content = JSON.stringify((prompt.match(/^\d+\. /gm) || []).map((_, i) => ({ i, answer: i ? "partly" : "yes", why: "stated in the abstract" })));
      else if (prompt.includes("\nFields:\n")) {
        const fields = prompt.split("\nFields:\n")[1].split("\n\n")[0].split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);
        content = JSON.stringify(Object.fromEntries(fields.map((f) => [f, "case study"])));
      } else if (prompt.includes('{"query"')) content = JSON.stringify({ query: 'IFC AND ("building information model*" OR BIM)', yearFrom: 2015, yearTo: null, concepts: ["IFC", "BIM"], rationale: "IFC is the open BIM exchange schema." });
      else if (prompt.includes('"decision"')) content = JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, decision: i % 2 ? "exclude" : "include", reason: i % 2 ? "Off topic" : "", confidence: i % 3 === 2 ? 0.6 : 0.9, why: i % 2 ? "not about IFC" : "IFC exchange case study" })));
      else if (prompt.includes("Papers:\n")) content = JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, score: i % 2 ? 3 : 8, reason: i % 2 ? "tangential" : "directly about IFC-based BIM exchange" })));
      else if (prompt.includes("<h2>Comparison</h2>")) content = "<h2>Comparison</h2><table><tr><th>Paper</th><th>Method</th></tr><tr><td>A</td><td>Case study</td></tr></table><h2>Synthesis</h2><p>Both use IFC.</p><script>alert(1)</script>";
      else if (prompt.includes("Item data:")) content = JSON.stringify({ itemType: "journalArticle", title: "Deep learning", authors: [{ firstName: "Yann", lastName: "LeCun" }], date: "2015", DOI: null, venue: "Nature" });
      else if (prompt.includes("SAME work")) content = JSON.stringify({ index: 0, confidence: 0.9, reason: "same title and authors" });
      else content = "OK";
      const json = { choices: [{ message: { content } }], usage: { prompt_tokens: 1200 + prompt.length, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: Math.ceil(String(content).length / 4) } };
      return { status: 200, text: JSON.stringify(json), json: () => json };
    };
  }

  /** A minimal text PDF (Helvetica, one line per string) for the full-text tests. */
  function simplePDF(pages) {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const objects = [];
    const kids = [];
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    let n = 4;
    for (const lines of pages) {
      const stream = "BT /F1 11 Tf 16 TL 60 740 Td " + lines.map((l) => `(${esc(l)}) Tj T* T*`).join(" ") + " ET";
      objects[n] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`;
      objects[n + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      kids.push(`${n} 0 R`);
      n += 2;
    }
    objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
    let out = "%PDF-1.4\n";
    const offsets = [];
    for (let i = 1; i < n; i++) {
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${n}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  }

  /**
   * Open Settings on the plugin's pane. The window takes focus when it opens, so a stray
   * keystroke from another app can land in its search box - clear it and navigate back.
   */
  async function openPrefs() {
    const pw = Zotero.Utilities.Internal.openPreferences("zotero-researcher-prefs");
    await waitFor(() => pw.document?.readyState === "complete" && pw.Zotero_Preferences, 30000);
    try {
      const P = pw.Zotero_Preferences;
      if (P.searchField?.value) {
        P.searchField.value = "";
        await P._search("");
      }
      await P.navigateToPane("zotero-researcher-prefs");
    } catch (e) {
      /* older Zotero: keep what opened */
    }
    return pw;
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
      win.focus(); // popups only open in the active window
      await U.sleep(300);
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
      d.querySelector("#builder .qb-add").click();
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
      const firstRow = d.querySelector("#builder .qb-row");
      const styled = w.getComputedStyle(firstRow).display === "flex" && w.getComputedStyle(d.getElementById("builder")).borderTopStyle !== "none";
      const cssURL = d.querySelector('link[rel="stylesheet"]').getAttribute("href");
      const res = { built, xor, feedback: d.getElementById("query-feedback").textContent, opMenuVisible: opPick.visible, rowsFromText: rows, styled, cssURL };
      if (!styled) throw new Error("builder CSS not applied " + JSON.stringify(res));
      if (!cssURL.includes("?v=" + ZR.version)) throw new Error("stylesheet URL not version-stamped: " + cssURL);
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

    await step("filters (language, type, abstract) and sort order", async () => {
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      d.querySelector('#mode-seg button[data-mode="structured"]').click();
      w.App.panels.search.useQueryText('"building information model*" AND IFC');
      for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["openalex", "crossref", "doaj"].includes(cb.value);
      d.getElementById("options-chip").click();
      const clickPick = (box, label) => [...d.querySelectorAll(`#${box} .pick`)].find((p) => p.textContent === label).click();
      clickPick("lang-picks", "English");
      clickPick("type-picks", "Journal articles");
      d.getElementById("has-abstract").checked = true;
      d.getElementById("has-abstract").dispatchEvent(new w.Event("change"));
      await U.sleep(200);
      await shot(w, "04b-filters.png");
      const chip = d.getElementById("options-chip").textContent;
      d.getElementById("limit").value = "6";
      d.getElementById("skip-existing").checked = false;
      d.getElementById("run").click();
      await waitFor(() => !d.getElementById("run").disabled && /papers found/.test(d.getElementById("search-status").textContent), 120000);
      await pick(d.getElementById("res-sort"), "Newest first");
      const years = [...d.querySelectorAll("#results .r-meta")].map((m) => parseInt((m.textContent.match(/\b(19|20)\d\d\b/) || [])[0], 10)).filter(Boolean);
      const sortedDesc = years.every((y, i) => i === 0 || years[i - 1] >= y);
      const res = { chip, status: d.getElementById("search-status").textContent, results: d.querySelectorAll("#results .result").length, years, sortedDesc };
      w.close();
      if (!/EN/.test(chip) || !/with abstract/.test(chip)) throw new Error("options chip lacks filters: " + chip);
      if (years.length < 2 || !sortedDesc) throw new Error("not sorted newest first: " + years);
      return res;
    });

    await step("clicking a paper already in the library jumps to it / lists its collections", async () => {
      // the previous step's filters are remembered by design (globally and in the project)
      ZR.Prefs.setJSON("dialogState", {});
      for (const p of await ZR.Projects.list(libraryID)) (p.search = {}), await ZR.Projects.save(libraryID, p);
      await zp.collectionsView.selectCollection(collection.id);
      await U.sleep(400);
      const w = await openResearch(win, { tab: "find", itemIDs: [] });
      const d = w.document;
      d.querySelector('#mode-seg button[data-mode="structured"]').click();
      w.App.panels.search.useQueryText('IFC AND "building information model*"');
      for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["crossref", "arxiv", "doaj"].includes(cb.value);
      d.getElementById("limit").value = "4";
      d.getElementById("skip-existing").checked = false;
      d.getElementById("run").click();
      await waitFor(() => !d.getElementById("run").disabled && /papers found|failed/.test(d.getElementById("search-status").textContent), 150000);
      if (!d.querySelector("#results .tag.lib")) {
        throw new Error("no in-library result: " + JSON.stringify({ status: d.getElementById("search-status").textContent, detail: d.getElementById("search-status").title, rows: d.querySelectorAll("#results .result").length, skipExisting: d.getElementById("skip-existing").checked, hideExcluded: d.getElementById("hide-excluded").checked, inCollection: collection.getChildItems().filter((i) => i.isRegularItem()).map((i) => i.getField("title").slice(0, 40)) }));
      }
      const timings = d.getElementById("search-status").title;
      const row = d.querySelector("#results .tag.lib").closest(".result");
      const title = row.querySelector(".r-title a").textContent;
      // default: jump
      await zp.collectionsView.selectLibrary(libraryID);
      await U.sleep(300);
      ZR.Prefs.set("resultClick", "jump");
      row.querySelector(".r-title a").click();
      await waitFor(() => zp.getSelectedItems()[0]?.getField("title") === title, 10000);
      const jumpedTo = zp.getCollectionTreeRows()[0]?.ref?.name;
      // alternative: list collections
      ZR.Prefs.set("resultClick", "collections");
      row.querySelector(".r-title a").click();
      const cols = await waitFor(() => row.querySelector(".in-cols"), 5000);
      await shot(w, "04c-in-collections.png");
      const listed = [...cols.querySelectorAll("a")].map((a) => a.textContent);
      await zp.collectionsView.selectLibrary(libraryID);
      cols.querySelector("a").click();
      await waitFor(() => zp.getSelectedItems()[0]?.getField("title") === title, 10000);
      ZR.Prefs.set("resultClick", "jump");
      w.close();
      if (jumpedTo !== "zr-selftest") throw new Error("jumped to " + jumpedTo);
      return { title, jumpedTo, listed, webLink: !!row.querySelector(".r-title a.web"), timings };
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
      const pw = await openPrefs();
      try {
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
      await pick(d.getElementById("zr-llm-provider"), "Claude Code CLI");
      const program = await waitFor(() => [...d.querySelectorAll("#zr-llm-editor input")].map((i) => i.value).find((v) => /claude(.exe|.cmd)?$/i.test(v)), 15000).catch(() => "not detected");
      const keyRowHidden = [...d.querySelectorAll("#zr-llm-editor label")].find((l) => l.textContent === "API key")?.hidden;
      // The key field itself must be gone for CLIs, and nothing may stick out of the pane
      const editor = d.querySelector("#zr-llm-editor .zr-editor");
      if (!editor.getBoundingClientRect().width) throw new Error("the AI provider editor is not visible (Settings search active?): layout can't be checked");
      const keyFieldShown = d.querySelector('#zr-llm-editor input[type="password"]').getBoundingClientRect().width > 0;
      const claudeModels = await waitFor(() => d.querySelectorAll("#zr-llm-editor .zr-model-row").length >= 4 && [...d.querySelectorAll("#zr-llm-editor .zr-model-row")].map((r) => r.querySelector(".zr-model-id").textContent), 15000).catch(() => []);
      const right = editor.getBoundingClientRect().right;
      const overflowing = [...editor.querySelectorAll("input, select, button, .zr-dd-btn")].filter((e) => e.getBoundingClientRect().width && e.getBoundingClientRect().right > right + 1).map((e) => e.id || e.className || e.localName);
      editor.scrollIntoView();
      await U.sleep(200);
      await shot(pw, "06c-ai-editor-cli.png");
      await pick(d.getElementById("zr-llm-provider"), "Codex CLI");
      const codexModels = await waitFor(() => [...d.querySelectorAll("#zr-llm-editor .zr-model-row .zr-model-id")].map((r) => r.textContent).filter((t) => /gpt/i.test(t)).length && [...d.querySelectorAll("#zr-llm-editor .zr-model-row .zr-model-id")].map((r) => r.textContent), 15000).catch(() => []);
      const astra = [...d.querySelectorAll("#zr-llm-editor .zr-model-row")].find((r) => /gpt/i.test(r.querySelector(".zr-model-id")?.textContent || ""));
      astra?.click();
      const codexEfforts = codexModels.length ? await waitFor(() => [...d.querySelectorAll("#zr-llm-effort option")].map((o) => o.value).filter(Boolean).length && [...d.querySelectorAll("#zr-llm-effort option")].map((o) => o.value).filter(Boolean), 8000).catch(() => []) : [];
      await shot(pw, "06d-ai-editor-codex.png");
      if (codexModels.length && !codexEfforts.length) throw new Error("no reasoning levels for Codex: " + JSON.stringify(codexModels.slice(0, 3)));
      if (keyFieldShown || overflowing.length || claudeModels.length < 4) throw new Error(JSON.stringify({ keyFieldShown, overflowing, claudeModels }));
      d.getElementById("zr-llm-provider").zrDropdownButton.click();
      await U.sleep(200);
      await shot(pw, "06b-preferences-dropdown.png");
      d.querySelector(".zr-dd-menu .zr-dd-item")?.click();
      const res = { codexEfforts, checklist: d.querySelectorAll("#zr-checklist .zr-check-row").length, areas: d.querySelectorAll("#zr-areas .zr-area").length, databasesShown: rowsDefault, pubmedListed, aiEditor: !!d.querySelector("#zr-llm-editor .zr-editor"), providerMenuVisible: prov.visible, baseAfterPick, cliProgram: program, cliHidesKey: keyRowHidden, claudeModels, codexModels, system1: d.querySelectorAll("#zr-s1 select, #zr-s1 input").length };
      if (pubmedListed) throw new Error("PubMed listed although medicine is off");
      return res;
      } finally {
        pw.close();
      }
    });

    // ------------------------------------------------ AI + review (mock LLM)
    const realHTTP = ZR.http;
    const llmCalls = [];
    const tsCalls = [];
    ZR.http = ZR.Activity.wrapHTTP(mockLLM(ZR.Util.zoteroHTTP, llmCalls, tsCalls));
    if (!ZR.Prefs.get("selftestOllama", false)) ZR.Prefs.set("embedURL", MOCK_EMBED);
    await ZR.Secrets.set(ZR.PDFHunt.keyName("firecrawl"), "fc-mock");
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

      // --- Structured review project: protocol → pool → System 1 → AI → decisions → report
      let rw;
      let reviewProject;
      let reviewCol;
      await ZR.Secrets.set(ZR.System1.keyName, "ts-mock");
      ZR.Prefs.set("s1Engine", "typesafe");
      const rv = () => rw.document;
      const rvStatus = () => rv().getElementById("review-status").textContent;
      const goStep = async (s, ready) => {
        rv().querySelector(`#rv-steps button[data-step="${s}"]`).click();
        await waitFor(() => ready(rv()), 15000);
        await U.sleep(250);
      };
      const key = (k) => rv().dispatchEvent(new rw.KeyboardEvent("keydown", { key: k, bubbles: true }));

      await step("projects: a collection you add papers to remembers its searches in a quick project", async () => {
        await zp.collectionsView.selectCollection(collection.id);
        await U.sleep(400);
        rw = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = rv();
        const p = rw.App.project;
        if (!p || p.kind !== "quick" || p.collectionKey !== collection.key) throw new Error("no quick project for the collection: " + JSON.stringify(p));
        return { project: p.name, runs: p.runs.length, rememberedQuery: p.search.query || p.search.request, selectValue: d.getElementById("project-select").value === p.id };
      });

      await step("projects: create a structured review project with its own collection", async () => {
        const d = rv();
        await pick(d.getElementById("project-select"), "New project");
        await waitFor(() => !d.getElementById("np-layer").hidden, 5000);
        const useDisabled = d.querySelector('input[name="np-col"][value="use"]').disabled; // collection already has a project
        d.getElementById("np-name").value = "IFC review";
        d.querySelector('input[name="np-kind"][value="review"]').checked = true;
        d.querySelector('input[name="np-col"][value="new"]').checked = true;
        await shot(rw, "08-new-project.png");
        d.getElementById("np-create").click();
        await waitFor(() => rw.App.project?.name === "IFC review" && !d.getElementById("rv-main").hidden && !d.getElementById("rv-protocol").hidden, 15000);
        reviewProject = rw.App.project;
        reviewCol = Zotero.Collections.getByLibraryAndKey(libraryID, reviewProject.collectionKey);
        return { kind: reviewProject.kind, methodology: reviewProject.methodology, collection: reviewCol?.name, target: d.getElementById("target").textContent, useCurrentDisabled: useDisabled, pill: d.getElementById("review-pill").textContent };
      });

      await step("review protocol: the form follows the methodology; describe in plain words → AI fills it", async () => {
        const d = rv();
        const fields = () => [...d.querySelectorAll("#rv-form .pf-row")].map((r) => r.dataset.field);
        d.querySelector('#rv-protocol-mode button[data-mode="form"]').click();
        d.querySelector('#rv-methods [data-method="kitchenham"]').click();
        const kitchenham = fields();
        d.querySelector('#rv-methods [data-method="scoping"]').click();
        const scoping = fields();
        const scopingFramework = d.getElementById("pf-framework").value;
        d.querySelector('#rv-methods [data-method="prisma2020"]').click();
        d.querySelector('#rv-protocol-mode button[data-mode="describe"]').click();
        d.getElementById("rv-description").value = "For my thesis I want to know how IFC is used for BIM data exchange between tools. Only research papers since 2015, in English. Papers that only mention IFC in passing are out.";
        d.getElementById("rv-fill").click();
        await waitFor(() => !d.getElementById("rv-form").hidden && d.getElementById("pf-inclusion")?.value, 30000);
        await shot(rw, "09-protocol.png");
        const recommended = d.querySelector("#rv-form .ai-box")?.textContent || "";
        const filled = { inclusion: d.getElementById("pf-inclusion").value, query: d.getElementById("pf-query").value, population: d.getElementById("pf-fw-population")?.value };
        d.getElementById("rv-save").click();
        await waitFor(() => /Saved/.test(d.getElementById("rv-save-note").textContent), 10000);
        const p = await ZR.Projects.get(libraryID, reviewProject.id);
        if (!kitchenham.includes("quality") || scoping.includes("quality") || scopingFramework !== "PCC") throw new Error("form does not follow methodology: " + JSON.stringify({ kitchenham, scoping, scopingFramework }));
        if (!p.protocol.inclusion.length || p.search.query !== p.protocol.query) throw new Error("protocol not saved: " + JSON.stringify(p));
        return { filled, recommended: recommended.slice(0, 80), savedCriteria: p.protocol.inclusion.length + p.protocol.exclusion.length, searchSynced: p.search.query, years: [p.protocol.yearFrom, p.protocol.yearTo] };
      });

      await step("protocol form: structured lists with +, the query builder or raw text (one switch), a growing query box", async () => {
        const d = rv();
        const R = rw.App.panels.review;
        await R.go("protocol");
        d.querySelector('#rv-protocol-mode button[data-mode="form"]').click();
        d.querySelector('#rv-view button[data-view="structured"]').click();
        const modeIcons = [...d.querySelectorAll("#rv-protocol-mode button")].map((b) => ({ icon: !!b.querySelector("svg"), title: b.title, text: b.textContent.trim() }));
        const list = d.querySelector('.pf-list[data-list="questions"]');
        const before = list.querySelectorAll(".pf-li").length;
        d.querySelector('.pf-add[data-add="questions"]').click();
        const rows = list.querySelectorAll(".pf-li");
        const t = rows[rows.length - 1].querySelector("textarea");
        t.value = "Which exchange problems are reported?";
        t.dispatchEvent(new rw.Event("input"));
        const hidden = d.getElementById("pf-questions").value.split("\n");
        const numbers = [...list.querySelectorAll(".pf-num")].map((n) => n.textContent);
        const builderRows = d.querySelectorAll("#pf-query-builder .qb-row").length;
        const fb = d.getElementById("pf-query-fb");
        const feedback = { text: fb.textContent, onHover: fb.title.slice(0, 60) };
        const otherLists = [...d.querySelectorAll(".pf-list")].map((l) => l.dataset.list);
        await shot(rw, "15a-protocol-structured.png");
        // one switch turns every list and the query into text
        d.querySelector('#rv-view button[data-view="text"]').click();
        const q = d.getElementById("pf-query");
        const textView = !d.getElementById("pf-questions").hidden && !q.hidden && !d.querySelector(".pf-list") && !d.getElementById("pf-query-builder");
        const long = '(BIM OR "building information model*" OR "building information management" OR Bauwerksinformationsmodell* OR Gebäudedatenmodell*) AND (construction OR Bauausführung OR Bauphase OR Baustell* OR Bauprozess* OR "site management" OR "site coordination" OR "field management" OR "site logistics" OR "progress monitoring" OR "production planning" OR "4D BIM" OR "5D BIM")';
        const original = q.value;
        q.value = long;
        q.dispatchEvent(new rw.Event("input"));
        await U.sleep(50);
        const grown = { height: q.clientHeight, content: q.scrollHeight };
        await shot(rw, "15b-protocol-text.png");
        q.value = original;
        q.dispatchEvent(new rw.Event("input"));
        d.querySelector('#rv-view button[data-view="structured"]').click();
        const kept = [...d.querySelectorAll('.pf-list[data-list="questions"] textarea')].some((x) => /exchange problems/.test(x.value));
        // unsaved edits are dropped again for the next steps
        R.reset();
        await R.refresh();
        await R.go("protocol");
        const res = { modeIcons, before, after: rows.length, hidden: hidden.length, numbers, builderRows, feedback, otherLists, textView, grown, kept };
        if (rows.length !== before + 1 || hidden.length !== before + 1 || numbers.at(-1) !== `RQ${before + 1}` || !builderRows || feedback.text !== "✓ Valid query" || !feedback.onHover || !textView || grown.height < 60 || grown.height < grown.content - 4 || !kept || modeIcons.some((m) => !m.icon || m.text)) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("review search: pre-filled from the protocol; results go into the pool, not the library", async () => {
        const d = rv();
        const next = d.getElementById("rv-next");
        const nextLabel = !next.hidden && next.textContent;
        next.click();
        await waitFor(() => !d.getElementById("rv-search").hidden, 5000);
        d.getElementById("rv-add-search").click();
        await waitFor(() => !d.getElementById("panel-search").hidden, 5000);
        const prefilled = d.getElementById("query").value;
        for (const cb of d.querySelectorAll("#sources input")) cb.checked = ["crossref", "doaj", "arxiv"].includes(cb.value);
        d.getElementById("limit").value = "5";
        d.getElementById("hide-excluded").checked = false;
        d.getElementById("skip-existing").checked = false;
        d.getElementById("run").click();
        await waitFor(() => d.querySelectorAll("#results .result").length > 3 && !d.getElementById("run").disabled, 120000);
        const label = d.getElementById("import").textContent;
        d.getElementById("import").click();
        await waitFor(() => /screening pool|Adding failed/.test(d.getElementById("search-status").textContent), 60000);
        const pool = await ZR.Projects.loadPool(libraryID, reviewProject.id);
        const p = await ZR.Projects.get(libraryID, reviewProject.id);
        // came from the review: continues with screening
        const jumped = await waitFor(() => !d.getElementById("panel-review").hidden && !d.getElementById("rv-screen").hidden, 10000).catch(() => false);
        const res = { nextLabel, prefilled, importLabel: label, pool: Object.keys(pool.records).length, inCollection: reviewCol.getChildItems().filter((i) => i.isRegularItem()).length, runsLogged: p.runs.length, jumpedToScreening: !!jumped, status: d.getElementById("search-status").textContent };
        if (!/Next: Find papers/.test(nextLabel || "") || !jumped || !/screening pool/.test(label) || res.pool < 3 || res.inCollection !== 0 || res.runsLogged !== 1) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("System 1 (TypeSafe Jev, mocked): rate every paper, histogram, threshold decisions", async () => {
        const d = rv();
        rw.App.showTab("review");
        await waitFor(() => !d.getElementById("rv-main").hidden, 5000);
        await goStep("screen", (x) => x.querySelector("#screen-card .paper-card"));
        d.getElementById("s1-rate").click();
        await waitFor(() => /Rated \d+/.test(rvStatus()), 60000);
        await U.sleep(300);
        const rated = d.querySelectorAll("#queue .q-p").length;
        const bins = d.querySelectorAll("#s1-hist .bin").length;
        const firstBody = tsCalls[0];
        await shot(rw, "10-system1.png");
        d.getElementById("s1-low").value = "30";
        d.getElementById("s1-low").dispatchEvent(new rw.Event("change"));
        d.getElementById("s1-high").value = "80";
        d.getElementById("s1-high").dispatchEvent(new rw.Event("change"));
        await U.sleep(400);
        const exBtn = d.getElementById("s1-exclude");
        const toExclude = parseInt(exBtn.textContent.replace(/\D+/g, ""), 10) || 0;
        exBtn.click(); // arms
        const armedText = exBtn.textContent;
        exBtn.click(); // confirms
        await waitFor(() => /Excluded \d+ paper/.test(rvStatus()), 30000);
        const inBtn = d.getElementById("s1-include");
        const toInclude = parseInt(inBtn.textContent.replace(/\D+/g, ""), 10) || 0;
        inBtn.click();
        inBtn.click();
        await waitFor(() => /Included \d+ paper/.test(rvStatus()), 60000);
        const items = reviewCol.getChildItems().filter((i) => i.isRegularItem());
        const ledger = await ZR.Store.load(libraryID);
        const byS1 = Object.values(ledger.decisions).filter((e) => e.c === reviewCol.key && e.ta?.by === "s1");
        const res = {
          typesafeCalls: tsCalls.length,
          questions: Object.keys(firstBody?.questions || {}),
          stateFields: Object.keys(firstBody?.state || {}),
          rated,
          bins,
          armedText,
          toExclude,
          toInclude,
          includedIntoCollection: items.filter((i) => i.hasTag("zr:include")).length,
          decidedByS1: byS1.length,
        };
        if (!res.typesafeCalls || !res.questions.includes("relevant") || !res.questions.some((q) => q.startsWith("exc_")) || res.includedIntoCollection !== toInclude || res.decidedByS1 !== toExclude + toInclude) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("screening card: decisions on top, tinted criteria, search terms, highlights with a note → Zotero", async () => {
        const d = rv();
        // a paper with an abstract long enough to highlight in
        const cands = rw.App.panels.review.candidates;
        const target = cands.find((c) => !c.ta && (c.abstract || "").length > 200);
        if (!target) throw new Error("no undecided paper with an abstract");
        d.querySelector(`#queue .q-item[data-key="${target.key}"]`).click();
        await waitFor(() => d.querySelector("#screen-card .abstract span[data-o]"), 5000);
        const card = d.querySelector("#screen-card .paper-card");
        const order = [...card.children].map((n) => n.className.split(" ")[0]);
        const decideFirst = order.indexOf("decide") < order.indexOf("s1-box");
        const tinted = [...card.querySelectorAll(".crit")].filter((r) => /v-(inc|may|exc)/.test(r.className)).length;
        const abs = card.querySelector(".abstract");
        const cs = rw.getComputedStyle(abs);
        const style = { textAlign: cs.textAlign, hyphens: cs.hyphens }; // read now: the card is re-rendered below
        const kwMarks = card.querySelectorAll(".kw").length;
        const foundBy = card.querySelector(".found-by")?.textContent || "";
        // select a passage and right-click it
        const span = [...abs.querySelectorAll("span[data-o]")].find((s) => s.textContent.length > 40) || abs.querySelector("span[data-o]");
        const range = d.createRange();
        range.setStart(span.firstChild, 5);
        range.setEnd(span.firstChild, Math.min(span.firstChild.length, 35));
        const quote = range.toString().trim();
        d.getSelection().removeAllRanges();
        d.getSelection().addRange(range);
        const rect = span.getBoundingClientRect();
        span.dispatchEvent(new rw.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 5 }));
        const menu = await waitFor(() => d.querySelector(".ctx-menu"), 3000);
        const menuItems = [...menu.querySelectorAll(".ctx-item")].map((b) => b.textContent);
        await shot(rw, "11a-highlight-menu.png");
        menu.querySelector('.ctx-item[data-kind="include"]').click();
        const mark = await waitFor(() => d.querySelector("#screen-card .abstract .hl-include"), 5000);
        // right-click the highlight to add a note
        const r2 = mark.getBoundingClientRect();
        mark.dispatchEvent(new rw.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r2.left + 4, clientY: r2.top + 4 }));
        const menu2 = await waitFor(() => d.querySelector(".ctx-menu"), 3000);
        [...menu2.querySelectorAll(".ctx-item")].find((b) => /note/i.test(b.textContent)).click();
        const pop = await waitFor(() => d.querySelector(".note-pop textarea"), 3000);
        pop.value = "Reports a concrete IFC 5 milestone";
        d.querySelector(".note-pop .primary").click();
        await waitFor(() => d.querySelector("#screen-card .hl-notetext"), 5000);
        await shot(rw, "11b-highlight-note.png");
        const pool = await ZR.Projects.loadPool(libraryID, reviewProject.id);
        const stored = pool.notes?.[target.key] || [];
        // one sentence per paragraph (Settings)
        ZR.Prefs.set("abstractSentences", true);
        d.querySelector(`#queue .q-item[data-key="${target.key}"]`).click();
        const sentences = await waitFor(() => d.querySelectorAll("#screen-card .abstract p.sentence").length, 5000).catch(() => 0);
        ZR.Prefs.set("abstractSentences", false);
        // including the paper takes the highlights into Zotero
        d.querySelector(`#queue .q-item[data-key="${target.key}"]`).click();
        await U.sleep(200);
        key("i");
        const note = await waitFor(() => {
          const c = rw.App.panels.review.candidates.find((x) => x.key === target.key);
          const item = c?.itemID && Zotero.Items.get(c.itemID);
          return item && item.getNotes().map((id) => Zotero.Items.get(id)).find((n) => n.hasTag("zr:highlights"));
        }, 20000);
        const html = note.getNote();
        const res = {
          decideFirst,
          tinted,
          textAlign: style.textAlign,
          hyphens: style.hyphens,
          lang: abs.getAttribute("lang"),
          kwMarks,
          foundBy: foundBy.slice(0, 120),
          menuItems,
          quote,
          stored: stored.map((h) => [h.kind, h.text, h.note]),
          sentences,
          noteInZotero: html.includes("Screening highlights") && html.includes("IFC 5 milestone"),
        };
        if (!decideFirst || !tinted || style.textAlign !== "justify" || !kwMarks || stored.length !== 1 || stored[0].note !== "Reports a concrete IFC 5 milestone" || sentences < 2 || !res.noteInZotero) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("activity log: web, AI and System 1 calls with timing and details", async () => {
        const d = rv();
        d.querySelector("#panel-review .log-btn").click();
        const panel = await waitFor(() => d.getElementById("log-panel"), 3000);
        const kinds = [...new Set([...panel.querySelectorAll(".log-kind")].map((k) => k.textContent))];
        const rows = panel.querySelectorAll(".log-row").length;
        panel.querySelector(".log-row").click();
        const detail = await waitFor(() => panel.querySelector(".log-detail")?.textContent, 3000);
        [...panel.querySelectorAll(".seg button")].find((b) => b.textContent === "AI").click();
        await U.sleep(100);
        const aiRows = panel.querySelectorAll(".log-row").length;
        await shot(rw, "11c-activity-log.png");
        rw.App.closeLog();
        const res = { rows, kinds, aiRows, detail: detail.slice(0, 120) };
        if (!rows || !kinds.includes("web") || !aiRows) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("the AI reasons about the uncertain middle; keyboard screening of the rest", async () => {
        const d = rv();
        const uncertainLabel = d.getElementById("ai-uncertain").textContent;
        d.getElementById("ai-uncertain").click();
        await waitFor(() => /AI suggested decisions|AI suggestions failed/.test(rvStatus()), 60000);
        const rings = d.querySelectorAll("#queue .dot.ai").length;
        const aiStatus = rvStatus();
        d.getElementById("ai-accept").click();
        await waitFor(() => /Accepted|No undecided/.test(rvStatus()), 30000);
        const accepted = rvStatus();
        // decide what is left by keyboard
        let guard = 0;
        while (d.querySelector("#screen-card .paper-card") && guard++ < 30) {
          key(guard % 2 ? "i" : "e");
          await U.sleep(350);
        }
        const cands = await ZR.Projects.candidates(libraryID, reviewProject);
        const res = { uncertainLabel, rings, aiStatus, accepted, undecided: cands.filter((c) => !c.ta).length, included: cands.filter((c) => c.ta === "include").length, inCollection: reviewCol.getChildItems().filter((i) => i.isRegularItem()).length };
        if (!rings || res.undecided) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("full text, quality appraisal and data extraction (AI-filled)", async () => {
        const d = rv();
        await goStep("fulltext", (x) => x.querySelector('#queue-filter option[value="maybe"]').hidden && (x.querySelector("#screen-card .paper-card") || x.querySelector("#screen-card .empty-state")));
        const pdfButton = d.querySelector("#screen-card .actions button:not(.link)")?.textContent || "";
        let guard = 0;
        while (d.querySelector("#screen-card .paper-card") && guard++ < 30) {
          key("i");
          await U.sleep(350);
        }
        await goStep("quality", (x) => x.querySelector("#rv-table-body table, #rv-table-body .empty-state"));
        rw.App.status("review", "");
        d.getElementById("rv-table-ai").click();
        await waitFor(() => /The AI filled \d+ paper\(s\)(,|\.)/.test(rvStatus()), 60000);
        await U.sleep(300);
        const qa = [...d.querySelectorAll("#rv-table-body select.qa")].map((s) => s.value).filter(Boolean).length;
        await goStep("extract", (x) => x.querySelector("#rv-table-body table, #rv-table-body .empty-state"));
        rw.App.status("review", "");
        d.getElementById("rv-table-ai").click();
        await waitFor(() => /The AI filled \d+ paper\(s\)(,|\.)/.test(rvStatus()) && !d.getElementById("rv-table-ai").disabled, 60000);
        await U.sleep(300);
        await shot(rw, "11-extraction.png");
        const extracted = [...d.querySelectorAll("#rv-table-body textarea")].filter((t) => t.value).length;
        const pool = await ZR.Projects.loadPool(libraryID, reviewProject.id);
        const res = { pdfButton, qaCells: qa, extractedCells: extracted, storedQA: Object.keys(pool.qa).length, storedExtract: Object.keys(pool.extract).length, steps: [...d.querySelectorAll("#rv-steps button")].map((b) => b.textContent).join(" | ") };
        if (!qa || !extracted) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("report: flow diagram from the logged search and every decision; protocol note", async () => {
        const d = rv();
        await goStep("report", (x) => x.querySelector("#prisma-view svg"));
        await shot(rw, "12-report.png");
        const svgText = d.querySelector("#prisma-view svg").textContent;
        d.getElementById("prisma-note").click();
        await waitFor(() => /saved as a note/.test(rvStatus()), 10000);
        const note = reviewCol.getChildItems().find((i) => i.isNote() && i.getNote().includes("Methodology:"));
        const funnel = d.getElementById("rv-funnel").textContent;
        const res = { identified: (svgText.match(/Records identified from databases \(n = (\d+)\)/) || [])[1], screened: (svgText.match(/Records screened \(n = (\d+)\)/) || [])[1], included: (svgText.match(/Studies included in review \(n = (\d+)\)/) || [])[1], funnel, note: !!note && note.getNote().includes("PRISMA 2020 flow") };
        if (!res.note || !res.identified) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("report diagrams: PRISMA, review process, search strategy; styles (preset, editor, AI from text and image); copy and download as PNG, JPG, SVG, LaTeX", async () => {
        const d = rv();
        const RV = rw.ReportView;
        await goStep("report", (x) => x.querySelector("#prisma-view svg"));
        const svg = () => d.querySelector("#prisma-view svg").outerHTML;
        const text = () => d.querySelector("#prisma-view svg").textContent;
        const res = { diagrams: {}, panelCollapsed: d.getElementById("ap-panel")?.classList.contains("collapsed") };
        for (const k of ["process", "search", "prisma"]) {
          d.querySelector(`#rp-diagram [data-d="${k}"]`).click();
          await waitFor(() => RV.kind() === k && d.querySelector(`#rp-diagram [data-d="${k}"].on`), 3000);
          res.diagrams[k] = text().slice(0, 110);
          if (k !== "prisma") await shot(rw, `12d-diagram-${k}.png`);
        }
        // a preset
        d.getElementById("rp-theme").value = "print";
        d.getElementById("rp-theme").dispatchEvent(new rw.Event("change"));
        await waitFor(() => RV.currentTheme().id === "print" && d.getElementById("rp-theme").value === "print" && !/ rx="6"/.test(svg()), 5000).catch(() => null);
        res.printSquare = !/<rect[^>]* rx="[1-9]/.test(svg().replace(/<marker[\s\S]*?<\/marker>/, ""));
        // the editor: corners, then save as a style of its own
        d.getElementById("rp-edit").click();
        const radius = await waitFor(() => d.querySelector('#rp-editor input[data-key="radius"]'), 3000);
        radius.value = "12";
        radius.dispatchEvent(new rw.Event("input"));
        res.editedRadius = / rx="12"/.test(svg());
        res.unsaved = d.getElementById("rp-theme").value === "__draft";
        await shot(rw, "12e-style-editor.png");
        d.getElementById("rp-name").value = "Selftest style";
        d.getElementById("rp-save-new").click();
        await waitFor(() => ZR.Prefs.getJSON("diagramThemes", []).some((t) => t.name === "Selftest style") && d.getElementById("rp-theme").value !== "__draft", 5000).catch(() => null);
        res.savedStyle = d.getElementById("rp-theme").selectedOptions[0]?.textContent;
        // the AI: a description and an example image
        d.getElementById("rp-edit").click();
        d.getElementById("rp-ai").click();
        await waitFor(() => d.getElementById("rp-ai-run"), 3000);
        RV.setStyleImage({ mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", name: "example.png" });
        d.getElementById("rp-ai-text").value = "Black and white, Times, square boxes, open arrows";
        mockLLM.images = 0;
        d.getElementById("rp-ai-run").click();
        await waitFor(() => RV.currentTheme().name === "Journal of Mock Engineering", 20000);
        const t = RV.currentTheme();
        res.ai = { font: t.font, radius: t.radius, bands: t.bands, arrow: t.arrow, imagesSent: mockLLM.images, editorOpen: !d.getElementById("rp-editor").hidden };
        await shot(rw, "12f-style-ai.png");
        // downloads (to a temporary folder instead of the save dialog)
        const dir = PathUtils.join(PathUtils.tempDir, "zr-diagrams-" + Date.now());
        await IOUtils.makeDirectory(dir);
        const head = {};
        for (const f of ["png", "jpg", "svg", "tikz", "latex"]) {
          const p = PathUtils.join(dir, "d." + f);
          await RV.download(f, p);
          const b = await IOUtils.read(p);
          head[f] = f === "png" ? [...b.slice(1, 4)].map((x) => String.fromCharCode(x)).join("") + ` ${(b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]}px` : f === "jpg" ? [...b.slice(0, 3)].join(",") : new TextDecoder().decode(b.slice(0, 40)).split("\n")[0];
        }
        const svgWidth = Number(svg().match(/ width="(\d+)"/)[1]);
        res.files = head;
        res.pngScale = Number(head.png.split(" ")[1].replace("px", "")) / svgWidth;
        await IOUtils.remove(dir, { recursive: true });
        // clipboard: LaTeX as text, the image as an image
        const readClip = () => {
          const Cc = Components.classes;
          const Ci = Components.interfaces;
          const tr = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
          tr.init(null);
          tr.addDataFlavor("text/plain");
          Services.clipboard.getData(tr, Services.clipboard.kGlobalClipboard);
          const o = {};
          tr.getTransferData("text/plain", o);
          return o.value.QueryInterface(Ci.nsISupportsString).data;
        };
        await RV.copy("tikz");
        res.clipTikz = readClip().split("\n")[0];
        await RV.copy("png");
        res.clipImage = Services.clipboard.hasDataMatchingFlavors(["application/x-moz-nativeimage", "image/png"], Services.clipboard.kGlobalClipboard);
        // the menus
        d.getElementById("rp-download").click();
        res.downloadMenu = [...(await waitFor(() => d.querySelector(".ctx-menu"), 3000)).querySelectorAll(".ctx-item")].map((x) => x.textContent.split(" ")[0]);
        await shot(rw, "12g-download-menu.png");
        rw.PaperView.closeMenu();
        await RV.chooseTheme("colour");
        const ok =
          /How this review was done/.test(res.diagrams.process) === !!RV.currentTheme().showTitle &&
          /Concept 1|Query/.test(res.diagrams.search) &&
          res.panelCollapsed && res.printSquare && res.editedRadius && res.unsaved && /Selftest style/.test(res.savedStyle || "") &&
          res.ai.font === "serif" && res.ai.radius === 0 && res.ai.bands === false && res.ai.imagesSent === 1 && res.ai.editorOpen &&
          head.png.startsWith("PNG") && head.jpg === "255,216,255" && head.svg.startsWith("<svg") && head.tikz.startsWith("% ") && head.latex.startsWith("\\documentclass") &&
          Math.abs(res.pngScale - 3) < 0.01 && res.clipTikz.startsWith("% ") && res.clipImage && res.downloadMenu.length === 5;
        if (!ok) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("logged searches: audit trail with the full chain, reopen read-only, refine as #1.1", async () => {
        const d = rv();
        await goStep("search", (x) => x.querySelector("#rv-runs table"));
        const labelsBefore = [...d.querySelectorAll("#rv-runs .run-label")].map((t) => t.textContent);
        // audit trail
        d.querySelector("#rv-runs tr[data-run] td:nth-child(2)").click();
        const layer = await waitFor(() => d.getElementById("audit-layer"), 5000);
        await waitFor(() => layer.querySelectorAll("table.audit tr").length > 1, 5000);
        const outcomes = [...new Set([...layer.querySelectorAll("table.audit td.a-outcome")].map((t) => t.textContent))];
        const searchResults = [...new Set([...layer.querySelectorAll("table.audit tr td:nth-child(5)")].map((t) => t.textContent))];
        const summary = layer.querySelector(".audit-summary").textContent;
        await shot(rw, "12a-audit-trail.png");
        await pick(layer.querySelector("#audit-outcome"), "Not added");
        const notAddedRows = layer.querySelectorAll("table.audit tr").length - 1;
        layer.remove();
        // reopen search #1 read-only
        d.querySelector("#rv-runs .run-query").click();
        await waitFor(() => !d.getElementById("panel-search").hidden && d.body.dataset.readonly === "1", 5000);
        const shownResults = d.querySelectorAll("#results .result").length;
        const fateTags = [...new Set([...d.querySelectorAll("#results .tag")].map((t) => t.textContent).filter((t) => /pool|added|selected/.test(t)))];
        const readOnlyImportHidden = d.getElementById("import-bar").hidden;
        await shot(rw, "12b-search-readonly.png");
        // edit, change the query, run → asked: refinement or new
        d.getElementById("run-edit").click();
        const q0 = d.getElementById("query").value;
        rw.App.panels.search.useQueryText(q0 + " AND exchange");
        d.getElementById("run").click();
        const ask = await waitFor(() => d.getElementById("ask-layer"), 5000);
        const askText = ask.textContent;
        ask.querySelector('[data-choice="refine"]').click();
        await waitFor(() => !d.getElementById("run").disabled && /papers found|failed/.test(d.getElementById("search-status").textContent), 120000);
        d.getElementById("import").click();
        await waitFor(() => /screening pool|Adding failed/.test(d.getElementById("search-status").textContent), 60000);
        const p = await ZR.Projects.get(libraryID, reviewProject.id);
        rw.App.showTab("review");
        await goStep("search", (x) => x.querySelectorAll("#rv-runs .run-label").length === 2);
        const labelsAfter = [...d.querySelectorAll("#rv-runs .run-label")].map((t) => t.textContent);
        await shot(rw, "12c-search-versions.png");
        // search terms have their own colours
        await goStep("screen", (x) => x.querySelector("#queue-filter"));
        d.getElementById("queue-filter").value = "all";
        d.getElementById("queue-filter").dispatchEvent(new rw.Event("change"));
        const huesNow = () => [...new Set([...d.querySelectorAll("#screen-card .kw, #screen-card .kw-chip")].map((k) => k.style.getPropertyValue("--kw-h")).filter(Boolean))];
        let hues = [];
        for (const item of [...d.querySelectorAll("#queue .q-item")].slice(0, 15)) {
          d.querySelector(`#queue .q-item[data-key="${item.dataset.key}"]`)?.click();
          await U.sleep(80);
          if ((hues = huesNow()).length >= 2) break;
        }
        const res = { labelsBefore, outcomes, searchResults, summary: summary.slice(0, 160), notAddedRows, shownResults, fateTags, readOnlyImportHidden, askText: askText.slice(0, 80), refinementParent: p.runs[1]?.parent === p.runs[0]?.id, labelsAfter, hues };
        if (!outcomes.some((o) => /^Excluded/.test(o)) || !outcomes.some((o) => /^(Passed|Included)/.test(o)) || !shownResults || !readOnlyImportHidden || !res.refinementParent || labelsAfter.join() !== "#1,↳ #1.1" || hues.length < 2) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("full text: the AI annotates the PDF (real Zotero annotations), your tagged annotations sync back", async () => {
        const d = rv();
        // A paper with a two-page PDF that has a real text layer
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", "IFC 5 development: an annotated test paper");
        paper.setField("abstractNote", "We examine whether the development of IFC 5 has progressed. The schema moved to a modular JSON-based format. Some parts of the work have stalled.");
        paper.addToCollection(reviewCol.id);
        await paper.saveTx();
        const pdfPath = PathUtils.join(outDir, "annotation-test.pdf");
        await IOUtils.writeUTF8(
          pdfPath,
          simplePDF([
            [
              "IFC 5 development: an annotated test paper",
              "This study reviews the development of IFC 5 between 2022 and 2025.",
              "The new schema replaces the monolithic model with modular JSON components.",
              "Three software vendors implemented prototype exporters for the new format.",
            ],
            [
              "The working group reported no releases during the last six months.",
              "This paper is an opinion piece and does not present empirical data.",
              "Further evaluation of data exchange quality remains necessary.",
            ],
          ])
        );
        const att = await Zotero.Attachments.importFromFile({ file: pdfPath, parentItemID: paper.id });
        await ZR.Store.decide({ libraryID, item: paper, stage: "ta", d: "include", by: "me", collectionKey: reviewCol.key });
        await rw.App.panels.review.refresh();
        await goStep("fulltext", (x) => x.querySelector("#screen-card .paper-card, #screen-card .empty-state"));
        const cand = rw.App.panels.review.candidates.find((c) => c.itemID === paper.id);
        d.querySelector(`#queue .q-item[data-key="${cand.key}"]`).click();
        await waitFor(() => d.querySelector("#screen-card .anno-box .anno-ai"), 5000);
        const order = [...d.querySelector("#screen-card .paper-card").children].map((n) => n.className.split(" ")[0]);
        rw.App.status("review", "");
        d.querySelector("#screen-card .anno-ai").click();
        await waitFor(() => /The AI added \d+ annotation|Annotating failed/.test(rvStatus()), 120000);
        const status = rvStatus();
        const bot = att.getAnnotations();
        const botView = bot.map((a) => ({ author: a.annotationAuthorName, tags: a.getTags().map((t) => t.tag), color: a.annotationColor, page: a.annotationPageLabel, rects: JSON.parse(a.annotationPosition).rects.length, text: a.annotationText.slice(0, 40) }));
        // Your own annotation, tagged in Zotero: shows up with the human marker
        const doc = await ZR.FullText.documentOf(att);
        await ZR.FullText.saveAnnotation(att, doc, { quote: "Further evaluation of data exchange quality remains necessary.", kind: null, comment: "my own note", author: "" });
        const human = att.getAnnotations().find((a) => !a.annotationAuthorName);
        human.addTag("Exclude");
        await human.saveTx();
        await waitFor(() => d.querySelectorAll("#screen-card .anno-row").length === bot.length + 1, 10000);
        const rows = [...d.querySelectorAll("#screen-card .anno-row")].map((r) => [r.querySelector(".anno-who").textContent, r.className.replace("anno-row ", "")]);
        await shot(rw, "11d-fulltext-annotations.png");
        // Changing the verdict in the list writes the tag and the colour to the annotation
        d.querySelector(`#screen-card .anno-row[data-key="${human.key}"] .kind-btn.include`).click();
        await waitFor(() => Zotero.Items.getByLibraryAndKey(libraryID, human.key).getTags().some((t) => t.tag === "include"), 5000);
        const changed = Zotero.Items.getByLibraryAndKey(libraryID, human.key);
        // Clicking an annotation opens the PDF there; the reader has the Review button
        d.querySelector(`#screen-card .anno-row[data-key="${human.key}"] .anno-main`).click();
        const reader = await waitFor(() => Zotero.Reader._readers.find((r) => r.itemID === att.id), 20000);
        const toolbarButton = await waitFor(() => reader._iframeWindow?.document.getElementById("zr-reader-btn"), 20000).catch(() => null);
        await U.sleep(1500);
        await shot(win, "11e-reader.png");
        win.Zotero_Tabs.close(reader.tabID);
        const res = {
          order: order.slice(0, 5),
          status,
          bot: botView,
          rows,
          changed: { tags: changed.getTags().map((t) => t.tag), color: changed.annotationColor },
          readerOpened: !!reader,
          toolbarButton: toolbarButton?.textContent || null,
        };
        const kinds = botView.map((b) => b.tags[0]).sort().join(",");
        if (bot.length !== 3 || kinds !== "exclude,include,maybe" || botView.some((b) => b.author !== "Bot" || !b.rects) || rows.filter((r) => r[0] === "👤").length !== 1 || !rows.some((r) => r[1] === "k-exclude" && r[0] === "👤") || changed.annotationColor !== "#5fb236" || !toolbarButton) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("projects share a collection: papers reused, decisions kept apart, project tags, tag tree in Zotero's tag pane", async () => {
        const d = rv();
        const A = await ZR.Projects.get(libraryID, reviewProject.id);
        await pick(d.getElementById("project-select"), "New project");
        await waitFor(() => !d.getElementById("np-layer").hidden, 5000);
        const other = d.getElementById("np-col-other");
        d.getElementById("np-name").value = "IFC review B";
        d.querySelector('input[name="np-kind"][value="review"]').checked = true;
        other.value = reviewCol.key;
        other.dispatchEvent(new rw.Event("change"));
        const note = d.getElementById("np-other-note").textContent;
        const chosen = d.querySelector('input[name="np-col"]:checked').value;
        await shot(rw, "08b-new-project-shared.png");
        d.getElementById("np-create").click();
        await waitFor(() => rw.App.project?.name === "IFC review B", 15000);
        const B = rw.App.project;
        const candsA = await ZR.Projects.candidates(libraryID, A);
        const candsB = await ZR.Projects.candidates(libraryID, B);
        const incA = candsA.filter((c) => c.itemID && c.ta === "include");
        const untaggedBefore = incA.filter((c) => !Zotero.Items.get(c.itemID).hasTag(A.tag)).map((c) => `${c.title.slice(0, 40)} (by ${c.taInfo?.by || "?"})`);
        // include in B a paper that A excluded: the Zotero item is reused and tagged for B; A keeps its decision
        const target = candsB.find((c) => c.itemID && candsA.find((a) => a.key === c.key)?.ta === "exclude") || candsB.find((c) => c.itemID);
        await rw.App.panels.review.refresh();
        await rw.App.panels.review.api.decideByKey(target.key, "ta", "include", "", "me");
        const item = Zotero.Items.get(target.itemID);
        const hashTags = item.getTags().map((t) => t.tag).filter((t) => t.startsWith("#"));
        const aBefore = candsA.find((a) => a.key === target.key)?.ta || null;
        const aAfter = (await ZR.Store.prior(libraryID, { key: target.key, item, collectionKey: ZR.Projects.reviewKey(A) }))?.ta?.d || null;
        const bAfter = (await ZR.Store.prior(libraryID, { key: target.key, item, collectionKey: ZR.Projects.reviewKey(B) }))?.ta?.d || null;
        // the tag tree in Zotero's tag pane
        const mdoc = win.document;
        await zp.collectionsView.selectCollection(reviewCol.id);
        await U.sleep(800);
        const tabs = [...mdoc.querySelectorAll("#zr-tagtabs button")].map((b) => b.textContent);
        mdoc.querySelector('#zr-tagtabs button[data-mode="tree"]').click();
        const reviewRow = await waitFor(() => mdoc.querySelector('#zr-tagtree .zr-tt-row[data-path="#review"]'), 8000);
        if (reviewRow.getAttribute("aria-expanded") !== "true") reviewRow.querySelector(".zr-tt-twisty").click();
        const child = await waitFor(() => mdoc.querySelector(`#zr-tagtree .zr-tt-row[data-path="${B.tag}"]`), 5000);
        const rows = [...mdoc.querySelectorAll("#zr-tagtree .zr-tt-row")].map((r) => r.dataset.path);
        child.querySelector(".zr-tt-label").click();
        await waitFor(() => zp.tagSelector.getTagSelection().has(B.tag), 5000);
        await waitFor(() => zp.itemsView.rowCount === 1, 5000).catch(() => null);
        const shown = zp.itemsView.rowCount;
        const selectedRow = !!mdoc.querySelector(`#zr-tagtree .zr-tt-row.selected[data-path="${B.tag}"]`);
        const filterVisible = !!mdoc.querySelector(".tag-selector-filter-container")?.getClientRects().length;
        await shot(win, "16-tag-tree.png");
        mdoc.querySelector(`#zr-tagtree .zr-tt-row[data-path="${B.tag}"] .zr-tt-label`).click();
        await waitFor(() => !zp.tagSelector.getTagSelection().has(B.tag), 5000);
        mdoc.querySelector('#zr-tagtabs button[data-mode="list"]').click();
        const listBack = !!mdoc.querySelector(".tag-selector-list-container")?.getClientRects().length;
        await rw.App.switchProject(reviewProject.id);
        await waitFor(() => incA.every((c) => Zotero.Items.get(c.itemID).hasTag(A.tag)), 5000).catch(() => null);
        const taggedA = incA.filter((c) => Zotero.Items.get(c.itemID).hasTag(A.tag)).length;
        const res = {
          untaggedBefore,
          chosen,
          note,
          decisionKey: B.decisionKey,
          collectionShared: B.collectionKey === reviewCol.key,
          tags: { A: A.tag, B: B.tag },
          itemsA: candsA.filter((c) => c.itemID).length,
          itemsB: candsB.filter((c) => c.itemID).length,
          decidedInB: candsB.filter((c) => c.ta).length,
          includedA: incA.length,
          taggedA,
          reused: { title: target.title.slice(0, 50), hashTags, aBefore, aAfter, bAfter },
          tabs,
          rows,
          selectedRow,
          shown,
          filterVisible,
          listBack,
        };
        const ok =
          chosen === "other" && /Shared with project/.test(note) && /^p:/.test(B.decisionKey || "") && res.collectionShared && res.itemsB === res.itemsA && res.itemsB > 0 && res.decidedInB === 0 &&
          incA.length > 0 && taggedA === incA.length && hashTags.includes(B.tag) && aAfter === aBefore && bAfter === "include" &&
          rows.includes("#review") && rows.includes(B.tag) && selectedRow && shown === 1 && filterVisible && listBack;
        if (!ok) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("full text: papers without PDF greyed out until found; a job per crawler with pause, resume, stop; crawler calls in the Log", async () => {
        const d = rv();
        const R = rw.App.panels.review;
        await goStep("fulltext", (x) => x.querySelector("#queue .q-item"));
        // papers waiting for a PDF: three without a full-text decision (restored at the end);
        // one of them keeps a link the search found, so an open-access strategy can find it again
        const pop = R.api.population().filter((c) => c.itemID);
        const withLink = pop.filter((c) => c.record?.pdfURLs?.length || /arxiv/i.test(c.record?.sources?.join(" ") || ""));
        const victims = [...new Set([...withLink.slice(0, 1), ...pop])].slice(0, 3);
        const ftBefore = victims.map((c) => ({ key: c.key, d: c.ft, r: c.reason, by: c.ftInfo?.by || "me" }));
        for (const c of victims) {
          if (c.ft) await R.api.decideByKey(c.key, "ft", null, "", "me");
          for (const id of Zotero.Items.get(c.itemID).getAttachments()) {
            const a = Zotero.Items.get(id);
            if (a?.isPDFAttachment()) await a.eraseTx();
          }
        }
        // including a pool paper with “Download PDFs” on starts a background download job
        const proj = rw.App.project;
        const hadPDFs = proj.search?.attachPDFs;
        proj.search = Object.assign({}, proj.search, { attachPDFs: true });
        const poolPaper = R.api.candidates().find((c) => !c.itemID && !c.ta);
        if (poolPaper) await R.api.decideByKey(poolPaper.key, "ta", "include", "", "me");
        proj.search.attachPDFs = hadPDFs;
        await R.refresh();
        await R.go("fulltext");
        d.getElementById("queue-filter").value = "all";
        d.getElementById("queue-filter").dispatchEvent(new rw.Event("change"));
        await waitFor(() => d.querySelectorAll("#queue .q-item.no-pdf").length >= victims.length, 5000);
        const greyed = [...d.querySelectorAll("#queue .q-item.no-pdf")].map((x) => x.dataset.key);
        // a slow crawler: pause it, resume it, stop it; then the open-access sources run
        mockLLM.crawlerDelay = 1500;
        const hunting = R.api.huntPDFs(["crawler:firecrawl", "oa"]);
        const crawler = await waitFor(() => ZR.Jobs.running().find((j) => j.kind === "crawler" && j.state === "running"), 8000);
        const queued = ZR.Jobs.running().find((j) => j.state === "queued")?.label || "";
        await waitFor(() => d.querySelector(`#rv-jobs .job-pill[data-job="${crawler.id}"]`), 3000);
        const pill = d.querySelector(`#rv-jobs .job-pill[data-job="${crawler.id}"]`).textContent;
        ZR.Jobs.pause(crawler.id);
        pill && d.querySelector(`#rv-jobs .job-pill[data-job="${crawler.id}"]`).click();
        await waitFor(() => d.getElementById("jobs-pop"), 3000);
        await U.sleep(2200);
        const doneWhilePaused = crawler.done;
        const pausedState = crawler.state;
        await U.sleep(1600);
        const stillPaused = crawler.done === doneWhilePaused && crawler.state === "paused";
        await shot(rw, "11f-jobs.png");
        d.querySelector(`#jobs-pop .job-row[data-job="${crawler.id}"] .ap-icon[title="Resume"]`)?.click();
        await waitFor(() => crawler.state === "running", 3000);
        d.querySelector(`#jobs-pop .job-row[data-job="${crawler.id}"] .ap-icon.danger`).click();
        await hunting;
        mockLLM.crawlerDelay = 0;
        const oa = ZR.Jobs.list().find((j) => j.label.startsWith("Open-access") && j.started >= crawler.started);
        await waitFor(() => d.querySelectorAll("#queue .q-item.no-pdf").length < greyed.length, 8000).catch(() => null);
        const greyedAfter = [...d.querySelectorAll("#queue .q-item.no-pdf")].map((x) => x.dataset.key);
        const crawlerLog = ZR.Activity.list().filter((e) => e.kind === "crawler").map((e) => e.label.slice(0, 60));
        d.getElementById("jobs-pop")?.remove();
        const nullShown = /\bnull\b/.test(d.getElementById("rv-jobs").textContent);
        for (const b of ftBefore) if (b.d) await R.api.decideByKey(b.key, "ft", b.d, b.r, b.by);
        await R.refresh();
        const res = { greyed: greyed.length, victims: victims.length, queued, pill, pausedState, stillPaused, crawler: { state: crawler.state, done: crawler.done, total: crawler.total }, oa: oa && { state: oa.state, found: oa.found, total: oa.total }, greyedAfter: greyedAfter.length, crawlerLog };
        res.nullShown = nullShown;
        const bg = ZR.Jobs.list().find((j) => /background/.test(j.label));
        if (poolPaper) await R.api.decideByKey(poolPaper.key, "ta", null, "", "me");
        res.background = bg && { state: bg.state, done: bg.done, total: bg.total, found: bg.found };
        const ok = (!poolPaper || (!!bg && bg.total > 0)) && !nullShown && greyed.length >= victims.length && /Open-access/.test(queued) && pausedState === "paused" && stillPaused && crawler.state === "stopped" && crawler.done < crawler.total && oa && ["done", "skipped"].includes(oa.state) && crawlerLog.length > 0 && (!oa.found || greyedAfter.length < greyed.length);
        if (!ok) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("searches that stopped early: “In pool” turns yellow, details per database, the rest is fetched from where it stopped", async () => {
        const d = rv();
        const R = rw.App.panels.review;
        await rw.App.switchProject(reviewProject.id);
        rw.App.showTab("review");
        await waitFor(() => d.getElementById("rv-funnel")?.textContent, 5000);
        // the review's first search asked for 5 per database, so most databases have more
        const yellow = await waitFor(() => d.getElementById("rv-incomplete"), 5000);
        const colour = rw.getComputedStyle(yellow).backgroundColor;
        const plain = rw.getComputedStyle(d.querySelector("#rv-funnel .funnel-stage:not(.incomplete)")).backgroundColor;
        yellow.click();
        const layer = await waitFor(() => d.getElementById("inc-layer"), 3000);
        const rows = [...layer.querySelectorAll("tr[data-source]")].map((r) => ({ source: r.dataset.source, run: r.dataset.run, text: r.textContent.replace(/\s+/g, " ").slice(0, 110) }));
        await shot(rw, "12h-incomplete.png");
        layer.remove();
        // fetch 5 more of one database: the search goes on from result 6, nothing twice
        const pick = R.api.incomplete().find((x) => x.pos && x.reason === "limit" && x.source !== "crossref") || R.api.incomplete().find((x) => x.pos);
        const before = (await ZR.Projects.get(libraryID, reviewProject.id)).runs.length;
        const res0 = await R.api.fetchRest(pick.runID, [pick.source], { limit: 5 });
        const p = await ZR.Projects.get(libraryID, reviewProject.id);
        const cont = p.runs.at(-1);
        const orig = p.runs.find((r) => r.id === pick.runID);
        const res = {
          colour,
          rows,
          picked: { source: pick.source, fetched: pick.fetched, total: pick.total, pos: pick.pos },
          newRun: { continues: cont.continues, count: cont.perSource?.[pick.source]?.count, pos: cont.perSource?.[pick.source]?.pos || null, identified: cont.identified },
          originalDone: orig.perSource[pick.source].done === cont.id,
          runsAdded: p.runs.length - before,
          addedToPool: res0?.pool?.added,
          label: [...d.querySelectorAll("#rv-runs td")].map((t) => t.textContent).find((t) => /^rest of/.test(t)) || "",
        };
        await R.go("search");
        res.label = [...d.querySelectorAll("#rv-runs td")].map((t) => t.textContent).find((t) => /^rest of/.test(t)) || "";
        const posOK = !res.newRun.pos || (res.newRun.pos.offset ?? 0) === (pick.pos.offset ?? 0) + res.newRun.count || !!res.newRun.pos.branches;
        if (!rows.length || colour === plain || res.newRun.continues !== pick.runID || !res.originalDone || res.runsAdded !== 1 || !res.newRun.count || !posOK || !/^rest of #1/.test(res.label)) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("autopilot: Stop now cancels a running AI call at once; Resume restarts the step", async () => {
        const col = new Zotero.Collection({ name: "zr-stop", libraryID });
        await col.saveTx();
        const proj = await ZR.Projects.create(libraryID, { name: "Stop test", kind: "review", collectionKey: col.key, methodology: "prisma2020" });
        await zp.collectionsView.selectCollection(col.id);
        await U.sleep(300);
        const sw = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = sw.document;
        mockLLM.delayMs = 60000; // the AI takes "forever"
        sw.App.showTab("review");
        await waitFor(() => sw.App.project?.id === proj.id, 5000);
        sw.Autopilot.start({ profileID: "mock", question: "How is IFC used for BIM data exchange?", stage: "protocol" });
        const running = await waitFor(() => ZR.Activity.running().find((e) => /mock-llm/.test(e.label)), 15000);
        const stopButton = await waitFor(() => !d.getElementById("ap-stop").hidden && d.getElementById("ap-stop"), 5000);
        await shot(sw, "13d-autopilot-stopping.png");
        const t0 = Date.now();
        stopButton.click();
        await waitFor(() => [...d.querySelectorAll("#ap-log .ap-msg")].some((m) => /Stopped during/.test(m.textContent)), 10000);
        const stoppedMs = Date.now() - t0;
        const stillRunning = ZR.Activity.running().filter((e) => /mock-llm/.test(e.label)).length;
        const afterStop = { stage: sw.App.project.autopilot.stage, on: sw.App.project.autopilot.on, resumeVisible: d.getElementById("ap-toggle").title === "Resume", protocolFilled: !!sw.App.project.protocol?.inclusion?.length };
        // resume: the same step runs again, now with a responsive AI
        mockLLM.delayMs = 0;
        d.getElementById("ap-toggle").click();
        const askLine = await waitFor(() => d.querySelector('#ap-prompt [data-choice="go"]') && d.querySelector("#ap-prompt .ap-ask-line").textContent, 30000);
        d.querySelector('#ap-prompt [data-choice="pause"]').click();
        await waitFor(() => !sw.Autopilot.isRunning(), 10000);
        sw.close();
        const res = { cancelledCall: running.label.slice(0, 60), stoppedMs, stillRunning, afterStop, resumedTo: askLine.slice(0, 60) };
        if (stoppedMs > 5000 || stillRunning || afterStop.stage !== "protocol" || !afterStop.on || !afterStop.resumeVisible || afterStop.protocolFilled || !/protocol/i.test(askLine)) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("layout: header and footer lines match Zotero's main window; autopilot controls; rows; delete a project", async () => {
        const proj = (await ZR.Projects.list(libraryID)).find((p) => p.name === "Stop test");
        const col = Zotero.Collections.getByLibraryAndKey(libraryID, proj.collectionKey);
        await zp.collectionsView.selectCollection(col.id);
        await U.sleep(300);
        const lw2 = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = lw2.document;
        lw2.App.showTab("review");
        await waitFor(() => d.getElementById("rv-funnel")?.offsetHeight, 5000);
        lw2.App.syncLayout();
        await U.sleep(200);
        // measured from the window's outer edges, like two windows side by side
        const fromTop = (w, rect) => w.mozInnerScreenY - w.screenY + rect.bottom;
        const fromBottom = (w, y) => w.screenY + w.outerHeight - (w.mozInnerScreenY + y);
        const mdoc = win.document;
        const tabs = mdoc.getElementById("tab-bar-container") || mdoc.getElementById("zotero-title-bar");
        const headerDiff = Math.abs(fromTop(win, tabs.getBoundingClientRect()) - fromTop(lw2, d.querySelector("header.top").getBoundingClientRect()));
        const filter = mdoc.querySelector(".tag-selector-filter-container");
        const status = d.querySelector("#panel-review .statusbar");
        const footerDiff = filter?.getBoundingClientRect().height ? Math.abs(fromBottom(win, filter.getBoundingClientRect().top) - fromBottom(lw2, status.getBoundingClientRect().top)) : null;
        // autopilot panel: its header ends with the subheader; collapse / expand
        await lw2.Autopilot.show();
        await U.sleep(200);
        const apDiff = Math.abs(d.querySelector("#ap-panel .ap-head").getBoundingClientRect().bottom - d.getElementById("rv-funnel").getBoundingClientRect().bottom);
        const gapToFooter = Math.round(d.querySelector("#panel-review .statusbar").getBoundingClientRect().top - d.getElementById("ap-panel").getBoundingClientRect().bottom);
        // the footer line runs under the panel, to the window edge
        const footerToEdge = Math.round(lw2.innerWidth - status.getBoundingClientRect().right);
        // Zotero's grey: header, footer, subheader and the panel's header
        const bg = (node) => lw2.getComputedStyle(node).backgroundColor;
        const colours = { zotero: win.getComputedStyle(mdoc.documentElement).getPropertyValue("--material-sidepane").trim(), header: bg(d.querySelector("header.top")), footer: bg(status), subheader: bg(d.getElementById("rv-funnel")), apHead: bg(d.querySelector("#ap-panel .ap-head")) };
        await lw2.App.panels.review.go("protocol");
        colours.protocolCard = bg(d.querySelector("#rv-protocol .card"));
        colours.page = bg(d.body);
        const icons = ["help", "open-prefs"].map((id) => {
          const b = d.getElementById(id);
          return { svg: b.querySelector("svg")?.getBoundingClientRect().width, border: lw2.getComputedStyle(b).borderTopWidth, text: b.textContent.trim() };
        });
        // no model line in the header; a click on "Autopilot" shows it as details
        const subtitle = !!d.getElementById("ap-model");
        d.getElementById("ap-title").click();
        const info = (await waitFor(() => d.getElementById("ap-pop"), 3000)).textContent;
        await shot(lw2, "14a-layout-autopilot.png");
        d.getElementById("ap-title").click();
        const infoClosed = !d.getElementById("ap-pop");
        const centre = (node) => Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2);
        const toggleY = centre(d.getElementById("ap-collapse"));
        d.getElementById("ap-collapse").click();
        await U.sleep(150);
        const collapsedWidth = Math.round(d.getElementById("ap-panel").getBoundingClientRect().width);
        const collapsed = { playShown: !!d.getElementById("ap-toggle").getClientRects().length, historyShown: !!d.getElementById("ap-history").getClientRects().length, toggleMoved: centre(d.getElementById("ap-collapse")) - toggleY };
        // the collapsed strip continues the subheader line; Log sits centred under it
        lw2.App.syncLayout();
        await U.sleep(100);
        const headLine = lw2.getComputedStyle(d.querySelector("#ap-panel .ap-head"));
        collapsed.line = headLine.borderBottomWidth + " " + headLine.borderBottomColor;
        collapsed.lineEndsWithSubheader = Math.abs(d.querySelector("#ap-panel .ap-head").getBoundingClientRect().bottom - d.getElementById("rv-funnel").getBoundingClientRect().bottom) <= 1;
        const logR = d.querySelector("#panel-review > .statusbar .log-btn").getBoundingClientRect();
        const apR = d.getElementById("ap-panel").getBoundingClientRect();
        collapsed.logOffCentre = Math.round((logR.left + logR.right) / 2 - (apR.left + apR.right) / 2);
        // lines in Zotero's colour (not the text colour)
        const zLine = win.getComputedStyle(mdoc.querySelector(".tag-selector-filter-container") || mdoc.documentElement);
        collapsed.lines = { zotero: parseFloat(zLine.borderTopWidth) > 0 ? zLine.borderTopColor : "(none measured)", subheader: lw2.getComputedStyle(d.getElementById("rv-funnel")).borderBottomColor, header: lw2.getComputedStyle(d.querySelector("header.top")).borderBottomColor, text: lw2.getComputedStyle(d.body).color };
        // no Autopilot button in the subheader any more
        collapsed.subheaderButton = !!d.getElementById("ap-open");
        await shot(lw2, "14b-autopilot-collapsed.png");
        d.getElementById("ap-collapse").click();
        await U.sleep(150);
        const expandedWidth = Math.round(d.getElementById("ap-panel").getBoundingClientRect().width);
        const toggleTitle = d.getElementById("ap-toggle").title;
        lw2.Autopilot.hide();
        // alternating rows in the screening list
        const rv2 = await ZR.Projects.list(libraryID).then((l) => l.find((p) => p.name === "IFC review"));
        const bgs = [];
        const filterColours = [];
        if (rv2) {
          await lw2.App.switchProject(rv2.id);
          lw2.App.showTab("review");
          await waitFor(() => d.querySelector('#rv-steps button[data-step="screen"]'), 5000);
          d.querySelector('#rv-steps button[data-step="screen"]').click();
          d.getElementById("queue-filter").value = "all";
          d.getElementById("queue-filter").dispatchEvent(new lw2.Event("change"));
          await waitFor(() => d.querySelectorAll("#queue .q-item").length > 3, 5000);
          const items = d.querySelectorAll("#queue .q-item");
          bgs.push(lw2.getComputedStyle(items[1]).backgroundColor, lw2.getComputedStyle(items[2]).backgroundColor);
          // the filter shows the decisions in their colours; a line under the list header
          d.getElementById("queue-filter").zrDropdownButton.click();
          const menuItems = await waitFor(() => d.querySelectorAll(".zr-dd-menu .zr-dd-item").length && [...d.querySelectorAll(".zr-dd-menu .zr-dd-item")], 3000);
          filterColours.push(...menuItems.map((x) => lw2.getComputedStyle(x).color));
          await shot(lw2, "14f-filter-colours.png");
          lw2.ZRDropdown.close();
          filterColours.push(lw2.getComputedStyle(d.querySelector(".queue-head")).borderBottomWidth);
          await shot(lw2, "14c-rows.png");
          await lw2.App.switchProject(proj.id);
        }
        // delete the project: right-click on the project, red trash can
        const ddButton = d.getElementById("project-select").zrDropdownButton;
        const r = ddButton.getBoundingClientRect();
        ddButton.dispatchEvent(new lw2.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom }));
        const onButton = (await waitFor(() => d.getElementById("ctx-delete-project"), 3000)).textContent;
        // Info: where the project adds papers (no longer a line under the project name)
        d.getElementById("ctx-project-info").click();
        const projectInfo = (await waitFor(() => d.getElementById("project-info"), 3000)).textContent;
        await shot(lw2, "14e-project-info.png");
        d.getElementById("project-info").remove();
        const targetLineShown = !!d.getElementById("target").getClientRects().length;
        lw2.PaperView.closeMenu();
        ddButton.click();
        const entry = await waitFor(() => d.querySelector(`.zr-dd-menu .zr-dd-item[data-value="${proj.id}"]`), 3000);
        entry.dispatchEvent(new lw2.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom + 40 }));
        const del = await waitFor(() => d.getElementById("ctx-delete-project"), 3000);
        const deleteItem = { onButton, text: del.textContent, red: /\b(210|240), (59|107)/.test(lw2.getComputedStyle(del).color), icon: !!del.querySelector("svg"), listOpen: !!d.querySelector(".zr-dd-menu"), newProject: !!d.getElementById("ctx-new-project") };
        await shot(lw2, "14d-delete-menu.png");
        del.click();
        const ask = await waitFor(() => d.getElementById("ask-layer"), 5000);
        const askText = ask.textContent.slice(0, 90);
        const redButton = ask.querySelector('[data-choice="delete"]');
        lw2.InspectorUtils?.addPseudoClassLock(redButton, ":hover");
        deleteItem.hoverBackground = lw2.getComputedStyle(redButton).backgroundColor;
        lw2.InspectorUtils?.removePseudoClassLock(redButton, ":hover");
        ask.querySelector('[data-choice="delete"]').click();
        await waitFor(async () => !(await ZR.Projects.get(libraryID, proj.id)), 5000);
        const poolFile = PathUtils.join(Zotero.DataDirectory.dir, "zotero-researcher", "projects", `L${libraryID}-${proj.id}.json`);
        const res = {
          headerDiff,
          footerDiff,
          apDiff,
          gapToFooter,
          collapsedWidth,
          expandedWidth,
          toggleTitle,
          rowColours: bgs,
          filterColours,
          askText,
          deleted: !(await ZR.Projects.get(libraryID, proj.id)),
          poolFileGone: !(await IOUtils.exists(poolFile)),
          collectionKept: !!Zotero.Collections.getByLibraryAndKey(libraryID, proj.collectionKey),
          selectOptions: [...d.querySelectorAll("#project-select option")].map((o) => o.textContent).filter((t) => /Stop test/.test(t)).length,
          deleteOption: [...d.querySelectorAll("#project-select option")].some((o) => /Delete/.test(o.textContent)),
          deleteItem,
          projectInfo: projectInfo.slice(0, 140),
          targetLineShown,
          footerToEdge,
          colours,
          icons,
          subtitle,
          info: info.slice(0, 120),
          infoClosed,
          collapsed,
        };
        lw2.close();
        if (headerDiff > 2 || (footerDiff != null && footerDiff > 2) || apDiff > 1 || gapToFooter < 4 || collapsedWidth > 60 || expandedWidth < 300 || (bgs.length && bgs[0] === bgs[1]) || !res.deleted || !res.poolFileGone || !res.collectionKept || res.selectOptions || res.deleteOption || targetLineShown || !/Adds papers to/.test(projectInfo) || !/zr-stop/.test(projectInfo) || !deleteItem.red || !deleteItem.icon || !deleteItem.listOpen || !deleteItem.newProject || !/\b(210|240), (59|107)/.test(deleteItem.hoverBackground || "") || Math.abs(footerToEdge) > 1 || colours.footer !== colours.header || colours.apHead !== colours.header || colours.subheader !== colours.header || colours.protocolCard !== colours.header || colours.footer === colours.page || icons.some((i) => i.svg < 20 || i.border !== "0px" || i.text) || subtitle || !/Harness/.test(info) || !infoClosed || collapsed.playShown || collapsed.historyShown || Math.abs(collapsed.toggleMoved) > 1 || !collapsed.line.startsWith("1px") || !collapsed.lineEndsWithSubheader || Math.abs(collapsed.logOffCentre) > 2 || collapsed.lines.subheader === collapsed.lines.text || (collapsed.lines.zotero !== "(none measured)" && collapsed.lines.subheader !== collapsed.lines.zotero) || collapsed.subheaderButton || (filterColours.length && (new Set(filterColours.slice(1, 4)).size !== 3 || filterColours.at(-1) !== "1px"))) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("autopilot: an AI runs a new review end to end, asking at every decision", async () => {
        const aw = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = aw.document;
        // project wizard with the autopilot switched on
        await pick(d.getElementById("project-select"), "New project");
        await waitFor(() => !d.getElementById("np-layer").hidden, 5000);
        d.getElementById("np-name").value = "Autopilot review";
        d.querySelector('input[name="np-kind"][value="review"]').click();
        d.querySelector('input[name="np-col"][value="new"]').checked = true;
        await waitFor(() => !d.getElementById("np-ap").hidden, 3000);
        d.getElementById("np-ap-on").click();
        d.getElementById("np-ap-question").value = "How is IFC used for BIM data exchange between authoring tools, and what problems are reported?";
        d.getElementById("np-create").click();
        await waitFor(() => d.getElementById("ap-panel") && !d.getElementById("ap-panel").hidden, 10000);
        // answer like a user: accept proposals, run the search with a small limit, apply changes
        const prompts = [];
        const prefer = ["go", "apply", "yes", "harness", "do", "save", "fulltext"];
        const t0 = Date.now();
        let shotTaken = false;
        while (Date.now() - t0 < 420000) {
          const p = aw.App.project;
          if (p?.autopilot?.finished) break;
          const plan = d.getElementById("ap-search-layer");
          if (plan) {
            prompts.push("search plan: " + [...plan.querySelectorAll(".ap-sources input:checked")].map((i) => i.value).join(",") + ` · pdfs ${plan.querySelector("#ap-s-pdfs").checked} · languages ${plan.querySelectorAll("#ap-s-langs .pick").length} · types ${plan.querySelectorAll("#ap-s-types .pick").length} · options ${plan.querySelectorAll(".ap-check input").length}`);
            if (!shotTaken) {
              await shot(aw, "13a-autopilot-search-plan.png");
              shotTaken = true;
            }
            plan.querySelector("#ap-s-limit").value = "5";
            plan.querySelector("#ap-s-run").click();
            await U.sleep(300);
            continue;
          }
          const btns = [...d.querySelectorAll("#ap-prompt [data-choice]")];
          if (btns.some((b) => b.dataset.choice === "try")) {
            const line = d.querySelector("#ap-prompt .ap-ask-line").textContent;
            const choice = prompts.some((x) => x.startsWith("missing PDFs")) ? "skip" : "try";
            prompts.push(`missing PDFs: ${line.slice(0, 60)} · strategies ${d.querySelectorAll("#ap-prompt input[type=checkbox]").length} → ${choice}`);
            if (choice === "try") await shot(aw, "13e-autopilot-missing-pdfs.png");
            btns.find((b) => b.dataset.choice === choice).click();
            await U.sleep(400);
            continue;
          }
          const pickBtn = prefer.map((id) => btns.find((b) => b.dataset.choice === id)).find(Boolean);
          if (/Who reads the full texts/.test(d.querySelector("#ap-prompt").textContent)) prompts.push("full-text model: " + [...d.querySelectorAll("#ap-prompt select")[0].options].map((o) => o.textContent).slice(0, 2).join(" | "));
          if (pickBtn) {
            prompts.push(`${d.querySelector("#ap-prompt .ap-ask-line")?.textContent.slice(0, 70)} → ${pickBtn.dataset.choice}`);
            if (prompts.length === 4) await shot(aw, "13b-autopilot-conversation.png");
            pickBtn.click();
          }
          await U.sleep(400);
        }
        // the conversation: step dividers, structured blocks instead of long sentences
        await shot(aw, "13c-autopilot-done.png");
        const chat = { problems: [] };
        const logBox = d.getElementById("ap-log");
        chat.dividers = [...logBox.querySelectorAll(".ap-stage")].map((x) => x.textContent);
        chat.queryBlocks = logBox.querySelectorAll(".ap-query pre.q-code").length;
        chat.coloured = [...new Set([...logBox.querySelectorAll(".ap-query pre.q-code span")].map((x) => x.className))];
        chat.facts = logBox.querySelectorAll(".ap-facts").length;
        chat.splits = logBox.querySelectorAll(".ap-split").length;
        const DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
        chat.dashes = DASH.test(d.getElementById("ap-panel").textContent);
        // scroll edges fade on the side with more content
        logBox.scrollTop = logBox.scrollHeight;
        logBox.dispatchEvent(new aw.Event("scroll"));
        await U.sleep(50);
        chat.fadeAtBottom = [...logBox.classList].filter((c) => c.startsWith("fade"));
        logBox.scrollTop = 0;
        logBox.dispatchEvent(new aw.Event("scroll"));
        await U.sleep(50);
        chat.fadeAtTop = [...logBox.classList].filter((c) => c.startsWith("fade"));
        // "Show in the protocol" jumps to the query field
        logBox.querySelector(".ap-query .ap-jump")?.click();
        await waitFor(() => d.querySelector('#rv-form .pf-row[data-field="query"].flash'), 5000).catch(() => null);
        chat.jumped = !!d.querySelector('#rv-form .pf-row[data-field="query"].flash') && !d.getElementById("rv-protocol").hidden;
        // right-click on a step: run from here / redo from here
        const stepBtn = (s) => d.querySelector(`#rv-steps button[data-step="${s}"]`);
        const rightClick = (node) => {
          const r = node.getBoundingClientRect();
          node.dispatchEvent(new aw.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom }));
        };
        rightClick(stepBtn("screen"));
        const menu = await waitFor(() => d.getElementById("ctx-ap-from") && d.querySelector(".ctx-menu"), 3000);
        chat.stepMenu = [...menu.querySelectorAll(".ctx-item")].map((x) => x.textContent);
        await shot(aw, "13f-step-menu.png");
        aw.PaperView.closeMenu();
        // run again from the report step: a new session, the old one is kept
        rightClick(stepBtn("report"));
        (await waitFor(() => d.getElementById("ctx-ap-from"), 3000)).click();
        const noNote = await waitFor(() => d.querySelector('#ap-prompt [data-choice="no"]'), 20000);
        chat.newSession = d.querySelectorAll("#ap-log .ap-msg").length;
        noNote.click();
        await waitFor(() => aw.App.project.autopilot?.finished && !aw.Autopilot.isRunning(), 20000);
        d.getElementById("ap-history").click();
        const pop = await waitFor(() => d.getElementById("ap-pop"), 3000);
        chat.sessions = [...pop.querySelectorAll(".ap-sess")].map((x) => x.textContent.slice(0, 80));
        await shot(aw, "13g-sessions.png");
        pop.querySelector('.ap-sess[data-session^="s"]').click();
        await waitFor(() => d.querySelector("#ap-log .ap-archived"), 3000);
        chat.archivedMessages = d.querySelectorAll("#ap-log .ap-msg").length;
        await shot(aw, "13h-earlier-session.png");
        d.getElementById("ap-back").click();
        await waitFor(() => !d.querySelector("#ap-log .ap-archived"), 3000);
        // analytics of the earlier (full) session: tokens and time per model and step
        d.getElementById("ap-history").click();
        (await waitFor(() => d.querySelector('#ap-pop .ap-sess-info[data-analytics^="s"]'), 3000)).click();
        const an = await waitFor(() => d.getElementById("ap-analytics-layer"), 5000);
        const tables = an.querySelectorAll(".ap-an-table");
        chat.analytics = { facts: an.querySelector(".ap-facts").textContent.replace(/\s+/g, " ").slice(0, 200), models: tables[0] ? tables[0].querySelectorAll("tr").length - 1 : 0, steps: tables[1] ? tables[1].querySelectorAll("tr").length - 1 : 0 };
        await shot(aw, "13i-analytics.png");
        an.remove();
        if (!chat.analytics.models || chat.analytics.steps < 3 || !/Tokens in/.test(chat.analytics.facts)) chat.problems.push("analytics");
        if (chat.dividers.length < 5) chat.problems.push("dividers");
        if (!chat.queryBlocks || !chat.coloured.includes("qk-op")) chat.problems.push("query block");
        if (chat.facts < 3 || chat.splits < 2) chat.problems.push("blocks");
        if (chat.dashes) chat.problems.push("dashes");
        if (!chat.fadeAtBottom.includes("fade-top") || !chat.fadeAtTop.includes("fade-bottom") || chat.fadeAtTop.includes("fade-top")) chat.problems.push("fade");
        if (!chat.jumped) chat.problems.push("jump");
        if (chat.stepMenu.length < 2) chat.problems.push("step menu");
        if (chat.newSession > 4) chat.problems.push("new session");
        if (chat.sessions.length < 2 || chat.archivedMessages < 20) chat.problems.push("sessions");
        const p = aw.App.project;
        const log = [...d.querySelectorAll("#ap-log .ap-msg")].map((m) => m.textContent);
        const cands = await ZR.Projects.candidates(libraryID, p);
        const res = {
          methodology: p.methodology,
          finished: !!p.autopilot?.finished,
          stage: p.autopilot?.stage,
          runs: p.runs.length,
          pool: cands.length,
          screened: cands.filter((c) => c.ta).length,
          passed: cands.filter((c) => c.ta === "include").length,
          thresholdsChanged: p.funnel?.includeAbove === 0.8,
          prompts,
          crawlerCalls: mockLLM.crawlerCalls || 0,
          chat,
          log: log.slice(-6).map((t) => t.slice(0, 120)),
          errors: log.filter((t) => /went wrong/.test(t)),
        };
        aw.close();
        if (!res.prompts.some((x) => /full-text model: Same as the autopilot/.test(x))) chat.problems.push("full-text model question");
        if (!res.finished || res.errors.length || !res.runs || res.screened !== res.pool || !res.thresholdsChanged || chat.problems.length) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("a quick project converts into a review; projects persist across reopening", async () => {
        const d = rv();
        await pick(d.getElementById("project-select"), "zr-selftest");
        await waitFor(() => rw.App.project?.collectionKey === collection.key, 5000);
        rw.App.showTab("review");
        await waitFor(() => !d.getElementById("rv-start").hidden, 5000);
        const offer = d.getElementById("rv-start-btn").textContent;
        const quick = rw.App.project;
        const quickQuery = quick.search.query;
        const quickRuns = quick.runs.length;
        d.getElementById("rv-start-btn").click();
        await waitFor(() => !d.getElementById("rv-main").hidden && !d.getElementById("rv-protocol").hidden, 10000);
        const converted = await ZR.Projects.get(libraryID, quick.id);
        const funnelAfter = d.getElementById("rv-funnel").textContent;
        rw.close();
        rw = null;
        // Reopen on the review collection: the review is still there
        await zp.collectionsView.selectCollection(reviewCol.id);
        await U.sleep(500);
        rw = await openResearch(win, { tab: "find", itemIDs: [] });
        rw.App.showTab("review");
        await waitFor(() => !rv().getElementById("rv-main").hidden && rv().getElementById("rv-funnel").textContent, 10000);
        const reopened = { project: rw.App.project?.name, funnel: rv().getElementById("rv-funnel").textContent, s1Kept: Object.keys((await ZR.Projects.loadPool(libraryID, reviewProject.id)).s1).length };
        const res = { offer, kind: converted.kind, methodology: converted.methodology, queryCarriedOver: converted.protocol.query === (quickQuery || ""), runsKept: converted.runs.length === quickRuns, funnelAfter, reopened };
        if (converted.kind !== "review" || !res.queryCarriedOver || !res.runsKept || reopened.project !== "IFC review") throw new Error(JSON.stringify(res));
        return res;
      });
      rw?.close();
      ZR.Prefs.set("s1Engine", "");
      await ZR.Secrets.set(ZR.System1.keyName, "");
      report.typesafeCalls = tsCalls.length;

      // --- Local model (embeddings on this computer): real Ollama with ZR_E2E_OLLAMA=1, else a mock server
      const realOllama = ZR.Prefs.get("selftestOllama", false);
      report.localModel = realOllama ? "real Ollama" : "mock";
      await step(`local model: Settings finds the server and model (${report.localModel})`, async () => {
        ZR.Embed._reset();
        for (const w of Services.wm.getEnumerator("zotero:pref")) w.close(); // a fresh pane checks the server again
        await U.sleep(300);
        const pw = await openPrefs();
        const d = await waitFor(() => pw.document?.getElementById("zr-local-status") && pw.document, 30000);
        const status = await waitFor(() => {
          const t = d.getElementById("zr-local-status").textContent;
          return /Ready|✗/.test(t) && t;
        }, 60000);
        const engines = [...d.querySelectorAll("#zr-s1-engine option")].map((o) => o.value);
        d.getElementById("zr-local").scrollIntoView();
        await U.sleep(300);
        await screenshot(pw, PathUtils.join(outDir, "13-local-settings.png"));
        pw.close();
        if (!/Ready/.test(status) || !engines.includes("local")) throw new Error(JSON.stringify({ status, engines }));
        return { status, engines };
      });

      const IFC_PAPERS = [
        ["Evaluating IFC-based data exchange between BIM authoring tools", "We test how well Industry Foundation Classes (IFC) files carry geometry and property sets between Revit, ArchiCAD and Tekla, and report losses in the exchange."],
        ["An IFC model view definition for structural analysis data exchange", "This paper proposes an IFC model view definition that enables data exchange between BIM modelling software and structural analysis tools."],
        ["Validating IFC exports against model view definitions", "We present a checker that validates IFC files exported from BIM tools against model view definitions to improve interoperability."],
        ["IFC 4.3 for infrastructure: exchanging road and bridge models", "The paper studies Industry Foundation Classes 4.3 for exchanging infrastructure BIM models between design and construction software."],
        ["Semantic enrichment of IFC models for facility management handover", "Building information models are exchanged as IFC for facility management; we enrich IFC data to reduce information loss at handover."],
        ["Round-trip interoperability of IFC between architectural design tools", "Round-trip tests of IFC import and export between architectural BIM tools reveal where Industry Foundation Classes exchange fails."],
      ];
      const OTHER_PAPERS = [
        ["Deep learning for skin cancer classification from dermoscopy images", "Convolutional neural networks classify melanoma in dermoscopy images with dermatologist-level accuracy."],
        ["Corrosion fatigue of weathering steel in highway bridge girders", "We measure corrosion fatigue crack growth in weathering steel girders exposed to de-icing salts."],
        ["Soil moisture retrieval from Sentinel-1 radar backscatter", "A change detection method estimates soil moisture from Sentinel-1 synthetic aperture radar observations."],
        ["The economics of minimum wage increases in rural labour markets", "Using county data we estimate employment effects of minimum wage increases in rural labour markets."],
        ["Protein folding with attention-based neural networks", "Attention-based networks predict protein structures from amino acid sequences."],
        ["Urban heat islands and tree canopy cover in European cities", "Satellite land surface temperature shows how tree canopy cover reduces urban heat islands."],
      ];
      let lw;
      let localProject;
      let localCol;
      const lwStatus = () => lw.document.getElementById("review-status").textContent;
      await step("local model: System 1 ranks by the protocol, finds a duplicate, learns from your decisions", async () => {
        localCol = new Zotero.Collection({ name: "zr-local", libraryID });
        await localCol.saveTx();
        const protocol = ZR.Methodologies.normalizeProtocol("prisma2020", {
          title: "IFC data exchange",
          questions: ["How is IFC (Industry Foundation Classes) used for data exchange between BIM tools?"],
          inclusion: ["Studies IFC-based data exchange between BIM software"],
          reasons: ["Off topic", "Duplicate"],
        });
        localProject = await ZR.Projects.create(libraryID, { name: "Local model test", kind: "review", collectionKey: localCol.key, methodology: "prisma2020", protocol });
        const rec = (t, a, itemType = "journalArticle") => ZR.Records.make("openalex", { title: t, abstract: a, year: 2022, creators: [{ firstName: "Ada", lastName: "Author" }], itemType });
        const recs = [...IFC_PAPERS.map(([t, a]) => rec(t, a)), ...OTHER_PAPERS.map(([t, a]) => rec(t, a)), rec(IFC_PAPERS[0][0] + " (preprint)", IFC_PAPERS[0][1], "preprint")];
        for (const r of recs) r.key = ZR.Store.keyForRecord(r);
        await ZR.Projects.addToPool(libraryID, localProject.id, recs);
        ZR.Prefs.set("s1Engine", "local");
        await zp.collectionsView.selectCollection(localCol.id);
        await U.sleep(400);
        lw = await openResearch(win, { tab: "find", itemIDs: [] });
        const d = lw.document;
        lw.App.showTab("review");
        await waitFor(() => !d.getElementById("rv-main").hidden && d.querySelector('#rv-steps button[data-step="screen"]'), 15000);
        d.querySelector('#rv-steps button[data-step="screen"]').click();
        await waitFor(() => d.querySelector("#screen-card .paper-card"), 10000);
        const t0 = Date.now();
        d.getElementById("s1-rate").click();
        await waitFor(() => /Rated \d+|Rating failed/.test(lwStatus()), 180000);
        const rateMs = Date.now() - t0;
        const rated = lwStatus();
        await U.sleep(300);
        const pool = await ZR.Projects.loadPool(libraryID, localProject.id);
        const pOf = (title) => pool.s1[ZR.Store.keyForRecord({ title })]?.p ?? null;
        const mean = (list) => list.reduce((a, [t]) => a + (pOf(t) ?? 0), 0) / list.length;
        const cold = { ifc: mean(IFC_PAPERS), other: mean(OTHER_PAPERS), model: Object.values(pool.s1)[0]?.model };
        const dupMarks = d.querySelectorAll("#queue .q-dup").length;
        await shot(lw, "14-local-rated.png");
        // exclude the duplicate (two clicks)
        d.getElementById("dup-find").click();
        d.getElementById("dup-find").click();
        await waitFor(() => /Excluded \d+ duplicate/.test(lwStatus()), 20000);
        const dupStatus = lwStatus();
        // decide by keyboard: top 4 (most likely) include, bottom 3 exclude
        const key = (k) => d.dispatchEvent(new lw.KeyboardEvent("keydown", { key: k, bubbles: true }));
        for (let i = 0; i < 4; i++) {
          key("i");
          await U.sleep(500);
        }
        d.getElementById("queue-sort").value = "p-asc";
        d.getElementById("queue-sort").dispatchEvent(new lw.Event("change"));
        await U.sleep(300);
        for (let i = 0; i < 3; i++) {
          key("e");
          await U.sleep(500);
        }
        await waitFor(() => /Re-ranked \d+ paper\(s\) with what the local model learned from \d+/.test(lwStatus()), 30000);
        const relearned = lwStatus();
        await shot(lw, "15-local-learned.png");
        const pool2 = await ZR.Projects.loadPool(libraryID, localProject.id);
        const cands = await ZR.Projects.candidates(libraryID, localProject);
        const open = cands.filter((c) => !c.ta && pool2.s1[c.key]);
        const isIFC = (c) => IFC_PAPERS.some(([t]) => c.title.startsWith(t.slice(0, 30)));
        const openIFC = open.filter(isIFC).map((c) => pool2.s1[c.key].p);
        const openOther = open.filter((c) => !isIFC(c)).map((c) => pool2.s1[c.key].p);
        const includedIFC = cands.filter((c) => c.ta === "include" && isIFC(c)).length;
        const ledger = await ZR.Store.load(libraryID);
        const byDup = Object.values(ledger.decisions).filter((e) => e.c === localCol.key && e.ta?.by === "dup").length;
        const res = { rateMs, rated, cold, dupMarks, dupStatus, byDup, includedIFC, relearned, trained: open.some((c) => pool2.s1[c.key].trained), openIFC, openOther };
        if (!(cold.ifc > cold.other) || byDup !== 1 || includedIFC < 4 || !res.trained) throw new Error(JSON.stringify(res));
        if (openIFC.length && openOther.length && Math.min(...openIFC) <= Math.max(...openOther)) throw new Error("learned ranking wrong: " + JSON.stringify(res));
        return res;
      });

      await step("local model: topic clusters become a facet (mapping study)", async () => {
        const d = lw.document;
        localProject.methodology = "mapping";
        localProject.protocol = ZR.Methodologies.normalizeProtocol("mapping", localProject.protocol);
        await ZR.Projects.save(libraryID, localProject);
        lw.App.panels.review.reset();
        await lw.App.panels.review.refresh();
        d.querySelector('#rv-steps button[data-step="classify"]').click();
        await waitFor(() => !d.getElementById("rv-table-cluster").hidden, 10000);
        lw.App.status("review", "");
        d.getElementById("rv-table-cluster").click();
        await waitFor(() => /Grouped \d+ papers|Clustering failed/.test(lwStatus()), 60000);
        await U.sleep(300);
        await shot(lw, "16-clusters.png");
        const p = await ZR.Projects.get(libraryID, localProject.id);
        const facet = p.protocol.facets.find((f) => f.startsWith("Topic (clusters):"));
        const cells = [...d.querySelectorAll("#rv-table-body select")].map((s) => s.value).filter(Boolean);
        const res = { status: lwStatus(), facet, classified: cells.length };
        if (!facet || cells.length < 4) throw new Error(JSON.stringify(res));
        return res;
      });
      lw?.close();

      await step("local model: long full texts are cut to the relevant passages", async () => {
        const filler = (w) => Array.from({ length: 60 }, (_, i) => `In the ${w} part, the authors describe the history of their institute and its buildings, item ${i}.`).join(" ");
        const text = ["Abstract: this paper evaluates BIM data exchange.", filler("first"), "Results: exporting IFC from Revit to ArchiCAD lost 12 percent of the property sets and all custom parameters.", filler("second"), filler("third")].join("\n\n");
        const t0 = Date.now();
        const out = await ZR.Embed.passages("att:e2e/long", text, ["How much information is lost in IFC exchange between tools?"], { budget: 4000 });
        const res = { chars: text.length, kept: out.length, ms: Date.now() - t0, found: /lost 12 percent/.test(out), opening: out.startsWith("Abstract") };
        if (!res.found || out.length > 4100) throw new Error(JSON.stringify(res));
        return res;
      });

      await step("local model: similar papers in the library and in the citation graph", async () => {
        const ids = collection.getChildItems().filter((i) => i.isRegularItem()).slice(0, 2).map((i) => i.id);
        await zp.collectionsView.selectCollection(collection.id);
        await U.sleep(400);
        const w = await openResearch(win, { tab: "selected", itemIDs: ids }, (dd) => dd.getElementById("find-similar"));
        const d = w.document;
        d.getElementById("find-similar").click();
        await waitFor(() => d.querySelector("#similar-list .similar-row, #similar-list .hint") || /failed|not available/.test(d.getElementById("items-status").textContent), 180000);
        await shot(w, "17-similar.png");
        const rows = [...d.querySelectorAll("#similar-list .similar-row")].map((r) => r.textContent.slice(0, 70));
        w.App.showTab("citations");
        await waitFor(() => !d.getElementById("cite-similar-wrap").hidden, 15000);
        d.getElementById("cite-similar").checked = true;
        d.getElementById("cite-similar").dispatchEvent(new w.Event("change"));
        await waitFor(() => !/reading/.test(d.getElementById("cite-status").textContent) && w.App.panels.citations.similarEdges != null, 60000);
        await U.sleep(500);
        const res = { similar: rows.length, first: rows[0], status: d.getElementById("items-status").textContent, graphSimilarEdges: w.App.panels.citations.similarEdges };
        w.close();
        if (!rows.length) throw new Error(JSON.stringify(res));
        return res;
      });
      ZR.Prefs.set("s1Engine", "");
    } finally {
      ZR.http = realHTTP;
      report.llmCalls = llmCalls.length;
      ZR.Prefs.set("embedURL", "");
      ZR.Prefs.set("s1Engine", "");
      await ZR.Secrets.set(ZR.System1.keyName, "");
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

    if (ZR.Prefs.get("selftestCLI", false)) {
      for (const [provider, label] of [["claude-cli", "Claude Code"], ["codex-cli", "Codex"]]) {
        await step(`real AI call through the ${label} CLI (subscription, no API key)`, async () => {
          const path = await ZR.CLI.detect(provider);
          if (!path) throw new Error(label + " CLI not installed");
          const profile = { id: "cli-" + provider, name: label, provider, model: "", baseURL: "" };
          const t = await ZR.LLM.test(profile);
          const plan = await ZR.Assist.planQuery(profile, "Papers on IFC-based BIM data exchange, since 2019");
          if (!t.ok) throw new Error("test reply: " + t.reply);
          return { path, testReply: t.reply, ms: t.ms, plannedQuery: plan.query, validSyntax: !!ZR.Query.parse(plan.query) };
        });
      }
    }

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

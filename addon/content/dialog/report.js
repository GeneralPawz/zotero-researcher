/* global App, el, $, document, window, Zotero, Components, Services, IOUtils, PathUtils, PaperView, Image */
"use strict";

// Report step: diagrams from the project's data (PRISMA flow, review process, search
// strategy), in a style of your choice, copied to the clipboard or saved as PNG, JPG,
// SVG or LaTeX (TikZ). Styles are presets, your own (saved in the settings), or written
// by an AI from a journal's description or an example image.

const ReportView = (window.ReportView = (() => {
  const ZR = () => App.ZR;
  const D = () => App.ZR.Diagrams;
  let ctx = null; // from the review panel: {project, method, cands, counts, thresholds, engineName}
  let draft = null; // the style being shown (may have unsaved changes)
  let dirty = false;
  let styleImage = null; // {mediaType, data, name} for the AI
  const DIAGRAMS = [
    { id: "prisma", label: "PRISMA flow", file: "prisma-flow" },
    { id: "process", label: "Review process", file: "review-process" },
    { id: "search", label: "Search strategy", file: "search-strategy" },
  ];
  const st = (m) => App.status("review", m);

  // --------------------------------------------------------------- styles ----
  const customThemes = () => ZR().Prefs.getJSON("diagramThemes", []).map((t) => D().normalizeTheme(t, t));
  const allThemes = () => [...D().PRESETS, ...customThemes()];
  const isCustom = (id) => customThemes().some((t) => t.id === id);
  const report = () => ctx.project.report || {};

  async function saveReport(patch) {
    const p = ctx.project;
    p.report = Object.assign({}, p.report, patch);
    await ZR().Projects.save(App.target.libraryID, p);
  }

  function currentTheme() {
    if (!draft) {
      const id = report().themeID || "colour";
      draft = D().normalizeTheme(allThemes().find((t) => t.id === id) || D().PRESETS[0]);
      dirty = false;
    }
    return draft;
  }

  function renderThemeSelect() {
    const sel = $("rp-theme");
    const t = currentTheme();
    const opts = [
      ...D().PRESETS.map((p) => el("option", { value: p.id, text: p.name })),
      ...customThemes().map((c) => el("option", { value: c.id, text: `★ ${c.name}` })),
    ];
    if (dirty) opts.unshift(el("option", { value: "__draft", text: `${t.name} (unsaved changes)` }));
    sel.replaceChildren(...opts);
    sel.value = dirty ? "__draft" : t.id;
  }

  async function chooseTheme(id) {
    if (id === "__draft") return;
    draft = D().normalizeTheme(allThemes().find((t) => t.id === id) || D().PRESETS[0]);
    dirty = false;
    await saveReport({ themeID: draft.id });
    refresh();
  }

  function setDraft(patch) {
    draft = D().normalizeTheme(Object.assign({}, currentTheme(), patch), currentTheme());
    dirty = true;
    renderThemeSelect();
    draw();
  }

  // ------------------------------------------------------------- diagrams ----
  const kind = () => report().diagram || "prisma";

  /** What the diagrams show, from the project. */
  function facts() {
    const p = ctx.project;
    const P = p.protocol || {};
    const c = ctx.counts;
    const R = ZR().Records;
    const lang = (P.languages || []).map((x) => R.LANGUAGES.find((l) => l.code === x)?.name || x).join(", ");
    const types = (P.types || []).map((x) => R.TYPE_FILTERS.find((t) => t.id === x)?.label || x).join(", ");
    const runs = (p.runs || []).filter((r) => r.mode !== "related");
    const dbs = {};
    for (const r of runs) for (const [id, s] of Object.entries(r.perSource || {})) if (s.count) dbs[id] = (dbs[id] || 0) + s.count;
    const dates = runs.map((r) => String(r.at || "").slice(0, 10)).filter(Boolean).sort();
    const by = (w) => ctx.cands.filter((x) => x.ta && (w === "me" ? !["s1", "llm"].includes(x.taInfo?.by) : x.taInfo?.by === w)).length;
    const ap = p.autopilot;
    const ftProfile = ap?.profileID && App.profiles().find((x) => x.id === (ap.ftProfileID || ap.profileID));
    const fw = ZR().Methodologies.FRAMEWORKS[P.framework];
    const population = ctx.cands.filter((x) => x.ta === "include");
    return {
      methodology: ctx.method,
      stages: ctx.method.stages,
      protocol: {
        questions: (P.questions || []).length,
        inclusion: (P.inclusion || []).length,
        exclusion: (P.exclusion || []).length,
        framework: fw?.fields?.length ? fw.name : "",
        years: P.yearFrom || P.yearTo ? `${P.yearFrom || "any"} to ${P.yearTo || "today"}` : "",
        languages: lang,
        types,
      },
      search: {
        runs: runs.length,
        identified: c.identified,
        duplicates: c.removedDuplicates,
        inLibrary: c.removedInLibrary,
        databases: Object.entries(dbs).map(([id, n]) => ({ name: ZR().Sources.get(id)?.name || id, n })),
        query: P.query || runs.at(-1)?.query || "",
        when: dates.length ? (dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} to ${dates.at(-1)}`) : "",
      },
      screening: {
        pool: c.screened,
        included: ctx.cands.filter((x) => x.ta === "include").length,
        excluded: c.excludedTA,
        engine: ctx.engineName,
        thresholds: [Math.round(ctx.thresholds.excludeBelow * 100), Math.round(ctx.thresholds.includeAbove * 100)],
        bySystem1: by("s1"),
        byAI: by("llm"),
        byYou: by("me"),
      },
      fulltext: { sought: c.sought, withPDF: population.filter((x) => x.hasPDF).length, notRetrieved: c.notRetrieved, assessed: c.assessed, included: c.included, excluded: c.excludedFTTotal, annotatedBy: ftProfile ? `${ftProfile.name}${ap.ftModel || ap.model ? " · " + (ap.ftModel || ap.model) : ftProfile.model ? " · " + ftProfile.model : ""}` : "" },
      quality: (P.quality || []).length,
      extraction: (P.extraction || []).length,
      facets: (P.facets || []).length,
      included: c.included,
      // for the search strategy
      query: P.query || runs.at(-1)?.query || "",
      databases: Object.entries(dbs).map(([id, n]) => ({ name: ZR().Sources.get(id)?.name || id, n })),
      identified: c.identified,
      years: P.yearFrom || P.yearTo ? `${P.yearFrom || "any"} to ${P.yearTo || "today"}` : "",
      languages: lang,
      types,
    };
  }

  function scene(k = kind(), theme = currentTheme()) {
    const name = ctx.project.name;
    if (k === "process") return D().processScene(facts(), theme, { title: `How this review was done · ${name}` });
    if (k === "search") return D().searchScene(Object.assign(facts(), { duplicates: ctx.counts.removedDuplicates }), theme, { title: `Search strategy · ${name}` });
    return D().prismaScene(ctx.counts, theme, { title: `${ctx.method.name} · ${name}` });
  }

  const svgText = (k) => D().toSVG(scene(k), currentTheme());

  function draw() {
    const svg = svgText();
    const doc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
    const view = $("prisma-view");
    view.replaceChildren(document.importNode(doc.documentElement, true));
    view.classList.toggle("transparent", currentTheme().background === "none");
    for (const b of $("rp-diagram").children) b.classList.toggle("on", b.dataset.d === kind());
    if (ctx.facetSummary) view.append(ctx.facetSummary());
  }

  /** Called by the review panel when the report step is shown. */
  function render(c) {
    const same = ctx?.project?.id === c.project.id;
    ctx = c;
    if (!same) {
      draft = null;
      styleImage = null;
    }
    renderThemeSelect();
    if (!$("rp-editor").hidden) renderEditor();
    draw();
  }

  function refresh() {
    renderThemeSelect();
    if (!$("rp-editor").hidden) renderEditor();
    draw();
  }

  // --------------------------------------------------------------- editor ----
  function renderEditor() {
    const t = currentTheme();
    const box = $("rp-editor");
    const colourField = (key, label, value = t[key], onSet = (v) => setDraft({ [key]: v })) => {
      const hex = el("input", { type: "text", class: "rp-hex", value, spellcheck: "false", "data-key": key, maxlength: "7" });
      const picker = el("input", { type: "color", value, tabindex: "-1", title: "Pick a colour" });
      hex.addEventListener("change", () => onSet(hex.value));
      picker.addEventListener("input", () => ((hex.value = picker.value), onSet(picker.value)));
      return el("label", { class: "rp-field" }, [el("span", { text: label }), el("span", { class: "rp-colour" }, [picker, hex])]);
    };
    const numberField = (key, label, min, max, step = 1) => {
      const i = el("input", { type: "number", min: String(min), max: String(max), step: String(step), value: String(t[key]), "data-key": key });
      i.addEventListener("change", () => setDraft({ [key]: Number(i.value) }));
      return el("label", { class: "rp-field" }, [el("span", { text: label }), i]);
    };
    const check = (key, label) => {
      const i = el("input", { type: "checkbox", checked: !!t[key], "data-key": key });
      i.addEventListener("change", () => setDraft({ [key]: i.checked }));
      return el("label", { class: "rp-check" }, [i, " " + label]);
    };
    const select = (key, label, options) => {
      const s = el("select", { "data-key": key, onchange: (e) => setDraft({ [key]: e.target.value }) }, options.map(([v, l]) => el("option", { value: v, text: l, selected: v === t[key] })));
      return el("label", { class: "rp-field" }, [el("span", { text: label }), s]);
    };
    const radius = el("input", { type: "range", min: "0", max: "24", value: String(t.radius), "data-key": "radius" });
    radius.addEventListener("input", () => ((radius.nextSibling.textContent = radius.value + " px"), setDraft({ radius: Number(radius.value) })));
    const name = el("input", { type: "text", id: "rp-name", value: dirty && !isCustom(t.id) ? `${t.name} (my version)` : t.name, placeholder: "Name, e.g. the journal" });
    const group = (title, children) => el("div", { class: "rp-group" }, [el("div", { class: "opt-title", text: title }), ...children]);
    box.replaceChildren(
      el("div", { class: "rp-grid" }, [
        group("Text", [
          select("font", "Font", D().FONTS.map((f) => [f.id, f.label])),
          numberField("fontSize", "Size (px)", 8, 20),
          numberField("titleSize", "Title size (px)", 10, 28),
          check("showTitle", "Show a title"),
          check("boldFirst", "First line of each box bold"),
          colourField("text", "Text colour"),
        ]),
        group("Boxes", [
          el("label", { class: "rp-field" }, [el("span", { text: "Corners" }), el("span", { class: "rp-range" }, [radius, el("span", { class: "hint", text: t.radius + " px" })])]),
          colourField("boxFill", "Fill"),
          colourField("startFill", "First box"),
          colourField("endFill", "Last box"),
          colourField("sideFill", "Side boxes"),
          colourField("boxStroke", "Border"),
        ]),
        group("Lines", [
          colourField("line", "Line colour"),
          numberField("lineWidth", "Line width (px)", 0.5, 4, 0.1),
          select("arrow", "Arrow heads", [["filled", "Filled"], ["open", "Open"], ["none", "None"]]),
          el("label", { class: "rp-check" }, [el("input", { type: "checkbox", checked: t.background === "none", "data-key": "transparent", onchange: (e) => setDraft({ background: e.target.checked ? "none" : "#ffffff" }) }), " Transparent background"]),
          t.background === "none" ? null : colourField("background", "Background"),
        ]),
        group("Phase bands (PRISMA)", [
          check("bands", "Show bands on the left"),
          ...[0, 1, 2].map((i) => colourField("band" + i, ["Identification", "Screening", "Included"][i], t.bandColors[i], (v) => setDraft({ bandColors: t.bandColors.map((c, k) => (k === i ? v : c)) }))),
          colourField("bandText", "Band text"),
        ]),
      ]),
      el("div", { class: "actions rp-save" }, [
        name,
        isCustom(t.id) ? el("button", { id: "rp-update", class: "primary", text: "Save", disabled: !dirty && name.value === t.name, onclick: () => saveTheme(false) }) : null,
        el("button", { id: "rp-save-new", class: isCustom(t.id) ? "" : "primary", text: "Save as a new style", onclick: () => saveTheme(true) }),
        dirty ? el("button", { text: "Discard changes", onclick: () => chooseTheme(report().themeID || "colour") }) : null,
        el("span", { class: "spacer" }),
        isCustom(t.id) ? el("button", { class: "danger-soft", id: "rp-delete-style", text: "Delete this style", onclick: () => deleteTheme(t.id) }) : null,
      ])
    );
    name.addEventListener("input", () => $("rp-update") && ($("rp-update").disabled = false));
  }

  async function saveTheme(asNew) {
    const name = $("rp-name").value.trim() || "My style";
    const t = D().normalizeTheme(Object.assign({}, currentTheme(), { name, id: asNew || !isCustom(currentTheme().id) ? "custom-" + Date.now().toString(36) : currentTheme().id }));
    const list = customThemes().filter((x) => x.id !== t.id);
    list.push(t);
    ZR().Prefs.setJSON("diagramThemes", list);
    draft = t;
    dirty = false;
    await saveReport({ themeID: t.id });
    refresh();
    st(`Style “${t.name}” saved. It is available in every project.`);
  }

  async function deleteTheme(id) {
    const t = customThemes().find((x) => x.id === id);
    const c = await App.ask(`Delete the style “${t?.name}”?`, "Projects that use it switch back to the default style.", [
      { id: "cancel", label: "Cancel" },
      { id: "delete", label: "Delete style", danger: true },
    ]);
    if (c !== "delete") return;
    ZR().Prefs.setJSON("diagramThemes", customThemes().filter((x) => x.id !== id));
    await chooseTheme("colour");
  }

  // ------------------------------------------------------------ AI styles ----
  function renderAIBox() {
    const box = $("rp-ai-box");
    const profiles = App.profiles();
    const active = ZR().Prefs.getActiveLLMProfile();
    const text = el("textarea", { id: "rp-ai-text", rows: "4", placeholder: "Describe the journal's figure style or paste its guidelines, e.g. “black and white only, Arial 8 pt, square boxes, thin lines, no background colours”. You can also add a picture of an example figure." });
    text.value = report().aiText || "";
    text.addEventListener("paste", (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      readImageFile(file);
    });
    const preview = el("div", { id: "rp-ai-image", class: "rp-ai-image" });
    const showImage = () => {
      preview.replaceChildren(
        ...(styleImage
          ? [el("img", { src: `data:${styleImage.mediaType};base64,${styleImage.data}`, alt: "Example figure" }), el("span", { class: "hint", text: styleImage.name || "pasted image" }), el("button", { class: "icon-action danger", title: "Remove the image", onclick: () => ((styleImage = null), showImage()) }, App.icon("trash"))]
          : [el("span", { class: "hint", text: "No example image. Paste one into the text box (Ctrl+V) or choose a file." })])
      );
    };
    function readImageFile(file) {
      const r = new window.FileReader();
      r.onload = () => {
        const [head, data] = String(r.result).split(",");
        styleImage = { mediaType: head.match(/data:([^;]+)/)?.[1] || "image/png", data, name: file.name };
        showImage();
      };
      r.readAsDataURL(file);
    }
    showImage();
    const profileSel = el("select", { id: "rp-ai-profile" }, profiles.map((p) => el("option", { value: p.id, text: `${p.name}${p.model ? " · " + p.model : ""}`, selected: p.id === active?.id })));
    box.replaceChildren(
      el("div", { class: "hint", text: "The AI turns a journal's figure guidelines, your wishes, or a picture of a figure you like into a style. You check it in the editor and save it." }),
      text,
      el("div", { class: "rp-ai-row" }, [preview, el("button", { text: "Choose an image…", onclick: chooseImage })]),
      el("div", { class: "actions" }, [
        profiles.length ? el("label", { class: "inline hint" }, ["AI ", profileSel]) : el("span", { class: "hint", text: "Add an AI provider in Settings first." }),
        el("span", { class: "spacer" }),
        el("button", { id: "rp-ai-run", class: "primary", text: "Create the style", disabled: !profiles.length, onclick: () => runAI(profileSel.value, text.value) }),
      ])
    );
  }

  async function chooseImage() {
    const { FilePicker } = window.ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(window, "Example figure", fp.modeOpen);
    fp.appendFilter("Images", "*.png; *.jpg; *.jpeg; *.gif; *.webp");
    if ((await fp.show()) !== fp.returnOK) return;
    const path = typeof fp.file === "string" ? fp.file : fp.file.path;
    const bytes = await IOUtils.read(path);
    const ext = path.split(".").pop().toLowerCase();
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    setStyleImage({ mediaType: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext, data: window.btoa(bin), name: PathUtils.filename(path) });
  }

  function setStyleImage(img) {
    styleImage = img;
    if (!$("rp-ai-box").hidden) renderAIBox();
  }

  async function runAI(profileID, text) {
    const profile = App.profiles().find((p) => p.id === profileID);
    if (!profile) return st("Choose an AI provider.");
    if (!text.trim() && !styleImage) return st("Describe the style or add an example image first.");
    await saveReport({ aiText: text });
    App.setBusy("review", true);
    $("rp-ai-run").disabled = true;
    st(`${profile.name} is designing the style${styleImage ? " from the image" : ""}…`);
    try {
      const t = await D().themeFromAI(profile, { text, image: styleImage, base: currentTheme() });
      draft = t;
      dirty = true;
      $("rp-ai-box").hidden = true;
      $("rp-ai").setAttribute("aria-pressed", "false");
      $("rp-editor").hidden = false;
      $("rp-edit").setAttribute("aria-pressed", "true");
      refresh();
      st(`Style “${t.name}” created by the AI. Check it, adjust it in the editor, then save it.`);
    } catch (e) {
      st("The AI could not create a style: " + e.message);
    } finally {
      App.setBusy("review", false);
      if ($("rp-ai-run")) $("rp-ai-run").disabled = false;
    }
  }

  // --------------------------------------------------------------- export ----
  /** SVG → PNG / JPG bytes at a scale (3 = print, ~300 dpi at the diagram's size). */
  async function rasterize(svg, type = "image/png", scale = 3) {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("The diagram could not be drawn as an image"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
    const w = Number(svg.match(/ width="(\d+)"/)[1]);
    const h = Number(svg.match(/ height="(\d+)"/)[1]);
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const g = canvas.getContext("2d");
    if (type === "image/jpeg") {
      g.fillStyle = "#ffffff"; // JPG has no transparency
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, type, 0.95));
    return new Uint8Array(await blob.arrayBuffer());
  }

  const scale = () => Number($("rp-scale").value) || 3;

  /**
   * One diagram in one format: {data: string | Uint8Array, ext, mime, label}.
   * format: png | jpg | svg | tikz | latex
   */
  async function exportAs(format, k = kind()) {
    const s = scene(k);
    const t = currentTheme();
    const name = DIAGRAMS.find((x) => x.id === k).label;
    if (format === "svg") return { data: D().toSVG(s, t), ext: "svg", label: "SVG image" };
    if (format === "tikz") return { data: D().toTikZ(s, t, { name }), ext: "tex", label: "LaTeX (TikZ picture)" };
    if (format === "latex") return { data: D().toLaTeXDocument(s, t, { name }), ext: "tex", label: "LaTeX document" };
    const type = format === "jpg" ? "image/jpeg" : "image/png";
    return { data: await rasterize(D().toSVG(s, t), type, scale()), ext: format, label: format.toUpperCase() + " image" };
  }

  function fileName(k, ext) {
    const base = DIAGRAMS.find((x) => x.id === k).file;
    const proj = ctx.project.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40);
    return `${base}${proj ? "-" + proj : ""}.${ext}`;
  }

  /** Save to a path (tests) or ask where. */
  async function download(format, path = null) {
    try {
      const out = await exportAs(format);
      if (path) {
        if (typeof out.data === "string") await IOUtils.writeUTF8(path, out.data);
        else await IOUtils.write(path, out.data);
        return path;
      }
      const f = await App.saveFile(out.data, fileName(kind(), out.ext), out.label, "*." + out.ext);
      if (f) st("Saved " + f);
      return f;
    } catch (e) {
      Zotero.logError(e);
      st("Could not save the diagram: " + e.message);
      return null;
    }
  }

  function copyImage(bytes) {
    const Cc = Components.classes;
    const Ci = Components.interfaces;
    const imgTools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const container = imgTools.decodeImageFromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "image/png");
    const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    trans.init(null);
    trans.addDataFlavor("application/x-moz-nativeimage");
    trans.setTransferData("application/x-moz-nativeimage", container);
    Services.clipboard.setData(trans, null, Services.clipboard.kGlobalClipboard);
  }

  async function copy(format) {
    try {
      const out = await exportAs(format);
      if (format === "png") copyImage(out.data);
      else Zotero.Utilities.Internal.copyTextToClipboard(out.data);
      st(`Copied: ${DIAGRAMS.find((x) => x.id === kind()).label} as ${format === "png" ? "an image (paste into Word, PowerPoint, …)" : out.label}.`);
      return true;
    } catch (e) {
      Zotero.logError(e);
      st("Could not copy the diagram: " + e.message);
      return false;
    }
  }

  function menu(btn, items) {
    const r = btn.getBoundingClientRect();
    PaperView.openMenu(r.left, r.bottom + 4, items);
  }

  // ----------------------------------------------------------------- init ----
  function init() {
    for (const d of DIAGRAMS) $("rp-diagram").append(el("button", { "data-d": d.id, role: "radio", text: d.label, onclick: () => saveReport({ diagram: d.id }).then(draw) }));
    $("rp-theme").addEventListener("change", (e) => chooseTheme(e.target.value));
    $("rp-edit").addEventListener("click", () => {
      const open = $("rp-editor").hidden;
      $("rp-editor").hidden = !open;
      $("rp-edit").setAttribute("aria-pressed", String(open));
      if (open) renderEditor();
    });
    $("rp-ai").addEventListener("click", () => {
      const open = $("rp-ai-box").hidden;
      $("rp-ai-box").hidden = !open;
      $("rp-ai").setAttribute("aria-pressed", String(open));
      if (open) renderAIBox();
    });
    $("rp-copy").addEventListener("click", (e) =>
      menu(e.currentTarget, [
        { id: "rp-copy-png", icon: "jump", label: "As an image (PNG) for Word, PowerPoint, …", run: () => copy("png") },
        { id: "rp-copy-svg", icon: "jump", label: "As SVG code", run: () => copy("svg") },
        { id: "rp-copy-tikz", icon: "jump", label: "As LaTeX (TikZ picture)", run: () => copy("tikz") },
      ])
    );
    $("rp-download").addEventListener("click", (e) =>
      menu(e.currentTarget, [
        { id: "rp-dl-png", icon: "jump", label: `PNG image (${scale()}×)`, run: () => download("png") },
        { id: "rp-dl-jpg", icon: "jump", label: `JPG image (${scale()}×)`, run: () => download("jpg") },
        { id: "rp-dl-svg", icon: "jump", label: "SVG (vector, for Illustrator, Inkscape, the web)", run: () => download("svg") },
        { id: "rp-dl-tikz", icon: "jump", label: "LaTeX: TikZ picture to \\input (.tex)", run: () => download("tikz") },
        { id: "rp-dl-latex", icon: "jump", label: "LaTeX: document that compiles on its own (.tex)", run: () => download("latex") },
      ])
    );
    const saved = ZR().Prefs.get("diagramScale", 3);
    $("rp-scale").value = String(saved);
    $("rp-scale").addEventListener("change", () => ZR().Prefs.set("diagramScale", Number($("rp-scale").value)));
  }

  return { init, render, refresh, exportAs, download, copy, setStyleImage, runAI, chooseTheme, setDraft, saveTheme, currentTheme: () => currentTheme(), kind: () => kind() };
})());

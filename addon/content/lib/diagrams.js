/* global ZR */
// Report diagrams: the PRISMA flow, the review process with the project's specifics,
// and the search strategy.
//
// Each diagram is laid out once as a neutral scene (boxes with wrapped lines, arrows,
// side bands, labels) and then drawn by a renderer: SVG (also the source for PNG / JPG
// in the window) or TikZ for LaTeX. A theme sets fonts, colours, corners, arrows and
// bands, so the same diagram can follow a journal's style. Themes can be written by an
// AI from a description or a screenshot of an example figure.

ZR.Diagrams = (() => {
  const U = ZR.Util;

  const FONTS = [
    { id: "sans", label: "Sans serif (Segoe UI / Helvetica)", css: "Segoe UI, Helvetica, Arial, sans-serif", tex: "\\sffamily", w: 0.55 },
    { id: "arial", label: "Arial / Helvetica", css: "Arial, Helvetica, sans-serif", tex: "\\sffamily", w: 0.55 },
    { id: "serif", label: "Serif (Times)", css: "Times New Roman, Times, serif", tex: "\\rmfamily", w: 0.5 },
    { id: "georgia", label: "Serif (Georgia)", css: "Georgia, Times New Roman, serif", tex: "\\rmfamily", w: 0.56 },
    { id: "mono", label: "Monospace", css: "Consolas, Menlo, monospace", tex: "\\ttfamily", w: 0.6 },
  ];
  const ARROWS = ["filled", "open", "none"];

  // Built-in themes. Custom ones are stored in the preferences (see ZR.Prefs "diagramThemes").
  const PRESETS = [
    { id: "colour", name: "Colour (default)", font: "sans", fontSize: 13, titleSize: 16, showTitle: true, text: "#1a202c", line: "#4a5568", lineWidth: 1.3, boxFill: "#ffffff", boxStroke: "#4a5568", startFill: "#f7fafc", endFill: "#f0fff4", sideFill: "#ffffff", bands: true, bandColors: ["#bee3f8", "#c6f6d5", "#fefcbf"], bandText: "#1a202c", radius: 6, arrow: "filled", background: "#ffffff", boldFirst: true },
    { id: "print", name: "Black and white, square corners", font: "arial", fontSize: 12, titleSize: 14, showTitle: false, text: "#000000", line: "#000000", lineWidth: 1, boxFill: "#ffffff", boxStroke: "#000000", startFill: "#ffffff", endFill: "#ffffff", sideFill: "#ffffff", bands: true, bandColors: ["#e6e6e6", "#e6e6e6", "#e6e6e6"], bandText: "#000000", radius: 0, arrow: "filled", background: "#ffffff", boldFirst: false },
    { id: "grey", name: "Greyscale, rounded", font: "sans", fontSize: 12, titleSize: 15, showTitle: true, text: "#222222", line: "#555555", lineWidth: 1.2, boxFill: "#ffffff", boxStroke: "#666666", startFill: "#f2f2f2", endFill: "#e8e8e8", sideFill: "#fafafa", bands: true, bandColors: ["#d9d9d9", "#cccccc", "#bfbfbf"], bandText: "#222222", radius: 8, arrow: "filled", background: "#ffffff", boldFirst: true },
    { id: "serif", name: "Serif (Times), square, no bands", font: "serif", fontSize: 13, titleSize: 15, showTitle: false, text: "#000000", line: "#000000", lineWidth: 0.9, boxFill: "#ffffff", boxStroke: "#000000", startFill: "#ffffff", endFill: "#ffffff", sideFill: "#ffffff", bands: false, bandColors: ["#eeeeee", "#eeeeee", "#eeeeee"], bandText: "#000000", radius: 0, arrow: "open", background: "#ffffff", boldFirst: false },
    { id: "soft", name: "Soft pastel, very rounded", font: "sans", fontSize: 13, titleSize: 16, showTitle: true, text: "#2d3748", line: "#718096", lineWidth: 1.4, boxFill: "#ffffff", boxStroke: "#a0aec0", startFill: "#ebf8ff", endFill: "#f0fff4", sideFill: "#fff5f5", bands: true, bandColors: ["#e9d8fd", "#c4f1f9", "#fed7e2"], bandText: "#2d3748", radius: 14, arrow: "filled", background: "#ffffff", boldFirst: true },
    { id: "blue", name: "Blue accent, transparent background", font: "arial", fontSize: 12, titleSize: 15, showTitle: true, text: "#0b2545", line: "#13315c", lineWidth: 1.5, boxFill: "#ffffff", boxStroke: "#13315c", startFill: "#dbe9f6", endFill: "#dbe9f6", sideFill: "#ffffff", bands: true, bandColors: ["#13315c", "#134074", "#8da9c4"], bandText: "#ffffff", radius: 4, arrow: "filled", background: "none", boldFirst: true },
  ];

  const HEX = /^#[0-9a-f]{6}$/i;
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const colour = (v, d) => {
    let s = String(v ?? "").trim();
    if (/^#[0-9a-f]{3}$/i.test(s)) s = "#" + [...s.slice(1)].map((c) => c + c).join("");
    return HEX.test(s) ? s.toLowerCase() : d;
  };

  /** A theme with every field present and valid (AI or hand-made input is not trusted). */
  function normalizeTheme(t = {}, base = PRESETS[0]) {
    const b = Object.assign({}, PRESETS[0], base);
    const bands = Array.isArray(t.bandColors) ? t.bandColors : [];
    return {
      id: String(t.id || b.id || "custom").replace(/[^\w-]/g, "").slice(0, 40) || "custom",
      name: String(t.name || b.name || "Custom").trim().slice(0, 60) || "Custom",
      font: FONTS.some((f) => f.id === t.font) ? t.font : b.font,
      fontSize: Math.round(clamp(t.fontSize, 8, 20, b.fontSize)),
      titleSize: Math.round(clamp(t.titleSize, 10, 28, b.titleSize)),
      showTitle: t.showTitle == null ? b.showTitle : !!t.showTitle,
      text: colour(t.text, b.text),
      line: colour(t.line, b.line),
      lineWidth: Math.round(clamp(t.lineWidth, 0.5, 4, b.lineWidth) * 10) / 10,
      boxFill: colour(t.boxFill, b.boxFill),
      boxStroke: colour(t.boxStroke, b.boxStroke),
      startFill: colour(t.startFill, b.startFill),
      endFill: colour(t.endFill, b.endFill),
      sideFill: colour(t.sideFill, b.sideFill),
      bands: t.bands == null ? b.bands : !!t.bands,
      bandColors: [0, 1, 2].map((i) => colour(bands[i], b.bandColors[i])),
      bandText: colour(t.bandText, b.bandText),
      radius: Math.round(clamp(t.radius, 0, 24, b.radius)),
      arrow: ARROWS.includes(t.arrow) ? t.arrow : b.arrow,
      background: t.background === "none" || t.background === "transparent" ? "none" : colour(t.background, b.background === "none" ? "#ffffff" : b.background),
      boldFirst: t.boldFirst == null ? b.boldFirst : !!t.boldFirst,
    };
  }

  const font = (theme) => FONTS.find((f) => f.id === theme.font) || FONTS[0];

  // ---------------------------------------------------------------- text ----
  /** Approximate text width (no DOM here); good enough to wrap lines inside boxes. */
  function textWidth(s, size, theme, bold = false) {
    return String(s).length * size * font(theme).w * (bold ? 1.07 : 1);
  }

  /** Greedy word wrap to a width in px; very long words are cut. */
  const GLUE = String.fromCharCode(1); // keeps "(n = 12)" on one line
  function wrap(text, width, size, theme, bold = false) {
    const glued = String(text ?? "").replace(/\s+/g, " ").trim().replace(/\(n = ([\d,.]+)\)/g, `(n${GLUE}=${GLUE}$1)`);
    return wrapWords(glued.split(" ").filter(Boolean), width, size, theme, bold).map((l) => l.split(GLUE).join(" "));
  }

  function wrapWords(words, width, size, theme, bold) {
    const lines = [];
    let cur = "";
    const fits = (s) => textWidth(s, size, theme, bold) <= width;
    for (let w of words) {
      while (!fits(w)) {
        let n = Math.max(1, Math.floor(width / (size * font(theme).w * (bold ? 1.07 : 1))) - 1);
        if (cur) {
          lines.push(cur);
          cur = "";
        }
        lines.push(w.slice(0, n) + "-");
        w = w.slice(n);
      }
      const next = cur ? cur + " " + w : w;
      if (fits(next)) cur = next;
      else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // --------------------------------------------------------------- scenes ----
  /**
   * Scene: {width, height, title, boxes: [{x, y, w, h, kind, lines: [{text, bold, x, y}]}],
   *         arrows: [{points: [[x, y], …], label?}], bands: [{x, y, w, h, label, i}], labels: [{x, y, text, bold, anchor}]}
   * kind: main | start | end | side | detail | op
   */
  function sceneBuilder(theme, title) {
    const fs = theme.fontSize;
    const lineH = Math.round(fs * 1.35);
    const pad = Math.round(fs * 0.7);
    const s = { width: 0, height: 0, title: theme.showTitle ? title || "" : "", boxes: [], arrows: [], bands: [], labels: [] };
    const top = s.title ? Math.round(theme.titleSize * 2.4) : 16;
    /** lines: strings or {text, bold, indent}; the first line is bold when the theme says so */
    function box(x, y, w, lines, kind = "main") {
      const out = [];
      let ly = y + pad + fs;
      lines.forEach((l, i) => {
        const o = typeof l === "string" ? { text: l } : l;
        const bold = o.bold ?? (i === 0 && theme.boldFirst);
        const indent = o.indent ? Math.round(fs * 1.1) : 0;
        for (const t of wrap(o.text, w - 2 * pad - indent, fs, theme, bold)) {
          out.push({ text: t, bold, x: x + pad + indent, y: ly });
          ly += lineH;
        }
      });
      const b = { x, y, w, h: ly - y - lineH + pad + Math.round(fs * 0.35), kind, lines: out };
      s.boxes.push(b);
      return b;
    }
    const arrow = (points, label) => s.arrows.push(label ? { points, label } : { points });
    const band = (label, y1, y2, i) => theme.bands && s.bands.push({ x: 8, y: y1, w: 30, h: y2 - y1, label, i });
    const finish = (width, height) => {
      s.width = Math.round(width);
      s.height = Math.round(height);
      return s;
    };
    return { s, box, arrow, band, finish, top, fs, lineH, pad };
  }

  const n = (v) => `(n = ${Number(v || 0).toLocaleString("en")})`;

  /** PRISMA 2020 flow diagram from the review's counts (ZR.Prisma.countsFromData). */
  function prismaScene(c, theme, { title = "" } = {}) {
    const B = sceneBuilder(theme, title);
    const lx = theme.bands ? 54 : 20;
    const boxW = 340;
    const rx = lx + boxW + 70;
    const gap = 30;
    let y = B.top;
    const row = (left, right, leftKind = "main") => {
      const a = B.box(lx, y, boxW, left, leftKind);
      const b = right ? B.box(rx, y, boxW, right, "side") : null;
      if (b) {
        const h = Math.max(a.h, b.h);
        a.h = b.h = h;
        B.arrow([[lx + boxW, y + h / 2], [rx, y + h / 2]]);
      }
      const top = y;
      y += a.h + gap;
      return { top, bottom: y - gap };
    };
    const down = () => B.arrow([[lx + boxW / 2, y - gap], [lx + boxW / 2, y]]);
    const other = c.otherMethods.citation + c.otherMethods.manual;
    const r1 = row(
      [`Records identified from databases ${n(c.identified)}`, ...Object.entries(c.bySource).map(([k, v]) => ({ text: `${k} ${n(v)}`, indent: true })), ...(other ? [{ text: `Other methods: citation searching ${n(c.otherMethods.citation)}, added manually ${n(c.otherMethods.manual)}`, indent: true }] : [])],
      ["Records removed before screening:", { text: `Duplicates removed ${n(c.removedDuplicates)}`, indent: true }, { text: `Already in library ${n(c.removedInLibrary)}`, indent: true }],
      "start"
    );
    B.band("Identification", r1.top, r1.bottom + gap / 2, 0);
    down();
    const scTop = y;
    row(
      [`Records screened ${n(c.screened)}`, ...(c.pendingTA ? [{ text: `not yet screened ${n(c.pendingTA)}`, indent: true }] : []), ...(c.maybeTA ? [{ text: `undecided / maybe ${n(c.maybeTA)}`, indent: true }] : [])],
      [`Records excluded ${n(c.excludedTA)}`, ...Object.entries(c.excludedTAReasons || {}).slice(0, 6).map(([k, v]) => ({ text: `${k} ${n(v)}`, indent: true }))]
    );
    down();
    row([`Reports sought for retrieval ${n(c.sought)}`], [`Reports not retrieved ${n(c.notRetrieved)}`]);
    down();
    const r4 = row(
      [`Reports assessed for eligibility ${n(c.assessed)}`, ...(c.pendingFT ? [{ text: `awaiting full-text screening ${n(c.pendingFT)}`, indent: true }] : [])],
      [`Reports excluded ${n(c.excludedFTTotal)}`, ...Object.entries(c.excludedFT || {}).map(([k, v]) => ({ text: `${k} ${n(v)}`, indent: true }))]
    );
    B.band("Screening", scTop - gap / 2, r4.bottom + gap / 2, 1);
    down();
    const r5 = row([`Studies included in review ${n(c.included)}`], null, "end");
    B.band("Included", r5.top - gap / 2, r5.bottom + 6, 2);
    return B.finish(rx + boxW + 20, y - gap + 16);
  }

  /**
   * How the review was done, with this project's specifics.
   * facts: {methodology, stages, protocol: {questions, inclusion, exclusion, framework, years, languages},
   *   search: {databases: [{name, n}], runs, identified, duplicates, from, to},
   *   screening: {engine, thresholds, bySystem1, byAI, byYou, included, excluded, pool},
   *   fulltext: {sought, withPDF, notRetrieved, annotatedBy, assessed, included, excluded},
   *   quality, extraction, facets (numbers of fields), included}
   */
  function processScene(f, theme, { title = "" } = {}) {
    const B = sceneBuilder(theme, title);
    const lx = 20;
    const mainW = 300;
    const dx = lx + mainW + 56;
    const detailW = 380;
    const gap = 26;
    let y = B.top;
    let prev = null;
    const step = (num, label, summary, details, kind = "main") => {
      const a = B.box(lx, y, mainW, [{ text: `${num}. ${label}`, bold: true }, ...summary], kind);
      const d = details.length ? B.box(dx, y, detailW, details, "detail") : null;
      if (d) {
        const h = Math.max(a.h, d.h);
        a.h = d.h = h;
        B.arrow([[lx + mainW, y + h / 2], [dx, y + h / 2]], "dashed");
      }
      if (prev) B.arrow([[lx + mainW / 2, prev], [lx + mainW / 2, y]]);
      prev = y + a.h;
      y += a.h + gap;
    };
    const P = f.protocol || {};
    const stages = f.stages || [];
    let k = 1;
    for (const st of stages) {
      if (st === "protocol")
        step(k++, "Protocol", [f.methodology?.name || ""], [
          `${P.questions || 0} research question(s)${P.framework ? `, framework ${P.framework}` : ""}`,
          `${P.inclusion || 0} inclusion and ${P.exclusion || 0} exclusion criteria`,
          ...(P.years ? [`Years: ${P.years}`] : []),
          ...(P.languages ? [`Languages: ${P.languages}`] : []),
          ...(P.types ? [`Publication types: ${P.types}`] : []),
        ], "start");
      else if (st === "search") {
        const S = f.search || {};
        step(k++, "Search", [`${S.runs || 0} logged search${S.runs === 1 ? "" : "es"}, ${(S.identified || 0).toLocaleString("en")} records`], [
          ...(S.databases?.length ? [`Databases: ${S.databases.map((d) => `${d.name} (${d.n})`).join(", ")}`] : []),
          ...(S.when ? [`Run ${S.when}`] : []),
          `Duplicates removed ${n(S.duplicates)}; already in the library ${n(S.inLibrary)}`,
          ...(S.query ? [`Query: ${U.truncate(S.query, 220)}`] : []),
        ]);
      } else if (st === "screen") {
        const S = f.screening || {};
        step(k++, "Title and abstract screening", [`${(S.pool || 0).toLocaleString("en")} screened: ${S.included || 0} included, ${S.excluded || 0} excluded`], [
          `System 1 relevance estimate: ${S.engine || "keyword rules"}`,
          ...(S.thresholds ? [`Thresholds: exclude below ${S.thresholds[0]}%, include above ${S.thresholds[1]}%`] : []),
          `Decided by System 1 ${n(S.bySystem1)}, by the AI ${n(S.byAI)}, by the reviewer ${n(S.byYou)}`,
        ]);
      } else if (st === "fulltext") {
        const F = f.fulltext || {};
        step(k++, "Full-text assessment", [`${(F.assessed || 0).toLocaleString("en")} assessed: ${F.included || 0} included, ${F.excluded || 0} excluded`], [
          `Reports sought ${n(F.sought)}, full text retrieved ${n(F.withPDF)}, not retrieved ${n(F.notRetrieved)}`,
          ...(F.annotatedBy ? [`Evidence annotated in the PDFs by ${F.annotatedBy}, checked by the reviewer`] : []),
        ]);
      } else if (st === "quality") step(k++, "Quality appraisal", [`${f.quality || 0} checklist question(s)`], []);
      else if (st === "extract") step(k++, "Data extraction", [`${f.extraction || 0} field(s) per study`], []);
      else if (st === "classify") step(k++, "Classification", [`${f.facets || 0} facet(s)`], []);
      else if (st === "report") step(k++, "Synthesis and report", [`${(f.included || 0).toLocaleString("en")} studies included`], [], "end");
    }
    return B.finish(dx + detailW + 20, y - gap + 16);
  }

  /**
   * The search strategy: the query's concepts (terms in one concept are alternatives)
   * and how they combine, the databases with their counts, and what came out.
   */
  function searchScene(f, theme, { title = "" } = {}) {
    const B = sceneBuilder(theme, title);
    const lx = 20;
    const W = 760;
    let y = B.top;
    const blocks = f.query ? ZR.QueryBuilder.fromQuery(f.query) : null;
    const fieldName = { title: "in the title", abstract: "in the abstract", author: "as author" };
    let bottom;
    if (blocks?.length) {
      const per = Math.min(3, blocks.length);
      const opW = 56;
      const bw = Math.floor((W - (per - 1) * opW) / per);
      let rowTop = y;
      let rowH = 0;
      const placed = [];
      blocks.forEach((b, i) => {
        const col = i % per;
        if (col === 0 && i) {
          rowTop += rowH + 40;
          rowH = 0;
        }
        const x = lx + col * (bw + opW);
        const box = B.box(x, rowTop, bw, [{ text: `Concept ${i + 1}${b.field && b.field !== "any" ? ` (${fieldName[b.field] || b.field})` : ""}`, bold: true }, b.terms.join(" OR ")], i === 0 ? "start" : "main");
        rowH = Math.max(rowH, box.h);
        placed.push({ box, op: b.op, col });
      });
      // same height per row, operators between the concepts
      placed.forEach((p, i) => {
        const rowMates = placed.filter((q) => q.box.y === p.box.y);
        p.box.h = Math.max(...rowMates.map((q) => q.box.h));
        if (i > 0) {
          const op = p.op || "AND";
          if (p.col > 0) B.s.labels.push({ x: p.box.x - opW / 2, y: p.box.y + p.box.h / 2 + B.fs * 0.35, text: op, bold: true, anchor: "middle", pill: true });
          else B.s.labels.push({ x: p.box.x - 4 + bw / 2, y: p.box.y - 14, text: op, bold: true, anchor: "middle", pill: true });
        }
      });
      bottom = Math.max(...placed.map((p) => p.box.y + p.box.h));
    } else {
      const box = B.box(lx, y, W, [{ text: "Query", bold: true }, f.query || "(no query recorded)"], "start");
      bottom = box.y + box.h;
    }
    const mid = lx + W / 2;
    y = bottom + 36;
    B.arrow([[mid, bottom], [mid, y]]);
    const filters = [f.years && `years ${f.years}`, f.languages && `languages: ${f.languages}`, f.types && `types: ${f.types}`].filter(Boolean);
    const db = B.box(lx + 80, y, W - 160, [{ text: `Databases searched (${(f.databases || []).length})`, bold: true }, ...(f.databases || []).map((d) => ({ text: `${d.name} ${n(d.n)}`, indent: true })), ...(filters.length ? [{ text: `Limits: ${filters.join("; ")}`, bold: false }] : [])]);
    y = db.y + db.h + 36;
    B.arrow([[mid, db.y + db.h], [mid, y]]);
    const out = B.box(lx + 160, y, W - 320, [`Records identified ${n(f.identified)}`, { text: `after duplicates removed ${n((f.identified || 0) - (f.duplicates || 0))}`, bold: false }], "end");
    return B.finish(lx + W + 20, out.y + out.h + 16);
  }

  // ------------------------------------------------------------ renderers ----
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fillOf = (theme, kind) => ({ start: theme.startFill, end: theme.endFill, side: theme.sideFill, detail: theme.sideFill }[kind] || theme.boxFill);

  function toSVG(s, theme) {
    const t = normalizeTheme(theme, theme);
    const out = [];
    const mk = t.arrow === "none" ? "" : ' marker-end="url(#zr-arrow)"';
    if (t.background !== "none") out.push(`<rect width="100%" height="100%" fill="${t.background}"/>`);
    if (s.title) out.push(`<text x="${s.width / 2}" y="${Math.round(t.titleSize * 1.6)}" text-anchor="middle" font-size="${t.titleSize}" font-weight="700">${esc(s.title)}</text>`);
    for (const b of s.bands) {
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.min(t.radius, 8)}" fill="${t.bandColors[b.i]}"/>`);
      out.push(`<text transform="translate(${b.x + b.w / 2 + t.fontSize * 0.35} ${b.y + b.h / 2}) rotate(-90)" text-anchor="middle" font-size="${t.fontSize - 1}" font-weight="600" fill="${t.bandText}">${esc(b.label)}</text>`);
    }
    for (const a of s.arrows) {
      const dash = a.label === "dashed" ? ' stroke-dasharray="5 4"' : "";
      out.push(`<polyline points="${a.points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${t.line}" stroke-width="${t.lineWidth}"${dash}${a.label === "dashed" ? "" : mk}/>`);
    }
    for (const b of s.boxes) {
      const dash = b.kind === "detail" ? ' stroke-dasharray="4 3"' : "";
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"${t.radius ? ` rx="${t.radius}"` : ""} fill="${fillOf(t, b.kind)}" stroke="${t.boxStroke}" stroke-width="${t.lineWidth}"${dash}/>`);
      for (const l of b.lines) out.push(`<text x="${l.x}" y="${l.y}" font-size="${t.fontSize}"${l.bold ? ' font-weight="600"' : ""}>${esc(l.text)}</text>`);
    }
    for (const l of s.labels) {
      if (l.pill) {
        const w = textWidth(l.text, t.fontSize - 1, t, true) + 14;
        const h = t.fontSize + 8;
        out.push(`<rect x="${l.x - w / 2}" y="${l.y - h + 5}" width="${w}" height="${h}" rx="${h / 2}" fill="${t.line}"/>`);
        out.push(`<text x="${l.x}" y="${l.y}" text-anchor="middle" font-size="${t.fontSize - 1}" font-weight="700" fill="${t.background === "none" ? "#ffffff" : t.background}">${esc(l.text)}</text>`);
      } else out.push(`<text x="${l.x}" y="${l.y}" text-anchor="${l.anchor || "start"}" font-size="${t.fontSize}"${l.bold ? ' font-weight="700"' : ""}>${esc(l.text)}</text>`);
    }
    const head = t.arrow === "open" ? `<path d="M1 1L9 5L1 9" fill="none" stroke="${t.line}" stroke-width="1.4"/>` : `<path d="M0 0L10 5L0 10z" fill="${t.line}"/>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}" font-family="${esc(font(t).css)}" fill="${t.text}">` +
      `<defs><marker id="zr-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${Math.round(7 / Math.max(1, t.lineWidth * 0.8))}" markerHeight="${Math.round(7 / Math.max(1, t.lineWidth * 0.8))}" orient="auto">${head}</marker></defs>` +
      out.join("") +
      `</svg>`
    );
  }

  /** LaTeX special characters in text. */
  function texEscape(s) {
    const map = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "^": "\\textasciicircum{}", _: "\\_", "%": "\\%", "~": "\\textasciitilde{}" };
    return String(s).replace(/[\\{}$&#^_%~]/g, (c) => map[c]);
  }

  /**
   * TikZ picture with the same layout (1 px = 0.75 pt). Needs \usepackage{tikz} and
   * \usetikzlibrary{arrows.meta}; colours are defined with \definecolor (xcolor).
   */
  function toTikZ(s, theme, { name = "diagram" } = {}) {
    const t = normalizeTheme(theme, theme);
    const colours = new Map();
    const col = (hex) => {
      if (!colours.has(hex)) colours.set(hex, "zr" + String.fromCharCode(65 + colours.size % 26) + (colours.size >= 26 ? Math.floor(colours.size / 26) : ""));
      return colours.get(hex);
    };
    const f = font(t);
    const pt = (v) => Math.round(v * 0.75 * 10) / 10;
    const size = `\\fontsize{${pt(t.fontSize)}}{${pt(t.fontSize * 1.35)}}\\selectfont`;
    const body = [];
    const tip = t.arrow === "none" ? "" : t.arrow === "open" ? ", -{Stealth[open]}" : ", -{Stealth}";
    if (t.background !== "none") body.push(`  \\fill[${col(t.background)}] (0,0) rectangle (${s.width},${s.height});`);
    if (s.title) body.push(`  \\node[anchor=base, font=${f.tex}\\bfseries\\fontsize{${pt(t.titleSize)}}{${pt(t.titleSize * 1.3)}}\\selectfont, text=${col(t.text)}] at (${s.width / 2},${Math.round(t.titleSize * 1.6)}) {${texEscape(s.title)}};`);
    for (const b of s.bands) {
      body.push(`  \\fill[${col(t.bandColors[b.i])}, rounded corners=${pt(Math.min(t.radius, 8))}pt] (${b.x},${b.y}) rectangle (${b.x + b.w},${b.y + b.h});`);
      body.push(`  \\node[rotate=90, font=${f.tex}\\bfseries${size}, text=${col(t.bandText)}] at (${b.x + b.w / 2},${b.y + b.h / 2}) {${texEscape(b.label)}};`);
    }
    for (const a of s.arrows) {
      const dashed = a.label === "dashed";
      body.push(`  \\draw[${col(t.line)}, line width=${pt(t.lineWidth)}pt${dashed ? ", dashed" : tip}] ${a.points.map((p) => `(${p[0]},${p[1]})`).join(" -- ")};`);
    }
    for (const b of s.boxes) {
      const rc = t.radius ? `, rounded corners=${pt(t.radius)}pt` : "";
      body.push(`  \\draw[fill=${col(fillOf(t, b.kind))}, draw=${col(t.boxStroke)}, line width=${pt(t.lineWidth)}pt${rc}${b.kind === "detail" ? ", dashed" : ""}] (${b.x},${b.y}) rectangle (${b.x + b.w},${b.y + b.h});`);
      for (const l of b.lines) body.push(`  \\node[anchor=base west, inner sep=0, font=${f.tex}${l.bold ? "\\bfseries" : ""}${size}, text=${col(t.text)}] at (${l.x},${l.y}) {${texEscape(l.text)}};`);
    }
    for (const l of s.labels) {
      const pill = l.pill ? `, fill=${col(t.line)}, rounded corners=6pt, inner xsep=5pt, inner ysep=2pt, text=${col(t.background === "none" ? "#ffffff" : t.background)}` : `, text=${col(t.text)}`;
      body.push(`  \\node[anchor=base, font=${f.tex}\\bfseries${size}${pill}] at (${l.x},${l.y}) {${texEscape(l.text)}};`);
    }
    const defs = [...colours].map(([hex, id]) => `\\definecolor{${id}}{HTML}{${hex.slice(1).toUpperCase()}}`);
    return [
      `% ${name}: made with Zotero Researcher`,
      "% Preamble: \\usepackage{tikz} \\usetikzlibrary{arrows.meta}",
      ...defs,
      `\\begin{tikzpicture}[x=0.75pt, y=-0.75pt]`,
      ...body,
      `\\end{tikzpicture}`,
      "",
    ].join("\n");
  }

  /** A complete LaTeX document around the picture (compiles on its own). */
  function toLaTeXDocument(s, theme, opts) {
    return `\\documentclass[border=4pt]{standalone}\n\\usepackage{tikz}\n\\usetikzlibrary{arrows.meta}\n\\begin{document}\n${toTikZ(s, theme, opts)}\\end{document}\n`;
  }

  // ------------------------------------------------------------- AI themes ----
  const THEME_FIELDS = `{"name": "<short name, e.g. the journal>", "font": "sans"|"arial"|"serif"|"georgia"|"mono", "fontSize": 8-20 (px), "titleSize": 10-28, "showTitle": true|false,
 "text": "#rrggbb", "line": "#rrggbb", "lineWidth": 0.5-4, "boxFill": "#rrggbb", "boxStroke": "#rrggbb", "startFill": "#rrggbb" (first box), "endFill": "#rrggbb" (last box),
 "sideFill": "#rrggbb" (boxes on the right: exclusions, details), "bands": true|false (coloured phase bands on the left), "bandColors": ["#rrggbb", "#rrggbb", "#rrggbb"], "bandText": "#rrggbb",
 "radius": 0-24 (corner radius, 0 = square), "arrow": "filled"|"open"|"none", "background": "#rrggbb"|"none", "boldFirst": true|false (first line of each box bold)}`;

  /**
   * A theme from a description and/or an example image (a journal's figure guidelines,
   * a screenshot of a diagram). image: {mediaType, data (base64)}.
   */
  async function themeFromAI(profile, { text = "", image = null, base = PRESETS[0] } = {}) {
    if (!text.trim() && !image) throw new Error("Describe the style or add an example image");
    const user =
      `Design a style for flow diagrams in a scientific paper (PRISMA flow diagram, process flowchart, search strategy).\n\n` +
      (text.trim() ? `Requirements from the user (journal guidelines or wishes):\n${text.trim()}\n\n` : "") +
      (image ? "An example image is attached: match its look (colours, corners, line weights, font style, arrows, bands). Use the exact colours you see.\n\n" : "") +
      `Current style, change what the requirements or the image ask for:\n${JSON.stringify(normalizeTheme(base, base))}\n\n` +
      `Reply with JSON only, with these fields:\n${THEME_FIELDS}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system: "You are a scientific figure designer who follows journal style guides exactly.", maxTokens: 1200, images: image ? [image] : [], timeout: 240000 });
    return normalizeTheme(Object.assign({ id: "custom-" + Date.now().toString(36) }, out), base);
  }

  return { FONTS, ARROWS, PRESETS, normalizeTheme, wrap, textWidth, prismaScene, processScene, searchScene, toSVG, toTikZ, toLaTeXDocument, texEscape, themeFromAI };
})();

/* global Zotero, App, $, el, window, getComputedStyle, requestAnimationFrame */
"use strict";

// Citations tab: find who-cites-whom among library papers (from OpenAlex, Semantic
// Scholar, OpenCitations, Crossref), add Zotero "Related" links, show a graph, export.

App.panels.citations = (() => {
  let ZR;
  let graph = { nodes: [], edges: [] };
  let simEdges = []; // {from, to, sim} content similarity (local model), shown dashed
  let lastScan = null;
  let sim = null; // {nodes with x,y,vx,vy, edges}
  let hover = null;
  const st = (m) => App.status("cite", m);
  const COLORS = { include: "--good", exclude: "--bad", maybe: "--mid", unscreened: "--fg-3", "": "--accent" };

  function init() {
    ZR = App.ZR;
    $("cite-scope").value = App.collection() ? "collection" : "library";
    $("cite-scope").querySelector('option[value="collection"]').disabled = !App.collection();
    $("cite-scan").addEventListener("click", scan);
    $("cite-missing").addEventListener("click", missing);
    $("cite-graphml").addEventListener("click", () => exportGraph("graphml"));
    $("cite-csv").addEventListener("click", () => exportGraph("csv"));
    $("cite-scope").addEventListener("change", load);
    $("cite-similar").addEventListener("change", load);
    const canvas = $("graph");
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", () => ((hover = null), ($("graph-tip").hidden = true), draw()));
    canvas.addEventListener("click", () => hover && Zotero.getMainWindow()?.ZoteroPane.selectItem(hover.id));
    window.addEventListener("resize", () => sim && draw());
    $("graph-legend").replaceChildren(
      ...[["include", "included"], ["exclude", "excluded"], ["maybe", "maybe"], ["unscreened", "not screened"], ["", "no decision"]].map(([k, label]) =>
        el("span", {}, [el("span", { class: "dot", style: `background: var(${COLORS[k]}); border-color: var(${COLORS[k]})` }), label])
      )
    );
  }

  async function scopeItems() {
    if ($("cite-scope").value === "collection" && App.collection()) return App.collection().getChildItems(false).filter((i) => i.isRegularItem());
    return (await Zotero.Items.getAll(App.target.libraryID, true, false)).filter((i) => i.isRegularItem());
  }

  async function onShow() {
    await load();
  }

  async function load() {
    const items = await scopeItems();
    graph = await ZR.Citations.graph(App.target.libraryID, items);
    $("cite-similar-wrap").hidden = !(await ZR.Embed.available().catch(() => false));
    simEdges = $("cite-similar").checked && !$("cite-similar-wrap").hidden ? await similarEdges(items) : [];
    const any = graph.edges.length + simEdges.length > 0;
    $("graph-empty").hidden = any;
    $("graph-legend").hidden = !any;
    st(graph.edges.length ? `${graph.edges.length} citation links between ${new Set(graph.edges.flatMap((e) => [e.from, e.to])).size} of ${items.length} papers (click a dot to show it in Zotero)` : `${items.length} papers in scope. Click “Find citation links”.`);
    layout();
  }

  /** Each paper's two closest neighbours by content (≥ 0.8), where no citation link exists. */
  async function similarEdges(items) {
    const papers = items.map(ZR.Embed.itemPaper).filter((p) => p.title || p.abstract);
    const vecs = await ZR.Embed.paperVectors(papers, { onProgress: (d, n) => st(`The local model is reading ${d}/${n} paper(s) (first time only)…`) });
    const idOf = new Map(papers.map((p) => [p.key, p.itemID]));
    const cited = new Set(graph.edges.flatMap((e) => [`${e.from}>${e.to}`, `${e.to}>${e.from}`]));
    const out = new Map();
    for (const p of papers) {
      const v = vecs.get(p.key);
      if (!v) continue;
      for (const hit of ZR.Embed.nearest(v, vecs, 2, new Set([p.key]))) {
        if (hit.sim < 0.8) continue;
        const [a, b] = [p.itemID, idOf.get(hit.key)].sort((x, y) => x - y);
        if (cited.has(`${a}>${b}`)) continue;
        out.set(`${a}-${b}`, { from: a, to: b, sim: hit.sim });
      }
    }
    return [...out.values()];
  }

  async function scan() {
    const items = await scopeItems();
    if (items.length < 2) return st("Need at least two papers.");
    App.setBusy("cite", true);
    try {
      lastScan = await ZR.Citations.scan(items, { onProgress: st });
      await ZR.Citations.saveDirections(App.target.libraryID, lastScan.edges);
      let added = 0;
      if ($("cite-related").checked && App.target.editable) added = await ZR.Citations.linkRelated(lastScan.edges);
      await ZR.Store.flush(App.target.libraryID);
      await load();
      const s = lastScan.stats;
      const by = Object.entries(s.found).filter(([, n]) => n).map(([k, n]) => `${ZR.Sources.get(k)?.name || k} ${n}`).join(", ");
      st(
        `${s.edges} citation links among ${s.papers} papers · data from ${by || "-"}` +
          (s.notFound ? ` · ${s.notFound} papers unknown to the graphs (no DOI/arXiv id?)` : "") +
          ($("cite-related").checked ? ` · ${added} new “Related” links in Zotero` : "") +
          (s.errors.length ? ` · ⚠ ${s.errors[0]}` : "")
      );
    } catch (e) {
      Zotero.logError(e);
      st("Citation scan failed: " + e.message);
    } finally {
      App.setBusy("cite", false);
    }
  }

  async function missing() {
    if (!lastScan) {
      await scan();
      if (!lastScan) return;
    }
    App.setBusy("cite", true);
    try {
      st("Looking up frequently cited papers you don't have…");
      const records = await ZR.Citations.missing(lastScan.external, { minCount: 2, limit: 40 });
      for (const r of records) {
        const hit = await ZR.Importer.findExisting(App.target.libraryID, r);
        r.existingItemID = hit ? hit.id : null;
      }
      await ZR.Store.annotateRecords(App.target.libraryID, records);
      for (const r of records) r.selected = !r.existingItemID && (r.prior?.ta?.d !== "exclude");
      App.panels.search.showRecords(records, {
        mode: "related",
        query: `cited by ≥2 of ${lastScan.stats.papers} papers`,
        title: "Papers your collection cites often but you don't have",
        description: "From OpenAlex reference lists: a quick way to close gaps (citation searching in PRISMA terms).",
      });
      App.showTab("search");
      App.status("search", `${records.length} frequently cited papers missing from your library`);
    } catch (e) {
      st("Could not collect missing papers: " + e.message);
    } finally {
      App.setBusy("cite", false);
    }
  }

  async function exportGraph(kind) {
    if (!graph.edges.length) return st("Nothing to export yet. Find citation links first.");
    const content = kind === "graphml" ? ZR.Citations.graphML(graph) : ZR.Citations.edgesCSV(graph);
    const f = await App.saveFile(content, kind === "graphml" ? "citations.graphml" : "citations.csv", kind === "graphml" ? "GraphML (Gephi, yEd, Cytoscape)" : "CSV", kind === "graphml" ? "*.graphml" : "*.csv");
    if (f) st("Saved " + f);
  }

  // ------------------------------------------------------------ drawing ----
  function layout() {
    const linked = new Set([...graph.edges, ...simEdges].flatMap((e) => [e.from, e.to]));
    const nodes = graph.nodes.filter((n) => linked.has(n.id)).map((n, i, arr) => {
      const a = (2 * Math.PI * i) / arr.length;
      return Object.assign({}, n, { x: Math.cos(a) * 200, y: Math.sin(a) * 200, vx: 0, vy: 0, deg: 0 });
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = graph.edges.map((e) => ({ s: byId.get(e.from), t: byId.get(e.to) })).filter((e) => e.s && e.t);
    for (const e of edges) e.t.deg++;
    for (const e of simEdges) {
      const s = byId.get(e.from);
      const t = byId.get(e.to);
      if (s && t) edges.push({ s, t, similar: e.sim });
    }
    sim = { nodes, edges };
    // Simple force-directed layout: repulsion, springs, centering
    // O(n²) per iteration: fewer iterations for big libraries keep the window responsive
    const iters = nodes.length > 400 ? 60 : nodes.length > 150 ? 150 : 300;
    for (let it = 0; it < iters; it++) {
      const alpha = 1 - it / iters;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, 25);
          const f = (2400 / d2) * alpha;
          dx *= f / Math.sqrt(d2);
          dy *= f / Math.sqrt(d2);
          a.vx += dx;
          a.vy += dy;
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      for (const e of edges) {
        const dx = e.t.x - e.s.x;
        const dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - 90) / d) * 0.05 * alpha;
        e.s.vx += dx * f;
        e.s.vy += dy * f;
        e.t.vx -= dx * f;
        e.t.vy -= dy * f;
      }
      for (const n of nodes) {
        n.vx -= n.x * 0.01 * alpha;
        n.vy -= n.y * 0.01 * alpha;
        n.x += n.vx;
        n.y += n.vy;
        n.vx *= 0.6;
        n.vy *= 0.6;
      }
    }
    requestAnimationFrame(draw);
  }

  function view(canvas) {
    const xs = sim.nodes.map((n) => n.x);
    const ys = sim.nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const scale = Math.min((w - 80) / Math.max(maxX - minX, 1), (h - 80) / Math.max(maxY - minY, 1), 2.5);
    return { scale, ox: w / 2 - ((minX + maxX) / 2) * scale, oy: h / 2 - ((minY + maxY) / 2) * scale };
  }

  function draw() {
    const canvas = $("graph");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (!sim?.nodes.length) return;
    const css = getComputedStyle(document.documentElement);
    const color = (v) => css.getPropertyValue(v).trim();
    const { scale, ox, oy } = view(canvas);
    const P = (n) => [n.x * scale + ox, n.y * scale + oy];
    const radius = (n) => 4 + Math.min(10, Math.sqrt(n.deg) * 2.2);
    ctx.lineWidth = 1;
    for (const e of sim.edges) {
      const [x1, y1] = P(e.s);
      const [x2, y2] = P(e.t);
      const hl = hover && (e.s === hover || e.t === hover);
      ctx.strokeStyle = hl ? color("--accent") : color("--fg-3");
      ctx.globalAlpha = hover && !hl ? 0.35 : e.similar ? 0.7 : 1;
      ctx.setLineDash(e.similar ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (e.similar) continue; // similarity has no direction
      // arrow head at the cited paper
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const r = radius(e.t) + 2;
      const ax = x2 - Math.cos(ang) * r;
      const ay = y2 - Math.sin(ang) * r;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(ang - 0.4) * 7, ay - Math.sin(ang - 0.4) * 7);
      ctx.lineTo(ax - Math.cos(ang + 0.4) * 7, ay - Math.sin(ang + 0.4) * 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const n of sim.nodes) {
      const [x, y] = P(n);
      ctx.fillStyle = color(COLORS[n.decision] || "--accent");
      ctx.beginPath();
      ctx.arc(x, y, radius(n), 0, Math.PI * 2);
      ctx.fill();
      if (n === hover) {
        ctx.strokeStyle = color("--fg");
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    ctx.fillStyle = color("--fg-2");
    ctx.font = "11px sans-serif";
    // Small graphs: label everything; large graphs: only the most-cited papers
    const labelled = sim.nodes.length <= 30 ? sim.nodes : [...sim.nodes].sort((a, b) => b.deg - a.deg).slice(0, 12).filter((n) => n.deg);
    for (const n of labelled) {
      const [x, y] = P(n);
      const who = (n.creators || "").split(",")[0];
      ctx.fillText(who ? `${who} ${n.year || ""}`.trim() : ZR.Util.truncate(n.title, 32), x + radius(n) + 3, y + 3);
    }
  }

  function onMove(e) {
    if (!sim?.nodes.length) return;
    const canvas = $("graph");
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { scale, ox, oy } = view(canvas);
    let best = null;
    let bestD = 14 * 14;
    for (const n of sim.nodes) {
      const dx = n.x * scale + ox - mx;
      const dy = n.y * scale + oy - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        best = n;
        bestD = d;
      }
    }
    if (best !== hover) {
      hover = best;
      draw();
    }
    const tip = $("graph-tip");
    if (!hover) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    const cites = sim.edges.filter((x) => x.s === hover && !x.similar).length;
    const similar = sim.edges.filter((x) => x.similar && (x.s === hover || x.t === hover)).length;
    tip.textContent = `${hover.title} · ${hover.creators || ""} ${hover.year || ""} · cited by ${hover.deg} · cites ${cites} here${similar ? ` · ${similar} similar` : ""}`;
    tip.style.left = Math.min(mx + 14, canvas.clientWidth - 370) + "px";
    tip.style.top = my + 14 + "px";
  }

  return {
    init,
    onShow,
    get similarEdges() {
      return simEdges.length;
    },
  };
})();

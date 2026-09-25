/* global ZR, Zotero */
// Citation links between library items, built from existing open citation graphs
// rather than from scratch:
//   1. OpenAlex    – batch lookup by DOI (50 per request), `referenced_works`
//   2. Semantic Scholar – batch lookup (500 per request) incl. arXiv-only papers
//   3. OpenCitations – open DOI→DOI index, for papers that still have no links
//   4. Crossref    – publisher-deposited reference lists, last gap filler
// Links become Zotero "Related" relations (undirected, native) and the direction
// (who cites whom) is kept in the ledger for graph views and exports.

ZR.Citations = (() => {
  const U = ZR.Util;

  function nodeInfo(item) {
    const get = (f) => {
      try {
        return item.getField(f) || "";
      } catch (e) {
        return "";
      }
    };
    const doi = U.cleanDOI(get("DOI") || get("extra").match(/DOI:\s*\S+/i)?.[0] || get("url"));
    const arx = (get("archiveID") + " " + get("extra") + " " + get("url")).match(/arxiv(?:\.org\/abs\/|:\s*)(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    return { id: item.id, key: item.key, doi, arxiv: arx ? arx[1].toLowerCase() : "", title: get("title"), year: U.yearOf(get("date")) };
  }

  /** Pure: turn OpenAlex works + our node index into citing→cited pairs. */
  function edgesFromOpenAlex(works, nodesByDOI) {
    const oaToNode = new Map();
    for (const w of works) {
      const n = nodesByDOI.get(U.cleanDOI(w.doi || ""));
      if (n) oaToNode.set(w.id, n);
    }
    const edges = [];
    const external = new Map();
    for (const w of works) {
      const from = oaToNode.get(w.id);
      if (!from) continue;
      for (const ref of w.referenced_works || []) {
        const to = oaToNode.get(ref);
        if (to && to !== from) edges.push([from.id, to.id]);
        else if (!to) external.set(ref, (external.get(ref) || 0) + 1);
      }
    }
    return { edges, found: new Set([...oaToNode.values()].map((n) => n.id)), external };
  }

  /** Pure: Semantic Scholar batch response (aligned with requested nodes) → pairs. */
  function edgesFromS2(papers, requested, nodesByDOI, nodesByArxiv) {
    const edges = [];
    const found = new Set();
    papers.forEach((p, i) => {
      if (!p) return;
      const from = requested[i];
      found.add(from.id);
      for (const ref of p.references || []) {
        const ids = ref.externalIds || {};
        const to = (ids.DOI && nodesByDOI.get(U.cleanDOI(ids.DOI))) || (ids.ArXiv && nodesByArxiv.get(String(ids.ArXiv).toLowerCase()));
        if (to && to !== from) edges.push([from.id, to.id]);
      }
    });
    return { edges, found };
  }

  /** Pure: OpenCitations v2 "references" rows → cited DOIs. */
  function doisFromOpenCitations(rows) {
    return rows.map((r) => U.cleanDOI((String(r.cited).match(/doi:(\S+)/) || [])[1] || "")).filter(Boolean);
  }

  /**
   * Find citations among `items`.
   * @returns {{edges: {from:number,to:number,sources:string[]}[], stats:object, external: Map}}
   */
  async function scan(items, { onProgress = () => {} } = {}) {
    const nodes = items.filter((i) => i.isRegularItem()).map(nodeInfo);
    const byDOI = new Map(nodes.filter((n) => n.doi).map((n) => [n.doi, n]));
    const byArxiv = new Map(nodes.filter((n) => n.arxiv).map((n) => [n.arxiv, n]));
    const edgeMap = new Map(); // "a>b" -> Set(sources)
    const add = (pairs, source) => {
      for (const [a, b] of pairs) {
        const k = `${a}>${b}`;
        if (!edgeMap.has(k)) edgeMap.set(k, new Set());
        edgeMap.get(k).add(source);
      }
    };
    const stats = { papers: nodes.length, withDOI: byDOI.size, found: { openalex: 0, semanticscholar: 0, opencitations: 0, crossref: 0 }, errors: [] };
    const email = ZR.Prefs.get("email", "");
    let external = new Map();

    // 1) OpenAlex
    const oaKey = ZR.Sources.keyFor("openalex");
    const dois = [...byDOI.keys()];
    const works = [];
    for (let i = 0; i < dois.length; i += 50) {
      onProgress(`OpenAlex: looking up ${Math.min(i + 50, dois.length)}/${dois.length} DOIs…`);
      try {
        const data = await U.getJSON(
          "https://api.openalex.org/works?" + U.qs({ filter: "doi:" + dois.slice(i, i + 50).join("|"), per_page: 50, select: "id,doi,referenced_works", api_key: oaKey, mailto: oaKey ? "" : email }),
          { retryAfterMax: 45000 }
        );
        works.push(...(data.results || []));
      } catch (e) {
        stats.errors.push("OpenAlex: " + e.message);
        break;
      }
    }
    const oa = edgesFromOpenAlex(works, byDOI);
    add(oa.edges, "openalex");
    stats.found.openalex = oa.found.size;
    external = oa.external;

    // 2) Semantic Scholar batch — every paper with a DOI or arXiv id (union improves recall)
    const s2Nodes = nodes.filter((n) => n.doi || n.arxiv);
    const s2Key = ZR.Sources.keyFor("semanticscholar");
    const s2Found = new Set();
    for (let i = 0; i < s2Nodes.length; i += 400) {
      const batch = s2Nodes.slice(i, i + 400);
      onProgress(`Semantic Scholar: ${Math.min(i + 400, s2Nodes.length)}/${s2Nodes.length} papers…`);
      try {
        await ZR.Sources.throttle("semanticscholar", 1100);
        const res = await ZR.http("POST", "https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,references.externalIds", {
          headers: s2Key ? { "x-api-key": s2Key } : {},
          body: { ids: batch.map((n) => (n.doi ? "DOI:" + n.doi : "ARXIV:" + n.arxiv)) },
          retryAfterMax: 20000,
        });
        const s2 = edgesFromS2(res.json(), batch, byDOI, byArxiv);
        add(s2.edges, "semanticscholar");
        for (const id of s2.found) s2Found.add(id);
      } catch (e) {
        stats.errors.push("Semantic Scholar: " + e.message);
        break;
      }
    }
    stats.found.semanticscholar = s2Found.size;

    // Gap fillers only for papers that neither graph knows about
    const gaps = nodes.filter((n) => n.doi && !oa.found.has(n.id) && !s2Found.has(n.id)).slice(0, 100);

    // 3) OpenCitations
    let ocDone = 0;
    for (const n of gaps) {
      onProgress(`OpenCitations: filling gaps ${++ocDone}/${gaps.length}…`);
      try {
        const rows = await U.getJSON(`https://api.opencitations.net/index/v2/references/doi:${encodeURIComponent(n.doi)}`, { timeout: 20000, noRetry: true });
        const cited = doisFromOpenCitations(rows);
        if (rows.length) stats.found.opencitations++;
        add(cited.map((d) => byDOI.get(d)).filter((t) => t && t !== n).map((t) => [n.id, t.id]), "opencitations");
      } catch (e) {
        stats.errors.push("OpenCitations: " + e.message);
        break;
      }
    }

    // 4) Crossref reference lists for papers still without outgoing links
    const stillEmpty = gaps.filter((n) => ![...edgeMap.keys()].some((k) => k.startsWith(n.id + ">")));
    let crDone = 0;
    for (const n of stillEmpty) {
      onProgress(`Crossref: reading reference lists ${++crDone}/${stillEmpty.length}…`);
      try {
        await ZR.Sources.throttle("crossref", email ? 400 : 1100);
        const data = await U.getJSON(`https://api.crossref.org/works/${encodeURIComponent(n.doi)}?` + U.qs({ mailto: email }), { noRetry: true });
        const refs = data.message?.reference || [];
        if (refs.length) stats.found.crossref++;
        add(refs.map((r) => byDOI.get(U.cleanDOI(r.DOI || ""))).filter((t) => t && t !== n).map((t) => [n.id, t.id]), "crossref");
      } catch (e) {
        if (e.status !== 404) stats.errors.push("Crossref: " + e.message);
      }
    }

    const edges = [...edgeMap.entries()].map(([k, s]) => {
      const [from, to] = k.split(">").map(Number);
      return { from, to, sources: [...s] };
    });
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    stats.edges = edges.length;
    stats.linkedPapers = linked.size;
    stats.notFound = nodes.filter((n) => !oa.found.has(n.id) && !s2Found.has(n.id)).length;
    return { edges, stats, external, nodes };
  }

  /** Add native Zotero "Related" links for each citation pair. Returns number of new links. */
  async function linkRelated(edges) {
    let added = 0;
    const dirty = new Set();
    for (const e of edges) {
      const a = Zotero.Items.get(e.from);
      const b = Zotero.Items.get(e.to);
      if (!a || !b || a.libraryID !== b.libraryID) continue;
      const already = a.relatedItems.includes(b.key) && b.relatedItems.includes(a.key);
      if (already) continue;
      a.addRelatedItem(b);
      b.addRelatedItem(a);
      dirty.add(a);
      dirty.add(b);
      added++;
    }
    for (const item of dirty) await item.saveTx({ skipDateModifiedUpdate: true });
    return added;
  }

  /** Persist directions in the ledger: {citingKey: [citedKey, …]} (merged with earlier scans). */
  async function saveDirections(libraryID, edges) {
    const existing = await ZR.Store.getCitations(libraryID);
    const map = {};
    for (const e of edges) {
      const a = Zotero.Items.get(e.from);
      const b = Zotero.Items.get(e.to);
      if (!a || !b) continue;
      const list = (map[a.key] = map[a.key] || [...(existing[a.key] || [])]);
      if (!list.includes(b.key)) list.push(b.key);
    }
    await ZR.Store.setCitations(libraryID, map);
  }

  /** Graph of stored citations restricted to `items` (for the viewer and exports). */
  async function graph(libraryID, items) {
    const cites = await ZR.Store.getCitations(libraryID);
    const byKey = new Map(items.filter((i) => i.isRegularItem()).map((i) => [i.key, i]));
    const nodes = [...byKey.values()].map((i) => {
      const dec = ZR.Store.decisionFromItem(i);
      return {
        id: i.id,
        key: i.key,
        title: i.getField("title"),
        year: U.yearOf(i.getField("date")),
        creators: i.getCreators().map((c) => c.lastName).slice(0, 3).join(", "),
        decision: dec?.ft?.d || dec?.ta?.d || (dec?.unscreened ? "unscreened" : ""),
      };
    });
    const edges = [];
    for (const [from, tos] of Object.entries(cites)) {
      if (!byKey.has(from)) continue;
      for (const to of tos) if (byKey.has(to)) edges.push({ from: byKey.get(from).id, to: byKey.get(to).id });
    }
    return { nodes, edges };
  }

  function graphML({ nodes, edges }) {
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n` +
      `<key id="title" for="node" attr.name="title" attr.type="string"/><key id="year" for="node" attr.name="year" attr.type="int"/>` +
      `<key id="authors" for="node" attr.name="authors" attr.type="string"/><key id="decision" for="node" attr.name="decision" attr.type="string"/>\n` +
      `<graph id="citations" edgedefault="directed">\n` +
      nodes.map((n) => `<node id="${n.key}"><data key="title">${esc(n.title)}</data><data key="year">${n.year || ""}</data><data key="authors">${esc(n.creators)}</data><data key="decision">${esc(n.decision)}</data></node>`).join("\n") +
      "\n" +
      edges.map((e, i) => `<edge id="e${i}" source="${nodes.find((n) => n.id === e.from).key}" target="${nodes.find((n) => n.id === e.to).key}"/>`).join("\n") +
      `\n</graph>\n</graphml>\n`
    );
  }

  function edgesCSV({ nodes, edges }) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    return ["citing_key,citing_title,cited_key,cited_title", ...edges.map((e) => [byId.get(e.from).key, q(byId.get(e.from).title), byId.get(e.to).key, q(byId.get(e.to).title)].join(","))].join("\n");
  }

  /** Works cited by ≥ minCount scanned papers but missing from the library (OpenAlex). */
  async function missing(external, { minCount = 2, limit = 40 } = {}) {
    const ranked = [...external.entries()].filter(([, n]) => n >= minCount).sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (!ranked.length) return [];
    const key = ZR.Sources.keyFor("openalex");
    const email = ZR.Prefs.get("email", "");
    const records = [];
    for (let i = 0; i < ranked.length; i += 50) {
      const ids = ranked.slice(i, i + 50).map(([id]) => id.replace("https://openalex.org/", ""));
      const data = await U.getJSON("https://api.openalex.org/works?" + U.qs({ filter: "openalex:" + ids.join("|"), per_page: 50, api_key: key, mailto: key ? "" : email }), { retryAfterMax: 45000 });
      for (const w of data.results || []) {
        const r = ZR.Sources.get("openalex").mapWork(w);
        r.citedByCollection = external.get(w.id) || 0;
        records.push(r);
      }
    }
    return records.sort((a, b) => b.citedByCollection - a.citedByCollection);
  }

  return { scan, linkRelated, saveDirections, graph, graphML, edgesCSV, missing, edgesFromOpenAlex, edgesFromS2, doisFromOpenCitations, nodeInfo };
})();

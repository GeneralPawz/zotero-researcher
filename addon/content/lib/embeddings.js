/* global ZR, Zotero, IOUtils, PathUtils */
// Local embeddings (this computer, e.g. Ollama with nomic-embed-text) and what is built
// on them — all offline, free and private:
//   - a relevance model that learns from your screening decisions (System 1 "local")
//   - duplicate detection (preprint vs. journal version, re-worded titles)
//   - "similar papers" in your library, clusters for mapping-study facets
//   - passage retrieval: only the relevant parts of a long full text go to the LLM
//
// Vectors are cached per model on disk (<data dir>/zotero-researcher/vectors/), keyed by
// paper key plus a hash of the embedded text, so each paper is embedded once.

ZR.Embed = (() => {
  const U = ZR.Util;
  const DEFAULT_URL = "http://127.0.0.1:11434";

  const APIS = [
    { id: "ollama", name: "Ollama", defaultURL: "http://127.0.0.1:11434" },
    { id: "openai", name: "OpenAI-compatible (Foundry Local, LM Studio, llama.cpp, …)", defaultURL: "http://127.0.0.1:1234/v1" },
  ];

  const MODELS = [
    { id: "nomic-embed-text", size: "274 MB", note: "recommended — good quality, fast on CPU" },
    { id: "embeddinggemma", size: "622 MB", note: "multilingual, higher quality" },
    { id: "mxbai-embed-large", size: "670 MB", note: "high quality, slower" },
    { id: "all-minilm", size: "46 MB", note: "tiny and very fast, English, lower quality" },
  ];

  function config() {
    const api = ZR.Prefs.get("embedAPI", "ollama") === "openai" ? "openai" : "ollama";
    const url = String(ZR.Prefs.get("embedURL", "") || (api === "ollama" ? DEFAULT_URL : APIS[1].defaultURL)).replace(/\/+$/, "");
    return { api, url, model: ZR.Prefs.get("embedModel", "nomic-embed-text") || "nomic-embed-text", enabled: ZR.Prefs.get("embedEnabled", true) !== false };
  }

  // Task prefixes the models were trained with (retrieval quality drops without them)
  function prefixes(model) {
    const m = model.toLowerCase();
    if (m.includes("nomic")) return { query: "search_query: ", doc: "search_document: " };
    if (m.includes("e5")) return { query: "query: ", doc: "passage: " };
    if (m.includes("mxbai") || m.includes("bge")) return { query: "Represent this sentence for searching relevant passages: ", doc: "" };
    if (m.includes("embeddinggemma")) return { query: "task: search result | query: ", doc: "title: none | text: " };
    return { query: "", doc: "" };
  }

  // ---------------------------------------------------------------- server ----
  let lastStatus = null; // {ok, at, ...}

  function explain(e, cfg) {
    const status = e?.status;
    if (status === 403 && cfg.api === "ollama") return "Ollama refused the request (403). Allow Zotero by setting the environment variable OLLAMA_ORIGINS=* and restarting Ollama.";
    if (status === 404) return `Model “${cfg.model}” is not installed on the local server.`;
    if (!status) return cfg.api === "ollama" ? "Ollama is not running on this computer (start the Ollama app)." : `No local server answers at ${cfg.url}.`;
    return e.message || String(e);
  }

  /** Check the local server and model. Returns {ok, server, version, models, hasModel, error}. */
  async function check() {
    const cfg = config();
    const out = { ok: false, api: cfg.api, url: cfg.url, model: cfg.model, version: "", models: [], hasModel: false, error: "", at: Date.now() };
    try {
      if (cfg.api === "ollama") {
        out.version = (await ZR.http("GET", `${cfg.url}/api/version`, { timeout: 4000, noRetry: true })).json().version || "";
        out.models = ((await ZR.http("GET", `${cfg.url}/api/tags`, { timeout: 4000, noRetry: true })).json().models || []).map((m) => m.name);
        out.hasModel = out.models.some((n) => n === cfg.model || n.split(":")[0] === cfg.model.split(":")[0]);
      } else {
        out.models = ((await ZR.http("GET", `${cfg.url}/models`, { timeout: 4000, noRetry: true })).json().data || []).map((m) => m.id);
        out.hasModel = !out.models.length || out.models.includes(cfg.model);
      }
      if (!out.hasModel) out.error = `Model “${cfg.model}” is not installed.`;
      else {
        const v = await rawEmbed(["test"], cfg);
        out.dim = v[0]?.length || 0;
        out.ok = out.dim > 0;
      }
    } catch (e) {
      out.error = explain(e, cfg);
    }
    lastStatus = out;
    return out;
  }

  /** Last known availability (sync; refreshed by check()/available()). */
  const isAvailable = () => config().enabled && !!lastStatus?.ok;

  /** Available right now? Re-checks at most once a minute. */
  async function available() {
    if (!config().enabled) return false;
    if (!lastStatus || Date.now() - lastStatus.at > 60000) await check();
    return !!lastStatus.ok;
  }

  /** Download the model into Ollama. */
  async function pull(onStatus = () => {}) {
    const cfg = config();
    if (cfg.api !== "ollama") throw new Error("Download the model with your local server's own tools.");
    onStatus(`Downloading ${cfg.model}…`);
    await ZR.http("POST", `${cfg.url}/api/pull`, { body: { model: cfg.model, stream: false }, timeout: 30 * 60000, noRetry: true });
    return check();
  }

  async function rawEmbed(texts, cfg = config()) {
    if (cfg.api === "ollama") {
      const res = await ZR.http("POST", `${cfg.url}/api/embed`, { body: { model: cfg.model, input: texts, truncate: true }, timeout: 180000, noRetry: true });
      return res.json().embeddings;
    }
    const res = await ZR.http("POST", `${cfg.url}/embeddings`, { body: { model: cfg.model, input: texts }, timeout: 180000, noRetry: true });
    return (res.json().data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  function normalize(v) {
    const out = new Float32Array(v.length);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  /** Embed texts ("doc" or "query"), in batches. Returns unit Float32Arrays. */
  async function embed(texts, kind = "doc", { batch = 16, onProgress } = {}) {
    const cfg = config();
    const pre = prefixes(cfg.model)[kind] || "";
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      let vecs;
      try {
        vecs = await rawEmbed(texts.slice(i, i + batch).map((t) => pre + U.truncate(String(t || ""), 2000)), cfg);
      } catch (e) {
        throw new Error(explain(e, cfg));
      }
      for (const v of vecs) out.push(normalize(v));
      onProgress?.(Math.min(i + batch, texts.length), texts.length);
    }
    return out;
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // ----------------------------------------------------------- vector cache ----
  const caches = new Map(); // model -> {map: Map(key -> {h, v}), dirty, timer}

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toB64(f32) {
    const b = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = "";
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
    }
    return s;
  }
  function fromB64(s) {
    const clean = s.replace(/=+$/, "");
    const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let j = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      if (j < bytes.length) bytes[j++] = (n >> 16) & 255;
      if (j < bytes.length) bytes[j++] = (n >> 8) & 255;
      if (j < bytes.length) bytes[j++] = n & 255;
    }
    return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
  }

  const hasFS = () => typeof IOUtils !== "undefined" && typeof Zotero !== "undefined";
  const cachePath = (model) => PathUtils.join(Zotero.DataDirectory.dir, "zotero-researcher", "vectors", model.replace(/[^\w.-]+/g, "_") + ".json");

  async function cacheFor(model) {
    if (caches.has(model)) return caches.get(model);
    const c = { map: new Map(), dirty: false, timer: null };
    caches.set(model, c);
    if (hasFS()) {
      try {
        const data = JSON.parse(await IOUtils.readUTF8(cachePath(model)));
        for (const [k, [h, v]] of Object.entries(data.items || {})) c.map.set(k, { h, v: fromB64(v) });
      } catch (e) {
        /* no cache yet */
      }
    }
    return c;
  }

  function saveSoon(model) {
    const c = caches.get(model);
    if (!c || !hasFS()) return;
    c.dirty = true;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => flush(model).catch((e) => U.log("vector cache save failed", e.message)), 1500);
  }

  async function flush(model = config().model) {
    const c = caches.get(model);
    if (!c?.dirty || !hasFS()) return;
    c.dirty = false;
    const items = {};
    for (const [k, { h, v }] of c.map) items[k] = [h, toB64(v)];
    const path = cachePath(model);
    await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeUTF8(path, JSON.stringify({ model, items }), { tmpPath: path + ".tmp" });
  }

  /**
   * Vectors for keyed texts, embedding only what is not cached yet.
   * @param {{key: string, text: string}[]} entries
   * @returns {Promise<Map<string, Float32Array>>}
   */
  async function vectors(entries, { onProgress } = {}) {
    const model = config().model;
    const c = await cacheFor(model);
    const out = new Map();
    const todo = [];
    for (const e of entries) {
      if (!e.key || !e.text) continue;
      const h = hash(e.text);
      const hit = c.map.get(e.key);
      if (hit && hit.h === h) out.set(e.key, hit.v);
      else todo.push(Object.assign({ h }, e));
    }
    if (todo.length) {
      const vecs = await embed(
        todo.map((e) => e.text),
        "doc",
        { onProgress: (d, n) => onProgress?.(d, n) }
      );
      todo.forEach((e, i) => {
        c.map.set(e.key, { h: e.h, v: vecs[i] });
        out.set(e.key, vecs[i]);
      });
      saveSoon(model);
    }
    return out;
  }

  /** The text a paper is represented by: title and abstract. */
  const paperText = (p) => [p.title, p.abstract].filter(Boolean).join("\n").slice(0, 2000);

  /** Vectors for papers ({key, title, abstract}). */
  const paperVectors = (papers, opts) => vectors(papers.map((p) => ({ key: p.key, text: paperText(p) })), opts);

  /** Item → {key, title, abstract} (key: library item key). */
  function itemPaper(item) {
    return { key: "item:" + item.libraryID + "/" + item.key, itemID: item.id, title: item.getField("title"), abstract: item.getField("abstractNote") };
  }

  // -------------------------------------------------------------- similarity ----
  /** The k nearest keys to a vector. */
  function nearest(qv, vecs, k = 10, exclude = new Set()) {
    const out = [];
    for (const [key, v] of vecs) if (!exclude.has(key)) out.push({ key, sim: dot(qv, v) });
    return out.sort((a, b) => b.sim - a.sim).slice(0, k);
  }

  /**
   * Likely duplicates among papers: very similar title+abstract, or similar text with
   * near-identical titles (preprint vs. journal version, re-worded abstracts).
   * @returns {{a: string, b: string, sim: number}[]} key pairs
   */
  function duplicates(papers, vecs, { threshold = 0.95, withTitle = 0.9 } = {}) {
    const list = papers.filter((p) => vecs.has(p.key));
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      const vi = vecs.get(list[i].key);
      for (let j = i + 1; j < list.length; j++) {
        const sim = dot(vi, vecs.get(list[j].key));
        if (sim < withTitle) continue;
        if (sim >= threshold || U.titleSimilarity(list[i].title, list[j].title) >= 0.8) pairs.push({ a: list[i].key, b: list[j].key, sim });
      }
    }
    return pairs.sort((x, y) => y.sim - x.sim);
  }

  // ---------------------------------------------------------------- passages ----
  /** Split a long text into overlapping chunks at paragraph/sentence boundaries. */
  function chunk(text, size = 1200, overlap = 200) {
    const out = [];
    let start = 0;
    const t = String(text || "");
    while (start < t.length) {
      let end = Math.min(t.length, start + size);
      if (end < t.length) {
        const window = t.slice(start + size * 0.6, end);
        const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
        if (cut > 0) end = start + Math.floor(size * 0.6) + cut + 1;
      }
      out.push({ i: out.length, start, text: t.slice(start, end).trim() });
      if (end >= t.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    return out.filter((c) => c.text);
  }

  /**
   * The parts of a long text that matter for the given questions, in document order and
   * within a character budget. Short texts are returned unchanged.
   * @param {string} docKey  stable id of the document (e.g. attachment key)
   * @param {string[]} queries  what the reader is looking for (criteria, fields, …)
   */
  async function passages(docKey, text, queries, { budget = 9000, size = 1200 } = {}) {
    text = String(text || "");
    if (text.length <= budget) return text;
    const chunks = chunk(text, size);
    const vecs = await vectors(chunks.map((c) => ({ key: `${docKey}#${c.i}`, text: c.text })));
    const qs = queries.map((q) => String(q || "").trim()).filter(Boolean);
    const qv = qs.length ? await embed(qs, "query") : [];
    // Rank chunks per query, then take them round-robin so every query gets coverage
    const ranked = qv.map((q) => chunks.map((c) => ({ c, s: dot(q, vecs.get(`${docKey}#${c.i}`)) })).sort((a, b) => b.s - a.s));
    const picked = new Map([[0, chunks[0]]]); // the opening (abstract/introduction) gives context
    let used = chunks[0].text.length;
    for (let r = 0; r < chunks.length && used < budget; r++) {
      for (const list of ranked) {
        const c = list[r]?.c;
        if (!c || picked.has(c.i)) continue;
        if (used + c.text.length > budget) continue;
        picked.set(c.i, c);
        used += c.text.length;
      }
    }
    return [...picked.values()]
      .sort((a, b) => a.i - b.i)
      .map((c) => c.text)
      .join("\n[…]\n");
  }

  // ---------------------------------------------------------------- clustering ----
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)), ((s ^= s >>> 16) >>> 0) / 4294967296);
  }

  /** k-means (cosine; k-means++ init, deterministic). Returns {assign: number[], centroids}. */
  function kmeans(vecs, k, { iters = 40, seed = 7 } = {}) {
    const n = vecs.length;
    k = Math.max(1, Math.min(k, n));
    const rand = rng(seed);
    const cents = [vecs[Math.floor(rand() * n)]];
    while (cents.length < k) {
      const d = vecs.map((v) => Math.max(0, 1 - Math.max(...cents.map((c) => dot(c, v)))));
      const total = d.reduce((a, b) => a + b, 0) || 1;
      let r = rand() * total;
      let idx = 0;
      while (idx < n - 1 && (r -= d[idx]) > 0) idx++;
      cents.push(vecs[idx]);
    }
    let assign = new Array(n).fill(0);
    for (let it = 0; it < iters; it++) {
      const next = vecs.map((v) => {
        let best = 0;
        let bs = -Infinity;
        cents.forEach((c, j) => {
          const s = dot(c, v);
          if (s > bs) (bs = s), (best = j);
        });
        return best;
      });
      const changed = next.some((a, i) => a !== assign[i]);
      assign = next;
      for (let j = 0; j < k; j++) {
        const members = vecs.filter((_, i) => assign[i] === j);
        if (!members.length) continue;
        const m = new Float32Array(members[0].length);
        for (const v of members) for (let d = 0; d < m.length; d++) m[d] += v[d];
        cents[j] = normalize(m);
      }
      if (!changed && it) break;
    }
    return { assign, centroids: cents };
  }

  // ---------------------------------------------------- learning from decisions ----
  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

  /**
   * L2-regularised logistic regression with class-balanced weights (few, imbalanced
   * labels are the normal case in screening). X: Float32Array[]; y: 0/1.
   */
  function trainLogistic(X, y, { l2 = 0.05, iters = 250, lr = 1.5 } = {}) {
    const n = X.length;
    const d = X[0].length;
    const pos = y.filter((v) => v === 1).length;
    const wPos = n / (2 * Math.max(1, pos));
    const wNeg = n / (2 * Math.max(1, n - pos));
    const w = new Float64Array(d);
    let b = 0;
    const g = new Float64Array(d);
    for (let it = 0; it < iters; it++) {
      g.fill(0);
      let gb = 0;
      for (let i = 0; i < n; i++) {
        const x = X[i];
        let z = b;
        for (let j = 0; j < d; j++) z += w[j] * x[j];
        const err = (sigmoid(z) - y[i]) * (y[i] ? wPos : wNeg);
        for (let j = 0; j < d; j++) g[j] += err * x[j];
        gb += err;
      }
      for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
      b -= lr * (gb / n);
    }
    return { w, b };
  }

  function predict(model, x) {
    let z = model.b;
    for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
    return sigmoid(z);
  }

  function _reset() {
    caches.clear();
    lastStatus = null;
  }

  return {
    APIS,
    MODELS,
    config,
    prefixes,
    check,
    available,
    isAvailable,
    pull,
    embed,
    vectors,
    paperText,
    paperVectors,
    itemPaper,
    dot,
    normalize,
    nearest,
    duplicates,
    chunk,
    passages,
    kmeans,
    trainLogistic,
    predict,
    sigmoid,
    flush,
    hash,
    toB64,
    fromB64,
    _reset,
    get status() {
      return lastStatus;
    },
  };
})();

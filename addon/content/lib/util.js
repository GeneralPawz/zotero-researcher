/* global ZR, Zotero */
// Shared helpers. Everything here must also run under Node (see test/harness.mjs),
// so Zotero is only touched inside functions that are never called from tests.

ZR.Util = (() => {
  const log = (...args) => {
    const msg = "[Zotero Researcher] " + args.map((a) => (typeof a === "string" ? a : safeJSON(a))).join(" ");
    if (typeof Zotero !== "undefined" && Zotero.debug) Zotero.debug(msg);
    else if (typeof console !== "undefined") console.log(msg);
  };

  function safeJSON(v) {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const STATUS_HINTS = {
    400: "request rejected",
    401: "API key missing or invalid",
    403: "access denied — key invalid or no entitlement (institutional access needed?)",
    404: "not found",
    429: "rate limit or daily quota exceeded — wait, or add an API key in Settings",
  };

  class HTTPError extends Error {
    constructor(status, url, body) {
      const hint = STATUS_HINTS[status] || (status >= 500 ? "server error" : "");
      const host = String(url).match(/^https?:\/\/([^/]+)/)?.[1] || url;
      super(`HTTP ${status}${hint ? ` (${hint})` : ""} from ${host}${body ? ": " + String(body).replace(/\s+/g, " ").slice(0, 200) : ""}`);
      this.status = status;
      this.body = body;
    }
  }

  /**
   * HTTP transport backed by Zotero.HTTP (privileged XHR, no CORS). Returns a small
   * response object; non-2xx statuses throw HTTPError. ZR.http is swappable for tests.
   */
  async function zoteroHTTP(method, url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    let body = options.body;
    if (body && typeof body === "object") {
      body = JSON.stringify(body);
      headers["Content-Type"] ??= "application/json";
    }
    let xhr;
    try {
      xhr = await Zotero.HTTP.request(method, url, {
        headers,
        body,
        timeout: options.timeout ?? 60000,
        successCodes: false,
        errorDelayIntervals: [1500, 4000],
        errorDelayMax: options.noRetry ? 0 : 12000,
        responseType: "text",
      });
    } catch (e) {
      if (e && e.xmlhttp) xhr = e.xmlhttp;
      else throw e;
    }
    const text = xhr.responseText ?? xhr.response ?? "";
    // Some APIs (OpenAlex anonymous pool, Semantic Scholar shared pool) ask clients to
    // come back after a short pause; honour that once when the caller allows it.
    if (xhr.status === 429 && options.retryAfterMax && !options._retried) {
      const wait = retryAfterSeconds(xhr, text);
      if (wait !== null && wait * 1000 <= options.retryAfterMax) {
        log(`429 from ${url.replace(/\?.*/, "")}, retrying in ${wait}s`);
        await sleep(wait * 1000 + 250);
        return zoteroHTTP(method, url, Object.assign({}, options, { _retried: true }));
      }
    }
    if (xhr.status < 200 || xhr.status >= 300) throw new HTTPError(xhr.status, url, text);
    return {
      status: xhr.status,
      text,
      json() {
        return JSON.parse(text);
      },
      header(name) {
        return xhr.getResponseHeader(name);
      },
    };
  }

  function retryAfterSeconds(xhr, text) {
    const h = parseInt(xhr.getResponseHeader?.("Retry-After") || "", 10);
    if (Number.isFinite(h)) return h;
    try {
      const j = JSON.parse(text);
      if (Number.isFinite(j.retryAfter)) return j.retryAfter;
    } catch (e) {
      /* not JSON */
    }
    const m = String(text).match(/retry in (\d+)\s*s/i);
    return m ? parseInt(m[1], 10) : null;
  }

  async function getJSON(url, options = {}) {
    const res = await ZR.http(options.method || "GET", url, options);
    return res.json();
  }

  async function getText(url, options = {}) {
    const res = await ZR.http(options.method || "GET", url, options);
    return res.text;
  }

  function qs(params) {
    const out = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      out.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
    return out.join("&");
  }

  function cleanDOI(s) {
    if (!s) return "";
    const m = String(s).match(/10\.\d{4,9}\/[^\s"<>]+/);
    if (!m) return "";
    return m[0].replace(/[.,;)\]]+$/, "").toLowerCase();
  }

  function stripTags(s) {
    if (!s) return "";
    return String(s)
      .replace(/<\/?(jats:)?[a-z][^>]*>/gi, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeTitle(t) {
    return String(t || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /** Dice coefficient over word bigrams of normalized titles, 0..1. */
  function titleSimilarity(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const grams = (s) => {
      const w = s.split(" ");
      if (w.length === 1) return [s];
      const g = [];
      for (let i = 0; i < w.length - 1; i++) g.push(w[i] + " " + w[i + 1]);
      return g;
    };
    const ga = grams(na);
    const gb = grams(nb);
    const counts = new Map();
    for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
    let hits = 0;
    for (const g of gb) {
      const c = counts.get(g);
      if (c) {
        hits++;
        counts.set(g, c - 1);
      }
    }
    return (2 * hits) / (ga.length + gb.length);
  }

  /** Rebuild abstract text from OpenAlex's abstract_inverted_index. */
  function invertedIndexToText(idx) {
    if (!idx) return "";
    const words = [];
    for (const [word, positions] of Object.entries(idx)) {
      for (const p of positions) words[p] = word;
    }
    return words.filter((w) => w !== undefined).join(" ");
  }

  /** Split "Lastname, First" / "First Lastname" into a Zotero-style creator. */
  function parseName(name) {
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (!name) return null;
    if (name.includes(",")) {
      const [last, ...rest] = name.split(",");
      return { firstName: rest.join(",").trim(), lastName: last.trim() };
    }
    const parts = name.split(" ");
    if (parts.length === 1) return { name, fieldMode: 1 };
    const particles = new Set(["van", "von", "der", "den", "de", "del", "da", "di", "la", "le", "du", "ten", "ter"]);
    let i = parts.length - 1;
    while (i > 1 && particles.has(parts[i - 1].toLowerCase())) i--;
    return { firstName: parts.slice(0, i).join(" "), lastName: parts.slice(i).join(" ") };
  }

  function yearOf(s) {
    const m = String(s ?? "").match(/\b(1[5-9]\d\d|20\d\d|21\d\d)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Extract the first JSON value from an LLM reply (tolerates code fences and prose). */
  function extractJSON(text) {
    if (text == null) throw new Error("Empty LLM response");
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try {
      return JSON.parse(s);
    } catch (e) {
      // fall through to bracket scan
    }
    const start = s.search(/[[{]/);
    if (start < 0) throw new Error("No JSON found in LLM response: " + s.slice(0, 200));
    const open = s[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
    throw new Error("Unterminated JSON in LLM response");
  }

  /** Run async fn over items with bounded concurrency, preserving order. */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function truncate(s, n) {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  return {
    log,
    sleep,
    HTTPError,
    zoteroHTTP,
    getJSON,
    getText,
    qs,
    cleanDOI,
    stripTags,
    escapeHTML,
    normalizeTitle,
    titleSimilarity,
    invertedIndexToText,
    parseName,
    yearOf,
    extractJSON,
    mapLimit,
    truncate,
  };
})();

/* global ZR */
// Activity log: what the plugin is doing behind the scenes - web requests, AI calls,
// CLI runs, local-model calls - with timing, so a slow step can be told apart from a
// stuck one. Kept in memory only (last 400 entries); shown by the Log button.

ZR.Activity = (() => {
  const MAX = 400;
  const entries = [];
  const listeners = new Set();
  let seq = 0;

  /** Thrown into running work when you stop it. */
  class Stopped extends Error {
    constructor(msg = "Stopped by you") {
      super(msg);
      this.name = "Stopped";
      this.stopped = true;
    }
  }
  // While stopping, new requests and CLI runs are refused, so loops wind down fast
  let stopping = false;

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        /* a closed window */
      }
    }
  };

  /**
   * Start an entry. kind: "ai" | "web" | "cli" | "local" | "task".
   * @returns {number} id for end()
   */
  function start(kind, label, detail = "") {
    const e = { id: ++seq, kind, label: String(label), detail: String(detail || ""), started: Date.now(), ended: null, ok: null, result: "" };
    entries.push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    emit();
    return e.id;
  }

  function end(id, { ok = true, result = "" } = {}) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    e.ended = Date.now();
    e.ok = ok;
    e.result = String(result || "");
    emit();
  }

  /** A single finished line (e.g. a progress note). */
  function note(kind, label, detail = "") {
    const id = start(kind, label, detail);
    end(id, { ok: true });
  }

  /** Run fn inside an entry; errors are recorded and re-thrown. fn(setCancel) may register how to cancel it. */
  async function track(kind, label, detail, fn, describe = (r) => "") {
    const id = start(kind, label, detail);
    const entry = entries.find((x) => x.id === id);
    try {
      const r = await fn((cancel) => entry && (entry.cancel = cancel));
      end(id, { ok: true, result: describe(r) });
      return r;
    } catch (e) {
      end(id, { ok: false, result: e?.message || String(e) });
      throw e;
    }
  }

  const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/;

  /** Wrap the HTTP transport so every request shows up in the log. */
  function wrapHTTP(http) {
    return async (method, url, options = {}) => {
      if (stopping) throw new Stopped();
      const short = String(url).replace(/([?&](key|api_key|apikey|token|mailto)=)[^&]+/gi, "$1…").replace(/^https?:\/\//, "");
      const body = options.body && typeof options.body === "object" ? JSON.stringify(options.body) : options.body || "";
      return track(
        LOCAL.test(url) ? "local" : "web",
        `${method} ${short.length > 110 ? short.slice(0, 110) + "…" : short}`,
        body ? "Request: " + body.slice(0, 1500) : "",
        (setCancel) =>
          http(
            method,
            url,
            Object.assign({}, options, {
              cancellerReceiver: (cancel) => {
                setCancel(cancel);
                options.cancellerReceiver?.(cancel);
              },
            })
          ).catch((e) => {
            throw stopping ? new Stopped() : e;
          }),
        (r) => `HTTP ${r.status} · ${r.text.length.toLocaleString()} bytes` + (r.text ? "\n" + r.text.slice(0, 1200) : "")
      );
    };
  }

  /** Cancel one running entry (a request or a CLI run). */
  function cancel(id) {
    const e = entries.find((x) => x.id === id);
    if (!e || e.ended || !e.cancel) return false;
    try {
      e.cancel();
    } catch (err) {
      /* already finished */
    }
    return true;
  }

  /** Stop everything: cancel what runs and refuse new requests until resume(). */
  function stopAll() {
    stopping = true;
    let n = 0;
    for (const e of entries) if (!e.ended && cancel(e.id)) n++;
    emit();
    return n;
  }

  function resume() {
    stopping = false;
  }

  const running = () => entries.filter((e) => !e.ended);
  const list = () => entries.slice();
  const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));

  function clear() {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].ended) entries.splice(i, 1);
    emit();
  }

  /** Plain-text export for bug reports. */
  function text() {
    const t = (ms) => new Date(ms).toISOString().slice(11, 19);
    return entries
      .map((e) => `${t(e.started)} [${e.kind}] ${e.label} · ${e.ended ? `${e.ok ? "ok" : "FAILED"} in ${((e.ended - e.started) / 1000).toFixed(1)} s` : "running"}${e.result ? "\n    " + e.result.split("\n")[0] : ""}`)
      .join("\n");
  }

  return { start, end, note, track, wrapHTTP, running, list, subscribe, clear, text, cancel, stopAll, resume, Stopped, get stopping() { return stopping; } };
})();

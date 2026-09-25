/* global ZR */
// "System 1" relevance scoring: a fast, cheap, calibrated probability that a paper
// belongs in the review — the complement to the LLM ("System 2"), which sets up the
// review and reasons about the uncertain cases.
//
// Engines
//   typesafe – TypeSafe's Jev model (https://docs.typesafe.ai). One request per paper;
//              the paper is the `state`, and each criterion is its own literal yes/no
//              ("noul") question, evaluated in parallel. Probabilities are combined
//              in code, as TypeSafe recommends (no arithmetic or dates in the model).
//   local    – embeddings on this computer (e.g. Ollama): similarity to the protocol at
//              first, then a model that learns from your own screening decisions
//              (active learning) and re-ranks the pool as you screen
//   llm      – the configured LLM profile (slower; confidence mapped to a probability)
//   rules    – keyword rules only: does title/abstract satisfy the review query?
//
// Result per paper: {p, relevance, exclusion, criteria: [{kind, text, p}], suggest: {d, r}, engine, model, at}
//   relevance – P(relevant to the review question)
//   exclusion – max P over exclusion criteria
//   p         – relevance × (1 − exclusion): the chance the paper survives screening
// Once the local model has learned from enough of your decisions, TypeSafe/LLM results are
// blended with it (pref s1Blend): p = ½ (base + learned); base is kept for re-blending.

ZR.System1 = (() => {
  const U = ZR.Util;
  const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

  const ENGINES = [
    { id: "typesafe", name: "TypeSafe Jev — System 1 model (fast, calibrated, API key)", keyURL: "https://console.typesafe.ai/", docsURL: "https://docs.typesafe.ai/" },
    { id: "local", name: "Local model on this computer — learns from your decisions (free, offline)" },
    { id: "llm", name: "Your AI provider (slower; reasons instead of estimating)" },
    { id: "rules", name: "Keyword rules only (no AI)" },
  ];

  const keyName = "s1:typesafe";
  const apiKey = () => ZR.Secrets.get(keyName);
  const model = () => ZR.Prefs.get("s1Model", "jev-latest") || "jev-latest";

  /** Engine to use: the setting, or the best available one. */
  function engine() {
    const chosen = ZR.Prefs.get("s1Engine", "");
    const local = ZR.Embed?.isAvailable();
    if (chosen === "typesafe" && apiKey()) return "typesafe";
    if (chosen === "local" && local) return "local";
    if (chosen === "llm" && ZR.Prefs.getActiveLLMProfile()) return "llm";
    if (chosen === "rules") return "rules";
    if (apiKey()) return "typesafe";
    if (local) return "local";
    if (ZR.Prefs.getActiveLLMProfile()) return "llm";
    return "rules";
  }

  /** Suggestion from a probability (and the strongest exclusion criterion, if any). */
  function suggestFor(p, protocol, worst) {
    if (worst && worst.p >= 0.6) return { d: "exclude", r: worst.text };
    if (p < 0.3) return { d: "exclude", r: (protocol.reasons || [])[0] || "Off topic" };
    if (p >= 0.7) return { d: "include", r: "" };
    return { d: "maybe", r: "" };
  }

  // --------------------------------------------------------------- TypeSafe ----
  /** Only the fields a relevance decision needs (TypeSafe: filter state first). */
  function paperState(c) {
    const s = { title: c.title || "", abstract: U.truncate(c.abstract || "(no abstract available)", 3000) };
    if (c.venue) s.venue = c.venue;
    if (c.itemType) s.publication_type = c.itemType;
    if (c.record?.keywords?.length) s.keywords = c.record.keywords.slice(0, 12).join("; ");
    return s;
  }

  function reviewContext(protocol) {
    const ctx = {};
    if (protocol.questions?.length) ctx.research_questions = protocol.questions;
    if (protocol.objective) ctx.objective = protocol.objective;
    const fw = ZR.Methodologies.FRAMEWORKS[protocol.framework];
    for (const f of fw?.fields || []) if (protocol.frameworkFields?.[f.id]) ctx[f.label] = protocol.frameworkFields[f.id];
    return ctx;
  }

  /** Typed questions for one paper: overall relevance + one literal question per criterion. */
  function buildQuestions(protocol) {
    const q = {
      relevant: {
        type: "noul",
        instructions: {
          review: reviewContext(protocol),
          question: "Is the paper in `state` relevant to the literature review described in `review`, so that a reviewer would keep it for full-text reading?",
        },
        criteria: {
          true: "The paper's own topic addresses the review's research questions",
          false: "The paper is about something else, or mentions the review topic only in passing",
        },
      },
    };
    (protocol.inclusion || []).forEach((text, i) => {
      q[`inc_${i}`] = {
        type: "noul",
        instructions: `Does the paper in \`state\` meet this inclusion criterion: "${text}"?`,
        criteria: { true: "The title or abstract shows the criterion is met", false: "The criterion is not met, or nothing indicates it" },
      };
    });
    (protocol.exclusion || []).forEach((text, i) => {
      q[`exc_${i}`] = {
        type: "noul",
        instructions: `Does the paper in \`state\` match this exclusion criterion: "${text}"?`,
        criteria: { true: "The title or abstract shows the paper matches it", false: "The paper does not match it" },
      };
    });
    return q;
  }

  /** Combine per-question probabilities in code. */
  function combine(protocol, get) {
    const relevance = get("relevant");
    const criteria = [];
    (protocol.inclusion || []).forEach((text, i) => criteria.push({ kind: "include", text, p: get(`inc_${i}`) }));
    (protocol.exclusion || []).forEach((text, i) => criteria.push({ kind: "exclude", text, p: get(`exc_${i}`) }));
    const excl = criteria.filter((c) => c.kind === "exclude" && c.p != null);
    const exclusion = excl.length ? Math.max(...excl.map((c) => c.p)) : 0;
    const p = Math.max(0, Math.min(1, (relevance ?? 0.5) * (1 - exclusion)));
    const worst = excl.sort((a, b) => b.p - a.p)[0];
    const suggest = suggestFor((relevance ?? 0.5) < 0.3 ? 0 : p, protocol, worst);
    return { p, relevance, exclusion, criteria, suggest };
  }

  async function scoreOneTypeSafe(c, protocol, questions, key) {
    const res = await ZR.http("POST", ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      body: { state: paperState(c), model: model(), questions },
      timeout: 30000,
      retryAfterMax: 20000,
    });
    const data = res.json();
    const get = (id) => (typeof data.answers?.[id]?.noul === "number" ? data.answers[id].noul : null);
    return Object.assign(combine(protocol, get), { engine: "typesafe", model: data.model, tokens: data.usage?.input_tokens || 0 });
  }

  // ------------------------------------------------------------ fallbacks ----
  async function scoreLLM(cands, protocol, onProgress) {
    const profile = ZR.Prefs.getActiveLLMProfile();
    if (!profile) throw new Error("No AI provider set up");
    const review = { question: (protocol.questions || []).join(" ") || protocol.objective, include: (protocol.inclusion || []).join("; "), exclude: (protocol.exclusion || []).join("; "), reasons: protocol.reasons };
    const papers = cands.map((c) => ({ title: c.title, year: c.year, venue: c.venue, abstract: c.abstract }));
    const out = await ZR.Assist.screenCriteria(profile, review, papers, "ta", { onProgress });
    const results = {};
    cands.forEach((c, i) => {
      const o = out[i];
      if (!o) return;
      const p = o.d === "include" ? 0.5 + o.c / 2 : o.d === "exclude" ? 0.5 - o.c / 2 : 0.5;
      results[c.key] = { p, relevance: p, exclusion: 0, criteria: [], suggest: { d: o.d, r: o.r }, why: o.why, engine: "llm", model: profile.model };
    });
    return results;
  }

  function scoreRules(cands, protocol) {
    let ast = null;
    try {
      ast = ZR.Query.parse(protocol.query || "");
    } catch (e) {
      /* no usable query */
    }
    const results = {};
    for (const c of cands) {
      const hit = ast ? ZR.Query.matches(ast, { title: c.title, abstract: c.abstract, keywords: c.record?.keywords }) : null;
      const p = hit == null ? 0.5 : hit ? 0.7 : 0.2;
      results[c.key] = { p, relevance: p, exclusion: 0, criteria: [], suggest: { d: hit === false ? "exclude" : "maybe", r: hit === false ? "Off topic" : "" }, engine: "rules", model: "query match" };
    }
    return results;
  }

  // ---------------------------------------------------------- local model ----
  const MIN_LABELS = 3; // of each class before the learned model replaces plain similarity

  /** What the review is looking for, as one query text. */
  function protocolQuery(protocol) {
    const fw = ZR.Methodologies.FRAMEWORKS[protocol.framework];
    const parts = [...(protocol.questions || []), protocol.objective, ...(fw?.fields || []).map((f) => protocol.frameworkFields?.[f.id]), ...(protocol.inclusion || [])];
    return parts.filter(Boolean).join("\n") || protocol.query || "";
  }

  /** Screening decisions made by the reviewer (not by System 1 or the AI) — the training labels. */
  const isLabel = (c) => (c.ta === "include" || c.ta === "exclude") && !["s1", "llm", "dup"].includes(c.by);

  /**
   * Local relevance for candidates. Before enough labels: similarity to the protocol,
   * spread into a probability by its z-score within the pool (a ranking, not calibrated).
   * After: logistic regression on the embeddings of the papers the reviewer decided.
   * @param {object[]} cands  papers to rate
   * @param {object[]} all    every paper of the review (labels and similarity statistics)
   */
  async function learn(cands, protocol, all = cands, { onProgress } = {}) {
    const E = ZR.Embed;
    const union = new Map();
    for (const c of [...all, ...cands]) union.set(c.key, c);
    const vecs = await E.paperVectors([...union.values()], { onProgress: (d, n) => onProgress?.(d, n, "embedding") });
    const [qv] = await E.embed([protocolQuery(protocol)], "query");
    const sims = new Map();
    for (const [key, v] of vecs) sims.set(key, E.dot(qv, v));
    const labeled = [...union.values()].filter((c) => isLabel(c) && vecs.has(c.key));
    const pos = labeled.filter((c) => c.ta === "include").length;
    const neg = labeled.length - pos;
    const trained = pos >= MIN_LABELS && neg >= MIN_LABELS;
    // Embeddings of one field share a large common direction; centring on the pool's mean
    // leaves what distinguishes the papers, which is what a handful of labels can learn.
    const mu = new Float32Array(qv.length);
    for (const v of vecs.values()) for (let j = 0; j < mu.length; j++) mu[j] += v[j] / vecs.size;
    const centred = (v) => E.normalize(v.map((x, j) => x - mu[j]));
    const model = trained ? E.trainLogistic(labeled.map((c) => centred(vecs.get(c.key))), labeled.map((c) => (c.ta === "include" ? 1 : 0))) : null;
    const vals = [...sims.values()];
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 0.05;
    const results = {};
    for (const c of cands) {
      const v = vecs.get(c.key);
      if (!v) continue;
      const sim = sims.get(c.key);
      const p = trained ? E.predict(model, centred(v)) : E.sigmoid((1.6 * (sim - mean)) / sd - 0.4);
      results[c.key] = { p, sim };
    }
    return { results, trained, labels: labeled.length, pos, neg };
  }

  async function scoreLocal(cands, protocol, all, onProgress) {
    const cfg = ZR.Embed.config();
    const { results, trained, labels } = await learn(cands, protocol, all, { onProgress });
    const out = {};
    for (const [key, r] of Object.entries(results)) {
      out[key] = {
        p: r.p,
        relevance: r.p,
        exclusion: 0,
        criteria: [],
        similarity: r.sim,
        suggest: suggestFor(r.p, protocol),
        engine: "local",
        model: trained ? `${cfg.model} · learned from ${labels} decisions` : `${cfg.model} · similarity to the protocol`,
        trained,
        labels,
      };
    }
    return out;
  }

  /** Blend TypeSafe/LLM results with the learned local model (once it is trained). */
  async function blend(results, cands, protocol, all) {
    if (ZR.Prefs.get("s1Blend", true) === false || !ZR.Embed || !(await ZR.Embed.available())) return results;
    const rated = cands.filter((c) => results[c.key]);
    if (!rated.length) return results;
    const { results: learned, trained, labels } = await learn(rated, protocol, all);
    if (!trained) return results;
    for (const c of rated) {
      const r = results[c.key];
      const l = learned[c.key];
      if (!l) continue;
      r.base = r.base ?? r.p;
      r.learned = l.p;
      r.p = (r.base + l.p) / 2;
      r.labels = labels;
      const worst = (r.criteria || []).filter((k) => k.kind === "exclude" && k.p != null).sort((a, b) => b.p - a.p)[0];
      r.suggest = suggestFor(r.p, protocol, worst);
    }
    return results;
  }

  /**
   * Re-rank after new decisions (active learning): local results are recomputed, blended
   * results re-blended from their stored base. Uses cached embeddings — fast.
   * @returns {Promise<{results, trained, labels}>} updated results for rated `cands`
   */
  async function relearn(cands, protocol, all = cands) {
    const at = new Date().toISOString().slice(0, 10);
    const withS1 = cands.filter((c) => c.s1);
    const local = withS1.filter((c) => c.s1.engine === "local");
    const other = withS1.filter((c) => c.s1.engine === "typesafe" || c.s1.engine === "llm");
    const out = {};
    let info = { trained: false, labels: 0 };
    if (local.length) {
      const res = await scoreLocal(local, protocol, all);
      Object.assign(out, stamp(res, at));
      const any = Object.values(res)[0];
      if (any) info = { trained: any.trained, labels: any.labels };
    }
    if (other.length) {
      const base = {};
      for (const c of other) base[c.key] = Object.assign({}, c.s1, { p: c.s1.base ?? c.s1.p, base: undefined });
      const res = await blend(base, other, protocol, all);
      for (const c of other) if (res[c.key].learned != null) out[c.key] = res[c.key];
      const any = Object.values(res).find((r) => r.learned != null);
      if (any) info = { trained: true, labels: any.labels };
    }
    return Object.assign({ results: out }, info);
  }

  /**
   * Score candidates. Returns {key: result}; failures are skipped (reported via onError).
   * @param {object[]} cands  candidates (see ZR.Projects.candidates)
   */
  async function score(cands, protocol, { engine: eng = engine(), concurrency = 8, onProgress = () => {}, onError = () => {}, all = cands } = {}) {
    const at = new Date().toISOString().slice(0, 10);
    if (eng === "rules") return stamp(scoreRules(cands, protocol), at);
    if (eng === "local") return stamp(await scoreLocal(cands, protocol, all, onProgress), at);
    if (eng === "llm") return stamp(await blend(await scoreLLM(cands, protocol, onProgress), cands, protocol, all), at);
    const key = apiKey();
    if (!key) throw new Error("TypeSafe API key missing — add it under Settings → System 1 model");
    const questions = buildQuestions(protocol);
    const results = {};
    let done = 0;
    await U.mapLimit(cands, concurrency, async (c) => {
      try {
        results[c.key] = await scoreOneTypeSafe(c, protocol, questions, key);
      } catch (e) {
        onError(c, e);
      }
      onProgress(++done, cands.length);
    });
    return stamp(await blend(results, cands, protocol, all), at);
  }

  function stamp(results, at) {
    for (const r of Object.values(results)) r.at = at;
    return results;
  }

  /** Connection test for Settings. */
  async function test(key = apiKey()) {
    const t0 = Date.now();
    const res = await ZR.http("POST", ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      body: { state: "A study of IFC-based data exchange between BIM authoring tools.", model: model(), questions: { bim: { type: "noul", instructions: "Is this about building information modelling?" } } },
      timeout: 20000,
      noRetry: true,
    });
    const data = res.json();
    return { ok: typeof data.answers?.bim?.noul === "number", p: data.answers?.bim?.noul, model: data.model, ms: Date.now() - t0 };
  }

  return { ENGINES, ENDPOINT, keyName, MIN_LABELS, engine, buildQuestions, paperState, combine, score, relearn, learn, protocolQuery, isLabel, test };
})();

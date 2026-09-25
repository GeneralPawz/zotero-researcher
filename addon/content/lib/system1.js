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
//   llm      – the configured LLM profile (slower; confidence mapped to a probability)
//   rules    – keyword rules only: does title/abstract satisfy the review query?
//
// Result per paper: {p, relevance, exclusion, criteria: [{kind, text, p}], suggest: {d, r}, engine, model, at}
//   relevance – P(relevant to the review question)
//   exclusion – max P over exclusion criteria
//   p         – relevance × (1 − exclusion): the chance the paper survives screening

ZR.System1 = (() => {
  const U = ZR.Util;
  const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

  const ENGINES = [
    { id: "typesafe", name: "TypeSafe Jev — System 1 model (fast, calibrated, API key)", keyURL: "https://console.typesafe.ai/", docsURL: "https://docs.typesafe.ai/" },
    { id: "llm", name: "Your AI provider (slower; reasons instead of estimating)" },
    { id: "rules", name: "Keyword rules only (no AI)" },
  ];

  const keyName = "s1:typesafe";
  const apiKey = () => ZR.Secrets.get(keyName);
  const model = () => ZR.Prefs.get("s1Model", "jev-latest") || "jev-latest";

  /** Engine to use: the setting, or the best available one. */
  function engine() {
    const chosen = ZR.Prefs.get("s1Engine", "");
    if (chosen === "typesafe" && apiKey()) return "typesafe";
    if (chosen === "llm" && ZR.Prefs.getActiveLLMProfile()) return "llm";
    if (chosen === "rules") return "rules";
    if (apiKey()) return "typesafe";
    if (ZR.Prefs.getActiveLLMProfile()) return "llm";
    return "rules";
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
    let suggest;
    if (worst && worst.p >= 0.6) suggest = { d: "exclude", r: worst.text };
    else if ((relevance ?? 0.5) < 0.3) suggest = { d: "exclude", r: (protocol.reasons || [])[0] || "Off topic" };
    else if (p >= 0.7) suggest = { d: "include", r: "" };
    else suggest = { d: "maybe", r: "" };
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

  /**
   * Score candidates. Returns {key: result}; failures are skipped (reported via onError).
   * @param {object[]} cands  candidates (see ZR.Projects.candidates)
   */
  async function score(cands, protocol, { engine: eng = engine(), concurrency = 8, onProgress = () => {}, onError = () => {} } = {}) {
    const at = new Date().toISOString().slice(0, 10);
    if (eng === "rules") return stamp(scoreRules(cands, protocol), at);
    if (eng === "llm") return stamp(await scoreLLM(cands, protocol, onProgress), at);
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
    return stamp(results, at);
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

  return { ENGINES, ENDPOINT, keyName, engine, buildQuestions, paperState, combine, score, test };
})();

/* global ZR */
// Autopilot: a "harness" model that runs a structured review with you, step by step.
//
// The harness does not see everything - it gets condensed numbers and small samples
// (to save tokens) and returns small JSON decisions. The deterministic parts stay in
// code: System 1 rates papers, the annotation model reads full texts, the plugin applies
// decisions. At every consequential point the harness asks you (see dialog/autopilot.js).

ZR.Autopilot = (() => {
  const U = ZR.Util;

  // ------------------------------------------------------------------ setup ----
  /** Draft the protocol for the best-fitting methodology. */
  async function chooseMethodology(profile, question, context = {}) {
    // a short answer first, then the form is filled once (not once for PRISMA and again for the methodology that fits)
    const rec = await ZR.Assist.recommendMethodology(profile, question);
    const out = await ZR.Assist.fillProtocol(profile, rec.methodology, question, context);
    return { methodology: rec.methodology, protocol: out.protocol, why: rec.why || out.recommended?.why || "", rationale: out.rationale || "" };
  }

  /** Which databases to search and how many results per source. */
  async function planSearch(profile, protocol, sources) {
    const list = sources.map((s) => `${s.id}: ${s.name} · ${U.truncate(s.coverage || "", 110)} (${s.access})`).join("\n");
    const user = `Review questions: ${(protocol.questions || []).join(" | ") || protocol.objective}\nQuery: ${protocol.query}\n\nAvailable databases (id: name · coverage):\n${list}\n\nPick the databases that cover this topic well (usually 3-6; include multidisciplinary ones) and a number of results per database (10-200) that keeps screening manageable.\n\nReply with JSON only: {"sources": ["<id>", …], "limit": <int>, "why": "<one sentence>"}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system: "You plan literature searches for systematic reviews.", maxTokens: 1500 });
    const ids = new Set(sources.map((s) => s.id));
    const chosen = (Array.isArray(out?.sources) ? out.sources : []).filter((id) => ids.has(id));
    return { sources: chosen.length ? chosen : sources.slice(0, 4).map((s) => s.id), limit: Math.max(5, Math.min(500, parseInt(out?.limit, 10) || 50)), why: String(out?.why || "") };
  }

  // -------------------------------------------------------------- screening ----
  /** Condensed picture of a System 1 rating (numbers, not papers). */
  function screeningSummary(cands, { excludeBelow, includeAbove }) {
    const rated = cands.filter((c) => c.s1);
    const bins = new Array(10).fill(0);
    for (const c of rated) bins[Math.min(9, Math.floor(c.s1.p * 10))]++;
    const suggest = { include: 0, maybe: 0, exclude: 0 };
    const reasons = {};
    for (const c of rated) {
      const d = c.s1.suggest?.d || "maybe";
      suggest[d] = (suggest[d] || 0) + 1;
      if (d === "exclude") reasons[c.s1.suggest.r || "?"] = (reasons[c.s1.suggest.r || "?"] || 0) + 1;
    }
    // Mean probability per criterion shows which question drives the verdicts
    const crit = {};
    for (const c of rated)
      for (const k of c.s1.criteria || []) {
        if (k.p == null || k.code) continue;
        const key = `${k.kind}: ${k.text}`;
        crit[key] = crit[key] || { sum: 0, n: 0 };
        crit[key].sum += k.p;
        crit[key].n++;
      }
    const sorted = rated.slice().sort((a, b) => b.s1.p - a.s1.p);
    const brief = (c) => ({ title: U.truncate(c.title, 110), p: Math.round(c.s1.p * 100) / 100 });
    return {
      pool: cands.length,
      rated: rated.length,
      histogram: bins,
      belowExclude: rated.filter((c) => c.s1.p < excludeBelow).length,
      aboveInclude: rated.filter((c) => c.s1.p >= includeAbove).length,
      middle: rated.filter((c) => c.s1.p >= excludeBelow && c.s1.p < includeAbove).length,
      suggest,
      topExclusionReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5),
      criteriaMean: Object.fromEntries(Object.entries(crit).map(([k, v]) => [k, Math.round((v.sum / v.n) * 100) / 100])),
      highest: sorted.slice(0, 6).map(brief),
      lowest: sorted.slice(-6).map(brief),
    };
  }

  /** A few papers in detail, for the drill-down. */
  function screeningSample(cands, n = 8) {
    const rated = cands.filter((c) => c.s1).sort((a, b) => a.s1.p - b.s1.p);
    const pick = [...rated.slice(0, Math.ceil(n / 2)), ...rated.slice(Math.floor(rated.length / 2), Math.floor(rated.length / 2) + Math.floor(n / 2))];
    return pick.map((c) => ({
      title: c.title,
      abstract: U.truncate(c.abstract || "(no abstract)", 450),
      p: Math.round(c.s1.p * 100) / 100,
      criteria: (c.s1.criteria || []).filter((k) => k.p != null).map((k) => `${k.kind} "${U.truncate(k.text, 90)}": ${Math.round(k.p * 100)}%`),
      suggestion: c.s1.suggest ? `${c.s1.suggest.d}${c.s1.suggest.r ? ": " + c.s1.suggest.r : ""}` : "",
    }));
  }

  function normalizeChanges(ch, protocol) {
    const out = {};
    if (!ch || typeof ch !== "object") return out;
    if (typeof ch.query === "string" && ch.query.trim() && ch.query.trim() !== protocol.query) {
      try {
        ZR.Query.parse(ch.query);
        out.query = ch.query.trim();
      } catch (e) {
        /* an unusable query is dropped */
      }
    }
    const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : null);
    if (list(ch.inclusion)) out.inclusion = list(ch.inclusion);
    if (list(ch.exclusion)) out.exclusion = list(ch.exclusion);
    const t = ch.thresholds;
    if (t && Number.isFinite(Number(t.excludeBelow)) && Number.isFinite(Number(t.includeAbove))) {
      const lo = Math.max(0, Math.min(1, Number(t.excludeBelow)));
      const hi = Math.max(0, Math.min(1, Number(t.includeAbove)));
      if (lo < hi) out.thresholds = { excludeBelow: lo, includeAbove: hi };
    }
    return out;
  }

  /**
   * Is the System 1 outcome plausible? First from the numbers; the harness may ask for a
   * drill-down into sample papers before it judges.
   * @returns {{verdict: "ok"|"adjust"|"hopeless", explanation, message, changes, drilldown: boolean}}
   */
  async function assessScreening(profile, protocol, summary, getSample, { attempt = 0 } = {}) {
    const system =
      "You supervise the title/abstract screening of a systematic literature review. A fast System 1 model has rated every paper in the pool with a probability of passing screening. " +
      "Judge whether the outcome is plausible for the research question. Too many or all papers rejected usually means over-strict or badly worded criteria (for example an exclusion criterion that is just the negation of an inclusion criterion, or one that matches most papers) or a search that missed the topic. " +
      "Nearly everything accepted means criteria that are too loose. Propose concrete, minimal changes. Keep criteria literal and checkable from a title and abstract.";
    const base = `Research questions: ${(protocol.questions || []).join(" | ") || protocol.objective}\nInclusion criteria: ${JSON.stringify(protocol.inclusion || [])}\nExclusion criteria: ${JSON.stringify(protocol.exclusion || [])}\nSearch query: ${protocol.query}\nAttempt: ${attempt + 1} of 3\n\nSystem 1 outcome (condensed): ${JSON.stringify(summary)}`;
    const answer = `Reply with JSON only: {"drilldown": <true if you need to see sample papers before judging>, "verdict": "ok"|"adjust"|"hopeless", "explanation": "<2-4 sentences on what you see and why>", "message": "<what you propose to the user, 1-3 sentences>", "changes": {"query": "<new boolean query or empty>", "inclusion": [<full new list or omit>], "exclusion": [<full new list or omit>], "thresholds": {"excludeBelow": <0-1>, "includeAbove": <0-1>} or omit}}`;
    let out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: `${base}\n\n${answer}` }], { system, maxTokens: 3000 });
    let drilled = false;
    if (out?.drilldown && getSample) {
      drilled = true;
      const sample = getSample();
      out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: `${base}\n\nSample papers with their System 1 ratings:\n${JSON.stringify(sample, null, 1)}\n\nNow judge (no further drill-down).\n${answer}` }], { system, maxTokens: 3000 });
    }
    const verdict = ["ok", "adjust", "hopeless"].includes(out?.verdict) ? out.verdict : "ok";
    return { verdict, explanation: String(out?.explanation || ""), message: String(out?.message || ""), changes: normalizeChanges(out?.changes, protocol), drilldown: drilled };
  }

  // ------------------------------------------------------------- full text ----
  /**
   * Full-text decisions from the annotations (condensed: verdict counts, short quotes and comments).
   * @param {{key, title, hasPDF, annotations: {kind, text, comment, isBot}[]}[]} papers
   */
  async function decideFullText(profile, protocol, papers) {
    const reasons = protocol.reasons?.length ? protocol.reasons : ZR.Methodologies.DEFAULT_REASONS;
    const brief = papers.map((p, i) => ({
      i,
      title: U.truncate(p.title, 120),
      pdf: p.hasPDF,
      evidence: (p.annotations || []).slice(0, 12).map((a) => `[${a.kind || "untagged"}${a.isBot ? "" : ", human"}] "${U.truncate(a.text, 180)}"${a.comment ? ": " + U.truncate(a.comment, 120) : ""}`),
    }));
    const user = `Research questions: ${(protocol.questions || []).join(" | ") || protocol.objective}\nInclusion criteria: ${JSON.stringify(protocol.inclusion || [])}\nExclusion criteria: ${JSON.stringify(protocol.exclusion || [])}\nAllowed exclusion reasons: ${JSON.stringify(reasons)}\n\nPapers with their full-text annotations:\n${JSON.stringify(brief, null, 1)}\n\nDecide for each paper with a PDF whether it is included at full-text stage. Human annotations weigh more than the AI's. Papers without PDF: decision "none".\nReply with JSON only: {"decisions": [{"i": <index>, "decision": "include"|"exclude"|"none", "reason": "<one allowed exclusion reason, or empty>", "why": "<max 25 words>"}, …], "summary": "<2-3 sentences for the user>"}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system: "You make full-text eligibility decisions in a systematic review from annotated evidence. Be consistent with the criteria and say why.", maxTokens: 4000 });
    const decisions = [];
    for (const row of Array.isArray(out?.decisions) ? out.decisions : []) {
      const p = papers[row.i];
      if (!p || !["include", "exclude"].includes(row.decision)) continue;
      const r = row.decision === "exclude" ? reasons.find((x) => x.toLowerCase() === String(row.reason || "").toLowerCase()) || String(row.reason || reasons[0]) : "";
      decisions.push({ key: p.key, d: row.decision, r, why: String(row.why || "") });
    }
    return { decisions, summary: String(out?.summary || "") };
  }

  /** Annotation verdicts that System 1 disagrees with (p = P(passage supports inclusion)). */
  function discrepancies(annotations, scores, { low = 0.35, high = 0.65 } = {}) {
    const out = [];
    for (const a of annotations) {
      const p = scores[a.key];
      if (p == null || !a.kind || a.kind === "maybe") continue;
      if ((a.kind === "include" && p < low) || (a.kind === "exclude" && p > high)) out.push(Object.assign({}, a, { p }));
    }
    return out;
  }

  /** The harness re-reads the flagged annotations and corrects verdicts where needed. */
  async function reviewDiscrepancies(profile, protocol, flagged) {
    const list = flagged.map((a, i) => ({ i, paper: U.truncate(a.paperTitle || "", 90), verdict: a.kind, systemOne: Math.round(a.p * 100) + "% supports inclusion", passage: U.truncate(a.text, 300), comment: U.truncate(a.comment, 160) }));
    const user = `Research questions: ${(protocol.questions || []).join(" | ") || protocol.objective}\nInclusion criteria: ${JSON.stringify(protocol.inclusion || [])}\nExclusion criteria: ${JSON.stringify(protocol.exclusion || [])}\n\nThe annotation model tagged these passages; a System 1 model disagrees:\n${JSON.stringify(list, null, 1)}\n\nFor each, decide the correct verdict.\nReply with JSON only: {"corrections": [{"i": <index>, "verdict": "include"|"maybe"|"exclude"|"keep", "why": "<max 20 words>"}, …]}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system: "You arbitrate between two models' judgements of evidence in a literature review.", maxTokens: 3000 });
    const res = [];
    for (const row of Array.isArray(out?.corrections) ? out.corrections : []) {
      const a = flagged[row.i];
      if (!a) continue;
      const v = ["include", "maybe", "exclude"].includes(row.verdict) ? row.verdict : "keep";
      res.push({ key: a.key, from: a.kind, to: v === "keep" ? a.kind : v, why: String(row.why || "") });
    }
    return res;
  }

  /**
   * A new autopilot run starts a new conversation. The finished one is kept (newest
   * first, at most 30) and can be read again. Mutates pool; returns the sessions.
   */
  function archiveSession(pool) {
    const log = pool.autopilotLog || [];
    const sessions = (pool.autopilotSessions = pool.autopilotSessions || []);
    if (log.length) {
      const head = log.find((m) => m.kind === "start") || {};
      sessions.unshift({ id: "s" + log[0].at.replace(/\D/g, ""), started: log[0].at, ended: log[log.length - 1].at, from: head.from || log.find((m) => m.stage)?.stage || "", model: head.model || "", count: log.length, log });
      sessions.splice(30);
    }
    pool.autopilotLog = [];
    return sessions;
  }

  return { archiveSession, chooseMethodology, planSearch, screeningSummary, screeningSample, normalizeChanges, assessScreening, decideFullText, discrepancies, reviewDiscrepancies };
})();

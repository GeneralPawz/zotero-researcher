/* global ZR */
// LLM-backed research tasks. Every function returns plain data so callers can show,
// edit, or discard what the model proposed; nothing here writes to the library.

ZR.Assist = (() => {
  const U = ZR.Util;

  const QUERY_SYNTAX = `Boolean syntax: AND, OR, NOT (uppercase), parentheses, "quoted phrases", trailing * for prefix wildcard, and optional field prefixes title:, abstract:, author:. Example: ("IFC 5" OR IFCX OR "industry foundation classes") AND (BIM OR "building information model*") NOT title:survey`;

  /** Turn a natural-language research request into a structured boolean query. */
  async function planQuery(profile, request, { today = new Date().toISOString().slice(0, 10) } = {}) {
    const system =
      "You are a research librarian who writes precise, high-recall boolean search strings for scholarly databases (OpenAlex, Scopus, Web of Science, arXiv). " +
      "Expand acronyms and add common synonyms and spelling variants, but keep the query focused on the user's topic. " +
      QUERY_SYNTAX;
    const user = `Today is ${today}. Research request:\n"""${request}"""\n\nReply with JSON only:\n{"query": "<boolean query>", "yearFrom": <int|null>, "yearTo": <int|null>, "concepts": ["<key concept>", ...], "rationale": "<one or two sentences>"}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 2048 });
    if (!out || typeof out.query !== "string" || !out.query.trim()) throw new Error("LLM did not return a query");
    // Validate by parsing; fall back to the positive keywords when the model's syntax is off.
    try {
      ZR.Query.parse(out.query);
    } catch (e) {
      U.log("LLM query did not parse, sanitizing", out.query, e.message);
      out.query = out.query.replace(/[()]/g, " ");
    }
    return {
      query: out.query.trim(),
      yearFrom: Number.isInteger(out.yearFrom) ? out.yearFrom : null,
      yearTo: Number.isInteger(out.yearTo) ? out.yearTo : null,
      concepts: Array.isArray(out.concepts) ? out.concepts.map(String) : [],
      rationale: String(out.rationale || ""),
    };
  }

  /**
   * Score each record's relevance to the request (0-10). Mutates records with
   * .llmScore and .llmReason. Batches to keep prompts small.
   */
  async function screen(profile, request, records, { batchSize = 12, onProgress } = {}) {
    const system =
      "You screen search results for a systematic literature review. Judge relevance strictly from title, venue, year, and abstract. " +
      "Score 0-10: 9-10 directly on topic, 6-8 clearly relevant, 3-5 tangential, 0-2 off-topic. Be calibrated and concise.";
    let done = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const list = batch
        .map(
          (r, j) =>
            `[${j}] ${r.title} (${r.year || "n.d."}; ${U.truncate(r.venue, 80)})\n${U.truncate(r.abstract || "(no abstract)", 900)}`
        )
        .join("\n\n");
      const user = `Research request:\n"""${request}"""\n\nPapers:\n${list}\n\nReply with JSON only: [{"i": <index>, "score": <0-10>, "reason": "<max 20 words>"}, ...] covering every index.`;
      try {
        const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 3000 });
        const arr = Array.isArray(out) ? out : out.results || [];
        for (const row of arr) {
          const r = batch[row.i];
          if (!r) continue;
          r.llmScore = Math.max(0, Math.min(10, Number(row.score) || 0));
          r.llmReason = String(row.reason || "");
        }
      } catch (e) {
        U.log("Screening batch failed", e.message);
        for (const r of batch) if (r.llmScore == null) r.llmReason = "screening failed: " + e.message;
      }
      done += batch.length;
      onProgress?.(done, records.length);
    }
    return records;
  }

  /**
   * PRISMA screening suggestion against the review's criteria.
   * @param {{question, include, exclude, reasons: string[]}} review
   * @param {{title, year, venue, abstract, fulltext?}[]} papers
   * @param {"ta"|"ft"} stage  title/abstract or full text
   * @returns {Promise<{d: "include"|"exclude"|"maybe", r: string, c: number, why: string}[]>} aligned with papers
   */
  async function screenCriteria(profile, review, papers, stage = "ta", { batchSize, onProgress } = {}) {
    batchSize = batchSize || (stage === "ft" ? 2 : 10);
    const reasons = review.reasons?.length ? review.reasons : ["Off topic"];
    const system =
      `You assist with ${stage === "ft" ? "full-text eligibility assessment" : "title/abstract screening"} in a PRISMA 2020 systematic review. ` +
      "Apply the criteria literally. At title/abstract stage, be inclusive when information is missing (answer maybe or include): exclusion needs clear evidence. " +
      "At full-text stage, decide include or exclude. Never invent content that is not in the text.";
    const criteria = `Review question: ${review.question || "(not stated)"}\nInclusion criteria: ${review.include || "(not stated)"}\nExclusion criteria: ${review.exclude || "(not stated)"}\nAllowed exclusion reasons: ${reasons.map((r) => `"${r}"`).join(", ")}`;
    const out = new Array(papers.length).fill(null);
    for (let i = 0; i < papers.length; i += batchSize) {
      if (ZR.Activity?.stopping) break;
      const batch = papers.slice(i, i + batchSize);
      const list = batch
        .map(
          (p, j) =>
            `[${j}] ${p.title} (${p.year || "n.d."}; ${U.truncate(p.venue || "", 80)})\nAbstract: ${U.truncate(p.abstract || "(none)", 1500)}` +
            (stage === "ft" && p.fulltext ? `\nFull text (excerpt): ${U.truncate(p.fulltext, 9000)}` : "")
        )
        .join("\n\n");
      const user = `${criteria}\n\nPapers:\n${list}\n\nReply with JSON only: [{"i": <index>, "decision": "include"|"exclude"|"maybe", "reason": "<one allowed exclusion reason, or empty>", "confidence": <0-1>, "why": "<max 25 words>"}, ...] covering every index.`;
      try {
        const res = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 4000 });
        for (const row of Array.isArray(res) ? res : res.results || []) {
          const p = batch[row.i];
          if (!p) continue;
          const d = ["include", "exclude", "maybe"].includes(row.decision) ? row.decision : "maybe";
          const r = d === "exclude" ? reasons.find((x) => x.toLowerCase() === String(row.reason || "").toLowerCase()) || reasons[0] : "";
          out[i + row.i] = { d: stage === "ft" && d === "maybe" ? "exclude" : d, r, c: Math.max(0, Math.min(1, Number(row.confidence) || 0.5)), why: String(row.why || "") };
        }
      } catch (e) {
        U.log("Criteria screening batch failed", e.message);
      }
      onProgress?.(Math.min(i + batchSize, papers.length), papers.length);
    }
    return out;
  }

  /**
   * Turn a plain-language description into a review protocol for a methodology.
   * Returns {protocol (normalized), recommended: {methodology, why}, rationale}.
   * @param {object} context  optional {query, titles[]} from an existing (quick) project
   */
  async function fillProtocol(profile, methodologyID, description, context = {}) {
    const M = ZR.Methodologies;
    const system =
      "You are an experienced research librarian and review methodologist. From the user's description you draft a review protocol that a careful researcher would accept: " +
      "focused research questions, literal and checkable inclusion/exclusion criteria (each one a single condition a yes/no answer can decide from a title and abstract), " +
      "a high-recall boolean search query, and methodology-appropriate extras (quality checklist, data extraction fields, classification facets). Use the user's language for text fields. " +
      "Rules for criteria: 2-4 inclusion and 1-4 exclusion criteria. An exclusion criterion must add a new condition: never the negation of an inclusion criterion. " +
      "Do NOT write publication years or languages into criteria: they are separate fields (yearFrom, yearTo, languages) and are checked automatically. " +
      "Only exclude reviews, surveys or opinion pieces if the user asks for primary studies; for questions about the state or development of a field they are relevant. " +
      QUERY_SYNTAX;
    const extra = [
      context.query ? `The user already searched with: ${context.query}` : "",
      context.titles?.length ? `Papers already collected (sample):\n${context.titles.slice(0, 15).map((t) => "- " + t).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = `${M.describeForm(methodologyID)}

Other methodologies available: ${M.LIST.map((m) => `${m.id} (${m.name})`).join(", ")}.

User's description:
"""${description}"""
${extra ? "\n" + extra + "\n" : ""}
Reply with JSON only:
{"title": str, "objective": str, "questions": [str], "framework": str, "frameworkFields": {<field id>: str}, "inclusion": [str], "exclusion": [str], "reasons": [str], "query": str, "yearFrom": int|null, "yearTo": int|null, "languages": [str], "types": [str], "quality": [str], "extraction": [str], "facets": [str], "recommendedMethodology": str, "recommendationWhy": str, "rationale": str}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 4000 });
    const protocol = M.normalizeProtocol(methodologyID, out);
    try {
      ZR.Query.parse(protocol.query);
    } catch (e) {
      protocol.query = protocol.query.replace(/[()]/g, " ");
    }
    const rec = M.get(out.recommendedMethodology) ? out.recommendedMethodology : methodologyID;
    return { protocol, recommended: { methodology: rec, why: String(out.recommendationWhy || "") }, rationale: String(out.rationale || "") };
  }

  /**
   * Annotate a paper's full text for a review: verbatim passages that speak for or
   * against inclusion. Returns {annotations: [{quote, kind, comment}], summary}.
   */
  async function annotateFullText(profile, protocol, paper, { max = 10 } = {}) {
    const system =
      "You annotate the full text of a research paper for a systematic literature review. " +
      "Pick the passages a careful reviewer would mark as evidence for the eligibility decision: what the paper studies, its method, data and findings as they relate to the criteria. " +
      "Every quote must be copied EXACTLY from the text: same words, same order, one to three sentences, no ellipses, no paraphrase. " +
      "kind is include (evidence the paper meets the criteria), exclude (evidence it does not), or maybe (relevant but inconclusive). The comment names the criterion and says why, in at most 25 words, in the language of the review.";
    const criteria = [
      protocol.questions?.length ? "Research questions:\n" + protocol.questions.map((q) => "- " + q).join("\n") : "",
      protocol.objective ? "Objective: " + protocol.objective : "",
      protocol.inclusion?.length ? "Inclusion criteria:\n" + protocol.inclusion.map((q) => "- " + q).join("\n") : "",
      protocol.exclusion?.length ? "Exclusion criteria:\n" + protocol.exclusion.map((q) => "- " + q).join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = `${criteria}\n\nPaper: ${paper.title}\n\nText:\n"""\n${paper.text}\n"""\n\nReply with JSON only: {"annotations": [{"quote": "<exact text>", "kind": "include"|"maybe"|"exclude", "comment": "<why>"}, …], "summary": "<one sentence: does the full text meet the criteria?>"} with at most ${max} annotations, most important first.`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 6000, timeout: 300000 });
    const list = Array.isArray(out?.annotations) ? out.annotations : Array.isArray(out) ? out : [];
    return {
      annotations: list
        .filter((a) => a && typeof a.quote === "string" && a.quote.trim().length >= 8)
        .slice(0, max)
        .map((a) => ({ quote: a.quote.trim(), kind: ["include", "maybe", "exclude"].includes(a.kind) ? a.kind : "maybe", comment: U.truncate(String(a.comment || ""), 300) })),
      summary: String(out?.summary || ""),
    };
  }

  /** Fill data-extraction fields for one paper from its abstract / full text. */
  async function extractFields(profile, fields, paper) {
    const system = "You extract data for a literature review. Use only the given text; write 'not reported' when the text does not say. Keep each value short (a phrase or one sentence).";
    const user = `Paper: ${paper.title} (${paper.year || "n.d."})\n\nText:\n"""${U.truncate(paper.fulltext || paper.abstract || "", 12000)}"""\n\nFields:\n${fields.map((f) => "- " + f).join("\n")}\n\nReply with JSON only: {<field>: <value>, …} using exactly the field names above.`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 2000 });
    const res = {};
    for (const f of fields) res[f] = out?.[f] == null ? "" : String(out[f]);
    return res;
  }

  /** Answer a quality checklist (yes / partly / no) for one paper. */
  async function assessQuality(profile, checklist, paper) {
    const system = "You appraise study quality for a literature review. Judge only from the given text; answer 'no' when the text gives no evidence.";
    const user = `Paper: ${paper.title}\n\nText:\n"""${U.truncate(paper.fulltext || paper.abstract || "", 12000)}"""\n\nChecklist:\n${checklist.map((q, i) => `${i}. ${q}`).join("\n")}\n\nReply with JSON only: [{"i": <index>, "answer": "yes"|"partly"|"no", "why": "<max 15 words>"}, …] covering every index.`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 2000 });
    const answers = checklist.map(() => null);
    for (const row of Array.isArray(out) ? out : []) {
      if (answers[row.i] === null && ["yes", "partly", "no"].includes(row.answer)) answers[row.i] = { a: row.answer, why: String(row.why || "") };
    }
    return answers;
  }

  /**
   * Short names for clusters of papers (e.g. to turn embedding clusters into a
   * classification facet). Returns one name per cluster, aligned with `clusters`.
   * @param {string[][]} clusters  titles per cluster
   */
  async function nameClusters(profile, clusters, context = "") {
    const system = "You name topic clusters of research papers for a systematic mapping study. Each name is 1-4 words, specific, and distinct from the other names.";
    const list = clusters.map((titles, i) => `[${i}]\n${titles.slice(0, 10).map((t) => "- " + U.truncate(t, 140)).join("\n")}`).join("\n\n");
    const user = `${context ? "Review: " + context + "\n\n" : ""}Clusters:\n${list}\n\nReply with JSON only: {"names": ["<name for cluster 0>", ...]} with exactly ${clusters.length} names.`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 1000 });
    const names = Array.isArray(out?.names) ? out.names.map((n) => String(n).trim()) : [];
    return clusters.map((_, i) => names[i] || "");
  }

  /** Compare papers along user-chosen dimensions; returns sanitized HTML for a Zotero note. */
  async function compare(profile, papers, instruction) {
    const system =
      "You are a careful research assistant. Compare the given papers using ONLY the supplied metadata/abstract/full-text excerpts; " +
      "write 'not stated' rather than guessing. Output clean HTML (h2, p, table/thead/tbody/tr/th/td, ul/li, strong, em) with no scripts, no styles, no markdown.";
    const body = papers
      .map(
        (p, i) =>
          `### Paper ${i + 1}: ${p.title}\nAuthors: ${p.authors}\nYear: ${p.year || "n.d."}\nVenue: ${p.venue || ""}\nDOI: ${p.doi || ""}\nAbstract: ${U.truncate(p.abstract || "", 2500)}\n${
            p.fulltext ? "Full-text excerpt: " + U.truncate(p.fulltext, 5000) : ""
          }`
      )
      .join("\n\n");
    const user = `${instruction || "Compare these papers: research question, method, data, key findings, limitations, and how they relate to each other."}\n\nStart with <h2>Comparison</h2>, then a table with one row per paper, then a short synthesis section.\n\n${body}`;
    const html = await ZR.LLM.chat(profile, [{ role: "user", content: user }], { system, maxTokens: 8000 });
    return sanitizeHTML(html.replace(/^```(?:html)?\s*|\s*```$/g, ""));
  }

  /** Guess bibliographic metadata from whatever an item already has (fields, filename, full text). */
  async function extractMetadata(profile, context) {
    const system =
      "You extract bibliographic metadata. Use only information present in the input; never invent DOIs. If unsure of a value, use null.";
    const user = `Item data:\n"""\n${U.truncate(context, 12000)}\n"""\n\nReply with JSON only:\n{"itemType": "journalArticle|conferencePaper|book|bookSection|thesis|report|preprint|webpage|standard|document", "title": str|null, "authors": [{"firstName": str, "lastName": str}], "date": "YYYY[-MM[-DD]]"|null, "DOI": str|null, "ISBN": str|null, "venue": str|null, "volume": str|null, "issue": str|null, "pages": str|null, "publisher": str|null, "url": str|null, "abstract": str|null, "language": str|null}`;
    return ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { system, maxTokens: 3000 });
  }

  /** Given an item description and candidate records, pick the one describing the same work (or none). */
  async function pickCandidate(profile, description, candidates) {
    if (!candidates.length) return null;
    const list = candidates
      .map((c, i) => `[${i}] ${c.title} | ${ZR.Records.creatorsToString(c.creators, 4)} | ${c.year || ""} | ${c.venue || ""} | DOI ${c.doi || "-"}`)
      .join("\n");
    const user = `Which candidate is the SAME work as this item? If none clearly is, answer -1.\n\nItem:\n${U.truncate(description, 3000)}\n\nCandidates:\n${list}\n\nReply with JSON only: {"index": <int>, "confidence": <0-1>, "reason": "<short>"}`;
    const out = await ZR.LLM.chatJSON(profile, [{ role: "user", content: user }], { maxTokens: 1000 });
    const i = Number(out.index);
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) return null;
    return { record: candidates[i], confidence: Number(out.confidence) || 0, reason: String(out.reason || "") };
  }

  /** Allow a conservative subset of HTML for notes. */
  function sanitizeHTML(html) {
    const allowed = new Set(["h1", "h2", "h3", "h4", "p", "br", "table", "thead", "tbody", "tr", "th", "td", "ul", "ol", "li", "strong", "b", "em", "i", "code", "blockquote", "a"]);
    return String(html)
      .replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag, attrs) => {
        tag = tag.toLowerCase();
        if (!allowed.has(tag)) return "";
        const closing = m.startsWith("</");
        if (closing) return `</${tag}>`;
        if (tag === "a") {
          const href = attrs.match(/href\s*=\s*"(https?:[^"]*)"/i);
          return href ? `<a href="${href[1]}">` : "<a>";
        }
        return `<${tag}>`;
      });
  }

  return { planQuery, screen, screenCriteria, fillProtocol, annotateFullText, extractFields, assessQuality, nameClusters, compare, extractMetadata, pickCandidate, sanitizeHTML, QUERY_SYNTAX };
})();

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
   * Score each record's relevance to the request (0–10). Mutates records with
   * .llmScore and .llmReason. Batches to keep prompts small.
   */
  async function screen(profile, request, records, { batchSize = 12, onProgress } = {}) {
    const system =
      "You screen search results for a systematic literature review. Judge relevance strictly from title, venue, year, and abstract. " +
      "Score 0–10: 9–10 directly on topic, 6–8 clearly relevant, 3–5 tangential, 0–2 off-topic. Be calibrated and concise.";
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
      "Apply the criteria literally. At title/abstract stage, be inclusive when information is missing (answer maybe or include) — exclusion needs clear evidence. " +
      "At full-text stage, decide include or exclude. Never invent content that is not in the text.";
    const criteria = `Review question: ${review.question || "(not stated)"}\nInclusion criteria: ${review.include || "(not stated)"}\nExclusion criteria: ${review.exclude || "(not stated)"}\nAllowed exclusion reasons: ${reasons.map((r) => `"${r}"`).join(", ")}`;
    const out = new Array(papers.length).fill(null);
    for (let i = 0; i < papers.length; i += batchSize) {
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

  return { planQuery, screen, screenCriteria, compare, extractMetadata, pickCandidate, sanitizeHTML, QUERY_SYNTAX };
})();

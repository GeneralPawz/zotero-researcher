/* global ZR, Zotero */
// Finding PDFs the usual sources don't have.
//
// Strategies (run one after another, as often as you like):
//   oa       – links from the search (arXiv, DOAJ, CORE, …), DOI resolvers, Unpaywall
//   ai:<id>  – an AI provider looks on the web (Codex / Claude Code CLIs with web search,
//              Perplexity, OpenRouter ":online" models; others answer from memory)
//   crawler:<id> – a web search / crawl API (Firecrawl, SerpApi Google Scholar, Tavily,
//              Exa, Brave Search) with its own key (Settings → Web search & crawlers)
//
// Every candidate is downloaded by Zotero and checked: it must be a PDF whose first pages
// contain the paper's title. Anything else is removed again — a wrong or invented link
// never ends up attached.

ZR.PDFHunt = (() => {
  const U = ZR.Util;

  const CRAWLERS = [
    { id: "firecrawl", name: "Firecrawl", note: "web search and scraping", keyURL: "https://www.firecrawl.dev/app/api-keys" },
    { id: "serpapi", name: "SerpApi — Google Scholar", note: "Google Scholar results, with direct PDF links", keyURL: "https://serpapi.com/manage-api-key" },
    { id: "tavily", name: "Tavily", note: "web search for AI agents", keyURL: "https://app.tavily.com/home" },
    { id: "exa", name: "Exa", note: "neural web search", keyURL: "https://dashboard.exa.ai/api-keys" },
    { id: "brave", name: "Brave Search", note: "web search API", keyURL: "https://api-dashboard.search.brave.com/app/keys" },
  ];
  const keyName = (id) => `crawler:${id}`;
  const crawlerKey = (id) => ZR.Secrets.get(keyName(id));
  const configuredCrawlers = () => CRAWLERS.filter((c) => crawlerKey(c.id));

  /** AI providers that can look on the web for this task. */
  function webCapable(profile) {
    const p = ZR.LLM.getProvider(profile.provider);
    return p.protocol === "cli" || p.webSearch || profile.provider === "openrouter";
  }

  /** Strategies available right now: [{id, label, kind}] */
  function strategies() {
    const out = [{ id: "oa", label: "Open-access sources (links from the search, DOI, Unpaywall)", kind: "oa" }];
    for (const p of ZR.Prefs.getLLMProfiles()) out.push({ id: "ai:" + p.id, label: `AI agent: ${p.name}${p.model ? " · " + p.model : ""}${webCapable(p) ? " (web search)" : " (no web access — answers from memory)"}`, kind: "ai" });
    for (const c of configuredCrawlers()) out.push({ id: "crawler:" + c.id, label: `Crawler: ${c.name}`, kind: "crawler" });
    return out;
  }

  // ------------------------------------------------------------- candidates ----
  const looksLikePDF = (u) => /\.pdf($|[?#])|\/pdf\b|\/download\b|arxiv\.org\/pdf|download=true/i.test(u);
  function rank(urls) {
    const seen = new Set();
    return urls
      .map((u) => String(u || "").trim())
      .filter((u) => /^https?:\/\//.test(u) && !seen.has(u) && seen.add(u))
      .sort((a, b) => Number(looksLikePDF(b)) - Number(looksLikePDF(a)))
      .slice(0, 6);
  }

  function describe(item) {
    const creators = item.getCreators().slice(0, 3).map((c) => c.lastName).filter(Boolean).join(", ");
    return { title: item.getField("title"), creators, year: U.yearOf(item.getField("date")), doi: item.getField("DOI"), venue: item.getField("publicationTitle") || item.getField("proceedingsTitle") || "" };
  }

  /** Candidate PDF links from a crawler API. */
  async function crawlerURLs(id, paper) {
    const key = crawlerKey(id);
    if (!key) throw new Error(`No key for ${id} — add it in Settings → Web search & crawlers`);
    const q = `"${paper.title}" pdf`;
    const http = (method, url, o = {}) => ZR.http(method, url, Object.assign({ timeout: 45000, noRetry: true }, o)).then((r) => r.json());
    if (id === "firecrawl") {
      const j = await http("POST", "https://api.firecrawl.dev/v1/search", { headers: { Authorization: `Bearer ${key}` }, body: { query: q, limit: 6 } });
      const list = Array.isArray(j.data) ? j.data : j.data?.web || [];
      return list.map((r) => r.url);
    }
    if (id === "serpapi") {
      const j = await http("GET", `https://serpapi.com/search.json?${U.qs({ engine: "google_scholar", q: paper.title, num: 5, api_key: key })}`);
      const out = [];
      for (const r of j.organic_results || []) {
        for (const res of r.resources || []) if (/pdf/i.test(res.file_format || "") || looksLikePDF(res.link)) out.push(res.link);
        if (looksLikePDF(r.link || "")) out.push(r.link);
      }
      return out;
    }
    if (id === "tavily") {
      const j = await http("POST", "https://api.tavily.com/search", { headers: { Authorization: `Bearer ${key}` }, body: { query: q, max_results: 6 } });
      return (j.results || []).map((r) => r.url);
    }
    if (id === "exa") {
      const j = await http("POST", "https://api.exa.ai/search", { headers: { "x-api-key": key }, body: { query: `${paper.title} full text pdf`, numResults: 6 } });
      return (j.results || []).map((r) => r.url);
    }
    if (id === "brave") {
      const j = await http("GET", `https://api.search.brave.com/res/v1/web/search?${U.qs({ q: `"${paper.title}" filetype:pdf`, count: 6 })}`, { headers: { "X-Subscription-Token": key, Accept: "application/json" } });
      return (j.web?.results || []).map((r) => r.url);
    }
    throw new Error("Unknown crawler " + id);
  }

  /** Candidate PDF links from an AI agent (with web search where the provider has it). */
  async function aiURLs(profile, paper) {
    let p = profile;
    if (profile.provider === "openrouter" && p.model && !p.model.endsWith(":online")) p = Object.assign({}, p, { model: p.model + ":online" });
    const user = `Find a legally accessible full-text PDF of this paper: open-access version, author's copy, institutional or preprint repository.\n\nTitle: ${paper.title}\nAuthors: ${paper.creators}\nYear: ${paper.year || ""}\nVenue: ${paper.venue}\nDOI: ${paper.doi || "(none)"}\n\nSearch the web. Give only links that you have seen and that lead directly to a PDF file of exactly this paper — no landing pages, no guesses.\nReply with JSON only: {"urls": ["<direct PDF link>", …]} (empty list if you found none).`;
    const out = await ZR.LLM.chatJSON(p, [{ role: "user", content: user }], { system: "You locate open-access copies of research papers on the web.", maxTokens: 1500, timeout: 300000, web: true });
    return Array.isArray(out?.urls) ? out.urls : [];
  }

  // ----------------------------------------------------------- verification ----
  const words = (s) => [...new Set(U.normalizeTitle(s).split(" ").filter((w) => w.length >= 4))];

  /** Share of the title's longer words found in a text (0..1). */
  function titleCoverage(title, text) {
    const w = words(title);
    if (!w.length) return 1;
    const hay = " " + U.normalizeTitle(text) + " ";
    return w.filter((x) => hay.includes(" " + x + " ")).length / w.length;
  }

  /** Download each link in turn; keep the first PDF that really is this paper. */
  async function tryURLs(item, urls, via) {
    for (const url of urls) {
      if (ZR.Activity?.stopping) return null;
      let att = null;
      try {
        att = await Zotero.Attachments.addFileFromURLs(item, [{ url, accessMethod: via }]);
      } catch (e) {
        U.log("PDF download failed", url, e.message);
      }
      if (!att) continue;
      att = att === true ? null : att;
      const attachment = att || item.getAttachments().map((id) => Zotero.Items.get(id)).find((a) => a?.isPDFAttachment?.());
      if (!attachment) continue;
      if (attachment.attachmentContentType !== "application/pdf") {
        await attachment.eraseTx();
        continue;
      }
      let text = "";
      try {
        text = (await Zotero.PDFWorker.getFullText(attachment.id, 2)).text || "";
      } catch (e) {
        /* scanned PDF: no text layer to check against */
      }
      if (text && titleCoverage(item.getField("title"), text) < 0.6) {
        U.log("PDF did not match the paper, removed", url);
        await attachment.eraseTx();
        continue;
      }
      return { url, attachment };
    }
    return null;
  }

  const hasPDF = (item) => item.getAttachments().some((id) => Zotero.Items.get(id)?.isPDFAttachment?.());

  /**
   * Run one strategy for papers without PDF.
   * @param {Zotero.Item[]} items
   * @param {string} strategy  "oa" | "ai:<profileID>" | "crawler:<id>"
   * @returns {Promise<{tried, found, failed: string[], results: {itemID, url}[]}>}
   */
  async function run(items, strategy, { onProgress = () => {}, records = new Map() } = {}) {
    const todo = items.filter((i) => !hasPDF(i));
    const res = { tried: todo.length, found: 0, failed: [], results: [] };
    for (const [n, item] of todo.entries()) {
      if (ZR.Activity?.stopping) break;
      onProgress(n + 1, todo.length, item);
      try {
        if (strategy === "oa") {
          if (await ZR.Importer.attachFullText(item, records.get(item.id) || null)) {
            res.found++;
            res.results.push({ itemID: item.id, url: "open access" });
          }
          continue;
        }
        const paper = describe(item);
        let urls;
        if (strategy.startsWith("ai:")) {
          const profile = ZR.Prefs.getLLMProfiles().find((p) => p.id === strategy.slice(3));
          if (!profile) throw new Error("AI provider not found");
          urls = await aiURLs(profile, paper);
        } else urls = await crawlerURLs(strategy.slice(8), paper);
        const hit = await tryURLs(item, rank(urls), strategy);
        if (hit) {
          res.found++;
          res.results.push({ itemID: item.id, url: hit.url });
        }
      } catch (e) {
        if (e?.stopped) break;
        res.failed.push(`${U.truncate(item.getField("title"), 50)}: ${e.message}`);
      }
    }
    return res;
  }

  return { CRAWLERS, keyName, crawlerKey, configuredCrawlers, strategies, webCapable, rank, titleCoverage, crawlerURLs, aiURLs, tryURLs, hasPDF, run };
})();

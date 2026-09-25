import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

const paper = { title: "Construction Progress Monitoring through the Integration of 4D BIM and SLAM", creators: "Perfetti", year: 2023, doi: "10.3390/buildings13102488" };

test("each crawler's answer becomes a list of candidate links, PDF-looking ones first", async () => {
  const http = mockHTTP((url, method, o) => {
    if (url.startsWith("https://api.firecrawl.dev/v1/search")) {
      assert.equal(o.headers.Authorization, "Bearer fc");
      return { success: true, data: [{ url: "https://example.org/landing" }, { url: "https://repo.example.org/files/paper.pdf" }] };
    }
    if (url.startsWith("https://serpapi.com/search.json")) {
      assert.match(url, /engine=google_scholar/);
      return { organic_results: [{ link: "https://www.mdpi.com/2075-5309/13/10/2488", resources: [{ file_format: "PDF", link: "https://www.mdpi.com/2075-5309/13/10/2488/pdf" }] }] };
    }
    if (url === "https://api.tavily.com/search") return { results: [{ url: "https://t.example/a.pdf" }] };
    if (url === "https://api.exa.ai/search") {
      assert.equal(o.headers["x-api-key"], "ex");
      return { results: [{ url: "https://e.example/a" }] };
    }
    if (url.startsWith("https://api.search.brave.com")) {
      assert.equal(o.headers["X-Subscription-Token"], "br");
      assert.match(decodeURIComponent(url), /filetype:pdf/);
      return { web: { results: [{ url: "https://b.example/x.pdf" }] } };
    }
    throw new Error("unexpected " + url);
  });
  const ZR = load({ http });
  for (const [id, key] of [["firecrawl", "fc"], ["serpapi", "sa"], ["tavily", "tv"], ["exa", "ex"], ["brave", "br"]]) await ZR.Secrets.set(ZR.PDFHunt.keyName(id), key);
  const H = ZR.PDFHunt;
  eq(H.rank(await H.crawlerURLs("firecrawl", paper)), ["https://repo.example.org/files/paper.pdf", "https://example.org/landing"]);
  eq(await H.crawlerURLs("serpapi", paper), ["https://www.mdpi.com/2075-5309/13/10/2488/pdf"]);
  eq(await H.crawlerURLs("tavily", paper), ["https://t.example/a.pdf"]);
  eq(await H.crawlerURLs("exa", paper), ["https://e.example/a"]);
  eq(await H.crawlerURLs("brave", paper), ["https://b.example/x.pdf"]);
  eq(H.configuredCrawlers().map((c) => c.id), ["firecrawl", "serpapi", "tavily", "exa", "brave"]);
});

test("a downloaded PDF must contain the paper's title", () => {
  const { PDFHunt: H } = load();
  const good = "Buildings 2023 — Construction Progress Monitoring through the Integration of 4D BIM and SLAM-Based Mapping Devices. Perfetti et al.";
  const wrong = "A survey of corrosion in steel bridges. Abstract: we review monitoring methods for bridges.";
  assert.ok(H.titleCoverage(paper.title, good) >= 0.9);
  assert.ok(H.titleCoverage(paper.title, wrong) < 0.6);
  eq(H.rank(["ftp://x", "https://a", "https://a", "https://b/paper.pdf", ""]), ["https://b/paper.pdf", "https://a"]);
});

test("AI agents search the web: CLIs get web access, OpenRouter uses an :online model", async () => {
  const calls = [];
  const http = mockHTTP((url, m, o) => {
    calls.push(o.body.model);
    return { choices: [{ message: { content: '{"urls": ["https://arxiv.org/pdf/2301.00001"]}' } }] };
  });
  const ZR = load({ http });
  let cliOpts = null;
  ZR.CLI.chat = async (profile, messages, opts) => ((cliOpts = opts), '{"urls": ["https://x.example/p.pdf"]}');
  eq(await ZR.PDFHunt.aiURLs({ id: "c", name: "Codex", provider: "codex-cli", model: "" }, paper), ["https://x.example/p.pdf"]);
  assert.equal(cliOpts.web, true, "web search on for the CLI");
  eq(await ZR.PDFHunt.aiURLs({ id: "o", name: "OR", provider: "openrouter", model: "anthropic/claude-sonnet-5", apiKey: "k" }, paper), ["https://arxiv.org/pdf/2301.00001"]);
  assert.equal(calls[0], "anthropic/claude-sonnet-5:online");
  assert.ok(ZR.PDFHunt.webCapable({ provider: "perplexity" }));
  assert.ok(!ZR.PDFHunt.webCapable({ provider: "mistral" }));
});

test("Perplexity is an AI provider with web search built in", async () => {
  const ZR = load();
  const p = ZR.LLM.getProvider("perplexity");
  assert.equal(p.baseURL, "https://api.perplexity.ai");
  assert.equal(p.webSearch, true);
  eq((await ZR.LLM.listModels({ provider: "perplexity", apiKey: "k" })).map((m) => m.id), ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"]);
});

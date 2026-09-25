# Zotero Researcher

A Zotero 7–10 plugin for building and curating a literature collection. It can:

- find papers for a collection in scholarly databases,
- remember each topic's search settings and history as a **project**,
- run a structured review (PRISMA 2020, scoping review, Kitchenham SLR, mapping study, …) with a screening funnel in which a fast **System 1** model and an AI help you decide,
- link papers that cite each other,
- fetch full-text PDFs,
- repair sparse metadata.

It works two ways, and you can mix them:

- **Deterministic.** You write a boolean query. It is translated into each database's own syntax. Every run can be logged, so results are reproducible.
- **AI-assisted.** You describe what you need in plain words. An AI model of your choice drafts the query, rates results, suggests screening decisions and compares papers. What the AI proposes is shown to you, and is checked against real bibliographic data where possible, before anything is written.

Tested against Zotero 10.0.3 on Windows (see [Testing](#testing)).

## Install

1. Download the latest `.xpi` from [Releases](https://github.com/GeneralPawz/zotero-researcher/releases/latest), or build it yourself with `npm run build` (Node 18+, no dependencies).
2. In Zotero, go to **Tools → Plugins → gear icon → Install Plugin From File…** and select the `.xpi`.
3. A pointer at the new toolbar button offers a short **guided tour**. You can replay it any time with **?** in the Researcher window, or from Settings.
4. Open **Settings → Zotero Researcher**. The *Getting started* checklist shows what is set up: your e-mail (for open-access PDFs), an optional free OpenAlex key, and optional AI providers.

## Updates

Installed copies update themselves from this repository:

- **Settings → Zotero Researcher → Updates → Check for updates** installs a newer release right away. You can also use Zotero's **Tools → Plugins → gear icon → Check for Updates**.
- Zotero also checks automatically, about once a day.
- The plugin reloads itself after an update, so there's no need to restart Zotero. Settings, API keys and all library data (tags, ledger) are kept.

**How it works:** the manifest's `update_url` points to [`updates.json` on the `release` branch](https://raw.githubusercontent.com/GeneralPawz/zotero-researcher/release/updates.json). That file names the newest version and links to that version's XPI on GitHub Releases. It also carries the XPI's SHA-256 hash, which Zotero checks before installing.

### Publishing a release

1. Bump `version` in `addon/manifest.json` (and `package.json`), then commit to `main`.
2. Run `npm run release` from `main`. It checks that the version is new, merges `main` into `release` and pushes. You can also merge a pull request into `release`.
3. The **Release** GitHub Action then:
   - runs the tests,
   - builds the XPI,
   - creates GitHub Release `v<version>` with the XPI attached,
   - rewrites `updates.json` on `release`.

   If the version hasn't changed, it publishes nothing.

GitHub caches `updates.json` for up to 5 minutes, so a brand-new release can take that long to show up in *Check for updates*.

To test the whole update path locally, run `npm run e2e -- --update`. It installs an old build (0.0.1) in a throwaway Zotero, clicks *Check for updates*, and checks that the published release gets installed.

## Where it shows up

| Place | What it does |
|---|---|
| **Items toolbar**, right after *New Note* | Opens the Researcher window for the selected collection, e.g. *Austausch IAB › test*. |
| **Multi-selection pane** ("N items selected [Edit Multiple Items…]") | Adds **Researcher: Metadata, PDFs & Compare…** |
| **Item pane → Researcher** | Shows how complete the item's metadata is, plus one-click metadata retrieval (with or without AI) and PDF finding. It also shows any remembered screening decision. |
| **Item context menu → Researcher** | Retrieve metadata, find PDFs, compare with AI, find related papers. **Judge ▸ Relevant / Not relevant / Weak** records your verdict on a paper. |
| **Collection context menu** | Find papers for this collection. |

## The Researcher window

There are four tabs. Each shows one main action; the rest stays out of the way.

**Projects.** The top right shows the current project and the collection papers go to. A project is bound to a collection and remembers its search settings and search history. There are two kinds:
- **Quick search:** "get me papers on X". Type the parameters and go; results go straight into the collection. A collection gets a quick project automatically the first time you add papers to it.
- **Structured review:** a methodology-based pipeline for a paper or thesis (see *Review* below).

Pick a project from the menu to switch to it (and to its collection), or create one with **+ New project…**, using the current collection or a new one. A quick project can be **converted into a structured review** at any time. Its query, filters and search history carry over.

**Search**
- Choose **Keywords** or **Describe it (AI)**.
- In Keywords mode you can switch between two editors:
  - **Builder:** one line per condition. Type a term and press Enter to add it as a chip; terms on one line are alternatives (OR). Each line can target *Anywhere*, *Title*, *Abstract* or *Author*, and lines combine with **AND / OR / NOT / XOR**.
  - **Text:** type the query directly, e.g. `("IFC5" OR IFCX) AND BIM`.

  Both editors stay in sync.
- Below the search box, two chips summarize and open the **sources** and the **options**:
  - **Results:** years, max results per source, full text only, open access only, strict match
  - **Filters:** languages, publication types, minimum citations, has abstract, has DOI. When a source doesn't report a value (e.g. language), the paper is kept.
  - **Your library:** hide papers you already have or excluded before, download PDFs, save a search log, tag new items
- Results can be sorted by best match, most cited, newest, oldest, or title. Hover the status line to see each database's result count and response time. A database that doesn't answer within 45 s is skipped rather than holding up the search.
- For each result you can see whether it is already in your library, whether you judged it before (and why), and when it appeared in an earlier search.
- **Clicking a paper that's already in your library** jumps to it in Zotero, preferring the current collection. Under Settings → Advanced you can switch this to list every collection the paper is in instead, each one clickable.
- Use *Judge* on any result to record a verdict without adding the paper.
- In AI mode, *Add results automatically* is the hands-off "YOLO" mode: it searches, rates and adds without a review step.

**Review** runs a structured review for the current project. The steps shown depend on the methodology:

| Methodology | Steps after the protocol |
|---|---|
| Systematic review (PRISMA 2020) | find → screen → full text → quality → extract → report |
| Scoping review (PRISMA-ScR / JBI, PCC) | find → screen → full text → extract → report |
| Rapid review (Cochrane RRMG) | find → screen → full text → report |
| Systematic literature review (Kitchenham & Charters) | find → screen → full text → quality → extract → report |
| Systematic mapping study (Petersen) | find → screen → classify → report |
| Semi-systematic / narrative review (Snyder) | find → screen → report |

1. **Protocol.** Choose the methodology, then either:
   - **describe in your own words** what you want to achieve. The AI fills in the methodology's form (and may suggest a better-fitting methodology); or
   - **fill in the form** yourself.

   Either way you end up with the same form: working title, objective, research questions, a question framework (PICO, PICOS, PCC, SPIDER or PEO), inclusion and exclusion criteria, exclusion reasons, the search query, years, languages and publication types. Depending on the methodology it also asks for a quality checklist, data extraction fields or classification facets. Saving the protocol pre-fills the Search tab.
2. **Find papers.** Search results go into the project's **candidate pool**, not into your library. Every search is logged for the report.
3. **Screen titles & abstracts: the funnel.** Thousands of candidates are narrowed down to the relevant few:
   - A **System 1 model** rates every paper: the probability that it belongs in the review, with one probability per criterion. This is fast and cheap. The queue is sorted by that probability, and a histogram shows the spread.
   - Two **thresholds** settle the clear cases in bulk: *exclude below* and *include above*. Each needs a second click to confirm. The decisions are recorded as "by System 1".
   - The **AI** reasons about the uncertain middle band and suggests a decision with a reason. *Accept confident AI suggestions* applies those with at least 80% confidence.
   - You decide the rest. Keys: `I` include, `M` maybe, `E` exclude, `1–9` pick a reason, `↑/↓` move.

   Papers are added to the Zotero collection **when you include them**.
4. **Check full texts.** Only included papers appear, with *Open PDF*, *Find PDF* and *Find PDFs for all*. The AI can read the indexed full text.
5. **Assess quality / extract data / classify.** A table of the included papers against the protocol's checklist, fields or facets. You fill it by hand or with *Fill with AI* (full text where indexed, otherwise the abstract), then export it as CSV.
6. **Report.** The PRISMA flow diagram is computed from the logged searches and every decision. Mapping studies also get facet counts. *Save as note* writes the protocol plus the flow summary into the collection, ready for the method section. The diagram can also be exported as SVG.

The LLM and the System 1 model complement each other. The LLM reasons: it sets up the protocol, handles the uncertain papers, and fills in quality and extraction tables. The System 1 model makes quick, calibrated guesses for every paper.

**Selected items.** Fix metadata (identifier → Zotero translators, or an exact title match in Crossref, OpenAlex, Semantic Scholar or arXiv; with AI if needed), find PDFs, compare papers with AI (the result can be saved as a note), and find related papers.

**Citations.** Finds who cites whom among the papers in the collection (or the whole library), adds Zotero's native **Related** links, and draws a graph. Dots are colored by screening decision; click one to open the paper in Zotero. You can export to **GraphML** (Gephi, yEd, Cytoscape) or **CSV**. *Suggest missing papers* lists works that several of your papers cite but that are not in your library.

The citation data is not built from scratch; the plugin reuses existing open citation graphs and only fills gaps:
1. **OpenAlex** is queried first, in batches of 50 DOIs.
2. **Semantic Scholar** is queried next, in batches, including arXiv-only papers.
3. **OpenCitations** and **Crossref** reference lists are used only for papers that neither of the first two knows about.

## Your data survives the plugin

Decisions live in your Zotero library, not in the plugin. They sync, group members share them, and they remain if you uninstall. A reinstall picks everything up again.

- **Tags on papers:**
  - `zr:include`, `zr:exclude`, `zr:maybe` for the title/abstract stage
  - `zr:ft:include`, `zr:ft:exclude` for the full-text stage
  - `zr:why:<reason>` for the exclusion reason
- **One ledger note per library**, titled *"Zotero Researcher — data ledger"*. It stores:
  - verdicts on papers you never added, including papers excluded from a review's pool (with who decided: you, the AI or System 1)
  - projects: search settings, search logs, review methodology and protocol
  - AI suggestions
  - citation directions (Zotero's "Related" links have no direction)

  Settings → *Your data* selects the ledger for you.
- **Local files** in `<Zotero data dir>/zotero-researcher/`:
  - `cache.json` records which results you have already seen.
  - `projects/` holds each review's candidate pool and per-paper model outputs (System 1 ratings, AI suggestions, quality answers, extracted data). These can be regenerated.

A later search recognizes a paper you judged before by DOI, arXiv ID or title, marks it (e.g. *Excluded 2026-09-25 — Weak / low quality*), and leaves it unselected.

## Research areas and sources

In **Settings → Research areas** you choose which areas' databases appear. **Life sciences & medicine is off by default**, so PubMed and Europe PMC stay hidden. Multidisciplinary databases are always available.

| Access | Databases with search support |
|---|---|
| Free (no key) | OpenAlex¹, Crossref, Semantic Scholar¹, arXiv, Europe PMC, PubMed¹, DOAJ, HAL, Zenodo, OSTI.gov, dblp² |
| Free key | CORE¹, Springer Nature, IEEE Xplore, Web of Science Starter |
| Paid / institutional | Scopus, ScienceDirect (Elsevier key plus campus IP or an institutional token) |

- ¹ Works without a key; a free key raises the limits. A free OpenAlex key is strongly recommended, since anonymous use is limited to about 100 searches a day.
- ² dblp's API currently sits behind a bot check. The plugin detects this and reports it.

Listed for reference only, with no search support: Lens.org, Dimensions, OpenAIRE, BASE, Scilit, Wiley TDM, Google Scholar. API keys are stored in Zotero's encrypted login store.

## AI providers

You can add any number of AI profiles and switch between them:

- **Your subscription, no API key:** Claude Code CLI (Claude plan) and Codex CLI (ChatGPT plan). The plugin runs your installed `claude` or `codex` program with the account you're signed in with in the terminal:
  - The program is found automatically; if not, click *Detect* or enter its path.
  - Claude runs with every tool disabled and without saving the session.
  - Codex runs read-only and ephemeral, in an empty temporary folder.
  - Replies take a few seconds longer than the APIs.
- **Cloud APIs:** Anthropic (Claude), OpenAI, Google Gemini, Mistral, Groq, OpenRouter (many models behind one key), DeepSeek, xAI
- **Local models:** Ollama, LM Studio
- **Custom:** any OpenAI-compatible endpoint

*Fetch available models* lists the models your key can use, and *Test* checks the connection.

## System 1 model (screening)

**Settings → System 1 model** chooses what rates papers in a review:

- **TypeSafe Jev** ([typesafe.ai](https://typesafe.ai/)): a System 1 model that answers typed questions with calibrated probabilities instead of text. It costs about $0.04 per million tokens and handles 1,200 requests a minute. Get a key at [console.typesafe.ai](https://console.typesafe.ai/). For each paper, only its title, abstract, venue, type and keywords are sent. Each paper goes out as one request:
  - one yes/no question per inclusion and exclusion criterion, plus one on overall relevance to the research questions;
  - the probabilities are combined in the plugin as relevance × (1 − strongest exclusion).
  
  Pin a model version (e.g. `jev-1.13.0`) instead of `jev-latest` for a reproducible review.
- **Your AI provider:** slower, and its stated confidence is mapped to a probability.
- **Keyword rules:** no AI at all; papers are rated by whether they match the protocol's query.

*Automatic* uses the best one available.

## Development

```
npm test          # 42 unit tests (Node's built-in runner, no dependencies)
npm run build     # build/zotero-researcher-<version>.xpi
npm run e2e       # end-to-end test inside a real Zotero (see below)
npm run e2e -- --update   # update path: old build → Check for updates → latest release
ZR_E2E_CLI=1 npm run e2e  # also makes real calls through your installed Claude Code / Codex CLIs
```

Layout:
- `addon/content/lib/` — the engine:
  - `query.js`: boolean parser and per-database compilers
  - `store.js`: tags, ledger, cache
  - `prisma.js`, `citations.js`, `search.js`, `enrich.js`, `llm.js`, `assist.js`, `importer.js`
  - `ui.js`: main-window integration
- `addon/content/sources/` — the database catalog and search adapters.
- `addon/content/dialog/` — the Researcher window: `research.js` (shell + Search), `review.js`, `items.js`, `citations.js`, `tour.js`.
- `addon/content/preferences/` — Settings.

### Testing

`npm run e2e` works like this:
1. It builds the XPI and installs it into a **throwaway profile and data directory**.
2. It starts a separate Zotero (`-no-remote`).
3. The in-app self-test (`content/lib/selftest.js`) drives the real UI: 33 steps covering the toolbar, multi-select, item pane, context menu, welcome pointer, tour, research areas, live searches, PDFs, metadata fixing, judging and decision memory, Settings, the AI flows (against a mock AI endpoint, with live databases), projects (automatic quick projects, new review projects, conversion, persistence), the structured review (methodology-dependent forms, AI-filled protocol, candidate pool, System 1 rating against a mock TypeSafe endpoint with threshold decisions, AI on the uncertain papers, keyboard screening, full text, AI-filled quality and extraction tables, flow diagram and protocol note), citation linking on real papers (ResNet → GoogLeNet, Attention → ResNet), and disable/re-enable with the decisions surviving.
4. It writes `report.json` and screenshots, then quits.

Your normal profile and library are never touched. Use `--keep-open` to keep the test instance open, and `--clean` to delete the temp folder after a passing run.

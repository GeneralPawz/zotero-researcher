# Zotero Researcher

A Zotero 7–10 plugin for building and curating a literature collection. It can:

- find papers for a collection in scholarly databases,
- screen them as a PRISMA 2020 systematic review,
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
2. Push `main` to `release` with `git push origin main:release`, or merge a pull request into `release`.
3. The **Release** GitHub Action then:
   - runs the tests,
   - builds the XPI,
   - creates GitHub Release `v<version>` with the XPI attached,
   - rewrites `updates.json` on `release`.

   If the version hasn't changed, it publishes nothing.

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

**Search**
- Choose **Keywords** (e.g. `("IFC5" OR IFCX) AND BIM`) or **Describe it (AI)**.
- Below the search box, two chips summarize and open the **sources** and the **options**. Options include years, full text only, open access only, download PDFs, and hide papers you excluded before.
- For each result you can see whether it is already in your library, whether you judged it before (and why), and when it appeared in an earlier search.
- Use *Judge ▾* on any result to record a verdict without adding the paper.
- In AI mode, *Add results automatically* is the hands-off "YOLO" mode: it searches, rates and adds without a review step.

**Review (PRISMA 2020)** turns a collection into a systematic review:
1. **Find papers.** Write the question and the inclusion and exclusion criteria. Every search you add papers from is then logged. Added papers are tagged `zr:unscreened`.
2. **Screen titles & abstracts.** Papers are shown one card at a time.
   - Keys: `I` include, `M` maybe, `E` exclude, `1–9` pick a reason, `↑/↓` move between papers.
   - *AI suggestions* reads the whole list and pre-fills a decision for each paper, which you then confirm. *Accept confident ones* applies only suggestions with at least 80% confidence; those are recorded as decided "by AI".
3. **Check full texts.** Only included papers appear here, with *Open PDF* / *Find PDF*. The AI can read the PDF text too.
4. **PRISMA report.** The flow diagram is computed live from the logged searches and the tags on the papers. You can save it as a note or export it as SVG.

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
  - `zr:unscreened` for papers waiting in a review
- **One ledger note per library**, titled *"Zotero Researcher — data ledger"*. It stores:
  - verdicts on papers you never added
  - review setups and search logs
  - AI suggestions
  - citation directions (Zotero's "Related" links have no direction)

  Settings → *Your data* selects the ledger for you.
- **A local cache file**, `<Zotero data dir>/zotero-researcher/cache.json`, records which results you have already seen.

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

- **Cloud:** OpenAI, Anthropic (Claude), Google Gemini, Mistral, Groq, OpenRouter, DeepSeek, xAI
- **Local:** Ollama, LM Studio
- **Custom:** any OpenAI-compatible endpoint

*Fetch available models* lists the models your key can use, and *Test* checks the connection.

## Development

```
npm test          # 32 unit tests (Node's built-in runner, no dependencies)
npm run build     # build/zotero-researcher-<version>.xpi
npm run e2e       # end-to-end test inside a real Zotero (see below)
npm run e2e -- --update   # update path: old build → Check for updates → latest release
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
3. The in-app self-test (`content/lib/selftest.js`) drives the real UI: 25 steps covering the toolbar, multi-select, item pane, context menu, welcome pointer, tour, research areas, live searches, PDFs, metadata fixing, judging and decision memory, Settings, the AI flows (against a mock AI endpoint, with live databases), the full PRISMA review, citation linking on real papers (ResNet → GoogLeNet, Attention → ResNet), and disable/re-enable with the decisions surviving.
4. It writes `report.json` and screenshots, then quits.

Your normal profile and library are never touched. Use `--keep-open` to keep the test instance open, and `--clean` to delete the temp folder after a passing run.

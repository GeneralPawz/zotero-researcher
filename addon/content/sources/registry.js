/* global ZR */
// Catalog of scholarly databases. Adapters (sources/adapters.js) attach `search()` to
// the entries they implement; entries without it are listed for reference only.
//
// access:  "free"     – works without any key (a key may raise limits: keyOptional)
//          "free-key" – requires a free registration key
//          "paid"     – needs a subscription / institutional entitlement / paid plan

ZR.Sources = (() => {
  const CATALOG = [
    {
      id: "openalex",
      name: "OpenAlex",
      access: "free",
      keyOptional: true,
      keyLabel: "API key (free; raises daily budget from ~100 to ~1,000 searches)",
      signupURL: "https://openalex.org/settings/api",
      docsURL: "https://docs.openalex.org",
      coverage: "All disciplines, ~250M works; full boolean search; OA links",
      defaultEnabled: true,
    },
    {
      id: "crossref",
      name: "Crossref",
      access: "free",
      signupURL: "",
      docsURL: "https://api.crossref.org/swagger-ui/index.html",
      coverage: "All DOIs registered with Crossref; keyword relevance (boolean expanded client-side)",
      defaultEnabled: true,
    },
    {
      id: "semanticscholar",
      name: "Semantic Scholar",
      access: "free",
      keyOptional: true,
      keyLabel: "API key (free on request; avoids shared-pool throttling)",
      signupURL: "https://www.semanticscholar.org/product/api#api-key-form",
      docsURL: "https://api.semanticscholar.org/api-docs/graph",
      coverage: "CS, biomed and more, ~200M papers; boolean bulk search; OA PDFs",
      defaultEnabled: true,
    },
    {
      id: "arxiv",
      name: "arXiv",
      access: "free",
      docsURL: "https://info.arxiv.org/help/api/user-manual.html",
      coverage: "Preprints in physics, math, CS, eess, q-bio, econ; always full text",
      defaultEnabled: true,
    },
    {
      id: "europepmc",
      name: "Europe PMC",
      access: "free",
      docsURL: "https://europepmc.org/RestfulWebService",
      coverage: "Life sciences incl. PubMed, PMC and preprints; OA full-text links",
      defaultEnabled: false,
    },
    {
      id: "pubmed",
      name: "PubMed (NCBI E-utilities)",
      access: "free",
      keyOptional: true,
      keyLabel: "NCBI API key (optional; 10 instead of 3 requests/s)",
      signupURL: "https://account.ncbi.nlm.nih.gov/settings/",
      docsURL: "https://www.ncbi.nlm.nih.gov/books/NBK25501/",
      coverage: "Biomedical literature (MEDLINE)",
      defaultEnabled: false,
    },
    {
      id: "doaj",
      name: "DOAJ",
      access: "free",
      docsURL: "https://doaj.org/api/docs",
      coverage: "Articles in fully open-access journals",
      defaultEnabled: true,
    },
    {
      id: "hal",
      name: "HAL (archives ouvertes)",
      access: "free",
      docsURL: "https://api.archives-ouvertes.fr/docs/search",
      coverage: "French/European open archive, many full-text PDFs",
      defaultEnabled: false,
    },
    {
      id: "zenodo",
      name: "Zenodo",
      access: "free",
      docsURL: "https://developers.zenodo.org",
      coverage: "Open repository: papers, reports, datasets, software",
      defaultEnabled: false,
    },
    {
      id: "osti",
      name: "OSTI.gov",
      access: "free",
      docsURL: "https://www.osti.gov/api/v1/docs",
      coverage: "US Department of Energy research: reports, articles",
      defaultEnabled: false,
    },
    {
      id: "dblp",
      name: "dblp",
      access: "free",
      docsURL: "https://dblp.org/faq/How+to+use+the+dblp+search+API.html",
      coverage: "Computer science bibliography (no abstracts). Note: API currently behind a bot check",
      defaultEnabled: false,
    },
    {
      id: "core",
      name: "CORE",
      access: "free-key",
      keyOptional: true,
      keyLabel: "API key (free; keyless allows only ~10 requests/min)",
      signupURL: "https://core.ac.uk/services/api#form",
      docsURL: "https://api.core.ac.uk/docs/v3",
      coverage: "Aggregated OA repositories, many direct PDF links",
      defaultEnabled: false,
    },
    {
      id: "springer",
      name: "Springer Nature",
      access: "free-key",
      keyLabel: "Meta API key",
      signupURL: "https://dev.springernature.com",
      docsURL: "https://dev.springernature.com/docs/supported-query-params/",
      coverage: "Springer, Nature, BMC journals and books",
      defaultEnabled: true,
    },
    {
      id: "ieee",
      name: "IEEE Xplore",
      access: "free-key",
      keyLabel: "API key (manually approved)",
      signupURL: "https://developer.ieee.org/member/register",
      docsURL: "https://developer.ieee.org/docs/read/Metadata_API_details",
      coverage: "IEEE/IET journals, conferences, standards",
      defaultEnabled: true,
    },
    {
      id: "wos",
      name: "Web of Science Starter",
      access: "free-key",
      keyLabel: "Starter API key (free trial plan: 50 requests/day)",
      signupURL: "https://developer.clarivate.com/apis/wos-starter",
      docsURL: "https://api.clarivate.com/swagger-ui/?apikey=none&url=https%3A%2F%2Fdeveloper.clarivate.com%2Fapis%2Fwos-starter%2Fswagger",
      coverage: "Web of Science Core Collection metadata + citation counts",
      defaultEnabled: true,
    },
    {
      id: "scopus",
      name: "Scopus (Elsevier)",
      access: "paid",
      keyLabel: "Elsevier API key (needs institutional access; campus IP or insttoken)",
      extraSecrets: [{ id: "insttoken", label: "Institutional token (optional)" }],
      signupURL: "https://dev.elsevier.com/apikey/manage",
      docsURL: "https://dev.elsevier.com/sc_search_tips.html",
      coverage: "Abstract & citation database across all disciplines",
      defaultEnabled: true,
    },
    {
      id: "sciencedirect",
      name: "ScienceDirect (Elsevier)",
      access: "paid",
      keyLabel: "Elsevier API key (needs institutional access; campus IP or insttoken)",
      extraSecrets: [{ id: "insttoken", label: "Institutional token (optional)" }],
      sharesKeyWith: "scopus",
      signupURL: "https://dev.elsevier.com/apikey/manage",
      docsURL: "https://dev.elsevier.com/tecdoc_sdsearch_migration.html",
      coverage: "Elsevier journals & books full-text search",
      defaultEnabled: true,
    },
    // --- reference-only entries (no adapter yet) ---
    {
      id: "lens",
      name: "Lens.org Scholarly API",
      access: "paid",
      signupURL: "https://www.lens.org/lens/user/subscriptions",
      docsURL: "https://docs.api.lens.org",
      coverage: "Scholarly works linked to patents; 14-day trial, then paid",
    },
    {
      id: "dimensions",
      name: "Dimensions",
      access: "paid",
      signupURL: "https://www.dimensions.ai/scientometric-research/",
      docsURL: "https://docs.dimensions.ai/dsl/api.html",
      coverage: "Publications, grants, patents; free for approved scientometric research",
    },
    {
      id: "openaire",
      name: "OpenAIRE Graph",
      access: "free",
      signupURL: "https://develop.openaire.eu",
      docsURL: "https://graph.openaire.eu/docs/apis/graph-api/",
      coverage: "European research graph incl. EU project outputs",
    },
    {
      id: "base",
      name: "BASE (Bielefeld)",
      access: "paid",
      signupURL: "https://www.base-search.net/about/en/contact.php",
      docsURL: "https://www.base-search.net/about/download/base_interface.pdf",
      coverage: "OA repository aggregator; API access by IP allow-listing only",
    },
    {
      id: "scilit",
      name: "Scilit",
      access: "free-key",
      signupURL: "https://www.scilit.com/about/user-guide/api",
      docsURL: "https://www.scilit.com/about/user-guide/api",
      coverage: "MDPI's cross-publisher index; token on request",
    },
    {
      id: "wiley",
      name: "Wiley TDM",
      access: "paid",
      signupURL: "https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining",
      docsURL: "https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining",
      coverage: "PDF download by DOI for subscribed content (no search)",
    },
    {
      id: "googlescholar",
      name: "Google Scholar",
      access: "paid",
      docsURL: "https://scholar.google.com",
      coverage: "No official API; use Zotero Connector in the browser instead",
    },
    {
      id: "unpaywall",
      name: "Unpaywall (PDF finder)",
      access: "free",
      signupURL: "",
      docsURL: "https://unpaywall.org/products/api",
      coverage: "Used automatically to locate legal OA PDFs by DOI (needs your e-mail below)",
      pdfOnly: true,
    },
  ];

  // Research areas ("source pools"). A source is shown when at least one of its areas is
  // enabled in Settings. Multidisciplinary sources are always relevant.
  const DISCIPLINES = [
    { id: "multi", name: "Multidisciplinary", description: "OpenAlex, Crossref, Semantic Scholar, Scopus, Web of Science, …", defaultOn: true, locked: true },
    { id: "engineering", name: "Engineering & computer science", description: "IEEE Xplore, dblp, arXiv (cs), ScienceDirect", defaultOn: true },
    { id: "physics", name: "Physics, mathematics & astronomy", description: "arXiv", defaultOn: true },
    { id: "energy", name: "Energy & applied sciences", description: "OSTI.gov (US Dept. of Energy)", defaultOn: true },
    { id: "medicine", name: "Life sciences & medicine", description: "PubMed, Europe PMC", defaultOn: false },
    { id: "repositories", name: "Open repositories", description: "Zenodo, HAL, CORE — reports, theses, preprints", defaultOn: true },
  ];
  const DISCIPLINE_OF = {
    openalex: ["multi"],
    crossref: ["multi"],
    semanticscholar: ["multi"],
    arxiv: ["engineering", "physics"],
    europepmc: ["medicine"],
    pubmed: ["medicine"],
    doaj: ["multi"],
    hal: ["repositories"],
    zenodo: ["repositories"],
    osti: ["energy"],
    dblp: ["engineering"],
    core: ["repositories"],
    springer: ["multi"],
    ieee: ["engineering"],
    wos: ["multi"],
    scopus: ["multi"],
    sciencedirect: ["multi", "engineering"],
    lens: ["multi"],
    dimensions: ["multi"],
    openaire: ["repositories"],
    base: ["repositories"],
    scilit: ["multi"],
    wiley: ["multi"],
    googlescholar: ["multi"],
    unpaywall: ["multi"],
  };
  for (const s of CATALOG) s.disciplines = DISCIPLINE_OF[s.id] || ["multi"];

  const byID = new Map(CATALOG.map((s) => [s.id, s]));
  const lastCall = new Map();

  function disciplineEnabled(id) {
    const d = DISCIPLINES.find((x) => x.id === id);
    if (!d) return true;
    if (d.locked) return true;
    const setting = ZR.Prefs.getJSON("disciplines", {})[id];
    return typeof setting === "boolean" ? setting : d.defaultOn;
  }

  function setDisciplineEnabled(id, on) {
    const all = ZR.Prefs.getJSON("disciplines", {});
    all[id] = !!on;
    ZR.Prefs.setJSON("disciplines", all);
  }

  /** Whether the source belongs to at least one enabled research area. */
  function inEnabledArea(s) {
    s = typeof s === "string" ? get(s) : s;
    return !!s && s.disciplines.some(disciplineEnabled);
  }

  /** Searchable sources the user wants to see (research-area filter applied). */
  function visibleSearchable() {
    return searchable().filter(inEnabledArea);
  }

  function get(id) {
    return byID.get(id) || null;
  }

  function all() {
    return CATALOG;
  }

  /** Searchable sources (have an adapter). */
  function searchable() {
    return CATALOG.filter((s) => typeof s.search === "function");
  }

  function keyFor(id) {
    const s = get(id);
    const keyOwner = s?.sharesKeyWith || id;
    return ZR.Secrets.get(ZR.Secrets.sourceKey(keyOwner));
  }

  function secretFor(id, secretID) {
    const s = get(id);
    const keyOwner = s?.sharesKeyWith || id;
    return ZR.Secrets.get(ZR.Secrets.sourceKey(`${keyOwner}:${secretID}`));
  }

  function isEnabled(id) {
    const s = get(id);
    if (!s || !s.search || !inEnabledArea(s)) return false;
    const setting = ZR.Prefs.getSourceSettings()[id];
    return setting && typeof setting.enabled === "boolean" ? setting.enabled : !!s.defaultEnabled;
  }

  /** Why a source can't run right now, or "" if it can. */
  function unavailableReason(id) {
    const s = get(id);
    if (!s) return "unknown source";
    if (!s.search) return "no search adapter";
    const needsKey = s.access !== "free" && !s.keyOptional;
    if (needsKey && !keyFor(id)) return "API key missing (Settings → Zotero Researcher)";
    return "";
  }

  /** Enforce a minimum interval between requests to one source. */
  async function throttle(id, minIntervalMs) {
    const prev = lastCall.get(id) || 0;
    const wait = prev + minIntervalMs - Date.now();
    lastCall.set(id, Math.max(Date.now(), prev + minIntervalMs));
    if (wait > 0) await ZR.Util.sleep(wait);
  }

  return {
    DISCIPLINES,
    all,
    get,
    searchable,
    visibleSearchable,
    inEnabledArea,
    disciplineEnabled,
    setDisciplineEnabled,
    keyFor,
    secretFor,
    isEnabled,
    unavailableReason,
    throttle,
  };
})();

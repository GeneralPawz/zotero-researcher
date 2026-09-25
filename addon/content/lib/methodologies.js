/* global ZR */
// Review methodologies. Each defines the protocol form (which fields, which question
// framework) and the funnel stages papers pass through. The same definitions drive the
// setup form, the LLM that pre-fills it from a plain-language description, and the
// pipeline steps in the Review tab.

ZR.Methodologies = (() => {
  // Question frameworks: structured decomposition of the research question
  const FRAMEWORKS = {
    none: { name: "No framework", fields: [] },
    PICO: {
      name: "PICO",
      fields: [
        { id: "population", label: "Population / problem" },
        { id: "intervention", label: "Intervention / technology" },
        { id: "comparison", label: "Comparison" },
        { id: "outcome", label: "Outcome" },
      ],
    },
    PICOS: {
      name: "PICOS",
      fields: [
        { id: "population", label: "Population / problem" },
        { id: "intervention", label: "Intervention / technology" },
        { id: "comparison", label: "Comparison" },
        { id: "outcome", label: "Outcome" },
        { id: "studyDesign", label: "Study design" },
      ],
    },
    PCC: {
      name: "PCC",
      fields: [
        { id: "population", label: "Population" },
        { id: "concept", label: "Concept" },
        { id: "context", label: "Context" },
      ],
    },
    SPIDER: {
      name: "SPIDER",
      fields: [
        { id: "sample", label: "Sample" },
        { id: "phenomenon", label: "Phenomenon of interest" },
        { id: "design", label: "Design" },
        { id: "evaluation", label: "Evaluation" },
        { id: "researchType", label: "Research type" },
      ],
    },
    PEO: {
      name: "PEO",
      fields: [
        { id: "population", label: "Population" },
        { id: "exposure", label: "Exposure" },
        { id: "outcome", label: "Outcome" },
      ],
    },
  };

  // Protocol fields. `list` fields hold one entry per line.
  const FIELDS = {
    title: { label: "Working title", type: "text", hint: "e.g. IFC 5 and IFCX in BIM data exchange: a systematic review" },
    objective: { label: "Objective", type: "textarea", hint: "What should this review establish, and for whom?" },
    questions: { label: "Research questions", type: "list", hint: "One per line, e.g. RQ1: How is IFC 5 used for …?" },
    inclusion: { label: "Include papers that…", type: "list", hint: "One criterion per line — written so a yes/no answer is possible" },
    exclusion: { label: "Exclude papers that…", type: "list", hint: "One criterion per line" },
    reasons: { label: "Exclusion reasons", type: "list", hint: "Shown when you exclude a paper; used in the flow diagram" },
    query: { label: "Search query", type: "query", hint: 'Boolean query, e.g. ("IFC5" OR IFCX) AND BIM' },
    years: { label: "Publication years", type: "years" },
    languages: { label: "Languages", type: "languages" },
    types: { label: "Publication types", type: "types" },
    quality: { label: "Quality assessment checklist", type: "list", hint: "One yes/partly/no question per line" },
    extraction: { label: "Data extraction fields", type: "list", hint: "One field per line, e.g. Method, Data set, Key finding" },
    facets: { label: "Classification facets", type: "list", hint: "One facet per line with categories, e.g. Research type: evaluation, solution, validation, philosophical" },
  };

  const DEFAULT_REASONS = [
    "Off topic",
    "Wrong study type (not research)",
    "Wrong context or population",
    "Weak / low quality",
    "Not peer-reviewed",
    "Language",
    "Duplicate",
    "Full text not available",
  ];

  // Funnel stage types: search → screen (title/abstract) → fulltext → quality → extract → report
  const STAGES = {
    protocol: { label: "Protocol", short: "Protocol" },
    search: { label: "Find papers", short: "Find" },
    screen: { label: "Screen titles & abstracts", short: "Screen" },
    fulltext: { label: "Check full texts", short: "Full text" },
    quality: { label: "Assess quality", short: "Quality" },
    extract: { label: "Extract data", short: "Extract" },
    classify: { label: "Classify papers", short: "Classify" },
    report: { label: "Report", short: "Report" },
  };

  const LIST = [
    {
      id: "prisma2020",
      name: "Systematic review (PRISMA 2020)",
      short: "Answers a focused question from all relevant studies, with transparent selection. The standard for health, increasingly for engineering.",
      reference: "Page et al. (2021), BMJ 372:n71",
      framework: "PICO",
      frameworks: ["PICO", "PICOS", "SPIDER", "PEO", "none"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types", "quality", "extraction"],
      stages: ["protocol", "search", "screen", "fulltext", "quality", "extract", "report"],
      report: "prisma",
    },
    {
      id: "scoping",
      name: "Scoping review (PRISMA-ScR / JBI)",
      short: "Maps what is known about a broad topic, the kinds of evidence and the gaps — no quality appraisal.",
      reference: "Tricco et al. (2018), Ann Intern Med 169:467; Peters et al., JBI Manual",
      framework: "PCC",
      frameworks: ["PCC", "none"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types", "extraction"],
      stages: ["protocol", "search", "screen", "fulltext", "extract", "report"],
      report: "prisma",
    },
    {
      id: "rapid",
      name: "Rapid review",
      short: "A streamlined systematic review for time-critical decisions: fewer sources, date and language limits, single screening.",
      reference: "Garritty et al. (2021), Cochrane Rapid Reviews Methods Group, J Clin Epidemiol 130:13",
      framework: "PICO",
      frameworks: ["PICO", "PCC", "none"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types"],
      stages: ["protocol", "search", "screen", "fulltext", "report"],
      report: "prisma",
    },
    {
      id: "kitchenham",
      name: "Systematic literature review (Kitchenham & Charters)",
      short: "The engineering / software-engineering SLR: research questions, search string, selection, quality assessment and data extraction.",
      reference: "Kitchenham & Charters (2007), EBSE Technical Report EBSE-2007-01",
      framework: "none",
      frameworks: ["none", "PICOS"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types", "quality", "extraction"],
      stages: ["protocol", "search", "screen", "fulltext", "quality", "extract", "report"],
      report: "prisma",
    },
    {
      id: "mapping",
      name: "Systematic mapping study (Petersen)",
      short: "Classifies a research field by topic, research type and venue to show trends and gaps — breadth over depth.",
      reference: "Petersen, Vakkalanka & Kuzniarz (2015), IST 64:1",
      framework: "none",
      frameworks: ["none", "PCC"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types", "facets"],
      stages: ["protocol", "search", "screen", "classify", "report"],
      report: "prisma",
    },
    {
      id: "narrative",
      name: "Semi-systematic / narrative review",
      short: "Overview of a topic and how it developed, with a documented but lighter selection process.",
      reference: "Snyder (2019), J Bus Res 104:333",
      framework: "none",
      frameworks: ["none", "PCC", "PICO"],
      fields: ["title", "objective", "questions", "inclusion", "exclusion", "reasons", "query", "years", "languages", "types"],
      stages: ["protocol", "search", "screen", "report"],
      report: "prisma",
    },
  ];

  const get = (id) => LIST.find((m) => m.id === id) || null;

  /** Empty protocol for a methodology (the "build from scratch" starting point). */
  function emptyProtocol(id) {
    const m = get(id);
    return {
      title: "",
      objective: "",
      questions: [],
      framework: m?.framework || "none",
      frameworkFields: {},
      inclusion: [],
      exclusion: [],
      reasons: DEFAULT_REASONS.slice(),
      query: "",
      yearFrom: null,
      yearTo: null,
      languages: [],
      types: [],
      quality: [],
      extraction: [],
      facets: [],
    };
  }

  /** Normalize/validate a protocol (e.g. one returned by the LLM) against a methodology. */
  function normalizeProtocol(id, p) {
    const m = get(id);
    const out = emptyProtocol(id);
    const list = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);
    const str = (v) => (v == null ? "" : String(v).trim());
    const year = (v) => (Number.isInteger(Number(v)) && Number(v) > 1500 && Number(v) < 2200 ? Number(v) : null);
    if (!p) return out;
    out.title = str(p.title);
    out.objective = str(p.objective);
    out.questions = list(p.questions);
    out.framework = m.frameworks.includes(p.framework) ? p.framework : m.framework;
    const fw = FRAMEWORKS[out.framework];
    for (const f of fw.fields) out.frameworkFields[f.id] = str(p.frameworkFields?.[f.id]);
    out.inclusion = list(p.inclusion);
    out.exclusion = list(p.exclusion);
    const reasons = list(p.reasons);
    out.reasons = reasons.length ? reasons : DEFAULT_REASONS.slice();
    out.query = str(p.query);
    out.yearFrom = year(p.yearFrom);
    out.yearTo = year(p.yearTo);
    const offered = new Set(ZR.Records.LANGUAGES.map((l) => l.code));
    out.languages = [...new Set(list(p.languages).map((l) => ZR.Records.normLang(l)))].filter((l) => offered.has(l));
    out.types = list(p.types).filter((t) => ZR.Records.TYPE_FILTERS.some((x) => x.id === t));
    out.quality = m.fields.includes("quality") ? list(p.quality) : [];
    out.extraction = m.fields.includes("extraction") ? list(p.extraction) : [];
    out.facets = m.fields.includes("facets") ? list(p.facets) : [];
    return out;
  }

  /** Plain-text description of the form, for the LLM that fills it. */
  function describeForm(id) {
    const m = get(id);
    const fwLines = m.frameworks.map((f) => `  ${f}: ${FRAMEWORKS[f].fields.map((x) => `${x.id} (${x.label})`).join(", ") || "—"}`).join("\n");
    return [
      `Methodology: ${m.name} — ${m.short}`,
      `Allowed question frameworks (field ids):\n${fwLines}`,
      `Fields to fill: ${m.fields.map((f) => `${f} (${FIELDS[f].label})`).join(", ")}`,
      `Publication type ids: ${ZR.Records.TYPE_FILTERS.map((t) => t.id).join(", ")}. Language codes: ISO 639-1 (en, de, …).`,
    ].join("\n");
  }

  return { LIST, FRAMEWORKS, FIELDS, STAGES, DEFAULT_REASONS, get, emptyProtocol, normalizeProtocol, describeForm };
})();

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

const counts = {
  identified: 275,
  bySource: { Scopus: 120, OpenAlex: 100, CORE: 55 },
  otherMethods: { citation: 0, manual: 0 },
  removedDuplicates: 70,
  removedInLibrary: 32,
  screened: 173,
  excludedTA: 62,
  excludedTAReasons: { "Off topic": 50, "Wrong study type (not research)": 12 },
  maybeTA: 0,
  pendingTA: 0,
  sought: 111,
  notRetrieved: 2,
  assessed: 109,
  pendingFT: 0,
  excludedFT: { "Off topic": 40 },
  excludedFTTotal: 40,
  included: 69,
};
const BIM = '(BIM OR "building information model*") AND (construction OR Bauausführung OR "site logistics") NOT survey';

test("themes: every field is checked; bad values fall back to the base theme", () => {
  const { Diagrams: D } = load();
  const t = D.normalizeTheme({ name: "Journal X", font: "comic", fontSize: 99, radius: -3, text: "red", line: "#123", bandColors: ["#abcdef"], arrow: "sideways", background: "transparent", lineWidth: "2.34" });
  assert.equal(t.font, "sans");
  assert.equal(t.fontSize, 20);
  assert.equal(t.radius, 0);
  assert.equal(t.text, "#1a202c", "not a hex colour");
  assert.equal(t.line, "#112233", "short hex is expanded");
  eq(t.bandColors, ["#abcdef", "#c6f6d5", "#fefcbf"]);
  assert.equal(t.arrow, "filled");
  assert.equal(t.background, "none");
  assert.equal(t.lineWidth, 2.3);
  for (const p of D.PRESETS) assert.equal(JSON.stringify(D.normalizeTheme(p, p)), JSON.stringify(Object.assign({}, p)), p.id + " is already valid");
});

test("text wraps inside the box width", () => {
  const { Diagrams: D } = load();
  const theme = D.PRESETS[0];
  const lines = D.wrap("Records identified from databases and registers through the logged searches of this review", 200, 13, theme);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(D.textWidth(l, 13, theme) <= 200, l);
  assert.ok(D.wrap("Supercalifragilisticexpialidociouswordthatneverends", 80, 13, theme).every((l) => D.textWidth(l, 13, theme) <= 80 + 13));
});

test("PRISMA flow: counts in the boxes, theme decides corners, bands and title", () => {
  const { Diagrams: D } = load();
  const colour = D.prismaScene(counts, D.PRESETS[0], { title: "Scoping review · BIM" });
  const text = colour.boxes.flatMap((b) => b.lines.map((l) => l.text)).join(" | ");
  for (const s of ["(n = 275)", "Scopus (n = 120)", "Duplicates removed (n = 70)", "Off topic (n = 50)", "Reports not retrieved (n = 2)", "Studies included in review (n = 69)"]) assert.ok(text.includes(s), s);
  assert.equal(colour.bands.length, 3);
  const svg = D.toSVG(colour, D.PRESETS[0]);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+"/);
  assert.match(svg, / rx="6"/);
  assert.match(svg, /Scoping review · BIM/);
  const print = D.PRESETS.find((p) => p.id === "print");
  const bw = D.toSVG(D.prismaScene(counts, print, { title: "Scoping review · BIM" }), print);
  assert.doesNotMatch(bw.replace(/<text[^>]*>[^<]*<\/text>/g, "").replace(/<marker[\s\S]*?<\/marker>/, ""), / rx="[1-9]/, "square corners");
  assert.doesNotMatch(bw, /Scoping review · BIM/, "this theme has no title");
  assert.doesNotMatch(bw, /#bee3f8|#c6f6d5/, "no colours of the default theme");
  const serif = D.PRESETS.find((p) => p.id === "serif");
  assert.equal(D.prismaScene(counts, serif).bands.length, 0);
  assert.match(D.toSVG(D.prismaScene(counts, serif), serif), /font-family="Times New Roman/);
});

test("review process: the project's steps with their specifics", () => {
  const { Diagrams: D } = load();
  const facts = {
    methodology: { name: "Scoping review (PRISMA-ScR / JBI)" },
    stages: ["protocol", "search", "screen", "fulltext", "extract", "report"],
    protocol: { questions: 4, inclusion: 2, exclusion: 1, framework: "PCC", years: "2015 to 2026" },
    search: { runs: 1, identified: 275, duplicates: 70, inLibrary: 32, databases: [{ name: "Scopus", n: 120 }, { name: "OpenAlex", n: 100 }], query: BIM, when: "2026-09-25" },
    screening: { pool: 173, included: 111, excluded: 62, engine: "TypeSafe Jev", thresholds: [20, 80], bySystem1: 90, byAI: 60, byYou: 23 },
    fulltext: { sought: 111, withPDF: 109, notRetrieved: 2, assessed: 109, included: 69, excluded: 40, annotatedBy: "Codex CLI · gpt-6-astra" },
    extraction: 5,
    included: 69,
  };
  const s = D.processScene(facts, D.PRESETS[0]);
  const text = s.boxes.flatMap((b) => b.lines.map((l) => l.text)).join(" ");
  for (const x of ["1. Protocol", "2. Search", "3. Title and abstract screening", "4. Full-text assessment", "5. Data extraction", "6. Synthesis and report", "framework PCC", "Scopus (120)", "TypeSafe Jev", "exclude below 20%", "Codex CLI"]) assert.ok(text.includes(x), x);
  assert.equal(s.boxes.filter((b) => b.kind === "detail").length, 4);
  assert.ok(s.arrows.some((a) => a.label === "dashed"));
});

test("search strategy: the query's concepts, how they combine, databases and results", () => {
  const { Diagrams: D } = load();
  const s = D.searchScene({ query: BIM, databases: [{ name: "Scopus", n: 120 }, { name: "CORE", n: 55 }], identified: 175, duplicates: 20, years: "2015 to 2026" }, D.PRESETS[0]);
  const concepts = s.boxes.filter((b) => /^Concept/.test(b.lines[0].text));
  assert.equal(concepts.length, 3);
  assert.ok(concepts[0].lines.map((l) => l.text).join(" ").includes("BIM OR building information model*"));
  eq(s.labels.map((l) => l.text), ["AND", "NOT"]);
  const text = s.boxes.flatMap((b) => b.lines.map((l) => l.text)).join(" ");
  assert.ok(text.includes("Scopus (n = 120)") && text.includes("after duplicates removed (n = 155)") && text.includes("years 2015 to 2026"));
  const nested = D.searchScene({ query: "(a AND (b OR c)) OR d", databases: [] }, D.PRESETS[0]);
  assert.ok(nested.boxes[0].lines.some((l) => l.text.includes("(a AND (b OR c)) OR d")), "a query the builder can't show stays text");
});

test("LaTeX: a TikZ picture with the same layout, special characters escaped", () => {
  const { Diagrams: D } = load();
  const t = D.PRESETS[0];
  const tex = D.toTikZ(D.prismaScene(Object.assign({}, counts, { bySource: { "R&D_db 100%": 3 } }), t, { title: "A #1 review" }), t, { name: "PRISMA 2020 flow" });
  assert.match(tex, /^% PRISMA 2020 flow: made with Zotero Researcher/);
  assert.match(tex, /\\begin\{tikzpicture\}\[x=0.75pt, y=-0.75pt\]/);
  assert.match(tex, /\\definecolor\{zr[A-Z]\}\{HTML\}\{BEE3F8\}/);
  assert.match(tex, /rounded corners=4.5pt/);
  assert.match(tex, /R\\&D\\_db 100\\% \(n = 3\)/);
  assert.match(tex, /A \\#1 review/);
  assert.match(tex, /-\{Stealth\}/);
  assert.equal(D.texEscape("a\\b{c}~^"), "a\\textbackslash{}b\\{c\\}\\textasciitilde{}\\textasciicircum{}");
  const doc = D.toLaTeXDocument(D.prismaScene(counts, t), t);
  assert.match(doc, /^\\documentclass\[border=4pt\]\{standalone\}/);
  assert.match(doc, /\\end\{tikzpicture\}\n\\end\{document\}\n$/);
});

test("an AI writes a theme from a description and an example image (Anthropic and OpenAI formats)", async () => {
  const bodies = [];
  const http = mockHTTP((url, m, o) => {
    bodies.push({ url, body: o.body });
    const theme = JSON.stringify({ name: "Journal of BIM", font: "serif", radius: 0, boxStroke: "#000000", bands: false, arrow: "open", fontSize: 11 });
    if (url.includes("anthropic")) return { content: [{ type: "text", text: theme }] };
    return { choices: [{ message: { content: theme } }] };
  });
  const ZR = load({ http });
  const image = { mediaType: "image/png", data: "iVBORw0KGgo=" };
  const t = await ZR.Diagrams.themeFromAI({ id: "a", name: "A", provider: "anthropic", model: "claude-sonnet-5", apiKey: "k" }, { text: "Black and white, Times, 9 pt", image });
  assert.equal(t.name, "Journal of BIM");
  assert.equal(t.font, "serif");
  assert.equal(t.radius, 0);
  assert.equal(t.bands, false);
  const content = bodies[0].body.messages[0].content;
  eq(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  assert.match(content[1].text, /Black and white, Times/);
  await ZR.Diagrams.themeFromAI({ id: "o", name: "O", provider: "openai", model: "gpt-6-astra", apiKey: "k" }, { image });
  const oc = bodies[1].body.messages.at(-1).content;
  assert.equal(oc[1].image_url.url, "data:image/png;base64,iVBORw0KGgo=");
  await assert.rejects(ZR.Diagrams.themeFromAI({ provider: "openai" }, {}), /Describe the style/);
  eq([...ZR.Util.base64ToBytes("iVBORw0KGgo=")], [137, 80, 78, 71, 13, 10, 26, 10]);
});

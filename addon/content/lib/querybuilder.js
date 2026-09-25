/* global ZR */
// Query builder model <-> boolean query text.
//
// A query is a list of "concept" rows. Terms inside a row are alternatives (OR);
// rows are combined left to right with AND / OR / NOT / XOR:
//
//   [Anywhere] IFC5 | IFCX          →  ("IFC5" OR IFCX)
//   AND [Title] BIM                 →  … AND title:BIM
//
// toQuery() always produces text the parser accepts; fromQuery() turns text back into
// rows when its shape allows (otherwise null and the user keeps editing text).

ZR.QueryBuilder = (() => {
  const FIELDS = [
    { id: "any", label: "Anywhere" },
    { id: "title", label: "Title" },
    { id: "abstract", label: "Abstract" },
    { id: "author", label: "Author" },
  ];
  const OPS = [
    { id: "AND", label: "AND", hint: "must also match" },
    { id: "OR", label: "OR", hint: "or instead" },
    { id: "NOT", label: "NOT", hint: "must not match" },
    { id: "XOR", label: "XOR", hint: "one or the other, not both" },
  ];

  /** Clean a user-typed term: keep "quoted exact" terms, quote multi-word phrases. */
  function termString(raw, field) {
    let t = String(raw || "").trim().replace(/[()]/g, " ").replace(/\s+/g, " ");
    const quoted = /^["“„].*["”“]$/.test(t);
    t = t.replace(/["“”„]/g, "").trim();
    if (!t) return "";
    if (/^(AND|OR|NOT)$/i.test(t)) t = `"${t}"`;
    else if (quoted || /\s/.test(t)) t = `"${t}"`;
    return field && field !== "any" ? `${field}:${t}` : t;
  }

  function blockString(b) {
    const terms = (b.terms || []).map((t) => termString(t, b.field)).filter(Boolean);
    if (!terms.length) return "";
    return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
  }

  /** Wrap in parentheses unless x is already a single term or one bracketed group. */
  function group(x) {
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < x.length; i++) {
      const c = x[i];
      if (c === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0 && i < x.length - 1) return `(${x})`; // "(a) OR (b)"
      } else if (c === " " && depth === 0) return `(${x})`;
    }
    return x;
  }

  /** Rows → boolean query text. Empty rows are ignored. */
  function toQuery(blocks) {
    let q = "";
    let family = null; // operator family of q's top level, for precedence-safe parentheses
    for (const b of blocks || []) {
      const s = blockString(b);
      if (!s) continue;
      if (!q) {
        q = s;
        continue;
      }
      const op = b.op || "AND";
      if (op === "XOR") {
        q = `(${group(q)} OR ${s}) AND NOT (${group(q)} AND ${s})`;
        family = "and";
        continue;
      }
      const f = op === "OR" ? "or" : "and";
      if (family && family !== f) q = `(${q})`;
      q = `${q} ${op} ${s}`;
      family = f;
    }
    return q;
  }

  function termText(n) {
    return n.phrase && !/\s/.test(n.text) ? `"${n.text}"` : n.text;
  }

  function blockFromNode(n) {
    if (n.op === "term") return { field: n.field || "any", terms: [termText(n)] };
    if (n.op === "or" && n.args.every((a) => a.op === "term")) {
      const fields = new Set(n.args.map((a) => a.field || "any"));
      if (fields.size === 1) return { field: [...fields][0], terms: n.args.map(termText) };
    }
    return null;
  }

  /** Query text → rows, or null when the query is too nested for the row model. */
  function fromQuery(text) {
    let ast;
    try {
      ast = ZR.Query.parse(text);
    } catch (e) {
      return null;
    }
    if (!ast) return [{ op: "AND", field: "any", terms: [] }];
    const whole = blockFromNode(ast);
    if (whole) return [Object.assign({ op: "AND" }, whole)];
    if (ast.op === "and" || ast.op === "or") {
      const blocks = [];
      for (const [i, arg] of ast.args.entries()) {
        const negated = arg.op === "not";
        if (negated && (i === 0 || ast.op === "or")) return null;
        const b = blockFromNode(negated ? arg.arg : arg);
        if (!b) return null;
        blocks.push(Object.assign({ op: negated ? "NOT" : ast.op === "or" ? "OR" : "AND" }, b));
      }
      return blocks;
    }
    return null;
  }

  return { FIELDS, OPS, toQuery, fromQuery, termString };
})();

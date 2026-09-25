/* global ZR */
// Boolean query language shared by all sources.
//
//   ("IFC5" OR IFCX) AND BIM NOT title:survey
//
// Operators: AND / OR / NOT (any case), also && || ! and a leading "-" for NOT.
// Adjacent terms are implicitly ANDed. Quotes make phrases, trailing * is a prefix
// wildcard, and title: / abstract: / author: (ti: ab: au:) restrict a term to a field.
// The AST is compiled into each database's dialect, and `matches()` evaluates it
// locally so results from sources with weak boolean support can be post-filtered.

ZR.Query = (() => {
  const FIELD_ALIASES = {
    title: "title",
    ti: "title",
    abstract: "abstract",
    abs: "abstract",
    ab: "abstract",
    author: "author",
    au: "author",
    authors: "author",
  };

  class QuerySyntaxError extends Error {}

  // --- Tokenizer -----------------------------------------------------------
  function tokenize(input) {
    const tokens = [];
    let i = 0;
    const s = String(input || "");
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === "(" || c === ")") {
        tokens.push({ type: c });
        i++;
        continue;
      }
      if (s.startsWith("&&", i)) {
        tokens.push({ type: "AND" });
        i += 2;
        continue;
      }
      if (s.startsWith("||", i)) {
        tokens.push({ type: "OR" });
        i += 2;
        continue;
      }
      if (c === "|") {
        tokens.push({ type: "OR" });
        i++;
        continue;
      }
      if (c === "!" || (c === "-" && i + 1 < s.length && /[^\s-]/.test(s[i + 1]) && (i === 0 || /[\s(]/.test(s[i - 1])))) {
        tokens.push({ type: "NOT" });
        i++;
        continue;
      }
      if (c === "+" && (i === 0 || /[\s(]/.test(s[i - 1]))) {
        i++;
        continue;
      }
      // field prefix?
      let field = null;
      const fm = s.slice(i).match(/^([A-Za-z]+):(?=\S)/);
      if (fm && FIELD_ALIASES[fm[1].toLowerCase()]) {
        field = FIELD_ALIASES[fm[1].toLowerCase()];
        i += fm[0].length;
      }
      if (s[i] === '"' || s[i] === "“" || s[i] === "„") {
        let j = i + 1;
        while (j < s.length && s[j] !== '"' && s[j] !== "”" && s[j] !== "“") j++;
        const text = s.slice(i + 1, j).trim();
        i = j + 1;
        if (text) tokens.push({ type: "TERM", text, quoted: true, field });
        continue;
      }
      let j = i;
      while (j < s.length && !/[\s()]/.test(s[j])) j++;
      const word = s.slice(i, j);
      i = j;
      if (!field) {
        const up = word.toUpperCase();
        if (up === "AND") {
          tokens.push({ type: "AND" });
          continue;
        }
        if (up === "OR") {
          tokens.push({ type: "OR" });
          continue;
        }
        if (up === "NOT" || up === "ANDNOT") {
          if (up === "ANDNOT") tokens.push({ type: "AND" });
          tokens.push({ type: "NOT" });
          continue;
        }
      }
      if (word) tokens.push({ type: "TERM", text: word, quoted: false, field });
    }
    return tokens;
  }

  // --- Parser (recursive descent) -------------------------------------------
  function parse(input) {
    const tokens = tokenize(input);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseOr() {
      const args = [parseAnd()];
      while (peek() && peek().type === "OR") {
        next();
        args.push(parseAnd());
      }
      return args.length === 1 ? args[0] : { op: "or", args };
    }
    function startsUnary(t) {
      return t && (t.type === "TERM" || t.type === "(" || t.type === "NOT");
    }
    function parseAnd() {
      const args = [parseUnary()];
      for (;;) {
        const t = peek();
        if (t && t.type === "AND") {
          next();
          args.push(parseUnary());
        } else if (startsUnary(t)) {
          args.push(parseUnary());
        } else break;
      }
      return args.length === 1 ? args[0] : { op: "and", args };
    }
    function parseUnary() {
      const t = peek();
      if (!t) throw new QuerySyntaxError("Unexpected end of query");
      if (t.type === "NOT") {
        next();
        return { op: "not", arg: parseUnary() };
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = next();
      if (!t) throw new QuerySyntaxError("Unexpected end of query");
      if (t.type === "(") {
        const e = parseOr();
        if (!peek() || peek().type !== ")") throw new QuerySyntaxError("Missing closing parenthesis");
        next();
        return e;
      }
      if (t.type === "TERM") {
        return { op: "term", text: t.text, phrase: !!t.quoted, field: t.field || null };
      }
      throw new QuerySyntaxError(`Unexpected "${t.type}"`);
    }

    if (!tokens.length) return null;
    // Tolerate dangling operators at the edges ("BIM AND") rather than failing a search.
    while (tokens.length && ["AND", "OR"].includes(tokens[tokens.length - 1].type)) tokens.pop();
    while (tokens.length && ["AND", "OR"].includes(tokens[0].type)) tokens.shift();
    if (!tokens.length) return null;
    const ast = parseOr();
    if (pos < tokens.length) {
      if (tokens[pos].type === ")") throw new QuerySyntaxError("Unbalanced closing parenthesis");
      throw new QuerySyntaxError(`Unexpected token at position ${pos}`);
    }
    return simplify(ast);
  }

  function simplify(node) {
    if (!node) return node;
    if (node.op === "not") {
      const arg = simplify(node.arg);
      return arg.op === "not" ? arg.arg : { op: "not", arg };
    }
    if (node.op === "and" || node.op === "or") {
      const args = [];
      for (const a of node.args.map(simplify)) {
        if (a.op === node.op) args.push(...a.args);
        else args.push(a);
      }
      return args.length === 1 ? args[0] : { op: node.op, args };
    }
    return node;
  }

  // --- Generic serializer --------------------------------------------------
  /**
   * @param {object} d dialect:
   *   term(node) -> string, and/or/not: operator strings,
   *   andNot: string used for "A AND NOT B" (default `${and} ${not}`),
   *   group: [open, close]
   */
  function serialize(node, d) {
    const [open, close] = d.group || ["(", ")"];
    const wrap = (child, parentOp) => {
      const s = serialize(child, d);
      if ((child.op === "and" || child.op === "or") && child.op !== parentOp) return open + s + close;
      return s;
    };
    switch (node.op) {
      case "term":
        return d.term(node);
      case "not":
        return (d.notPrefix || d.not + " ") + wrap(node.arg, "not");
      case "or":
        return node.args.map((a) => wrap(a, "or")).join(` ${d.or} `);
      case "and": {
        if (d.andNot) {
          const pos = node.args.filter((a) => a.op !== "not");
          const neg = node.args.filter((a) => a.op === "not");
          if (!pos.length) return node.args.map((a) => wrap(a, "and")).join(` ${d.and} `);
          let s = pos.map((a) => wrap(a, "and")).join(` ${d.and} `);
          for (const n of neg) s += ` ${d.andNot} ` + wrap(n.arg, "and");
          return s;
        }
        return node.args.map((a) => wrap(a, "and")).join(` ${d.and} `);
      }
    }
    return "";
  }

  const quote = (t) => '"' + t.text.replace(/"/g, "") + '"';
  const plain = (t) => (t.phrase || /\s/.test(t.text) ? quote(t) : t.text);
  // Many APIs reject wildcards (OpenAlex inside phrases, DOAJ everywhere). Their search
  // is stemmed anyway, so "model*" → "model" loses little; strict local matching still
  // honours the wildcard.
  const noWild = (t) => ({ ...t, text: t.text.replace(/\*+/g, "").trim() || t.text });
  const plainNoWild = (t) => plain(noWild(t));

  function luceneTerm(fieldMap, { wildcards = true } = {}) {
    return (t) => {
      const v = wildcards ? plain(t) : plainNoWild(t);
      const f = t.field && fieldMap[t.field];
      return f ? `${f}:${v}` : v;
    };
  }

  const dialects = {
    // Human-readable canonical form (used for protocol notes and LLM round-trips)
    canonical: { and: "AND", or: "OR", not: "NOT", term: (t) => (t.field ? t.field + ":" : "") + plain(t) },
    openalex: { and: "AND", or: "OR", not: "NOT", term: plainNoWild },
    lucene: { and: "AND", or: "OR", not: "NOT", term: plainNoWild },
    europepmc: { and: "AND", or: "OR", not: "NOT", term: luceneTerm({ title: "TITLE", abstract: "ABSTRACT", author: "AUTH" }) },
    core: { and: "AND", or: "OR", not: "NOT", term: luceneTerm({ title: "title", abstract: "abstract", author: "authors" }) },
    springer: { and: "AND", or: "OR", not: "NOT", term: luceneTerm({ title: "title", author: "name" }, { wildcards: false }) },
    doaj: {
      and: "AND",
      or: "OR",
      not: "NOT",
      term: luceneTerm({ title: "bibjson.title", abstract: "bibjson.abstract", author: "bibjson.author.name" }, { wildcards: false }),
    },
    hal: { and: "AND", or: "OR", not: "NOT", term: luceneTerm({ title: "title_t", abstract: "abstract_t", author: "authFullName_t" }) },
    zenodo: { and: "AND", or: "OR", not: "NOT", term: luceneTerm({ title: "title", abstract: "description", author: "creators.name" }) },
    pubmed: {
      and: "AND",
      or: "OR",
      not: "NOT",
      term: (t) => plain(t) + ({ title: "[ti]", abstract: "[tiab]", author: "[au]" }[t.field] || "[tiab]"),
    },
    ieee: {
      and: "AND",
      or: "OR",
      not: "NOT",
      term: (t) => {
        const f = { title: '"Document Title"', abstract: '"Abstract"', author: '"Authors"' }[t.field];
        return f ? `${f}:${plain(t)}` : plain(t);
      },
    },
    scopus: {
      and: "AND",
      or: "OR",
      not: "NOT",
      andNot: "AND NOT",
      term: (t) => {
        const f = { title: "TITLE", abstract: "ABS", author: "AUTHOR-NAME" }[t.field] || "TITLE-ABS-KEY";
        return `${f}(${plain(t)})`;
      },
    },
    sciencedirect: { and: "AND", or: "OR", not: "NOT", andNot: "AND NOT", term: plainNoWild },
    wos: {
      and: "AND",
      or: "OR",
      not: "NOT",
      andNot: "NOT",
      term: (t) => {
        const f = { title: "TI", author: "AU" }[t.field] || "TS";
        return `${f}=(${plain(t)})`;
      },
    },
    s2bulk: { and: "+", or: "|", notPrefix: "-", not: "-", term: plain },
    arxiv: {
      and: "AND",
      or: "OR",
      not: "ANDNOT",
      andNot: "ANDNOT",
      term: (t) => {
        const f = { title: "ti", abstract: "abs", author: "au" }[t.field] || "all";
        return `${f}:${plainNoWild(t)}`;
      },
    },
  };

  /** Remove NOT nodes that a dialect cannot express (e.g. arXiv NOT inside OR). */
  function dropUnsupportedNot(node, allowOnlyInAnd) {
    if (node.op === "term") return node;
    if (node.op === "not") return allowOnlyInAnd ? null : node;
    const args = [];
    for (const a of node.args) {
      if (a.op === "not") {
        if (node.op === "and") args.push({ op: "not", arg: dropUnsupportedNot(a.arg, allowOnlyInAnd) || a.arg });
        continue;
      }
      const c = dropUnsupportedNot(a, allowOnlyInAnd);
      if (c) args.push(c);
    }
    if (!args.length) return null;
    if (node.op === "and" && args.every((a) => a.op === "not")) return null;
    return args.length === 1 ? args[0] : { op: node.op, args };
  }

  function compile(ast, dialect) {
    if (!ast) return "";
    const d = dialects[dialect];
    if (!d) throw new Error(`Unknown query dialect ${dialect}`);
    let node = ast;
    if (dialect === "arxiv" || dialect === "scopus" || dialect === "wos") {
      node = dropUnsupportedNot(ast, true);
      if (!node) return "";
    }
    return serialize(node, d);
  }

  // --- Keyword expansion for sources without boolean support ---------------
  /**
   * Disjunctive normal form over positive terms: [["ifc5","bim"],["ifcx","bim"]].
   * Negations are dropped (post-filtering handles them). Returns null when the
   * expansion would exceed maxClauses.
   */
  function toDNF(ast, maxClauses = 6) {
    function dnf(node) {
      switch (node.op) {
        case "term":
          return [[node]];
        case "not":
          return [[]];
        case "or": {
          const out = [];
          for (const a of node.args) {
            out.push(...dnf(a));
            if (out.length > maxClauses) throw new RangeError();
          }
          return out;
        }
        case "and": {
          let acc = [[]];
          for (const a of node.args) {
            const d = dnf(a);
            const next = [];
            for (const x of acc) for (const y of d) next.push([...x, ...y]);
            if (next.length > maxClauses) throw new RangeError();
            acc = next;
          }
          return acc;
        }
      }
      return [[]];
    }
    if (!ast) return [];
    try {
      return dnf(ast)
        .map((c) => c.map((t) => t.text.replace(/\*+/g, "")))
        .filter((c) => c.length);
    } catch (e) {
      if (e instanceof RangeError) return null;
      throw e;
    }
  }

  function positiveTerms(ast) {
    const out = [];
    (function walk(n, neg) {
      if (!n) return;
      if (n.op === "term") {
        if (!neg) out.push(n.text);
      } else if (n.op === "not") walk(n.arg, !neg);
      else n.args.forEach((a) => walk(a, neg));
    })(ast, false);
    return [...new Set(out)];
  }

  /** Keyword strings to send to keyword-only APIs (one request per string). */
  function keywordQueries(ast, maxClauses = 4) {
    const clauses = toDNF(ast, maxClauses);
    if (clauses && clauses.length) return clauses.map((c) => [...new Set(c)].join(" "));
    const terms = positiveTerms(ast);
    return terms.length ? [terms.join(" ")] : [];
  }

  // --- Local evaluation ----------------------------------------------------
  function norm(s) {
    return String(s || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const reCache = new Map();
  function termRegex(text) {
    let re = reCache.get(text);
    if (re) return re;
    let t = norm(text).trim();
    const prefix = t.endsWith("*");
    if (prefix) t = t.replace(/\*+$/, "");
    const body = t
      .split(/[^a-z0-9*]+/)
      .filter(Boolean)
      .map((w) => escapeRe(w).replace(/\\\*/g, "[a-z0-9]*"))
      .join("[^a-z0-9]+");
    re = new RegExp(`(^|[^a-z0-9])${body}${prefix ? "" : "(?![a-z0-9])"}`);
    reCache.set(text, re);
    return re;
  }

  /**
   * @param {object} ast
   * @param {{title?:string, abstract?:string, keywords?:string[], creators?:object[]}} rec
   */
  function matches(ast, rec) {
    if (!ast) return true;
    const title = norm(rec.title);
    const abstract = norm(rec.abstract);
    const any = [title, abstract, norm((rec.keywords || []).join(" "))].join(" \n ");
    const authors = norm(
      (rec.creators || []).map((c) => [c.firstName, c.lastName, c.name].filter(Boolean).join(" ")).join("; ")
    );
    const hay = { title, abstract, author: authors };
    function ev(n) {
      switch (n.op) {
        case "term": {
          const re = termRegex(n.text);
          return re.test(n.field ? hay[n.field] : any);
        }
        case "not":
          return !ev(n.arg);
        case "and":
          return n.args.every(ev);
        case "or":
          return n.args.some(ev);
      }
      return false;
    }
    return ev(ast);
  }

  function toCanonical(ast) {
    return compile(ast, "canonical");
  }

  // --- Highlighting ----------------------------------------------------------
  /** Terms a record is searched for (not the negated ones): [{text, phrase, field}] */
  function termNodes(ast, negated = false, out = []) {
    if (!ast) return out;
    if (ast.op === "term") {
      if (!negated && !out.some((t) => t.text.toLowerCase() === ast.text.toLowerCase() && t.field === ast.field)) out.push({ text: ast.text, phrase: ast.phrase, field: ast.field });
    } else if (ast.op === "not") termNodes(ast.arg, !negated, out);
    else for (const a of ast.args || []) termNodes(a, negated, out);
    return out;
  }

  /** Case- and accent-folded copy of a string with the same length (so offsets carry over). */
  function fold(s) {
    let out = "";
    for (const c of String(s || "")) {
      const f = c.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
      out += c.length === 2 ? (f[0] || "x") + "x" : f[0] || c;
    }
    return out;
  }

  /**
   * Where the terms occur in a text, as offsets into the original text.
   * @returns {{start: number, end: number, term: string}[]}
   */
  function termRanges(text, terms) {
    const f = fold(text);
    const out = [];
    for (const t of terms) {
      const re = new RegExp(termRegex(t.text).source, "g");
      for (let m; (m = re.exec(f)); ) {
        const start = m.index + m[1].length;
        let end = m.index + m[0].length;
        // a trailing * matches word endings: mark the whole word (build* → "building")
        if (t.text.trim().endsWith("*")) while (end < f.length && /[a-z0-9]/.test(f[end])) end++;
        if (end > start) out.push({ start, end, term: t.text });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  return {
    QuerySyntaxError,
    tokenize,
    parse,
    compile,
    toDNF,
    positiveTerms,
    keywordQueries,
    matches,
    toCanonical,
    termNodes,
    termRanges,
    dialects: Object.keys(dialects),
  };
})();

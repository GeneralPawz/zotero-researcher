/* global ZR */
// What the AI calls cost: tokens (in, of those cached, out, of those reasoning), time and,
// where the provider reports it, money. Every call made through ZR.LLM is recorded; the
// autopilot tags its calls with its session and step and keeps them with the project, so a
// session can be analysed later (which model used how much, for which step).

ZR.Usage = (() => {
  let context = null; // {session, stage} while the autopilot runs
  let sink = null; // where tagged records go (the autopilot's pool file)

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /** Provider reports → {input, cached, output, reasoning, cost, model}. input includes cached. */
  const parse = {
    openai(u = {}, model = "") {
      return { model, input: num(u.prompt_tokens), cached: num(u.prompt_tokens_details?.cached_tokens), output: num(u.completion_tokens), reasoning: num(u.completion_tokens_details?.reasoning_tokens), cost: num(u.cost) };
    },
    anthropic(u = {}, model = "") {
      const cached = num(u.cache_read_input_tokens);
      return { model, input: num(u.input_tokens) + cached + num(u.cache_creation_input_tokens), cached, output: num(u.output_tokens), reasoning: 0, cost: 0 };
    },
    /** Codex --json: the usage of the finished turn(s) */
    codex(stdout = "", model = "") {
      const out = { model, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 };
      for (const line of String(stdout).split("\n")) {
        if (!line.includes('"usage"')) continue;
        try {
          const ev = JSON.parse(line);
          const u = ev.usage || ev.msg?.usage || ev.payload?.usage;
          if (!u || !/turn\.completed|token_count|turn_completed/.test(ev.type || ev.msg?.type || "turn.completed")) continue;
          out.input += num(u.input_tokens);
          out.cached += num(u.cached_input_tokens);
          out.output += num(u.output_tokens);
          out.reasoning += num(u.reasoning_output_tokens);
        } catch (e) {
          /* not an event line */
        }
      }
      return out;
    },
    /** Claude Code --output-format json */
    claude(data = {}, model = "") {
      const u = data.usage || {};
      const cached = num(u.cache_read_input_tokens);
      return { model: Object.keys(data.modelUsage || {})[0] || model, input: num(u.input_tokens) + cached + num(u.cache_creation_input_tokens), cached, output: num(u.output_tokens), reasoning: 0, cost: num(data.total_cost_usd) };
    },
  };

  /** One call: {label, provider, model, effort, ms, ok, input, cached, output, reasoning, cost, what}. */
  function record(rec) {
    const r = Object.assign({ at: new Date().toISOString().slice(0, 19) }, context || {}, rec);
    if (context && sink) {
      try {
        sink(r);
      } catch (e) {
        /* the pool is gone */
      }
    }
    return r;
  }

  const zero = () => ({ calls: 0, failed: 0, input: 0, cached: 0, output: 0, reasoning: 0, ms: 0, cost: 0 });
  const add = (a, r) => {
    a.calls++;
    if (r.ok === false) a.failed++;
    for (const k of ["input", "cached", "output", "reasoning", "ms", "cost"]) a[k] += num(r[k]);
    return a;
  };

  /** Totals, per model, per step, and the slowest calls. */
  function summarize(records = []) {
    const total = records.reduce(add, zero());
    const group = (key) => {
      const m = new Map();
      for (const r of records) {
        const k = key(r);
        m.set(k, add(m.get(k) || Object.assign(zero(), { key: k }), r));
      }
      return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
    };
    return {
      total,
      byModel: group((r) => [r.label || r.provider, r.model || "default", r.effort || ""].filter(Boolean).join(" · ")),
      byStage: group((r) => r.stage || "(outside a step)"),
      slowest: records.slice().sort((a, b) => num(b.ms) - num(a.ms)).slice(0, 5),
      first: records[0]?.at || "",
      last: records.at(-1)?.at || "",
    };
  }

  return {
    parse,
    record,
    summarize,
    setContext(c) {
      context = c;
    },
    setSink(f) {
      sink = f;
    },
    get context() {
      return context;
    },
  };
})();

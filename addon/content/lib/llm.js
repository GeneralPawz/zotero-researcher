/* global ZR */
// Multi-provider LLM client. Most providers speak the OpenAI chat-completions
// protocol; Anthropic uses its native Messages API.
//
// A *profile* is a user-configured {id, name, provider, model, baseURL, temperature}.
// Its API key lives in ZR.Secrets under ZR.Secrets.llmKey(profile.id).

ZR.LLM = (() => {
  const U = ZR.Util;

  const PROVIDERS = [
    {
      id: "claude-cli",
      name: "Claude Code CLI (uses your Claude subscription)",
      protocol: "cli",
      baseURL: "",
      keyURL: "https://docs.anthropic.com/en/docs/claude-code/overview",
      needsKey: false,
      models: ["fable", "opus", "sonnet", "haiku"], // aliases for the latest model of each family
    },
    {
      id: "codex-cli",
      name: "Codex CLI (uses your ChatGPT plan)",
      protocol: "cli",
      baseURL: "",
      keyURL: "https://developers.openai.com/codex/cli",
      needsKey: false,
      models: [],
    },
    {
      id: "openai",
      name: "OpenAI",
      protocol: "openai",
      baseURL: "https://api.openai.com/v1",
      keyURL: "https://platform.openai.com/api-keys",
      needsKey: true,
      models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
      newParams: true,
    },
    {
      id: "anthropic",
      name: "Anthropic (Claude)",
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      keyURL: "https://console.anthropic.com/settings/keys",
      needsKey: true,
      models: ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"],
    },
    {
      id: "gemini",
      name: "Google Gemini",
      protocol: "openai",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      keyURL: "https://aistudio.google.com/app/apikey",
      needsKey: true,
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"],
      // The OpenAI-compatible /models route 404s; list via the native API instead.
      modelsURL: (key) => `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    },
    {
      id: "mistral",
      name: "Mistral AI",
      protocol: "openai",
      baseURL: "https://api.mistral.ai/v1",
      keyURL: "https://console.mistral.ai/api-keys",
      needsKey: true,
      models: ["mistral-medium-latest", "mistral-small-latest", "mistral-large-latest"],
    },
    {
      id: "groq",
      name: "Groq",
      protocol: "openai",
      baseURL: "https://api.groq.com/openai/v1",
      keyURL: "https://console.groq.com/keys",
      needsKey: true,
      models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
    },
    {
      id: "openrouter",
      name: "OpenRouter (many models)",
      protocol: "openai",
      baseURL: "https://openrouter.ai/api/v1",
      keyURL: "https://openrouter.ai/keys",
      needsKey: true,
      models: ["anthropic/claude-sonnet-5", "openai/gpt-6-astra", "google/gemini-3.8-flash"],
      extraHeaders: { "HTTP-Referer": "https://www.zotero.org", "X-Title": "Zotero Researcher" },
    },
    {
      id: "perplexity",
      name: "Perplexity (Sonar: answers with live web search)",
      protocol: "openai",
      baseURL: "https://api.perplexity.ai",
      keyURL: "https://www.perplexity.ai/account/api/keys",
      needsKey: true,
      models: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
      webSearch: true,
      staticModels: true, // no model-listing endpoint
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai",
      baseURL: "https://api.deepseek.com",
      keyURL: "https://platform.deepseek.com/api_keys",
      needsKey: true,
      models: ["deepseek-flash", "deepseek-v4-pro"],
    },
    {
      id: "xai",
      name: "xAI (Grok)",
      protocol: "openai",
      baseURL: "https://api.x.ai/v1",
      keyURL: "https://console.x.ai",
      needsKey: true,
      models: ["grok-4.7", "grok-4.6"],
    },
    {
      id: "ollama",
      name: "Ollama (local)",
      protocol: "openai",
      baseURL: "http://localhost:11434/v1",
      keyURL: "https://ollama.com/download",
      needsKey: false,
      models: ["llama3.1", "qwen2.5", "mistral"],
    },
    {
      id: "lmstudio",
      name: "LM Studio (local)",
      protocol: "openai",
      baseURL: "http://localhost:1234/v1",
      keyURL: "https://lmstudio.ai",
      needsKey: false,
      models: [],
    },
    {
      id: "custom",
      name: "Custom OpenAI-compatible endpoint",
      protocol: "openai",
      baseURL: "",
      keyURL: "",
      needsKey: false,
      models: [],
    },
  ];

  const getProvider = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS.find((p) => p.id === "custom");

  function resolve(profile) {
    if (!profile) throw new Error("No LLM profile configured. Add one in Settings → Zotero Researcher.");
    const provider = getProvider(profile.provider);
    if (provider.protocol === "cli") return { provider, baseURL: "", apiKey: "" };
    const baseURL = (profile.baseURL || provider.baseURL || "").replace(/\/+$/, "");
    if (!baseURL) throw new Error(`LLM profile "${profile.name}" has no base URL`);
    const apiKey = profile.apiKey ?? ZR.Secrets.get(ZR.Secrets.llmKey(profile.id));
    if (provider.needsKey && !apiKey) throw new Error(`LLM profile "${profile.name}" has no API key`);
    if (!profile.model) throw new Error(`LLM profile "${profile.name}" has no model selected`);
    return { provider, baseURL, apiKey };
  }

  // Texts the user reads are written without em / en dashes (they read as machine-made)
  const STYLE = "In any text for the user, do not use em dashes or en dashes; use commas, colons, parentheses or separate sentences.";

  /**
   * Send a chat; recorded in the activity log (prompt and reply excerpts, timing).
   * @param {object} profile
   * @param {{role:string, content:string}[]} messages  user/assistant turns
   * @param {{system?:string, maxTokens?:number, temperature?:number, timeout?:number}} opts
   * @returns {Promise<string>}
   */
  function chat(profile, messages, opts = {}) {
    opts = Object.assign({}, opts, { system: opts.system ? opts.system + "\n\n" + STYLE : STYLE });
    if (!ZR.Activity || !profile) return chatRaw(profile, messages, opts);
    return measured(profile, messages, opts);
  }

  /** Every call: time and tokens, for the autopilot's session analytics. */
  async function measured(profile, messages, opts) {
    const t0 = Date.now();
    let ok = false;
    try {
      const reply = await tracked(profile, messages, opts);
      ok = true;
      return reply;
    } finally {
      const u = opts._usage || {};
      ZR.Usage?.record({ label: profile.name || profile.provider, provider: profile.provider, model: u.model || profile.model || "", effort: profile.effort || "", ms: Date.now() - t0, ok, input: u.input || 0, cached: u.cached || 0, output: u.output || 0, reasoning: u.reasoning || 0, cost: u.cost || 0, what: U.truncate(String(messages[messages.length - 1]?.content || "").replace(/\s+/g, " "), 80) });
    }
  }

  function tracked(profile, messages, opts) {
    const last = messages[messages.length - 1]?.content || "";
    return ZR.Activity.track(
      "ai",
      `${profile.name || profile.provider}${profile.model ? " · " + profile.model : ""}: ${U.truncate(String(last).replace(/\s+/g, " "), 90)}`,
      (opts.system ? "System: " + U.truncate(opts.system, 600) + "\n\n" : "") + "Prompt: " + U.truncate(String(last), 4000),
      () => chatRaw(profile, messages, opts),
      (reply) => `${reply.length.toLocaleString()} characters\n${U.truncate(reply, 3000)}`
    );
  }

  /** Images ({mediaType, data: base64}) go with the last user message, in each API's format. */
  function withImages(messages, images, format) {
    if (!images?.length) return messages;
    const out = messages.slice();
    const i = out.map((m) => m.role).lastIndexOf("user");
    const text = { type: "text", text: String(out[i].content) };
    const pics = images.map((im) => (format === "anthropic" ? { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } } : { type: "image_url", image_url: { url: `data:${im.mediaType};base64,${im.data}` } }));
    out[i] = { role: "user", content: format === "anthropic" ? [...pics, text] : [text, ...pics] };
    return out;
  }

  async function chatRaw(profile, messages, opts = {}) {
    const { provider, baseURL, apiKey } = resolve(profile);
    // Local CLI (Claude Code / Codex): the user's subscription, no API key
    if (provider.protocol === "cli") return ZR.CLI.chat(profile, messages, { system: opts.system, timeout: opts.timeout || 240000, web: !!opts.web, images: opts.images, onUsage: (u) => (opts._usage = u) });
    const maxTokens = opts.maxTokens || 4096;
    const temperature = opts.temperature ?? (profile.temperature !== "" && profile.temperature != null ? Number(profile.temperature) : undefined);
    const timeout = opts.timeout || 180000;

    if (provider.protocol === "anthropic") {
      const body = { model: profile.model, max_tokens: maxTokens, messages: withImages(messages, opts.images, "anthropic") };
      if (opts.system) body.system = opts.system;
      const budget = ANTHROPIC_THINKING[profile.effort];
      if (budget) {
        body.thinking = { type: "enabled", budget_tokens: budget }; // the answer comes after the thinking
        body.max_tokens = Math.max(maxTokens, budget + 2048);
      } else if (temperature !== undefined && !Number.isNaN(temperature)) body.temperature = temperature;
      const res = await ZR.http("POST", `${baseURL}/messages`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body,
        timeout,
      });
      const data = res.json();
      opts._usage = ZR.Usage?.parse.anthropic(data.usage, data.model || profile.model);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text) throw new Error("Empty response from Anthropic" + (data.stop_reason ? ` (${data.stop_reason})` : ""));
      return text;
    }

    const withPics = withImages(messages, opts.images, "openai");
    const msgs = opts.system ? [{ role: "system", content: opts.system }, ...withPics] : withPics;
    const body = { model: profile.model, messages: msgs };
    // OpenAI's current models reject max_tokens and non-default temperatures.
    if (provider.newParams) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (temperature !== undefined && !Number.isNaN(temperature)) body.temperature = temperature;
    if (profile.effort && provider.id === "openai") body.reasoning_effort = profile.effort;
    if (profile.effort && provider.id === "openrouter") body.reasoning = { effort: profile.effort };
    const headers = Object.assign({}, provider.extraHeaders || {});
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await ZR.http("POST", `${baseURL}/chat/completions`, { headers, body, timeout });
    const data = res.json();
    opts._usage = ZR.Usage?.parse.openai(data.usage, data.model || profile.model);
    const choice = data.choices && data.choices[0];
    const content = choice?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || "").join("") : content;
    if (!text) throw new Error("Empty response from LLM" + (choice?.finish_reason ? ` (${choice.finish_reason})` : ""));
    return text;
  }

  /** chat() + parse a JSON reply; retries once with a corrective message if parsing fails. */
  async function chatJSON(profile, messages, opts = {}) {
    const text = await chat(profile, messages, opts);
    try {
      return U.extractJSON(text);
    } catch (e) {
      U.log("LLM JSON parse failed, retrying", e.message);
      const retry = await chat(
        profile,
        [...messages, { role: "assistant", content: text }, { role: "user", content: "That was not valid JSON. Reply again with ONLY the JSON value, no prose, no code fences." }],
        opts
      );
      return U.extractJSON(retry);
    }
  }

  // Models that cannot chat (embeddings, speech, images, moderation, …)
  const NOT_CHAT = /(embed|whisper|tts|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search-preview|computer-use|sora|guard|rerank|ocr)/i;
  const dateOf = (v) => (typeof v === "number" ? new Date(v * 1000).toISOString().slice(0, 10) : String(v || "").slice(0, 10));
  const kTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const perM = (p) => {
    const v = Number(p) * 1e6;
    return v ? `$${v < 1 ? +v.toFixed(3) : +v.toFixed(2)}` : "free";
  };

  /**
   * The models a profile can use, from the provider's own model list.
   *   API providers: their /models endpoint (Anthropic, OpenAI, OpenRouter, Gemini, Mistral, …)
   *   Codex CLI: the model list Codex itself keeps for your account (~/.codex/models_cache.json)
   *   Claude Code: its aliases (fable, opus, sonnet, haiku) plus your account's extra models;
   *                with {resolve: true} each alias is asked once which model it runs.
   * @returns {Promise<{id: string, name: string, detail: string, isDefault?: boolean}[]>}
   */
  const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const API_EFFORTS = ["low", "medium", "high"];
  const ANTHROPIC_THINKING = { low: 2048, medium: 8192, high: 24576 };

  /**
   * How much a model thinks before it answers: {levels, def, from, hints}. Empty levels:
   * the provider has no such setting. Codex reports the levels of each model; lower is
   * faster and more to the point.
   */
  async function effortLevels(profile, models = null) {
    const p = profile.provider;
    if (p === "codex-cli") {
      let list = models;
      if (!list) {
        try {
          list = await ZR.CLI.models(profile);
        } catch (e) {
          list = [];
        }
      }
      const m = list.find((x) => x.id === profile.model) || list.find((x) => x.isDefault) || list[0];
      return { levels: m?.efforts?.length ? m.efforts : ["low", "medium", "high", "xhigh"], def: m?.defaultEffort || "", from: m?.effortFrom || "Codex", hints: m?.effortHints || {} };
    }
    if (p === "claude-cli") return { levels: CLAUDE_EFFORTS, def: "", from: "Claude Code", hints: {} };
    if (p === "anthropic") return { levels: ["off", ...Object.keys(ANTHROPIC_THINKING)], def: "off", from: "the API", hints: { off: "no extended thinking" } };
    if (p === "openai" || p === "openrouter") return { levels: API_EFFORTS, def: "", from: "the model", hints: {} };
    return { levels: [], def: "", from: "", hints: {} };
  }

  async function listModels(profile, { resolve = false } = {}) {
    const provider = getProvider(profile.provider);
    if (provider.protocol === "cli") return ZR.CLI.models(profile, { resolve });
    if (provider.staticModels) return provider.models.map((id) => ({ id, name: id, detail: "" }));
    const baseURL = (profile.baseURL || provider.baseURL || "").replace(/\/+$/, "");
    const apiKey = profile.apiKey ?? ZR.Secrets.get(ZR.Secrets.llmKey(profile.id));
    const headers = Object.assign({}, provider.extraHeaders || {});
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (provider.needsKey && !apiKey && provider.id !== "openrouter") throw new Error("enter the API key first");
    const url = provider.modelsURL && apiKey ? provider.modelsURL(apiKey) : `${baseURL}/models${provider.protocol === "anthropic" ? "?limit=1000" : ""}`;
    if (provider.modelsURL) delete headers.Authorization;
    const data = (await ZR.http("GET", url, { headers, timeout: 30000, noRetry: true })).json();
    const list = data.data || data.models || [];
    let out;
    if (provider.protocol === "anthropic") {
      out = list.map((m) => ({ id: m.id, name: m.display_name || m.id, detail: m.created_at ? "released " + dateOf(m.created_at) : "", order: m.created_at || "" }));
    } else if (provider.id === "openrouter") {
      out = list
        .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          detail: [m.pricing ? `${perM(m.pricing.prompt)} in / ${perM(m.pricing.completion)} out per M tokens` : "", m.context_length ? kTokens(m.context_length) + " context" : ""].filter(Boolean).join(" · "),
          order: m.created || 0,
        }));
    } else if (provider.modelsURL) {
      // Gemini native API
      out = list
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => ({ id: String(m.name).replace(/^models\//, ""), name: m.displayName || m.name, detail: [m.inputTokenLimit ? kTokens(m.inputTokenLimit) + " context" : "", U.truncate(m.description || "", 90)].filter(Boolean).join(" · "), order: 0 }));
    } else {
      out = list
        .map((m) => (typeof m === "string" ? { id: m } : m))
        .filter((m) => m.id && !NOT_CHAT.test(m.id) && m.active !== false && m.capabilities?.completion_chat !== false && !m.deprecation)
        .map((m) => ({
          id: m.id,
          name: m.name && m.name !== m.id ? m.name : m.id,
          detail: [m.max_context_length || m.context_window ? kTokens(m.max_context_length || m.context_window) + " context" : "", m.created ? "released " + dateOf(m.created) : "", U.truncate(m.description || "", 90)].filter(Boolean).join(" · "),
          order: m.created || 0,
        }));
    }
    // Newest first where the provider says when a model came out; otherwise by name
    return out.sort((a, b) => (b.order > a.order ? 1 : b.order < a.order ? -1 : a.name.localeCompare(b.name))).map(({ order, ...m }) => m);
  }

  async function test(profile) {
    const t0 = Date.now();
    // Generous token budget: reasoning models spend tokens before answering.
    const reply = await chat(profile, [{ role: "user", content: "Reply with exactly: OK" }], { maxTokens: 1024, timeout: 60000 });
    return { ok: /ok/i.test(reply), reply: reply.slice(0, 200), ms: Date.now() - t0 };
  }

  return { PROVIDERS, getProvider, chat, chatJSON, listModels, effortLevels, test };
})();

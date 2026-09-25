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
    const baseURL = (profile.baseURL || provider.baseURL || "").replace(/\/+$/, "");
    if (!baseURL) throw new Error(`LLM profile "${profile.name}" has no base URL`);
    const apiKey = profile.apiKey ?? ZR.Secrets.get(ZR.Secrets.llmKey(profile.id));
    if (provider.needsKey && !apiKey) throw new Error(`LLM profile "${profile.name}" has no API key`);
    if (!profile.model) throw new Error(`LLM profile "${profile.name}" has no model selected`);
    return { provider, baseURL, apiKey };
  }

  /**
   * @param {object} profile
   * @param {{role:string, content:string}[]} messages  user/assistant turns
   * @param {{system?:string, maxTokens?:number, temperature?:number, timeout?:number}} opts
   * @returns {Promise<string>}
   */
  async function chat(profile, messages, opts = {}) {
    const { provider, baseURL, apiKey } = resolve(profile);
    const maxTokens = opts.maxTokens || 4096;
    const temperature = opts.temperature ?? (profile.temperature !== "" && profile.temperature != null ? Number(profile.temperature) : undefined);
    const timeout = opts.timeout || 180000;

    if (provider.protocol === "anthropic") {
      const body = { model: profile.model, max_tokens: maxTokens, messages };
      if (opts.system) body.system = opts.system;
      if (temperature !== undefined && !Number.isNaN(temperature)) body.temperature = temperature;
      const res = await ZR.http("POST", `${baseURL}/messages`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body,
        timeout,
      });
      const data = res.json();
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!text) throw new Error("Empty response from Anthropic" + (data.stop_reason ? ` (${data.stop_reason})` : ""));
      return text;
    }

    const msgs = opts.system ? [{ role: "system", content: opts.system }, ...messages] : messages;
    const body = { model: profile.model, messages: msgs };
    // OpenAI's current models reject max_tokens and non-default temperatures.
    if (provider.newParams) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
    if (temperature !== undefined && !Number.isNaN(temperature)) body.temperature = temperature;
    const headers = Object.assign({}, provider.extraHeaders || {});
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await ZR.http("POST", `${baseURL}/chat/completions`, { headers, body, timeout });
    const data = res.json();
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

  async function listModels(profile) {
    const provider = getProvider(profile.provider);
    const baseURL = (profile.baseURL || provider.baseURL || "").replace(/\/+$/, "");
    const apiKey = profile.apiKey ?? ZR.Secrets.get(ZR.Secrets.llmKey(profile.id));
    const headers = Object.assign({}, provider.extraHeaders || {});
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const url = provider.modelsURL && apiKey ? provider.modelsURL(apiKey) : `${baseURL}/models${provider.protocol === "anthropic" ? "?limit=100" : ""}`;
    if (provider.modelsURL) delete headers.Authorization;
    const res = await ZR.http("GET", url, { headers, timeout: 30000, noRetry: true });
    const data = res.json();
    const list = data.data || data.models || [];
    return list
      .map((m) => (typeof m === "string" ? m : m.id || m.name))
      .filter(Boolean)
      .map((id) => id.replace(/^models\//, ""))
      .sort();
  }

  async function test(profile) {
    const t0 = Date.now();
    // Generous token budget: reasoning models spend tokens before answering.
    const reply = await chat(profile, [{ role: "user", content: "Reply with exactly: OK" }], { maxTokens: 1024, timeout: 60000 });
    return { ok: /ok/i.test(reply), reply: reply.slice(0, 200), ms: Date.now() - t0 };
  }

  return { PROVIDERS, getProvider, chat, chatJSON, listModels, test };
})();

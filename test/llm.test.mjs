import { test } from "node:test";
import assert from "node:assert/strict";
import { load, mockHTTP, eq } from "./harness.mjs";

test("Anthropic protocol: headers, system prompt, response parsing", async () => {
  const http = mockHTTP((url, m, o) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(o.headers["x-api-key"], "sk-ant");
    assert.equal(o.headers["anthropic-version"], "2023-06-01");
    assert.equal(o.body.system, "SYS");
    assert.equal(o.body.model, "claude-sonnet-5");
    assert.ok(o.body.max_tokens > 0);
    return { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" };
  });
  const ZR = load({ http });
  const out = await ZR.LLM.chat({ id: "a", name: "A", provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant" }, [{ role: "user", content: "hi" }], { system: "SYS" });
  assert.equal(out, "hello");
});

test("OpenAI protocol: new params for OpenAI, classic for others", async () => {
  const bodies = [];
  const http = mockHTTP((url, m, o) => {
    bodies.push({ url, body: o.body, auth: o.headers.Authorization });
    return { choices: [{ message: { content: "ok" } }] };
  });
  const ZR = load({ http });
  await ZR.LLM.chat({ id: "o", name: "O", provider: "openai", model: "gpt-6-astra", apiKey: "k1" }, [{ role: "user", content: "x" }], { system: "S" });
  await ZR.LLM.chat({ id: "m", name: "M", provider: "mistral", model: "mistral-medium-latest", apiKey: "k2", temperature: 0.2 }, [{ role: "user", content: "x" }]);
  await ZR.LLM.chat({ id: "l", name: "L", provider: "ollama", model: "llama3.1", apiKey: "" }, [{ role: "user", content: "x" }]);
  assert.equal(bodies[0].url, "https://api.openai.com/v1/chat/completions");
  assert.ok(bodies[0].body.max_completion_tokens && !("max_tokens" in bodies[0].body));
  assert.equal(bodies[0].body.messages[0].role, "system");
  assert.equal(bodies[0].auth, "Bearer k1");
  assert.equal(bodies[1].body.temperature, 0.2);
  assert.ok(bodies[1].body.max_tokens);
  assert.equal(bodies[2].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(bodies[2].auth, undefined);
});

test("missing key and model are reported clearly", async () => {
  const ZR = load();
  await assert.rejects(ZR.LLM.chat({ id: "x", name: "X", provider: "openai", model: "m" }, []), /no API key/);
  await assert.rejects(ZR.LLM.chat({ id: "x", name: "X", provider: "ollama", model: "" }, []), /no model/);
  await assert.rejects(ZR.LLM.chat(null, []), /No LLM profile/);
});

test("listModels: each provider's own model list, with names and details", async () => {
  const http = mockHTTP((url, method, o) => {
    if (url.includes("generativelanguage")) {
      assert.match(url, /v1beta\/models\?pageSize=200&key=G/);
      return {
        models: [
          { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-9", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        ],
      };
    }
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      assert.equal(o.headers["x-api-key"], "k");
      assert.equal(o.headers["anthropic-version"], "2023-06-01");
      return { data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-03-01T00:00:00Z" }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-08-01T00:00:00Z" }] };
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      return {
        data: [
          { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", context_length: 1000000, pricing: { prompt: "0.000003", completion: "0.000015" }, architecture: { output_modalities: ["text"] }, created: 1772000000 },
          { id: "x/image-gen", name: "Image model", architecture: { output_modalities: ["image"] } },
        ],
      };
    }
    if (url === "https://api.openai.com/v1/models") return { data: [{ id: "gpt-6-luna", created: 1770000000 }, { id: "text-embedding-4", created: 1780000000 }, { id: "gpt-6-astra", created: 1775000000 }, { id: "whisper-2" }] };
    return { data: [{ id: "b" }, { id: "a" }] };
  });
  const ZR = load({ http });
  eq((await ZR.LLM.listModels({ provider: "groq", apiKey: "k" })).map((m) => m.id), ["a", "b"]);
  const gemini = await ZR.LLM.listModels({ provider: "gemini", apiKey: "G" });
  eq(gemini.map((m) => [m.id, m.name]), [["gemini-3.8-flash", "Gemini 3.8 Flash"]]);
  assert.match(gemini[0].detail, /1M context/);
  const claude = await ZR.LLM.listModels({ provider: "anthropic", apiKey: "k" });
  eq(claude.map((m) => m.name), ["Claude Opus 5.5", "Claude Sonnet 5"], "newest first, display names");
  assert.ok(http.calls.some((c) => /anthropic\.com\/v1\/models\?limit=1000/.test(c.url)));
  const or = await ZR.LLM.listModels({ provider: "openrouter" }); // public list, no key needed
  eq(or.map((m) => m.id), ["anthropic/claude-sonnet-5"], "text models only");
  assert.equal(or[0].detail, "$3 in / $15 out per M tokens · 1M context");
  const openai = await ZR.LLM.listModels({ provider: "openai", apiKey: "k" });
  eq(openai.map((m) => m.id), ["gpt-6-astra", "gpt-6-luna"], "chat models only, newest first");
  await assert.rejects(ZR.LLM.listModels({ provider: "anthropic", apiKey: "" }), /API key/);
});

test("listModels for the CLIs reads what the CLIs themselves know", async () => {
  const files = {
    "/home/.codex/models_cache.json": JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence.", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", description: "Everyday work.", visibility: "list" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ],
    }),
    "/home/.codex/config.toml": 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "medium"\n',
    "/home/.claude/settings.json": JSON.stringify({ model: "opus[1m]" }),
    "/home/.claude.json": JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable", description: "Fable 5.1 · Most capable" }] }),
  };
  const globals = {
    IOUtils: {
      readUTF8: async (p) => {
        if (!(p in files)) throw new Error("ENOENT " + p);
        return files[p];
      },
      exists: async (p) => p in files,
    },
    PathUtils: { join: (...a) => a.join("/") },
    Services: { env: { get: () => "" }, dirsvc: { get: () => ({ path: "/home" }) }, appinfo: { OS: "Linux" } },
    Components: { interfaces: { nsIFile: {} } },
  };
  const ZR = load({ globals });
  const codex = await ZR.LLM.listModels({ provider: "codex-cli" });
  eq(codex.map((m) => [m.id, m.name, !!m.isDefault]), [["gpt-6-astra", "GPT-6-Astra", false], ["gpt-5.6-terra", "GPT-5.6-Terra", true]], "hidden models left out; your default marked");
  assert.match(codex[0].detail, /reasoning: low, high/);
  const claude = await ZR.LLM.listModels({ provider: "claude-cli" });
  eq(claude.map((m) => m.id), ["fable", "opus", "sonnet", "haiku", "claude-fable-5-1[1m]"]);
  assert.equal(claude.find((m) => m.isDefault).id, "opus", "default from Claude Code settings");
  // Resolved aliases (from an earlier check) show the exact model
  ZR.Prefs.setJSON("claudeModelMap", { sonnet: { id: "claude-sonnet-5", at: "2026-09-25" } });
  assert.match((await ZR.LLM.listModels({ provider: "claude-cli" })).find((m) => m.id === "sonnet").detail, /runs claude-sonnet-5/);
});

test("planQuery validates the LLM's boolean query", async () => {
  const http = mockHTTP(() => ({ choices: [{ message: { content: 'Here: {"query": "(\\"IFC 5\\" OR IFCX) AND BIM", "yearFrom": 2019, "yearTo": null, "concepts": ["IFC"], "rationale": "r"}' } }] }));
  const ZR = load({ http });
  const plan = await ZR.Assist.planQuery({ id: "p", name: "P", provider: "groq", model: "m", apiKey: "k" }, "IFC5 stuff");
  assert.equal(plan.query, '("IFC 5" OR IFCX) AND BIM');
  assert.equal(plan.yearFrom, 2019);
  assert.equal(plan.yearTo, null);
});

test("chatJSON retries once when the reply is not JSON", async () => {
  let n = 0;
  const http = mockHTTP(() => ({ choices: [{ message: { content: n++ === 0 ? "I cannot format that" : '{"ok": true}' } }] }));
  const ZR = load({ http });
  eq(await ZR.LLM.chatJSON({ id: "p", name: "P", provider: "groq", model: "m", apiKey: "k" }, [{ role: "user", content: "x" }]), { ok: true });
  assert.equal(http.calls.length, 2);
});

test("screen assigns scores per record and survives a failed batch", async () => {
  let call = 0;
  const http = mockHTTP(() => {
    call++;
    if (call === 2) throw new Error("boom");
    return { choices: [{ message: { content: JSON.stringify([{ i: 0, score: 9, reason: "on topic" }, { i: 1, score: 2, reason: "off" }]) } }] };
  });
  const ZR = load({ http });
  const recs = [0, 1, 2, 3].map((i) => ZR.Records.make("x", { title: "T" + i }));
  await ZR.Assist.screen({ id: "p", name: "P", provider: "groq", model: "m", apiKey: "k" }, "req", recs, { batchSize: 2 });
  assert.equal(recs[0].llmScore, 9);
  assert.equal(recs[1].llmScore, 2);
  assert.equal(recs[2].llmScore, undefined);
  assert.match(recs[2].llmReason, /screening failed/);
});

test("sanitizeHTML strips scripts, styles and attributes", () => {
  const ZR = load();
  const out = ZR.Assist.sanitizeHTML('<h2 onclick="x()">T</h2><script>alert(1)</script><table style="c"><tr><td>1</td></tr></table><a href="javascript:x">j</a><a href="https://ok">k</a><img src=x>');
  assert.equal(out, '<h2>T</h2><table><tr><td>1</td></tr></table><a>j</a><a href="https://ok">k</a>');
});

test("CLI providers (Claude Code / Codex) need no key or model and route to the CLI bridge", async () => {
  const ZR = load();
  const calls = [];
  ZR.CLI.chat = async (profile, messages, opts) => {
    calls.push({ provider: profile.provider, messages, system: opts.system });
    return '{"query": "BIM AND IFC", "yearFrom": null, "yearTo": null, "concepts": [], "rationale": "r"}';
  };
  const plan = await ZR.Assist.planQuery({ id: "c", name: "Claude Code", provider: "claude-cli", model: "", baseURL: "" }, "BIM papers");
  assert.equal(plan.query, "BIM AND IFC");
  assert.equal(calls[0].provider, "claude-cli");
  assert.match(calls[0].system, /research librarian/);
  const ids = ZR.LLM.PROVIDERS.map((p) => p.id);
  for (const id of ["claude-cli", "codex-cli", "anthropic", "openrouter"]) assert.ok(ids.includes(id), id);
});

test("multi-turn chats are flattened into one CLI prompt", () => {
  const ZR = load();
  assert.equal(ZR.CLI.transcript([{ role: "user", content: "Hi" }], "SYS", false), "Hi");
  assert.equal(ZR.CLI.transcript([{ role: "user", content: "Hi" }], "SYS", true), "Instructions:\nSYS\n\nHi");
  const t = ZR.CLI.transcript([{ role: "user", content: "A" }, { role: "assistant", content: "B" }, { role: "user", content: "C" }], "", false);
  assert.equal(t, "User:\nA\n\nAssistant:\nB\n\nUser:\nC\n\nAssistant:");
});

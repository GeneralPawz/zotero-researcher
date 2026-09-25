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

test("listModels: OpenAI-style, Anthropic, and Gemini native endpoint", async () => {
  const http = mockHTTP((url) => {
    if (url.includes("generativelanguage")) {
      assert.match(url, /v1beta\/models\?pageSize=200&key=G/);
      return { models: [{ name: "models/gemini-3.8-flash" }] };
    }
    return { data: [{ id: "b" }, { id: "a" }] };
  });
  const ZR = load({ http });
  eq(await ZR.LLM.listModels({ provider: "groq", apiKey: "k" }), ["a", "b"]);
  eq(await ZR.LLM.listModels({ provider: "gemini", apiKey: "G" }), ["gemini-3.8-flash"]);
  await ZR.LLM.listModels({ provider: "anthropic", apiKey: "k" });
  assert.match(http.calls[2].url, /api\.anthropic\.com\/v1\/models\?limit=100/);
  assert.equal(http.calls[2].options.headers["x-api-key"], "k");
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

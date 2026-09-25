// Loads the plugin's pure-logic modules into a Node VM context (no Zotero), the same
// way bootstrap.js loads them into the plugin scope.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const content = join(fileURLToPath(import.meta.url), "..", "..", "addon", "content");
const FILES = ["lib/util.js", "lib/prefs.js", "lib/secrets.js", "lib/store.js", "lib/query.js", "lib/querybuilder.js", "lib/records.js", "sources/registry.js", "sources/adapters.js", "lib/llm.js", "lib/cli.js", "lib/assist.js", "lib/prisma.js", "lib/citations.js", "lib/search.js"];

export function load({ http, prefs = {} } = {}) {
  const ZR = { id: "test", version: "test" };
  const ctx = vm.createContext({ ZR, console, setTimeout, clearTimeout, URLSearchParams, TextEncoder });
  for (const f of FILES) vm.runInContext(readFileSync(join(content, f), "utf8"), ctx, { filename: f });
  const store = new Map(Object.entries(prefs));
  ZR.Prefs._backend = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  ZR.http = http || (async () => {
    throw new Error("network disabled in tests");
  });
  return ZR;
}

/** Mock transport: route(url, method, options) -> JSON value or {status, text}. */
export function mockHTTP(route) {
  const calls = [];
  const fn = async (method, url, options = {}) => {
    calls.push({ method, url, options });
    const r = await route(url, method, options);
    const text = typeof r === "string" ? r : JSON.stringify(r);
    return { status: 200, text, json: () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}

/** deepStrictEqual across VM realms (prototypes differ, so compare plain JSON). */
export const eq = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

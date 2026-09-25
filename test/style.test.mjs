import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "./harness.mjs";

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test("the plugin has no em or en dashes (they read as machine-made)", () => {
  const found = [];
  for (const f of walk("addon")) {
    if (!/\.(js|mjs|xhtml|html|css|ftl|json)$/.test(f)) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => /[–—]/.test(l) && found.push(`${f}:${i + 1}`));
  }
  assert.deepEqual(found, []);
});

test("AI text is shown without dashes", () => {
  const { Util: U } = load();
  assert.equal(U.undash("Scoping review — the question is broad."), "Scoping review, the question is broad.");
  assert.equal(U.undash("years 2019–2024, pages 3 – 9"), "years 2019-2024, pages 3-9");
  assert.equal(U.undash("a clear fit—exactly on topic —."), "a clear fit, exactly on topic.");
});

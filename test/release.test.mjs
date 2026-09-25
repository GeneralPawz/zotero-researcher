import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8"));

test("manifest points Zotero's update check at the release branch", () => {
  const z = manifest.applications.zotero;
  assert.equal(z.update_url, "https://raw.githubusercontent.com/GeneralPawz/zotero-researcher/release/updates.json");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("updates.json has the add-on manager's format and the XPI hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-upd-"));
  const xpi = join(dir, "fake.xpi");
  writeFileSync(xpi, "not really a zip");
  const out = join(dir, "updates.json");
  const url = `https://github.com/GeneralPawz/zotero-researcher/releases/download/v${manifest.version}/zotero-researcher-${manifest.version}.xpi`;
  execFileSync(process.execPath, [join(root, "scripts", "updates-json.mjs"), xpi, url, out]);
  const u = JSON.parse(readFileSync(out, "utf8"));
  const entry = u.addons[manifest.applications.zotero.id].updates[0];
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.update_link, url);
  assert.equal(entry.update_hash, "sha256:" + createHash("sha256").update("not really a zip").digest("hex"));
  assert.equal(entry.applications.zotero.strict_max_version, manifest.applications.zotero.strict_max_version);
  rmSync(dir, { recursive: true, force: true });
});

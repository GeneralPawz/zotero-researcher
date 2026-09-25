// Writes the update manifest Zotero polls (manifest.json → applications.zotero.update_url).
//
//   node scripts/updates-json.mjs <xpi> <download-url> [out=updates.json]
//
// Format: Firefox/Zotero add-on update manifest. The sha256 lets Zotero verify the
// download before installing it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const [xpi, url, out = "updates.json"] = process.argv.slice(2);
if (!xpi || !url) {
  console.error("usage: node scripts/updates-json.mjs <xpi> <download-url> [out]");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8"));
const z = manifest.applications.zotero;
const hash = createHash("sha256").update(readFileSync(xpi)).digest("hex");

const updates = {
  addons: {
    [z.id]: {
      updates: [
        {
          version: manifest.version,
          update_link: url,
          update_hash: `sha256:${hash}`,
          applications: { zotero: { strict_min_version: z.strict_min_version, strict_max_version: z.strict_max_version } },
        },
      ],
    },
  },
};
writeFileSync(out, JSON.stringify(updates, null, 2) + "\n");
console.log(`Wrote ${out}: ${z.id} ${manifest.version} sha256:${hash.slice(0, 12)}…`);

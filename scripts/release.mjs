// Ship the current main branch: merge main into release and push it. The Release
// GitHub Action then builds the XPI, publishes GitHub Release v<version>, and updates
// updates.json on the release branch, which installed plugins poll for updates.
//
//   npm run release
//
// Bump "version" in addon/manifest.json (and package.json) on main first.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "inherit" });
const fail = (msg) => {
  console.error("✗ " + msg);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8")).version;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (pkg !== version) fail(`package.json (${pkg}) and addon/manifest.json (${version}) disagree`);
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("run this from the main branch");
if (git("status", "--porcelain")) fail("commit or stash your changes first");

run("fetch", "origin", "--tags");
if (git("tag", "--list", `v${version}`)) fail(`v${version} is already released — bump the version in addon/manifest.json and package.json`);
if (git("rev-list", "--count", "origin/main..main") !== "0") fail("main has unpushed commits — git push first");

// Merge main into release in place (updates.json only exists on release, so no conflicts).
run("switch", "--quiet", "-C", "release", "origin/release");
try {
  run("merge", "--no-edit", "--no-ff", "-m", `Release v${version}`, "main");
  run("push", "origin", "release");
} finally {
  run("switch", "--quiet", "main");
}
console.log(`✓ Pushed release v${version}. Follow the build with: gh run watch --repo GeneralPawz/zotero-researcher`);

// End-to-end test in a real Zotero: builds the XPI, installs it into a throwaway
// profile + data directory, starts a separate Zotero instance (-no-remote), lets the
// in-app self-test (content/lib/selftest.js) drive the UI and live APIs, then prints
// the report. Your normal Zotero profile and library are never touched.
//
//   node scripts/e2e.mjs [--zotero "C:\Program Files\Zotero\zotero.exe"] [--keep-open] [--clean]
//   node scripts/e2e.mjs --update   installs an old build (0.0.1) and checks that
//                                   "Check for updates" pulls the published GitHub release
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const defaultExe = process.platform === "win32" ? "C:\\Program Files\\Zotero\\zotero.exe" : process.platform === "darwin" ? "/Applications/Zotero.app/Contents/MacOS/zotero" : "zotero";
const exe = opt("--zotero", defaultExe);
const keepOpen = argv.includes("--keep-open");
const base = opt("--dir", join(tmpdir(), `zr-e2e-${Date.now()}`));

const updateTest = argv.includes("--update");
const buildEnv = updateTest ? { ...process.env, ZR_BUILD_VERSION: "0.0.1" } : process.env;
execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit", env: buildEnv });
const version = updateTest ? "0.0.1" : JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8")).version;
const { applications } = JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8"));
const id = applications.zotero.id;

const profile = join(base, "profile");
const data = join(base, "data");
const out = join(base, "out");
for (const d of [profile, data, out, join(profile, "extensions")]) mkdirSync(d, { recursive: true });
copyFileSync(join(root, "build", `zotero-researcher-${version}.xpi`), join(profile, "extensions", `${id}.xpi`));

const js = (v) => JSON.stringify(v);
const prefs = {
  "extensions.zotero.dataDir": data,
  "extensions.zotero.useDataDir": true,
  "extensions.zotero.firstRunGuidance": false,
  "extensions.zotero.sync.autoSync": false,
  "extensions.zotero.debug.store": true,
  "extensions.zotero.automaticScraperUpdates": false,
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 15,
  "app.update.enabled": false,
  // Fresh profiles otherwise pop up word-processor plugin install prompts.
  "extensions.zoteroWinWordIntegration.skipInstallation": true,
  "extensions.zoteroOpenOfficeIntegration.skipInstallation": true,
  "extensions.zotero-researcher.selftest": out,
  "extensions.zotero-researcher.selftestQuit": !keepOpen,
  "extensions.zotero-researcher.selftestMode": updateTest ? "update" : "",
};
writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${js(k)}, ${js(v)});`).join("\n") + "\n");

console.log(`Profile: ${profile}\nOutput:  ${out}\nStarting ${exe} …`);
// On Windows the launcher process exits immediately after starting the real app, so
// completion is detected by polling the report rather than waiting on the child.
spawn(exe, ["-profile", profile, "-no-remote"], { stdio: "ignore", detached: true }).unref();
const reportPath = join(out, "report.json");
const deadline = Date.now() + 12 * 60 * 1000;
const readReport = () => {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    return null;
  }
};
let report;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  report = readReport();
  if (report?.finished) break;
  if (Date.now() > deadline) {
    console.error(report ? "Timed out; partial report follows" : "Timed out without a report — was the plugin loaded?");
    if (!report) process.exit(1);
    break;
  }
}
for (const s of report.steps) {
  console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.name}  (${s.ms} ms)`);
  const detail = s.ok ? s.result : s.error;
  if (detail !== undefined && detail !== true) console.log("      " + JSON.stringify(detail, null, 2).replace(/\n/g, "\n      "));
}
console.log(`\n${report.passed} passed, ${report.failed} failed — screenshots in ${out}`);
if (argv.includes("--clean") && !report.failed) rmSync(base, { recursive: true, force: true });
process.exit(report.failed ? 1 : 0);

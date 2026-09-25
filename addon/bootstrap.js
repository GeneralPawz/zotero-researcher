/* global Zotero, Services, Components, ChromeUtils */
/* eslint-disable no-unused-vars */

var chromeHandle;
var ZR;

// Order matters: later files depend on earlier ones.
const LIB_FILES = [
  "lib/util.js",
  "lib/prefs.js",
  "lib/secrets.js",
  "lib/store.js",
  "lib/query.js",
  "lib/querybuilder.js",
  "lib/records.js",
  "sources/registry.js",
  "sources/adapters.js",
  "lib/llm.js",
  "lib/assist.js",
  "lib/prisma.js",
  "lib/citations.js",
  "lib/importer.js",
  "lib/search.js",
  "lib/enrich.js",
  "lib/updater.js",
  "lib/ui.js",
  "lib/selftest.js",
];

function install() {}

async function startup({ id, version, rootURI }) {
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-researcher", rootURI + "content/"],
  ]);

  ZR = { id, version, rootURI, chromeRoot: "chrome://zotero-researcher/content/" };
  const scope = { ZR, Zotero, Services, Components, ChromeUtils };
  for (const file of LIB_FILES) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + file, scope);
  }
  ZR.http = ZR.Util.zoteroHTTP;
  Zotero.Researcher = ZR;

  await ZR.UI.startup();
  for (const win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) ZR.UI.onMainWindowLoad(win);
  }
  ZR.SelfTest.maybeRun();
}

function onMainWindowLoad({ window }) {
  ZR?.UI.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  ZR?.UI.onMainWindowUnload(window);
}

async function shutdown() {
  try {
    await ZR?.UI.shutdown();
  } finally {
    delete Zotero.Researcher;
    ZR = undefined;
    chromeHandle?.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}

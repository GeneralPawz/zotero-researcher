/* global ZR, ChromeUtils */
// "Check for updates" through Zotero's add-on manager. It reads the update manifest at
// manifest.json → applications.zotero.update_url (updates.json on the GitHub `release`
// branch), downloads the XPI from the GitHub release, verifies its sha256, and
// installs it. Zotero also checks automatically about once a day.

ZR.Updater = (() => {
  const AM = () => ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;

  /** @returns {Promise<{status: "current"|"available"|"error", version?: string, install?: object, error?: string}>} */
  async function check() {
    const AddonManager = AM();
    const addon = await AddonManager.getAddonByID(ZR.id);
    if (!addon) return { status: "error", error: "plugin not found in the add-on manager" };
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      addon.findUpdates(
        {
          onUpdateAvailable: (a, install) => finish({ status: "available", version: install.version, install }),
          onNoUpdateAvailable: () => finish({ status: "current", version: addon.version }),
          onUpdateFinished: (a, error) => {
            if (error) finish({ status: "error", error: `update check failed (code ${error}): are you online?` });
            else finish({ status: "current", version: addon.version });
          },
        },
        AddonManager.UPDATE_WHEN_USER_REQUESTED
      );
    });
  }

  /** Download + install. The plugin restarts itself afterwards (no Zotero restart needed). */
  function install(install) {
    return new Promise((resolve, reject) => {
      install.addListener({
        onDownloadFailed: () => reject(new Error("download failed")),
        onInstallFailed: () => reject(new Error("installation failed")),
        onInstallEnded: (i, addon) => resolve(addon.version),
      });
      install.install();
    });
  }

  return { check, install };
})();

/* global ZR, Services, Components */
// API keys live in the Firefox/Zotero login manager (encrypted with the profile key,
// or the OS keystore when a primary password is set), never in prefs.js.

ZR.Secrets = (() => {
  const ORIGIN = "chrome://zotero-researcher";
  const REALM = "Zotero Researcher API keys";
  const memory = new Map();
  const hasLoginManager = () => typeof Services !== "undefined" && !!Services.logins;

  function find(name) {
    return Services.logins.findLogins(ORIGIN, null, REALM).find((l) => l.username === name) || null;
  }

  return {
    get(name) {
      if (!hasLoginManager()) return memory.get(name) || "";
      try {
        return find(name)?.password || "";
      } catch (e) {
        ZR.Util.log("Login manager read failed", e.message);
        return "";
      }
    },

    async set(name, value) {
      if (!hasLoginManager()) {
        if (value) memory.set(name, value);
        else memory.delete(name);
        return;
      }
      const existing = find(name);
      if (!value) {
        if (existing) Services.logins.removeLogin(existing);
        return;
      }
      const LoginInfo = new Components.Constructor(
        "@mozilla.org/login-manager/loginInfo;1",
        Components.interfaces.nsILoginInfo,
        "init"
      );
      const info = new LoginInfo(ORIGIN, null, REALM, name, value, "", "");
      if (existing) Services.logins.modifyLogin(existing, info);
      else await Services.logins.addLoginAsync(info);
    },

    sourceKey: (id) => `source:${id}`,
    llmKey: (profileID) => `llm:${profileID}`,
  };
})();

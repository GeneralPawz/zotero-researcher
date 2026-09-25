/* global ZR, Zotero */
// Thin wrapper over Zotero.Prefs for the plugin's branch. Tests replace ZR.Prefs._backend.

ZR.Prefs = (() => {
  const BRANCH = "extensions.zotero-researcher.";

  const zoteroBackend = {
    get: (k) => Zotero.Prefs.get(BRANCH + k, true),
    set: (k, v) => Zotero.Prefs.set(BRANCH + k, v, true),
  };

  const api = {
    BRANCH,
    _backend: typeof Zotero !== "undefined" ? zoteroBackend : null,
    get(key, fallback) {
      const v = api._backend.get(key);
      return v === undefined || v === null ? fallback : v;
    },
    set(key, value) {
      api._backend.set(key, value);
    },
    getJSON(key, fallback) {
      try {
        const raw = api.get(key, "");
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        ZR.Util.log(`Bad JSON in pref ${key}`, e.message);
        return fallback;
      }
    },
    setJSON(key, value) {
      api.set(key, JSON.stringify(value));
    },

    // --- LLM profiles -----------------------------------------------------
    getLLMProfiles() {
      return api.getJSON("llmProfiles", []);
    },
    setLLMProfiles(list) {
      api.setJSON("llmProfiles", list);
    },
    getActiveLLMProfile() {
      const list = api.getLLMProfiles();
      const id = api.get("activeLLMProfile", "");
      return list.find((p) => p.id === id) || list[0] || null;
    },

    // --- Source settings --------------------------------------------------
    getSourceSettings() {
      return api.getJSON("sources", {});
    },
    setSourceSetting(id, patch) {
      const all = api.getSourceSettings();
      all[id] = Object.assign({}, all[id], patch);
      api.setJSON("sources", all);
    },
  };
  return api;
})();

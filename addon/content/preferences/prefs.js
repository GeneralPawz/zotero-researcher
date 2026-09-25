/* global Zotero, document, ZRDropdown */
// Settings pane controller. Loaded into a sandbox before the pane markup is inserted,
// so initialization waits for the pane's `load` event (dispatched on #zr-prefs).

var ZRPrefsPane = (() => {
  const HTML = "http://www.w3.org/1999/xhtml";
  let ZR;
  let srcFilter = "all";
  let srcSearch = "";
  let showHiddenAreas = false;
  let editing = null; // profile being edited (copy) or null

  function el(tag, props = {}, children = []) {
    const e = document.createElementNS(HTML, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c != null && c !== false) e.append(c);
    return e;
  }

  const link = (text, url) => el("a", { href: "#", class: "zr-link", text, onclick: (ev) => (ev.preventDefault(), Zotero.launchURL(url)) });

  function init() {
    ZR = Zotero.Researcher;
    if (!ZR || !document.getElementById("zr-llm-list")) return;
    ZRDropdown.observe(document, document.getElementById("zr-prefs"));
    renderChecklist();
    renderAreas();
    renderLLMList();
    renderSourcesToolbar();
    renderSources();
    document.getElementById("zr-replay-tour").addEventListener("click", () => {
      ZR.Prefs.set("tourSeen", false);
      ZR.UI.openDialog(Zotero.getMainWindow(), { tour: true, tab: "find" });
    });
    document.getElementById("zr-show-ledger").addEventListener("click", showLedger);
    document.getElementById("zr-version").textContent = `Installed: version ${ZR.version}`;
    document.getElementById("zr-check-updates").addEventListener("click", checkUpdates);
    document.getElementById("zr-email").addEventListener("change", () => setTimeout(renderChecklist, 100));
  }

  // ----------------------------------------------------- getting started ----
  function renderChecklist() {
    const box = document.getElementById("zr-checklist");
    const email = !!ZR.Prefs.get("email", "");
    const ai = ZR.Prefs.getLLMProfiles().length > 0;
    const oaKey = !!ZR.Sources.keyFor("openalex");
    const rows = [
      [true, "Free databases work right away — click the Researcher button next to “New Note”."],
      [email, email ? "E-mail set: Unpaywall can find open-access PDFs." : "Add your e-mail below so open-access PDFs can be found (Unpaywall)."],
      [oaKey, oaKey ? "OpenAlex key set." : "Recommended: a free OpenAlex key (Databases → OpenAlex). Without it OpenAlex allows only ~100 searches a day."],
      [ai, ai ? "AI is set up." : "Optional: add an AI provider to describe searches in plain words, screen papers and compare them."],
    ];
    box.replaceChildren(...rows.map(([ok, text]) => el("div", { class: "zr-check-row" }, [el("span", { class: ok ? "zr-good" : "zr-todo", text: ok ? "✓" : "○" }), el("span", { text })])));
  }

  // ------------------------------------------------------- research areas ----
  function renderAreas() {
    const box = document.getElementById("zr-areas");
    box.replaceChildren();
    for (const d of ZR.Sources.DISCIPLINES) {
      const cb = el("input", {
        type: "checkbox",
        checked: ZR.Sources.disciplineEnabled(d.id),
        disabled: !!d.locked,
        onchange: (e) => {
          ZR.Sources.setDisciplineEnabled(d.id, e.target.checked);
          renderSources();
        },
      });
      box.append(el("label", { class: "zr-area" + (d.locked ? " locked" : "") }, [cb, el("div", {}, [el("div", { class: "zr-name", text: d.name + (d.locked ? " (always on)" : "") }), el("div", { class: "zr-help", text: d.description })])]));
    }
  }

  // --------------------------------------------------------------- updates ----
  async function checkUpdates() {
    const btn = document.getElementById("zr-check-updates");
    const status = document.getElementById("zr-update-status");
    const Updater = ZR.Updater; // keep a reference: the plugin reloads itself after updating
    const set = (text, cls = "") => {
      status.textContent = text;
      status.className = "zr-status " + cls;
    };
    btn.disabled = true;
    set("checking…");
    try {
      const r = await Updater.check();
      if (r.status === "error") set(r.error, "zr-bad");
      else if (r.status === "current") set(`You have the latest version (${r.version}).`, "zr-good");
      else {
        set(`Installing version ${r.version}…`);
        const v = await Updater.install(r.install);
        set(`Updated to ${v}. Close and reopen Settings to see the new version.`, "zr-good");
      }
    } catch (e) {
      set("Update failed: " + e.message, "zr-bad");
    } finally {
      btn.disabled = false;
    }
  }

  async function showLedger() {
    const status = document.getElementById("zr-ledger-status");
    const win = Zotero.getMainWindow();
    const libraryID = win?.ZoteroPane.getSelectedLibraryIDs?.()[0] ?? Zotero.Libraries.userLibraryID;
    await ZR.Store.flush(libraryID);
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("tag", "is", ZR.Store.TAG.ledger);
    const ids = await s.search();
    if (!ids.length) {
      status.textContent = "No ledger yet in this library — it is created with your first judgement or review.";
      return;
    }
    await win.ZoteroPane.selectItem(ids[0]);
    win.focus();
    status.textContent = "Selected in the main window.";
  }

  // ------------------------------------------------------------ LLM ----
  function renderLLMList() {
    const box = document.getElementById("zr-llm-list");
    box.replaceChildren();
    const profiles = ZR.Prefs.getLLMProfiles();
    const active = ZR.Prefs.getActiveLLMProfile();
    if (!profiles.length) box.append(el("div", { class: "zr-empty", text: "No AI set up yet. AI features (describing searches, rating and screening papers, comparisons, AI metadata) stay off until you add one." }));
    else {
      const table = el("table", { class: "zr-table" }, [
        el("tr", {}, ["Active", "Name", "Provider", "Model", "Key", ""].map((t) => el("th", { text: t }))),
      ]);
      for (const p of profiles) {
        const provider = ZR.LLM.getProvider(p.provider);
        const hasKey = !!ZR.Secrets.get(ZR.Secrets.llmKey(p.id));
        const status = el("span", { class: "zr-status" });
        table.append(
          el("tr", {}, [
            el("td", {}, el("input", { type: "radio", name: "zr-active-llm", checked: active && active.id === p.id, onchange: () => (ZR.Prefs.set("activeLLMProfile", p.id), renderLLMList()) })),
            el("td", { text: p.name }),
            el("td", { text: provider.name }),
            el("td", { text: p.model, class: "zr-mono" }),
            el("td", { text: provider.needsKey ? (hasKey ? "✓ stored" : "missing") : "not needed", class: provider.needsKey && !hasKey ? "zr-bad" : "" }),
            el("td", { class: "zr-actions" }, [
              el("button", { text: "Test", onclick: () => testProfile(p, status) }),
              el("button", { text: "Edit", onclick: () => openEditor(p) }),
              el("button", { text: "Delete", onclick: () => deleteProfile(p) }),
              status,
            ]),
          ])
        );
      }
      box.append(table);
    }
    box.append(el("div", { class: "zr-actions" }, el("button", { text: "+ Add AI provider", onclick: () => openEditor(null) })));
  }

  async function testProfile(p, status) {
    status.className = "zr-status";
    status.textContent = "testing…";
    try {
      const r = await ZR.LLM.test(p);
      status.textContent = r.ok ? `OK (${r.ms} ms)` : `answered: ${r.reply}`;
      status.classList.add(r.ok ? "zr-good" : "zr-bad");
    } catch (e) {
      status.textContent = e.message;
      status.classList.add("zr-bad");
    }
  }

  async function deleteProfile(p) {
    const list = ZR.Prefs.getLLMProfiles().filter((x) => x.id !== p.id);
    ZR.Prefs.setLLMProfiles(list);
    await ZR.Secrets.set(ZR.Secrets.llmKey(p.id), "");
    if (ZR.Prefs.get("activeLLMProfile", "") === p.id) ZR.Prefs.set("activeLLMProfile", list[0]?.id || "");
    renderLLMList();
  }

  function openEditor(p) {
    const isNew = !p;
    const providerID = p?.provider || "openai";
    editing = p ? Object.assign({}, p) : { id: "llm-" + Date.now().toString(36), name: "", provider: providerID, baseURL: "", model: "", temperature: "" };
    const box = document.getElementById("zr-llm-editor");
    box.replaceChildren();

    const providerSel = el("select", { id: "zr-llm-provider" }, ZR.LLM.PROVIDERS.map((x) => el("option", { value: x.id, text: x.name, selected: x.id === editing.provider })));
    const name = el("input", { type: "text", value: editing.name, placeholder: "e.g. Claude Sonnet (work)", size: 30 });
    const baseURL = el("input", { type: "text", value: editing.baseURL, size: 46, class: "zr-mono" });
    const key = el("input", { type: "password", size: 46, value: isNew ? "" : ZR.Secrets.get(ZR.Secrets.llmKey(editing.id)), placeholder: "API key", autocomplete: "off" });
    const showKey = el("button", { text: "show", onclick: () => ((key.type = key.type === "password" ? "text" : "password"), (showKey.textContent = key.type === "password" ? "show" : "hide")) });
    const keyLink = el("span");
    const model = el("input", { type: "text", value: editing.model, size: 34, list: "zr-model-list", class: "zr-mono", placeholder: "model id" });
    const datalist = el("datalist", { id: "zr-model-list" });
    const temp = el("input", { type: "number", min: "0", max: "2", step: "0.1", value: editing.temperature ?? "", placeholder: "default", style: "width: 80px" });
    const status = el("span", { class: "zr-status" });

    const syncProvider = (resetURL) => {
      const prov = ZR.LLM.getProvider(providerSel.value);
      if (resetURL || !baseURL.value) baseURL.value = prov.baseURL;
      baseURL.placeholder = prov.baseURL || "https://your-endpoint/v1";
      datalist.replaceChildren(...prov.models.map((m) => el("option", { value: m })));
      if (!model.value && prov.models[0]) model.value = prov.models[0];
      keyLink.replaceChildren(prov.keyURL ? link(prov.needsKey ? "Get an API key" : "Download / docs", prov.keyURL) : "");
      key.placeholder = prov.needsKey ? "API key (required)" : "API key (optional)";
      if (!name.value || name.dataset.auto) {
        name.value = prov.name;
        name.dataset.auto = "1";
      }
    };
    name.addEventListener("input", () => delete name.dataset.auto);
    providerSel.addEventListener("change", () => {
      model.value = "";
      syncProvider(true);
    });
    if (isNew) name.dataset.auto = "1";
    syncProvider(false);

    const current = () => ({
      id: editing.id,
      name: name.value.trim() || ZR.LLM.getProvider(providerSel.value).name,
      provider: providerSel.value,
      baseURL: baseURL.value.trim() === ZR.LLM.getProvider(providerSel.value).baseURL ? "" : baseURL.value.trim(),
      model: model.value.trim(),
      temperature: temp.value === "" ? "" : Number(temp.value),
    });

    const fetchModels = async () => {
      status.className = "zr-status";
      status.textContent = "fetching models…";
      try {
        const models = await ZR.LLM.listModels(Object.assign(current(), { apiKey: key.value.trim() }));
        datalist.replaceChildren(...models.map((m) => el("option", { value: m })));
        status.textContent = `${models.length} models available — pick one in the Model field`;
        status.classList.add("zr-good");
      } catch (e) {
        status.textContent = "Could not list models: " + e.message;
        status.classList.add("zr-bad");
      }
    };

    const save = async () => {
      const prof = current();
      if (!prof.model) {
        status.textContent = "Choose a model.";
        status.className = "zr-status zr-bad";
        return;
      }
      const list = ZR.Prefs.getLLMProfiles();
      const i = list.findIndex((x) => x.id === prof.id);
      if (i >= 0) list[i] = prof;
      else list.push(prof);
      ZR.Prefs.setLLMProfiles(list);
      await ZR.Secrets.set(ZR.Secrets.llmKey(prof.id), key.value.trim());
      if (!ZR.Prefs.get("activeLLMProfile", "") || list.length === 1) ZR.Prefs.set("activeLLMProfile", prof.id);
      box.replaceChildren();
      editing = null;
      renderLLMList();
    };

    box.append(
      el("div", { class: "zr-editor" }, [
        el("h3", { text: isNew ? "New AI provider" : `Edit “${editing.name}”` }),
        el("div", { class: "zr-grid" }, [
          el("label", { text: "Provider" }),
          providerSel,
          el("label", { text: "Name" }),
          name,
          el("label", { text: "Base URL" }),
          baseURL,
          el("label", { text: "API key" }),
          el("div", { class: "zr-actions" }, [key, showKey, keyLink]),
          el("label", { text: "Model" }),
          el("div", { class: "zr-actions" }, [model, datalist, el("button", { text: "Fetch available models", onclick: fetchModels })]),
          el("label", { text: "Temperature" }),
          el("div", { class: "zr-actions" }, [temp, el("span", { class: "zr-help", text: "leave empty for provider default (required for some reasoning models)" })]),
        ]),
        el("div", { class: "zr-actions" }, [
          el("button", { text: "Save", class: "zr-primary", onclick: save }),
          el("button", { text: "Test", onclick: () => testProfile(Object.assign(current(), { apiKey: key.value.trim() }), status) }),
          el("button", { text: "Cancel", onclick: () => (box.replaceChildren(), (editing = null)) }),
          status,
        ]),
      ])
    );
  }

  // -------------------------------------------------------- sources ----
  function renderSourcesToolbar() {
    const bar = document.getElementById("zr-src-toolbar");
    bar.replaceChildren();
    const filters = [
      ["all", "All"],
      ["free", "Free (no key)"],
      ["free-key", "Free with key"],
      ["paid", "Paid / institutional"],
      ["searchable", "Searchable in plugin"],
    ];
    for (const [id, label] of filters) {
      bar.append(el("button", { class: "zr-seg" + (srcFilter === id ? " active" : ""), text: label, onclick: () => ((srcFilter = id), renderSourcesToolbar(), renderSources()) }));
    }
    const search = el("input", { type: "search", placeholder: "filter…", value: srcSearch, oninput: (e) => ((srcSearch = e.target.value.toLowerCase()), renderSources()) });
    const hidden = el("label", { class: "zr-inline" }, [el("input", { type: "checkbox", checked: showHiddenAreas, onchange: (e) => ((showHiddenAreas = e.target.checked), renderSources()) }), "show hidden areas"]);
    bar.append(hidden, search);
  }

  function renderSources() {
    const box = document.getElementById("zr-src-table");
    box.replaceChildren();
    const table = el("table", { class: "zr-table zr-src" }, el("tr", {}, ["Use", "Source", "Access", "API key", "Links"].map((t) => el("th", { text: t }))));
    const list = ZR.Sources.all().filter((s) => {
      if (!showHiddenAreas && !ZR.Sources.inEnabledArea(s)) return false;
      if (srcFilter === "searchable" && !s.search) return false;
      if (["free", "free-key", "paid"].includes(srcFilter) && s.access !== srcFilter) return false;
      if (srcSearch && !`${s.name} ${s.coverage}`.toLowerCase().includes(srcSearch)) return false;
      return true;
    });
    for (const s of list) {
      const enabled = el("input", {
        type: "checkbox",
        checked: ZR.Sources.isEnabled(s.id),
        disabled: !s.search,
        title: s.search ? "Pre-select this source in the search dialog" : "Listed for reference — no search adapter",
        onchange: (e) => ZR.Prefs.setSourceSetting(s.id, { enabled: e.target.checked }),
      });
      const keyCell = el("td", { class: "zr-keys" });
      const wantsKey = s.keyLabel && !s.sharesKeyWith;
      if (wantsKey) keyCell.append(secretInput(ZR.Secrets.sourceKey(s.id), s.keyLabel));
      for (const extra of s.sharesKeyWith ? [] : s.extraSecrets || []) keyCell.append(secretInput(ZR.Secrets.sourceKey(`${s.id}:${extra.id}`), extra.label));
      if (s.sharesKeyWith) keyCell.append(el("span", { class: "zr-help", text: `uses the ${ZR.Sources.get(s.sharesKeyWith).name} key` }));
      if (s.id === "unpaywall") keyCell.append(el("span", { class: "zr-help", text: "uses the contact e-mail below" }));
      const badge = { free: "free", "free-key": "free key", paid: "paid" }[s.access];
      table.append(
        el("tr", { class: s.search ? "" : "zr-muted" }, [
          el("td", {}, enabled),
          el("td", {}, [el("div", { class: "zr-name", text: s.name }), el("div", { class: "zr-help", text: s.coverage || "" })]),
          el("td", {}, [el("span", { class: "zr-badge " + s.access, text: badge }), s.keyOptional ? el("div", { class: "zr-help", text: "key optional" }) : null]),
          keyCell,
          el("td", { class: "zr-links" }, [s.signupURL ? link("Get key", s.signupURL) : null, s.docsURL ? link("Docs", s.docsURL) : null]),
        ])
      );
    }
    box.append(table);
  }

  function secretInput(secretName, label) {
    const input = el("input", { type: "password", size: 26, placeholder: "not set", value: ZR.Secrets.get(secretName), autocomplete: "off", title: label });
    const mark = el("span", { class: "zr-saved" });
    input.addEventListener("change", async () => {
      await ZR.Secrets.set(secretName, input.value.trim());
      mark.textContent = input.value.trim() ? "saved" : "removed";
      setTimeout(() => (mark.textContent = ""), 2000);
    });
    return el("div", { class: "zr-key" }, [el("div", { class: "zr-help", text: label }), el("div", { class: "zr-actions" }, [input, mark])]);
  }

  return { init };
})();

// Initialize when Zotero dispatches `load` on the pane root (non-bubbling, so capture).
document.addEventListener(
  "load",
  (e) => {
    if (e.target?.id === "zr-prefs") ZRPrefsPane.init();
  },
  true
);

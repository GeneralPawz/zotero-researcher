/* global App, el, $, document, window, Zotero */
"use strict";

// Autopilot panel: a harness model runs the review with you, step by step.
//
//   Protocol  - picks the methodology and fills in the form from your question
//   Find      - proposes databases and settings; you accept or change them; searches
//   Screen    - System 1 rates the pool; the harness checks the outcome from condensed
//               numbers (drilling into sample papers when something looks off), proposes
//               changes to query / criteria / thresholds and loops (max. 3 attempts);
//               then thresholds, AI for the uncertain middle, decisions
//   Full text - finds PDFs; a model of your choice annotates them; the harness proposes
//               decisions; System 1 can check the annotation verdicts; the harness can
//               arbitrate the discrepancies; you confirm
//   Quality / extract / classify - filled by the full-text model (extraction optional)
//   Report    - summary, optional note
//
// The state (stage, attempt, models, question) is saved with the project, so a paused
// or interrupted run resumes where it stopped. The conversation is kept in the pool file;
// starting the autopilot again (from the start or any step) begins a new session and
// keeps the old one to read later.
//
// Messages: {at, who, stage, text, blocks?, actions?}. Blocks show structured content
// (a coloured query, facts, chips, lists, a distribution bar) instead of long sentences.

const Autopilot = (window.Autopilot = (() => {
  const ZR = () => App.ZR;
  const R = () => App.panels.review;
  let running = false;
  let pauseRequested = false;
  let stopRequested = false;
  let pendingAsk = null;
  let closeDialog = null;
  let viewing = null; // id of a past session shown read-only
  let lastStage = null; // for the step dividers in the conversation

  // Review operations the autopilot calls: after a stop, none of them starts any more
  const ASYNC_OPS = new Set(["persistProtocol", "rate", "bulk", "aiUncertain", "acceptAll", "decideRest", "decideByKey", "setThresholds", "findPDFs", "huntPDFs", "annotateAll", "tableAI", "saveNote", "clearMachineDecisions"]);
  const checkStop = () => {
    if (stopRequested) throw new (ZR().Activity.Stopped)();
  };
  const API = () =>
    new Proxy(App.panels.review.api, {
      get(target, name) {
        const v = target[name];
        if (typeof v !== "function" || !ASYNC_OPS.has(name)) return v;
        return async (...args) => {
          checkStop();
          const r = await v(...args);
          checkStop();
          return r;
        };
      },
    });

  const state = () => (App.project?.kind === "review" ? App.project.autopilot || null : null);
  async function saveState(patch) {
    const p = App.project;
    p.autopilot = Object.assign({}, p.autopilot, patch);
    await ZR().Projects.save(App.target.libraryID, p);
    renderHead();
  }

  function profileFor(id, model) {
    const base = App.profiles().find((p) => p.id === id);
    if (!base) return null;
    return model ? Object.assign({}, base, { model }) : base;
  }
  const harness = () => {
    const s = state();
    const p = profileFor(s?.profileID, s?.model);
    if (!p) throw new Error("The autopilot's AI provider is gone. Choose another one (Settings → AI providers)");
    return p;
  };
  const ftModel = () => {
    const s = state();
    return profileFor(s?.ftProfileID || s?.profileID, s?.ftProfileID ? s.ftModel : s?.model) || harness();
  };
  const modelName = (p) => `${p.name}${p.model ? " · " + p.model : ""}`;
  const stageLabel = (s) => ZR().Methodologies.STAGES[s]?.label || s;
  const stageNum = (s) => {
    const i = (API().method()?.stages || []).indexOf(s);
    return i < 0 ? "" : String(i + 1);
  };
  const when = (at) => (at ? new Date(at + "Z").toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

  /** Run fn with another AI profile as App.profile() (steps use different models). */
  async function withProfile(profile, fn) {
    const before = App.profileOverride;
    App.profileOverride = profile;
    try {
      return await fn();
    } finally {
      App.profileOverride = before;
    }
  }

  // ---------------------------------------------------------------- panel ----
  function panel() {
    let p = $("ap-panel");
    if (p) return p;
    p = el("div", { id: "ap-panel", class: "ap-panel", role: "complementary", "aria-label": "Autopilot" }, [
      el("div", { class: "ap-head" }, [
        el("button", { id: "ap-title", class: "ap-title", title: "Details: models, step, question", "aria-haspopup": "dialog", onclick: () => toggleInfo() }, [el("span", { class: "ap-spark" }, App.icon("sparkle")), el("b", { text: "Autopilot" }), el("span", { class: "ap-state", id: "ap-state" })]),
        el("span", { class: "spacer" }),
        el("button", { id: "ap-history", class: "ap-icon", title: "Sessions: this one and earlier ones", "aria-haspopup": "dialog", onclick: () => toggleHistory() }, App.icon("history")),
        el("button", { id: "ap-toggle", class: "ap-icon", onclick: () => (running ? pause() : state()?.on ? run() : (expand(), renderSetup())) }, App.icon("play")),
        el("button", { id: "ap-stop", class: "ap-icon danger", title: "Stop now: cancels running AI calls, CLI programs and requests", onclick: () => stop() }, App.icon("stop")),
        el("button", { id: "ap-collapse", class: "ap-icon", onclick: () => ($("ap-panel").classList.contains("collapsed") ? show() : collapse()) }, App.icon("collapse")),
      ]),
      el("div", { class: "ap-log", id: "ap-log" }),
      el("div", { class: "ap-prompt", id: "ap-prompt" }),
    ]);
    document.body.append(p);
    document.addEventListener("mousedown", (e) => {
      const pop = $("ap-pop");
      if (pop && !pop.contains(e.target) && !e.target.closest?.("#ap-title, #ap-history")) pop.remove();
    });
    return p;
  }

  async function show() {
    if (App.project?.kind !== "review") return App.status("review", "The autopilot runs structured reviews. Start or convert a review project first.");
    expand();
    await renderLog();
    renderHead();
    if (!state()?.on && !running) renderSetup();
  }

  function hide() {
    if ($("ap-panel")) $("ap-panel").hidden = true;
    $("ap-pop")?.remove();
    document.body.classList.remove("ap-open", "ap-collapsed");
  }

  /** On the review tab the panel is always there: collapsed to a strip until opened. */
  function dock() {
    if (App.project?.kind !== "review") return hide();
    const fresh = !$("ap-panel");
    const p = panel();
    if (!fresh && !p.hidden) return renderHead(); // open or collapsed as the user left it
    p.hidden = false;
    p.classList.add("collapsed");
    document.body.classList.add("ap-open", "ap-collapsed");
    renderHead();
  }

  function collapse() {
    $("ap-pop")?.remove();
    $("ap-panel").classList.add("collapsed");
    document.body.classList.add("ap-collapsed");
    renderHead();
  }

  function expand() {
    panel().hidden = false;
    $("ap-panel").classList.remove("collapsed");
    document.body.classList.remove("ap-collapsed");
    document.body.classList.add("ap-open");
    renderHead();
  }

  function statusText() {
    const s = state();
    if (running) return pauseRequested ? "pausing" : stopRequested ? "stopping" : "running";
    if (s?.on) return "paused";
    if (s?.finished) return "finished";
    return "";
  }

  function renderHead() {
    if (!$("ap-panel")) return;
    const s = state();
    $("ap-state").textContent = statusText();
    $("ap-state").dataset.state = statusText();
    const toggle = $("ap-toggle");
    toggle.replaceChildren(App.icon(running ? "pause" : "play"));
    toggle.title = running ? (pauseRequested ? "Pausing after the current step…" : "Pause after the current step") : s?.on ? "Resume" : "Start the autopilot";
    toggle.disabled = running && (pauseRequested || stopRequested);
    toggle.classList.toggle("primary", !running && !!s?.on);
    $("ap-stop").hidden = !running;
    $("ap-stop").disabled = stopRequested;
    const collapsed = $("ap-panel").classList.contains("collapsed");
    $("ap-panel").classList.toggle("running", running);
    $("ap-collapse").replaceChildren(App.icon(collapsed ? "expand" : "collapse"));
    $("ap-collapse").title = collapsed ? (running ? "Autopilot: running. Click to show it" : s?.on ? "Autopilot: paused. Click to show it" : "Autopilot: an AI runs the review with you. Click to open") : "Collapse the autopilot panel";
    $("ap-history").classList.toggle("on", !!viewing);
    App.syncLayout?.();
  }

  // ------------------------------------------------------------- popovers ----
  function popover(id, children) {
    const had = $("ap-pop")?.dataset.for === id;
    $("ap-pop")?.remove();
    if (had) return null;
    const pop = el("div", { id: "ap-pop", class: "ap-pop", role: "dialog", "data-for": id }, children);
    $("ap-panel").append(pop);
    return pop;
  }

  /** Click on "Autopilot": what it runs with, where it stands. */
  function toggleInfo() {
    const s = state() || {};
    const facts = [];
    const fact = (k, v) => v && facts.push(el("span", { class: "ap-fk", text: k }), el("span", { class: "ap-fv", text: v }));
    fact("Status", statusText() || "not started");
    if (s.stage) fact("Step", `${stageNum(s.stage)}. ${stageLabel(s.stage)}${s.stage === "screen" && s.attempt ? ` (attempt ${s.attempt + 1} of 3)` : ""}`);
    const h = profileFor(s.profileID, s.model);
    if (h) {
      fact("Harness", h.name);
      fact("Provider", ZR().LLM.getProvider(h.provider)?.name || h.provider);
      fact("Model", h.model || "the provider's default");
    } else if (s.profileID) fact("Harness", "(AI provider missing)");
    if (s.ftProfileID) {
      const f = profileFor(s.ftProfileID, s.ftModel);
      fact("Full-text model", f ? modelName(f) : "(missing)");
    } else if (h) fact("Full-text model", "same as the harness");
    fact("Question", s.question || "");
    popover("info", [
      el("div", { class: "ap-pop-title", text: "Autopilot" }),
      el("div", { class: "ap-facts" }, facts),
      running ? null : el("div", { class: "actions" }, [el("button", { id: "ap-setup", text: s.profileID ? "Change model or question…" : "Set up…", onclick: () => ($("ap-pop")?.remove(), expand(), renderSetup({ stage: s.stage })) })]),
    ]);
  }

  /** The sessions: the current one and earlier runs, readable again. */
  async function toggleHistory() {
    const pool = await logStore();
    const sessions = pool.autopilotSessions || [];
    const cur = pool.autopilotLog;
    const row = (id, title, sub) =>
      el("button", { class: "ap-sess" + ((viewing || "current") === id ? " on" : ""), "data-session": id, onclick: () => ($("ap-pop")?.remove(), viewSession(id === "current" ? null : id)) }, [el("b", { text: title }), el("span", { class: "hint", text: sub })]);
    popover("history", [
      el("div", { class: "ap-pop-title", text: "Sessions" }),
      row("current", "Current session", cur.length ? `since ${when(cur[0].at)} · ${cur.length} messages` : "empty"),
      ...sessions.map((s) => row(s.id, when(s.started), `from “${stageLabel(s.from)}”${s.model ? " · " + s.model : ""} · ${s.count} messages`)),
      sessions.length ? null : el("div", { class: "hint ap-pop-note", text: "Starting the autopilot again, from the start or from any step, begins a new session. Earlier ones are kept here." }),
    ]);
  }

  async function viewSession(id) {
    viewing = id;
    await renderLog();
    renderHead();
  }

  // --------------------------------------------------------- conversation ----
  async function logStore() {
    const pool = await ZR().Projects.loadPool(App.target.libraryID, App.project.id);
    pool.autopilotLog = pool.autopilotLog || [];
    return pool;
  }

  /** Text with **bold** (the only markup used), without dashes. */
  function richText(s, cls = "ap-text") {
    const node = el("div", { class: cls });
    ZR()
      .Util.undash(s)
      .split(/(\*\*[^*]+\*\*)/)
      .forEach((part) => node.append(/^\*\*.*\*\*$/.test(part) ? el("b", { text: part.slice(2, -2) }) : part));
    return node;
  }

  /** Go to a step (and a protocol field) from the conversation. */
  async function jump(a) {
    // switching tabs refreshes the review; wait for it, or it redraws after the jump
    if (App.currentTab !== "review") await App.showTab("review");
    if (a.field) return R().showField(a.field);
    await R().go(a.step);
  }

  function actionButton(a) {
    return el("button", { class: "ap-jump", onclick: () => jump(a) }, [App.icon("jump"), a.label]);
  }

  function renderBlock(b) {
    if (b.type === "query") {
      const code = App.queryCode(b.text);
      const box = el("div", { class: "ap-query" }, [code]);
      const long = b.text.length > 260;
      if (long) box.classList.add("clipped");
      box.append(
        el("div", { class: "ap-block-actions" }, [
          long ? el("button", { class: "link", text: "show all", onclick: (e) => (box.classList.toggle("clipped"), (e.target.textContent = box.classList.contains("clipped") ? "show all" : "show less")) }) : null,
          el("span", { class: "spacer" }),
          b.field === false ? null : actionButton({ label: b.label || "Show in the protocol", field: "query" }),
        ])
      );
      return box;
    }
    if (b.type === "facts") return el("div", { class: "ap-facts" }, b.rows.flatMap(([k, v]) => [el("span", { class: "ap-fk", text: k }), el("span", { class: "ap-fv", text: String(v) })]));
    if (b.type === "chips") return el("div", { class: "ap-chips" }, b.items.map((t) => el("span", { class: "ap-chip", text: t })));
    if (b.type === "list")
      return el(
        "div",
        { class: "ap-list" },
        b.items.map((it) => el("div", { class: "ap-li" + (it.kind ? " is-" + it.kind : "") }, [el("span", { class: "ap-mark", text: it.mark || "•" }), el("span", {}, [el("span", { text: ZR().Util.undash(it.text) }), it.note ? el("span", { class: "ap-note", text: ZR().Util.undash(it.note) }) : null])]))
      );
    if (b.type === "split") {
      const parts = b.parts.filter((p) => p.n);
      return el("div", { class: "ap-split" }, [
        el("div", { class: "ap-bar" }, parts.map((p) => el("span", { class: "seg-" + p.kind, style: `flex: ${p.n}`, title: `${p.label}: ${p.n}` }))),
        el("div", { class: "ap-legend" }, b.parts.map((p) => el("span", { class: "lg-" + p.kind }, [el("i"), p.label + " ", el("b", { text: String(p.n) })]))),
      ]);
    }
    return null;
  }

  function logEntry(m) {
    const body = el("div", { class: "ap-body" }, [richText(m.text)]);
    for (const b of m.blocks || []) body.append(renderBlock(b) || "");
    if (m.actions?.length) body.append(el("div", { class: "ap-actions" }, m.actions.map(actionButton)));
    return el("div", { class: `ap-msg ap-${m.who}`, "data-stage": m.stage || "" }, [el("span", { class: "ap-who", text: { ai: "✦", you: "you", info: "·", warn: "!", done: "✓" }[m.who] || "·" }), body]);
  }

  /** A divider when the conversation moves on to another step. */
  function divider(m) {
    if (!m.stage || m.stage === lastStage) return null;
    lastStage = m.stage;
    return el("div", { class: "ap-stage", "data-stage": m.stage }, [el("span", { class: "ap-stage-num", text: stageNum(m.stage) }), stageLabel(m.stage)]);
  }

  async function renderLog() {
    const pool = await logStore();
    const past = viewing && (pool.autopilotSessions || []).find((s) => s.id === viewing);
    if (viewing && !past) viewing = null;
    const msgs = past ? past.log : pool.autopilotLog;
    lastStage = null;
    const nodes = [];
    if (past)
      nodes.push(
        el("div", { class: "ap-archived" }, [
          el("span", {}, [el("b", { text: "Earlier session" }), ` · ${when(past.started)} to ${when(past.ended)}${past.model ? " · " + past.model : ""}`]),
          el("button", { class: "link", id: "ap-back", text: "Back to the current session", onclick: () => viewSession(null) }),
        ])
      );
    for (const m of msgs.slice(-300)) nodes.push(divider(m) || "", logEntry(m));
    $("ap-log").replaceChildren(...nodes);
    $("ap-log").classList.toggle("archived", !!past);
    $("ap-prompt").hidden = !!past;
    $("ap-log").scrollTop = past ? 0 : $("ap-log").scrollHeight;
  }

  /**
   * Post a message to the conversation (kept with the project).
   * extra: {blocks, actions} for structured content.
   */
  async function say(text, who = "ai", extra = {}) {
    const m = Object.assign({ at: new Date().toISOString().slice(0, 19), who, stage: state()?.stage || "", text: String(text) }, extra);
    const pool = await logStore();
    pool.autopilotLog.push(m);
    if (pool.autopilotLog.length > 500) pool.autopilotLog.splice(0, pool.autopilotLog.length - 500);
    ZR().Projects.savePool(App.target.libraryID, App.project.id).catch(() => {});
    if (!$("ap-log")) return;
    if (viewing) return viewSession(null);
    const d = divider(m);
    if (d) $("ap-log").append(d);
    $("ap-log").append(logEntry(m));
    $("ap-log").scrollTop = $("ap-log").scrollHeight;
  }

  /**
   * Ask the user. choices: [{id, label, primary?}]; inputs: [{id, type: select|textarea|text|checkbox, label, options?, value?}];
   * blocks: structured content shown with the question.
   * @returns {Promise<{choice, values}>}
   */
  function ask(text, choices, { inputs = [], blocks = [] } = {}) {
    if (stopRequested) return Promise.reject(new (ZR().Activity.Stopped)());
    expand();
    if (viewing) viewSession(null);
    return new Promise((resolve) => {
      const fields = {};
      const box = $("ap-prompt");
      const done = (c) => {
        const values = {};
        for (const [id, f] of Object.entries(fields)) values[id] = f.type === "checkbox" ? f.checked : f.value;
        box.replaceChildren();
        pendingAsk = null;
        say(c.label, "you");
        resolve({ choice: c.id, values });
      };
      pendingAsk = { resolve: () => done({ id: "pause", label: "Pause" }) };
      box.replaceChildren(
        el("div", { class: "ap-ask" }, [
          ...String(text)
            .split("\n")
            .map((line) => richText(line, "ap-ask-line")),
          ...blocks.map(renderBlock),
          ...inputs.map((f) => {
            let input;
            if (f.type === "select") input = el("select", { "data-input": f.id }, f.options.map((o) => el("option", { value: o.value, text: o.label, selected: o.value === f.value })));
            else if (f.type === "textarea") {
              input = el("textarea", { rows: String(f.rows || 4), "data-input": f.id, placeholder: f.placeholder || "" });
              input.value = f.value || "";
            } else if (f.type === "checkbox") input = el("input", { type: "checkbox", "data-input": f.id, checked: !!f.value });
            else input = el("input", { type: "text", "data-input": f.id, value: f.value || "", placeholder: f.placeholder || "" });
            fields[f.id] = input;
            return el("label", { class: "ap-field" + (f.type === "checkbox" ? " inline" : "") }, f.type === "checkbox" ? [input, " " + f.label] : [el("span", { text: f.label }), input]);
          }),
          el("div", { class: "actions" }, choices.map((c) => el("button", { class: c.primary ? "primary" : "", "data-choice": c.id, text: c.label, onclick: () => done(c) }))),
        ])
      );
      box.querySelector("textarea, button.primary")?.focus();
    });
  }

  // ---------------------------------------------------------------- setup ----
  function profileOptions() {
    return App.profiles().map((p) => ({ value: p.id, label: `${p.name}${p.model ? " · " + p.model : ""}` }));
  }

  /** Model choice for a provider: its list of models (Codex / Claude / API), default first. */
  async function modelOptions(profileID) {
    const p = App.profiles().find((x) => x.id === profileID);
    if (!p) return [];
    try {
      const list = await ZR().LLM.listModels(p);
      return [{ value: "", label: `${p.model || "the provider's default"} (as set up)` }, ...list.slice(0, 80).map((m) => ({ value: m.id, label: `${m.name}${m.name !== m.id ? " (" + m.id + ")" : ""}` }))];
    } catch (e) {
      return [{ value: "", label: `${p.model || "default"} (as set up)` }];
    }
  }

  async function renderSetup({ stage = null } = {}) {
    const profiles = profileOptions();
    const box = $("ap-prompt");
    if (viewing) await viewSession(null);
    if (!profiles.length) {
      box.replaceChildren(el("div", { class: "ap-ask" }, [el("div", { text: "The autopilot needs an AI provider. Add one in Settings → AI providers (e.g. Codex or Claude Code on your subscription)." })]));
      return;
    }
    const p = App.project;
    const s = state() || {};
    const protocolReady = !!(p.protocol?.questions?.length || p.protocol?.inclusion?.length);
    const stages = API().method().stages;
    const current = stage && stages.includes(stage) ? stage : R().step && stages.includes(R().step) ? R().step : protocolReady ? (p.runs?.length ? "screen" : "search") : "protocol";
    const profileSel = el("select", { id: "ap-profile" }, profiles.map((o) => el("option", { value: o.value, text: o.label, selected: o.value === s.profileID })));
    const modelSel = el("select", { id: "ap-model-select" });
    const fillModels = async () => {
      modelSel.replaceChildren(...(await modelOptions(profileSel.value)).map((o) => el("option", { value: o.value, text: o.label })));
      if (profileSel.value === s.profileID && s.model) modelSel.value = s.model;
    };
    profileSel.addEventListener("change", fillModels);
    await fillModels();
    const question = el("textarea", { id: "ap-question", rows: "4", placeholder: "Your research question in your own words: what you want to find out and why." });
    question.value = s.question || p.description || (p.protocol?.questions || []).join("\n");
    const startAt = el("select", { id: "ap-start" }, stages.map((x) => el("option", { value: x, text: `Start at: ${stageNum(x)}. ${stageLabel(x)}`, selected: x === current })));
    box.replaceChildren(
      el("div", { class: "ap-ask" }, [
        el("div", { class: "ap-ask-line", text: "An AI of your choice runs the review with you: it sets up the protocol, plans the search, checks the screening, reads the full texts and fills in the tables, and asks you at every decision." }),
        el("label", { class: "ap-field" }, [el("span", { text: "Harness model" }), profileSel]),
        el("label", { class: "ap-field" }, [el("span", { text: "Model" }), modelSel]),
        el("label", { class: "ap-field" }, [el("span", { text: "Research question" }), question]),
        el("label", { class: "ap-field" }, [el("span", { text: "Where to start" }), startAt]),
        el("div", { class: "actions" }, [
          el("button", {
            id: "ap-go",
            class: "primary",
            text: "Start the autopilot",
            onclick: () => {
              if (!question.value.trim()) return question.focus();
              start({ profileID: profileSel.value, model: modelSel.value, question: question.value.trim(), stage: startAt.value });
            },
          }),
        ]),
      ])
    );
  }

  /** Start (or restart) the autopilot for the current review project: a new session. */
  async function start({ profileID, model = "", question, stage = "protocol" }) {
    const pool = await logStore();
    ZR().Autopilot.archiveSession(pool);
    await ZR().Projects.savePool(App.target.libraryID, App.project.id);
    viewing = null;
    await saveState({ on: true, profileID, model, question, stage, attempt: 0, finished: false });
    await show();
    $("ap-prompt").replaceChildren();
    const name = modelName(harness());
    await say(`Autopilot started with **${name}** at step ${stageNum(stage)}, “${stageLabel(stage)}”.`, "info", { kind: "start", model: name, from: stage });
    run();
  }

  /** Right-click on a step: run from there (a new session), with the models set up before. */
  async function runFrom(stage) {
    if (App.project?.kind !== "review") return;
    if (running) await stopAndWait();
    const s = state() || {};
    const question = s.question || App.project.description || (App.project.protocol?.questions || []).join("\n");
    if (s.profileID && profileFor(s.profileID, s.model) && question) return start({ profileID: s.profileID, model: s.model || "", question, stage });
    await show();
    await renderSetup({ stage });
  }

  function pause() {
    pauseRequested = true;
    pendingAsk?.resolve();
    closeDialog?.();
    say("Pausing after the current step finishes. Use “Stop now” to interrupt it.", "info");
    renderHead();
  }

  /** Stop immediately: cancel running AI calls, CLI programs and requests; the step can be resumed. */
  function stop() {
    if (!running) return;
    stopRequested = true;
    pauseRequested = true;
    const n = ZR().Activity.stopAll();
    pendingAsk?.resolve();
    closeDialog?.();
    say(`Stopping now${n ? `: cancelled ${n} running call(s)` : ""}…`, "warn");
    renderHead();
  }

  async function stopAndWait() {
    stop();
    for (let i = 0; running && i < 150; i++) await ZR().Util.sleep(100);
  }

  // ---------------------------------------------------------------- the loop ----
  function nextAfter(stage) {
    const stages = API().method().stages;
    return stages[stages.indexOf(stage) + 1] || "report";
  }

  async function run() {
    if (running || !state()?.on) return;
    running = true;
    pauseRequested = false;
    stopRequested = false;
    ZR().Activity.resume();
    renderHead();
    try {
      while (state()?.on && !pauseRequested) {
        const s = state().stage;
        const fn = STAGES[s];
        if (!fn) break;
        App.showTab("review");
        await R().refresh(); // fresh candidates before the step works with them
        const next = await fn();
        if (stopRequested) throw new (ZR().Activity.Stopped)(); // never move on after a stop
        if (next === "pause" || pauseRequested) {
          await say("Paused. Press ▶ to continue from here.", "info");
          break;
        }
        if (next === "stop") break;
        await saveState({ stage: next, attempt: 0 });
      }
    } catch (e) {
      if (stopRequested || e?.stopped) await say(`Stopped during “${stageLabel(state()?.stage)}”. ▶ starts this step again.`, "info");
      else {
        Zotero.logError(e);
        await say("Something went wrong: " + e.message + ". Fix it and press ▶ to retry this step.", "warn");
      }
    } finally {
      running = false;
      if (stopRequested) {
        stopRequested = false;
        ZR().Activity.resume();
      }
      App.setBusy("review", false);
      renderHead();
    }
  }

  const protocol = () => App.project.protocol;

  // --- 1 protocol
  async function doProtocol() {
    await R().go("protocol");
    await say("Reading your question and choosing the methodology…", "info");
    const r = await ZR().Autopilot.chooseMethodology(harness(), state().question, { query: App.project.search?.query });
    await API().persistProtocol(r.methodology, r.protocol, state().question);
    await R().go("protocol");
    const P = App.project.protocol;
    const fw = ZR().Methodologies.FRAMEWORKS?.[P.framework]?.name;
    await say(`I chose **${ZR().Methodologies.get(r.methodology).name}**.${r.why ? " " + r.why : ""}`, "ai", {
      blocks: [
        {
          type: "facts",
          rows: [
            ["Research questions", P.questions.length],
            ["Inclusion criteria", P.inclusion.length],
            ["Exclusion criteria", P.exclusion.length],
            ...(fw ? [["Question framework", fw]] : []),
            ...(P.yearFrom || P.yearTo ? [["Years", `${P.yearFrom || "any"} to ${P.yearTo || "today"}`]] : []),
          ],
        },
        ...(P.query ? [{ type: "query", text: P.query }] : []),
      ],
      actions: [{ label: "Open the protocol", step: "protocol" }],
    });
    const a = await ask("Check the protocol on the left (you can edit it). Continue with the search?", [
      { id: "go", label: "Continue", primary: true },
      { id: "pause", label: "Pause, I'll edit it first" },
    ]);
    return a.choice === "go" ? nextAfter("protocol") : "pause";
  }

  // --- 2 find
  async function doSearch() {
    await R().go("search");
    const sources = ZR().Sources.visibleSearchable().filter((s) => !ZR().Sources.unavailableReason(s.id));
    await say("Planning the search: which databases, how many results…", "info");
    const plan = await ZR().Autopilot.planSearch(harness(), protocol(), sources);
    await say(`I suggest **${plan.sources.length}** database(s), **${plan.limit}** results each.${plan.why ? " " + plan.why : ""}`, "ai", {
      blocks: [{ type: "chips", items: plan.sources.map((id) => ZR().Sources.get(id)?.name || id) }],
    });
    const settings = await searchDialog(plan, sources);
    if (!settings) return "pause";
    await runSearch(settings, null);
    return nextAfter("search");
  }

  async function runSearch(settings, parent) {
    await say(`Searching ${settings.sources.length} database(s)…`, "info");
    const res = await App.panels.search.searchIntoPool(settings, { parent });
    App.showTab("review");
    await saveState({ lastRunID: res.run.id, lastSettings: settings });
    await say("The search is done.", "ai", {
      blocks: [
        {
          type: "facts",
          rows: [
            ["Records found", res.run.identified],
            ["New in the pool", res.pool?.added ?? 0],
            ...(res.pool?.known ? [["Already in the pool", res.pool.known]] : []),
            ["Not added (duplicates, filters)", res.pool?.notAdded ?? 0],
          ],
        },
      ],
      actions: [{ label: "Searches and what was not added", step: "search" }],
    });
    return res;
  }

  /** The search plan in a popup: every search setting can be set or unset before it runs. */
  function searchDialog(plan, sources) {
    return new Promise((resolve) => {
      const Z = ZR();
      const P = protocol();
      const prev = App.project.search || {};
      const q = el("textarea", { id: "ap-s-query", rows: "3", class: "mono" });
      q.value = P.query || prev.query || "";
      const chosen = new Set(plan.sources);
      const srcBox = el(
        "div",
        { class: "ap-sources" },
        sources.map((s) => el("label", { class: "src", title: s.coverage || "" }, [el("input", { type: "checkbox", value: s.id, checked: chosen.has(s.id) }), el("span", { text: s.name }), el("span", { class: "badge " + s.access, text: s.access === "free" ? "free" : s.access === "free-key" ? "key" : "paid" })]))
      );
      const setSources = (pred) => srcBox.querySelectorAll("input").forEach((i) => (i.checked = pred(Z.Sources.get(i.value), i.value)));
      const num = (id, value, attrs = {}) => el("input", Object.assign({ type: "number", id, value: value ?? "" }, attrs));
      const limit = num("ap-s-limit", plan.limit, { min: "5", max: "500" });
      const yFrom = num("ap-s-from", P.yearFrom ?? prev.yearFrom, { placeholder: "from" });
      const yTo = num("ap-s-to", P.yearTo ?? prev.yearTo, { placeholder: "to" });
      const minCites = num("ap-s-cites", prev.minCitations || "", { min: "0", placeholder: "0" });
      const picks = (id, items, selected) =>
        el(
          "div",
          { class: "picks", id },
          items.map((it) => el("button", { class: "pick", "data-v": it.id, "aria-pressed": String(selected.includes(it.id)), text: it.label, onclick: (e) => e.target.setAttribute("aria-pressed", String(e.target.getAttribute("aria-pressed") !== "true")) }))
        );
      const langs = picks("ap-s-langs", Z.Records.LANGUAGES.map((l) => ({ id: l.code, label: l.name })), P.languages?.length ? P.languages : prev.languages || []);
      const types = picks("ap-s-types", Z.Records.TYPE_FILTERS.map((t) => ({ id: t.id, label: t.label })), P.types?.length ? P.types : prev.types || []);
      const picked = (box) => [...box.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.v);
      const box = (id, label, checked, title = "") => {
        const input = el("input", { type: "checkbox", id, checked: !!checked });
        return { input, row: el("label", { class: "ap-check", title }, [input, " " + label]) };
      };
      const opts = {
        hasAbstract: box("ap-s-abstract", "Only papers with an abstract", prev.hasAbstract),
        hasDOI: box("ap-s-doi", "Only papers with a DOI", prev.hasDOI),
        oaOnly: box("ap-s-oa", "Only open access", prev.oaOnly),
        fulltextOnly: box("ap-s-ft", "Only papers with a full text available", prev.fulltextOnly),
        strict: box("ap-s-strict", "Strict matching (query must match title, abstract or keywords)", prev.strict),
        inLibrary: box("ap-s-inlib", "Also screen papers already in my library (recommended for a review)", true),
        hideExcluded: box("ap-s-hideexcl", "Hide papers I excluded before", false),
        attachPDFs: box("ap-s-pdfs", "Download PDFs when papers are included (needed for the full-text step)", prev.attachPDFs ?? Z.Prefs.get("attachPDFs", true)),
      };
      const close = (v) => {
        closeDialog = null;
        layer.remove();
        resolve(v);
      };
      closeDialog = () => close(null);
      const section = (title, children) => el("div", { class: "ap-sec" }, [el("div", { class: "opt-title", text: title }), ...children]);
      const layer = el(
        "div",
        { class: "modal-layer", id: "ap-search-layer" },
        el("div", { class: "modal ap-search-modal", role: "dialog" }, [
          el("h2", { text: "Search plan" }),
          el("p", { class: "hint", text: (plan.why ? Z.Util.undash(plan.why) + " " : "") + "Proposed by the autopilot. Set or unset anything before it runs." }),
          el("div", { class: "ap-search-body" }, [
            section("Query", [q]),
            section("Databases", [
              el("div", { class: "ap-row" }, [
                el("button", { class: "link", text: "all", onclick: () => setSources(() => true) }),
                el("button", { class: "link", text: "none", onclick: () => setSources(() => false) }),
                el("button", { class: "link", text: "free only", onclick: () => setSources((s) => s?.access === "free") }),
                el("button", { class: "link", text: "suggested", onclick: () => setSources((s, id) => chosen.has(id)) }),
              ]),
              srcBox,
            ]),
            section("Results", [el("div", { class: "ap-row" }, [el("label", { class: "ap-inline" }, ["Per database ", limit]), el("label", { class: "ap-inline" }, ["Years ", yFrom, " to ", yTo]), el("label", { class: "ap-inline" }, ["Min. citations ", minCites])])]),
            section("Languages (none = any)", [langs]),
            section("Publication types (none = any)", [types]),
            section("Filters", [opts.hasAbstract.row, opts.hasDOI.row, opts.oaOnly.row, opts.fulltextOnly.row, opts.strict.row]),
            section("Library and PDFs", [opts.inLibrary.row, opts.hideExcluded.row, opts.attachPDFs.row]),
          ]),
          el("div", { class: "actions" }, [
            el("span", { class: "spacer" }),
            el("button", { text: "Pause", onclick: () => close(null) }),
            el("button", {
              class: "primary",
              id: "ap-s-run",
              text: "Run the search",
              onclick: () => {
                const sourcesChosen = [...srcBox.querySelectorAll("input:checked")].map((i) => i.value);
                if (!sourcesChosen.length) return srcBox.classList.add("ap-missing");
                close({
                  mode: "structured",
                  query: q.value.trim(),
                  sources: sourcesChosen,
                  limit: parseInt(limit.value, 10) || plan.limit,
                  yearFrom: parseInt(yFrom.value, 10) || null,
                  yearTo: parseInt(yTo.value, 10) || null,
                  minCitations: Math.max(0, parseInt(minCites.value, 10) || 0),
                  languages: picked(langs),
                  types: picked(types),
                  hasAbstract: opts.hasAbstract.input.checked,
                  hasDOI: opts.hasDOI.input.checked,
                  oaOnly: opts.oaOnly.input.checked,
                  fulltextOnly: opts.fulltextOnly.input.checked,
                  strict: opts.strict.input.checked,
                  skipExisting: !opts.inLibrary.input.checked,
                  hideExcluded: opts.hideExcluded.input.checked,
                  attachPDFs: opts.attachPDFs.input.checked,
                });
              },
            }),
          ]),
        ])
      );
      document.body.append(layer);
    });
  }

  // --- 3 screen
  /** Proposed changes as blocks: the new query coloured, criteria and thresholds as a list. */
  function changeBlocks(ch) {
    const items = [];
    if (ch.inclusion) ch.inclusion.forEach((t, i) => items.push({ mark: `IC${i + 1}`, text: t }));
    if (ch.exclusion) (ch.exclusion.length ? ch.exclusion : ["(no exclusion criteria)"]).forEach((t, i) => items.push({ mark: `EC${i + 1}`, text: t }));
    if (ch.thresholds) items.push({ mark: "%", text: `Exclude below ${Math.round(ch.thresholds.excludeBelow * 100)}%, include above ${Math.round(ch.thresholds.includeAbove * 100)}%` });
    return [...(ch.query ? [{ type: "query", text: ch.query, field: false }] : []), ...(items.length ? [{ type: "list", items }] : [])];
  }

  async function applyChanges(ch) {
    const p = App.project;
    const P = Object.assign({}, p.protocol);
    if (ch.inclusion) P.inclusion = ch.inclusion;
    if (ch.exclusion) P.exclusion = ch.exclusion;
    if (ch.query) P.query = ch.query;
    if (ch.inclusion || ch.exclusion || ch.query) await API().persistProtocol(p.methodology, P);
    if (ch.thresholds) await API().setThresholds(ch.thresholds);
    if (ch.query) {
      const s = state();
      const base = s.lastSettings || { mode: "structured", sources: Object.keys(p.runs?.at(-1)?.perSource || {}), limit: 50 };
      await runSearch(Object.assign({}, base, { query: ch.query }), s.lastRunID || p.runs?.at(-1)?.id || null);
    }
    await R().go("screen");
  }

  async function doScreen() {
    App.showTab("review");
    await R().go("screen");
    let attempt = state().attempt || 0;
    for (;;) {
      await say("System 1 is rating the pool…", "info");
      await API().rate(true);
      const cands = API().population();
      if (!cands.length) {
        await say("The pool is empty, so there is nothing to screen. Let's adjust the search.", "warn");
        await saveState({ stage: "search" });
        return "search";
      }
      const summary = ZR().Autopilot.screeningSummary(cands, API().thresholds());
      await say(`System 1 rated **${summary.pool}** papers.`, "info", {
        blocks: [
          {
            type: "split",
            parts: [
              { kind: "exc", label: "below the exclude threshold", n: summary.belowExclude },
              { kind: "mid", label: "uncertain", n: summary.middle },
              { kind: "inc", label: "above the include threshold", n: summary.aboveInclude },
            ],
          },
          { type: "facts", rows: [["Its suggestions", `${summary.suggest.include} include, ${summary.suggest.maybe} maybe, ${summary.suggest.exclude} exclude`]] },
        ],
      });
      await say("Checking whether that is plausible…", "info");
      const a = await ZR().Autopilot.assessScreening(harness(), protocol(), summary, () => ZR().Autopilot.screeningSample(API().population()), { attempt });
      await say((a.drilldown ? "I looked at sample papers in detail. " : "") + a.explanation);
      if (a.verdict === "ok") break;
      attempt++;
      await saveState({ attempt });
      if (attempt >= 3 || a.verdict === "hopeless") {
        const c = await ask(`${a.message}\nAfter ${attempt} attempt(s) nothing better comes back; there may genuinely be little on this question. What now?`, [
          { id: "fulltext", label: "Continue to the full texts anyway", primary: true },
          { id: "close", label: "Close the review here" },
        ]);
        if (c.choice === "close") {
          await R().go("report");
          await saveState({ on: false, finished: true, stage: "report" });
          await say("Closed. The report shows where the review stands.", "done", { actions: [{ label: "Open the report", step: "report" }] });
          return "stop";
        }
        break;
      }
      const blocks = changeBlocks(a.changes);
      const c = await ask(`${a.message}${blocks.length ? "\n**Proposed:**" : ""}`, [
        { id: "apply", label: blocks.length ? "Apply and try again" : "Try again", primary: true },
        { id: "accept", label: "Keep it as it is" },
        { id: "pause", label: "Pause, I'll adjust it myself" },
      ], { blocks });
      if (c.choice === "pause") return "pause";
      if (c.choice === "accept") break;
      await applyChanges(a.changes);
    }
    await say("Screening: applying the thresholds, and the AI reads the uncertain papers…", "info");
    await API().bulk("exclude");
    await API().bulk("include");
    await withProfile(harness(), () => API().aiUncertain());
    await API().acceptAll({ maybeAs: "include" });
    await API().decideRest();
    const all = API().candidates();
    await say("Screening done. Every decision is in the list and can be changed.", "ai", {
      blocks: [
        {
          type: "split",
          parts: [
            { kind: "exc", label: "excluded", n: all.filter((c) => c.ta === "exclude").length },
            { kind: "inc", label: "go on to the full texts", n: all.filter((c) => c.ta === "include").length },
          ],
        },
      ],
      actions: [{ label: "Open the screening list", step: "screen" }],
    });
    return nextAfter("screen");
  }

  // --- 4 full text
  async function doFullText() {
    await R().go("fulltext");
    const profiles = profileOptions();
    const a = await ask("Which model should read and annotate the full texts?", [
      { id: "harness", label: `Use ${modelName(harness())}`, primary: true },
      { id: "choose", label: "Use the one selected below" },
      { id: "pause", label: "Pause" },
    ], { inputs: [{ id: "profile", type: "select", label: "AI provider", options: profiles, value: state().profileID }] });
    if (a.choice === "pause") return "pause";
    if (a.choice === "choose") await saveState({ ftProfileID: a.values.profile, ftModel: "" });
    else await saveState({ ftProfileID: null });
    await say("Looking for PDFs…", "info");
    await API().findPDFs();
    if ((await missingPDFStep()) === "pause") return "pause";
    await say(`**${modelName(ftModel())}** annotates the full texts (real Zotero annotations, author “${ZR().FullText.botName()}”)…`, "info");
    await withProfile(ftModel(), () => API().annotateAll());
    let papers = fullTextPapers();
    const withPDF = papers.filter((p) => p.hasPDF).length;
    await say(`${withPDF} of ${papers.length} papers have a PDF and annotations.`, "info", {
      blocks: papers.length - withPDF ? [{ type: "facts", rows: [["Without PDF", `${papers.length - withPDF}, they stay open (“not retrieved” in the flow diagram)`]] }] : [],
    });
    let dec = await ZR().Autopilot.decideFullText(harness(), protocol(), papers);
    const proposal = (d) => ({ type: "split", parts: [{ kind: "exc", label: "exclude", n: d.decisions.filter((x) => x.d === "exclude").length }, { kind: "inc", label: "include", n: d.decisions.filter((x) => x.d === "include").length }] });
    await say(dec.summary, "ai", { blocks: [proposal(dec)] });
    const q1 = await ask("Should System 1 check whether the annotation model's include / exclude verdicts make sense for the research question?", [
      { id: "yes", label: "Yes, check them", primary: true },
      { id: "no", label: "No" },
    ]);
    if (q1.choice === "yes") {
      const anns = papers.flatMap((p) => p.annotations.filter((x) => x.isBot && (x.kind === "include" || x.kind === "exclude")).map((x) => Object.assign({ paperTitle: p.title }, x)));
      const scores = await ZR().System1.scorePassages(anns, protocol());
      const flagged = ZR().Autopilot.discrepancies(anns, scores);
      await say(`System 1 rated ${Object.keys(scores).length} of ${anns.length} annotations and disagrees with **${flagged.length}**.`, "info", {
        blocks: flagged.length ? [{ type: "list", items: flagged.slice(0, 8).map((f) => ({ mark: f.kind === "include" ? "✓" : "✗", kind: f.kind, text: `“${ZR().Util.truncate(f.text, 110)}”`, note: `System 1: ${Math.round(f.p * 100)}%` })) }] : [],
      });
      if (flagged.length) {
        const q2 = await ask("Should I check these discrepancies and correct the verdicts where needed?", [
          { id: "yes", label: "Yes", primary: true },
          { id: "no", label: "No, keep them" },
        ]);
        if (q2.choice === "yes") {
          const corr = await ZR().Autopilot.reviewDiscrepancies(harness(), protocol(), flagged);
          const changed = corr.filter((c) => c.to !== c.from);
          for (const c of changed) await ZR().FullText.setKind(c.key, App.target.libraryID, c.to);
          await say(`I corrected **${changed.length}** verdict(s).`, "ai", { blocks: changed.length ? [{ type: "list", items: changed.map((c) => ({ mark: "→", text: `${c.from} → ${c.to}`, note: c.why })) }] : [] });
          if (changed.length) {
            papers = fullTextPapers();
            dec = await ZR().Autopilot.decideFullText(harness(), protocol(), papers);
            await say("Updated proposal:", "ai", { blocks: [proposal(dec)] });
          }
        }
      }
    }
    const items = dec.decisions.map((d) => ({ mark: d.d === "include" ? "✓" : "✗", kind: d.d, text: ZR().Util.truncate(papers.find((p) => p.key === d.key)?.title || "", 90), note: d.r || "" }));
    const q3 = await ask("Apply these full-text decisions?", [
      { id: "apply", label: "Apply", primary: true },
      { id: "pause", label: "Pause, I'll decide myself" },
    ], { blocks: [{ type: "list", items }] });
    if (q3.choice === "pause") return "pause";
    for (const d of dec.decisions) await API().decideByKey(d.key, "ft", d.d, d.r, "llm");
    await R().go("fulltext");
    await say(`Full-text decisions applied (${dec.decisions.length}).`, "ai", { actions: [{ label: "Open the full-text list", step: "fulltext" }] });
    return nextAfter("fulltext");
  }

  /** Papers without PDF can't be assessed: warn, and offer strategies to get them (repeatable). */
  async function missingPDFStep() {
    for (;;) {
      const missing = API().missingPDFs();
      if (!missing.length) return;
      const total = API().population().length;
      const off = state().lastSettings?.attachPDFs === false;
      const strategies = ZR().PDFHunt.strategies().filter((x) => x.id !== "oa");
      const harnessID = "ai:" + state().profileID;
      const a = await ask(
        `${off ? "“Download PDFs” was switched off in the search plan. " : ""}**${missing.length} of ${total}** papers at this step have no PDF. They can't be read or annotated, so no full-text assessment is possible for them. They are in Zotero already; I can try to find their PDFs with the strategies below (one after another; you can try again with others afterwards).`,
        [
          { id: "try", label: "Try the selected strategies", primary: true },
          { id: "skip", label: "Continue without them" },
          { id: "pause", label: "Pause" },
        ],
        { inputs: strategies.map((x) => ({ id: x.id, type: "checkbox", label: x.label, value: x.kind === "crawler" || (x.id === harnessID && x.label.includes("web search")) })) }
      );
      if (a.choice === "pause") return "pause";
      if (a.choice === "skip") {
        await say(`Continuing: ${missing.length} paper(s) without PDF stay open (“reports not retrieved” in the flow diagram).`, "info");
        return;
      }
      const chosen = strategies.filter((x) => a.values[x.id]).map((x) => x.id);
      if (!chosen.length) continue;
      await say("Looking for the missing PDFs…", "info");
      await API().huntPDFs(chosen, { onLine: (t) => say(t, "info") });
      const still = API().missingPDFs().length;
      await say(`${missing.length - still} PDF(s) found, ${still} still missing.`);
    }
  }

  function fullTextPapers() {
    return R()
      .api.population()
      .map((c) => {
        const item = c.itemID && Zotero.Items.get(c.itemID);
        return { key: c.key, title: c.title, hasPDF: !!(item && ZR().FullText.pdfOf(item)), annotations: item ? ZR().FullText.annotationsOf(item) : [] };
      });
  }

  // --- 5-6 tables
  async function doTable(stage, optional) {
    await R().go(stage);
    const P = protocol();
    const cols = stage === "quality" ? P.quality : stage === "extract" ? P.extraction : P.facets;
    if (!cols?.length) {
      await say(`${stageLabel(stage)}: the protocol has no ${stage === "quality" ? "checklist" : "fields"}, skipped.`, "info");
      return nextAfter(stage);
    }
    if (optional) {
      const a = await ask(`${stageLabel(stage)} is optional. Should **${modelName(ftModel())}** fill in ${cols.length} field(s) for every included paper now?`, [
        { id: "do", label: "Yes, fill them in", primary: true },
        { id: "skip", label: "Skip" },
      ], { blocks: [{ type: "list", items: cols.map((c, i) => ({ mark: `${stage === "extract" ? "E" : "C"}${i + 1}`, text: c })) }] });
      if (a.choice === "skip") return nextAfter(stage);
    }
    await say(`${stageLabel(stage)}: ${modelName(ftModel())} fills in the table…`, "info");
    await withProfile(ftModel(), () => API().tableAI());
    await say(`${stageLabel(stage)} done. Check the table; every cell can be changed.`, "ai", { actions: [{ label: "Open the table", step: stage }] });
    return nextAfter(stage);
  }

  // --- 7 report
  async function doReport() {
    await R().go("report");
    const c = API().counts();
    await say("All steps done.", "done", {
      blocks: [
        {
          type: "facts",
          rows: [
            ["Records identified", c.identified],
            ["Screened", c.screened],
            ["Excluded at screening", c.excludedTA],
            ["Full texts assessed", c.assessed],
            ["Included", c.included],
          ],
        },
      ],
      actions: [{ label: "Open the report", step: "report" }],
    });
    const a = await ask("Save the protocol and the flow summary as a note in the collection?", [
      { id: "save", label: "Save as note", primary: true },
      { id: "no", label: "Finish" },
    ]);
    if (a.choice === "save") await API().saveNote();
    await saveState({ on: false, finished: true, stage: "report" });
    await say("Finished. Right-click any step to run the autopilot from there again.", "done");
    return "stop";
  }

  const STAGES = {
    protocol: doProtocol,
    search: doSearch,
    screen: doScreen,
    fulltext: doFullText,
    quality: () => doTable("quality", false),
    extract: () => doTable("extract", true),
    classify: () => doTable("classify", true),
    report: doReport,
  };

  return { show, hide, dock, collapse, expand, start, runFrom, run, pause, stop, stopAndWait, isRunning: () => running, isStopping: () => stopRequested, state, say, ask, viewSession };
})());

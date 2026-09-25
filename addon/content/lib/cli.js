/* global ZR, ChromeUtils, IOUtils, PathUtils, Services */
// Local AI command-line tools as LLM providers, so a Claude or ChatGPT subscription
// can be used instead of an API key:
//
//   Claude Code  claude -p --output-format json --tools "" --no-session-persistence …
//   Codex        codex exec --skip-git-repo-check --ephemeral --sandbox read-only -o <file> -
//
// The prompt is sent on stdin (no command-line length or quoting limits). Claude runs
// with every tool disabled; Codex runs read-only in an empty temporary folder.

ZR.CLI = (() => {
  const U = ZR.Util;
  const Subprocess = () => ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
  const isWin = () => Services.appinfo.OS === "WINNT";

  const TOOLS = {
    "claude-cli": { exe: "claude", label: "Claude Code" },
    "codex-cli": { exe: "codex", label: "Codex" },
  };

  function home() {
    return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  }
  function env(name) {
    return Services.env.get(name) || "";
  }

  /** Likely install locations (GUI apps often start with a short PATH). */
  function candidates(kind) {
    const exe = TOOLS[kind].exe;
    const h = home();
    if (isWin()) {
      const local = env("LOCALAPPDATA");
      const roaming = env("APPDATA");
      return [
        PathUtils.join(h, ".local", "bin", `${exe}.exe`),
        local && PathUtils.join(local, "Microsoft", "WinGet", "Links", `${exe}.exe`),
        local && kind === "codex-cli" && PathUtils.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        roaming && PathUtils.join(roaming, "npm", `${exe}.cmd`),
      ].filter(Boolean);
    }
    return [PathUtils.join(h, ".local", "bin", exe), "/opt/homebrew/bin/" + exe, "/usr/local/bin/" + exe, "/usr/bin/" + exe, PathUtils.join(h, ".npm-global", "bin", exe)];
  }

  /** Find the executable; returns an absolute path or "". */
  async function detect(kind) {
    const exe = TOOLS[kind]?.exe;
    if (!exe) return "";
    for (const name of isWin() ? [`${exe}.exe`, `${exe}.cmd`] : [exe]) {
      try {
        return await Subprocess().pathSearch(name);
      } catch (e) {
        /* not on PATH */
      }
    }
    for (const p of candidates(kind)) {
      if (await IOUtils.exists(p)) return p;
    }
    return "";
  }

  /** Run a program with stdin text; resolves {stdout, stderr, exitCode}. Kills it after `timeout` ms. */
  function exec(path, args, input, opts = {}) {
    if (ZR.Activity.stopping) return Promise.reject(new ZR.Activity.Stopped());
    const name = String(path).split(/[\\/]/).pop();
    return ZR.Activity.track(
      "cli",
      `${name} ${args.filter((a) => !a.startsWith("-") && a.length < 40).slice(0, 3).join(" ")}`.trim(),
      `${path} ${args.map((a) => (/\s/.test(a) || !a ? JSON.stringify(a) : a)).join(" ")}\n\nInput: ${U.truncate(String(input || ""), 2000)}`,
      (setCancel) => execRaw(path, args, input, opts, setCancel),
      (r) => `exit ${r.exitCode}${r.stderr ? "\n" + U.truncate(r.stderr, 1500) : ""}`
    );
  }

  /** End a CLI run with everything it started (Codex runs helpers of its own). */
  async function killTree(proc) {
    if (isWin() && proc.pid) {
      try {
        await Subprocess().call({ command: (env("SystemRoot") || "C:\\Windows") + "\\System32\\taskkill.exe", arguments: ["/PID", String(proc.pid), "/T", "/F"] }).then((p) => p.wait());
        return;
      } catch (e) {
        U.log("taskkill failed", e.message);
      }
    }
    proc.kill();
  }

  async function execRaw(path, args, input, { timeout = 180000, workdir = null } = {}, setCancel = () => {}) {
    let command = path;
    let argv = args;
    // npm installs .cmd shims, which must go through cmd.exe
    if (isWin() && /\.(cmd|bat)$/i.test(path)) {
      command = env("ComSpec") || "C:\\Windows\\System32\\cmd.exe";
      argv = ["/d", "/s", "/c", path, ...args];
    }
    const proc = await Subprocess().call({ command, arguments: argv, stderr: "pipe", workdir });
    let stopped = false;
    setCancel(() => ((stopped = true), killTree(proc)));
    const timer = setTimeout(() => killTree(proc), timeout);
    const readAll = async (pipe) => {
      let out = "";
      for (let s; (s = await pipe.readString()); ) out += s;
      return out;
    };
    try {
      const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr), (async () => {
        await proc.stdin.write(input);
        await proc.stdin.close();
      })()]);
      const { exitCode } = await proc.wait();
      if (stopped) throw new ZR.Activity.Stopped();
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJSON(path) {
    try {
      return JSON.parse(await IOUtils.readUTF8(path));
    } catch (e) {
      return null;
    }
  }

  const CLAUDE_ALIASES = [
    { id: "fable", name: "Fable (latest)", detail: "most capable" },
    { id: "opus", name: "Opus (latest)", detail: "strong reasoning" },
    { id: "sonnet", name: "Sonnet (latest)", detail: "balanced speed and quality" },
    { id: "haiku", name: "Haiku (latest)", detail: "fastest, lowest usage" },
  ];

  /** Ask Claude Code which model an alias runs (one tiny request; read from its usage report). */
  async function resolveClaude(path, alias) {
    const dir = await tempDir();
    try {
      const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--model", alias];
      const r = await exec(path, args, "Reply with OK", { timeout: 90000, workdir: dir });
      const data = JSON.parse(r.stdout.trim().split("\n").pop());
      return Object.keys(data.modelUsage || {})[0] || "";
    } finally {
      IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
  }

  /**
   * Models a CLI can use, from the CLI's own files:
   *   Codex: ~/.codex/models_cache.json (the list Codex fetched for your account) and the
   *          default model from ~/.codex/config.toml
   *   Claude Code: its aliases, extra models of your account (~/.claude.json) and your
   *          default (~/.claude/settings.json); with resolve, each alias is asked which model
   *          it runs (cached for a week)
   */
  async function models(profile, { resolve = false } = {}) {
    const kind = profile.provider;
    if (kind === "codex-cli") {
      const dir = env("CODEX_HOME") || PathUtils.join(home(), ".codex");
      const cache = await readJSON(PathUtils.join(dir, "models_cache.json"));
      let def = "";
      try {
        def = ((await IOUtils.readUTF8(PathUtils.join(dir, "config.toml"))).match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || "";
      } catch (e) {
        /* no config */
      }
      const list = (cache?.models || []).filter((m) => m.visibility !== "hide");
      if (!list.length) throw new Error("Codex has not stored its model list yet. Run codex once in a terminal");
      return list.map((m) => ({
        id: m.slug,
        name: m.display_name || m.slug,
        detail: [m.description, m.supported_reasoning_levels?.length ? "reasoning: " + m.supported_reasoning_levels.map((l) => l.effort).join(", ") : ""].filter(Boolean).join(" · "),
        isDefault: m.slug === def,
      }));
    }
    if (kind === "claude-cli") {
      const settings = await readJSON(PathUtils.join(home(), ".claude", "settings.json"));
      const account = await readJSON(PathUtils.join(home(), ".claude.json"));
      const def = settings?.model || "";
      const known = ZR.Prefs.getJSON("claudeModelMap", {});
      if (resolve) {
        const path = profile.baseURL || (await detect(kind));
        if (!path) throw new Error("Claude Code CLI not found");
        await Promise.all(
          CLAUDE_ALIASES.map(async (a) => {
            try {
              const id = await resolveClaude(path, a.id);
              if (id) known[a.id] = { id, at: new Date().toISOString().slice(0, 10) };
            } catch (e) {
              U.log("Could not resolve Claude alias", a.id, e.message);
            }
          })
        );
        ZR.Prefs.setJSON("claudeModelMap", known);
      }
      const out = CLAUDE_ALIASES.map((a) => ({
        id: a.id,
        name: a.name,
        detail: known[a.id] ? `runs ${known[a.id].id} (checked ${known[a.id].at}) · ${a.detail}` : a.detail,
        isDefault: def.replace(/\[.*\]$/, "") === a.id,
      }));
      for (const m of account?.additionalModelOptionsCache || []) {
        if (m?.value && !out.some((x) => x.id === m.value)) out.push({ id: m.value, name: m.label || m.value, detail: m.description || "", isDefault: m.value === def });
      }
      if (def && !out.some((x) => x.id === def || x.id === def.replace(/\[.*\]$/, ""))) out.push({ id: def, name: def, detail: "your Claude Code default", isDefault: true });
      return out;
    }
    return [];
  }

  /** Flatten a chat into one prompt (the CLIs take a single instruction). */
  function transcript(messages, system, inlineSystem) {
    const turns =
      messages.length === 1
        ? messages[0].content
        : messages.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}:\n${m.content}`).join("\n\n") + "\n\nAssistant:";
    return inlineSystem && system ? `Instructions:\n${system}\n\n${turns}` : turns;
  }

  async function tempDir() {
    const dir = PathUtils.join(PathUtils.tempDir, `zr-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    return dir;
  }

  /** Chat through a CLI; returns the reply text. */
  /** web: allow web search for this call (finding PDFs) - Claude: WebSearch/WebFetch tools; Codex: --search */
  async function chat(profile, messages, { system, timeout = 180000, web = false } = {}) {
    const kind = profile.provider;
    const path = profile.baseURL || (await detect(kind));
    if (!path) throw new Error(`${TOOLS[kind].label} CLI not found. Install it or set its path in the AI provider settings`);
    const dir = await tempDir();
    try {
      if (kind === "claude-cli") {
        const args = ["-p", "--output-format", "json", "--tools", web ? "WebSearch,WebFetch" : "", "--no-session-persistence", "--strict-mcp-config"];
        if (web) args.push("--allowedTools", "WebSearch,WebFetch");
        if (profile.model) args.push("--model", profile.model);
        if (system) args.push("--system-prompt", system);
        const r = await exec(path, args, transcript(messages, system, false), { timeout, workdir: dir });
        let data;
        try {
          data = JSON.parse(r.stdout.trim().split("\n").pop());
        } catch (e) {
          throw new Error(`Claude Code returned no result (exit ${r.exitCode}): ${U.truncate(r.stderr || r.stdout, 300)}`);
        }
        if (data.is_error || data.subtype?.startsWith("error")) throw new Error(`Claude Code: ${U.truncate(data.result || data.subtype, 300)}`);
        return String(data.result ?? "");
      }
      if (kind === "codex-cli") {
        const outFile = PathUtils.join(dir, "reply.txt");
        const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-C", dir, "-o", outFile];
        if (web) args.push("--search");
        if (profile.model) args.push("-m", profile.model);
        args.push("-");
        const r = await exec(path, args, transcript(messages, system, true), { timeout, workdir: dir });
        const reply = (await IOUtils.exists(outFile)) ? await IOUtils.readUTF8(outFile) : "";
        if (!reply.trim()) throw new Error(`Codex returned no answer (exit ${r.exitCode}): ${U.truncate(r.stderr || r.stdout, 300)}`);
        return reply.trim();
      }
      throw new Error("Unknown CLI provider " + kind);
    } finally {
      IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
  }

  return { TOOLS, detect, chat, transcript, models };
})();

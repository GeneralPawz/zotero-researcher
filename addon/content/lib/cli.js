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
  async function exec(path, args, input, { timeout = 180000, workdir = null } = {}) {
    let command = path;
    let argv = args;
    // npm installs .cmd shims, which must go through cmd.exe
    if (isWin() && /\.(cmd|bat)$/i.test(path)) {
      command = env("ComSpec") || "C:\\Windows\\System32\\cmd.exe";
      argv = ["/d", "/s", "/c", path, ...args];
    }
    const proc = await Subprocess().call({ command, arguments: argv, stderr: "pipe", workdir });
    const timer = setTimeout(() => proc.kill(), timeout);
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
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
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
  async function chat(profile, messages, { system, timeout = 180000 } = {}) {
    const kind = profile.provider;
    const path = profile.baseURL || (await detect(kind));
    if (!path) throw new Error(`${TOOLS[kind].label} CLI not found — install it or set its path in the AI provider settings`);
    const dir = await tempDir();
    try {
      if (kind === "claude-cli") {
        const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
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

  return { TOOLS, detect, chat, transcript };
})();

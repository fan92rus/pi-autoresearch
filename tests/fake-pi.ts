/**
 * Fake pi API harness — lets tests drive the REAL extension
 * (extensions/pi-autoresearch/index.ts) without a running pi instance.
 *
 * Usage:
 *   const { pi, tool, command, hook, ctx } = createFakePi({ dir, sessionId });
 *   autoresearchExtension(pi);              // real extension registers on fake pi
 *   await command("autoresearch").handler("on", ctx);
 *   await tool("init_experiment").execute("id", params, null, null, ctx);
 *   await hook("agent_end")({ messages: [] }, ctx);
 *
 * The fake captures tools/commands/hooks/shortcuts, records sendUserMessage/
 * notify/appendEntry calls, routes exec() through a real-git proxy (for git
 * commands in temp repos) or returns canned output, and provides the
 * sessionManager surface the extension expects (getSessionId + getBranch).
 *
 * run_experiment uses execBashScript (real spawn, NOT pi.exec) — commands
 * like `node -e "0"` run for real. Use trivial fast commands in PBT.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ──────────────────────────────────────────────────────────────────────
// Mini EventBus (for pi.events, unused by core tools in v1)
// ──────────────────────────────────────────────────────────────────────

export function createEventBus() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, data) {
      for (const h of [...(listeners.get(event) ?? [])]) h(data);
    },
    count(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Session manager (the surface pi-autoresearch index.ts expects)
// ──────────────────────────────────────────────────────────────────────

/**
 * Fake session manager. getSessionId() returns the current session key;
 * getBranch() returns the session branch (for reconstructState).
 * restart() simulates a new session (new sessionId).
 */
export function createSessionManager(sessionId, branch = []) {
  let current = sessionId;
  let currentBranch = branch;
  return {
    getSessionId() {
      return current;
    },
    getBranch() {
      return currentBranch;
    },
    restart(newId) {
      current = newId ?? `${current}-restart-${Date.now()}`;
      currentBranch = [{ sessionId: current }];
      return current;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Fake pi
// ──────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.dir — working directory (temp .auto/ lives here)
 * @param {string} opts.sessionId — session key
 * @param {boolean} opts.realGit — run REAL git (child_process) instead of canned answers
 * @param {object} opts.execTable — canned overrides: { "cmd args": { code, stdout, stderr } }
 * @param {function} opts.extraExec — (cmd, args, opts) => result | undefined
 */
export function createFakePi({
  dir,
  sessionId = "test-session",
  realGit = false,
  execTable = {},
  extraExec,
} = {}) {
  const tools = [];
  const commands = [];
  const hooks = new Map();
  const shortcuts = [];
  const sentMessages = [];
  const notifications = [];
  const entries = [];
  const execCalls = [];
  const events = createEventBus();
  let lastSystemPrompt = null;

  // Active-tools model: null = all registered tools are active (default).
  let activeToolNames = null;

  const sessionManager = createSessionManager(sessionId);

  const pi = {
    tools,
    commands,
    hooks,
    shortcuts,
    sentMessages,
    notifications,
    entries,
    execCalls,
    events,
    sessionManager,
    get _lastSystemPrompt() {
      return lastSystemPrompt;
    },

    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(
        event === "before_agent_start"
          ? async (ev, ctx) => {
              const result = await handler(ev, ctx);
              // before_agent_start returns { systemPrompt: ... } — capture it
              if (result?.systemPrompt) {
                lastSystemPrompt = result.systemPrompt;
              } else {
                lastSystemPrompt = ev.systemPrompt;
              }
              return result;
            }
          : handler,
      );
    },

    registerTool(def) {
      tools.push(def);
    },

    registerCommand(name, def) {
      commands.push({ name, ...def });
    },

    registerShortcut(def) {
      shortcuts.push(def);
    },

    registerFlag(_name, _def) {},

    getActiveTools() {
      return activeToolNames ?? tools.map((t) => t.name);
    },

    getAllTools() {
      return tools.map((t) => ({ name: t.name }));
    },

    setActiveTools(names) {
      activeToolNames = names;
    },

    setModel(_model) {},
    getThinkingLevel() {
      return "medium";
    },
    setThinkingLevel(_level) {},

    async exec(cmd, args = [], opts = {}) {
      execCalls.push({ cmd, args, opts });
      if (extraExec) {
        const r = extraExec(cmd, args, opts);
        if (r !== undefined) return r;
      }
      const key = [cmd, ...(args ?? [])].join(" ");
      if (execTable[key]) return execTable[key];

      if (cmd === "git") {
        if (realGit) {
          try {
            const out = execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8" });
            return { code: 0, stdout: out, stderr: "" };
          } catch (e) {
            return {
              code: e.status ?? 1,
              stdout: e.stdout ?? "",
              stderr: e.stderr ?? e.message ?? "",
            };
          }
        }
        // Canned git answers
        const joined = args.join(" ");
        if (joined.startsWith("rev-parse --short=7 HEAD")) return { code: 0, stdout: "aaa1111\n", stderr: "" };
        if (joined.startsWith("rev-parse HEAD")) return { code: 0, stdout: "aaa1111\n", stderr: "" };
        if (joined.startsWith("rev-parse --abbrev-ref HEAD")) return { code: 0, stdout: "main\n", stderr: "" };
        if (joined.startsWith("rev-parse --git-dir")) return { code: 0, stdout: ".git\n", stderr: "" };
        if (joined.startsWith("update-ref")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("add")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("diff --cached --quiet")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("commit")) return { code: 0, stdout: "[main bbb2222] msg\n", stderr: "" };
        if (joined.startsWith("checkout")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("cat-file")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("branch")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("fetch")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("merge")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("log")) return { code: 0, stdout: "aaa1111 msg\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }

      // Other commands (bash scripts, etc.) — let them fall through to real exec
      return { code: 0, stdout: "", stderr: "" };
    },

    async sendUserMessage(text, msgOpts) {
      sentMessages.push({ text, opts: msgOpts ?? {} });
    },

    async notify(text, type) {
      notifications.push({ text, type });
    },

    appendEntry(entry) {
      entries.push(entry);
    },

    debug(..._args) {},
  };

  const tool = (name) => tools.find((t) => t.name === name);
  const command = (name) => commands.find((c) => c.name === name);
  const hook = (event) => (hooks.get(event) ?? [])[0];
  const hookAll = (event) => hooks.get(event) ?? [];
  return { pi, tool, command, hook, hookAll, events };
}

// ──────────────────────────────────────────────────────────────────────
// ctx factory
// ──────────────────────────────────────────────────────────────────────

/**
 * Create a fake extension context.
 * @param {string} dir — cwd
 * @param {string} sessionId — session key
 * @param {object} piRef — the fake pi object (for active-tools accessors)
 */
export function makeCtx(dir, sessionId, piRef) {
  const sessionManager = createSessionManager(sessionId);
  return {
    cwd: dir,
    sessionManager,
    ui: {
      notify() {},
      setWidget() {},
      input: async () => "",
      select: async () => "",
    },
    getActiveTools: () => piRef?.getActiveTools?.() ?? [],
    getAllTools: () => piRef?.getAllTools?.() ?? [],
    setActiveTools: (names) => piRef?.setActiveTools?.(names),
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

/**
 * Create a full test harness: fake pi + ctx, with the REAL extension loaded.
 * Handles git init for temp dirs.
 *
 * @param {object} opts
 * @param {string} opts.dir — temp working directory
 * @param {string} opts.sessionId
 * @param {boolean} opts.realGit — init a real git repo in dir
 * @param {object} opts.execTable — canned exec overrides
 * @returns {{ pi, tool, command, hook, hookAll, ctx, events, cleanup }}
 */
export async function createHarness({ dir, sessionId = "test", realGit = true, execTable = {} }) {
  // Ensure dir exists
  fs.mkdirSync(dir, { recursive: true });

  // Init real git repo if requested
  if (realGit) {
    try {
      execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      // Initial commit so HEAD exists
      fs.writeFileSync(path.join(dir, ".gitkeep"), "");
      execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch { /* may already be a repo */ }
  }

  const { pi, tool, command, hook, hookAll, events } = createFakePi({ dir, sessionId, realGit, execTable });
  const ctx = makeCtx(dir, sessionId, pi);

  // Load the REAL extension
  const { pathToFileURL } = await import("node:url");
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);

  return { pi, tool, command, hook, hookAll, ctx, events };
}

// ──────────────────────────────────────────────────────────────────────
// Disk state readers (for invariant assertions)
// ──────────────────────────────────────────────────────────────────────

/** Read and parse .auto/config.json (never throws). */
export function readConfig(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".auto", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Read and parse .auto/tree.json (never throws). */
export function readTree(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".auto", "tree.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Read .auto/log.jsonl as array of parsed lines (skips invalid lines). */
export function readLog(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The process of one plugin's daemon part (docs/plugins.md). gasho-daemon forks it with the plugin's daemon.js
// (`node plugin-host.js <daemon.js>`), tells it the plugin and its settings ("init"), and sends it the calls of the
// plugin's web part ("call"). It imports the plugin, runs `start`, answers each call with what the method returned,
// and runs `stop` before it ends. A process of its own, so that a plugin that fails or blocks cannot stop gasho-daemon,
// and so that a new version of the plugin replaces it as a whole (hot reload).
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FromHost, SessionWire, ToHost } from "./plugin-ipc.ts";

interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

interface Definition {
  methods: Record<string, (params: unknown, ctx: unknown) => unknown>;
  start?: (ctx: unknown) => unknown;
  stop?: () => unknown;
}

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
/** After SIGTERM, a command gets this long before SIGKILL. */
const EXEC_KILL_MS = 5000;

const file = process.argv[2];
let plugin = "?";
let machine = { id: "", name: "" };
let settings: Record<string, unknown> = {};
let folders: string[] = [];
let dataDir = "";
let def: Definition | undefined;
const aborts = new Map<number, AbortController>();

function send(m: FromHost): void {
  process.send?.(m);
}

/** An error the person is shown as it is (what the plugin's PluginError is, made here). */
function userError(message: string): Error {
  return Object.assign(new Error(message), { gashoPluginError: true });
}

const log = (...args: unknown[]) => console.log(...args);

/** Runs a command without a shell or a terminal, in a process group of its own (stopped as a whole). */
function exec(command: string, args: string[], opts: ExecOptions = {}, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (typeof command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      reject(new Error("exec: give the command and its arguments as strings"));
      return;
    }
    const max = opts.maxBuffer ?? EXEC_MAX_BUFFER;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let killed = false;
    let tooMuch = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (killed || child.pid === undefined || child.exitCode !== null) return;
      killed = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // gone
        }
      }, EXEC_KILL_MS);
      killTimer.unref();
    };
    const timer = setTimeout(stop, opts.timeoutMs ?? EXEC_TIMEOUT_MS);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (into: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > max) {
        tooMuch = true;
        stop();
        return;
      }
      into.push(b);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error(`${command}: ${e.message}`), { code: e.code, killed: false, stdout: "", stderr: "" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && !killed) {
        resolve({ stdout, stderr });
        return;
      }
      const why = tooMuch ? "output too large" : killed ? "stopped (took too long or was aborted)" : `exit code ${code}`;
      reject(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (${why})\n${stderr}`), { code: code ?? undefined, killed, stdout, stderr }));
    });
  });
}

/** The session of a call, with `repo(path)`: its folder, or a repository gasho-daemon found inside it. */
function sessionOf(w: SessionWire) {
  const repos = w.repos.map((r) => ({ path: r.path, dir: path.join(w.cwd, r.path), github: r.github, branch: r.branch }));
  return {
    ...w,
    repos,
    repo(p?: string) {
      if (p === undefined || p === "") return { dir: w.cwd, github: w.github, branch: w.gitBranch };
      const r = repos.find((x) => x.path === p);
      if (!r) throw userError("このリポジトリは見つかりません。");
      return { dir: r.dir, github: r.github, branch: r.branch };
    },
  };
}

function baseContext() {
  return { machine, settings, dataDir, folders: () => [...folders], log, exec: (c: string, a: string[], o?: ExecOptions) => exec(c, a, o) };
}

async function init(m: Extract<ToHost, { t: "init" }>): Promise<void> {
  plugin = m.plugin;
  machine = m.machine;
  settings = m.settings;
  folders = m.local.folders;
  dataDir = m.local.dataDir;
  try {
    if (!file) throw new Error("no daemon.js was given");
    const mod = (await import(pathToFileURL(file).href)) as { default?: Definition };
    const d = mod.default;
    if (!d || typeof d !== "object" || typeof d.methods !== "object" || d.methods === null) {
      throw new Error("daemon.js does not export a plugin (export default defineDaemonPlugin({ methods }))");
    }
    def = d;
    await def.start?.(baseContext());
    send({ t: "ready" });
  } catch (e) {
    send({ t: "failed", error: e instanceof Error ? e.message : String(e) });
    setTimeout(() => process.exit(1), 100);
  }
}

async function call(m: Extract<ToHost, { t: "call" }>): Promise<void> {
  const controller = new AbortController();
  aborts.set(m.id, controller);
  settings = m.settings;
  try {
    const method = def && Object.hasOwn(def.methods, m.method) ? def.methods[m.method] : undefined;
    if (typeof method !== "function") throw userError(`${plugin} に ${m.method} という処理はありません。`);
    const ctx = {
      ...baseContext(),
      session: m.session ? sessionOf(m.session) : undefined,
      signal: controller.signal,
      exec: (c: string, a: string[], o?: ExecOptions) => exec(c, a, o, controller.signal),
    };
    const data = await method(m.params, ctx);
    send({ t: "result", id: m.id, ok: true, data });
  } catch (e) {
    const user = (e as { gashoPluginError?: unknown } | null)?.gashoPluginError === true;
    const error = e instanceof Error ? e.message : String(e);
    if (!user) console.error(`${m.method} failed:`, e);
    send({ t: "result", id: m.id, ok: false, error, user });
  } finally {
    aborts.delete(m.id);
  }
}

process.on("message", (raw) => {
  const m = raw as ToHost;
  switch (m.t) {
    case "init":
      void init(m);
      break;
    case "call":
      void call(m);
      break;
    case "abort":
      aborts.get(m.id)?.abort();
      break;
    case "settings":
      settings = m.settings;
      break;
    case "folders":
      folders = m.folders;
      break;
    case "stop":
      for (const a of aborts.values()) a.abort();
      void (async () => {
        try {
          await def?.stop?.();
        } catch (e) {
          console.error("stop failed:", e);
        }
        process.exit(0);
      })();
      break;
  }
});
// gasho-daemon is gone: so is this.
process.on("disconnect", () => process.exit(0));
// A promise the plugin forgot about is reported; the process goes on.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));

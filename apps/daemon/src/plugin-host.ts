// The process of one plugin's daemon part (docs/plugins.md). gasho-daemon forks it with the plugin's daemon.js
// (`node plugin-host.js <daemon.js>`), tells it the plugin and its settings ("init"), and sends it the calls of the
// plugin's web part ("call"). It imports the plugin, runs `start`, answers each call with what the method returned,
// and runs `stop` before it ends. A process of its own, so that a plugin that fails or blocks cannot stop gasho-daemon,
// and so that a new version of the plugin replaces it as a whole (hot reload). What the plugin asks gh for
// (ctx.github) goes to gasho-daemon ("github"), which runs gh for every plugin.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exec, type ExecOptions, type ExecResult } from "./exec.ts";
import type { FromHost, GitHubAnswer, GitHubAsk, SessionWire, ToHost } from "./plugin-ipc.ts";

interface Definition {
  methods: Record<string, (params: unknown, ctx: unknown) => unknown>;
  start?: (ctx: unknown) => unknown;
  stop?: () => unknown;
}

const file = process.argv[2];
let plugin = "?";
let machine = { id: "", name: "" };
let settings: Record<string, unknown> = {};
let folders: string[] = [];
let dataDir = "";
let def: Definition | undefined;
const aborts = new Map<number, AbortController>();
const asked = new Map<number, (a: GitHubAnswer) => void>();
let nextAsk = 1;

function send(m: FromHost): void {
  process.send?.(m);
}

/** An error the person is shown as it is (what the plugin's PluginError is, made here). */
function userError(message: string): Error {
  return Object.assign(new Error(message), { gashoPluginError: true });
}

const log = (...args: unknown[]) => console.log(...args);

/** ctx.github of a call (`call`: its id), or of `start` (none): gh, run by gasho-daemon. */
function githubOf(call?: number, signal?: AbortSignal) {
  const ask =
    (write: boolean) =>
    (args: string[], o: Omit<GitHubAsk, "args"> = {}): Promise<ExecResult> =>
      new Promise((resolve, reject) => {
        const id = nextAsk++;
        const onAbort = () => answer({ ok: false, error: `gh ${args.join(" ")}: stopped (the call was aborted)`, killed: true, stdout: "", stderr: "" });
        const answer = (a: GitHubAnswer) => {
          asked.delete(id);
          signal?.removeEventListener("abort", onAbort);
          if (a.ok) resolve({ stdout: a.stdout, stderr: a.stderr });
          else {
            const { ok: _, error, user, ...rest } = a;
            reject(Object.assign(user ? userError(error) : new Error(error), rest));
          }
        };
        if (signal?.aborted) return onAbort();
        asked.set(id, answer);
        signal?.addEventListener("abort", onAbort, { once: true });
        const { repo, maxAgeSeconds, timeoutMs, maxBuffer } = o ?? {};
        send({ t: "github", id, ...(call !== undefined ? { call } : {}), write, args, repo, maxAgeSeconds, timeoutMs, maxBuffer });
      });
  return { read: ask(false), write: ask(true) };
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
  return {
    machine,
    settings,
    dataDir,
    folders: () => [...folders],
    log,
    exec: (c: string, a: string[], o?: ExecOptions) => exec(c, a, o),
    github: githubOf(),
  };
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
      github: githubOf(m.id, controller.signal),
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
    case "github.result": {
      const { t: _, id, ...answer } = m;
      asked.get(id)?.(answer);
      break;
    }
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

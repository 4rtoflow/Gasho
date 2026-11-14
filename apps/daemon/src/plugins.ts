// The daemon parts of plugins on this working server (docs/plugins.md). The Gasho server says which plugins to run
// and which version of each ("plugins"); gasho-daemon asks it for the code it does not have yet ("plugin.code.get"),
// keeps it in its cache, and runs each daemon part in a process of its own (plugin-host.ts). Calls from the plugins'
// web parts come as "plugin.request" and are answered with "plugin.response". A new version is started beside the
// old one and takes the calls once it is ready; the old one ends when its calls have (hot reload). What runs is told
// to the Gasho server with "plugin.status", which also tells it that this gasho-daemon runs plugins at all.
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonPluginEntry, DaemonPluginStatus, DaemonToHub, HubToDaemon } from "@gasho/protocol";
import type { FromHost, LocalWire, MachineWire, SessionWire, ToHost } from "./plugin-ipc.ts";

/** The plugin API this gasho-daemon runs plugins of. */
export const PLUGIN_API = "1.2";
/** The process of a daemon part: next to this file (.ts when run from the repository, .js in the npm package). */
const HOST_FILE = fileURLToPath(new URL(`./plugin-host${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
/** How long a new process may take to import the plugin and run its `start`. */
const READY_MS = 10_000;
/** How long `stop` may take before SIGTERM, and SIGTERM before SIGKILL. */
const STOP_MS = 5000;
/** How long an old version keeps answering the calls it took before it is stopped. */
const DRAIN_MS = 130_000;
/** Calls a plugin runs at once; more wait. */
const MAX_CONCURRENT = 8;
/** A daemon part that ends this many times within the window is not started again (until it is changed). */
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
const BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** How long the Gasho server may take to hand over a daemon part's code. */
const CODE_MS = 30_000;

const NOT_RUNNING = "このプラグインは、この working server では動いていません。";
const FAILED = "処理に失敗しました。詳しくは、working server の gasho-daemon のログを見てください。";

type Answer = { ok: true; data?: unknown } | { ok: false; error: string; user: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One process running one version of a plugin's daemon part. */
class HostProcess {
  readonly hash: string;
  private child: ChildProcess;
  private calls = new Map<number, { resolve: (a: Answer) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private exitCode: number | null | undefined;
  private exitWaiters: (() => void)[] = [];
  readonly ready: Promise<void>;
  /** Called once when the process ends. */
  onExit: (code: number | null) => void = () => undefined;

  constructor(id: string, hash: string, codeFile: string, init: { machine: MachineWire; settings: Record<string, unknown>; local: LocalWire }, log: (s: string) => void) {
    this.hash = hash;
    this.child = fork(HOST_FILE, [codeFile], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
      execArgv: [...process.execArgv.filter((a) => !a.startsWith("--max-old-space-size")), "--max-old-space-size=512"],
      env: { ...process.env, GASHO_PLUGIN: id },
    });
    const prefix = `plugin ${id}: `;
    const lines = (stream: NodeJS.ReadableStream | null) => {
      let rest = "";
      stream?.on("data", (b: Buffer) => {
        const text = rest + b.toString("utf8");
        const parts = text.split("\n");
        rest = parts.pop() ?? "";
        for (const l of parts) if (l.trim()) log(prefix + l);
      });
    };
    lines(this.child.stdout);
    lines(this.child.stderr);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${READY_MS / 1000}秒たっても動き始めませんでした。`)), READY_MS);
      this.child.on("message", (raw) => {
        const m = raw as FromHost;
        if (m.t === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (m.t === "failed") {
          clearTimeout(timer);
          reject(new Error(m.error));
        } else if (m.t === "result") {
          const c = this.calls.get(m.id);
          if (!c) return;
          clearTimeout(c.timer);
          this.calls.delete(m.id);
          c.resolve(m.ok ? { ok: true, data: m.data } : { ok: false, error: m.error, user: m.user });
        }
      });
      this.child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`起動できませんでした（終了コード ${code}）。`));
      });
    });
    this.ready.catch(() => undefined);
    this.child.on("exit", (code) => {
      this.exitCode = code;
      for (const [id, c] of this.calls) {
        clearTimeout(c.timer);
        this.calls.delete(id);
        c.resolve({ ok: false, error: "プラグインの処理が途中で止まりました。", user: true });
      }
      for (const w of this.exitWaiters.splice(0)) w();
      this.onExit(code);
    });
    this.child.on("error", (e) => log(`${prefix}${e.message}`));
    this.send({ t: "init", plugin: id, machine: init.machine, settings: init.settings, local: init.local });
  }

  get alive(): boolean {
    return this.exitCode === undefined;
  }

  get busy(): number {
    return this.calls.size;
  }

  private send(m: ToHost): void {
    if (this.alive && this.child.connected) this.child.send(m);
  }

  settings(settings: Record<string, unknown>): void {
    this.send({ t: "settings", settings });
  }

  folders(folders: string[]): void {
    this.send({ t: "folders", folders });
  }

  call(method: string, params: unknown, session: SessionWire | undefined, settings: Record<string, unknown>, timeoutMs: number): Promise<Answer> {
    return new Promise((resolve) => {
      if (!this.alive) {
        resolve({ ok: false, error: NOT_RUNNING, user: true });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.calls.delete(id)) return;
        this.send({ t: "abort", id });
        resolve({ ok: false, error: "working server から応答がありません。", user: true });
      }, timeoutMs);
      this.calls.set(id, { resolve, timer });
      this.send({ t: "call", id, method, params, ...(session ? { session } : {}), settings });
    });
  }

  private exited(ms: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Ends the process: `stop` first, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.send({ t: "stop" });
    if (await this.exited(STOP_MS)) return;
    this.child.kill("SIGTERM");
    if (await this.exited(STOP_MS)) return;
    this.child.kill("SIGKILL");
    await this.exited(STOP_MS);
  }

  /** Ends the process once the calls it took are answered (or after DRAIN_MS). */
  async retire(): Promise<void> {
    const until = Date.now() + DRAIN_MS;
    while (this.calls.size > 0 && Date.now() < until && this.alive) await sleep(100);
    await this.stop();
  }
}

/** A plugin this gasho-daemon was told about. */
interface Slot {
  id: string;
  entry: DaemonPluginEntry;
  /** The process taking the calls. */
  proc?: HostProcess;
  /** A new version being started. */
  starting?: HostProcess;
  /** The version that failed, and why; not started again until the plugin changes or is turned off and on. */
  failed?: { hash: string; error: string };
  crashes: number[];
  backoff: number;
  restart?: NodeJS.Timeout;
  /** Calls waiting for a process, or for room (MAX_CONCURRENT). */
  waiting: (() => void)[];
  /** Calls running. */
  running: number;
}

export interface PluginRunnerOptions {
  /** Where the daemon parts' code is kept, one folder per plugin and version. */
  cacheDir: string;
  send: (m: DaemonToHub) => void;
  machine: () => MachineWire;
  /** The session a call names, as gasho-daemon tracks it; undefined for one it does not. */
  session: (sessionId: string) => Promise<SessionWire | undefined>;
  /** The folders Gasho offers to start sessions in, now. */
  folders: () => string[];
  /** Where each daemon part keeps its own files, one folder per plugin. */
  dataDir: string;
  /** False when GASHO_PLUGINS=none: no daemon part runs here. */
  enabled: boolean;
  log: (s: string) => void;
}

export class PluginRunner {
  private opts: PluginRunnerOptions;
  private slots = new Map<string, Slot>();
  private code = new Map<string, { resolve: (code: string) => void; reject: (e: Error) => void }>();
  private lastStatus = "";

  constructor(opts: PluginRunnerOptions) {
    this.opts = opts;
  }

  /** What the Gasho server says should run here. */
  update(entries: DaemonPluginEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry?.id !== "string" || typeof entry.hash !== "string") continue;
      seen.add(entry.id);
      const slot = this.slots.get(entry.id) ?? { id: entry.id, entry, crashes: [], backoff: BACKOFF_MS, waiting: [], running: 0 };
      const was = slot.entry;
      slot.entry = entry;
      this.slots.set(entry.id, slot);
      if (!entry.run || !this.opts.enabled) {
        // Turned off: forgotten failures, so that turning it on again tries again.
        slot.failed = undefined;
        slot.crashes = [];
        this.halt(slot);
        continue;
      }
      if (!was.run || was.hash !== entry.hash) {
        slot.failed = undefined;
        slot.crashes = [];
      }
      if (slot.proc?.hash === entry.hash) slot.proc.settings(entry.settings);
      void this.ensure(slot);
    }
    for (const [id, slot] of this.slots) {
      if (seen.has(id)) continue;
      this.halt(slot);
      this.slots.delete(id);
    }
    this.status();
  }

  /** The code of a daemon part, as the Gasho server handed it over. */
  onCode(m: Extract<HubToDaemon, { type: "plugin.code" }>): void {
    const key = `${m.plugin}\0${m.hash}`;
    const waiting = this.code.get(key);
    if (!waiting) return;
    this.code.delete(key);
    if (typeof m.code === "string") waiting.resolve(m.code);
    else waiting.reject(new Error(m.error ?? "Gasho サーバーから daemon.js を受け取れませんでした。"));
  }

  /** A call from a plugin's web part. */
  async request(m: Extract<HubToDaemon, { type: "plugin.request" }>): Promise<void> {
    const reply = (a: { result?: unknown; error?: string }) => this.opts.send({ type: "plugin.response", requestId: m.requestId, ...a });
    const slot = this.slots.get(m.plugin);
    if (!this.opts.enabled) return reply({ error: "この working server の gasho-daemon は、プラグインを動かさない設定です（GASHO_PLUGINS）。" });
    if (!slot?.entry.run) return reply({ error: NOT_RUNNING });
    let session: SessionWire | undefined;
    if (m.sessionId !== undefined) {
      session = await this.opts.session(m.sessionId);
      if (!session) return reply({ error: "このセッションは見つかりません。" });
    }
    const timeoutMs = Math.min(Math.max(Number(m.timeoutMs) || 15_000, 1000), 120_000);
    const proc = await this.take(slot, timeoutMs);
    if (typeof proc === "string") return reply({ error: proc });
    slot.running++;
    try {
      const a = await proc.call(m.method, m.params, session, slot.entry.settings, timeoutMs);
      if (a.ok) reply({ result: a.data });
      else {
        if (!a.user) this.opts.log(`plugin ${slot.id}: ${m.method} failed: ${a.error}`);
        reply({ error: a.user ? a.error : FAILED });
      }
    } finally {
      slot.running--;
      slot.waiting.shift()?.();
    }
  }

  /** Tells the Gasho server what runs here (also that this gasho-daemon runs plugins at all). */
  status(force = false): void {
    const plugins: DaemonPluginStatus[] = [...this.slots.values()].map((s) => {
      if (!this.opts.enabled || !s.entry.run) return { id: s.id, state: "off" };
      if (s.failed) return { id: s.id, state: "failed", error: s.failed.error, ...(s.proc ? { hash: s.proc.hash } : {}) };
      if (s.proc?.alive) return { id: s.id, state: "running", hash: s.proc.hash };
      return { id: s.id, state: "stopped" };
    });
    const msg: DaemonToHub = { type: "plugin.status", api: PLUGIN_API, plugins };
    const json = JSON.stringify(msg);
    if (!force && json === this.lastStatus) return;
    this.lastStatus = json;
    this.opts.send(msg);
  }

  /** The folders Gasho offers to start sessions in changed: the running daemon parts hear of it. */
  foldersChanged(): void {
    const folders = this.opts.folders();
    for (const slot of this.slots.values()) {
      slot.proc?.folders(folders);
      slot.starting?.folders(folders);
    }
  }

  /** Ends every daemon part (gasho-daemon is stopping). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => this.halt(s)));
  }

  // ---- processes ----

  /** A process to call, once one is ready and has room; or why there is none. */
  private async take(slot: Slot, timeoutMs: number): Promise<HostProcess | string> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (!slot.entry.run) return NOT_RUNNING;
      if (slot.failed && slot.failed.hash === slot.entry.hash && !slot.proc?.alive) return `このプラグインを動かせません：${slot.failed.error}`;
      if (slot.proc?.alive && slot.running < MAX_CONCURRENT) return slot.proc;
      const left = until - Date.now();
      if (left <= 0) return "working server から応答がありません。";
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1000));
        slot.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Starts the version the Gasho server asked for, unless it runs, is starting, or failed. */
  private async ensure(slot: Slot): Promise<void> {
    const { hash } = slot.entry;
    if (!slot.entry.run || !this.opts.enabled) return;
    if (slot.proc?.alive && slot.proc.hash === hash) return;
    if (slot.starting?.hash === hash || slot.failed?.hash === hash) return;
    let file: string;
    // The plugin's id is checked by the Gasho server (letters, digits and "-"), so it can name a folder.
    const dataDir = path.join(this.opts.dataDir, slot.id);
    try {
      file = await this.codeFile(slot.id, hash);
      await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (slot.entry.hash === hash) slot.failed = { hash, error: e instanceof Error ? e.message : String(e) };
      this.status();
      return;
    }
    if (slot.entry.hash !== hash || !slot.entry.run || slot.starting?.hash === hash) return;
    const local = { folders: this.opts.folders(), dataDir };
    const proc = new HostProcess(slot.id, hash, file, { machine: this.opts.machine(), settings: slot.entry.settings, local }, this.opts.log);
    const before = slot.starting;
    slot.starting = proc;
    void before?.stop();
    try {
      await proc.ready;
    } catch (e) {
      void proc.stop();
      if (slot.starting === proc) slot.starting = undefined;
      if (slot.entry.hash === hash) {
        slot.failed = { hash, error: e instanceof Error ? e.message : String(e) };
        this.opts.log(`plugin ${slot.id}: version ${hash} did not start: ${slot.failed.error}`);
      }
      this.wake(slot);
      this.status();
      return;
    }
    if (slot.starting !== proc || slot.entry.hash !== hash || !slot.entry.run) {
      void proc.stop();
      return;
    }
    slot.starting = undefined;
    const old = slot.proc;
    slot.proc = proc;
    slot.failed = undefined;
    proc.onExit = (code) => this.ended(slot, proc, code);
    this.opts.log(`plugin ${slot.id}: version ${hash} runs${old ? ` (replacing ${old.hash})` : ""}`);
    if (old) void old.retire();
    this.wake(slot);
    this.status();
  }

  /** The process taking the calls ended by itself: started again after a while, unless it ends too often. */
  private ended(slot: Slot, proc: HostProcess, code: number | null): void {
    if (slot.proc !== proc) return;
    slot.proc = undefined;
    this.opts.log(`plugin ${slot.id}: its process ended (exit code ${code})`);
    const now = Date.now();
    slot.crashes = [...slot.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (slot.crashes.length >= MAX_CRASHES) {
      slot.failed = { hash: proc.hash, error: "10分間に5回止まったので、起動し直すのをやめました。" };
      this.wake(slot);
      this.status();
      return;
    }
    this.status();
    if (slot.restart) clearTimeout(slot.restart);
    slot.restart = setTimeout(() => {
      slot.restart = undefined;
      void this.ensure(slot);
    }, slot.backoff);
    slot.restart.unref();
    slot.backoff = Math.min(slot.backoff * 2, MAX_BACKOFF_MS);
  }

  private async halt(slot: Slot): Promise<void> {
    if (slot.restart) clearTimeout(slot.restart);
    slot.restart = undefined;
    slot.backoff = BACKOFF_MS;
    const procs = [slot.proc, slot.starting].filter((p): p is HostProcess => p !== undefined);
    slot.proc = undefined;
    slot.starting = undefined;
    this.wake(slot);
    await Promise.all(procs.map((p) => p.retire()));
  }

  private wake(slot: Slot): void {
    for (const w of slot.waiting.splice(0)) w();
  }

  /** The daemon part's code in the cache, asked of the Gasho server when it is not there yet. */
  private async codeFile(id: string, hash: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id) || !/^[0-9a-f]{16}$/.test(hash)) throw new Error("プラグインの指定が正しくありません。");
    const file = path.join(this.opts.cacheDir, id, hash, "daemon.mjs");
    if (fs.existsSync(file)) return file;
    const key = `${id}\0${hash}`;
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.code.delete(key);
        reject(new Error("Gasho サーバーから daemon.js を受け取れませんでした。"));
      }, CODE_MS);
      this.code.set(key, {
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.opts.send({ type: "plugin.code.get", plugin: id, hash });
    });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, code);
    await fsp.rename(tmp, file);
    await this.prune(id, hash);
    return file;
  }

  /** Keeps the code of the 5 newest versions of a plugin. */
  private async prune(id: string, keep: string): Promise<void> {
    const base = path.join(this.opts.cacheDir, id);
    const versions = await Promise.all(
      (await fsp.readdir(base).catch(() => [] as string[])).map(async (n) => ({ n, at: (await fsp.stat(path.join(base, n)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    for (const v of versions.sort((a, b) => b.at - a.at).slice(5)) {
      if (v.n !== keep) await fsp.rm(path.join(base, v.n), { recursive: true, force: true });
    }
  }
}

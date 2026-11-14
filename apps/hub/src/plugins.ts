// The plugins installed on the Gasho server (docs/plugins.md): one folder each in the plugins folder
// (GASHO_PLUGINS_DIR), a copy (hub:plugin add) or a link to a folder being developed (hub:plugin add --link). The
// registry reads and checks each folder, and takes the SHA-256 of its files as the plugin's version: what passed the
// checks is copied to a folder of that version in the cache, and served from there, so that browsers never get a
// build that is half written, and a version they loaded keeps its files (such as chunks loaded later). The folders are
// watched: a change shows up as a new version (hot reload), or, when the new files fail the checks, as an error while
// the version before stays in use.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PluginManifest, PluginMethodSpec, PluginPermission, PluginSettingSpec } from "@gasho/protocol";

/** The plugin API this Gasho server serves: plugins written for 1.0 … 1.PLUGIN_API_MINOR. */
export const PLUGIN_API_MAJOR = 1;
export const PLUGIN_API_MINOR = 5;
/** The version of the plugin API, as plugins and gasho-daemon name it. */
export const PLUGIN_API = `${PLUGIN_API_MAJOR}.${PLUGIN_API_MINOR}`;

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const API_RE = /^(\d+)\.(\d+)$/;
const KEY_RE = /^[A-Za-z][\w-]{0,63}$/;
const PERMISSIONS = new Set<PluginPermission>(["session.input", "session.launch"]);
export const DEFAULT_TIMEOUT_SECONDS = 15;
export const MAX_TIMEOUT_SECONDS = 120;
/** A plugin's files, at most. */
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
/** Versions kept per plugin in the cache. */
const KEEP_VERSIONS = 5;
/** A build writes several files in a row: the folders are read again this long after the last change. */
const SETTLE_MS = 300;

export type ManifestCheck = { manifest: PluginManifest } | { error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** A file of the plugin, relative to its folder ("web.js", "assets/x.js"): never one outside it. */
export function safeRelative(p: unknown): string | undefined {
  if (typeof p !== "string" || !p || p.length > 300 || p.includes("\0") || p.includes("\\")) return undefined;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== "..") ? parts.join("/") : undefined;
}

function settingError(key: string, spec: unknown): string | undefined {
  const where = `settings.${key}`;
  if (!isRecord(spec)) return `${where} が正しくありません。`;
  if (!isText(spec.label, 80)) return `${where}.label を80文字までで書いてください。`;
  if (spec.description !== undefined && (typeof spec.description !== "string" || spec.description.length > 300)) return `${where}.description は300文字までです。`;
  if (spec.scope !== "browser" && spec.scope !== "server") return `${where}.scope は browser か server です。`;
  const d = spec.default;
  switch (spec.type) {
    case "boolean":
      return d === undefined || typeof d === "boolean" ? undefined : `${where}.default は true か false です。`;
    case "number": {
      for (const k of ["default", "min", "max", "step"] as const) {
        if (spec[k] !== undefined && (typeof spec[k] !== "number" || !Number.isFinite(spec[k]))) return `${where}.${k} は数です。`;
      }
      return undefined;
    }
    case "string":
      if (spec.maxLength !== undefined && (!Number.isInteger(spec.maxLength) || (spec.maxLength as number) < 1)) return `${where}.maxLength は1以上の整数です。`;
      return d === undefined || typeof d === "string" ? undefined : `${where}.default は文字列です。`;
    case "select": {
      const options = spec.options;
      if (!Array.isArray(options) || options.length === 0) return `${where}.options に選択肢を並べてください。`;
      if (!options.every((o) => isRecord(o) && typeof o.value === "string" && isText(o.label, 80))) return `${where}.options が正しくありません。`;
      if (d !== undefined && !options.some((o) => (o as { value: string }).value === d)) return `${where}.default は options のどれかです。`;
      return undefined;
    }
    default:
      return `${where}.type は boolean、number、string、select のどれかです。`;
  }
}

/**
 * Checks a plugin's gasho-plugin.json: its fields, the plugin API it needs, and that the files it names are among
 * `files` (paths relative to its folder). `folder`: the name of its folder, which must be its id.
 */
export function checkManifest(raw: unknown, folder: string | undefined, files: ReadonlySet<string>): ManifestCheck {
  if (!isRecord(raw)) return { error: "gasho-plugin.json が JSON のオブジェクトではありません。" };
  const { id, name, version, description, api, web, daemon, methods, permissions, settings } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return { error: "id は、英小文字で始まり、英小文字・数字・- からなる2〜32文字にしてください。" };
  if (folder !== undefined && folder !== id) return { error: `フォルダーの名前（${folder}）と id（${id}）が違います。` };
  if (!isText(name, 40)) return { error: "name を40文字までで書いてください。" };
  if (typeof version !== "string" || !VERSION_RE.test(version)) return { error: "version は 1.2.0 の形で書いてください。" };
  if (description !== undefined && (typeof description !== "string" || description.length > 300)) return { error: "description は300文字までです。" };
  const a = typeof api === "string" ? API_RE.exec(api) : null;
  if (!a) return { error: "api は 1.0 の形で書いてください。" };
  if (Number(a[1]) !== PLUGIN_API_MAJOR || Number(a[2]) > PLUGIN_API_MINOR) {
    return { error: `このプラグインはプラグインの API ${api} が要りますが、この Gasho は ${PLUGIN_API} までです。` };
  }
  const manifest: PluginManifest = { id, name: name.trim(), version, api: api as string };
  if (typeof description === "string" && description.trim()) manifest.description = description.trim();
  const fileOf = (v: unknown, what: string): string | { error: string } => {
    const rel = safeRelative(v);
    if (!rel) return { error: `${what} のファイルの指定が正しくありません。` };
    if (!files.has(rel)) return { error: `${what} のファイル（${rel}）がありません。ビルドしましたか。` };
    return rel;
  };
  if (web !== undefined) {
    if (!isRecord(web)) return { error: "web が正しくありません。" };
    const js = fileOf(web.js, "web.js");
    if (typeof js !== "string") return js;
    manifest.web = { js };
    if (web.css !== undefined) {
      const css = fileOf(web.css, "web.css");
      if (typeof css !== "string") return css;
      manifest.web.css = css;
    }
  }
  if (daemon !== undefined) {
    if (!isRecord(daemon)) return { error: "daemon が正しくありません。" };
    const js = fileOf(daemon.js, "daemon.js");
    if (typeof js !== "string") return js;
    manifest.daemon = { js };
  }
  if (!manifest.web && !manifest.daemon) return { error: "web と daemon のどちらかは要ります。" };
  if (methods !== undefined) {
    if (!isRecord(methods)) return { error: "methods が正しくありません。" };
    const out: Record<string, PluginMethodSpec> = {};
    for (const [key, spec] of Object.entries(methods)) {
      if (!KEY_RE.test(key)) return { error: `methods の名前（${key}）が正しくありません。` };
      if (!isRecord(spec) || (spec.kind !== "read" && spec.kind !== "write")) return { error: `methods.${key}.kind は read か write です。` };
      const t = spec.timeoutSeconds;
      if (t !== undefined && (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > MAX_TIMEOUT_SECONDS)) {
        return { error: `methods.${key}.timeoutSeconds は ${MAX_TIMEOUT_SECONDS} までの秒数です。` };
      }
      out[key] = { kind: spec.kind, ...(t !== undefined ? { timeoutSeconds: t } : {}) };
    }
    if (Object.keys(out).length > 0 && !manifest.daemon) return { error: "methods があるのに daemon がありません。" };
    manifest.methods = out;
  }
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || !permissions.every((p) => PERMISSIONS.has(p as PluginPermission))) {
      return { error: "permissions に使えるのは session.input と session.launch です。" };
    }
    manifest.permissions = [...new Set(permissions as PluginPermission[])];
  }
  if (settings !== undefined) {
    if (!isRecord(settings)) return { error: "settings が正しくありません。" };
    for (const [key, spec] of Object.entries(settings)) {
      if (!KEY_RE.test(key)) return { error: `settings の名前（${key}）が正しくありません。` };
      const wrong = settingError(key, spec);
      if (wrong) return { error: wrong };
    }
    manifest.settings = settings as Record<string, PluginSettingSpec>;
  }
  return { manifest };
}

/** The value a setting has: `value` when it fits the spec, otherwise its default. */
export function settingValue(spec: PluginSettingSpec, value: unknown): unknown {
  return settingProblem(spec, value) === undefined ? value : spec.default;
}

/** Why `value` does not fit a setting (undefined when it does). */
export function settingProblem(spec: PluginSettingSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "true か false を選んでください。";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "数を入れてください。";
      if (spec.min !== undefined && value < spec.min) return `${spec.min} 以上にしてください。`;
      if (spec.max !== undefined && value > spec.max) return `${spec.max} 以下にしてください。`;
      return undefined;
    case "string":
      if (typeof value !== "string") return "文字を入れてください。";
      return value.length > (spec.maxLength ?? 10_000) ? `${spec.maxLength ?? 10_000}文字までです。` : undefined;
    case "select":
      return spec.options.some((o) => o.value === value) ? undefined : "選択肢から選んでください。";
  }
}

/** A version of a plugin that passed the checks. */
export interface PluginRevision {
  /** The first 16 hex digits of the SHA-256 of its files. */
  hash: string;
  manifest: PluginManifest;
  /** Its copy in the cache. */
  dir: string;
}

/** A plugin folder, as the registry last read it. */
export interface PluginEntry {
  id: string;
  /** A link to a folder being developed. */
  dev: boolean;
  /** The version in use. Absent when no version of it passed the checks. */
  revision?: PluginRevision;
  /** Why the folder (or its newest files) cannot be used. */
  error?: string;
}

/** The files of a folder, relative to it, sorted; links inside it are left out. */
async function filesOf(root: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), rel);
      else if (d.isFile()) {
        const size = (await fsp.stat(path.join(dir, d.name))).size;
        bytes += size;
        out.push({ rel, size });
        if (out.length > MAX_FILES) throw new Error(`ファイルが多すぎます（${MAX_FILES}個まで）。`);
        if (bytes > MAX_BYTES) throw new Error(`ファイルが大きすぎます（合わせて ${MAX_BYTES / 1024 / 1024}MB まで）。`);
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Whether a plugin folder being developed is in the middle of a build: the build of the SDK (gasho-plugin build) takes
 * its gasho-plugin.json away first and writes it again last, so while it is missing or older than another file, the
 * build is not done.
 */
export async function building(folder: string): Promise<boolean> {
  let manifest: number;
  try {
    manifest = (await fsp.stat(path.join(folder, "gasho-plugin.json"))).mtimeMs;
  } catch {
    return true;
  }
  const walk = async (dir: string): Promise<boolean> => {
    for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (await walk(p)) return true;
      } else if (d.isFile() && (await fsp.stat(p)).mtimeMs > manifest + 1) return true;
    }
    return false;
  };
  return walk(folder);
}

/** Reads and checks a plugin folder: its manifest, and its files with their hash. */
export async function readPluginFolder(
  folder: string,
  name: string | undefined,
): Promise<{ manifest: PluginManifest; hash: string; files: { rel: string; data: Buffer }[] } | { error: string }> {
  let list: { rel: string; size: number }[];
  try {
    list = await filesOf(folder);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const rels = new Set(list.map((f) => f.rel));
  if (!rels.has("gasho-plugin.json")) return { error: "gasho-plugin.json がありません。" };
  const files = await Promise.all(list.map(async (f) => ({ rel: f.rel, data: await fsp.readFile(path.join(folder, f.rel)) })));
  let raw: unknown;
  try {
    raw = JSON.parse(files.find((f) => f.rel === "gasho-plugin.json")?.data.toString("utf8") ?? "");
  } catch {
    return { error: "gasho-plugin.json を JSON として読めません。" };
  }
  const checked = checkManifest(raw, name, rels);
  if ("error" in checked) return checked;
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.rel);
    h.update("\0");
    h.update(String(f.data.length));
    h.update("\0");
    h.update(f.data);
  }
  return { manifest: checked.manifest, hash: h.digest("hex").slice(0, 16), files };
}

export interface PluginRegistryOptions {
  /** The plugins folder (GASHO_PLUGINS_DIR). */
  dir: string;
  /** Where the versions are copied to and served from. */
  cacheDir: string;
  log?: (s: string) => void;
}

/** Emits "change" whenever a plugin is added, removed, gets a new version, or gets or loses an error. */
export class PluginRegistry extends EventEmitter {
  readonly dir: string;
  readonly cacheDir: string;
  private log: (s: string) => void;
  private plugins = new Map<string, PluginEntry>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private scanning: Promise<void> | undefined;
  private again = false;
  private closed = false;
  /** start() was called: the folders are watched. */
  private watching = false;

  constructor(opts: PluginRegistryOptions) {
    super();
    this.dir = opts.dir;
    this.cacheDir = opts.cacheDir;
    this.log = opts.log ?? (() => undefined);
  }

  entries(): PluginEntry[] {
    return [...this.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginEntry | undefined {
    return this.plugins.get(id);
  }

  /** Reads every plugin folder again (once at a time; a call meanwhile reads again after it). */
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.again = false;
        await this.scanOnce();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  /** Reads the folders now and whenever they change. */
  async start(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    this.watching = true;
    await this.scan();
    try {
      const w = fs.watch(this.dir, () => this.settle());
      w.on("error", () => undefined);
      this.watchers.set(this.dir, w);
    } catch (e) {
      this.log(`cannot watch ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /** A file of a version of a plugin, to serve: undefined when there is no such file. */
  filePath(id: string, hash: string, rel: string): string | undefined {
    if (!ID_RE.test(id) || !/^[0-9a-f]{16}$/.test(hash)) return undefined;
    const safe = safeRelative(rel);
    if (!safe) return undefined;
    const root = path.join(this.cacheDir, id, hash);
    const file = path.join(root, safe);
    if (!file.startsWith(root + path.sep)) return undefined;
    try {
      return fs.statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** The daemon part of a version of a plugin (still in the cache), for gasho-daemon. */
  async daemonCode(id: string, hash: string): Promise<string | undefined> {
    const entry = this.plugins.get(id);
    const rel = entry?.revision?.hash === hash ? entry.revision.manifest.daemon?.js : await this.daemonFileOf(id, hash);
    const file = rel ? this.filePath(id, hash, rel) : undefined;
    return file ? fsp.readFile(file, "utf8") : undefined;
  }

  private async daemonFileOf(id: string, hash: string): Promise<string | undefined> {
    const file = this.filePath(id, hash, "gasho-plugin.json");
    if (!file) return undefined;
    try {
      const m = JSON.parse(await fsp.readFile(file, "utf8")) as PluginManifest;
      return m.daemon?.js;
    } catch {
      return undefined;
    }
  }

  private settle(ms = SETTLE_MS): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, ms);
    this.timer.unref();
  }

  private async scanOnce(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await fsp.readdir(this.dir)).filter((n) => !n.startsWith("."));
    } catch {
      names = [];
    }
    const next = new Map<string, PluginEntry>();
    const watched = new Set<string>([this.dir]);
    for (const name of names.sort()) {
      const folder = path.join(this.dir, name);
      let dev = false;
      let real: string;
      try {
        dev = (await fsp.lstat(folder)).isSymbolicLink();
        real = await fsp.realpath(folder);
        if (!(await fsp.stat(real)).isDirectory()) continue;
      } catch {
        // A broken link: shown, so that it can be removed.
        next.set(name, { id: name, dev: true, error: "リンク先のフォルダーがありません。" });
        continue;
      }
      const ino = (await fsp.stat(real)).ino;
      watched.add(`${real}#${ino}`);
      this.watchFolder(real, ino);
      if (dev) {
        // A build may make the folder anew (another inode): its parent says so.
        watched.add(`${path.dirname(real)}#parent`);
        this.watchParent(path.dirname(real));
      }
      const id = ID_RE.test(name) ? name : undefined;
      const before = this.plugins.get(name);
      // A plugin being developed, in the middle of a build: the version in use stays, and the end of the build is
      // awaited (its last write, gasho-plugin.json, is a change too; checked again in a while in case it was missed).
      if (dev && before && (await building(real))) {
        next.set(name, before);
        this.settle(2000);
        continue;
      }
      const read = await readPluginFolder(real, name);
      if ("error" in read) {
        // The version in use stays, with the error of the newer files.
        next.set(name, before?.revision ? { id: name, dev, revision: before.revision, error: `新しい版に問題があります：${read.error}` } : { id: name, dev, error: read.error });
        continue;
      }
      if (!id) continue;
      try {
        const dir = await this.keep(id, read.hash, read.files);
        next.set(id, { id, dev, revision: { hash: read.hash, manifest: read.manifest, dir } });
      } catch (e) {
        next.set(id, { id, dev, ...(before?.revision ? { revision: before.revision } : {}), error: `プラグインを用意できません：${e instanceof Error ? e.message : String(e)}` });
      }
    }
    for (const [p, w] of this.watchers) {
      if (watched.has(p)) continue;
      w.close();
      this.watchers.delete(p);
    }
    const changed = JSON.stringify([...this.plugins.entries()]) !== JSON.stringify([...next.entries()]);
    this.plugins = next;
    if (changed) {
      for (const e of next.values()) {
        if (e.error) this.log(`plugin ${e.id}: ${e.error}`);
        else if (e.revision) this.log(`plugin ${e.id} ${e.revision.manifest.version} (${e.revision.hash})${e.dev ? " [dev]" : ""}`);
      }
      this.emit("change");
    }
  }

  private watchFolder(real: string, ino: number): void {
    const key = `${real}#${ino}`;
    if (!this.watching || this.watchers.has(key) || this.closed) return;
    try {
      const w = fs.watch(real, { recursive: true }, () => this.settle());
      w.on("error", () => undefined);
      this.watchers.set(key, w);
    } catch (e) {
      this.log(`cannot watch ${real}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private watchParent(dir: string): void {
    const key = `${dir}#parent`;
    if (!this.watching || this.watchers.has(key) || this.closed) return;
    try {
      const w = fs.watch(dir, () => this.settle());
      w.on("error", () => undefined);
      this.watchers.set(key, w);
    } catch {
      // the folder itself is watched
    }
  }

  /** Copies a version into the cache (once), and drops the oldest ones beyond KEEP_VERSIONS. */
  private async keep(id: string, hash: string, files: { rel: string; data: Buffer }[]): Promise<string> {
    const base = path.join(this.cacheDir, id);
    const dir = path.join(base, hash);
    if (!fs.existsSync(dir)) {
      const tmp = path.join(base, `.${hash}-${process.pid}-${Date.now()}`);
      for (const f of files) {
        await fsp.mkdir(path.dirname(path.join(tmp, f.rel)), { recursive: true });
        await fsp.writeFile(path.join(tmp, f.rel), f.data);
      }
      try {
        await fsp.rename(tmp, dir);
      } catch (e) {
        await fsp.rm(tmp, { recursive: true, force: true });
        if (!fs.existsSync(dir)) throw e;
      }
    }
    const now = new Date();
    await fsp.utimes(dir, now, now).catch(() => undefined);
    const versions = await Promise.all(
      (await fsp.readdir(base)).filter((n) => /^[0-9a-f]{16}$/.test(n)).map(async (n) => ({ n, at: (await fsp.stat(path.join(base, n))).mtimeMs })),
    );
    for (const old of versions.sort((a, b) => b.at - a.at).slice(KEEP_VERSIONS)) {
      if (old.n !== hash) await fsp.rm(path.join(base, old.n), { recursive: true, force: true });
    }
    return dir;
  }
}

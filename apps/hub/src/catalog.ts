// The catalog of plugins (docs/plugins.md, P10). GashoPlugins' Actions build each plugin whose version has no release
// yet into <id>-<version>.tgz (the files of its dist/) in the release <id>-v<version>, and list the newest version of
// every plugin in catalog.json, in the release "catalog". The Gasho server reads that list with gh, logged in on its
// machine (it keeps no token), and when a browser adds or updates a plugin, it fetches the plugin's file, checks it
// against the list, and unpacks it into the plugins folder, where the registry (plugins.ts) picks it up like any other
// change.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CatalogPlugin, PluginCatalog, PluginManifest } from "@gasho/protocol";
import { ID_RE, MAX_BYTES, MAX_FILES, readPluginFolder, swapPluginFolder, VERSION_RE } from "./plugins.ts";
import { readTgz } from "./tar.ts";

export const DEFAULT_PLUGIN_REPO = "4rtoflow/GashoPlugins";
/** The release that holds catalog.json. */
const CATALOG_RELEASE = "catalog";
/** A browser's ask reads the catalog again when it was read longer ago than this; it is read every READ_EVERY_MS anyway. */
export const CATALOG_MAX_AGE_MS = 10 * 60_000;
/** After a reading failed, a browser's ask tries again once this long has passed. */
const RETRY_AFTER_MS = 60_000;
const READ_EVERY_MS = 6 * 3600_000;
const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_MAX_BYTES = 1024 * 1024;
/** Fetching a plugin's file gives up after this long. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A plugin's file, at most (unpacked, it may hold MAX_BYTES). */
const MAX_DOWNLOAD_BYTES = MAX_BYTES + 1024 * 1024;
const MAX_PLUGINS = 500;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Runs gh with these arguments; rejects (an execFile error, with its stderr) when it does not end well. */
export type GhRun = (args: string[], opts: { timeoutMs: number }) => Promise<void>;

/** gh on the Gasho server's machine (GASHO_GH_BIN), never asking anything. */
export function ghRunner(bin = "gh"): GhRun {
  return (args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          reject(Object.assign(err, { stderr: String(stderr ?? "") }));
        },
      );
    });
}

/** What went wrong with gh, in words for the plugins screen. */
export function ghProblem(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  if (err?.code === "ENOENT") return "gh が見つかりません。Gasho サーバーのマシンに GitHub CLI を入れて、ログインしてください（GASHO_GH_BIN）。";
  if (err?.killed) return "gh が時間内に終わりませんでした。";
  const said = (err?.stderr ?? "").trim() || (err instanceof Error ? err.message : String(e));
  if (/release not found/i.test(said)) return "リリースが見つかりません。";
  if (/no assets? (to download|match)/i.test(said)) return "リリースにファイルがありません。";
  if (/gh auth login|not logged in|authentication/i.test(said)) return "Gasho サーバーのマシンの gh が GitHub にログインしていません（gh auth login）。";
  return said.split("\n").filter(Boolean).pop()?.slice(0, 300) ?? "gh が失敗しました。";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One plugin of catalog.json, or why it is left out. */
function catalogEntry(p: unknown): CatalogPlugin | string {
  if (!isRecord(p)) return "an entry that is not an object";
  const { id, name, version, description, api, permissions, daemon, release, file, sha256, size } = p;
  if (typeof id !== "string" || !ID_RE.test(id)) return `a bad id (${String(id).slice(0, 40)})`;
  if (typeof name !== "string" || !name.trim() || name.length > 40) return `${id}: a bad name`;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return `${id}: a bad version`;
  if (typeof api !== "string" || !/^\d+\.\d+$/.test(api)) return `${id}: a bad api`;
  // The file is always where GashoPlugins' Actions put it, so that nothing else is handed to gh.
  if (release !== `${id}-v${version}` || file !== `${id}-${version}.tgz`) return `${id}: a release or file not named after its version`;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return `${id}: a bad sha256`;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_DOWNLOAD_BYTES) return `${id}: a bad size`;
  const entry: CatalogPlugin = { id, name: name.trim(), version, api, daemon: daemon === true, release, file, sha256, size };
  if (typeof description === "string" && description.trim()) entry.description = description.trim().slice(0, 300);
  if (Array.isArray(permissions)) {
    const named = permissions.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40);
    if (named.length > 0) entry.permissions = [...new Set(named)] as CatalogPlugin["permissions"];
  }
  return entry;
}

/** Reads catalog.json: its plugins (sorted by id; entries that are not right are left out and named in `skipped`). */
export function parseCatalog(raw: unknown): { plugins: CatalogPlugin[]; updatedAt?: string; skipped: string[] } | { error: string } {
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) return { error: "catalog.json の形が正しくありません。" };
  const plugins: CatalogPlugin[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const p of raw.plugins.slice(0, MAX_PLUGINS)) {
    const entry = catalogEntry(p);
    if (typeof entry === "string") skipped.push(entry);
    else if (!seen.has(entry.id)) {
      seen.add(entry.id);
      plugins.push(entry);
    }
  }
  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt.slice(0, 40) : undefined;
  return { plugins, ...(updatedAt ? { updatedAt } : {}), skipped };
}

/** Fetches one file of a release, to memory. */
async function download(gh: GhRun, repo: string, release: string, file: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  // Into a file: gh may change what it writes to standard output (escape sequences).
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gasho-catalog-"));
  try {
    const out = path.join(dir, "download");
    await gh(["release", "download", release, "--repo", repo, "--pattern", file, "--output", out], { timeoutMs });
    const st = await fsp.stat(out).catch(() => undefined);
    if (!st?.isFile()) throw new Error(`リリース ${release} に ${file} がありません。`);
    if (st.size > maxBytes) throw new Error(`${file} が大きすぎます。`);
    return await fsp.readFile(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface PluginCatalogOptions {
  /** The repository of the plugins (GASHO_PLUGIN_REPO, "owner/name"). */
  repo: string;
  gh: GhRun;
  log?: (s: string) => void;
  now?: () => number;
}

/** The catalog as last read. Emits "change" whenever it is read again, starts being read, or fails to be. */
export class PluginCatalogSource extends EventEmitter {
  readonly repo: string;
  private gh: GhRun;
  private log: (s: string) => void;
  private now: () => number;
  private state: PluginCatalog;
  private reading: Promise<void> | undefined;
  /** When it was last tried, read or not. */
  private triedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: PluginCatalogOptions) {
    super();
    this.repo = opts.repo;
    this.gh = opts.gh;
    this.log = opts.log ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.state = REPO_RE.test(opts.repo)
      ? { repo: opts.repo, plugins: [] }
      : { repo: opts.repo, plugins: [], error: `GASHO_PLUGIN_REPO（${opts.repo}）は owner/name の形で書いてください。` };
  }

  /** The catalog now (replaced, never changed, when it changes). */
  get(): PluginCatalog {
    return this.state;
  }

  find(id: string): CatalogPlugin | undefined {
    return this.state.plugins.find((p) => p.id === id);
  }

  /** Reads it now, and every 6 hours. */
  start(): void {
    void this.read(0);
    this.timer = setInterval(() => void this.read(0), READ_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Reads the catalog again, unless it was read less than `maxAgeMs` ago (or, when that failed, tried less than a
   * minute ago); joins a reading under way.
   */
  read(maxAgeMs = CATALOG_MAX_AGE_MS): Promise<void> {
    if (this.reading) return this.reading;
    if (!REPO_RE.test(this.repo)) return Promise.resolve();
    const wait = this.state.error ? Math.min(maxAgeMs, RETRY_AFTER_MS) : maxAgeMs;
    if (wait > 0 && this.now() - this.triedAt < wait) return Promise.resolve();
    this.triedAt = this.now();
    this.set({ ...this.state, loading: true });
    this.reading = (async () => {
      let next: PluginCatalog;
      try {
        const data = await download(this.gh, this.repo, CATALOG_RELEASE, "catalog.json", CATALOG_TIMEOUT_MS, CATALOG_MAX_BYTES);
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString("utf8"));
        } catch {
          throw new Error("catalog.json を JSON として読めません。");
        }
        const parsed = parseCatalog(raw);
        if ("error" in parsed) throw new Error(parsed.error);
        if (parsed.skipped.length > 0) this.log(`plugin catalog of ${this.repo}: left out ${parsed.skipped.join("; ")}`);
        next = { repo: this.repo, checkedAt: this.now(), ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}), plugins: parsed.plugins };
      } catch (e) {
        const said = ghProblem(e);
        const error = said === "リリースが見つかりません。" ? `${this.repo} にカタログ（リリース catalog）がまだありません。` : said;
        this.log(`cannot read the plugin catalog of ${this.repo}: ${error}`);
        // The catalog read before stays, with the reason.
        const { loading: _loading, error: _error, ...before } = this.state;
        next = { ...before, error };
      }
      this.set(next);
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** The file of a plugin in the catalog, checked against it (its size and SHA-256). */
  async fetch(entry: CatalogPlugin): Promise<Buffer> {
    let data: Buffer;
    try {
      data = await download(this.gh, this.repo, entry.release, entry.file, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES);
    } catch (e) {
      const said = ghProblem(e);
      throw new Error(said === "リリースが見つかりません。" ? `リリース ${entry.release} が見つかりません。カタログを読み直してください。` : said);
    }
    if (data.length !== entry.size || sha256(data) !== entry.sha256) throw new Error(`${entry.file} がカタログと合いません（大きさか SHA-256 が違います）。`);
    return data;
  }

  private set(next: PluginCatalog): void {
    this.state = next;
    this.emit("change");
  }
}

/**
 * Puts a plugin's release file in place of the plugin in the plugins folder, after checking it: it unpacks safely
 * (tar.ts), and what it holds is the catalog's version of that plugin and passes the registry's checks. Until it is
 * swapped in, the version before stays (swapPluginFolder). Gives the manifest of what it put in place.
 */
export async function installRelease(pluginsDir: string, entry: CatalogPlugin, tgz: Buffer): Promise<PluginManifest> {
  const { files, dirs } = readTgz(tgz, { maxBytes: MAX_BYTES, maxFiles: MAX_FILES });
  await fsp.mkdir(pluginsDir, { recursive: true });
  // Made inside the plugins folder (on the same disk, for the swap); the registry leaves out names starting with ".".
  const made = path.join(pluginsDir, `.${entry.id}-new-${randomBytes(4).toString("hex")}`);
  try {
    await fsp.mkdir(made);
    for (const d of dirs) await fsp.mkdir(path.join(made, d), { recursive: true });
    for (const f of files) {
      const to = path.join(made, f.path);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.writeFile(to, f.data, { mode: 0o644 });
    }
    const read = await readPluginFolder(made, undefined);
    if ("error" in read) throw new Error(read.error);
    if (read.manifest.id !== entry.id) throw new Error(`中身の id（${read.manifest.id}）がカタログ（${entry.id}）と違います。`);
    if (read.manifest.version !== entry.version) throw new Error(`中身の版（${read.manifest.version}）がカタログ（${entry.version}）と違います。`);
    await swapPluginFolder(pluginsDir, entry.id, made);
    return read.manifest;
  } catch (e) {
    await fsp.rm(made, { recursive: true, force: true });
    throw e;
  }
}

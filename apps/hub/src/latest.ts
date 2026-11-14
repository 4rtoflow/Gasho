// The latest published versions, looked up on the package registry with npm (`npm view`, which reads the registry and
// its token from the user's .npmrc, as `npx @4rtoflow/gasho-daemon` does). Browsers show them beside what each working
// server runs, and offer the update (daemon.update).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LatestVersions } from "@gasho/protocol";

/** The package gasho-daemon is published as (apps/daemon/src/install.ts). */
export const DAEMON_PACKAGE = "@4rtoflow/gasho-daemon";
/** How often the versions are looked up (the release workflow runs every 15 minutes). */
export const LATEST_INTERVAL_MS = 30 * 60_000;
/** A browser's "check now" does not look them up again sooner than this after the last time. */
const MIN_RECHECK_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 60_000;
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** npm: GASHO_NPM_BIN, or the npm beside the Node.js that runs the Gasho server, or the one on PATH. */
export function npmBin(env: NodeJS.ProcessEnv = process.env, node = process.execPath): string {
  if (env.GASHO_NPM_BIN) return env.GASHO_NPM_BIN;
  const beside = path.join(path.dirname(node), "npm");
  return fs.existsSync(beside) ? beside : "npm";
}

/** `npm view <name> version`: the version the `latest` tag points at. */
export function npmLatest(npm: string, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // --prefer-online: not the list of versions npm read earlier and kept.
    execFile(npm, ["view", name, "version", "--json", "--prefer-online"], { timeout: LOOKUP_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const said = `${stderr}`.trim().split("\n").slice(-3).join("\n");
        return reject(new Error(said || err.message));
      }
      let version: unknown;
      try {
        version = JSON.parse(stdout);
      } catch {
        version = stdout.trim();
      }
      if (typeof version === "string" && VERSION_RE.test(version)) resolve(version);
      else reject(new Error(`npm view ${name} がわからない答えを返しました：${stdout.trim().slice(0, 100)}`));
    });
  });
}

export class LatestCheck {
  private state: LatestVersions = {};
  private listeners = new Set<(l: LatestVersions) => void>();
  private timer: NodeJS.Timeout | undefined;
  private lookup: (name: string) => Promise<string>;
  private intervalMs: number;

  constructor(o: { lookup: (name: string) => Promise<string>; intervalMs?: number }) {
    this.lookup = o.lookup;
    this.intervalMs = o.intervalMs ?? LATEST_INTERVAL_MS;
  }

  latest(): LatestVersions {
    return this.state;
  }

  subscribe(l: (latest: LatestVersions) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Looks the versions up now and every interval after. */
  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Looks the versions up, unless a look-up is under way (or, when a browser asked, one was just done). */
  async check(asked = false): Promise<void> {
    if (this.state.checking) return;
    if (asked && this.state.checkedAt !== undefined && Date.now() - this.state.checkedAt < MIN_RECHECK_MS) {
      // Nothing new to say; the browser that asked still gets an answer.
      return this.emit();
    }
    this.state = { ...this.state, checking: true };
    this.emit();
    try {
      const daemon = await this.lookup(DAEMON_PACKAGE);
      this.state = { daemon, checkedAt: Date.now() };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.state = { ...this.state, checking: undefined, checkedAt: Date.now(), error: `最新の版を調べられませんでした：${error}` };
    }
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}

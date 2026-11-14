// The GitHub CLI (`gh`) of the working server, which uses the login of whoever runs gasho-daemon. The plugins' daemon
// parts ask gasho-daemon to run it (ctx.github, docs/plugins.md) rather than run it themselves, so that what several
// plugins and browsers ask again is answered from what gh said before: GitHub's API allows only so much an hour (GraphQL
// 5000 points). The issues and pull requests themselves are read by the GitHub plugin (GashoPlugins/github).
import { exec, type ExecResult } from "./exec.ts";
import type { GitHubAsk } from "./plugin-ipc.ts";

/** Why a `gh` call failed, for the person looking at the screen. */
export function ghError(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown; killed?: unknown };
  if (err.code === "ENOENT") {
    return "この working server に GitHub CLI（gh）がありません。gh を入れて、gh auth login でログインしてください。";
  }
  if (err.killed === true) return "GitHub からの応答が遅く、読み込めませんでした。";
  const text = [err.stderr, err.message].filter((t): t is string => typeof t === "string").join("\n");
  if (/gh auth login|not logged in|authentication/i.test(text)) {
    return "この working server の GitHub CLI（gh）がログインしていません。working server で gh auth login を実行してください。";
  }
  if (/Could not resolve to an? (issue|pull ?request)/i.test(text)) return "この番号の Issue や Pull request は見つかりません。";
  if (/Could not resolve to a Repository|HTTP 404|not found/i.test(text)) {
    return "GitHub でこのリポジトリを読めませんでした。gh でログインしているアカウントに権限がないか、リポジトリがありません。";
  }
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("Command failed"));
  return `GitHub から読み込めませんでした：${(first ?? "原因が分かりません").slice(0, 200)}`;
}

/** How old a stored answer may be when the asker does not say (seconds), and at most. */
const MAX_AGE_SECONDS = 30;
const MAX_AGE_LIMIT_SECONDS = 600;
const TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_BUFFER_LIMIT = 32 * 1024 * 1024;
/** Answers kept, at most (the oldest go first). */
const MAX_STORED = 500;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
/** The tag of answers whose repository is not known: any write drops them. */
const ANY = "";

const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback);

/** "owner/name" in lower case, from owner/name, HOST/owner/name or a URL of the repository; undefined otherwise. */
export function repoKey(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const parts = s
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
}

/** The repository gh's arguments name: --repo / -R, or the path of `gh api repos/<owner>/<name>/…`. */
export function repoOfArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--repo" || a === "-R") return repoKey(args[i + 1]);
    if (a.startsWith("--repo=")) return repoKey(a.slice("--repo=".length));
    if (a.startsWith("-R") && a.length > 2) return repoKey(a.slice(2));
  }
  if (args[0] === "api") {
    for (const a of args.slice(1)) {
      const m = /^\/?repos\/([^/?#]+)\/([^/?#]+)/.exec(a);
      if (m) return repoKey(`${m[1]}/${m[2]}`);
    }
  }
  return undefined;
}

export interface GitHubProxyOptions {
  ghBin: string;
  /** Runs gh (tests replace it). */
  run?: (args: string[], o: { timeoutMs: number; maxBuffer: number }) => Promise<ExecResult>;
  now?: () => number;
}

/**
 * Runs gh for the plugins' daemon parts. A read is answered from what gh said for the same arguments if that is new
 * enough, and reads asked while the same one runs wait for it, so gh runs once. A write runs gh, then drops what is kept
 * of its repository (and the answers whose repository is not known): the next read of them runs gh again.
 */
export class GitHubProxy {
  private ghBin: string;
  private runGh: NonNullable<GitHubProxyOptions["run"]>;
  private now: () => number;
  private stored = new Map<string, { tag: string; at: number; answer: ExecResult; bytes: number }>();
  private storedBytes = 0;
  private running = new Map<string, { tag: string; answer: Promise<ExecResult> }>();
  /** Counts the writes per tag: a read that ran across a write of its repository is not kept. */
  private writes = new Map<string, number>();

  constructor(opts: GitHubProxyOptions) {
    this.ghBin = opts.ghBin;
    this.runGh = opts.run ?? ((args, o) => exec(this.ghBin, args, o));
    this.now = opts.now ?? Date.now;
  }

  read(ask: GitHubAsk): Promise<ExecResult> {
    const key = JSON.stringify(ask.args);
    const tag = repoKey(ask.repo) ?? repoOfArgs(ask.args) ?? ANY;
    const maxAge = clamp(ask.maxAgeSeconds, 0, MAX_AGE_LIMIT_SECONDS, MAX_AGE_SECONDS) * 1000;
    const hit = this.stored.get(key);
    if (hit && this.now() - hit.at < maxAge) return Promise.resolve(hit.answer);
    const running = this.running.get(key);
    if (running) return running.answer;
    const writes = this.writes.get(tag) ?? 0;
    const answer = this.run(ask).then((a) => {
      if ((this.writes.get(tag) ?? 0) === writes) this.keep(key, tag, a);
      return a;
    });
    this.running.set(key, { tag, answer });
    const done = () => {
      if (this.running.get(key)?.answer === answer) this.running.delete(key);
    };
    answer.then(done, done);
    return answer;
  }

  async write(ask: GitHubAsk): Promise<ExecResult> {
    const repo = repoKey(ask.repo);
    if (!repo) throw new Error("ctx.github.write: give the repository it changes as repo (owner/name)");
    try {
      return await this.run(ask);
    } finally {
      // Also when gh failed: it may have changed part of what it was asked to.
      this.forget(repo);
    }
  }

  private run(ask: GitHubAsk): Promise<ExecResult> {
    return this.runGh(ask.args, {
      timeoutMs: clamp(ask.timeoutMs, 1000, MAX_TIMEOUT_MS, TIMEOUT_MS),
      maxBuffer: clamp(ask.maxBuffer, 1024, MAX_BUFFER_LIMIT, MAX_BUFFER),
    });
  }

  private keep(key: string, tag: string, answer: ExecResult): void {
    this.drop(key);
    const bytes = answer.stdout.length + answer.stderr.length;
    this.stored.set(key, { tag, at: this.now(), answer, bytes });
    this.storedBytes += bytes;
    const old = this.now() - MAX_AGE_LIMIT_SECONDS * 1000;
    for (const [k, v] of this.stored) {
      if (v.at >= old && this.stored.size <= MAX_STORED && this.storedBytes <= MAX_STORED_BYTES) break;
      this.drop(k);
    }
  }

  private drop(key: string): void {
    const v = this.stored.get(key);
    if (!v) return;
    this.stored.delete(key);
    this.storedBytes -= v.bytes;
  }

  private forget(repo: string): void {
    const tags = new Set([repo, ANY]);
    for (const [k, v] of this.stored) if (tags.has(v.tag)) this.drop(k);
    for (const [k, v] of this.running) if (tags.has(v.tag)) this.running.delete(k);
    for (const t of tags) this.writes.set(t, (this.writes.get(t) ?? 0) + 1);
  }
}

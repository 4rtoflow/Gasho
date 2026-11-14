// The plugin SDK for the daemon part of a Gasho plugin (daemon.js). gasho-daemon runs the daemon part in a process of
// its own (plugin-host of gasho-daemon), imports it, and calls its methods for the web part (useRequest, useCall).
// See docs/plugins.md of Gasho.
import type { GitHubRepo } from "@gasho/protocol";

export type { GitHubRepo } from "@gasho/protocol";

/** A folder of the session a call is about: the session's own, or a repository gasho-daemon found inside it. */
export interface SessionFolder {
  /** An absolute path on the working server. */
  dir: string;
  github?: GitHubRepo;
  branch?: string;
}

/** The session a call is about (only one gasho-daemon tracks). */
export interface DaemonSession {
  sessionId: string;
  /** The session's folder (an absolute path). */
  cwd: string;
  name?: string;
  /** Started from Gasho. */
  managed: boolean;
  github?: GitHubRepo;
  gitBranch?: string;
  /** Repositories inside the folder, when the folder is not itself in one. */
  repos: { path: string; dir: string; github?: GitHubRepo; branch?: string }[];
  /**
   * The session's folder (no `path`), or the repository inside it at `path` (as SessionRepo.path). Throws a
   * PluginError for a path gasho-daemon did not find, so that a path from a browser never reaches outside.
   */
  repo(path?: string): SessionFolder;
}

export interface ExecOptions {
  cwd?: string;
  /** Stopped after this long (its process group gets SIGTERM); 30 s by default. */
  timeoutMs?: number;
  /** Output kept per stream, in bytes; 8 MB by default. More fails the command. */
  maxBuffer?: number;
  /** Added to the environment. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * What exec throws when the command could not run or failed: as Node.js's execFile does, with `code` (the exit code,
 * or "ENOENT" when the command is not there), `killed` (stopped for taking too long), `stdout` and `stderr`.
 */
export interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
  stdout: string;
  stderr: string;
}

export interface GitHubReadOptions {
  /**
   * How old an answer gasho-daemon kept for the same arguments may be, in seconds: 30 by default, at most 600. With 0,
   * gh runs again (still once for those asking the same, with the same timeoutMs and maxBuffer, at the same time).
   */
  maxAgeSeconds?: number;
  /**
   * The repository the answer is about (owner/name), when the arguments do not name it with --repo (-R) or as the path
   * of `gh api repos/<owner>/<name>/…`. A write to the repository drops the answer; one whose repository is not known
   * is dropped by any write.
   */
  repo?: string;
  /** Stopped after this long; 30 s by default, at most 120 s. */
  timeoutMs?: number;
  /** Output kept per stream, in bytes; 8 MB by default, at most 32 MB. More fails the command. */
  maxBuffer?: number;
}

export interface GitHubWriteOptions {
  /** The repository it changes (owner/name): what gasho-daemon kept of it is dropped, so the next read runs gh. */
  repo: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * The GitHub CLI (gh) of the working server, run by gasho-daemon for every plugin (plugin API 1.3). Give the arguments
 * of gh, without "gh"; there is no folder or environment of the plugin's own, so name the repository with --repo. It
 * answers and fails as exec does.
 */
export interface DaemonGitHub {
  /** Reads: answered from what gh said for the same arguments when that is new enough. */
  read(args: string[], options?: GitHubReadOptions): Promise<ExecResult>;
  /**
   * Changes GitHub (assign, comment, …). Only in a method whose kind is "write" (gasho-plugin.json), so that the
   * operations log has it; elsewhere it fails with a PluginError.
   */
  write(args: string[], options: GitHubWriteOptions): Promise<ExecResult>;
}

/** What a method gets besides its params. */
export interface DaemonContext {
  machine: { id: string; name: string };
  /** The session the call is about, when it names one gasho-daemon tracks. */
  session?: DaemonSession;
  /** The values of the settings with scope "server". */
  settings: Record<string, unknown>;
  /**
   * The folders Gasho offers to start sessions in on this working server: those Claude Code trusts, and their parents
   * (as the screen's MachineInfo.folders). Plugin API 1.1.
   */
  folders(): string[];
  /**
   * A folder of this plugin's own on this working server, for what it keeps between calls (kept when the plugin is
   * updated, removed or added again). Plugin API 1.1.
   */
  dataDir: string;
  /** Aborted when the call takes too long, or the process is being stopped. */
  signal: AbortSignal;
  /**
   * Runs a command without a shell and without a terminal. GH_PROMPT_DISABLED=1 and GIT_TERMINAL_PROMPT=0 are set, so
   * that gh and git fail rather than wait for input.
   */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  /** gh, run by gasho-daemon: use this rather than exec("gh", …) (plugin API 1.3). */
  github: DaemonGitHub;
  /** Writes to gasho-daemon's log, with the plugin's id. */
  log(...args: unknown[]): void;
}

/** What start gets: the context without a session or a call. */
export type DaemonStartContext = Omit<DaemonContext, "session" | "signal">;

export type DaemonMethod = (params: unknown, ctx: DaemonContext) => unknown;

/** What the daemon part of a plugin does (its daemon.js exports it as default). */
export interface DaemonPluginDefinition {
  /** The methods the web part can call; gasho-plugin.json `methods` lists them. Results are JSON. */
  methods: Record<string, DaemonMethod>;
  /** Called when the process starts, for work that goes on without calls (watching files, timers). */
  start?(ctx: DaemonStartContext): void | Promise<void>;
  /** Called before the process is stopped (disabled, removed, replaced by a new version, gasho-daemon stopping). */
  stop?(): void | Promise<void>;
}

/** Returns `def`; for TypeScript. */
export function defineDaemonPlugin(def: DaemonPluginDefinition): DaemonPluginDefinition {
  return def;
}

/** An error whose message is shown to the person as it is. Any other error shows as "処理に失敗しました". */
export class PluginError extends Error {
  /** How gasho-daemon tells it apart (the class is the plugin's own copy, bundled into its daemon.js). */
  readonly gashoPluginError = true;

  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

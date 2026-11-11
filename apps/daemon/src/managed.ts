// Sessions that Gasho starts itself: `claude --remote-control` running in its own zellij session.
// Gasho can type into these (paste + Enter) and interrupt them (Esc); the official apps can still use them.
// Rules from the verification (docs/research.md): send input only while the session is idle, and never while
// a permission dialog is open, because Enter would answer the dialog.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The pane that `zellij attach --create-background … -- <command>` creates. */
export const PANE = "terminal_0";
export const TRUST_PROMPT_RE = /trust this folder|Quick safety check/i;
export const PERMISSION_PROMPT_RE = /Do you want to proceed\?/;

export interface ManagedSession {
  sessionId: string;
  zellijSession: string;
  pid: number;
  cwd: string;
  name: string;
  launchedAt: number;
}

/**
 * Environment for zellij and the Claude Code it starts. Nothing else is inherited: the daemon may itself run
 * inside Claude Code or zellij (CLAUDECODE, ZELLIJ_SESSION_NAME, …), which would confuse both.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" };
  for (const k of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

export function zellijSessionName(label: string, suffix = randomBytes(2).toString("hex")): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `gasho-${slug || "session"}-${suffix}`;
}

/**
 * Arguments for `zellij` that start Claude Code with Remote Control in `cwd` inside a new background session.
 * The shell writes its PID and then execs, so the PID file ends up holding Claude Code's PID.
 */
export function launchArgs(o: {
  zellijSession: string;
  pidFile: string;
  cwd: string;
  claudeBin: string;
  rcName: string;
  env: Record<string, string>;
}): string[] {
  const script = 'echo $$ > "$1" && cd "$2" && shift 2 && exec "$@"';
  const envPairs = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
  return [
    "attach",
    "--create-background",
    o.zellijSession,
    "--",
    "/bin/sh",
    "-c",
    script,
    "gasho-launch",
    o.pidFile,
    o.cwd,
    "env",
    "-i",
    ...envPairs,
    o.claudeBin,
    "--remote-control",
    o.rcName,
  ];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Thin wrapper over the zellij CLI. Every call names the session explicitly. */
export class Zellij {
  private env: Record<string, string>;

  constructor(env: Record<string, string>) {
    this.env = env;
  }

  async run(args: string[]): Promise<string> {
    const { stdout } = await execFileP("zellij", args, { env: this.env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  async available(): Promise<boolean> {
    try {
      await this.run(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Names of sessions that are running (not the resurrectable, exited ones). */
  async liveSessions(): Promise<Set<string>> {
    const out = await this.run(["list-sessions", "--no-formatting"]).catch(() => "");
    const names = new Set<string>();
    for (const line of out.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (name && !line.includes("EXITED")) names.add(name);
    }
    return names;
  }

  screen(session: string): Promise<string> {
    return this.run(["--session", session, "action", "dump-screen", "-p", PANE]);
  }

  async paste(session: string, text: string): Promise<void> {
    await this.run(["--session", session, "action", "paste", "-p", PANE, text]);
  }

  async keys(session: string, ...keys: string[]): Promise<void> {
    await this.run(["--session", session, "action", "send-keys", "-p", PANE, ...keys]);
  }

  async kill(session: string): Promise<void> {
    await this.run(["kill-session", session]).catch(() => "");
    await this.run(["delete-session", session]).catch(() => "");
  }
}

/** The sessions Gasho started and the input waiting for each, persisted so a daemon restart keeps them. */
export class ManagedSessions {
  private file: string;
  private sessions = new Map<string, ManagedSession>();
  private queues = new Map<string, string[]>();

  constructor(file: string) {
    this.file = file;
  }

  async load(keep: (m: ManagedSession) => Promise<boolean>): Promise<void> {
    let list: ManagedSession[] = [];
    try {
      list = JSON.parse(await fs.readFile(this.file, "utf8")) as ManagedSession[];
    } catch {
      return;
    }
    for (const m of list) if (await keep(m)) this.sessions.set(m.sessionId, m);
    await this.save();
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, `${JSON.stringify([...this.sessions.values()], null, 2)}\n`, { mode: 0o600 });
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  add(m: ManagedSession): void {
    this.sessions.set(m.sessionId, m);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.queues.delete(sessionId);
  }

  enqueue(sessionId: string, text: string): number {
    const q = this.queues.get(sessionId) ?? [];
    q.push(text);
    this.queues.set(sessionId, q);
    return q.length;
  }

  next(sessionId: string): string | undefined {
    return this.queues.get(sessionId)?.shift();
  }

  /** Puts a message back at the front, e.g. when sending it failed. */
  unshift(sessionId: string, text: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.unshift(text);
    this.queues.set(sessionId, q);
  }

  pending(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}

/** Folders Claude Code already trusts (from ~/.claude.json, an internal file) plus the given ones, if they exist. */
export async function launchableFolders(homeDir: string, extra: string[]): Promise<string[]> {
  const candidates = new Set(extra);
  try {
    const data = JSON.parse(await fs.readFile(path.join(homeDir, ".claude.json"), "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    for (const [dir, p] of Object.entries(data.projects ?? {})) if (p?.hasTrustDialogAccepted === true) candidates.add(dir);
  } catch {
    // unreadable: offer only the folders of running sessions
  }
  const under = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
  const tmp = os.tmpdir();
  const out: string[] = [];
  for (const dir of candidates) {
    // Skip the home folder itself and scratch folders, which are not projects.
    if (dir === homeDir || (under(dir, tmp) && !under(dir, homeDir))) continue;
    try {
      if ((await fs.stat(dir)).isDirectory()) out.push(dir);
    } catch {
      // gone
    }
  }
  return out.sort();
}

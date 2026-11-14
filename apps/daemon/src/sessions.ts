// Finds Claude Code sessions on this machine.
// `claude agents --json` is the supported interface; ~/.claude/sessions/<pid>.json is internal
// and only read for the Remote Control session id and for the state it records ("shell", which the list does not
// tell from "busy"; see sessionStatus). Without it, the list's state is used.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BackgroundTask, RcMode, SessionStatus } from "@gasho/protocol";
import { str } from "./util.ts";

const execFileP = promisify(execFile);

export interface AgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  startedAt?: number;
  sessionId?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  state?: string;
}

export async function listAgents(claudeBin: string): Promise<AgentRow[]> {
  const { stdout } = await execFileP(claudeBin, ["agents", "--json"], {
    cwd: os.tmpdir(),
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const data: unknown = JSON.parse(stdout);
  return Array.isArray(data) ? (data as AgentRow[]) : [];
}

export function mapStatus(row: AgentRow): SessionStatus {
  switch (row.status) {
    case "busy":
    case "waiting":
    case "idle":
      return row.status;
  }
  // Background sessions report `state` instead.
  switch (row.state) {
    case "working":
      return "busy";
    case "blocked":
      return "waiting";
    case "done":
    case "failed":
    case "stopped":
      return "idle";
  }
  return "unknown";
}

export interface RegistryInfo {
  bridgeSessionId?: string;
  entrypoint?: string;
  /**
   * The session's state as Claude Code writes it here: "busy", "waiting", "idle", or "shell" (Claude's turn has ended
   * and only shells and monitors run on in the background), which `claude agents` reports as "busy".
   */
  status?: string;
  /** When Claude Code wrote that state (ms). */
  statusAt?: number;
}

export async function readRegistry(claudeDir: string, pid: number): Promise<RegistryInfo | undefined> {
  try {
    const raw = await fs.readFile(path.join(claudeDir, "sessions", `${pid}.json`), "utf8");
    const d = JSON.parse(raw) as Record<string, unknown>;
    const statusAt = typeof d.statusUpdatedAt === "number" ? d.statusUpdatedAt : undefined;
    return { bridgeSessionId: str(d.bridgeSessionId), entrypoint: str(d.entrypoint), status: str(d.status), ...(statusAt ? { statusAt } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Gasho's state of a session: Claude Code's, except that a session whose turn has ended while only shells and
 * monitors run on in the background is idle. Claude Code's list calls it busy, but Claude waits for the person then:
 * input goes in as it would in the terminal, and Esc would stop nothing (the shells are stopped from the list of
 * background tasks). A session whose subagents or workflows run on stays busy: Claude goes on once they report.
 */
export function sessionStatus(row: AgentRow, registry: RegistryInfo | undefined): SessionStatus {
  const status = mapStatus(row);
  return status === "busy" && registry?.status === "shell" ? "idle" : status;
}

/** Claude Code's own state of a session (see RegistryInfo.status), and when it was written, when known. */
export interface ClaudeState {
  status?: string;
  at?: number;
}

/**
 * Whether background work that a session's transcript started and has not seen end may still run, as far as Claude
 * Code's own state says: "idle" means that nothing runs in the background, "shell" that only shells and monitors do.
 * That state says nothing of work started after Claude Code wrote it. Work started before the session's Claude Code
 * (a conversation resumed or forked) ended with the Claude Code that ran it. Claude Code does not always record the
 * end of a subagent (not when Ctrl+X Ctrl+K stops it), so this is what tells it has ended.
 */
export function mayRun(task: BackgroundTask, claude: ClaudeState, startedAt: number | undefined): boolean {
  if (startedAt !== undefined && task.startedAt !== undefined && task.startedAt < startedAt) return false;
  if (claude.at !== undefined && task.startedAt !== undefined && task.startedAt > claude.at) return true;
  if (claude.status === "idle") return false;
  return claude.status !== "shell" || task.kind === "shell" || task.kind === "monitor";
}

/** The background work that may still run (see mayRun), in the order it started. */
export function runningTasks(tasks: BackgroundTask[], claude: ClaudeState, startedAt: number | undefined): BackgroundTask[] {
  return tasks.filter((x) => mayRun(x, claude, startedAt));
}

export function rcModeOf(reg: RegistryInfo | undefined): RcMode {
  if (!reg?.bridgeSessionId) return "none";
  // Children of `claude remote-control` run as SDK processes; interactive sessions run as `cli`.
  return reg.entrypoint === "sdk-cli" ? "server" : "interactive";
}

export async function findTranscript(claudeDir: string, sessionId: string): Promise<string | undefined> {
  const projects = path.join(claudeDir, "projects");
  let dirs: import("node:fs").Dirent[];
  try {
    dirs = await fs.readdir(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(projects, d.name, `${sessionId}.jsonl`);
    try {
      await fs.access(file);
      return file;
    } catch {
      // not in this project directory
    }
  }
  return undefined;
}

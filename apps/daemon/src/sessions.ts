// Finds Claude Code sessions on this machine.
// `claude agents --json` is the supported interface; ~/.claude/sessions/<pid>.json is internal
// and only read for the Remote Control session id.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RcMode, SessionStatus } from "@gasho/protocol";
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
}

export async function readRegistry(claudeDir: string, pid: number): Promise<RegistryInfo | undefined> {
  try {
    const raw = await fs.readFile(path.join(claudeDir, "sessions", `${pid}.json`), "utf8");
    const d = JSON.parse(raw) as Record<string, unknown>;
    return { bridgeSessionId: str(d.bridgeSessionId), entrypoint: str(d.entrypoint) };
  } catch {
    return undefined;
  }
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

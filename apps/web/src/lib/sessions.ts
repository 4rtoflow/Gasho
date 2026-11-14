// Gasho shows only the sessions it started (from its own launcher); others running on a working server are not shown.
import type { GashoNotification, MachineInfo, SessionInfo } from "@gasho/protocol";
import { basename } from "./format.ts";

export function shownSessions(m: MachineInfo): SessionInfo[] {
  return m.sessions.filter((s) => s.managed);
}

/** When a session was last used: its latest activity, or for one with no conversation yet, when it started. */
const lastUsed = (s: SessionInfo): number => s.lastActivityAt ?? s.startedAt ?? 0;

/**
 * A worktree on a working server and the sessions Gasho shows in it: a row of the sidebar, and the tabs above a session.
 */
export interface WorktreeSessions {
  /** Unique among all working servers (see worktreeId). */
  id: string;
  machine: MachineInfo;
  /** The branch, or the folder's name when no branch is checked out or the folder is not in a repository. */
  label: string;
  /** The repository's name: its GitHub repository's, or its folder's. Absent outside a repository. */
  repo?: string;
  /** In the order they started, which is the order of the tabs. */
  sessions: SessionInfo[];
}

/**
 * The worktree a session is in. A session in a folder that is not in a repository, or one whose gasho-daemon is older
 * than 0.15.0 (it does not tell the worktree), is in a worktree of its own folder.
 */
export function worktreeId(machine: string, s: SessionInfo): string {
  return [machine, s.worktree?.path ?? s.cwd].join("\u001f");
}

/** The worktrees of the sessions Gasho shows, of all working servers (the sidebar's list): the one used last first. */
export function worktreesByLastUse(machines: MachineInfo[]): WorktreeSessions[] {
  const byId = new Map<string, WorktreeSessions>();
  for (const machine of machines) {
    for (const s of shownSessions(machine)) {
      const id = worktreeId(machine.id, s);
      const found = byId.get(id);
      if (found) {
        found.sessions.push(s);
        continue;
      }
      const w = s.worktree;
      const repo = s.github?.name ?? (w ? basename(w.repo).replace(/\.git$/, "") : undefined);
      byId.set(id, { id, machine, label: w?.branch ?? basename(w?.path ?? s.cwd), ...(repo ? { repo } : {}), sessions: [s] });
    }
  }
  const worktrees = [...byId.values()];
  for (const w of worktrees) w.sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
  const latest = (w: WorktreeSessions) => Math.max(...w.sessions.map(lastUsed));
  return worktrees.sort((a, b) => latest(b) - latest(a) || a.id.localeCompare(b.id));
}

/** The session each worktree had open last, by worktreeId, while this page is open. */
const lastOpened = new Map<string, string>();

export function rememberOpened(worktree: string, sessionId: string): void {
  lastOpened.set(worktree, sessionId);
}

/** The session to open for a worktree picked in the sidebar: the one it had open last, or else the one used last. */
export function sessionToOpen(w: WorktreeSessions): SessionInfo | undefined {
  const id = lastOpened.get(w.id);
  return w.sessions.find((s) => s.sessionId === id) ?? [...w.sessions].sort((a, b) => lastUsed(b) - lastUsed(a))[0];
}

/** Whether a working server's gasho-daemon is at least `major.minor` (older ones lack what came later). */
export function daemonAtLeast(m: MachineInfo, major: number, minor: number): boolean {
  const [a = 0, b = 0] = (m.daemonVersion ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return a > major || (a === major && b >= minor);
}

/** A notification is shown unless it is about a session known to have been started elsewhere. */
export function notificationShown(n: GashoNotification, machines: MachineInfo[]): boolean {
  const s = machines.find((m) => m.id === n.machine)?.sessions.find((x) => x.sessionId === n.sessionId);
  return !s || Boolean(s.managed);
}

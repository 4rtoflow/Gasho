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
  /** Its top folder: where "＋" starts a session and whose past conversations are listed. */
  path: string;
  /** Whether it is a git worktree, whose sessions may run in the folders inside `path` too. */
  subfolders: boolean;
  /** In the order they started, which is the order of the tabs. Empty for a worktree this browser remembers. */
  sessions: SessionInfo[];
}

/** A worktree this browser keeps in the sidebar once its sessions are gone, until it is taken off (see remembered-worktrees). */
export interface RememberedWorktree {
  machine: string;
  path: string;
  label: string;
  repo?: string;
  subfolders: boolean;
}

/**
 * The worktree a session is in. A session in a folder that is not in a repository, or one whose gasho-daemon is too old
 * to tell the worktree, is in a worktree of its own folder.
 */
export function worktreeId(machine: string, s: SessionInfo): string {
  return worktreeKey(machine, s.worktree?.path ?? s.cwd);
}

export function worktreeKey(machine: string, path: string): string {
  return [machine, path].join("\u001f");
}

/**
 * The worktrees of the sessions Gasho shows, of all working servers (the sidebar's list): the one used last first.
 * Then the `remembered` ones that have no session now, in the order given.
 */
export function worktreesByLastUse(machines: MachineInfo[], remembered: RememberedWorktree[] = []): WorktreeSessions[] {
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
      const path = w?.path ?? s.cwd;
      byId.set(id, { id, machine, label: w?.branch ?? basename(path), ...(repo ? { repo } : {}), path, subfolders: Boolean(w), sessions: [s] });
    }
  }
  const worktrees = [...byId.values()];
  for (const w of worktrees) w.sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
  const latest = (w: WorktreeSessions) => Math.max(...w.sessions.map(lastUsed));
  worktrees.sort((a, b) => latest(b) - latest(a) || a.id.localeCompare(b.id));
  for (const r of remembered) {
    const machine = machines.find((m) => m.id === r.machine);
    const id = worktreeKey(r.machine, r.path);
    if (!machine || byId.has(id)) continue;
    byId.set(id, { id, machine, label: r.label, ...(r.repo ? { repo: r.repo } : {}), path: r.path, subfolders: r.subfolders, sessions: [] });
    worktrees.push(byId.get(id)!);
  }
  return worktrees;
}

/** What the sidebar keeps of a worktree once its sessions are gone. */
export function rememberedOf(w: WorktreeSessions): RememberedWorktree {
  return { machine: w.machine.id, path: w.path, label: w.label, ...(w.repo ? { repo: w.repo } : {}), subfolders: w.subfolders };
}

/** The tab to open once the open session's tab is gone: the one after it, else the one before. */
export function tabAfterRemoval(w: WorktreeSessions, sessionId: string): SessionInfo | undefined {
  const i = w.sessions.findIndex((s) => s.sessionId === sessionId);
  if (i < 0) return undefined;
  return w.sessions[i + 1] ?? w.sessions[i - 1];
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

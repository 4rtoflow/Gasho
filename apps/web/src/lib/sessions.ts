// Gasho shows only the sessions it started (from its own launcher); others running on a working server are not shown.
import type { GashoNotification, MachineInfo, SessionInfo } from "@gasho/protocol";

export function shownSessions(m: MachineInfo): SessionInfo[] {
  return m.sessions.filter((s) => s.managed);
}

/** When a session was last used: its latest activity, or for one with no conversation yet, when it started. */
const lastUsed = (s: SessionInfo): number => s.lastActivityAt ?? s.startedAt ?? 0;

/**
 * The sessions Gasho shows, of all working servers, in one list (the sidebar's): the one used last first, whichever
 * working server it runs on.
 */
export function sessionsByLastUse(machines: MachineInfo[]): { machine: MachineInfo; session: SessionInfo }[] {
  return machines
    .flatMap((machine) => shownSessions(machine).map((session) => ({ machine, session })))
    .sort((a, b) => lastUsed(b.session) - lastUsed(a.session) || a.session.sessionId.localeCompare(b.session.sessionId));
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

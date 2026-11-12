// Gasho shows only the sessions it started (from its own launcher); others running on a working server are not shown.
import type { GashoNotification, MachineInfo, SessionInfo } from "@gasho/protocol";

export function shownSessions(m: MachineInfo): SessionInfo[] {
  return m.sessions.filter((s) => s.managed);
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

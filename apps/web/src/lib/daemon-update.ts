// Updating gasho-daemon from Gasho (daemon.update): what a working server's row says, and whether there is an update.
import type { DaemonUpdateStep, LatestVersions, MachineInfo } from "@gasho/protocol";

/** The command that makes gasho-daemon updatable from Gasho, for one too old to say whether it is. */
export const INSTALL_COMMAND = "npx @4rtoflow/gasho-daemon@latest service install";
/** How long a restart may take before the row suggests looking at the working server's log. */
export const RESTART_SLOW_MS = 2 * 60_000;

export const STEP_LABEL: Record<DaemonUpdateStep, string> = {
  install: "新しい版を取り込んでいます",
  check: "起動できるか確かめています",
  wait: "送るのを待っている入力を、送り終えるまで待っています",
  restart: "切り替えて、動かし直しています",
};

/** -1, 0 or 1 as `a` is older than, the same as, or newer than `b` (x.y.z; a missing part counts as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The version a working server's gasho-daemon can be updated to now, if any. */
export function updateTo(m: MachineInfo, latest: LatestVersions | undefined): string | undefined {
  const to = latest?.daemon;
  if (!to || !m.connected || !m.update?.canUpdate || m.update.progress) return undefined;
  return !m.daemonVersion || compareVersions(to, m.daemonVersion) > 0 ? to : undefined;
}

/** Whether a newer gasho-daemon is published than the one a working server runs (updatable from Gasho or not). */
export function newerPublished(m: MachineInfo, latest: LatestVersions | undefined): boolean {
  const to = latest?.daemon;
  return Boolean(to && m.daemonVersion && compareVersions(to, m.daemonVersion) > 0);
}

/** The changes between two versions of gasho-daemon, on GitHub (each release is tagged daemon-v<version>). */
export function changesUrl(from: string, to: string): string {
  return `https://github.com/4rtoflow/Gasho/compare/daemon-v${from}...daemon-v${to}`;
}

/** What waits on a working server that an update would affect: inputs still to send, and permission requests. */
export function pendingWork(m: MachineInfo): { inputs: number; requests: number } {
  let inputs = 0;
  let requests = 0;
  for (const s of m.sessions) {
    inputs += s.pendingInputs ?? 0;
    // A question read from the session's screen ("question:…") is read again after the restart; a permission request
    // held through Claude Code's hook is not.
    requests += (s.permissionRequests ?? []).filter((r) => !r.id.startsWith("question:")).length;
  }
  return { inputs, requests };
}

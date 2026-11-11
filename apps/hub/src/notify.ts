import type { GashoNotification, HookEvent, SessionInfo } from "@gasho/protocol";

export function sessionLabel(s: SessionInfo | undefined, sessionId: string): string {
  if (s?.title) return s.title;
  if (s?.name) return s.name;
  if (s?.cwd) return s.cwd.split("/").filter(Boolean).pop() ?? s.cwd;
  return sessionId.slice(0, 8);
}

/**
 * Decides whether a hook event deserves a notification.
 * Server-mode sessions never send idle_prompt, so "waiting for input" there is shown from Stop.
 */
export function notificationFor(
  machine: string,
  ev: HookEvent,
  session: SessionInfo | undefined,
  id: string,
): GashoNotification | null {
  const label = sessionLabel(session, ev.sessionId);
  const base = { id, machine, sessionId: ev.sessionId, at: ev.at, read: false };
  if (ev.event === "Stop") {
    return { ...base, kind: "done", title: `${label} の応答が終わりました`, body: ev.summary || undefined };
  }
  if (ev.event === "StopFailure") {
    return { ...base, kind: "error", title: `${label} がエラーで止まりました`, body: ev.summary || undefined };
  }
  if (ev.event === "Notification" && ev.notificationType === "permission_prompt") {
    return { ...base, kind: "permission", title: `${label} が権限の確認を待っています`, body: ev.summary || undefined };
  }
  if (ev.event === "Notification" && ev.notificationType === "idle_prompt") {
    return { ...base, kind: "idle", title: `${label} が入力を待っています`, body: ev.summary || undefined };
  }
  return null;
}

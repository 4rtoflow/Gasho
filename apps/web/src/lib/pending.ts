// Messages sent from this browser that the conversation does not show yet. Claude Code records a message only once
// gasho-daemon has typed it into the session, which can take a while: the session may switch the model first (with
// /model), or be busy (the message then waits on the working server). Meanwhile, the conversation shows the message at
// its end, from here, as being sent; the entry Claude Code records takes its place.
import { useCallback, useSyncExternalStore } from "react";
import type { TranscriptEntry } from "@gasho/protocol";
import { isShellInput } from "./shell.ts";

export interface PendingMessage {
  id: string;
  /** As sent (trimmed); empty when only files were sent. */
  text: string;
  /** Names of the files sent with it. */
  files: string[];
  /** How many entries the conversation had when it was sent: the message is recorded after them. */
  after: number;
  /**
   * "sending": the working server has not answered yet; "queued": it waits there until the session has finished its
   * work; "sent": typed into the session, so the conversation shows it shortly.
   */
  state: "sending" | "queued" | "sent";
  /** When the state last changed (ms, this browser's clock). */
  at: number;
}

/**
 * How long a message is shown from here after it was typed into the session (or, waiting on the working server, after
 * the session has none waiting any more), should the conversation not show it by then: Claude Code records some texts
 * otherwise, such as a slash command that only changes the session.
 */
export const SENT_GRACE_MS = 20_000;
/** The first characters of a message, spaces aside, that its entry in the conversation must hold. */
const HEAD = 24;

const squeeze = (s: string): string => s.replace(/\s+/g, "");

function entryText(e: TranscriptEntry): string {
  return squeeze(e.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
}

/**
 * Whether the conversation shows the message: an entry recorded after the ones it had when the message was sent, that
 * holds the message's first characters. Claude Code drops the "!" of a shell command (it records the command inside
 * tags); a slash command becomes a note that starts with it; files sent alone show as their paths under Gasho's
 * attachments folder. `start` is the index of entries[0] in the whole conversation.
 */
export function recorded(p: PendingMessage, entries: readonly TranscriptEntry[], start: number): boolean {
  const head = squeeze(p.text.replace(/^\s*!/, "")).slice(0, HEAD);
  const command = p.text.startsWith("/");
  for (let i = Math.max(0, p.after - start); i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    const text = entryText(e);
    if (e.role === "user" && (head ? text.includes(head) : text.includes("/gasho/attachments/"))) return true;
    if (e.role === "system" && command && head && text.startsWith(head)) return true;
  }
  return false;
}

/**
 * Whether to show a message from here: not once the conversation shows it. A message that waits on the working server
 * is shown while the session has messages waiting there (`waiting`, from the session's info), and for a while after it
 * was queued, in case that count was not seen go up.
 */
export function pendingShown(
  p: PendingMessage,
  entries: readonly TranscriptEntry[],
  start: number,
  waiting: number,
  now: number,
): boolean {
  if (recorded(p, entries, start)) return false;
  if (p.state === "queued") return waiting > 0 || now - p.at < SENT_GRACE_MS;
  return true;
}

// ---- the messages of each session, keyed by transcriptKey(machine, sessionId) ----

const lists = new Map<string, PendingMessage[]>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Whether each session is working, as last told (see sessionWorking). */
const working = new Map<string, boolean>();
const NONE: PendingMessage[] = [];

function set(key: string, list: PendingMessage[]): void {
  if (list.length > 0) lists.set(key, list);
  else lists.delete(key);
  for (const l of listeners) l();
}

/** Shows a message just sent from here. Returns its id. */
export function addPending(key: string, message: { text: string; files: string[]; after: number }): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  set(key, [...(lists.get(key) ?? []), { id, ...message, state: "sending", at: Date.now() }]);
  return id;
}

export function removePending(key: string, id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const list = lists.get(key) ?? [];
  if (list.some((p) => p.id === id)) set(key, list.filter((p) => p.id !== id));
}

/**
 * What the working server did with a message: typed it into the session ("sent"; it is removed from here a while
 * later, by when the conversation shows it), or kept it waiting until the session has finished its work ("queued").
 */
export function settlePending(key: string, id: string, state: "queued" | "sent"): void {
  const list = lists.get(key) ?? [];
  if (!list.some((p) => p.id === id)) return;
  set(key, list.map((p) => (p.id === id ? { ...p, state, at: Date.now() } : p)));
  if (state === "sent") {
    clearTimeout(timers.get(id));
    timers.delete(id);
    // A shell command runs as long as the session works (see sessionWorking).
    const shell = isShellInput(list.find((p) => p.id === id)?.text ?? "");
    if (!shell || !working.get(key)) timers.set(id, setTimeout(() => removePending(key, id), SENT_GRACE_MS));
  }
}

/**
 * Whether the session is working. Claude Code records a shell command ("!") only once it has ended, so one typed into
 * the session from here stays shown, as running, while the session works; once it stops, the command goes
 * SENT_GRACE_MS later, by when the conversation shows it (a command that was stopped is not recorded at all).
 */
export function sessionWorking(key: string, now: boolean): void {
  working.set(key, now);
  for (const p of lists.get(key) ?? []) {
    if (p.state !== "sent" || !isShellInput(p.text)) continue;
    clearTimeout(timers.get(p.id));
    timers.delete(p.id);
    if (!now) timers.set(p.id, setTimeout(() => removePending(key, p.id), SENT_GRACE_MS));
  }
}

/** The session has no messages waiting on the working server any more: the ones that waited there were typed. */
export function noneWaiting(key: string): void {
  for (const p of lists.get(key) ?? []) if (p.state === "queued") settlePending(key, p.id, "sent");
}

/** The messages sent from here to a session that are not over yet (see pendingShown for which to show). */
export function pendingOf(key: string): PendingMessage[] {
  return lists.get(key) ?? NONE;
}

/** pendingOf, kept up to date in a component. */
export function usePending(key: string): PendingMessage[] {
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return useSyncExternalStore(subscribe, () => pendingOf(key));
}

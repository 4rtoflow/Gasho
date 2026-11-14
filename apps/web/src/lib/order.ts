// The order the user put things in by dragging them: the tiles of the home screen and the sessions of the sidebar.
// Kept in this browser's localStorage, so a phone and a computer each keep their own; a private window or blocked
// storage keeps it for this page view only. Without a saved order, the default order applies.
import { useCallback, useSyncExternalStore } from "react";

/** Saved orders keep at most this many ids (sessions that ended are dropped from the end). */
const MAX_SAVED = 200;

const listeners = new Set<() => void>();
const values = new Map<string, string[] | undefined>();

function read(key: string): string[] | undefined {
  if (values.has(key)) return values.get(key);
  let value: string[] | undefined;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(saved) && saved.every((id) => typeof id === "string")) value = saved;
  } catch {
    // storage unavailable or unreadable: the default order
  }
  values.set(key, value);
  return value;
}

function write(key: string, ids: string[] | undefined): void {
  values.set(key, ids);
  try {
    if (ids) localStorage.setItem(key, JSON.stringify(ids));
    else localStorage.removeItem(key);
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

/** The saved order (undefined: none), and a way to save another or to go back to the default (undefined). */
export function useSavedOrder(key: string): [string[] | undefined, (ids: string[] | undefined) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(key),
  );
  return [value, useCallback((ids: string[] | undefined) => write(key, ids), [key])];
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The tiles in the saved order. A tile missing from it (one Gasho added later) goes after the tile it follows by
 * default; a saved id that is no longer a tile is left out.
 */
export function arrangeTiles(defaults: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved) return [...defaults];
  const known = new Set(defaults);
  const result = [...new Set(saved.filter((id) => known.has(id)))];
  defaults.forEach((id, i) => {
    if (result.includes(id)) return;
    const before = defaults.slice(0, i).findLast((d) => result.includes(d));
    result.splice(before === undefined ? 0 : result.indexOf(before) + 1, 0, id);
  });
  return result;
}

/**
 * The sessions in the saved order. Sessions missing from it (started or forked since) come first, in the order
 * given (the one used last first).
 */
export function arrangeSessions(ids: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved) return [...ids];
  const shown = new Set(ids);
  const placed = new Set(saved);
  return [...ids.filter((id) => !placed.has(id)), ...new Set(saved.filter((id) => shown.has(id)))];
}

/**
 * What to save after the sessions shown were put in the order `ids`: that order, then the saved sessions not shown
 * now, at most MAX_SAVED in all.
 */
export function rememberSessions(ids: readonly string[], saved: readonly string[] | undefined): string[] {
  const shown = new Set(ids);
  return [...ids, ...(saved ?? []).filter((id) => !shown.has(id))].slice(0, MAX_SAVED);
}

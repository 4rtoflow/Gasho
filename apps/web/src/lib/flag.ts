// Small choices of this browser (a folded list, the repository the sidebar is narrowed to, and the like), kept in
// localStorage. A private window or blocked storage just uses the default.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
/** What is saved under each key read so far (null: nothing). */
const values = new Map<string, string | null>();

function read(key: string): string | null {
  const known = values.get(key);
  if (known !== undefined) return known;
  let value: string | null = null;
  try {
    value = localStorage.getItem(key);
  } catch {
    // storage unavailable
  }
  values.set(key, value);
  return value;
}

function write(key: string, value: string | null): void {
  values.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

function useSaved(key: string): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(key),
  );
}

export function useFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const saved = useSaved(key);
  return [saved === "1" ? true : saved === "0" ? false : fallback, (next) => write(key, next ? "1" : "0")];
}

/** One of several choices, such as an id (undefined: none chosen). */
export function useChoice(key: string): [string | undefined, (value: string | undefined) => void] {
  return [useSaved(key) ?? undefined, (next) => write(key, next ?? null)];
}

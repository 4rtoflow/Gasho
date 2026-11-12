// Small on/off choices of this browser (a folded list and the like), kept in localStorage. A private window or
// blocked storage just uses the default.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const values = new Map<string, boolean>();

function read(key: string, fallback: boolean): boolean {
  const known = values.get(key);
  if (known !== undefined) return known;
  let value = fallback;
  try {
    const saved = localStorage.getItem(key);
    if (saved === "1" || saved === "0") value = saved === "1";
  } catch {
    // storage unavailable
  }
  values.set(key, value);
  return value;
}

function write(key: string, value: boolean): void {
  values.set(key, value);
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

export function useFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(key, fallback),
  );
  return [value, (next) => write(key, next)];
}

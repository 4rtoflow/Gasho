// Whether the session screen shows its full header. Remembered in this browser only; a private window or
// blocked storage just starts with the header shown.
import { useSyncExternalStore } from "react";

const KEY = "gasho.sessionHeader";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "hidden";
  } catch {
    return true;
  }
}

let shown = read();

export function toggleSessionHeader(): void {
  shown = !shown;
  try {
    localStorage.setItem(KEY, shown ? "shown" : "hidden");
  } catch {
    // keep the choice for this page view only
  }
  for (const l of listeners) l();
}

export function useSessionHeaderShown(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
  );
}

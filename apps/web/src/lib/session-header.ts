// Whether the session screen shows its full header. On a computer the choice is remembered in this browser (a
// private window or blocked storage starts with the header shown). On a phone the header starts closed whenever a
// session screen opens, so the conversation gets the room.
import { useSyncExternalStore } from "react";
import { DESKTOP, isDesktop, useMediaQuery } from "@/lib/media";

const KEY = "gasho.sessionHeader";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "hidden";
  } catch {
    return true;
  }
}

let desktopShown = read();
let phoneShown = false;

function changed(): void {
  for (const l of listeners) l();
}

export function toggleSessionHeader(): void {
  if (!isDesktop()) {
    phoneShown = !phoneShown;
    return changed();
  }
  desktopShown = !desktopShown;
  try {
    localStorage.setItem(KEY, desktopShown ? "shown" : "hidden");
  } catch {
    // keep the choice for this page view only
  }
  changed();
}

/** A session screen opened: on a phone, its header starts closed. */
export function closeSessionHeaderOnPhone(): void {
  if (!phoneShown) return;
  phoneShown = false;
  changed();
}

export function useSessionHeaderShown(): boolean {
  const desktop = useMediaQuery(DESKTOP);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (desktop ? desktopShown : phoneShown),
  );
}

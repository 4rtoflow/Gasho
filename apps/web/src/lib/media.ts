// Media queries as React state.
import { useSyncExternalStore } from "react";

/** A computer's screen (Tailwind's md breakpoint); narrower is a phone. */
export const DESKTOP = "(min-width: 768px)";

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", l);
      return () => list.removeEventListener("change", l);
    },
    () => matches(query),
  );
}

/** Whether the screen is a computer's right now (outside React). */
export function isDesktop(): boolean {
  return matches(DESKTOP);
}

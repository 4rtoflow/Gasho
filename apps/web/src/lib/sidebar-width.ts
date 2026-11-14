// The width of the sidebar on a computer, changed by dragging its right edge. Kept in this browser's localStorage, so
// each computer keeps its own; a private window or blocked storage keeps it for this page view only.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "gasho.sidebarWidth";

export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 360;
/**
 * What the sidebar leaves to the rest of the window: a session's side panel at its narrowest (380px) and the 140px
 * of the conversation that the default width leaves beside it on the narrowest computer screen (768px).
 */
const ROOM = 520;

/** A whole number of px within the range, made narrower when the window has no room for it. */
export function clampSidebarWidth(width: number, windowWidth = Number.POSITIVE_INFINITY): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, windowWidth - ROOM, Math.round(width)));
}

/** The width saved in storage; the default when there is none, or something else is there. */
export function parseSidebarWidth(saved: string | null): number {
  const width = saved === null || saved.trim() === "" ? Number.NaN : Number(saved);
  return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_WIDTH_DEFAULT;
}

const listeners = new Set<() => void>();
let current: number | undefined;

function read(): number {
  if (current === undefined) {
    try {
      current = parseSidebarWidth(localStorage.getItem(KEY));
    } catch {
      current = SIDEBAR_WIDTH_DEFAULT; // storage unavailable
    }
  }
  return current;
}

function write(width: number): void {
  current = clampSidebarWidth(width);
  try {
    // The default is not saved, so that it is followed if it changes.
    if (current === SIDEBAR_WIDTH_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(current));
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Changed in another tab of this browser (a null key: the storage was cleared).
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== KEY && e.key !== null) return;
    current = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The width saved, in px, and a way to save another. */
export function useSidebarWidth(): [number, (width: number) => void] {
  return [useSyncExternalStore(subscribe, read), useCallback((width: number) => write(width), [])];
}

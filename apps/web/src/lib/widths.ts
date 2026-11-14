// The widths of the sidebar and of a session's side panel on a computer, changed by dragging their edges. Kept in this
// browser's localStorage, so each computer keeps its own; a private window or blocked storage keeps them for this page
// view only.
import { useSyncExternalStore } from "react";

export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 360;
/** A session's side panel; when no width is saved, 40% of the window within this range. */
export const PANEL_WIDTH_MIN = 380;
export const PANEL_WIDTH_MAX = 620;
/**
 * The conversation beside a session's side panel, at its narrowest: what the default sidebar and the narrowest panel
 * leave it on the narrowest computer screen (768px).
 */
const CONVERSATION_MIN = 140;

/** A whole number of px within the range, made narrower when the window has no room for it beside the narrowest panel. */
export function clampSidebarWidth(width: number, windowWidth = Number.POSITIVE_INFINITY): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, windowWidth - PANEL_WIDTH_MIN - CONVERSATION_MIN, Math.round(width)));
}

/**
 * A whole number of px within the range, made narrower when `room` (what the conversation and the panel share: the
 * window but the sidebar) leaves the conversation too little.
 */
export function clampPanelWidth(width: number, room = Number.POSITIVE_INFINITY): number {
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, room - CONVERSATION_MIN, Math.round(width)));
}

/** The panel's width when none is saved: 40% of the window. */
export function defaultPanelWidth(windowWidth: number): number {
  return clampPanelWidth(windowWidth * 0.4);
}

/** A width saved in storage, made to fit `clamp`; null when there is none, or something else is there. */
export function parseWidth(saved: string | null, clamp: (width: number) => number): number | null {
  const width = saved === null || saved.trim() === "" ? Number.NaN : Number(saved);
  return Number.isFinite(width) ? clamp(width) : null;
}

/** A hook for the width kept under `key`: the one saved (null: none), and a way to save another (null: forget it). */
function storedWidth(key: string, clamp: (width: number) => number): () => [number | null, (width: number | null) => void] {
  const listeners = new Set<() => void>();
  let current: number | null | undefined;

  const read = (): number | null => {
    if (current === undefined) {
      try {
        current = parseWidth(localStorage.getItem(key), clamp);
      } catch {
        current = null; // storage unavailable
      }
    }
    return current;
  };

  const write = (width: number | null): void => {
    current = width === null ? null : clamp(width);
    try {
      if (current === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(current));
    } catch {
      // keep it for this page view only
    }
    for (const l of listeners) l();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    // Changed in another tab of this browser (a null key: the storage was cleared).
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key && e.key !== null) return;
      current = undefined;
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  };

  return () => [useSyncExternalStore(subscribe, read), write];
}

/** The sidebar's width saved, in px (null: none, so the default width). */
export const useSidebarWidth = storedWidth("gasho.sidebarWidth", (width) => clampSidebarWidth(width));
/** The width saved for a session's side panel, in px, the same for every kind of panel (null: none, so 40% of the window). */
export const usePanelWidth = storedWidth("gasho.panelWidth", (width) => clampPanelWidth(width));

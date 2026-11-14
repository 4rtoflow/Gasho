// The size of the conversation's text on the session screen, picked on the settings screen: the size of the body
// text in px, the conversation's other text (times, tool calls, code) following in the same proportion. Kept in this
// browser's localStorage, so a phone and a computer each keep their own; a private window or blocked storage keeps it
// for this page view only.
import { useCallback, useSyncExternalStore, type CSSProperties } from "react";

const KEY = "gasho.chatTextSize";

/** The body text of the conversation (Tailwind's text-sm), in px. */
export const CHAT_TEXT_DEFAULT = 14;
export const CHAT_TEXT_MIN = 12;
export const CHAT_TEXT_MAX = 20;

/** A whole number of px from the smallest size to the largest. */
export function clampChatTextSize(size: number): number {
  return Math.min(CHAT_TEXT_MAX, Math.max(CHAT_TEXT_MIN, Math.round(size)));
}

/** The size saved in storage; the default when there is none, or something else is there. */
export function parseChatTextSize(saved: string | null): number {
  const size = saved === null || saved.trim() === "" ? Number.NaN : Number(saved);
  return Number.isFinite(size) ? clampChatTextSize(size) : CHAT_TEXT_DEFAULT;
}

const listeners = new Set<() => void>();
let current: number | undefined;

function read(): number {
  if (current === undefined) {
    try {
      current = parseChatTextSize(localStorage.getItem(KEY));
    } catch {
      current = CHAT_TEXT_DEFAULT; // storage unavailable
    }
  }
  return current;
}

function write(size: number): void {
  current = clampChatTextSize(size);
  try {
    // The default is not saved, so that it is followed if it changes.
    if (current === CHAT_TEXT_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(current));
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Picked in another tab of this browser (a null key: the storage was cleared).
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

/** The size picked, in px, and a way to pick another. */
export function useChatTextSize(): [number, (size: number) => void] {
  return [useSyncExternalStore(subscribe, read), useCallback((size: number) => write(size), [])];
}

/** Sets the conversation's text to `size` px; goes on the element with the class chat-text (see index.css). */
export function chatTextStyle(size: number): CSSProperties {
  return { "--chat-scale": size / CHAT_TEXT_DEFAULT } as CSSProperties;
}

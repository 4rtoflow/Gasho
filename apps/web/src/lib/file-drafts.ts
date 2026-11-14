// What is being written in the files panel, per file, kept while Gasho is open: going to another file, panel or
// session and back finds the text as it was left. Kept in memory only, like the chat box's drafts (lib/drafts.ts), so
// reloading the page loses it: the page asks before it is left while something is not saved.
import { useSyncExternalStore } from "react";
import type { Eol } from "@/lib/file-text";

export interface FileDraft {
  /** The text in the text box ("\n" line endings, no byte order mark). */
  value: string;
  /** The text as it was when editing started, or when it was last saved: the draft is not saved while they differ. */
  original: string;
  /** The hash of that version of the file: it is saved over that version only (see the file.write command). */
  baseHash?: string;
  /** What to put back when it is saved (see lib/file-text.ts). */
  eol: Eol;
  bom: boolean;
}

/** Keyed by fileKey(machine, sessionId, path). A new map at each change, for useSyncExternalStore. */
let drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();

/** Whether a draft holds changes that are not saved. */
export const isDirty = (d: FileDraft | undefined): boolean => d !== undefined && d.value !== d.original;

export function getFileDraft(key: string): FileDraft | undefined {
  return drafts.get(key);
}

/** Starts, changes or (with undefined) drops the draft of a file. */
export function setFileDraft(key: string, draft: FileDraft | undefined): void {
  if (draft === drafts.get(key)) return;
  drafts = new Map(drafts);
  if (draft) drafts.set(key, draft);
  else drafts.delete(key);
  if (draft) warnBeforeLeaving();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** All drafts, to mark the files with unsaved changes. */
export function useFileDrafts(): ReadonlyMap<string, FileDraft> {
  return useSyncExternalStore(subscribe, () => drafts);
}

export function useFileDraft(key: string): FileDraft | undefined {
  return useSyncExternalStore(subscribe, () => drafts.get(key));
}

let warning = false;

/** Asks before the page is reloaded or closed while a draft is not saved (the browser words the question). */
function warnBeforeLeaving(): void {
  if (warning) return;
  warning = true;
  window.addEventListener("beforeunload", (e) => {
    if (![...drafts.values()].some(isDirty)) return;
    e.preventDefault();
    // Older browsers ask only when this is set.
    e.returnValue = "";
  });
}

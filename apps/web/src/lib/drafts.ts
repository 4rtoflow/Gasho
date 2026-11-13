// What the chat box of each session holds, kept while Gasho is open: going to another screen and back (another
// session, the home screen, or a panel on a phone) finds the box as it was left. That is the text being written, the
// files attached, the texts sent before (↑ recalls them), and the model, effort and ultracode picked to switch when
// sending. Kept in memory only: reloading the page starts afresh.
import { useCallback, useSyncExternalStore } from "react";
import type { EffortLevel, SessionModel } from "@gasho/protocol";
import { createPromptDraft, type PromptDraftStore } from "@/components/ui/prompt-input";

/** What is picked in the chat box, to switch (for this session only) when the next message is sent. */
export interface Picks {
  model?: SessionModel;
  effort?: EffortLevel;
  ultracode?: boolean;
}

interface Draft {
  prompt: PromptDraftStore;
  picks: Picks;
  listeners: Set<() => void>;
}

/** Keyed by transcriptKey(machine, sessionId). */
const drafts = new Map<string, Draft>();

function draftOf(key: string): Draft {
  let d = drafts.get(key);
  if (!d) {
    d = { prompt: createPromptDraft(), picks: {}, listeners: new Set() };
    drafts.set(key, d);
  }
  return d;
}

/** The text, files and sent texts of a session's chat box (PromptInput's `draft`). */
export function promptDraft(key: string): PromptDraftStore {
  return draftOf(key).prompt;
}

/**
 * What is picked in a session's chat box, and how to change it. A change made after the box has gone (when the
 * answer to a message sent from it comes) is kept too.
 */
export function usePicks(key: string): [Picks, (change: (p: Picks) => Picks) => void] {
  const d = draftOf(key);
  const subscribe = useCallback(
    (l: () => void) => {
      d.listeners.add(l);
      return () => d.listeners.delete(l);
    },
    [d],
  );
  const picks = useSyncExternalStore(subscribe, () => d.picks);
  const update = useCallback(
    (change: (p: Picks) => Picks) => {
      const next = change(d.picks);
      if (next === d.picks) return;
      d.picks = next;
      for (const l of d.listeners) l();
    },
    [d],
  );
  return [picks, update];
}

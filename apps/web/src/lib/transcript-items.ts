// What the conversation shows, in order. Claude Code records each tool call and each result as an entry of its
// own, so an agent that runs one command after another fills the screen with folds; Bash calls that come in a row
// are shown together, as one item.
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";

export type ToolUse = Extract<TranscriptBlock, { type: "tool_use" }>;

export type TranscriptItem =
  | { kind: "entry"; key: string; entry: TranscriptEntry }
  /** Two or more Bash calls in a row, oldest first. */
  | { kind: "commands"; key: string; calls: ToolUse[]; isSidechain: boolean };

const isCommand = (b: TranscriptBlock): b is ToolUse => b.type === "tool_use" && b.name === "Bash";

/**
 * Entries in the order to show them, with Bash calls in a row put together. The results between the calls do not
 * break the row: an entry of results whose calls are all loaded shows nothing (each result is shown in its call's
 * fold), so it is left out. `start` is the index of entries[0] in the whole transcript, for the keys of entries
 * without a uuid; a group takes its key from its first entry, so it keeps its key (and stays open) as calls are added.
 */
export function transcriptItems(
  entries: readonly TranscriptEntry[],
  start: number,
  called: (id: string | undefined) => boolean,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: { key: string; entries: { key: string; entry: TranscriptEntry }[]; calls: ToolUse[]; isSidechain: boolean } | undefined;
  const endRun = (): void => {
    if (!run) return;
    if (run.calls.length > 1) items.push({ kind: "commands", key: `commands:${run.key}`, calls: run.calls, isSidechain: run.isSidechain });
    else for (const e of run.entries) items.push({ kind: "entry", ...e });
    run = undefined;
  };
  entries.forEach((entry, i) => {
    const key = entry.uuid || `i${start + i}`;
    const { blocks } = entry;
    if (blocks.every((b) => b.type === "tool_result" && called(b.toolUseId))) return;
    const isSidechain = entry.isSidechain === true;
    if (!blocks.every(isCommand)) {
      endRun();
      items.push({ kind: "entry", key, entry });
    } else if (run?.isSidechain === isSidechain) {
      run.entries.push({ key, entry });
      run.calls.push(...blocks);
    } else {
      endRun();
      run = { key, entries: [{ key, entry }], calls: [...blocks], isSidechain };
    }
  });
  endRun();
  return items;
}

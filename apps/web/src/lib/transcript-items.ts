// What the conversation shows, in order. Claude Code records each tool call and each result as an entry of its
// own, so an agent that calls one tool after another fills the screen with folds; tool calls that come in a row
// (Bash, Read, Edit, ... mixed) are shown together, as one item. A command run in Claude Code's shell mode ("!") and
// what it printed are recorded as two user messages; they are shown together too, and so are the two entries of a
// compaction (where Claude Code summarized the conversation, and the summary).
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { shellCommand, shellOutput } from "./shell.ts";

export type ToolUse = Extract<TranscriptBlock, { type: "tool_use" }>;

export type TranscriptItem =
  | { kind: "entry"; key: string; entry: TranscriptEntry }
  /** Two or more tool calls in a row, oldest first. */
  | { kind: "tools"; key: string; calls: ToolUse[]; isSidechain: boolean }
  /**
   * A shell-mode command and what it printed. Either can be missing where a page of the conversation ends between
   * them (the command is recorded first).
   */
  | { kind: "shell"; key: string; command?: string; output?: { stdout: string; stderr: string }; ts?: string }
  /**
   * A compaction: where Claude Code summarized the conversation, and the summary it goes on from. The summary can be
   * missing where a page of the conversation ends between them (the mark is recorded first), and while it is not
   * recorded yet. The item takes its key from the summary, so it stays open when the page with its mark comes.
   */
  | { kind: "compaction"; key: string; summary?: string; ts?: string };

const isToolCall = (b: TranscriptBlock): b is ToolUse => b.type === "tool_use";

/** The text of a user message that is nothing but text, as shell-mode records are. */
function userText(e: TranscriptEntry | undefined): string | undefined {
  const only = e?.role === "user" && !e.isSidechain && e.blocks.length === 1 ? e.blocks[0] : undefined;
  return only?.type === "text" ? only.text : undefined;
}

/**
 * Entries in the order to show them, with tool calls in a row put together, whatever the tools. The results between the calls do not
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
    if (run.calls.length > 1) items.push({ kind: "tools", key: `tools:${run.key}`, calls: run.calls, isSidechain: run.isSidechain });
    else for (const e of run.entries) items.push({ kind: "entry", ...e });
    run = undefined;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const key = entry.uuid || `i${start + i}`;
    const { blocks } = entry;
    if (blocks.every((b) => b.type === "tool_result" && called(b.toolUseId))) continue;
    if (entry.compaction) {
      endRun();
      // The summary is recorded right after its mark.
      const next = entry.compaction === "mark" && entries[i + 1]?.compaction === "summary" ? entries[i + 1] : undefined;
      if (next) i++;
      const summary = entry.compaction === "summary" ? entry : next;
      const text = summary?.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
      items.push({ kind: "compaction", key: `compaction:${summary ? summary.uuid || `i${start + i}` : key}`, summary: text, ts: entry.ts });
      continue;
    }
    const isSidechain = entry.isSidechain === true;
    const text = userText(entry);
    const command = text === undefined ? undefined : shellCommand(text);
    const output = command === undefined && text !== undefined ? shellOutput(text) : undefined;
    if (command !== undefined || output) {
      endRun();
      // A command's output is recorded right after it.
      const next = command !== undefined ? userText(entries[i + 1]) : undefined;
      const its = next === undefined ? undefined : shellOutput(next);
      if (its) i++;
      items.push({ kind: "shell", key, command, output: output ?? its, ts: entry.ts });
    } else if (!blocks.every(isToolCall)) {
      endRun();
      items.push({ kind: "entry", key, entry });
    } else if (run?.isSidechain === isSidechain) {
      run.entries.push({ key, entry });
      run.calls.push(...blocks);
    } else {
      endRun();
      run = { key, entries: [{ key, entry }], calls: [...blocks], isSidechain };
    }
  }
  endRun();
  return items;
}

// What a session is working on, for the plugins (useSessionActivity, plugin API 1.2): since when, and with which tool.
// It is read from Claude Code's hooks that gasho-daemon passes on (Gasho's screen keeps the latest ones of all
// sessions) and from the session's conversation, when it is loaded.
import type { SessionActivity } from "@gasho/plugin-sdk";
import type { MachineHookEvent, SessionStatus, TranscriptEntry } from "@gasho/protocol";

/** Hooks after which the session has ended its work. */
const ENDS = new Set(["Stop", "StopFailure", "SessionEnd"]);
/** Hooks of work. A notification is not: Claude Code also sends one while it waits, idle, for the person. */
const WORK = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);
/** A message the conversation records this much after the hook of the last one is a later message, whose hook is gone. */
const SAME_MESSAGE_MS = 10_000;

/**
 * When the person last wrote to the session, as its conversation records it (ms since the epoch). Claude Code records
 * the results of tool calls as the person's entries too; those, the subagents', the interruptions and the summary of
 * a compaction are not what the person wrote.
 */
export function lastPromptAt(entries: readonly TranscriptEntry[] | undefined): number | undefined {
  const e = entries?.findLast(
    (e) => e.role === "user" && !e.isSidechain && !e.interrupted && !e.compaction && !e.blocks.every((b) => b.type === "tool_result"),
  );
  const at = e?.ts ? Date.parse(e.ts) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/**
 * What the session `at` is working on. `events`: the hooks Gasho's screen keeps, oldest first, of every session.
 * `entries`: the loaded part of the session's conversation, if any.
 */
export function sessionActivity(
  at: { machine: string; sessionId: string; status: SessionStatus | undefined },
  events: readonly MachineHookEvent[],
  entries: readonly TranscriptEntry[] | undefined,
): SessionActivity {
  if (at.status !== "busy" && at.status !== "waiting") return {};
  const own = events.filter((e) => e.machine === at.machine && e.sessionId === at.sessionId);
  let hooked: number | undefined;
  let ended: number | undefined;
  for (const e of own) {
    if (e.event === "UserPromptSubmit") hooked = Math.max(hooked ?? e.at, e.at);
    else if (ENDS.has(e.event)) ended = Math.max(ended ?? e.at, e.at);
  }
  // The person's last message: its hook, which comes first and so keeps the time the same while the conversation
  // catches up; the conversation's entry when the hook is gone (only the latest hooks are kept) or is of an earlier one.
  const said = lastPromptAt(entries);
  const prompt = hooked !== undefined && (said === undefined || said - hooked < SAME_MESSAGE_MS) ? hooked : said;
  // The person's last message while its work goes on. Once that work has ended, the session works on something it
  // took up by itself (the end of a task it ran in the background): from the first thing it did after.
  const turnStartedAt =
    prompt !== undefined && (ended === undefined || prompt > ended)
      ? prompt
      : ended !== undefined
        ? own.find((e) => e.at > ended && WORK.has(e.event))?.at
        : undefined;

  // The tools started and not finished yet. Several can run at once; a finished one is told apart from the others by
  // its name and input, which its PreToolUse and PostToolUse share.
  const running: MachineHookEvent[] = [];
  for (const e of own) {
    if (e.event === "PreToolUse" && e.toolName) running.push(e);
    else if (e.event === "PostToolUse" || e.event === "PostToolUseFailure") {
      const i = running.findIndex((r) => r.toolName === e.toolName && r.summary === e.summary);
      if (i >= 0) running.splice(i, 1);
    } else if (e.event === "UserPromptSubmit" || ENDS.has(e.event)) running.length = 0;
  }
  const tool = running.at(-1);
  return {
    ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
    ...(tool?.toolName ? { tool: { name: tool.toolName, ...(tool.summary ? { summary: tool.summary } : {}), startedAt: tool.at } } : {}),
  };
}

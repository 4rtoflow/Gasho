// Sessions that Gasho starts itself: `claude --remote-control` running in a terminal of its own (terminal.ts; zellij
// for those that gasho-daemon 0.10 and before started). Gasho can type into these (paste + Enter) and interrupt them
// (Esc); the official apps can still use them.
// Rules from the verification (docs/research.md): send input only while the session is idle, and never while
// a permission dialog is open, because Enter would answer the dialog.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BackgroundTaskKind, EffortLevel, ModelOption, SessionModel } from "@gasho/protocol";

const execFileP = promisify(execFile);

/** The pane that `zellij attach --create-background … -- <command>` creates. */
export const PANE = "terminal_0";
export const TRUST_PROMPT_RE = /trust this folder|Quick safety check/i;
export const PERMISSION_PROMPT_RE = /Do you want to proceed\?/;

/**
 * A screen of a session's terminal, read from its dump (terminal.ts's dumpScreen, or zellij's `action dump-screen
 * --ansi`, which mark dim and reverse video the same way). `plain` has every character. `typed` leaves out
 * what is drawn dim (SGR 2): in the prompt box, that is Claude Code's suggestion for the next message and its
 * placeholder, which nobody typed. Unless the terminal's own cursor is used, Claude Code draws its cursor on the first
 * character of these in reverse video (SGR 7) instead of dim; a single reversed character followed by dim text is left
 * out too. Both keep every line break, so their lines match. `reversed` keeps only what is drawn in reverse video
 * (the rest is spaces), with the same lines.
 */
export interface Screen {
  plain: string;
  typed: string;
  reversed?: string;
}

// CSI (with SGR as the "m" case), OSC, character set selection, and the other two-character escapes.
const ESCAPE_RE = /\x1b(?:\[([0-?]*)[ -\/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][ -~]|[ -~])/g;

/** Reads the dump of a terminal's screen (see Screen). */
export function readScreen(ansi: string): Screen {
  let plain = "";
  let typed = "";
  let reversed = "";
  let dim = false;
  let inverse = false;
  // A reversed character held back until it is known whether dim text follows it (then it is Claude Code's cursor).
  let cursor = "";
  let at = 0;
  const text = (s: string) => {
    if (!s) return;
    plain += s;
    reversed += inverse ? s : s.replace(/[^\n]/g, " ");
    if (dim) {
      typed += s.replace(/[^\n]/g, "");
      cursor = "";
    } else if (inverse && Array.from(s).length === 1 && s !== "\n") {
      typed += cursor;
      cursor = s;
    } else {
      typed += cursor + s;
      cursor = "";
    }
  };
  for (const m of ansi.matchAll(ESCAPE_RE)) {
    const index = m.index ?? 0;
    text(ansi.slice(at, index));
    at = index + m[0].length;
    if (m[2] !== "m") continue;
    const params = (m[1] || "0").split(";");
    for (let i = 0; i < params.length; i++) {
      const [code, ...sub] = (params[i] ?? "").split(":");
      const n = Number(code || "0");
      // 38, 48 and 58 set a colour; the numbers after them are its value, not attributes ("38;5;n", "38;2;r;g;b").
      if (n === 38 || n === 48 || n === 58) {
        if (sub.length === 0) i += params[i + 1] === "5" ? 2 : 4;
      } else if (n === 0) {
        dim = false;
        inverse = false;
      } else if (n === 22) dim = false;
      else if (n === 2) dim = true;
      else if (n === 7) inverse = true;
      else if (n === 27) inverse = false;
    }
  }
  text(ansi.slice(at));
  return { plain, typed: typed + cursor, reversed };
}

/** A screen read from plain text, where nothing is dim (for screens that need no more). */
export function plainScreen(plain: string): Screen {
  return { plain, typed: plain };
}

function screenLines(screen: string): string[] {
  return screen.split("\n").map((l) => l.trimEnd());
}

/**
 * The last `n` non-empty lines of the screen. Pickers, questions and dialogs are drawn at the bottom; the conversation
 * above them can contain the same words (a quoted dialog, a diff of this file), so checks for them look only here.
 */
export function bottomLines(screen: string, n: number): string[] {
  return screenLines(screen).filter(Boolean).slice(-n);
}

/** Whether `re` matches the last `n` non-empty lines of the screen, read as one text (a narrow pane wraps lines). */
export function atBottom(screen: string, re: RegExp, n = 15): boolean {
  return re.test(bottomLines(screen, n).join(" ").replace(/\s+/g, " "));
}

/**
 * Claude Code's question before a switch that makes it read the whole conversation again: "… This conversation is
 * cached for the current model. Switching to Haiku 5.5 means the full history gets re-read. ❯ 1. Yes, switch to
 * Haiku 5.5 / 2. No, go back". Undefined unless its two choices are at the bottom of the screen. `aboutCache` is false
 * for other questions with the same choices, such as a confirmation that a hook asks for: those are not Gasho's to
 * answer.
 */
export function switchQuestion(screen: string): { onYes: boolean; aboutCache: boolean } | undefined {
  const all = screenLines(screen).filter(Boolean);
  const yes = all.findLastIndex((l) => /^\s*(?:❯\s*)?1\.\s+Yes, switch to\b/.test(l));
  const no = all.findLastIndex((l) => /^\s*(?:❯\s*)?2\.\s+No, go back\b/.test(l));
  // The choices, then at most a line or two of key help.
  if (yes < 0 || no <= yes || no - yes > 2 || all.length - no > 3) return undefined;
  // The question's own lines: from its title ("Switch model?", "Change effort level?") down to the choices. Without a
  // title, the few lines above the choices; the conversation above them must not decide.
  const from = Math.max(0, yes - 10);
  const title = all.slice(from, yes).findLastIndex((l) => /^\s*(?:Switch model|Change effort level)\?\s*$/.test(l));
  const text = all
    .slice(title >= 0 ? from + title : Math.max(0, yes - 6), yes)
    .join(" ")
    .replace(/\s+/g, " ");
  return {
    onYes: /^\s*❯/.test(all[yes] ?? ""),
    aboutCache:
      /conversation is cached/i.test(text) && /history gets re-read/i.test(text) && !/PreModelSwitch|hook asked you to confirm/i.test(text),
  };
}

/**
 * The model in Claude Code's welcome banner, drawn when it starts and before the first message is recorded:
 * " ▐▛███▛█   Claude Code v2.1.322" / "▝▜██████▀  Sonnet 5.5 · Claude Ultra" / " ▝▝   ▝▝   ~/repos/app". Undefined when the
 * banner is not on the screen.
 */
export function bannerModel(screen: string): string | undefined {
  const lines = screen.split("\n");
  const at = lines.findIndex((l) => /Claude Code v\d/.test(l));
  if (at < 0) return undefined;
  // The logo is drawn with block elements (U+2580–U+259F).
  const rest = (lines[at + 1] ?? "").replace(/^[\s\u2580-\u259f]+/, "");
  const name = /^(.+?)\s+·\s/.exec(rest)?.[1]?.trim();
  return name && name.length <= 40 && /\d/.test(name) ? name : undefined;
}

/**
 * Claude Code's question when it resumes a session whose last message is old and whose conversation is long: "This
 * session is 3h 5m old and 120k tokens." with "Resume from summary (recommended)", "Resume full session as-is" and
 * "Don't ask me again". Esc answers it without a choice: the full session is resumed as it is, nothing is summarized,
 * and nothing is saved ("Don't ask me again" would turn the question off for every session). The question hides the
 * prompt box; with the box at the bottom, the words are only quoted in the conversation (Esc there would do harm: a
 * second one opens Claude Code's rewind menu).
 */
export function resumeQuestionOpen(screen: string): boolean {
  if (promptBoxAtBottom(screenLines(screen))) return false;
  return atBottom(screen, /This session is .+? old and .+? tokens\..*Resume full ?session/, 20);
}

/**
 * Claude Code's question whether to trust a folder it does not trust yet: "Quick safety check: Is this a project you
 * created or one you trust? …", then "No, exit" and "Yes, I trust this folder" (2.1.323 puts "No, exit" first, with the
 * cursor on it). Found by its two choices at the bottom of the screen, with at most the key help below them (the top of
 * a tall question can be cut off). `onYes`: the cursor is on "Yes, I trust this folder"; `yesBelow`: it is the lower
 * choice. `warnings`: what Claude Code points out about the folder's own settings, one paragraph each ("⚠ This folder
 * pre-approves 1 tool permission in .claude/settings.json: Bash(ls:*) These will apply without asking. …").
 */
export function trustQuestion(screen: string): { onYes: boolean; yesBelow: boolean; warnings: string[] } | undefined {
  const lines = screenLines(screen);
  if (promptBoxAtBottom(lines)) return undefined;
  const yes = lines.findLastIndex((l) => /^\s*(?:❯\s*)?(?:\d+\.\s+)?Yes, I trust this folder\s*$/.test(l));
  const no = lines.findLastIndex((l) => /^\s*(?:❯\s*)?(?:\d+\.\s+)?No, exit\s*$/.test(l));
  if (yes < 0 || no < 0 || Math.abs(yes - no) > 2) return undefined;
  if (lines.slice(Math.max(yes, no) + 1).filter(Boolean).length > 3) return undefined;
  return { onYes: /^\s*❯/.test(lines[yes] ?? ""), yesBelow: yes > no, warnings: trustWarnings(lines.slice(0, Math.min(yes, no))) };
}

/** The paragraphs between "… execute files here." and "Security guide" of the trust question: its warnings. */
function trustWarnings(lines: string[]): string[] {
  const start = lines.findLastIndex((l) => /execute files here\.?\s*$/.test(l));
  const end = lines.findLastIndex((l) => /^\s*Security guide\s*$/.test(l));
  if (start < 0 || end <= start) return [];
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const l of [...lines.slice(start + 1, end), ""]) {
    if (l.trim()) current.push(l.trim());
    else if (current.length > 0) {
      paragraphs.push(current.join(" ").slice(0, 600));
      current = [];
    }
  }
  return paragraphs.slice(0, 12);
}

/**
 * Claude Code's question about the MCP servers in a folder's .mcp.json that it has not been told about yet, asked
 * once the folder is trusted: "New MCP server found in this project: demo" (or "2 new MCP servers found in this
 * project", with check boxes). Esc answers it like "Continue without using this MCP server": the session starts
 * without them, and Claude Code saves that in the folder's .claude/settings.local.json (`disabledMcpjsonServers`), so
 * it does not ask again; /mcp turns them on.
 */
export function mcpQuestionOpen(screen: string): boolean {
  if (promptBoxAtBottom(screenLines(screen))) return false;
  return atBottom(screen, /\bnew MCP servers? found in this project\b/i, 20);
}

/** Whether the output of the latest /model on the screen says the model was switched for this session only. */
export function switchedForSession(screen: string): boolean {
  const flat = screen.replace(/\s+/g, " ");
  const i = flat.lastIndexOf("❯ /model");
  return i >= 0 && /for this session only/.test(flat.slice(i));
}

/**
 * The prompt box: the last horizontal rule on the screen (the one under the box); above it, the box's first line,
 * which starts with "❯" (or "!" when a text starting with "!" has put the box in shell mode), with only the indented
 * lines a long text folds into in between; and the rule right above that line. Claude Code writes the session's name
 * (given with /rename) and "ultracode" (while it is on) into that rule, at its right: "──── name ─". In Gasho's
 * 50-column terminals, a long name leaves only a few "─" before it, or none.
 */
function promptBox(lines: string[]): { top: number; bottom: number } | undefined {
  let bottom = lines.length - 1;
  while (bottom >= 0 && !/^─{8,}/.test(lines[bottom]!)) bottom--;
  let first = bottom - 1;
  while (first > 0 && /^(?:\s|$)/.test(lines[first]!)) first--;
  const top = first - 1;
  if (top < 0 || !/^[❯!]/.test(lines[first]!) || !/^─|─$/.test(lines[top]!)) return undefined;
  return { top, bottom };
}

/** At most this many lines (mode, hints, a status line) follow the prompt box when nothing else is open. */
const FOOTER_LINES = 4;

/**
 * Whether the prompt box is at the bottom of the screen, with only Claude Code's footer below it. Claude Code hides
 * the box while a picker, question or dialog has the keys, so then none of them is open, whatever the conversation
 * above says.
 */
function promptBoxAtBottom(lines: string[]): boolean {
  const box = promptBox(lines);
  return box !== undefined && lines.slice(box.bottom + 1).filter(Boolean).length <= FOOTER_LINES;
}

/**
 * Claude Code's occasional feedback survey, drawn right above the prompt box ("● How is Claude doing this session?
 * (optional)" / "1: Bad 2: Fine 3: Good 0: Dismiss"). It takes the keys while it is shown; "0" dismisses it.
 */
export function surveyOpen(screen: string): boolean {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  if (!box) return false;
  const above = lines.slice(0, box.top).filter(Boolean).slice(-2);
  return /How is Claude doing this session\?/.test(above[0] ?? "") && /\b0:\s*Dismiss\b/.test(above[1] ?? "");
}

/**
 * Claude Code's offer to set up auto mode, drawn right above the prompt box while the box stays shown ("Teach auto
 * mode about your environment?" / "1. Yes 2. Not now 3. Don't show again" / "Enter to confirm · Esc to cancel"). It
 * takes the keys while it is shown: a paste does not reach the box. Esc answers it like "Not now".
 */
export function autoModeOfferOpen(screen: string): boolean {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  if (!box) return false;
  const above = lines.slice(0, box.top).filter((l) => l.trim());
  if (!/Enter to confirm · Esc to cancel/.test(above.at(-1) ?? "")) return false;
  // The offer's own lines: up to the rule drawn above it.
  const ruleAt = above.findLastIndex((l) => /^─{8,}/.test(l));
  return above.slice(ruleAt + 1).some((l) => /Teach auto mode about your environment\?/.test(l));
}

/**
 * The key that closes what is drawn right above the prompt box and takes the keys while the box is still shown: "0"
 * for the feedback survey, Esc for the offer to set up auto mode. Undefined when neither is shown.
 */
export function noticeKey(screen: string): "0" | "Esc" | undefined {
  if (surveyOpen(screen)) return "0";
  if (autoModeOfferOpen(screen)) return "Esc";
  return undefined;
}

/** The lines of Claude Code's prompt box. Undefined when the screen does not show the prompt box. */
export function promptBoxLines(screen: string): string[] | undefined {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  return box && lines.slice(box.top + 1, box.bottom);
}

/** One choice of a dialog: "❯ 1. Yes" (the cursor is on it), "  2. No". */
export interface DialogOption {
  n: number;
  label: string;
  selected: boolean;
}

const DIALOG_OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(\S.*)$/;

/**
 * Claude Code's permission dialog for a tool, whatever it asks ("Do you want to proceed?" for a command, "Do you want
 * to make this edit to …?", "Do you want to allow Claude to fetch this content?"): its numbered choices at the bottom
 * of the screen, the first "Yes" and another "No…", one of them under the cursor. Undefined when the bottom of the
 * screen shows no such choices, or the prompt box is there.
 */
export function permissionDialog(screen: string): DialogOption[] | undefined {
  const lines = screenLines(screen);
  if (promptBoxAtBottom(lines)) return undefined;
  let options: DialogOption[] = [];
  for (const line of bottomLines(screen, 15)) {
    const m = DIALOG_OPTION_RE.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    const option = { n, label: m[3]!.trim(), selected: m[1] !== undefined };
    // A choice that wraps goes on without a number; numbers that start again from 1 are another list.
    if (n === 1) options = [option];
    else if (n === options.length + 1) options.push(option);
  }
  if (options[0]?.label !== "Yes" || !options.slice(1).some((o) => /^No\b/.test(o.label))) return undefined;
  return options.filter((o) => o.selected).length === 1 ? options : undefined;
}

/**
 * Whether something at the bottom of the screen has the keys instead of the prompt box: the /model picker, the
 * question before a switch, a permission dialog, the trust dialog, the question about a folder's MCP servers or the
 * question when resuming an old session.
 */
export function dialogOpen(screen: string): boolean {
  if (promptBoxAtBottom(screenLines(screen))) return false;
  return (
    modelPickerOptions(screen).length > 0 ||
    switchQuestion(screen) !== undefined ||
    atBottom(screen, PERMISSION_PROMPT_RE) ||
    permissionDialog(screen) !== undefined ||
    atBottom(screen, TRUST_PROMPT_RE) ||
    mcpQuestionOpen(screen) ||
    resumeQuestionOpen(screen)
  );
}

/**
 * What is typed in the prompt box, without the "❯", spaces and line breaks (the box folds long text), and without
 * what is drawn dim. Undefined when the screen shows no prompt box, or when a dialog has the keys.
 */
export function typedInBox(s: Screen): string | undefined {
  if (dialogOpen(s.plain)) return undefined;
  const box = promptBox(screenLines(s.plain));
  if (!box) return undefined;
  return s.typed
    .split("\n")
    .slice(box.top + 1, box.bottom)
    .join("")
    .replace(/\s+/g, "")
    .replace(/^[❯!]/, "");
}

/**
 * Whether the prompt box holds `text`: its first characters (spaces aside), or the "[Pasted text #N]" that Claude
 * Code shows for a long or multi-line paste. False when the screen shows no prompt box.
 */
export function promptHolds(s: Screen, text: string): boolean {
  const inBox = typedInBox(s);
  if (!inBox) return false;
  if (/\[Pastedtext#\d+/.test(inBox)) return true;
  // A text starting with "!" puts the box in shell mode, and Claude Code drops the "!" from it.
  const head = text.replace(/^\s*!/, "").replace(/\s+/g, "").slice(0, 12);
  return head.length > 0 && inBox.includes(head);
}

/**
 * Keys that empty the prompt box, for a box that takes `lines` lines on the screen. Ctrl+U deletes back to the
 * start of the line on the screen, and Backspace then deletes the line break before it (or a whole
 * "[Pasted text]"), so one pair per line is enough. On an empty box they do nothing. Ctrl+C would also empty
 * the box, but a second Ctrl+C within a few seconds quits Claude Code.
 */
export function clearPromptKeys(lines: number): string[] {
  return Array.from({ length: Math.max(1, lines) + 1 }, () => ["Ctrl u", "Backspace"]).flat();
}

/**
 * Claude Code's line above the prompt box once Claude's turn has ended while it still waits for subagents (or
 * workflows) it started in the background: "✻ Waiting for 1 background agent to finish". Claude Code still reports
 * the session as busy then, but Esc stops nothing.
 */
const BACKGROUND_WAIT_RE = /\bWaiting for \d+ background \w+/;

/** Whether Claude's turn has ended and Claude waits for subagents or workflows running in the background. */
export function waitingForBackground(screen: string): boolean {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  if (!box) return false;
  return BACKGROUND_WAIT_RE.test(lines.slice(Math.max(0, box.top - 6), box.top).join(" ").replace(/\s+/g, " "));
}

/**
 * Whether the item for the background tasks in the footer under the prompt box ("1 shell", "2 local agents") has the
 * keys: ↓ from the prompt box gives it to it, and Claude Code then draws it in reverse video. Enter then opens the list
 * of background tasks. When only subagents run, ↓ selects the row of agents under the footer instead, which is not
 * this.
 */
export function tasksItemFocused(s: Screen): boolean {
  const lines = screenLines(s.plain);
  const box = promptBox(lines);
  if (!box || !s.reversed) return false;
  const footer = s.reversed.split("\n").slice(box.bottom + 1, box.bottom + 3).join(" ");
  return /\b\d+ [a-z]/i.test(footer.replace(/\s+/g, " "));
}

/**
 * Whether ↓ from the prompt box gave the keys to the row of subagents under the footer ("❯ ● main", shown while
 * subagents run) instead of the item for the background tasks; ↑ gives them back to the prompt box.
 */
export function agentRowFocused(screen: string): boolean {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  return box !== undefined && lines.slice(box.bottom + 1).some((l) => /^\s*❯\s*[●◯○◉]\s/.test(l));
}

/** A row of Claude Code's list of background tasks (/tasks). */
export interface TaskRow {
  /** What the row shows of the task (a shell's command, a subagent's description), cut with "…" to fit. */
  label: string;
  /** The word after it: "running", "done", … */
  state: string;
  /** The row has the cursor (❯). */
  selected: boolean;
  /** The group it is listed in ("Shells", "Local agents", "Completed", …), or for a list of one group, what its summary says ("1 active shell"). */
  group: string;
}

/**
 * Claude Code's list of background tasks, or its view of one task (shown at once when /tasks finds only one; ← goes
 * back to the list from it). `cursorAway`: the cursor is on a row that is no task ("Earlier in this session").
 */
export type TasksDialog = { view: "list"; summary: string; rows: TaskRow[]; cursorAway: boolean } | { view: "details" };

/** The hints at the bottom of the list ("↑/↓ to select · Enter to view · x to stop · Esc to close"), and of one task's view. */
const TASK_LIST_HINT_RE = /↑\/↓ to select\b.*\bEsc to close/;
const TASK_DETAILS_HINT_RE = /← to go back\b.*\bto close\b/;
/** "❯ ● sleep 900          running", "✔ slow helper   done · Haiku 5.5": a status mark, the label, then its state. */
const TASK_ROW_RE = /^\s*(❯\s*)?[●◯○◉◎✔✓✗✘×■◆⏺]\s+(.+?)\s{2,}([a-z]+)\b/;
/** "Shells (2)", "Local agents (1)", "Completed (1)": a group's heading. */
const TASK_GROUP_RE = /^\s*([A-Z][A-Za-z ]*?) \(\d+\)\s*$/;
const TASK_EARLIER_RE = /Earlier in this session/;
/** The states of a row whose task has ended. */
const ENDED_STATES = new Set(["done", "completed", "failed", "error", "stopped", "killed", "cancelled", "canceled"]);

/** Claude Code's list of background tasks (or the view of one), when it is at the bottom of the screen. */
export function tasksDialog(screen: string): TasksDialog | undefined {
  const lines = screenLines(screen);
  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end--;
  const tail = lines.slice(Math.max(0, end - 3), end).join(" ").replace(/\s+/g, " ");
  if (TASK_DETAILS_HINT_RE.test(tail)) return { view: "details" };
  if (!TASK_LIST_HINT_RE.test(tail)) return undefined;
  // The list runs from its heading ("Background") down to the hints.
  let top = end - 1;
  while (top >= 0 && lines[top]!.trim() !== "Background") top--;
  if (top < 0) return undefined;
  const body = lines.slice(top + 1, end).filter(Boolean);
  const summary = body[0]?.trim() ?? "";
  const rows: TaskRow[] = [];
  let group = summary;
  let cursorAway = false;
  for (const line of body.slice(1)) {
    const row = TASK_ROW_RE.exec(line);
    if (row) {
      rows.push({ label: row[2]!.trim(), state: row[3]!, selected: Boolean(row[1]), group });
      continue;
    }
    if (TASK_EARLIER_RE.test(line)) {
      // Rows under it (when it is opened) are tasks of earlier, ended ones.
      group = "Earlier in this session";
      if (/^\s*❯/.test(line)) cursorAway = true;
      continue;
    }
    const heading = TASK_GROUP_RE.exec(line);
    if (heading) group = heading[1]!;
  }
  return { view: "list", summary, rows, cursorAway };
}

/** Whether a row of the list is a task that still runs (and can be stopped). */
export function taskRowActive(row: TaskRow): boolean {
  return !ENDED_STATES.has(row.state) && !/^(Completed|Earlier in this session)$/.test(row.group);
}

/** What kind of task a row of the list is, by its group's heading (or the list's summary): undefined when it does not say. */
export function taskRowKind(row: TaskRow): BackgroundTaskKind | undefined {
  if (/shell/i.test(row.group)) return "shell";
  if (/monitor/i.test(row.group)) return "monitor";
  if (/workflow/i.test(row.group)) return "workflow";
  if (/agent|team/i.test(row.group)) return "agent";
  return undefined;
}

/**
 * Whether a row of the list shows a task: its label is one of `texts` (the task's command, its title), or the start
 * of one when the list cut it ("…"). Spaces and line breaks count as one space.
 */
export function taskRowShows(row: TaskRow, texts: (string | undefined)[]): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const label = norm(row.label);
  const cut = label.endsWith("…");
  const head = cut ? label.slice(0, -1).trimEnd() : label;
  if (!head) return false;
  return texts.some((t) => t !== undefined && (cut ? norm(t).startsWith(head) : norm(t) === head));
}

/** An input waiting to be typed, and what to switch first (for this session only). */
export interface QueuedInput {
  /** The request that asked for it, so its outcome goes back to that request only. */
  id?: string;
  text: string;
  model?: SessionModel;
  effort?: EffortLevel;
  ultracode?: boolean;
  /**
   * Enter was pressed for this text (at `enteredAt`), but the prompt box still held it when Gasho stopped waiting.
   * The text is never typed again (that could send it twice). A later try drops it if Claude Code has taken it
   * since, and presses Enter only if the box still holds it.
   */
  entered?: boolean;
  enteredAt?: number;
  /** The session was seen busy since Enter was pressed: Claude Code took it (used when its transcript is not read). */
  seenBusy?: boolean;
  /**
   * Sent by gasho-daemon on its own, not asked for by anyone (the name from the first message; see
   * ManagedSession.autoName). It never empties a prompt box that holds text, which someone may be typing in the
   * session's terminal: it waits until the box is empty. It does not count as an input waiting (`pendingInputs`).
   */
  auto?: boolean;
}

/**
 * Commands that would change Claude Code's defaults for every new session, not only this one: `/model …` and
 * `/effort …` (except `/effort ultracode on|off`, which is for this session only). The chat box switches them for this
 * session instead. Returns the reason, or undefined when the text can be sent.
 */
export function refusedCommand(text: string): string | undefined {
  if (/^\s*\/model(?=\s|$)/i.test(text)) {
    return "モデルは、入力欄のモデルの選択で切り替えてください。/model で切り替えると、これから始めるすべてのセッションの既定のモデルも変わります。";
  }
  if (/^\s*\/effort(?=\s|$)/i.test(text) && !/^\s*\/effort\s+ultracode\s+(on|off)\s*$/i.test(text)) {
    return "Effort は、入力欄の Effort のボタンで切り替えてください。/effort で切り替えると、これから始めるすべてのセッションの既定の Effort も変わります（/effort ultracode on と off は、このセッションだけなので送れます）。";
  }
  return undefined;
}

/**
 * Why an input in Claude Code's shell mode ("!" and a command, `body` trimmed) cannot be typed, or undefined: one with
 * nothing after the "!", or one with files, which would be mentioned on lines of their own after the command (@path)
 * and run by the shell too.
 */
export function shellInputProblem(body: string, files: number): string | undefined {
  if (!body.startsWith("!")) return undefined;
  if (!body.slice(1).trim()) return "「!」のあとに、実行するコマンドを入れてください。";
  if (files > 0) return "シェルのコマンド（「!」で始まる入力）には、ファイルを添付できません。";
  return undefined;
}

/** Claude Code's effort levels, lowest first; ←/→ in the /model picker steps through them. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_WORD = "(low|medium|high|xhigh|max)";

/**
 * The lines of the /model picker between its title ("Select model") and its key help ("Enter to set as default ·
 * s to use this session only · Esc to cancel", which wraps in a narrow pane). The picker is drawn at the bottom of the
 * screen, so only the last title counts, and nothing but the rest of the key help may follow it: the conversation
 * above can quote a picker. Undefined when the picker is not open.
 */
function pickerLines(screen: string): string[] | undefined {
  const lines = screenLines(screen);
  const start = lines.findLastIndex((l) => /^\s*Select model\s*$/.test(l));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /Enter to set as default|Esc to cancel/.test(l));
  if (end < 0 || lines.slice(end + 1).filter(Boolean).length > 3) return undefined;
  return lines.slice(start + 1, end);
}

/** The effort level the /model picker shows ("◐ Medium effort (default) ←/→ to adjust"). */
export function pickerEffort(screen: string): EffortLevel | undefined {
  const re = new RegExp(`\\b${EFFORT_WORD} effort\\b`, "i");
  for (const line of pickerLines(screen) ?? []) {
    const m = re.exec(line);
    if (m?.[1]) return m[1].toLowerCase() as EffortLevel;
  }
  return undefined;
}

/**
 * Whether the prompt box says ultracode is on: Claude Code writes "ultracode" into the rule above the box while it
 * is on. Undefined when the screen shows no prompt box.
 */
export function promptRuleUltracode(screen: string): boolean | undefined {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  return box && /\bultracode\b/i.test(lines[box.top] ?? "");
}

/**
 * The effort level and ultracode as Claude Code shows them, for a while after a change, on the line right above the
 * prompt box ("◐ medium · ultracode · /effort"). Only that line counts: the terminal can still show such lines from
 * earlier frames higher up. Undefined when the line is not there.
 */
export function statusLine(screen: string): { effort: EffortLevel; ultracode: boolean } | undefined {
  const lines = screenLines(screen);
  const box = promptBox(lines);
  if (!box) return undefined;
  const m = new RegExp(`\\b${EFFORT_WORD}\\b(\\s*·\\s*ultracode)?\\s*·\\s*/effort\\s*$`, "i").exec(lines[box.top - 1] ?? "");
  if (!m?.[1]) return undefined;
  return { effort: m[1].toLowerCase() as EffortLevel, ultracode: Boolean(m[2]) };
}

/** One line of Claude Code's /model picker. */
export interface PickerOption {
  label: string;
  /** The start of the description column ("Sonnet 5.5 ·" for "Default (recommended)"). */
  detail?: string;
  /** The picker's cursor (❯) is on this line. */
  cursor: boolean;
  /** The model the session uses now (✔). */
  current: boolean;
}

/** The options of Claude Code's /model picker (see pickerLines). Empty when the picker is not open. */
export function modelPickerOptions(screen: string): PickerOption[] {
  const options: PickerOption[] = [];
  for (const line of pickerLines(screen) ?? []) {
    const m = /^\s*(❯\s*)?\d+\.\s+(\S.*?)(?:\s{2,}(\S.*))?$/.exec(line);
    if (!m?.[2]) continue;
    options.push({
      label: m[2].replace(/\s*✔\s*$/, "").trim(),
      ...(m[3] ? { detail: m[3].trim() } : {}),
      cursor: Boolean(m[1]),
      current: m[2].includes("✔"),
    });
  }
  return options;
}

/**
 * The models of the /model picker by Claude Code's names: "Opus 5.5", and for "default" the model it stands for
 * ("Sonnet 5.5"), read from the start of its description.
 */
export function pickerCatalog(options: PickerOption[]): ModelOption[] {
  const ids: SessionModel[] = ["default", "opus", "fable", "sonnet", "haiku"];
  const out: ModelOption[] = [];
  for (const id of ids) {
    const o = options.find((x) => pickerMatches(x.label, id));
    if (!o) continue;
    const name = id === "default" ? (o.detail?.split("·")[0]?.trim() ?? "") : o.label;
    out.push({ id, name: name || o.label });
  }
  return out;
}

/** Which picker line stands for a model ("Default (recommended)", "Opus 5.5", …). */
export function pickerMatches(label: string, model: SessionModel): boolean {
  return new RegExp(`^${model === "default" ? "Default" : model}\\b`, "i").test(label);
}

/**
 * A file name that is safe on disk and in an `@path` mention: letters (any script), digits, dot, dash and underscore;
 * everything else becomes "_". The end of the name (with its extension) is kept when it is long.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "");
  return cleaned.slice(-100) || "file";
}

export interface ManagedSession {
  sessionId: string;
  /** The session's terminal, by name (gasho-<name>-xxxx; see terminal.ts). */
  terminal: string;
  /**
   * The terminal is a zellij session: gasho-daemon 0.10 and before started it. Saved as `zellijSession`, as they
   * saved it, so that going back to one of them keeps these sessions.
   */
  zellij?: boolean;
  /** Claude Code's PID. */
  pid: number;
  cwd: string;
  name: string;
  launchedAt: number;
  /** A fork: the session it was forked from, and when (its transcript starts with a copy of that conversation). */
  forkOf?: string;
  forkedAt?: number;
  /**
   * Started without a name (so named "<folder>-gasho" for now): it is named after its first message, with the title
   * Claude Code gives the conversation from it (`ai-title`). Cleared once Claude Code records a name for it (the
   * /rename sent for that title, or one given in its terminal) or it is renamed from Gasho, so it happens once, and
   * a /rename lost with a restart of gasho-daemon (waiting inputs are not saved) is sent again.
   */
  autoName?: boolean;
}

/** Names of sessions started from Gasho: at most this many characters. */
export const MAX_SESSION_NAME = 60;

/**
 * The name a session takes from Claude Code's title of its conversation (see ManagedSession.autoName): one line,
 * clipped to the length a name may have. Undefined when nothing is left.
 */
export function titleName(title: string): string | undefined {
  const line = title.replace(/[\p{Cc}\s]+/gu, " ").trim();
  let name = "";
  // By characters, not UTF-16 units, so no emoji is cut in half.
  for (const ch of line) {
    if (name.length + ch.length > MAX_SESSION_NAME) break;
    name += ch;
  }
  return name.trimEnd() || undefined;
}

/**
 * Checks a session's name for Gasho and for Claude Code's /rename, which takes the rest of its line. Returns the name
 * without spaces around it, or an error message.
 */
export function sessionName(name: string): { name: string } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "名前を入れてください。" };
  if (trimmed.length > MAX_SESSION_NAME) return { error: `名前は${MAX_SESSION_NAME}文字までです。` };
  if (/\p{Cc}/u.test(trimmed)) return { error: "名前に改行や制御文字は使えません。" };
  return { name: trimmed };
}

/** What renames a session in Claude Code (and its Remote Control session, so in the official apps too). */
export function renameCommand(name: string): string {
  return `/rename ${name}`;
}

/** Whether an input is a /rename (or its alias /name). */
export function isRename(text: string): boolean {
  return /^\s*\/(?:re)?name(?=\s|$)/.test(text);
}

/** The name of a fork, when none is given: the session's name and "のフォーク", within the length allowed. */
export function forkName(of: string): string {
  const suffix = " のフォーク";
  return `${of.slice(0, MAX_SESSION_NAME - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Environment for the terminals and the Claude Code they start. Nothing else is inherited: the daemon may itself run
 * inside Claude Code or zellij (CLAUDECODE, ZELLIJ_SESSION_NAME, …), which would confuse both. XDG_RUNTIME_DIR lets
 * systemd-run reach the user's systemd.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" };
  for (const k of ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * The name of a new session's terminal: "gasho-", the start of `label` in lowercase letters and digits, and a random
 * suffix. It names the terminal's socket and its systemd scope too, and `gasho-daemon attach` takes it.
 */
export function terminalName(label: string, suffix = randomBytes(2).toString("hex")): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `gasho-${slug || "session"}-${suffix}`;
}

/**
 * `systemd-run` arguments that run a command in a systemd user scope of its own (`<unit>.scope`). Every process that a
 * service starts belongs to the service's unit, and stopping the unit stops them all (systemd's default KillMode): a
 * session that gasho-daemon's service started would end with each restart of gasho-daemon. In a scope, it goes on.
 * `extra`: what this machine's systemd-run needs to run the command as it is given (see NO_EXPANSION).
 */
export function scopeArgs(unit: string, extra: readonly string[] = []): string[] {
  return ["--user", "--scope", "--quiet", "--collect", ...extra, `--unit=${unit}`, "--"];
}

/**
 * systemd 254 and later expand "$VAR" in the command that systemd-run runs, also with --scope, and make "$$" a "$": a
 * path with a "$" in it would reach the command changed. `--expand-environment=no` runs the command as it is given.
 * Older versions lack the switch, and expand nothing.
 */
export const NO_EXPANSION: readonly string[] = ["--expand-environment=no"];

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin wrapper over the zellij CLI, for the sessions that gasho-daemon 0.10 and before started in zellij, until they
 * end; new sessions get a terminal of their own (terminal.ts). Every call names the session explicitly.
 */
export class Zellij {
  private env: Record<string, string>;

  constructor(env: Record<string, string>) {
    this.env = env;
  }

  async run(args: string[]): Promise<string> {
    const { stdout } = await execFileP("zellij", args, { env: this.env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  async available(): Promise<boolean> {
    try {
      await this.run(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Names of sessions that are running (not the resurrectable, exited ones). */
  async liveSessions(): Promise<Set<string>> {
    const out = await this.run(["list-sessions", "--no-formatting"]).catch(() => "");
    const names = new Set<string>();
    for (const line of out.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (name && !line.includes("EXITED")) names.add(name);
    }
    return names;
  }

  /** The pane's screen, with what is drawn dim told apart (see Screen). */
  async screen(session: string): Promise<Screen> {
    return readScreen(await this.run(["--session", session, "action", "dump-screen", "-p", PANE, "--ansi"]));
  }

  async paste(session: string, text: string): Promise<void> {
    await this.run(["--session", session, "action", "paste", "-p", PANE, text]);
  }

  async keys(session: string, ...keys: string[]): Promise<void> {
    await this.run(["--session", session, "action", "send-keys", "-p", PANE, ...keys]);
  }

  async kill(session: string): Promise<void> {
    await this.run(["kill-session", session]).catch(() => "");
    await this.run(["delete-session", session]).catch(() => "");
  }
}

/** The sessions Gasho started and the input waiting for each, persisted so a daemon restart keeps them. */
export class ManagedSessions {
  private file: string;
  private sessions = new Map<string, ManagedSession>();
  private queues = new Map<string, QueuedInput[]>();

  constructor(file: string) {
    this.file = file;
  }

  async load(keep: (m: ManagedSession) => Promise<boolean>): Promise<void> {
    let list: (ManagedSession & { zellijSession?: string })[] = [];
    try {
      list = JSON.parse(await fs.readFile(this.file, "utf8")) as typeof list;
    } catch {
      return;
    }
    for (const saved of list) {
      // Saved by gasho-daemon 0.10 or before, or saved for a session in zellij (see save).
      const { zellijSession, ...rest } = saved;
      const m: ManagedSession = zellijSession !== undefined ? { ...rest, terminal: zellijSession, zellij: true } : rest;
      if (await keep(m)) this.sessions.set(m.sessionId, m);
    }
    await this.save();
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // A session in zellij is saved the way gasho-daemon 0.10 and before saved it (see ManagedSession.zellij).
    const list = [...this.sessions.values()].map(({ terminal, zellij, ...rest }) =>
      zellij ? { ...rest, zellijSession: terminal } : { ...rest, terminal },
    );
    await fs.writeFile(this.file, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  add(m: ManagedSession): void {
    this.sessions.set(m.sessionId, m);
  }

  /** Whether the name changed. */
  setName(sessionId: string, name: string): boolean {
    const m = this.sessions.get(sessionId);
    if (!m || m.name === name) return false;
    m.name = name;
    return true;
  }

  /** The session is named now, so it no longer takes a name from its first message. Whether it was still to. */
  named(sessionId: string): boolean {
    const m = this.sessions.get(sessionId);
    if (!m?.autoName) return false;
    delete m.autoName;
    return true;
  }

  /**
   * Takes waiting inputs off the queue that `match`, except one whose Enter was pressed already (Claude Code may have
   * taken it). Returns how many were taken off.
   */
  drop(sessionId: string, match: (input: QueuedInput) => boolean): number {
    const q = this.queues.get(sessionId);
    if (!q) return 0;
    const kept = q.filter((input) => input.entered || !match(input));
    this.queues.set(sessionId, kept);
    return q.length - kept.length;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.queues.delete(sessionId);
  }

  enqueue(sessionId: string, input: QueuedInput): number {
    const q = this.queues.get(sessionId) ?? [];
    q.push(input);
    this.queues.set(sessionId, q);
    return q.length;
  }

  next(sessionId: string): QueuedInput | undefined {
    return this.queues.get(sessionId)?.shift();
  }

  /** Puts a message back at the front, e.g. when sending it failed. */
  unshift(sessionId: string, input: QueuedInput): void {
    const q = this.queues.get(sessionId) ?? [];
    q.unshift(input);
    this.queues.set(sessionId, q);
  }

  pending(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** The input that is sent next, without taking it off the queue. */
  peek(sessionId: string): QueuedInput | undefined {
    return this.queues.get(sessionId)?.[0];
  }

  /** The inputs waiting, the next first. */
  waiting(sessionId: string): readonly QueuedInput[] {
    return this.queues.get(sessionId) ?? [];
  }
}

/** Folders Claude Code already trusts (from ~/.claude.json, an internal file) plus the given ones, if they exist. */
export async function launchableFolders(homeDir: string, extra: string[]): Promise<string[]> {
  const candidates = new Set(extra);
  try {
    const data = JSON.parse(await fs.readFile(path.join(homeDir, ".claude.json"), "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    for (const [dir, p] of Object.entries(data.projects ?? {})) if (p?.hasTrustDialogAccepted === true) candidates.add(dir);
  } catch {
    // unreadable: offer only the folders of running sessions
  }
  const under = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
  const tmp = os.tmpdir();
  const out: string[] = [];
  for (const dir of candidates) {
    // Skip the home folder itself and scratch folders, which are not projects.
    if (dir === homeDir || (under(dir, tmp) && !under(dir, homeDir))) continue;
    try {
      if ((await fs.stat(dir)).isDirectory()) out.push(dir);
    } catch {
      // gone
    }
  }
  return out.sort();
}

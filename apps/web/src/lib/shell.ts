// Claude Code's shell mode: an input that starts with "!" is run as a shell command in the session's folder, not sent
// to Claude. Claude Code records the command and what it printed as two user messages, once the command has ended:
// "<bash-input>ls</bash-input>", then "<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>" (a command that
// fails has all of its output in the stderr part). gasho-daemon sends them as they are, cut short when long.

const INPUT_RE = /^\s*<bash-input>([\s\S]*?)(?:<\/bash-input>\s*)?$/;
const STDOUT_OPEN = "<bash-stdout>";
const STDOUT_CLOSE = "</bash-stdout>";
const STDERR_RE = /^<bash-stderr>([\s\S]*?)(?:<\/bash-stderr>)?$/;

/** Whether an input is a shell command for Claude Code's shell mode. */
export function isShellInput(text: string): boolean {
  return text.startsWith("!");
}

/** A shell command with nothing after the "!", which Claude Code would not run. */
export function emptyShellInput(text: string): boolean {
  return isShellInput(text) && !text.slice(1).trim();
}

/** The command of a recorded shell-mode input, or undefined for any other text. */
export function shellCommand(text: string): string | undefined {
  return INPUT_RE.exec(text)?.[1];
}

/** What a shell-mode command printed, as recorded, or undefined for any other text. A part cut short is kept as it is. */
export function shellOutput(text: string): { stdout: string; stderr: string } | undefined {
  const t = text.trim();
  if (!t.startsWith(STDOUT_OPEN)) return undefined;
  const rest = t.slice(STDOUT_OPEN.length);
  const end = rest.indexOf(STDOUT_CLOSE);
  if (end < 0) return { stdout: rest, stderr: "" };
  const err = STDERR_RE.exec(rest.slice(end + STDOUT_CLOSE.length).trim());
  return { stdout: rest.slice(0, end), stderr: err?.[1] ?? "" };
}

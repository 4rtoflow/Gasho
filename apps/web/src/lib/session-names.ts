// Names of sessions started from Gasho, as gasho-daemon and the Gasho server check them: one line, at most 60
// characters. Claude Code's /rename takes the rest of its line as the name.

export const MAX_SESSION_NAME = 60;

/** Why a name cannot be used, or undefined. Spaces around it do not count. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "名前を入れてください。";
  if (trimmed.length > MAX_SESSION_NAME) return `名前は${MAX_SESSION_NAME}文字までです。`;
  if (/\p{Cc}/u.test(trimmed)) return "名前に改行や制御文字は使えません。";
  return undefined;
}

/** The name a fork gets unless another is typed: the session's name and "のフォーク", as gasho-daemon names it. */
export function forkName(of: string): string {
  const suffix = " のフォーク";
  return `${of.slice(0, MAX_SESSION_NAME - suffix.length).trimEnd()}${suffix}`;
}

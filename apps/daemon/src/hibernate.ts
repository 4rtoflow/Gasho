// Sessions started from Gasho that nobody uses are hibernated: their Claude Code and terminal end, the session stays in
// Gasho, and `claude --resume` brings it back when it is used (docs/spec.md, docs/research.md 検証12). What decides
// is kept here, free of the daemon, so that it can be tested alone.
import type { EffortLevel } from "@gasho/protocol";

/**
 * Claude Code's prompt cache lasts an hour, so a session left for longer reads its conversation again on the next
 * message whether it was stopped or not: hibernating it after that costs no extra usage.
 */
export const MIN_HIBERNATE_MINUTES = 60;
export const DEFAULT_HIBERNATE_MINUTES = 90;

/**
 * After how long without activity sessions are hibernated; undefined when it is turned off (`GASHO_HIBERNATE=off`).
 * `GASHO_HIBERNATE_AFTER_MINUTES` below the minimum counts as the minimum; one that is no number is ignored.
 */
export function hibernateAfterMs(env: NodeJS.ProcessEnv): number | undefined {
  if (env.GASHO_HIBERNATE?.trim().toLowerCase() === "off") return undefined;
  const raw = env.GASHO_HIBERNATE_AFTER_MINUTES?.trim();
  const asked = raw ? Number(raw) : Number.NaN;
  const minutes = Number.isFinite(asked) ? Math.max(asked, MIN_HIBERNATE_MINUTES) : DEFAULT_HIBERNATE_MINUTES;
  return minutes * 60_000;
}

/** The permission modes a session is brought back in, by the name `--permission-mode` takes. */
export type PermissionMode = "manual" | "acceptEdits" | "plan" | "auto" | "dontAsk";

/** What is known about a session started from Gasho when deciding whether to hibernate it. */
export interface HibernateFacts {
  /** It runs in zellij (started by gasho-daemon 0.10 or before). */
  zellij: boolean;
  /** This machine can start a terminal again, the session has a transcript to resume, and its folder is there. */
  resumable: boolean;
  /** The session's state in Gasho. */
  status: string;
  /** Claude Code's own state ("shell" while shells or monitors run on, which Gasho shows as idle). */
  claudeStatus?: string;
  /** Background work still running. */
  background: number;
  /** Inputs waiting to be typed, and permission requests or questions waiting for an answer. */
  pendingInputs: number;
  permissionRequests: number;
  /**
   * Claude's question (AskUserQuestion) has no answer in the transcript yet. Told apart from the state and the screen:
   * neither of those may show it (a hook gone with a restart, a state not written), and a session hibernated with it
   * would lose the answer. Only an answer, or something the person writes or stops, ends it (see TranscriptMeta.question).
   */
  question: boolean;
  /** gasho-daemon is typing into it, switching its model, or otherwise working on it. */
  operating: boolean;
  /** Claude scheduled work in this process (CronCreate, ScheduleWakeup), which would be lost with it. */
  scheduled: boolean;
  /** What the prompt box holds: undefined when it is not shown (a dialog has the keys). */
  typed: string | undefined;
  /** Someone has its terminal open (`gasho-daemon attach`). */
  attached: boolean;
  /** The permission mode under the prompt box: undefined when it cannot be told, or cannot be gone back to. */
  permissionMode: PermissionMode | undefined;
  /** When it was last used, as far as each source knows: the latest counts. */
  activity: (number | undefined)[];
}

/** Whether a session has been left alone for `afterMs` and can be stopped without losing anything. */
export function mayHibernate(f: HibernateFacts, now: number, afterMs: number): boolean {
  if (f.zellij || !f.resumable) return false;
  if (f.status !== "idle" || (f.claudeStatus !== undefined && f.claudeStatus !== "idle")) return false;
  if (f.background > 0 || f.pendingInputs > 0 || f.permissionRequests > 0 || f.question) return false;
  if (f.operating || f.scheduled || f.attached || f.typed !== "") return false;
  // Coming back in another mode could run what this one would have asked about.
  if (f.permissionMode === undefined) return false;
  const last = Math.max(0, ...f.activity.map((at) => at ?? 0));
  // Never used, as far as anything says: not known to be left alone.
  return last > 0 && now - last >= afterMs;
}

/** What a session goes on with after a resume, which `claude --resume` does not bring back by itself. */
export interface ResumeState {
  /** "Opus 5.5", as Gasho shows it. */
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

/** A model's name without what is said after it: "Opus 4.6" for "Opus 4.6 (1M context)". */
export function baseModel(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "");
}

/**
 * The name to resume a session's model by. A reply records only the model ("Opus 4.6"), and `--model` without `[1m]`
 * would bring a session that used the 1M context window back with 200K: `named` are the names Claude Code gave that
 * model in full, the most reliable first. One of another model says nothing about this one.
 */
export function resumeModel(current: string | undefined, ...named: (string | undefined)[]): string | undefined {
  if (current === undefined) return undefined;
  return named.find((n) => n !== undefined && baseModel(n) === baseModel(current)) ?? current;
}

/**
 * The value of `--model` for a model as Gasho names it: "Opus 5.5" is claude-opus-5-5, "Opus 4.6 (1M context)"
 * claude-opus-4-6[1m]. Undefined for a name that says no such model: Claude Code then goes on with that of the last reply.
 */
export function modelFlag(name: string | undefined): string | undefined {
  const m = /^(?:Claude\s+)?([a-z]+)\s+(\d+)(?:\.(\d+))?\s*(\(.*\))?\s*$/i.exec(name?.trim() ?? "");
  if (!m?.[1] || !m[2]) return undefined;
  const id = `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? `-${m[3]}` : ""}`;
  return /\b1M\b/i.test(m[4] ?? "") ? `${id}[1m]` : id;
}

/**
 * The arguments that bring a hibernated session back as it was. Claude Code goes back to its default effort, to the
 * model of the last reply (a switch made after that is lost), and after /clear to its default permission mode, as the
 * new transcript does not record the mode. These flags are for this session only: none is saved to the settings.
 */
export function resumeArgs(sessionId: string, state: ResumeState): string[] {
  const model = modelFlag(state.model);
  return [
    "--resume",
    sessionId,
    ...(model ? ["--model", model] : []),
    ...(state.effort ? ["--effort", state.effort] : []),
    ...(state.permissionMode ? ["--permission-mode", state.permissionMode] : []),
  ];
}

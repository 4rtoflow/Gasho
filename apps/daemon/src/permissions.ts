// Permission requests that Claude Code asks through the PermissionRequest hook. The hook's HTTP response is held until
// the request is answered in Gasho; Claude Code shows its own dialog meanwhile, so the request can also be answered in
// the terminal or the official apps, and then Gasho lets go of it (answering the hook with no decision).
// Two tools ask the person for more than a yes: AskUserQuestion (questions with options) and ExitPlanMode (a plan to
// approve). For them, "allow" alone answers nothing and Claude Code keeps its dialog open: the answers, or the plan,
// go back in the tool's input (updatedInput), as Claude Code's hooks documentation says.
import { randomUUID } from "node:crypto";
import type { AskedOption, AskedQuestion, PermissionDecision, PermissionRequestInfo, PlanMode, QuestionAnswer } from "@gasho/protocol";
import { clip, inputSummary, str } from "./util.ts";

/** What the hook answers: a decision, or nothing (Claude Code goes on with its own dialog). */
export type HookReply = (body: Record<string, unknown> | undefined) => void;

interface Held {
  info: PermissionRequestInfo;
  sessionId: string;
  toolName: string;
  /** The tool input as Claude Code sent it: AskUserQuestion's and ExitPlanMode's go back with the answer. */
  input: Record<string, unknown>;
  /** What finds the call when its PostToolUse comes (answered elsewhere); see callKey. */
  callKey: string;
  /** The allow rules "allow from now on" applies (see alwaysSuggestions). */
  suggestions: Record<string, unknown>[];
  /** Claude Code's status showed the session waiting since the request came. */
  sawWaiting: boolean;
  reply: HookReply;
}

/** What an answer from Gasho may carry besides the decision (see `answer`). */
export interface AnswerDetails {
  answers?: QuestionAnswer[];
  mode?: PlanMode;
  message?: string;
}

/** The tool input shown in Gasho: pretty JSON, clipped. */
const MAX_INPUT = 4000;
/** A plan shown in Gasho, clipped. The plan Claude Code gets back is the one it sent, whole. */
const MAX_PLAN = 40_000;
/** What one answer to a question may say, written in Gasho. */
const MAX_ANSWER = 4000;

/** What Gasho answers when the person denies: Claude stops, as with "No" in the terminal, and waits for them. */
const DENY_MESSAGE = "The user denied this in Gasho.";
/** …and when they deny with a message: Claude is told it and goes on, as with feedback in the terminal. */
const DENY_WITH_MESSAGE = "The user declined this in Gasho and said:";

/**
 * The suggestions "allow from now on" applies: rules that allow the tool. The others are left out: a folder added to
 * the session does not spare the next prompt for a command, and a change of mode (accept edits) is more than this one
 * request asks for.
 */
export function alwaysSuggestions(suggestions: unknown[]): Record<string, unknown>[] {
  return suggestions.filter(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === "object" && (s as Record<string, unknown>).type === "addRules" && (s as Record<string, unknown>).behavior === "allow",
  );
}

/**
 * What those rules allow, in Claude Code's notation ("Bash(npm test:*)"), and "（このセッションのみ）" when they are
 * kept only for the session.
 */
export function alwaysLabel(rules: Record<string, unknown>[]): string | undefined {
  const parts: string[] = [];
  for (const s of rules) {
    for (const r of Array.isArray(s.rules) ? s.rules : []) {
      const rule = r as Record<string, unknown>;
      const tool = str(rule.toolName);
      if (!tool) continue;
      const content = str(rule.ruleContent);
      parts.push(content ? `${tool}(${content})` : tool);
    }
  }
  if (parts.length === 0) return undefined;
  const sessionOnly = rules.every((s) => s.destination === "session");
  return `${parts.join("、")}${sessionOnly ? "（このセッションのみ）" : ""}`;
}

/**
 * What finds a call's PostToolUse from its PermissionRequest: the tool input. AskUserQuestion's PostToolUse carries
 * the answers besides the questions, and ExitPlanMode's carries no input at all (Claude Code puts the plan into the
 * PermissionRequest only), so those two go by their questions, and by the tool alone.
 */
export function callKey(toolName: string | undefined, input: unknown): string {
  if (toolName === "ExitPlanMode") return "";
  if (toolName === "AskUserQuestion") return JSON.stringify((input as { questions?: unknown } | null | undefined)?.questions ?? null);
  return JSON.stringify(input ?? {});
}

/** AskUserQuestion's questions as Gasho shows them (clipped); undefined when they are not as Claude Code sends them. */
export function askedQuestions(input: Record<string, unknown>): AskedQuestion[] | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions as unknown[]) {
    const q = (raw ?? {}) as Record<string, unknown>;
    const question = str(q.question);
    if (!question || !Array.isArray(q.options)) return undefined;
    const options: AskedOption[] = [];
    for (const rawOption of q.options as unknown[]) {
      const o = (rawOption ?? {}) as Record<string, unknown>;
      const label = str(o.label);
      if (label === undefined) return undefined;
      const description = str(o.description);
      const preview = str(o.preview);
      options.push({
        label: clip(label, 300),
        // Claude sometimes repeats the label as the description.
        ...(description && description !== label ? { description: clip(description, 2000) } : {}),
        ...(preview ? { preview: clip(preview, 8000) } : {}),
      });
    }
    const header = str(q.header);
    out.push({ question: clip(question, 4000), ...(header ? { header: clip(header, 60) } : {}), options, ...(q.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return out;
}

/**
 * The answers AskUserQuestion takes: each question's text → the labels of the options chosen and what was written,
 * joined with ", " (as Claude Code joins a multiSelect question's labels). `input` is the tool input as Claude Code
 * sent it, so labels and questions are whole even where Gasho showed them clipped. A string is an error message: a
 * question is left unanswered, or an answer does not fit its question.
 */
export function questionAnswers(input: Record<string, unknown>, given: QuestionAnswer[] | undefined): Record<string, string> | string {
  const questions = input.questions as Array<{ question: string; options: Array<{ label: string }>; multiSelect?: boolean }>;
  if (!Array.isArray(given) || given.length !== questions.length) return "すべての質問に答えてください。";
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = given[i];
    const picked = Array.isArray(a?.picked) ? a.picked : [];
    const text = typeof a?.text === "string" ? a.text.trim() : "";
    const fits =
      picked.every((k) => Number.isInteger(k) && k >= 0 && k < q.options.length) &&
      new Set(picked).size === picked.length &&
      (q.multiSelect === true || picked.length + (text ? 1 : 0) <= 1);
    if (!fits) return "答えが質問に合っていません。画面を読み込み直してから、もう一度答えてください。";
    const parts = [...[...picked].sort((x, y) => x - y).map((k) => q.options[k]?.label ?? ""), ...(text ? [clip(text, MAX_ANSWER)] : [])];
    if (parts.length === 0) return "すべての質問に答えてください。";
    answers[q.question] = parts.join(", ");
  }
  return answers;
}

/** How the id of a question shown from the transcript starts (see openQuestionRequest). */
export const OPEN_QUESTION = "question:";

/**
 * Claude's question as the transcript has it, as a request that Gasho can answer although gasho-daemon holds no hook
 * for it (see PermissionRequestInfo.answerAsMessage); undefined when its questions are not as Claude Code sends them.
 */
export function openQuestionRequest(q: { toolUseId: string; input: Record<string, unknown>; at?: number }): PermissionRequestInfo | undefined {
  const questions = askedQuestions(q.input);
  if (!questions) return undefined;
  return {
    id: `${OPEN_QUESTION}${q.toolUseId}`,
    toolName: "AskUserQuestion",
    input: clip(JSON.stringify(q.input, null, 2), MAX_INPUT),
    summary: clip(questions[0]?.question ?? "", 200),
    at: q.at ?? 0,
    questions,
    answerAsMessage: true,
  };
}

/**
 * The message that answers Claude's questions once their dialog has been closed: each question (on one line) and its
 * answer, as questionAnswers makes them. Written to Claude on the person's behalf, in the language of Gasho's screens.
 */
export function answersMessage(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([q, a]) => `- 「${clip(q.replace(/\s+/g, " ").trim(), 300)}」→ ${a}`);
  return ["さきほどの質問への答えです（Gasho から答えたため、質問の画面は閉じました）。", ...lines].join("\n");
}

/** A plan's title: its first line with text, without Markdown's heading marks. */
function planTitle(plan: string): string {
  const line = plan
    .split("\n")
    .map((l) => l.replace(/^\s*#+\s*/, "").trim())
    .find(Boolean);
  return clip(line ?? "", 200);
}

export class PermissionRequests {
  private held = new Map<string, Held>();
  private onChange: () => void;

  /** `onChange`: the requests waiting changed (to send the sessions again). */
  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** A PermissionRequest hook: hold its reply until the request is answered here or elsewhere. */
  add(payload: Record<string, unknown>, reply: HookReply, now = Date.now()): string | undefined {
    const sessionId = str(payload.session_id);
    const toolName = str(payload.tool_name);
    if (!sessionId || !toolName) {
      reply(undefined);
      return undefined;
    }
    const raw = payload.tool_input ?? {};
    const input = (typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const suggestions = alwaysSuggestions(Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : []);
    const id = randomUUID();
    const always = alwaysLabel(suggestions);
    const questions = toolName === "AskUserQuestion" ? askedQuestions(input) : undefined;
    const plan = toolName === "ExitPlanMode" ? str(input.plan) : undefined;
    this.held.set(id, {
      info: {
        id,
        toolName,
        input: clip(JSON.stringify(raw, null, 2), MAX_INPUT),
        summary: questions ? clip(questions[0]?.question ?? "", 200) : plan !== undefined ? planTitle(plan) : inputSummary(raw, 200),
        at: now,
        ...(always ? { always } : {}),
        ...(questions ? { questions } : {}),
        ...(plan !== undefined ? { plan: clip(plan, MAX_PLAN) } : {}),
      },
      sessionId,
      toolName,
      input,
      callKey: callKey(toolName, raw),
      suggestions,
      sawWaiting: false,
      reply,
    });
    this.onChange();
    return id;
  }

  /** The requests waiting in a session, oldest first. */
  of(sessionId: string): PermissionRequestInfo[] | undefined {
    const list = [...this.held.values()].filter((h) => h.sessionId === sessionId).map((h) => h.info);
    return list.length > 0 ? list : undefined;
  }

  /**
   * Answers a request from Gasho. `answers`: a question's, which "allow" needs; `mode`: the permission mode a plan
   * approved goes on in; `message`: with "deny", what Claude is told, so that it goes on instead of stopping (a plan:
   * it plans again). Returns an error message when the request is no longer waiting or the answer does not fit it;
   * the request then stays as it was.
   */
  answer(sessionId: string, id: string, decision: PermissionDecision, details: AnswerDetails = {}): string | undefined {
    const h = this.held.get(id);
    if (!h || h.sessionId !== sessionId) return "この確認には、すでに答えられています。";
    if (decision === "always" && h.suggestions.length === 0) return "この確認では、今後も許可することはできません。";
    let body: Record<string, unknown>;
    const message = details.message?.trim();
    if (decision === "deny") {
      body = message
        ? { behavior: "deny", message: `${DENY_WITH_MESSAGE}\n${message}`, interrupt: false }
        : { behavior: "deny", message: DENY_MESSAGE, interrupt: true };
    } else if (h.toolName === "AskUserQuestion") {
      if (!h.info.questions) return "この質問には、Gasho から答えられません。端末か公式アプリで答えてください。";
      const answers = questionAnswers(h.input, details.answers);
      if (typeof answers === "string") return answers;
      body = { behavior: "allow", updatedInput: { ...h.input, answers } };
    } else if (h.toolName === "ExitPlanMode") {
      const mode = details.mode === "auto" || details.mode === "default" ? details.mode : undefined;
      body = { behavior: "allow", updatedInput: h.input, ...(mode ? { updatedPermissions: [{ type: "setMode", mode, destination: "session" }] } : {}) };
    } else {
      body = { behavior: "allow", ...(decision === "always" ? { updatedPermissions: h.suggestions } : {}) };
    }
    this.settle(id, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } });
    return undefined;
  }

  /**
   * Another hook of a session: a request answered elsewhere. The tool's PostToolUse (or its failure) settles the
   * request for that call; a new prompt, the end of the turn or of the session settle all of the session's requests.
   */
  observe(payload: Record<string, unknown>): void {
    const sessionId = str(payload.session_id);
    if (!sessionId) return;
    switch (str(payload.hook_event_name)) {
      case "PostToolUse":
      case "PostToolUseFailure": {
        const toolName = str(payload.tool_name);
        const key = callKey(toolName, payload.tool_input);
        const h = [...this.held.values()].find((x) => x.sessionId === sessionId && x.toolName === toolName && x.callKey === key);
        if (h) this.settle(h.info.id, undefined);
        return;
      }
      case "UserPromptSubmit":
      case "Stop":
      case "StopFailure":
      case "SessionEnd":
        this.settleSession(sessionId);
    }
  }

  /**
   * The session's status from Claude Code. A dialog keeps it "waiting"; once it has been seen waiting and is no longer,
   * the dialog was answered (an interruption, for one, sends no hook). Before it has been seen waiting, the status may
   * not have caught up with the request yet, so it settles nothing.
   */
  status(sessionId: string, status: string): void {
    for (const h of [...this.held.values()]) {
      if (h.sessionId !== sessionId) continue;
      if (status === "waiting") h.sawWaiting = true;
      else if (h.sawWaiting) this.settle(h.info.id, undefined);
    }
  }

  /** Lets go of every request of a session (it ended). */
  settleSession(sessionId: string): void {
    for (const h of [...this.held.values()]) if (h.sessionId === sessionId) this.settle(h.info.id, undefined);
  }

  /** The hook's connection closed before an answer: Claude Code gave up on it (timeout, or the session ended). */
  dropped(id: string): void {
    if (this.held.delete(id)) this.onChange();
  }

  private settle(id: string, body: Record<string, unknown> | undefined): void {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    h.reply(body);
    this.onChange();
  }
}

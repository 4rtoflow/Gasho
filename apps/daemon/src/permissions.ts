// Permission requests that Claude Code asks through the PermissionRequest hook. The hook's HTTP response is held until
// the request is answered in Gasho; Claude Code shows its own dialog meanwhile, so the request can also be answered in
// the terminal or the official apps, and then Gasho lets go of it (answering the hook with no decision).
import { randomUUID } from "node:crypto";
import type { PermissionDecision, PermissionRequestInfo } from "@gasho/protocol";
import { clip, inputSummary, str } from "./util.ts";

/** What the hook answers: a decision, or nothing (Claude Code goes on with its own dialog). */
export type HookReply = (body: Record<string, unknown> | undefined) => void;

interface Held {
  info: PermissionRequestInfo;
  sessionId: string;
  toolName: string;
  /** The tool input as JSON, to find the call when its PostToolUse comes (answered elsewhere). */
  inputKey: string;
  /** The allow rules "allow from now on" applies (see alwaysSuggestions). */
  suggestions: Record<string, unknown>[];
  /** Claude Code's status showed the session waiting since the request came. */
  sawWaiting: boolean;
  reply: HookReply;
}

/** The tool input shown in Gasho: pretty JSON, clipped. */
const MAX_INPUT = 4000;

/** What Gasho answers when the person denies: Claude stops, as with "No" in the terminal, and waits for them. */
const DENY_MESSAGE = "The user denied this in Gasho.";

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
    const input = payload.tool_input ?? {};
    const suggestions = alwaysSuggestions(Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : []);
    const id = randomUUID();
    const always = alwaysLabel(suggestions);
    this.held.set(id, {
      info: {
        id,
        toolName,
        input: clip(JSON.stringify(input, null, 2), MAX_INPUT),
        summary: inputSummary(input, 200),
        at: now,
        ...(always ? { always } : {}),
      },
      sessionId,
      toolName,
      inputKey: JSON.stringify(input),
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

  /** Answers a request from Gasho. Returns an error message when it is no longer waiting. */
  answer(sessionId: string, id: string, decision: PermissionDecision): string | undefined {
    const h = this.held.get(id);
    if (!h || h.sessionId !== sessionId) return "この確認には、すでに答えられています。";
    if (decision === "always" && h.suggestions.length === 0) return "この確認では、今後も許可することはできません。";
    const body =
      decision === "deny"
        ? { behavior: "deny", message: DENY_MESSAGE, interrupt: true }
        : { behavior: "allow", ...(decision === "always" ? { updatedPermissions: h.suggestions } : {}) };
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
        const key = JSON.stringify(payload.tool_input ?? {});
        const toolName = str(payload.tool_name);
        const h = [...this.held.values()].find((x) => x.sessionId === sessionId && x.toolName === toolName && x.inputKey === key);
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

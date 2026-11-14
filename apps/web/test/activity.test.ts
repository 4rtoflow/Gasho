import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineHookEvent, SessionStatus, TranscriptEntry } from "@gasho/protocol";
import { lastPromptAt, sessionActivity } from "../src/lib/activity.ts";

const ev = (event: string, at: number, extra: Partial<MachineHookEvent> = {}): MachineHookEvent => ({ machine: "m1", sessionId: "s1", event, at, ...extra });
const pre = (at: number, toolName: string, summary?: string) => ev("PreToolUse", at, { toolName, ...(summary ? { summary } : {}) });
const post = (at: number, toolName: string, summary?: string) => ev("PostToolUse", at, { toolName, ...(summary ? { summary } : {}) });
const s1 = (status: SessionStatus) => ({ machine: "m1", sessionId: "s1", status });
const said = (uuid: string, ts: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ uuid, ts, role: "user", blocks: [{ type: "text", text: uuid }], ...extra });

test("a session that is not working does nothing", () => {
  const events = [ev("UserPromptSubmit", 1000), pre(1100, "Bash", "npm test")];
  assert.deepEqual(sessionActivity(s1("idle"), events, undefined), {});
  assert.deepEqual(sessionActivity(s1("unknown"), events, undefined), {});
  assert.deepEqual(sessionActivity({ machine: "m1", sessionId: "s1", status: undefined }, events, undefined), {});
});

test("the work starts with the person's message, and the tool started last and not finished is the one running", () => {
  const events = [ev("UserPromptSubmit", 1000), pre(1100, "Read", "a.ts"), post(1200, "Read", "a.ts"), pre(1300, "Bash", "npm test")];
  assert.deepEqual(sessionActivity(s1("busy"), events, undefined), { turnStartedAt: 1000, tool: { name: "Bash", summary: "npm test", startedAt: 1300 } });
  // Waiting for an answer about it, the session is still at that work.
  assert.deepEqual(sessionActivity(s1("waiting"), events, undefined), { turnStartedAt: 1000, tool: { name: "Bash", summary: "npm test", startedAt: 1300 } });
  assert.deepEqual(sessionActivity(s1("busy"), [...events, post(1400, "Bash", "npm test")], undefined), { turnStartedAt: 1000 });
  assert.deepEqual(sessionActivity(s1("busy"), [...events, ev("PostToolUseFailure", 1400, { toolName: "Bash", summary: "npm test" })], undefined), {
    turnStartedAt: 1000,
  });
});

test("tools run at once finish apart, told by their name and input", () => {
  const events = [ev("UserPromptSubmit", 1000), pre(1100, "Read", "a.ts"), pre(1101, "Read", "b.ts"), pre(1102, "Grep", "TODO")];
  assert.equal(sessionActivity(s1("busy"), [...events, post(1200, "Grep", "TODO")], undefined).tool?.summary, "b.ts");
  assert.equal(sessionActivity(s1("busy"), [...events, post(1200, "Read", "b.ts")], undefined).tool?.summary, "TODO");
  const done = [...events, post(1200, "Read", "b.ts"), post(1201, "Grep", "TODO"), post(1202, "Read", "a.ts")];
  assert.equal(sessionActivity(s1("busy"), done, undefined).tool, undefined);
});

test("only the session's own hooks count", () => {
  const events = [
    ev("UserPromptSubmit", 1000),
    ev("UserPromptSubmit", 2000, { sessionId: "s2" }),
    { ...pre(2100, "Bash", "ls"), machine: "m2" },
    { ...pre(2200, "Edit", "x.ts"), sessionId: "s2" },
  ];
  assert.deepEqual(sessionActivity(s1("busy"), events, undefined), { turnStartedAt: 1000 });
});

test("the end of the work forgets the tools left unfinished", () => {
  const events = [ev("UserPromptSubmit", 1000), pre(1100, "Bash", "sleep 100"), ev("Stop", 1200), ev("UserPromptSubmit", 2000)];
  assert.deepEqual(sessionActivity(s1("busy"), events, undefined), { turnStartedAt: 2000 });
});

test("without the hook of the person's message, the conversation tells when it was written", () => {
  const entries = [
    said("p1", "2026-11-14T10:00:00.000Z"),
    { uuid: "a1", ts: "2026-11-14T10:00:05.000Z", role: "assistant", blocks: [{ type: "tool_use", name: "Bash", input: "{}" }] },
    // Not what the person wrote: a tool's result, a subagent's message, an interruption, a compaction's summary.
    { uuid: "r1", ts: "2026-11-14T10:00:06.000Z", role: "user", blocks: [{ type: "tool_result", content: "", isError: false }] },
    said("sub", "2026-11-14T10:00:07.000Z", { isSidechain: true }),
    said("int", "2026-11-14T10:00:08.000Z", { interrupted: true }),
    said("sum", "2026-11-14T10:00:09.000Z", { compaction: "summary" }),
  ] satisfies TranscriptEntry[];
  const p1 = Date.parse("2026-11-14T10:00:00.000Z");
  assert.equal(lastPromptAt(entries), p1);
  assert.equal(lastPromptAt(undefined), undefined);
  assert.equal(lastPromptAt([said("x", "not a time")]), undefined);
  assert.deepEqual(sessionActivity(s1("busy"), [pre(p1 + 5000, "Bash", "ls")], entries), { turnStartedAt: p1, tool: { name: "Bash", summary: "ls", startedAt: p1 + 5000 } });
  // Both there for the same message: the hook's time, which comes first, so the time does not move once the
  // conversation has it.
  assert.equal(sessionActivity(s1("busy"), [ev("UserPromptSubmit", p1 - 200)], entries).turnStartedAt, p1 - 200);
  assert.equal(sessionActivity(s1("busy"), [ev("UserPromptSubmit", p1 + 300)], entries).turnStartedAt, p1 + 300);
  // The conversation has a later message than the last hook: that one.
  assert.equal(sessionActivity(s1("busy"), [ev("UserPromptSubmit", p1 - 60_000)], entries).turnStartedAt, p1);
});

test("work the session took up by itself after its last message's work ended starts with the first thing it did", () => {
  // The notification of waiting, idle, for the person is not work.
  const events = [ev("UserPromptSubmit", 1000), ev("Stop", 1500), ev("Notification", 1600), pre(5000, "Bash", "npm test")];
  assert.deepEqual(sessionActivity(s1("busy"), events, undefined), { turnStartedAt: 5000, tool: { name: "Bash", summary: "npm test", startedAt: 5000 } });
  assert.equal(sessionActivity(s1("busy"), [ev("UserPromptSubmit", 1000), ev("Stop", 1500), ev("Notification", 1600)], undefined).turnStartedAt, undefined);
  // Nothing known: the hooks of the session were not kept, and its conversation is not loaded.
  assert.deepEqual(sessionActivity(s1("busy"), [], undefined), {});
});

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startHookServer } from "../src/hooks.ts";
import { alwaysLabel, PermissionRequests } from "../src/permissions.ts";

const request = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PermissionRequest",
  session_id: "s1",
  tool_name: "Bash",
  tool_input: { command: "npm test", description: "Run tests" },
  permission_suggestions: [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" },
  ],
  ...extra,
});

function setup() {
  let changes = 0;
  const replies: Array<Record<string, unknown> | undefined> = [];
  const p = new PermissionRequests(() => changes++);
  return { p, replies, changes: () => changes, reply: (b: Record<string, unknown> | undefined) => replies.push(b) };
}

test("a request is held, listed with its input and what 'always' allows, and answered with Claude Code's decision", () => {
  const { p, replies, reply } = setup();
  const id = p.add(request(), reply, 5);
  assert.ok(id);
  const [info] = p.of("s1") ?? [];
  assert.deepEqual({ ...info, id: "" }, {
    id: "",
    toolName: "Bash",
    input: JSON.stringify({ command: "npm test", description: "Run tests" }, null, 2),
    summary: "npm test",
    at: 5,
    always: "Bash(npm test:*)",
  });
  assert.equal(replies.length, 0);
  assert.equal(p.answer("s1", id, "always"), undefined);
  assert.deepEqual(replies[0], {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: request().permission_suggestions } },
  });
  assert.equal(p.of("s1"), undefined);
  // Answered already: the second answer is an error, and nothing more is sent.
  assert.ok(p.answer("s1", id, "allow"));
  assert.equal(replies.length, 1);
});

test("allow and deny", () => {
  const { p, replies, reply } = setup();
  const a = p.add(request(), reply) ?? "";
  const d = p.add(request(), reply) ?? "";
  assert.ok(p.answer("other-session", a, "allow"), "only the session's own requests");
  p.answer("s1", a, "allow");
  p.answer("s1", d, "deny");
  assert.deepEqual(replies[0], { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  const deny = (replies[1]?.hookSpecificOutput as { decision: Record<string, unknown> }).decision;
  assert.equal(deny.behavior, "deny");
  assert.equal(deny.interrupt, true);
});

test("'always' cannot be answered without a suggestion", () => {
  const { p, reply } = setup();
  const id = p.add(request({ permission_suggestions: undefined }), reply) ?? "";
  assert.equal(p.of("s1")?.[0]?.always, undefined);
  assert.ok(p.answer("s1", id, "always"));
  assert.equal(p.of("s1")?.length, 1);
});

test("answered elsewhere: the call's PostToolUse, the end of the turn, or the dialog closing let go of it with no decision", () => {
  const { p, replies, reply } = setup();
  p.add(request(), reply);
  p.add(request({ tool_input: { command: "ls" } }), reply);
  // Another call of the same tool does not settle it.
  p.observe({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "pwd" } });
  assert.equal(p.of("s1")?.length, 2);
  p.observe({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(p.of("s1")?.map((r) => r.summary), ["npm test"]);
  assert.deepEqual(replies, [undefined]);
  p.observe({ hook_event_name: "Stop", session_id: "s1" });
  assert.equal(p.of("s1"), undefined);
  assert.deepEqual(replies, [undefined, undefined]);

  // The status settles a request only once it has been seen waiting.
  p.add(request(), reply);
  p.status("s1", "busy");
  assert.equal(p.of("s1")?.length, 1);
  p.status("s1", "waiting");
  p.status("s1", "busy");
  assert.equal(p.of("s1"), undefined);
});

test("a request whose connection closed is dropped", () => {
  const { p, reply, changes } = setup();
  const id = p.add(request(), reply) ?? "";
  p.dropped(id);
  assert.equal(p.of("s1"), undefined);
  assert.equal(changes(), 2);
});

test("'always' applies only the allow rules Claude Code suggests", () => {
  const { p, replies, reply } = setup();
  const rule = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git log:*" }], behavior: "allow", destination: "localSettings" };
  // As Claude Code sent them for a mkdir: a folder for the session and the edit mode. Neither is offered.
  const folderAndMode = [
    { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ];
  assert.equal(p.of("s1"), undefined);
  p.add(request({ permission_suggestions: folderAndMode }), reply);
  assert.equal(p.of("s1")?.[0]?.always, undefined);
  p.settleSession("s1");
  const id = p.add(request({ permission_suggestions: [...folderAndMode, rule, { ...rule, behavior: "deny" }] }), reply) ?? "";
  assert.equal(p.of("s1")?.[0]?.always, "Bash(git log:*)");
  p.answer("s1", id, "always");
  const decision = (replies.at(-1)?.hookSpecificOutput as { decision: Record<string, unknown> }).decision;
  assert.deepEqual(decision.updatedPermissions, [rule]);
  assert.equal(
    alwaysLabel([{ type: "addRules", rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }]),
    "Read、Bash(ls:*)（このセッションのみ）",
  );
  assert.equal(alwaysLabel([]), undefined);
});

test("the hook server holds a PermissionRequest until it is answered, and answers other hooks at once", async () => {
  const p = new PermissionRequests(() => undefined);
  const events: string[] = [];
  const server = startHookServer({
    host: "127.0.0.1",
    port: 0,
    secret: undefined,
    onEvent: (payload) => events.push(String(payload.hook_event_name)),
    onPermissionRequest: (payload, reply) => {
      const id = p.add(payload, reply);
      return id ? () => p.dropped(id) : undefined;
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/hooks`;
  try {
    const stop = await fetch(url, { method: "POST", body: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }) });
    assert.equal(await stop.text(), "");
    const pending = fetch(url, { method: "POST", body: JSON.stringify(request()) });
    while (!p.of("s1")) await new Promise((r) => setTimeout(r, 5));
    const id = p.of("s1")?.[0]?.id ?? "";
    p.answer("s1", id, "allow");
    const res = await pending;
    assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.deepEqual(events, ["Stop", "PermissionRequest"]);

    // Claude Code gives up (closes the connection): the request is dropped.
    const ac = new AbortController();
    const gone = fetch(url, { method: "POST", body: JSON.stringify(request()), signal: ac.signal }).catch(() => undefined);
    while (!p.of("s1")) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await gone;
    while (p.of("s1")) await new Promise((r) => setTimeout(r, 5));
  } finally {
    server.close();
  }
});

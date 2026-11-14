import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startHookServer } from "../src/hooks.ts";
import { alwaysLabel, answersMessage, callKey, openQuestionRequest, PermissionRequests, questionAnswers } from "../src/permissions.ts";

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

// AskUserQuestion's input as Claude Code sent it (2.1.325): the questions, without answers.
const questions = [
  {
    question: "Which color do you like?",
    header: "Color",
    options: [
      { label: "Red", description: "warm" },
      { label: "Blue", description: "cool", preview: "■ blue" },
    ],
    multiSelect: false,
  },
  {
    question: "Which fruits do you eat?",
    header: "Fruits",
    options: [
      { label: "Apple", description: "Apple" },
      { label: "Banana", description: "Banana" },
      { label: "Cherry", description: "Cherry" },
    ],
    multiSelect: true,
  },
];
const ask = () => request({ tool_name: "AskUserQuestion", tool_input: { questions }, permission_suggestions: undefined });

test("Claude's questions are listed as such, and answered with the answers in the tool's input", () => {
  const { p, replies, reply } = setup();
  const id = p.add(ask(), reply) ?? "";
  const [info] = p.of("s1") ?? [];
  assert.equal(info?.summary, "Which color do you like?");
  assert.deepEqual(info?.questions, [
    {
      question: "Which color do you like?",
      header: "Color",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool", preview: "■ blue" },
      ],
    },
    // A description that only repeats the label is left out.
    { question: "Which fruits do you eat?", header: "Fruits", options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }], multiSelect: true },
  ]);
  // "allow" alone would leave Claude Code's dialog open: it is refused, and the request stays.
  assert.match(p.answer("s1", id, "allow") ?? "", /すべての質問に答えて/);
  assert.match(p.answer("s1", id, "allow", { answers: [{ picked: [1] }] }) ?? "", /すべての質問に答えて/);
  assert.match(p.answer("s1", id, "allow", { answers: [{ picked: [0, 1] }, { picked: [0] }] }) ?? "", /質問に合っていません/);
  assert.match(p.answer("s1", id, "allow", { answers: [{ picked: [2] }, { picked: [0] }] }) ?? "", /質問に合っていません/);
  assert.ok(p.answer("s1", id, "always"));
  assert.equal(replies.length, 0);
  assert.equal(p.of("s1")?.length, 1);

  assert.equal(p.answer("s1", id, "allow", { answers: [{ picked: [1] }, { picked: [2, 0], text: " and plums " }] }), undefined);
  assert.deepEqual(replies[0], {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: { questions, answers: { "Which color do you like?": "Blue", "Which fruits do you eat?": "Apple, Cherry, and plums" } },
      },
    },
  });
  assert.equal(p.of("s1"), undefined);
});

test("an answer is the options chosen and what was written, by the questions and labels as Claude Code sent them", () => {
  const long = "x".repeat(5000);
  const input = { questions: [{ question: long, options: [{ label: long }, { label: "B" }] }] };
  // Gasho shows them clipped; the answer still names them whole.
  assert.deepEqual(questionAnswers(input, [{ picked: [0] }]), { [long]: long });
  assert.deepEqual(questionAnswers(input, [{ picked: [], text: "  neither  " }]), { [long]: "neither" });
  // A question that takes one answer: one option, or what was written.
  assert.equal(typeof questionAnswers(input, [{ picked: [0], text: "and B" }]), "string");
  assert.equal(typeof questionAnswers(input, [{ picked: [], text: "  " }]), "string");
  assert.equal(typeof questionAnswers(input, [{ picked: [-1] }]), "string");
  assert.equal(typeof questionAnswers(input, [{ picked: [0.5] }]), "string");
  assert.equal(typeof questionAnswers(input, []), "string");
});

test("questions that are not as Claude Code sends them are a plain request, which cannot be allowed from Gasho", () => {
  const { p, reply } = setup();
  const id = p.add(request({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "?" }] }, permission_suggestions: undefined }), reply) ?? "";
  assert.equal(p.of("s1")?.[0]?.questions, undefined);
  assert.match(p.answer("s1", id, "allow", { answers: [{ picked: [0] }] }) ?? "", /端末か公式アプリ/);
  // Denying still works: Claude stops.
  assert.equal(p.answer("s1", id, "deny"), undefined);
});

test("a plan is listed with its title, approved with the plan as Claude Code sent it and the mode to go on in, or sent back", () => {
  const { p, replies, reply } = setup();
  // As Claude Code sent it (2.1.325): the plan and its file are put into the input; no suggestions.
  const input = { plan: "# Plan: create hello.txt\n\n1. Create `hello.txt`.\n", planFilePath: "/home/u/.claude/plans/x.md" };
  const plan = () => request({ tool_name: "ExitPlanMode", tool_input: input, permission_suggestions: undefined });
  const a = p.add(plan(), reply) ?? "";
  assert.equal(p.of("s1")?.[0]?.summary, "Plan: create hello.txt");
  assert.equal(p.of("s1")?.[0]?.plan, input.plan);
  p.answer("s1", a, "allow", { mode: "auto" });
  assert.deepEqual(replies[0], {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
    },
  });
  // Without a mode (an older Gasho screen), the plan is approved and Claude Code picks the mode.
  const b = p.add(plan(), reply) ?? "";
  p.answer("s1", b, "allow", { mode: "bypassPermissions" as "auto" });
  assert.deepEqual(replies[1], { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: input } } });
  // Sent back with what to change: Claude is told it and plans again, instead of stopping.
  const c = p.add(plan(), reply) ?? "";
  p.answer("s1", c, "deny", { message: " Name it farewell.txt " });
  assert.deepEqual(replies[2], {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The user declined this in Gasho and said:\nName it farewell.txt", interrupt: false },
    },
  });
  const d = p.add(plan(), reply) ?? "";
  p.answer("s1", d, "deny", { message: "   " });
  assert.deepEqual(replies[3], {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "The user denied this in Gasho.", interrupt: true } },
  });
});

test("a question or a plan answered in the terminal is let go of at its PostToolUse, which carries the answers or no input", () => {
  const { p, replies, reply } = setup();
  p.add(ask(), reply);
  p.add(request({ tool_name: "ExitPlanMode", tool_input: { plan: "# P", planFilePath: "/p.md" }, permission_suggestions: undefined }), reply);
  // Another question does not settle it.
  p.observe({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [questions[0]], answers: {} } });
  assert.equal(p.of("s1")?.length, 2);
  p.observe({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions, answers: { "Which color do you like?": "Red" } } });
  assert.deepEqual(p.of("s1")?.map((r) => r.toolName), ["ExitPlanMode"]);
  p.observe({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "ExitPlanMode", tool_input: {} });
  assert.equal(p.of("s1"), undefined);
  assert.deepEqual(replies, [undefined, undefined]);
  assert.equal(callKey("Bash", { command: "ls" }), JSON.stringify({ command: "ls" }));
});

test("a question shown from the transcript is a request answered as a message, by the questions as Claude wrote them", () => {
  const r = openQuestionRequest({ toolUseId: "toolu_9", input: { questions }, at: 7 });
  assert.equal(r?.id, "question:toolu_9");
  assert.equal(r?.toolName, "AskUserQuestion");
  assert.equal(r?.answerAsMessage, true);
  assert.equal(r?.at, 7);
  assert.equal(r?.questions?.length, 2);
  assert.equal(openQuestionRequest({ toolUseId: "x", input: { questions: [{ question: "?" }] } }), undefined);
  const answers = questionAnswers({ questions }, [{ picked: [1] }, { picked: [0], text: "梨も" }]);
  assert.ok(typeof answers !== "string");
  assert.equal(
    answersMessage(answers),
    [
      "さきほどの質問への答えです（Gasho から答えたため、質問の画面は閉じました）。",
      "- 「Which color do you like?」→ Blue",
      "- 「Which fruits do you eat?」→ Apple, 梨も",
    ].join("\n"),
  );
});

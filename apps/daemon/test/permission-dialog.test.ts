// A permission dialog that gasho-daemon holds no hook for (it restarted while the dialog was open, or the hook timed
// out): shown from the transcript's open tool call, and answered with the keys of Claude Code's dialog. Against a fake
// Claude Code terminal (no claude, no zellij).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { dialogOpen, permissionDialog, readScreen } from "../src/managed.ts";
import { dialogCall } from "../src/permissions.ts";
import { emptyMeta, type OpenCall, parseRecord } from "../src/transcript.ts";

const RULE = "─".repeat(50);
const SID = "11111111-2222-3333-4444-555555555555";
const COMMAND = "python3 - <<'EOF' ... EOF";

/** Claude Code 2.1.325's dialog for a command in a pane 50 columns wide: the long choice wraps. */
function dialog(cursor: number): string {
  const choices = [
    ["1. Yes"],
    ["2. Yes, and don't ask again for python3", "   commands in /home/rg/repos/Gasho"],
    ["3. No, and tell Claude what to do differently", "   (esc)"],
  ];
  return [
    " ▐▛███▛█   Claude Code v2.1.325",
    "● Bash(python3 - <<'EOF' ...)",
    RULE,
    " Bash command",
    "",
    `   ${COMMAND}`,
    "",
    " Do you want to proceed?",
    ...choices.flatMap((lines, i) => lines.map((l, j) => (j === 0 ? `${i === cursor ? " ❯ " : "   "}${l}` : `   ${l}`))),
    "",
    " Esc to cancel · Tab to amend",
    "",
  ].join("\n");
}

test("the dialog's choices are read from the bottom of the screen, whatever the tool", () => {
  const options = permissionDialog(dialog(0));
  assert.deepEqual(
    options?.map((o) => [o.n, o.label, o.selected]),
    [
      [1, "Yes", true],
      [2, "Yes, and don't ask again for python3", false],
      [3, "No, and tell Claude what to do differently", false],
    ],
  );
  assert.equal(permissionDialog(dialog(2))?.[2]?.selected, true);
  const edit = dialog(0).replace(" Do you want to proceed?", " Do you want to make this edit to managed.ts?");
  assert.ok(permissionDialog(edit));
  // An edit's dialog keeps typed input away like a command's.
  assert.ok(dialogOpen(edit.replace("Bash", "Edit")));
  // A list in Claude's reply, above the prompt box, is no dialog.
  const reply = [" ▐▛███▛█   Claude Code v2.1.325", "● 1. Yes", "  2. No", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", ""].join("\n");
  assert.equal(permissionDialog(reply), undefined);
  // Nor a question whose first choice is not "Yes".
  assert.equal(permissionDialog(dialog(0).replace("1. Yes", "1. Opus")), undefined);
});

test("the transcript keeps the calls without a result until the person writes", () => {
  const meta = emptyMeta();
  // Read anew each time: an assertion that it is undefined would narrow `meta.openCalls` for good.
  const open = (): OpenCall[] | undefined => meta.openCalls;
  const call = (id: string, name: string, input: Record<string, unknown>) =>
    parseRecord({ type: "assistant", uuid: id, timestamp: "2026-11-14T17:13:11.780Z", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }, meta);
  const result = (id: string) =>
    parseRecord({ type: "user", uuid: `r${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }, meta);
  call("toolu_1", "Read", { file_path: "/a" });
  result("toolu_1");
  assert.equal(meta.openCalls, undefined);
  call("toolu_2", "Agent", { prompt: "調べて" });
  call("toolu_3", "Bash", { command: COMMAND });
  assert.deepEqual(
    open()?.map((c) => c.toolUseId),
    ["toolu_2", "toolu_3"],
  );
  // A subagent asks nothing in the main transcript: the dialog is the command's.
  assert.equal(dialogCall(open())?.toolUseId, "toolu_3");
  result("toolu_3");
  assert.equal(dialogCall(open()), undefined);
  parseRecord({ type: "user", uuid: "u", message: { role: "user", content: "やめて" } }, meta);
  assert.equal(meta.openCalls, undefined);
});

class FakeClaude {
  cursor = 0;
  open = true;
  keys: string[] = [];
  answered?: string;
  key(key: string): void {
    this.keys.push(key);
    if (!this.open) return;
    if (key === "Up") this.cursor = Math.max(0, this.cursor - 1);
    else if (key === "Down") this.cursor = Math.min(2, this.cursor + 1);
    else if (key === "Enter" || key === "Esc") {
      this.answered = key === "Esc" ? "no" : ["yes", "always", "no"][this.cursor];
      this.open = false;
    }
  }
  ansi(): string {
    return this.open ? dialog(this.cursor) : [" ▐▛███▛█   Claude Code v2.1.325", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", ""].join("\n");
  }
}

async function setup(c: FakeClaude) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-dialog-"));
  const d = new Daemon(
    {
      hubUrl: "ws://127.0.0.1:1",
      machineId: "m",
      token: "t",
      hookPort: 0,
      claudeDir: path.join(dir, "claude"),
      claudeBin: "/bin/false",
      pollIntervalMs: 60_000,
      stateDir: dir,
      attachmentsDir: path.join(dir, "attachments"),
    } as ConstructorParameters<typeof Daemon>[0],
    { enterWaitMs: 300 },
  ) as unknown as Record<string, any>;
  d.terminals = {
    screen: async () => readScreen(c.ansi()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((k) => c.key(k)),
    paste: async () => undefined,
  };
  d.currentStatus = async () => (c.open ? "waiting" : "busy");
  d.scheduleRefresh = () => undefined;
  d.emitSessions = () => undefined;
  d.managed.add({ sessionId: SID, terminal: "z", pid: 1, cwd: dir, name: "fake", launchedAt: 1 });
  d.tracked.set(SID, {
    info: { sessionId: SID, cwd: dir, status: "waiting", waitingFor: "permission prompt", rcMode: "none", prLinks: [] },
    meta: { prLinks: [], openCalls: [{ toolUseId: "toolu_3", name: "Bash", input: { command: COMMAND }, at: 5 }] },
  });
  return { d, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

const answer = (extra: Record<string, unknown>) => ({
  type: "permission.answer",
  requestId: "r1",
  sessionId: SID,
  permissionId: "dialog:toolu_3",
  decision: "allow",
  ...extra,
});

test("the open call is shown while the session waits on a permission prompt, only for a session started from Gasho", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    const t = d.tracked.get(SID);
    const [r] = d.openPermission(t) ?? [];
    assert.equal(r?.id, "dialog:toolu_3");
    assert.equal(r?.toolName, "Bash");
    assert.equal(r?.always, undefined);
    t.info.waitingFor = "input needed";
    assert.equal(d.openPermission(t), undefined);
    t.info.waitingFor = "permission prompt";
    d.managed.remove(SID);
    assert.equal(d.openPermission(t), undefined);
  } finally {
    await done();
  }
});

test("allowing puts the cursor on Yes and presses Enter", async () => {
  const c = new FakeClaude();
  c.cursor = 2;
  const { d, done } = await setup(c);
  try {
    assert.deepEqual(await d.answerDialog(answer({})), { ok: true });
    assert.deepEqual(c.keys, ["Up", "Up", "Enter"]);
    assert.equal(c.answered, "yes");
  } finally {
    await done();
  }
});

test("denying presses Esc and sends a message given as the next message; other answers press nothing", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    assert.match((await d.answerDialog(answer({ decision: "always" }))).error, /今後も許可することはできません/);
    assert.match((await d.answerDialog(answer({ permissionId: "dialog:toolu_0" }))).error, /すでに答えられて/);
    const real = c.ansi.bind(c);
    c.ansi = () => real().replace("1. Yes", "1. Opus");
    assert.match((await d.answerDialog(answer({}))).error, /確認の画面が見当たらない/);
    c.ansi = real;
    assert.deepEqual(c.keys, []);

    assert.deepEqual(await d.answerDialog(answer({ decision: "deny", message: "先にテストを書いて" })), { ok: true, queued: true });
    assert.deepEqual(c.keys, ["Esc"]);
    assert.equal(c.answered, "no");
    assert.equal(d.managed.pending(SID), 1);
  } finally {
    await done();
  }
});

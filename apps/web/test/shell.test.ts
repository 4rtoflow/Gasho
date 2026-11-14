import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { TranscriptEntry } from "@gasho/protocol";
import { addPending, pendingOf, sessionWorking, settlePending, SENT_GRACE_MS } from "../src/lib/pending.ts";
import { emptyShellInput, isShellInput, shellCommand, shellOutput } from "../src/lib/shell.ts";
import { transcriptItems } from "../src/lib/transcript-items.ts";

// As Claude Code 2.1.323 recorded them: the command, then what it printed (a failing command prints into stderr).
const INPUT = "<bash-input>echo hello-gasho && pwd</bash-input>";
const OUTPUT = "<bash-stdout>hello-gasho\n/tmp/bash-probe</bash-stdout><bash-stderr></bash-stderr>";
const FAILED = "<bash-stdout></bash-stdout><bash-stderr>start\nout-line\nerr-line\n</bash-stderr>";
const user = (uuid: string, text: string): TranscriptEntry => ({ uuid, role: "user", ts: "2026-11-13T16:52:19Z", blocks: [{ type: "text", text }] });

test("a shell-mode command and its output are read from what Claude Code records, also when cut short", () => {
  assert.equal(shellCommand(INPUT), "echo hello-gasho && pwd");
  assert.equal(shellCommand("<bash-input>ls -la\n| head</bash-input>\n"), "ls -la\n| head");
  assert.deepEqual(shellOutput(OUTPUT), { stdout: "hello-gasho\n/tmp/bash-probe", stderr: "" });
  assert.deepEqual(shellOutput(FAILED), { stdout: "", stderr: "start\nout-line\nerr-line\n" });
  // gasho-daemon cuts long texts: "<bash-stdout>…… (+120 chars)".
  assert.deepEqual(shellOutput("<bash-stdout>aaaa… (+120 chars)"), { stdout: "aaaa… (+120 chars)", stderr: "" });
  assert.deepEqual(shellOutput("<bash-stdout>out</bash-stdout><bash-stderr>err… (+9 chars)"), { stdout: "out", stderr: "err… (+9 chars)" });
  for (const other of ["echo hi", "I typed <bash-input>x</bash-input> here", "<local-command-stdout>x</local-command-stdout>"]) {
    assert.equal(shellCommand(other), undefined, other);
    assert.equal(shellOutput(other), undefined, other);
  }
  assert.ok(isShellInput("!ls"));
  assert.ok(!isShellInput("ls !"));
  assert.ok(emptyShellInput("!  "));
  assert.ok(!emptyShellInput("!ls"));
});

test("a command and the output after it are one item; a page boundary between them leaves each on its own", () => {
  const entries = [user("q", "質問"), user("in", INPUT), user("out", OUTPUT), user("in2", "<bash-input>false</bash-input>"), user("out2", FAILED)];
  const items = transcriptItems(entries, 0, () => false);
  assert.deepEqual(
    items.map((i) => (i.kind === "shell" ? `shell:${i.key}:${i.command ?? "-"}:${i.output ? "out" : "-"}` : `${i.kind}:${i.key}`)),
    ["entry:q", "shell:in:echo hello-gasho && pwd:out", "shell:in2:false:out"],
  );
  const shell = items[1];
  assert.ok(shell?.kind === "shell" && shell.ts === "2026-11-13T16:52:19Z" && shell.output?.stdout === "hello-gasho\n/tmp/bash-probe");
  // The older page ends with the command; the newer one starts with its output.
  assert.deepEqual(
    transcriptItems([user("in", INPUT)], 0, () => false).map((i) => i.kind === "shell" && [i.command, i.output]),
    [["echo hello-gasho && pwd", undefined]],
  );
  assert.deepEqual(
    transcriptItems([user("out", OUTPUT), user("q", "次")], 10, () => false).map((i) => (i.kind === "shell" ? [i.command, i.output?.stdout] : i.kind)),
    [[undefined, "hello-gasho\n/tmp/bash-probe"], "entry"],
  );
  // A tool call before and after a shell command is not one group with it.
  const call = (id: string): TranscriptEntry => ({ uuid: id, role: "assistant", blocks: [{ type: "tool_use", id, name: "Bash", input: "{}" }] });
  assert.deepEqual(
    transcriptItems([call("c1"), call("c2"), user("in", INPUT), user("out", OUTPUT), call("c3"), call("c4")], 0, () => true).map((i) => i.kind),
    ["tools", "shell", "tools"],
  );
});

test("a shell command sent from here stays (running) while the session works, and goes a while after it stops", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const key = "m\u0000shell-session";
    const shown = () => pendingOf(key).map((p) => `${p.text}:${p.state}`);
    sessionWorking(key, false);
    const id = addPending(key, { text: "!npm test", files: [], after: 3 });
    settlePending(key, id, "sent");
    sessionWorking(key, true); // the command runs
    mock.timers.tick(SENT_GRACE_MS * 5);
    assert.deepEqual(shown(), ["!npm test:sent"]);
    sessionWorking(key, false); // it has ended: Claude Code records it now
    mock.timers.tick(SENT_GRACE_MS - 1);
    assert.equal(shown().length, 1);
    mock.timers.tick(1);
    assert.deepEqual(shown(), []);

    // A message to Claude goes SENT_GRACE_MS after it was typed, working or not.
    const other = addPending(key, { text: "テストを流して", files: [], after: 3 });
    sessionWorking(key, true);
    settlePending(key, other, "sent");
    mock.timers.tick(SENT_GRACE_MS);
    assert.deepEqual(shown(), []);
  } finally {
    mock.timers.reset();
  }
});


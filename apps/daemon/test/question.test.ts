// Claude's question that gasho-daemon holds no hook for (it restarted while the question was open, the hook timed out,
// or it was spent): shown from the transcript, and answered by closing Claude Code's dialog with Esc and sending the
// answers as the next message. Against a fake Claude Code terminal (no claude, no zellij).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { readScreen } from "../src/managed.ts";

const RULE = "─".repeat(50);
const SID = "11111111-2222-3333-4444-555555555555";
const QUESTION = "daemon の版をどちらに使いますか？";
const input = {
  questions: [{ question: QUESTION, header: "版の番号", options: [{ label: "PR #9 を 0.11.0 で出す (Recommended)" }, { label: "PR #8 を先に待つ" }], multiSelect: false }],
};

/** Claude Code 2.1.325 with Claude's question open (its dialog has the keys), as far as the daemon sees and drives it. */
class FakeClaude {
  question = true;
  box = "";
  keys: string[] = [];
  submitted: string[] = [];

  key(key: string): void {
    this.keys.push(key);
    if (this.question) {
      if (key === "Esc") this.question = false;
      return;
    }
    if (key === "Enter" && this.box) {
      this.submitted.push(this.box);
      this.box = "";
    } else if (key === "Ctrl u") this.box = this.box.replace(/[^\n]*$/, "");
  }

  paste(text: string): void {
    if (!this.question) this.box += text;
  }

  ansi(): string {
    const head = [" ▐▛███▛█   Claude Code v2.1.325", "❯ 版の番号を決めて", "● どちらの版にしますか？"];
    if (this.question) {
      return [
        ...head,
        RULE,
        " ☐ 版の番号",
        "",
        `│ ${QUESTION}`,
        "",
        "❯ 1. PR #9 を 0.11.0 で出す (Recommended)",
        "  2. PR #8 を先に待つ",
        "  3. Type something.",
        RULE,
        "  4. Chat about this",
        "",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
        "",
      ].join("\n");
    }
    const box = (this.box ? `❯ ${this.box}` : "❯ \x1b[2m前の指示をもう一度\x1b[22m").split("\n").map((l, i) => (i === 0 ? l : `  ${l}`));
    return [...head, "● User declined to answer questions", RULE, ...box, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)", ""].join("\n");
  }
}

async function setup(c: FakeClaude) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-question-"));
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
    paste: async (_s: string, text: string) => c.paste(text),
  };
  // Claude Code's status: waiting while its question is open; idle once it is closed (Claude stops).
  d.currentStatus = async () => (c.question ? "waiting" : "idle");
  d.scheduleRefresh = () => undefined;
  d.emitSessions = () => undefined;
  d.managed.add({ sessionId: SID, terminal: "z", pid: 1, cwd: dir, name: "fake", launchedAt: 1 });
  d.tracked.set(SID, {
    info: { sessionId: SID, cwd: dir, status: "waiting", rcMode: "none", prLinks: [] },
    meta: { prLinks: [], question: { toolUseId: "toolu_1", input, at: 5 } },
  });
  return { d, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

const answer = (extra: Record<string, unknown>) => ({
  type: "permission.answer",
  requestId: "r1",
  sessionId: SID,
  permissionId: "question:toolu_1",
  decision: "allow",
  ...extra,
});

test("a question without a hook is shown while the session waits, only for a session started from Gasho", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    const t = d.tracked.get(SID);
    const [r] = d.openQuestion(t) ?? [];
    assert.equal(r?.id, "question:toolu_1");
    assert.equal(r?.answerAsMessage, true);
    assert.equal(r?.questions?.[0]?.header, "版の番号");
    t.info.status = "idle";
    assert.equal(d.openQuestion(t), undefined);
    t.info.status = "waiting";
    d.managed.remove(SID);
    assert.equal(d.openQuestion(t), undefined);
  } finally {
    await done();
  }
});

test("answering closes the dialog with Esc, then sends the answers as one message once the session is idle", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    const res = await d.answerQuestion(answer({ answers: [{ picked: [0] }] }));
    assert.deepEqual(res, { ok: true, queued: true });
    assert.deepEqual(c.keys, ["Esc"]);
    assert.equal(c.question, false);
    // It waits for Claude Code to settle after the Esc, as after a stop.
    assert.equal(await d.flushInput(SID), undefined);
    assert.deepEqual(c.submitted, []);
    d.settleUntil.delete(SID);
    await d.flushInput(SID);
    assert.deepEqual(c.submitted, [
      `さきほどの質問への答えです（Gasho から答えたため、質問の画面は閉じました）。\n- 「${QUESTION}」→ PR #9 を 0.11.0 で出す (Recommended)`,
    ]);
  } finally {
    await done();
  }
});

test("declining only closes the dialog; a wrong answer, another question or a screen without it presses nothing", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    assert.match((await d.answerQuestion(answer({ answers: [] }))).error, /すべての質問に答えて/);
    assert.match((await d.answerQuestion(answer({ permissionId: "question:toolu_0", answers: [{ picked: [0] }] }))).error, /すでに答えられて/);
    // The status says waiting, but the dialog on the screen is not the question (it is something else's to answer).
    const real = c.ansi.bind(c);
    c.ansi = () => real().replace("Chat about this", "No, and tell Claude what to do differently");
    assert.match((await d.answerQuestion(answer({ answers: [{ picked: [1] }] }))).error, /質問の画面が見当たらない/);
    assert.deepEqual(c.keys, []);
    c.ansi = real;

    assert.deepEqual(await d.answerQuestion(answer({ decision: "deny" })), { ok: true });
    assert.deepEqual(c.keys, ["Esc"]);
    assert.equal(d.managed.pending(SID), 0);
  } finally {
    await done();
  }
});

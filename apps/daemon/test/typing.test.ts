// The daemon's typing against a fake Claude Code terminal (no claude, no zellij): Enter is pressed at most once per
// paste, nothing is typed behind a command whose Enter was not taken yet, Claude Code's dim suggestion is not typed
// text, and the /model picker gets "s" (this session only), never Enter (which saves the default for every session).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { readScreen } from "../src/managed.ts";

const RULE = "─".repeat(50);
const MODELS = ["Default (recommended)  Sonnet 5.5 · Efficient", "Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5"];
const EFFORTS = ["Low", "Medium", "High", "xHigh", "Max"];
const name = (i: number) => MODELS[i]?.split(/\s{2,}/)[0] ?? "";
type Key = { key: string } | { paste: string };

/** Claude Code 2.1.322's prompt box and /model picker, as far as the daemon sees and drives them. */
class FakeClaude {
  mode: "prompt" | "picker" = "prompt";
  box = "";
  conversation = ["❯ 前の指示", "● はい"];
  cursor = 0;
  model = 3;
  effort = 1;
  pickerEffort = 1;
  /** How long Claude Code takes to act on an Enter in the prompt box. */
  enterDelayMs = 0;
  /** The next Enter in the prompt box is lost. */
  loseEnter = false;
  /** A model (picker row) that has no xHigh: ←/→ skip it. */
  noXHigh = -1;
  submitted: string[] = [];
  events: string[] = [];
  private queue: Key[] = [];
  private busyUntil = 0;
  private pending?: () => void;

  pump(): void {
    for (;;) {
      if (Date.now() < this.busyUntil) return;
      if (this.pending) {
        const a = this.pending;
        this.pending = undefined;
        a();
        continue;
      }
      const k = this.queue.shift();
      if (!k) return;
      if ("paste" in k) this.paste(k.paste);
      else this.key(k.key);
    }
  }

  push(k: Key): void {
    this.queue.push(k);
    this.pump();
  }

  private paste(text: string): void {
    if (this.mode === "picker") this.events.push("paste in the picker");
    else this.box += text;
  }

  private key(key: string): void {
    if (this.mode === "picker") return this.pickerKey(key);
    if (key === "Ctrl u") this.box = this.box.replace(/[^\n]*$/, "");
    else if (key === "Backspace") this.box = this.box.slice(0, -1);
    else if (key === "Enter") {
      const text = this.box;
      if (!text) return;
      if (this.loseEnter) {
        this.loseEnter = false;
        return;
      }
      this.busyUntil = Date.now() + this.enterDelayMs;
      this.pending = () => {
        this.box = "";
        if (text === "/model") {
          this.mode = "picker";
          this.cursor = this.model;
          this.pickerEffort = this.effort;
          return;
        }
        this.conversation.push(`❯ ${text}`);
        const ultracode = /^\/effort ultracode (on|off)$/.exec(text);
        if (ultracode) this.conversation.push(`  ⎿  Ultracode ${ultracode[1]} (this session only)`);
        else this.submitted.push(text);
      };
    } else if (key === "Esc") this.events.push("Esc at the prompt");
    else if (key.length === 1) this.box += key;
  }

  private pickerKey(key: string): void {
    if (key === "Enter") {
      this.events.push("ENTER IN THE PICKER (saves the default for every session)");
      this.mode = "prompt";
    } else if (key === "s") {
      this.model = this.cursor;
      this.effort = this.pickerEffort;
      this.mode = "prompt";
      this.conversation.push("❯ /model", `  ⎿  Set model to ${name(this.model)} for this session only with ${EFFORTS[this.effort]?.toLowerCase()} effort`);
    } else if (key === "Esc") {
      this.mode = "prompt";
      this.conversation.push("❯ /model", "  ⎿  Kept model as X");
    } else if (key === "Up") this.cursor = Math.max(0, this.cursor - 1);
    else if (key === "Down") this.cursor = Math.min(MODELS.length - 1, this.cursor + 1);
    else if (key === "Right" || key === "Left") {
      const step = key === "Right" ? 1 : -1;
      let e = this.pickerEffort + step;
      if (this.cursor === this.noXHigh && e === 3) e += step;
      this.pickerEffort = Math.max(0, Math.min(4, e));
    } else this.events.push(`key ${key} in the picker`);
  }

  /** The screen, as `zellij action dump-screen --ansi` gives it. An empty box shows a suggestion, drawn dim. */
  ansi(): string {
    this.pump();
    const head = [" ▐▛███▛█   Claude Code v2.1.322", ...this.conversation];
    if (this.mode === "prompt") {
      const box = (this.box ? `❯ ${this.box}` : "❯ \x1b[2m前の指示をもう一度\x1b[22m").split("\n").map((l, i) => (i === 0 ? l : `  ${l}`));
      return [...head, RULE, ...box, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)", ""].join("\n");
    }
    const rows = MODELS.map((m, i) => {
      const [label, detail] = m.split(/\s{2,}/);
      return `   ${i === this.cursor ? "❯" : " "} ${i + 1}.  ${label}${i === this.model ? " ✔" : ""}${detail ? `  ${detail}` : ""}`;
    });
    return [
      ...head,
      "▔".repeat(50),
      "   Select model",
      ...rows,
      "     ▸   More models",
      `   ◐ ${EFFORTS[this.pickerEffort]} effort ←/→ to adjust`,
      "   Enter to set as default · s to use this",
      "   session only · Esc to cancel",
    ].join("\n");
  }
}

const SID = "11111111-2222-3333-4444-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A daemon whose zellij is the fake terminal and whose session is idle; Enter is given `enterWaitMs` to be taken. */
async function setup(c: FakeClaude, enterWaitMs = 400) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-typing-"));
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
    { enterWaitMs },
  ) as unknown as Record<string, any>;
  d.zellij = {
    screen: async () => readScreen(c.ansi()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((key) => c.push({ key })),
    paste: async (_s: string, text: string) => c.push({ paste: text }),
  };
  d.currentStatus = async () => "idle";
  d.scheduleRefresh = () => undefined;
  d.emitSessions = () => undefined;
  d.managed.add({ sessionId: SID, zellijSession: "z", pid: 1, cwd: dir, name: "fake", launchedAt: 1 });
  d.tracked.set(SID, {
    info: { sessionId: SID, cwd: dir, status: "idle", rcMode: "none", prLinks: [], model: name(c.model), effort: "medium", ultracode: false },
    meta: { prLinks: [] },
  });
  return { d, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("the dim suggestion in an empty box is not typed text: the input goes in once and is sent", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  assert.equal(await d.typeInput("z", "テストを直して"), "sent");
  assert.deepEqual(c.submitted, ["テストを直して"]);
  await done();
});

test("an Enter taken late is never pressed again: the next look finds the box empty and types nothing", async () => {
  const c = new FakeClaude();
  c.enterDelayMs = 900;
  const { d, done } = await setup(c);
  assert.equal(await d.typeInput("z", "長い作業をお願いします"), "unsure");
  await sleep(700);
  assert.equal(await d.typeInput("z", "長い作業をお願いします", true), "sent");
  assert.deepEqual(c.submitted, ["長い作業をお願いします"]);
  await done();
});

test("a lost Enter is pressed once more when the next look finds the text still in the box", async () => {
  const c = new FakeClaude();
  c.loseEnter = true;
  const { d, done } = await setup(c);
  assert.equal(await d.typeInput("z", "消えた Enter"), "unsure");
  assert.equal(await d.typeInput("z", "消えた Enter", true), "sent");
  assert.deepEqual(c.submitted, ["消えた Enter"]);
  await done();
});

test("when /model is taken late, nothing is typed behind it; the next try closes the late picker and switches", async () => {
  const c = new FakeClaude();
  c.enterDelayMs = 900;
  const { d, done } = await setup(c);
  const r = await d.input({ type: "session.input", requestId: "r", sessionId: SID, text: "はいと言って", model: "haiku" });
  assert.equal(r.ok, true);
  assert.equal(r.queued, true);
  assert.match(r.warning, /やり直します/);
  await sleep(700);
  c.ansi();
  assert.equal(c.mode, "picker"); // the late Enter opened it; nothing was typed into it
  c.enterDelayMs = 0;
  d.settleUntil.clear();
  const out = await d.flushInput(SID);
  assert.deepEqual(out, { id: "r", warnings: [], unapplied: [] });
  assert.equal(name(c.model), "Haiku 5.5");
  assert.deepEqual(c.submitted, ["はいと言って"]);
  assert.deepEqual(c.events, []);
  assert.equal(d.managed.pending(SID), 0);
  await done();
});

test("an effort level the model lacks is put back, and only the model is switched", async () => {
  const c = new FakeClaude();
  c.noXHigh = 4;
  const { d, done } = await setup(c);
  const out = { warnings: [] as string[], unapplied: [] as string[] };
  await d.switchModel("z", "haiku", "xhigh", d.tracked.get(SID), out);
  assert.equal(name(c.model), "Haiku 5.5");
  assert.equal(EFFORTS[c.effort], "Medium");
  assert.deepEqual(out.unapplied, ["effort"]);
  assert.match(out.warnings[0] ?? "", /xHigh にできませんでした（このモデルでは選べません）。モデルだけ切り替えます。/);
  assert.deepEqual(c.events, []);
  await done();
});

test("effort alone is switched on the model in use, and a question quoted in the conversation changes nothing", async () => {
  const c = new FakeClaude();
  c.conversation.push("● 確認はこう出ます:", "   ❯ 1. Yes, switch to Haiku 5.5", "     2. No, go back");
  const { d, done } = await setup(c);
  const out = { warnings: [] as string[], unapplied: [] as string[] };
  await d.switchModel("z", undefined, "high", d.tracked.get(SID), out);
  assert.equal(name(c.model), "Sonnet 5.5");
  assert.equal(EFFORTS[c.effort], "High");
  assert.deepEqual(out, { warnings: [], unapplied: [] });
  assert.deepEqual(c.events, []);
  await done();
});

test("after a stop, a text whose late Enter was taken is not sent again when Claude Code puts it back in the box", async () => {
  for (const followed of [false, true]) {
    const c = new FakeClaude();
    c.enterDelayMs = 900;
    const { d, done } = await setup(c);
    const r = await d.input({ type: "session.input", requestId: "r", sessionId: SID, text: "テストを流して" });
    assert.match(r.warning, /まだ残っていれば送ります/);
    await sleep(700);
    c.ansi(); // Claude Code took the Enter late and works on it
    assert.deepEqual(c.submitted, ["テストを流して"]);
    if (followed) {
      // Its transcript is followed: the message is recorded there.
      d.tracked.get(SID).tail = {};
      d.pollTails = async () => undefined;
      d.notePrompts(SID, [{ uuid: "u", role: "user", blocks: [{ type: "text", text: "テストを流して" }] }]);
    } else {
      // Not followed: the session is seen busy.
      d.currentStatus = async () => "busy";
      d.settleUntil.clear();
      await d.flushInput(SID);
      d.currentStatus = async () => "idle";
    }
    // Stopped before the reply: Claude Code puts the text back into the box.
    c.box = "テストを流して";
    d.settleUntil.clear();
    await d.flushInput(SID);
    await sleep(300);
    c.ansi();
    assert.deepEqual(c.submitted, ["テストを流して"], followed ? "transcript" : "busy");
    assert.equal(d.managed.pending(SID), 0);
    await done();
  }
});

test("a text whose Enter may have been pressed is never pasted again, even when a later try finds no prompt box", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  // The Enter key fails after it reached the pane, and Claude Code takes it late.
  c.enterDelayMs = 900;
  const keys = d.zellij.keys;
  d.zellij.keys = async (s: string, ...k: string[]) => {
    await keys(s, ...k);
    if (k.includes("Enter")) throw new Error("send-keys timed out");
  };
  const r = await d.input({ type: "session.input", requestId: "r", sessionId: SID, text: "一度だけ送って" });
  assert.equal(r.queued, true);
  d.zellij.keys = keys;
  assert.equal(d.managed.peek(SID)?.entered, true);
  // The next try finds no prompt box (the screen cannot be read): the text stays marked as entered.
  await sleep(700);
  const screen = d.zellij.screen;
  let reads = 0;
  d.zellij.screen = async () => {
    reads += 1;
    if (reads > 1) throw new Error("dump-screen failed");
    return screen();
  };
  d.settleUntil.clear();
  await d.flushInput(SID);
  d.zellij.screen = screen;
  assert.equal(d.managed.peek(SID)?.entered, true);
  d.settleUntil.clear();
  await d.flushInput(SID);
  await sleep(300);
  c.ansi();
  assert.deepEqual(c.submitted, ["一度だけ送って"]);
  assert.equal(d.managed.pending(SID), 0);
  await done();
});

test("an input reports only its own outcome, not that of an earlier queued input", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  d.managed.enqueue(SID, { id: "earlier", text: "先の指示", model: "fable" });
  d.models = { at: Date.now(), options: [{ id: "opus", name: "Opus 5.5" }] };
  const r = await d.input({ type: "session.input", requestId: "mine", sessionId: SID, text: "後の指示" });
  assert.equal(r.warning, undefined);
  assert.equal(r.unapplied, undefined);
  assert.equal(r.queued, true);
  await done();
});

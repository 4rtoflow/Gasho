import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cleanEnv,
  clearPromptKeys,
  launchableFolders,
  launchArgs,
  ManagedSessions,
  modelPickerOptions,
  pickerMatches,
  promptBoxLines,
  promptHolds,
  safeFileName,
  zellijSessionName,
} from "../src/managed.ts";

test("cleanEnv keeps only what Claude Code and zellij need", () => {
  const env = cleanEnv({
    HOME: "/home/rg",
    PATH: "/usr/bin",
    USER: "rg",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "x",
    ZELLIJ_SESSION_NAME: "main",
    ZELLIJ: "0",
    GASHO_HOOK_SECRET: "secret",
  });
  assert.equal(env.HOME, "/home/rg");
  assert.equal(env.TERM, "xterm-256color");
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "ZELLIJ_SESSION_NAME", "ZELLIJ", "GASHO_HOOK_SECRET"]) {
    assert.equal(env[k], undefined, k);
  }
});

test("zellij session names are safe and unique per launch", () => {
  assert.equal(zellijSessionName("Bobert の作業", "ab12"), "gasho-bobert-ab12");
  assert.equal(zellijSessionName("!!!", "ab12"), "gasho-session-ab12");
  assert.notEqual(zellijSessionName("x"), zellijSessionName("x"));
});

test("launchArgs starts claude --remote-control through a shell that records its PID", () => {
  const args = launchArgs({
    zellijSession: "gasho-x-1",
    pidFile: "/s/x.pid",
    cwd: "/home/rg/repos/Gasho",
    claudeBin: "claude",
    rcName: "Gasho-gasho",
    env: { HOME: "/home/rg", PATH: "/usr/bin" },
  });
  assert.deepEqual(args.slice(0, 4), ["attach", "--create-background", "gasho-x-1", "--"]);
  const i = args.indexOf("-c");
  assert.match(args[i + 1] ?? "", /echo \$\$ > "\$1" && cd "\$2" && shift 2 && exec "\$@"/);
  assert.deepEqual(args.slice(i + 3, i + 5), ["/s/x.pid", "/home/rg/repos/Gasho"]);
  assert.deepEqual(args.slice(-6), ["-i", "HOME=/home/rg", "PATH=/usr/bin", "claude", "--remote-control", "Gasho-gasho"]);
});

test("managed sessions keep their input queue in order and survive a reload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "s1", zellijSession: "z1", pid: 1, cwd: "/x", name: "x", launchedAt: 1 });
    a.add({ sessionId: "s2", zellijSession: "z2", pid: 2, cwd: "/y", name: "y", launchedAt: 2 });
    await a.save();
    assert.equal(a.enqueue("s1", { text: "one", model: "sonnet" }), 1);
    assert.equal(a.enqueue("s1", { text: "two" }), 2);
    const first = a.next("s1");
    assert.deepEqual(first, { text: "one", model: "sonnet" });
    if (first) a.unshift("s1", first);
    assert.deepEqual([a.next("s1"), a.next("s1"), a.next("s1")], [{ text: "one", model: "sonnet" }, { text: "two" }, undefined]);

    const b = new ManagedSessions(file);
    await b.load(async (m) => m.sessionId === "s2"); // s1's process is gone
    assert.deepEqual(
      b.all().map((m) => m.sessionId),
      ["s2"],
    );
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("launchableFolders lists trusted folders that exist, plus the given ones", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-home-"));
  try {
    const trusted = path.join(home, "repos", "a");
    const untrusted = path.join(home, "repos", "b");
    await fs.mkdir(trusted, { recursive: true });
    await fs.mkdir(untrusted, { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "not-read@example.com" },
        projects: {
          [trusted]: { hasTrustDialogAccepted: true },
          [untrusted]: { hasTrustDialogAccepted: false },
          [path.join(home, "gone")]: { hasTrustDialogAccepted: true },
          [home]: { hasTrustDialogAccepted: true },
        },
      }),
    );
    assert.deepEqual(await launchableFolders(home, []), [trusted]);
    assert.deepEqual(await launchableFolders(home, [untrusted]), [trusted, untrusted].sort());
  } finally {
    await fs.rm(home, { recursive: true });
  }
});

// Screens dumped from Claude Code v2.1.322 in a 50-column zellij pane.
const RULE = "─".repeat(50);
const screenWith = (...box: string[]) =>
  [
    " ▐▛███▛█   Claude Code v2.1.322",
    "  /remote-control is active · Continue here, on",
    "❯ 前の指示",
    "● はい",
    RULE,
    ...box,
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
    "",
  ].join("\n");

test("promptBoxLines reads the prompt box at the bottom of the screen", () => {
  assert.deepEqual(promptBoxLines(screenWith("❯ ")), ["❯"]);
  assert.deepEqual(promptBoxLines(screenWith("❯ 停止の実験 その2。", "  二行目です。", "  三行目は折り返される")), [
    "❯ 停止の実験 その2。",
    "  二行目です。",
    "  三行目は折り返される",
  ]);
  assert.deepEqual(promptBoxLines(screenWith("❯ [Pasted text #2 +40 lines]")), ["❯ [Pasted text #2 +40 lines]"]);
  assert.equal(promptBoxLines(screenWith(" Do you want to proceed?", " ❯ 1. Yes")), undefined);
  assert.equal(promptBoxLines("no prompt here"), undefined);
});

test("clearPromptKeys sends one Ctrl+U and Backspace pair per line, plus one", () => {
  assert.deepEqual(clearPromptKeys(1), ["Ctrl u", "Backspace", "Ctrl u", "Backspace"]);
  assert.equal(clearPromptKeys(3).length, 8);
  assert.equal(clearPromptKeys(0).length, 4);
  assert.ok(!clearPromptKeys(5).includes("Ctrl c"));
});

// The /model picker as Claude Code v2.1.322 draws it in a 50-column pane (descriptions wrap onto more lines).
const PICKER = [
  "❯ 1. 前の回答の箇条書き", // a numbered line of the conversation above the picker must not count
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Select model",
  "   Switch between Claude models. Your pick",
  "     1.  Default (recommended)  Opus 5.5 · Best",
  "                                for everyday,",
  "     2.  Opus 5.5               For complex",
  "     3.  Fable 5.2              For your",
  "   ❯ 4.  Sonnet 5.5 ✔           Most efficient",
  "     5.  Haiku 5.5              Fastest for",
  "     ▸   More models",
  "   ◐ Medium effort (default) ←/→ to adjust",
  "   Enter to set as default · s to use this",
  "   session only · Esc to cancel",
].join("\n");

test("modelPickerOptions reads the /model picker, its cursor and the current model", () => {
  const options = modelPickerOptions(PICKER);
  assert.deepEqual(
    options.map((o) => o.label),
    ["Default (recommended)", "Opus 5.5", "Fable 5.2", "Sonnet 5.5", "Haiku 5.5"],
  );
  assert.deepEqual(
    options.map((o) => [o.cursor, o.current]),
    [
      [false, false],
      [false, false],
      [false, false],
      [true, true],
      [false, false],
    ],
  );
  assert.deepEqual(modelPickerOptions("❯ 1. something\n❯ /model"), []);
  assert.ok(pickerMatches("Default (recommended)", "default"));
  assert.ok(pickerMatches("Haiku 5.5", "haiku"));
  assert.ok(!pickerMatches("Opus 5.5", "sonnet"));
});

test("safeFileName keeps letters of any script and the extension, and nothing that could leave the folder", () => {
  assert.equal(safeFileName("画面 1.png"), "画面_1.png");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..\\secret.txt"), "secret.txt");
  assert.equal(safeFileName(".env"), "env");
  assert.equal(safeFileName("a;b|c$(d).sh"), "a_b_c_d_.sh");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName(`${"x".repeat(150)}.pdf`).length, 100);
  assert.ok(safeFileName(`${"x".repeat(150)}.pdf`).endsWith(".pdf"));
});

test("promptHolds tells whether the prompt box holds the text, folded or collapsed into [Pasted text]", () => {
  assert.ok(promptHolds(screenWith("❯ これは停止の実験です。「はい」とだけ返してくだ", "  さい。"), "これは停止の実験です。「はい」とだけ返してください。"));
  assert.ok(promptHolds(screenWith("❯ [Pasted text #2 +40 lines]"), "長い\n指示"));
  assert.ok(!promptHolds(screenWith("❯ "), "これは"));
  assert.ok(!promptHolds(screenWith('❯ Try "edit hub.test.ts to..."'), "これは"));
  assert.ok(!promptHolds("no prompt box", "これは"));
});

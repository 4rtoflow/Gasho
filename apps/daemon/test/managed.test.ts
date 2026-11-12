import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  atBottom,
  cleanEnv,
  clearPromptKeys,
  dialogOpen,
  launchableFolders,
  launchArgs,
  ManagedSessions,
  EFFORT_LEVELS,
  modelPickerOptions,
  pickerCatalog,
  pickerEffort,
  pickerMatches,
  plainScreen,
  promptBoxLines,
  promptHolds,
  promptRuleUltracode,
  readScreen,
  refusedCommand,
  safeFileName,
  statusLine,
  switchedForSession,
  switchQuestion,
  typedInBox,
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
  const held = (screen: string, text: string) => promptHolds(plainScreen(screen), text);
  assert.ok(held(screenWith("❯ これは停止の実験です。「はい」とだけ返してくだ", "  さい。"), "これは停止の実験です。「はい」とだけ返してください。"));
  assert.ok(held(screenWith("❯ [Pasted text #2 +40 lines]"), "長い\n指示"));
  assert.ok(!held(screenWith("❯ "), "これは"));
  assert.ok(!held(screenWith('❯ Try "edit hub.test.ts to..."'), "これは"));
  assert.ok(!held("no prompt box", "これは"));
});

// The bottom of a screen dumped with `zellij action dump-screen --ansi` from Claude Code v2.1.322: the conversation
// shows the user's message, and the prompt box below shows Claude Code's suggestion to send it again, drawn dim.
const ANSI_BOTTOM = [
  "\x1b[38;2;153;153;153m\x1b[48;2;55;55;55m\x1b[22m\x1b[23m❯ \x1b[38;2;255;255;255m\x1b[48;2;55;55;55m\x1b[22m「はい」とだけ返してください。\x1b[39m",
  "",
  "\x1b[38;2;255;255;255m\x1b[49m\x1b[22m\x1b[23m●\x1b[m はい",
  "",
  `\x1b[38;2;136;136;136m\x1b[49m\x1b[22m\x1b[24m\x1b[22m\x1b[23m${"─".repeat(38)}\x1b[m \x1b[38;2;175;135;255m\x1b[49m\x1b[22multracode\x1b[m \x1b[38;2;136;136;136m─`,
  "\x1b[m❯\u00a0\x1b[39m\x1b[49m\x1b[29m\x1b[28m\x1b[27m\x1b[25m\x1b[25m\x1b[22m\x1b[24m\x1b[2m\x1b[23m「はい」とだけ返してください。",
  `\x1b[38;2;136;136;136m\x1b[49m\x1b[22m\x1b[24m\x1b[22m\x1b[23m${"─".repeat(50)}`,
  "\x1b[m  \x1b[38;2;255;193;7m\x1b[49m\x1b[22m⏵⏵ auto mode on\x1b[38;2;153;153;153m (shift+tab to cycle)\x1b[m",
  "",
].join("\n");

test("readScreen leaves what is drawn dim out of the typed text, and keeps every line", () => {
  const s = readScreen(ANSI_BOTTOM);
  assert.equal(s.plain.split("\n").length, s.typed.split("\n").length);
  assert.ok(!s.plain.includes("\x1b"));
  // The suggestion in the box is on the screen, but nobody typed it.
  assert.deepEqual(promptBoxLines(s.plain), ["❯\u00a0「はい」とだけ返してください。"]);
  assert.equal(typedInBox(s), "");
  assert.ok(!promptHolds(s, "「はい」とだけ返してください。"));
  assert.equal(promptRuleUltracode(s.plain), true);
  // Typed text in the same place counts.
  const typed = readScreen(ANSI_BOTTOM.replace("\x1b[2m\x1b[23m「はい」", "\x1b[22m\x1b[23m「はい」"));
  assert.ok(promptHolds(typed, "「はい」とだけ返してください。"));
  // Colours whose values contain a 2 ("38;2;…", "48;5;2") are not dim; SGR 0, an empty SGR and 22 end dim.
  assert.equal(readScreen("\x1b[38;2;2;2;2ma\x1b[48;5;2mb\x1b[2mc\x1b[0md\x1b[2me\x1b[mf\x1b[2;1mg\x1b[22mh").typed, "abdfh");
  assert.equal(readScreen("\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b(Bok").plain, "link ok");
  // A dim run that crosses a line break keeps the break.
  assert.equal(readScreen("\x1b[2mone\ntwo\x1b[22m three").typed, "\n three");
});

// The picker after ultracode was turned on and the default model moved to Sonnet 5.5 (its label gets cut short).
const PICKER_DEFAULT_SONNET = [
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ● high · ultracode · /effort ▔",
  "   Select model",
  "   ❯ 1.  Default (recommend… ✔  Sonnet 5.5 ·",
  "                                Efficient for",
  "     2.  Opus 5.5               For complex",
  "     3.  Fable 5.2              For your",
  "     4.  Sonnet 5.5             Most efficient",
  "     5.  Haiku 5.5              Fastest for",
  "     ▸   More models",
  "   ◉ xHigh effort ←/→ to adjust · Ultracode on",
  "   (/effort)",
  "   Enter to set as default · s to use this",
  "   session only · Esc to cancel",
].join("\n");

test("the /model picker gives the model names with their versions, the model the default stands for, and the effort", () => {
  const options = modelPickerOptions(PICKER_DEFAULT_SONNET);
  assert.equal(options[0]?.label, "Default (recommend…");
  assert.ok(options[0]?.cursor && options[0].current);
  assert.deepEqual(pickerCatalog(options), [
    { id: "default", name: "Sonnet 5.5" },
    { id: "opus", name: "Opus 5.5" },
    { id: "fable", name: "Fable 5.2" },
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "haiku", name: "Haiku 5.5" },
  ]);
  assert.equal(pickerEffort(PICKER_DEFAULT_SONNET), "xhigh");
  const KEYS = "   Enter to set as default · s to use this\n   session only · Esc to cancel";
  assert.equal(pickerEffort(`   Select model\n   ◐ Medium effort (default) ←/→ to adjust ·\n${KEYS}`), "medium");
  // Only the picker counts, not the conversation above it.
  assert.equal(pickerEffort(`     session only with medium effort\n   Select model\n   ● High effort ←/→ to adjust\n${KEYS}`), "high");
  assert.equal(pickerEffort("     session only with medium effort"), undefined);
  // Without its key help at the bottom, it is not the picker.
  assert.equal(pickerEffort("   Select model\n   ● High effort ←/→ to adjust"), undefined);
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
});

test("statusLine reads the effort level and ultracode shown above the prompt box", () => {
  const screen = (status: string) => ["● はい", `                  ${status}`, "─".repeat(50), "❯ ", "─".repeat(50)].join("\n");
  assert.deepEqual(statusLine(screen("◐ medium · ultracode · /effort")), { effort: "medium", ultracode: true });
  assert.deepEqual(statusLine(screen("● high · /effort")), { effort: "high", ultracode: false });
  assert.deepEqual(statusLine(screen("◈ max · /effort")), { effort: "max", ultracode: false });
  assert.equal(statusLine("no status here"), undefined);
  // A status line left from an earlier frame higher up does not count.
  assert.equal(statusLine(["   ◐ medium · ultracode · /effort", "● はい", "─".repeat(50), "❯ ", "─".repeat(50)].join("\n")), undefined);
  // The picker's own effort line ("Ultracode on (/effort)") is not the status line.
  assert.equal(statusLine("   ◐ Medium effort (default) ←/→ to adjust ·\n   Ultracode on (/effort)"), undefined);
});

test("promptRuleUltracode reads the ultracode mark in the rule above the prompt box", () => {
  assert.equal(promptRuleUltracode(["● はい", `${"─".repeat(38)} ultracode ─`, "❯ ", "─".repeat(50)].join("\n")), true);
  assert.equal(promptRuleUltracode(screenWith("❯ ")), false);
  assert.equal(promptRuleUltracode("no prompt box"), undefined);
});

test("the question before a model switch is recognised at the bottom only, and only the latest /model output counts as switched", () => {
  const question = [
    "● はい",
    "   Your next response will be slower and use",
    "   more tokens",
    "   This conversation is cached for the current",
    "   model. Switching to Haiku 5.5 means the full",
    "   history gets re-read.",
    "   ❯ 1. Yes, switch to Haiku 5.5",
    "     2. No, go back",
  ].join("\n");
  assert.deepEqual(switchQuestion(question), { onYes: true, aboutCache: true });
  assert.deepEqual(switchQuestion(question.replace("   ❯ 1.", "     1.").replace("     2.", "   ❯ 2.")), { onYes: false, aboutCache: true });
  assert.ok(dialogOpen(question));
  // The same choices for a confirmation a hook asks for: not Gasho's to answer.
  const hook = ["   Switch model?", "   A PreModelSwitch hook asked you to confirm", "   ❯ 1. Yes, switch to Fable 5.2", "     2. No, go back"].join("\n");
  assert.deepEqual(switchQuestion(hook), { onYes: true, aboutCache: false });
  // Quoted in the conversation, with the prompt box below it: not a question.
  const quoted = screenWith("❯ ").replace("● はい", `● はい\n${question}`);
  assert.equal(switchQuestion(quoted), undefined);
  assert.ok(!dialogOpen(quoted));
  assert.equal(typedInBox(plainScreen(quoted)), "");
  const switched = ["❯ /model", "  ⎿  Set model to Haiku 5.5 for this session only", "     with high effort", "❯ 「はい」", "● はい"].join("\n");
  assert.ok(!switchedForSession(switched + "\n❯ /model\n  ⎿  Kept model as Haiku 5.5"));
  assert.ok(switchedForSession(switched));
});

test("the /model picker is read only at the bottom of the screen, not where the conversation quotes one", () => {
  const quoted = [
    "● The picker looked like this:",
    "   Select model",
    "   ❯ 1.  Default (recommended) ✔  Opus 5.5 · Best",
    "   ◐ High effort ←/→ to adjust",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");
  // A quote above the prompt box is not a picker.
  const withBox = screenWith("❯ ").replace("● はい", quoted);
  assert.deepEqual(modelPickerOptions(withBox), []);
  assert.equal(pickerEffort(withBox), undefined);
  assert.ok(!dialogOpen(withBox));
  // A quote above the real picker: the real one (the last) is read.
  const both = `${quoted}\n${PICKER_DEFAULT_SONNET}`;
  assert.equal(modelPickerOptions(both).length, 5);
  assert.equal(pickerCatalog(modelPickerOptions(both))[0]?.name, "Sonnet 5.5");
  assert.equal(pickerEffort(both), "xhigh");
  assert.ok(dialogOpen(both));
  assert.equal(typedInBox(plainScreen(both)), undefined);
});

test("atBottom looks at the last lines only, read as one text", () => {
  const screen = ["Do you want to proceed?", ...Array<string>(20).fill("● 作業中"), " Do you trust the files in this", " folder?", ""].join("\n");
  assert.ok(!atBottom(screen, /Do you want to proceed\?/));
  assert.ok(atBottom(screen, /trust the files in this folder/));
  assert.ok(atBottom(screen, /Do you want to proceed\?/, 30));
});

test("commands that would change the defaults of every new session are refused", () => {
  for (const text of ["/model", "/model sonnet", "  /model\nopus", "/MODEL haiku", "/effort", "/effort high", "/effort ultracode", "/effort ultracode on please"]) {
    assert.ok(refusedCommand(text), text);
  }
  for (const text of ["/effort ultracode on", "/effort ultracode off", " /effort ultracode on ", "/exit", "/models の説明をして", "model を変えて", "please /model"]) {
    assert.equal(refusedCommand(text), undefined, text);
  }
});

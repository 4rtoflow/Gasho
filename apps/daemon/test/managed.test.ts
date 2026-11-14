import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  atBottom,
  bannerModel,
  cleanEnv,
  clearPromptKeys,
  dialogOpen,
  launchableFolders,
  ManagedSessions,
  EFFORT_LEVELS,
  forkName,
  isRename,
  MAX_SESSION_NAME,
  modelPickerOptions,
  renameCommand,
  resumeQuestionOpen,
  sessionName,
  titleName,
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
  surveyOpen,
  switchedForSession,
  switchQuestion,
  terminalName,
  typedInBox,
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

test("terminal names are safe and unique per launch", () => {
  assert.equal(terminalName("Bobert の作業", "ab12"), "gasho-bobert-ab12");
  assert.equal(terminalName("!!!", "ab12"), "gasho-session-ab12");
  assert.notEqual(terminalName("x"), terminalName("x"));
});

test("sessions in zellij (from gasho-daemon 0.10 and before) are read and saved the way those daemons save them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "managed.json");
    const old = { sessionId: "s1", zellijSession: "gasho-old-ab12", pid: 1, cwd: "/x", name: "x", launchedAt: 1 };
    const now = { sessionId: "s2", terminal: "gasho-new-cd34", pid: 2, cwd: "/y", name: "y", launchedAt: 2 };
    await fs.writeFile(file, JSON.stringify([old, now]));
    const a = new ManagedSessions(file);
    const seen: unknown[] = [];
    await a.load(async (m) => {
      seen.push(m);
      return true;
    });
    assert.deepEqual(seen, [
      { sessionId: "s1", terminal: "gasho-old-ab12", zellij: true, pid: 1, cwd: "/x", name: "x", launchedAt: 1 },
      now,
    ]);
    // Saved again (load saves), each in its own form: an older daemon still finds the session in zellij.
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), [old, now]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("managed sessions keep their input queue in order and survive a reload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "s1", terminal: "z1", pid: 1, cwd: "/x", name: "x", launchedAt: 1 });
    a.add({ sessionId: "s2", terminal: "z2", pid: 2, cwd: "/y", name: "y", launchedAt: 2 });
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

test("the rule above the prompt box can carry a name that leaves few \"─\" before it, or none", () => {
  // As Claude Code draws it after /rename, in a 50-column terminal: a fork's name left only four "─".
  const named = (rule: string, ...box: string[]) =>
    ["❯ /rename Gasho iPhone用クライアントアプリ のフォーク", "  ⎿  Session renamed to: Gasho", rule, ...box, RULE, "  ⏵⏵ auto mode on"].join("\n");
  const fork = "──── Gasho iPhone用クライアントアプリ のフォーク ─";
  assert.deepEqual(promptBoxLines(named(fork, "❯ ")), ["❯"]);
  assert.equal(typedInBox(plainScreen(named(fork, "❯ "))), "");
  assert.ok(!dialogOpen(named(fork, "❯ ")));
  assert.ok(promptHolds(plainScreen(named(fork, "❯ npx でのdaemonパッケージのセットアップをしたい")), "npx でのdaemonパッケージのセットアップをしたい"));
  assert.equal(promptRuleUltracode(named(fork, "❯ ")), false);
  // Should a name fill the whole rule, only the "─" at its end may be left.
  assert.deepEqual(promptBoxLines(named(" Gasho iPhone用クライアントアプリ のフォーク のフ… ─", "❯ ")), ["❯"]);
  // A dialog's options are indented: still no prompt box, whatever the rule above them carries.
  assert.equal(promptBoxLines(named(fork, " Do you want to proceed?", " ❯ 1. Yes")), undefined);
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
  for (const text of ["/effort ultracode on", "/effort ultracode off", " /effort ultracode on ", "/exit", "/models の説明をして", "model を変えて", "please /model", "/model-review を実行して", "/effort-estimate この課題", "/model:fast"]) {
    assert.equal(refusedCommand(text), undefined, text);
  }
});

test("Claude Code's cursor on the first character of a dim suggestion is not typed text", () => {
  // Without the terminal's own cursor, the first character is drawn reversed and the rest dim.
  const box = (inner: string) => [`${"─".repeat(50)}`, `❯ ${inner}`, "─".repeat(50), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
  assert.equal(typedInBox(readScreen(box("\x1b[7m「\x1b[27m\x1b[2mはい」とだけ返してください。\x1b[22m"))), "");
  assert.equal(typedInBox(readScreen(box('\x1b[7mT\x1b[27m\x1b[2mry "edit hub.test.ts to..."\x1b[22m'))), "");
  // A reversed character inside typed text (the cursor moved back) is typed text.
  assert.equal(typedInBox(readScreen(box("ab\x1b[7mc\x1b[27md"))), "abcd");
  assert.equal(typedInBox(readScreen(box("abc\x1b[7m \x1b[27m"))), "abc");
});

test("with the prompt box at the bottom, words in the box or the conversation do not count as a dialog", () => {
  // The user's own message names a permission dialog; Claude's last reply asks the same.
  const own = screenWith("❯ 「Do you want to proceed?」と聞かれたら 1 を選んで");
  assert.ok(!dialogOpen(own));
  assert.ok(promptHolds(plainScreen(own), "「Do you want to proceed?」と聞かれたら 1 を選んで"));
  const reply = screenWith("❯ ").replace("● はい", "● Removing them is irreversible. Do you want to proceed?\n  Or trust this folder first.");
  assert.ok(!dialogOpen(reply));
  assert.equal(typedInBox(plainScreen(reply)), "");
  // A real permission dialog has no prompt box below it.
  const dialog = [" ▐▛███▛█   Claude Code v2.1.322", "● Bash(rm -rf build)", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  assert.ok(dialogOpen(dialog));
  assert.equal(typedInBox(plainScreen(dialog)), undefined);
});

test("a text starting with \"!\" puts the box in shell mode, and the box is still read", () => {
  const shell = screenWith("! git status");
  assert.deepEqual(promptBoxLines(shell), ["! git status"]);
  assert.ok(promptHolds(plainScreen(shell), "!git status"));
  assert.ok(promptHolds(plainScreen(shell), "! git status"));
});

test("the survey counts only right above the prompt box, and only with its choices", () => {
  const survey = screenWith("❯ ").replace("● はい", "● はい\n● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss");
  assert.ok(surveyOpen(survey));
  assert.ok(!dialogOpen(survey));
  // Quoted in the conversation, with more below it.
  const quoted = screenWith("❯ ").replace("● はい", "● 「How is Claude doing this session?」と「1: Bad 2: Fine 3: Good 0: Dismiss」が出ます。\n✻ Churned for 1s");
  assert.ok(!surveyOpen(quoted));
  assert.ok(!surveyOpen("● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss"));
});

test("the question is judged by its own lines: \"hook\" in the conversation above does not make it a hook's question", () => {
  const question = (conversation: string, subtitle: string) =>
    [
      conversation,
      "   Switch model?",
      `   ${subtitle}`,
      "   This conversation is cached for the current",
      "   model. Switching to Haiku 5.5 means the full",
      "   history gets re-read.",
      "   ❯ 1. Yes, switch to Haiku 5.5",
      "     2. No, go back",
    ].join("\n");
  assert.deepEqual(switchQuestion(question("● Stop の hook を settings.json に登録しました。", "Your next response will be slower and use more tokens")), {
    onYes: true,
    aboutCache: true,
  });
  assert.deepEqual(switchQuestion(question("● はい", "A PreModelSwitch hook asked you to confirm")), { onYes: true, aboutCache: false });
});

test("the model in Claude Code's welcome banner is read before the transcript has one", () => {
  const banner = (second: string) =>
    ["", " ▐▛███▛█   Claude Code v2.1.322", second, " ▝▝   ▝▝   ~/repos/Bobert", "", "  /remote-control is active · Continue here, on"].join("\n");
  assert.equal(bannerModel(banner("▝▜██████▀  Sonnet 5.5 · Claude Ultra")), "Sonnet 5.5");
  assert.equal(bannerModel(banner("▝▜██████▀  Opus 4.6 (1M context) · API Usage Billing")), "Opus 4.6 (1M context)");
  // Not the banner's model line, or no banner at all.
  assert.equal(bannerModel(banner("▝▜██████▀  ~/repos/Bobert")), undefined);
  assert.equal(bannerModel(screenWith("❯ ")), undefined);
});

test("session names are one line of at most 60 characters, and a fork's default name fits", () => {
  assert.deepEqual(sessionName("  Bobert の調査  "), { name: "Bobert の調査" });
  assert.ok("error" in sessionName("   "));
  assert.ok("error" in sessionName("x".repeat(MAX_SESSION_NAME + 1)));
  assert.deepEqual(sessionName("x".repeat(MAX_SESSION_NAME)), { name: "x".repeat(MAX_SESSION_NAME) });
  // /rename takes the rest of its line: a second line would be typed as a message of its own.
  assert.ok("error" in sessionName("一行目\n/model opus"));
  assert.ok("error" in sessionName("tab\there"));
  assert.equal(forkName("Bobert-gasho"), "Bobert-gasho のフォーク");
  const long = forkName("あ".repeat(80));
  assert.equal(long.length, MAX_SESSION_NAME);
  assert.ok(long.endsWith(" のフォーク"));
  assert.equal(renameCommand("調査 その2"), "/rename 調査 その2");
  assert.ok(isRename("/rename 調査") && isRename("/name x") && isRename("/rename"));
  assert.ok(!isRename("/renamed") && !isRename("rename this") && !isRename("/model"));
});

test("a name taken from Claude Code's title is one line, clipped to 60 characters without cutting a character in half", () => {
  assert.equal(titleName("セッション名の自動設定"), "セッション名の自動設定");
  assert.equal(titleName("  一行目\n二行目\tと\u0007  "), "一行目 二行目 と");
  assert.equal(titleName(" \n "), undefined);
  assert.equal(titleName("x".repeat(80)), "x".repeat(MAX_SESSION_NAME));
  // An emoji is two UTF-16 units: one that would go past 60 is left out whole.
  const clipped = titleName(`${"x".repeat(MAX_SESSION_NAME - 1)}😀`);
  assert.equal(clipped, "x".repeat(MAX_SESSION_NAME - 1));
  // A space left at the end by the clipping goes.
  assert.equal(titleName(`${"x".repeat(MAX_SESSION_NAME - 1)} yy`), "x".repeat(MAX_SESSION_NAME - 1));
  for (const t of ["x".repeat(80), `${"あ".repeat(59)}😀`]) assert.ok(!("error" in sessionName(titleName(t) ?? "")));
});

test("a /rename still waiting is replaced, but not one whose Enter was pressed; names are kept on save", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "s1", terminal: "z1", pid: 1, cwd: "/x", name: "x", launchedAt: 1, forkOf: "s0", forkedAt: 1 });
    a.enqueue("s1", { text: "最初の指示" });
    a.enqueue("s1", { text: renameCommand("a") });
    a.enqueue("s1", { text: renameCommand("b"), entered: true, enteredAt: 5 });
    assert.equal(
      a.drop("s1", (input) => isRename(input.text)),
      1,
    );
    assert.deepEqual(
      a.waiting("s1").map((input) => input.text),
      ["最初の指示", "/rename b"],
    );
    assert.equal(a.drop("nobody", () => true), 0);
    assert.equal(a.setName("s1", "新しい名前"), true);
    assert.equal(a.setName("s1", "新しい名前"), false);
    assert.equal(a.setName("nobody", "x"), false);
    await a.save();
    const b = new ManagedSessions(file);
    await b.load(async () => true);
    assert.deepEqual(b.get("s1"), { sessionId: "s1", terminal: "z1", pid: 1, cwd: "/x", name: "新しい名前", launchedAt: 1, forkOf: "s0", forkedAt: 1 });
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("Claude Code's question when resuming an old, long session is a dialog; quoted in the conversation it is not", () => {
  const question = [
    " ▐▛███▛█   Claude Code v2.1.323",
    "❯ 前の指示",
    "● はい",
    "",
    " This session is 3h 5m old and 142.3k tokens.",
    "",
    " Resuming the full session will consume a",
    " substantial portion of your usage limits. We",
    " recommend resuming from a summary.",
    "",
    " ❯ 1. Resume from summary (recommended)",
    "   2. Resume full session as-is",
    "   3. Don't ask me again",
    "",
    " Enter to confirm · Esc to cancel",
    "",
  ].join("\n");
  assert.ok(resumeQuestionOpen(question));
  assert.ok(dialogOpen(question));
  assert.equal(typedInBox(plainScreen(question)), undefined);
  // Answered: the prompt box is back, and the conversation above may still mention the question.
  const quoted = screenWith("❯ ").replace(
    "● はい",
    "● This session is 3h 5m old and 142.3k tokens. Resume full session as-is を選ぶと…",
  );
  assert.ok(!resumeQuestionOpen(quoted));
  assert.ok(!dialogOpen(quoted));
  assert.equal(typedInBox(plainScreen(quoted)), "");
});

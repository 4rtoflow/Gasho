// Starting a session in a folder Claude Code does not trust yet: the question is found by its choices at the bottom,
// it is answered only when the launch asks for it (and then only with the cursor on "Yes, I trust this folder"), and
// the question about a folder's MCP servers that follows is answered with Esc. Screens as Claude Code 2.1.323 drew them
// in a 50-column zellij pane (Gasho's own terminals are as wide); the launches run against a fake terminal and a fake
// `claude agents` (no claude, no terminal).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { dialogOpen, mcpQuestionOpen, plainScreen, trustQuestion, typedInBox } from "../src/managed.ts";
import type { TerminalStart } from "../src/terminal.ts";

const RULE = "─".repeat(50);

function trustScreen(onYes: boolean, warnings: string[] = []): string {
  return [
    RULE,
    " Accessing workspace:",
    "",
    " /tmp/claude-1000/-home-rg-repos-Gasho/2591f41f-b",
    " ad4-4ca0-8809-bfaab0522045/scratchpad/trust-prob",
    " e/cloned",
    "",
    " Quick safety check: Is this a project you",
    " created or one you trust? (Like your own code, a",
    " well-known open source project, or work from",
    " your team). If not, take a moment to review",
    " what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and",
    " execute files here.",
    "",
    ...warnings.flatMap((w) => [...w.split("\n"), ""]),
    " Security guide",
    "",
    `${onYes ? "  " : " ❯"} No, exit`,
    `${onYes ? " ❯" : "  "} Yes, I trust this folder`,
    "",
    " Enter to confirm · Esc to cancel",
    "",
    "",
  ].join("\n");
}

const PERMISSIONS_WARNING = [
  " ⚠ This folder pre-approves 1 tool permission in",
  " .claude/settings.json:",
  "   Bash(ls:*)",
  " These will apply without asking. Only proceed if",
  " you trust this configuration.",
].join("\n");

const MCP_SCREEN = [
  RULE,
  "  New MCP server found in this project: demo",
  "  MCP servers may execute code or access system",
  "  resources. All tool calls require approval.",
  "  Learn more in the MCP documentation.",
  "",
  "    Use this MCP server",
  "    Use this and all future MCP servers in this",
  "    project",
  "  ❯ Continue without using this MCP server",
  "",
  "  Enter to confirm · Esc to cancel",
  "",
].join("\n");

function replScreen(above: string[] = []): string {
  return [
    " ▐▛███▛█   Claude Code v2.1.323",
    "▝▜██████▀  Opus 5.5 · Claude Ultra",
    " ▝▝   ▝▝   /…/scratchpad/trust-probe/parent",
    ...above,
    "                              ◐ medium · /effort",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for …",
    "",
  ].join("\n");
}

test("the trust question is found by its two choices at the bottom, with where the cursor is", () => {
  assert.deepEqual(trustQuestion(trustScreen(false)), { onYes: false, yesBelow: true, warnings: [] });
  assert.deepEqual(trustQuestion(trustScreen(true)), { onYes: true, yesBelow: true, warnings: [] });
  assert.ok(dialogOpen(trustScreen(false)));
  assert.equal(typedInBox(plainScreen(trustScreen(false))), undefined);
  // Quoted in a conversation above the prompt box, the same words are not the question.
  const quoted = replScreen(["● Claude Code asked:", " ❯ No, exit", "   Yes, I trust this folder", "  Enter to confirm · Esc to cancel"]);
  assert.equal(trustQuestion(quoted), undefined);
});

test("what Claude Code points out about the folder's settings comes with the question, one paragraph each", () => {
  const q = trustQuestion(trustScreen(false, [PERMISSIONS_WARNING, " ⚠ This folder configures hooks that run commands,\n declared in .claude/settings.json."]));
  assert.deepEqual(q?.warnings, [
    "⚠ This folder pre-approves 1 tool permission in .claude/settings.json: Bash(ls:*) These will apply without asking. Only proceed if you trust this configuration.",
    "⚠ This folder configures hooks that run commands, declared in .claude/settings.json.",
  ]);
});

test("the question about a folder's new MCP servers is open only while it has the keys", () => {
  assert.ok(mcpQuestionOpen(MCP_SCREEN));
  assert.ok(dialogOpen(MCP_SCREEN));
  assert.ok(mcpQuestionOpen(MCP_SCREEN.replace("New MCP server found in this project: demo", "2 new MCP servers found in this project")));
  assert.equal(mcpQuestionOpen(replScreen()), false);
  assert.equal(mcpQuestionOpen(replScreen(["● It said: New MCP server found in this project: demo"])), false);
  assert.equal(mcpQuestionOpen(trustScreen(false)), false);
});

/** Claude Code starting in a folder it does not trust, as far as the daemon sees and drives it. */
class FakeStart {
  state: "trust" | "mcp" | "repl" | "exited" = "trust";
  /** 0: "No, exit", 1: "Yes, I trust this folder". */
  cursor = 0;
  keys: string[] = [];
  private readonly o: { mcp?: boolean; warnings?: string[]; agentsFile: string; sessionId: string };

  constructor(o: { mcp?: boolean; warnings?: string[]; agentsFile: string; sessionId: string }) {
    this.o = o;
  }

  key(k: string): void {
    this.keys.push(k);
    if (this.state === "trust") {
      if (k === "Down") this.cursor = 1;
      else if (k === "Up") this.cursor = 0;
      else if (k === "Enter") this.to(this.cursor === 1 ? (this.o.mcp ? "mcp" : "repl") : "exited");
      else if (k === "Esc") this.to("exited");
    } else if (this.state === "mcp" && (k === "Esc" || k === "Enter")) this.to("repl");
  }

  private to(state: FakeStart["state"]): void {
    this.state = state;
    // Once its prompt is up, `claude agents` lists the session.
    if (state === "repl") writeFileSync(this.o.agentsFile, JSON.stringify([{ pid: process.pid, sessionId: this.o.sessionId, status: "idle" }]));
  }

  screen(): string {
    if (this.state === "trust") return trustScreen(this.cursor === 1, this.o.warnings);
    if (this.state === "mcp") return MCP_SCREEN;
    return this.state === "repl" ? replScreen() : "";
  }
}

const SID = "11111111-2222-3333-4444-666666666666";

/** A daemon whose terminal is the fake one and whose `claude agents` reads a file the fake writes. */
async function setup(o: { mcp?: boolean; warnings?: string[] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-launch-"));
  const agentsFile = path.join(dir, "agents.json");
  await fs.writeFile(agentsFile, "[]");
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, `#!/bin/sh\ncat '${agentsFile}'\n`, { mode: 0o755 });
  const folder = path.join(dir, "cloned");
  await fs.mkdir(folder);
  const fake = new FakeStart({ ...o, agentsFile, sessionId: SID });
  const killed: string[] = [];
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir: path.join(dir, "claude-dir"),
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  d.canLaunch = true;
  const started: TerminalStart[] = [];
  d.terminals = {
    // The terminal answers with Claude Code's PID; `claude agents` (the fake) lists this process.
    start: async (o: TerminalStart) => {
      started.push(o);
      return process.pid;
    },
    screen: async () => plainScreen(fake.screen()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((k) => fake.key(k)),
    kill: async (s: string) => {
      killed.push(s);
      fake.state = "exited";
    },
  };
  d.refresh = async () => undefined;
  d.refreshFolders = async () => undefined;
  return { d, fake, folder, killed, started, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("without trust, the launch stops at the question: nothing is pressed, and Claude Code's warnings come back", async () => {
  const { d, fake, folder, killed, done } = await setup({ warnings: [PERMISSIONS_WARNING] });
  try {
    const r = await d.launch(folder, "clone-test");
    assert.equal(r.ok, false);
    assert.equal(r.needsTrust, true);
    assert.match(r.error, /まだ Claude Code に信頼されていません/);
    assert.deepEqual(r.trustWarnings, [
      "⚠ This folder pre-approves 1 tool permission in .claude/settings.json: Bash(ls:*) These will apply without asking. Only proceed if you trust this configuration.",
    ]);
    assert.deepEqual(fake.keys, []);
    assert.equal(killed.length, 1);
    assert.equal(d.managed.has(SID), false);
  } finally {
    await done();
  }
});

test("with trust, the cursor is moved to yes before the one Enter, and the session starts", async () => {
  const { d, fake, folder, killed, started, done } = await setup();
  try {
    const r = await d.launch(folder, "clone-test", true);
    assert.deepEqual(r, { ok: true, sessionId: SID });
    assert.deepEqual(fake.keys, ["Down", "Enter"]);
    assert.deepEqual(killed, []);
    assert.equal(d.managed.get(SID)?.cwd, folder);
    // Claude Code runs with Remote Control in the folder, in a terminal named after the session.
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.args, ["--remote-control", "clone-test"]);
    assert.equal(started[0]?.cwd, folder);
    assert.match(started[0]?.name ?? "", /^gasho-clone-test-[0-9a-f]{4}$/);
    assert.equal(d.managed.get(SID)?.terminal, started[0]?.name);
  } finally {
    await done();
  }
});

test("the question about the folder's MCP servers that follows is answered with Esc, and the launch says so", async () => {
  const { d, fake, folder, done } = await setup({ mcp: true });
  try {
    const r = await d.launch(folder, undefined, true);
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, SID);
    assert.match(r.warning, /MCP サーバーは、使わない設定にして起動しました/);
    assert.deepEqual(fake.keys, ["Down", "Enter", "Esc"]);
  } finally {
    await done();
  }
});

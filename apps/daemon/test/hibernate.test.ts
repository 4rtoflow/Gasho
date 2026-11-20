// Sessions nobody uses are hibernated and brought back with `claude --resume`: what decides (hibernate.ts), and the
// daemon's part against a fake terminal, a fake `claude agents` and processes standing in for Claude Code.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { DEFAULT_HIBERNATE_MINUTES, type HibernateFacts, hibernateAfterMs, mayHibernate, modelFlag, resumeArgs, resumeModel } from "../src/hibernate.ts";
import { ManagedSessions, permissionModeShown, plainScreen } from "../src/managed.ts";
import type { TerminalStart } from "../src/terminal.ts";
import { tokenDayOf } from "../src/token-days.ts";
import { emptyMeta, TranscriptTail } from "../src/transcript.ts";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const facts = (extra: Partial<HibernateFacts> = {}): HibernateFacts => ({
  zellij: false,
  resumable: true,
  status: "idle",
  claudeStatus: "idle",
  background: 0,
  pendingInputs: 0,
  permissionRequests: 0,
  question: false,
  operating: false,
  scheduled: false,
  typed: "",
  attached: false,
  permissionMode: "auto",
  activity: [NOW - 2 * HOUR],
  ...extra,
});

test("the time before hibernating is 90 minutes, can be changed down to an hour, and hibernating can be turned off", () => {
  assert.equal(DEFAULT_HIBERNATE_MINUTES, 90);
  assert.equal(hibernateAfterMs({}), 90 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "120" }), 120 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "5" }), 60 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "soon" }), 90 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE: "off" }), undefined);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE: "OFF", GASHO_HIBERNATE_AFTER_MINUTES: "120" }), undefined);
});

test("a session left alone long enough is hibernated, and the latest activity of any source counts", () => {
  assert.equal(mayHibernate(facts(), NOW, HOUR), true);
  assert.equal(mayHibernate(facts({ activity: [NOW - HOUR] }), NOW, HOUR), true);
  assert.equal(mayHibernate(facts({ activity: [NOW - HOUR + 1] }), NOW, HOUR), false);
  assert.equal(mayHibernate(facts({ activity: [NOW - 5 * HOUR, undefined, NOW - 60_000] }), NOW, HOUR), false);
  assert.equal(mayHibernate(facts({ activity: [undefined] }), NOW, HOUR), false);
});

const KEPT_AWAKE: [string, Partial<HibernateFacts>][] = [
  ["in zellij", { zellij: true }],
  ["that cannot be resumed", { resumable: false }],
  ["working", { status: "busy" }],
  ["waiting for an answer", { status: "waiting" }],
  ["in an unknown state", { status: "unknown" }],
  ["with shells running on, shown as idle", { claudeStatus: "shell" }],
  ["with background work", { background: 1 }],
  ["with an input waiting", { pendingInputs: 1 }],
  ["with a permission request", { permissionRequests: 1 }],
  ["with Claude's question unanswered in its transcript, though its state says idle", { question: true }],
  ["that gasho-daemon is working on", { operating: true }],
  ["with work scheduled in its process", { scheduled: true }],
  ["with text in its prompt box", { typed: "書きかけ" }],
  ["with a dialog open", { typed: undefined }],
  ["with its terminal open", { attached: true }],
  ["whose permission mode cannot be told", { permissionMode: undefined }],
];
for (const [what, extra] of KEPT_AWAKE) {
  test(`a session ${what} is not hibernated`, () => assert.equal(mayHibernate(facts(extra), NOW, HOUR), false));
}

test("the permission mode is read from under the prompt box, as Claude Code 2.1.327 draws it at 50 columns", () => {
  const screen = (...footer: string[]) => [RULE, "❯ ", RULE, ...footer, ""].join("\n");
  assert.equal(permissionModeShown(screen("  ⏸ manual mode on · ? for shortcuts · ← for ag…")), "manual");
  assert.equal(permissionModeShown(screen("  ⏵⏵ accept edits on (shift+tab to cycle) · ← f…")), "acceptEdits");
  assert.equal(permissionModeShown(screen("  ⏸ plan mode on (shift+tab to cycle) · ← for a…")), "plan");
  assert.equal(permissionModeShown(screen("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for …")), "auto");
  assert.equal(permissionModeShown(screen("  ⏵⏵ don't ask on (shift+tab to cycle) · ← for …")), "dontAsk");
  // Under a status line of the user's own.
  assert.equal(permissionModeShown(screen("  main · 42%", "  ⏸ plan mode on")), "plan");
  // Starting in this one asks for a confirmation.
  assert.equal(permissionModeShown(screen("  ⏵⏵ bypass permissions on (shift+tab to cycle)")), undefined);
  assert.equal(permissionModeShown(screen("  ? for shortcuts")), undefined);
  // The conversation can quote it; only what is under the box counts.
  assert.equal(permissionModeShown(["  ⏸ plan mode on", RULE, "❯ ", RULE, ""].join("\n")), undefined);
  assert.equal(permissionModeShown("  ⏸ plan mode on"), undefined);
});

test("a resume names the model and effort level the session had, for Claude Code does not keep them", () => {
  assert.equal(modelFlag("Opus 5.5"), "claude-opus-5-5");
  assert.equal(modelFlag("Haiku 5.5"), "claude-haiku-5-5");
  assert.equal(modelFlag("Sonnet 4"), "claude-sonnet-4");
  assert.equal(modelFlag("Opus 4.6 (1M context)"), "claude-opus-4-6[1m]");
  assert.equal(modelFlag("Sonnet 5.5 (default)"), "claude-sonnet-5-5");
  assert.equal(modelFlag("<synthetic>"), undefined);
  assert.equal(modelFlag(undefined), undefined);
  assert.deepEqual(resumeArgs("id", { model: "Sonnet 5.5", effort: "xhigh" }), ["--resume", "id", "--model", "claude-sonnet-5-5", "--effort", "xhigh"]);
  assert.deepEqual(resumeArgs("id", {}), ["--resume", "id"]);
  assert.deepEqual(resumeArgs("id", { permissionMode: "plan" }), ["--resume", "id", "--permission-mode", "plan"]);
});

test("a resume keeps the 1M context window that a reply's record does not mention", () => {
  assert.equal(modelFlag(resumeModel("Opus 4.6", "Opus 4.6 (1M context)")), "claude-opus-4-6[1m]");
  assert.equal(modelFlag(resumeModel("Opus 4.6", undefined, "Opus 4.6 (1M context)")), "claude-opus-4-6[1m]");
  // The latest full name wins over the banner from when it started.
  assert.equal(modelFlag(resumeModel("Opus 4.6", "Opus 4.6", "Opus 4.6 (1M context)")), "claude-opus-4-6");
  // Named for another model: nothing to go by.
  assert.equal(modelFlag(resumeModel("Sonnet 5.5", "Opus 4.6 (1M context)")), "claude-sonnet-5-5");
  assert.equal(resumeModel(undefined, "Opus 4.6 (1M context)"), undefined);
});

test("the transcript keeps the model's full name past its replies, until another model replies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "t.jsonl");
    const named = JSON.stringify({ type: "attachment", attachment: { type: "model", identity: { modelId: "claude-opus-4-6", marketingName: "Opus 4.6 (1M context)" } } });
    const reply = (uuid: string, model: string) => JSON.stringify({ type: "assistant", uuid, timestamp: "2026-11-18T01:00:00.000Z", message: { role: "assistant", model, content: [{ type: "text", text: "はい" }] } });
    await fs.writeFile(file, `${named}\n${reply("a1", "claude-opus-4-6")}\n`);
    const meta = emptyMeta();
    const tail = new TranscriptTail(file);
    for await (const _ of tail.read(meta)) void _;
    assert.equal(meta.model, "Opus 4.6");
    assert.equal(meta.namedModel, "Opus 4.6 (1M context)");

    await fs.appendFile(file, `${reply("a2", "claude-sonnet-5-5")}\n`);
    for await (const _ of tail.read(meta)) void _;
    assert.equal(meta.model, "Sonnet 5.5");
    assert.equal(meta.namedModel, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("what waits for a hibernated session is saved with it, and nothing else that waits is", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "asleep", terminal: "t1", pid: 1, cwd: "/a", name: "a", launchedAt: 1, hibernated: { at: 2, effort: "low" } });
    a.add({ sessionId: "awake", terminal: "t2", pid: 2, cwd: "/b", name: "b", launchedAt: 1 });
    a.enqueue("asleep", { id: "r1", text: "続きを" });
    a.enqueue("asleep", { text: "/rename a", auto: true });
    a.enqueue("awake", { text: "消える" });
    await a.save();

    const b = new ManagedSessions(file);
    await b.load(async () => true);
    assert.deepEqual(b.get("asleep")?.hibernated, { at: 2, effort: "low" });
    assert.deepEqual(b.waiting("asleep"), [{ id: "r1", text: "続きを" }]);
    assert.equal(b.pending("awake"), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("work Claude scheduled to run later is noticed in the transcript", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "t.jsonl");
    const call = (name: string, at: string) =>
      JSON.stringify({ type: "assistant", uuid: name, timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: name, name, input: {} }] } });
    await fs.writeFile(file, `${call("Read", "2026-11-18T01:00:00.000Z")}\n${call("CronCreate", "2026-11-18T02:00:00.000Z")}\n${call("Bash", "2026-11-18T03:00:00.000Z")}\n`);
    const meta = emptyMeta();
    for await (const _ of new TranscriptTail(file).read(meta)) void _;
    assert.equal(meta.scheduledAt, Date.parse("2026-11-18T02:00:00.000Z"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const SID = "11111111-2222-3333-4444-777777777777";
const RULE = "─".repeat(50);

/** A process standing in for Claude Code, ready for SIGTERM. */
async function claudeProcess(): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000); console.log("ready")`], { stdio: ["ignore", "pipe", "ignore"] });
  await once(p.stdout!, "data");
  return p;
}

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(done(), what);
};

/** A daemon with one session started from Gasho, left alone for hours. */
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  const agentsFile = path.join(dir, "agents.json");
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, `#!/bin/sh\ncat '${agentsFile}'\n`, { mode: 0o755 });
  const folder = path.join(dir, "work");
  await fs.mkdir(folder);
  const claudeDir = path.join(dir, "claude-dir");
  await fs.mkdir(path.join(claudeDir, "projects", "p"), { recursive: true });
  const old = new Date(Date.now() - 5 * HOUR).toISOString();
  const transcript = path.join(claudeDir, "projects", "p", `${SID}.jsonl`);
  await fs.writeFile(
    transcript,
    `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: old, cwd: folder, effort: "low", message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "はい" }] } })}\n`,
  );
  const cfg = {
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir,
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    pluginDataDir: path.join(dir, "plugin-data"),
    hibernateAfterMs: HOUR,
  } as ConstructorParameters<typeof Daemon>[0];
  const procs: ChildProcess[] = [await claudeProcess()];
  const agents = (rows: object[]) => writeFileSync(agentsFile, JSON.stringify(rows));
  const row = (pid: number) => ({ pid, sessionId: SID, cwd: folder, status: "idle", startedAt: Date.now() - 5 * HOUR });
  agents([row(procs[0]!.pid!)]);

  // The terminal: its prompt box, what was entered into it, and whether ultracode is on.
  const term = { typed: "", entered: [] as string[], ultracode: false, viewers: 0, footer: "  ⏵⏵ auto mode on (shift+tab to cycle)", live: new Map<string, { pid: number; exited?: object }>() };
  const killed: string[] = [];
  const started: TerminalStart[] = [];
  const terminals = {
    start: async (o: TerminalStart) => {
      started.push(o);
      const p = await claudeProcess();
      procs.push(p);
      agents([row(p.pid!)]);
      return p.pid;
    },
    screen: async () =>
      plainScreen([`${RULE.slice(0, 30)}${term.ultracode ? " ultracode ─" : ""}`, `❯ ${term.typed.replaceAll("\n", "\n  ")}` /* lines after the first indented, as Claude Code draws them */, RULE, term.footer, ""].join("\n")),
    paste: async (_s: string, text: string) => {
      term.typed = text;
    },
    keys: async (_s: string, ...keys: string[]) => {
      for (const k of keys) {
        if (k === "Ctrl u" || k === "Backspace") term.typed = "";
        if (k !== "Enter") continue;
        term.entered.push(term.typed);
        if (term.typed === "/effort ultracode on") term.ultracode = true;
        term.typed = "";
      }
    },
    kill: async (name: string) => {
      killed.push(name);
    },
    builtIn: { hello: async () => ({ viewers: term.viewers }), live: async () => term.live },
  };
  const make = () => {
    const d = new Daemon(cfg) as unknown as Record<string, any>;
    d.canLaunch = true;
    d.terminals = terminals;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.refreshFolders = async () => undefined;
    d.sent = [];
    d.hub = { connected: true, send: (m: { type: string; sessions?: object[] }) => m.type === "sessions" && d.sent.push(m.sessions) };
    return d;
  };
  const d = make();
  d.managed.add({ sessionId: SID, terminal: "t1", pid: procs[0]!.pid, cwd: folder, name: "眠るセッション", launchedAt: Date.now() - 5 * HOUR });
  await d.refresh();
  const shown = (daemon = d) => daemon.sent.at(-1)?.find((s: { sessionId: string }) => s.sessionId === SID);
  return {
    d,
    make,
    term,
    killed,
    started,
    agents,
    row,
    procs,
    folder,
    transcript,
    shown,
    done: async () => {
      for (const p of procs) p.kill("SIGKILL");
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("a session left alone ends with its terminal, stays listed as it was, and can still be read", async () => {
  const { d, killed, agents, procs, shown, folder, done } = await setup();
  try {
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, "SIGTERM");
    assert.deepEqual(killed, ["t1"]);
    agents([]);
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    assert.equal(shown().hibernation, "hibernated");
    assert.equal(shown().status, "idle");
    assert.equal(shown().name, "眠るセッション");
    assert.equal(shown().model, "Haiku 5.5");
    assert.equal(shown().pid, undefined);
    assert.equal(d.tracked.get(SID).tail !== undefined, true);
    // Not offered as a past conversation too.
    assert.deepEqual((await d.history(folder, false)).history, []);
  } finally {
    await done();
  }
});

test("text in the prompt box, an open terminal or a waiting input keep a session running", async () => {
  const { d, term, procs, done } = await setup();
  try {
    term.typed = "書きかけ";
    await d.hibernateIdle();
    term.typed = "";
    term.viewers = 1;
    await d.hibernateIdle();
    term.viewers = 0;
    d.managed.enqueue(SID, { text: "待っている" });
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a session stopped from Gasho and left alone is hibernated once the stop has settled", async () => {
  const { d, agents, row, procs, done } = await setup();
  try {
    const pid = procs[0]!.pid!;
    agents([{ ...row(pid), status: "busy" }]);
    await d.refresh();
    assert.equal((await d.interrupt(SID)).ok, true);
    assert.ok(d.settleUntil.has(SID));
    agents([row(pid)]);
    await d.refresh();

    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);

    await until(() => Date.now() > d.settleUntil.get(SID), "the stop has settled");
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, "SIGTERM");
    assert.ok(d.managed.get(SID).hibernated);
  } finally {
    await done();
  }
});

test("an input brings the session back as it was, and is typed once it runs", async () => {
  const { d, term, started, agents, shown, done } = await setup();
  try {
    d.tracked.get(SID).info.ultracode = true;
    await d.hibernateIdle();
    agents([]);
    await d.refresh();
    assert.deepEqual(await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "続きをお願いします" }), { ok: true, queued: true });
    assert.equal(shown().hibernation, "resuming");
    assert.equal(shown().pendingInputs, 1);
    await d.waking.get(SID);
    await until(() => term.entered.includes("続きをお願いします"), "the input was typed");

    assert.equal(started.length, 1);
    assert.deepEqual(started[0]!.args.slice(0, 7), ["--remote-control=眠るセッション", "--resume", SID, "--model", "claude-haiku-5-5", "--effort", "low"]);
    // Ultracode first: the input goes out with the session as it was.
    assert.deepEqual(term.entered, ["/effort ultracode on", "続きをお願いします"]);
    const m = d.managed.get(SID);
    assert.equal(m.hibernated, undefined);
    assert.equal(m.terminal, started[0]!.name);
    await d.refresh();
    assert.equal(shown().hibernation, undefined);
  } finally {
    await done();
  }
});

test("the effort level known before /clear is the one a session comes back with", async () => {
  const NEW = "22222222-2222-3333-4444-777777777777";
  const { d, make, agents, row, procs, folder, done } = await setup();
  try {
    assert.equal(d.managed.get(SID).effort, "low");
    await d.managed.save();
    const restarted = make();
    await restarted.managed.load(async () => true);
    assert.equal(restarted.managed.get(SID).effort, "low");

    // /clear: the same process goes on under a new id, with a transcript that records no effort level.
    await fs.writeFile(
      path.join(d.cfg.claudeDir, "projects", "p", `${NEW}.jsonl`),
      `${JSON.stringify({ type: "assistant", uuid: "b1", timestamp: new Date(Date.now() - 5 * HOUR).toISOString(), cwd: folder, message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "はい" }] } })}\n`,
    );
    const launchedAt = d.managed.get(SID).launchedAt;
    d.managed.get(SID).launchedAt = Date.now();
    agents([{ ...row(procs[0]!.pid!), sessionId: NEW }]);
    await d.refresh();
    const m = d.managed.get(NEW);
    assert.ok(m);
    m.launchedAt = launchedAt;
    assert.equal(d.tracked.get(NEW).info.effort, undefined);

    await d.hibernateIdle();
    assert.equal(m.hibernated?.effort, "low");
    const args = resumeArgs(NEW, m.hibernated);
    assert.equal(args[args.indexOf("--effort") + 1], "low");
  } finally {
    await done();
  }
});

/** Claude scheduled work four hours ago, and /clear is about to give the session the id NEXT. */
const NEXT = "33333333-2222-3333-4444-777777777777";
async function scheduledThenCleared(s: Awaited<ReturnType<typeof setup>>) {
  const { d, folder } = s;
  const projects = path.join(d.cfg.claudeDir, "projects", "p");
  const at = Date.now() - 4 * HOUR;
  d.managed.get(SID).launchedAt = at - HOUR / 2;
  await fs.appendFile(
    path.join(projects, `${SID}.jsonl`),
    `${JSON.stringify({ type: "assistant", uuid: "c1", timestamp: new Date(at).toISOString(), cwd: folder, message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "CronCreate", input: {} }] } })}\n`,
  );
  await fs.writeFile(
    path.join(projects, `${NEXT}.jsonl`),
    `${JSON.stringify({ type: "assistant", uuid: "n1", timestamp: new Date(at).toISOString(), cwd: folder, message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "はい" }] } })}\n`,
  );
  return at;
}

test("work scheduled before /clear keeps the session running, for it stays in the process", async () => {
  const s = await setup();
  const { d, make, agents, row, procs, done } = s;
  try {
    const at = await scheduledThenCleared(s);
    await d.pollTails();
    assert.equal(d.managed.get(SID).scheduledAt, at);
    await d.managed.save();
    const restarted = make();
    await restarted.managed.load(async () => true);
    assert.equal(restarted.managed.get(SID).scheduledAt, at);

    agents([{ ...row(procs[0]!.pid!), sessionId: NEXT }]);
    await d.refresh();
    assert.equal(d.tracked.get(NEXT).meta.scheduledAt, undefined);
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(NEXT).hibernated, undefined);
  } finally {
    await done();
  }
});

test("work scheduled before a /clear that gasho-daemon did not see keeps the session running too", async () => {
  const s = await setup();
  const { d, make, term, agents, row, procs, done } = s;
  try {
    const at = await scheduledThenCleared(s);
    await d.managed.save();
    term.live.set("t1", { pid: procs[0]!.pid! });
    agents([{ ...row(procs[0]!.pid!), sessionId: NEXT }]);

    const again = make();
    await again.loadManaged();
    await again.refresh();
    assert.equal(again.managed.get(NEXT).scheduledAt, at);
    await again.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(again.managed.get(NEXT).hibernated, undefined);
  } finally {
    await done();
  }
});

test("what was scheduled is forgotten when the session comes back, for its process has ended", async () => {
  const { d, agents, done } = await setup();
  try {
    const at = Date.now() - 4 * HOUR;
    d.managed.get(SID).scheduledAt = at;
    d.managed.get(SID).hibernated = { at: Date.now() };
    agents([]);
    await d.wake(SID);
    assert.equal(d.managed.get(SID).hibernated, undefined);
    assert.equal(d.managed.get(SID).scheduledAt, undefined);

    // The old transcript still says so, about a process that is gone.
    const t = d.tracked.get(SID);
    t.meta.scheduledAt = at;
    d.applyMeta(t);
    assert.equal(d.managed.get(SID).scheduledAt, undefined);
  } finally {
    await done();
  }
});

test("an update waits for the inputs about to be typed, not for those a hibernated session keeps", async () => {
  const { d, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    d.managed.enqueue(SID, { id: "r1", text: "預けた発言" });
    assert.equal(d.inputsToType(), 0);
    d.codexSessions.waitingInputs = () => 2;
    assert.equal(d.inputsToType(), 2);
  } finally {
    await done();
  }
});

test("a session comes back in the permission mode it was in", async () => {
  const { d, term, started, agents, done } = await setup();
  try {
    term.footer = "  ⏸ plan mode on (shift+tab to cycle) · ← for a…";
    await d.hibernateIdle();
    assert.equal(d.managed.get(SID).hibernated.permissionMode, "plan");
    agents([]);
    await d.wake(SID);
    const { args } = started[0]!;
    assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  } finally {
    await done();
  }
});

test("a session whose permission mode cannot be told or gone back to keeps running", async () => {
  const { d, term, procs, done } = await setup();
  try {
    for (const footer of ["  ⏵⏵ bypass permissions on (shift+tab to cycle)", "  ? for shortcuts"]) {
      term.footer = footer;
      await d.hibernateIdle();
      assert.equal(procs[0]!.signalCode, null);
      assert.equal(d.managed.get(SID).hibernated, undefined);
    }
  } finally {
    await done();
  }
});

test("an input kept for a session stays saved while it is typed, and no longer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "s", terminal: "t", pid: 1, cwd: "/a", name: "a", launchedAt: 1, wokenFrom: { at: 2, effort: "low" } });
    a.enqueue("s", { id: "r1", text: "預けた発言" });
    a.enqueue("s", { id: "r2", text: "次の発言" });
    assert.equal(a.keepWaiting("s"), true);
    a.next("s")!.typingAt = Date.now();
    await a.save();

    const b = new ManagedSessions(file);
    await b.load(async () => true);
    assert.equal(b.waiting("s")[0]?.text, "預けた発言");
    assert.equal(b.waiting("s")[0]?.recheck, true);
    assert.equal(b.waiting("s")[1]?.text, "次の発言");
    assert.equal(b.waiting("s")[1]?.recheck, undefined);

    assert.equal(a.typed("s"), true);
    assert.equal(a.next("s")?.text, "次の発言");
    assert.equal(a.typed("s"), true);
    await a.save();
    const c = new ManagedSessions(file);
    await c.load(async () => true);
    assert.equal(c.pending("s"), 0);
    assert.equal(c.get("s")?.wokenFrom, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A session has come back with an input kept for it, and gasho-daemon stops before typing it. */
async function backButNotTyped(s: Awaited<ReturnType<typeof setup>>, texts = ["預けた発言"]) {
  const { d, term, started, agents, procs } = s;
  await d.hibernateIdle();
  agents([]);
  texts.forEach((text, i) => d.managed.enqueue(SID, { id: `r${i}`, text }));
  await d.managed.save();
  d.refresh = async () => undefined;
  d.flushWaitingInputs = () => undefined;
  await d.wake(SID);
  assert.equal(d.managed.pending(SID), texts.length);
  term.live.set(started[0]!.name, { pid: procs.at(-1)!.pid! });
  return path.join(d.cfg.claudeDir, "projects", "p", `${SID}.jsonl`);
}

const said = (text: string, at: number) =>
  `${JSON.stringify({ type: "user", uuid: `u${at}`, timestamp: new Date(at).toISOString(), message: { role: "user", content: text } })}\n`;

test("a restart right after a session came back types the input kept for it, once", async () => {
  const s = await setup();
  const { d, make, term, done } = s;
  try {
    const transcript = await backButNotTyped(s);
    // The same words said earlier are another message.
    await fs.appendFile(transcript, said("預けた発言", Date.now() - HOUR));
    const saved = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
    assert.equal(saved[0].wokenFrom.inputs[0].text, "預けた発言");

    const again = make();
    await again.loadManaged();
    assert.equal(again.managed.pending(SID), 1);
    await again.refresh();
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    await until(() => again.flushing.size === 0, "typing has ended");
    assert.deepEqual(term.entered, ["預けた発言"]);
    await again.managed.save();
    const after = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
    assert.equal(after[0].wokenFrom, undefined);
  } finally {
    await done();
  }
});

test("a restart after the kept input was typed does not type it again", async () => {
  const s = await setup();
  const { make, term, done } = s;
  try {
    const transcript = await backButNotTyped(s);
    s.d.managed.next(SID).typingAt = Date.now();
    await s.d.managed.save();
    await new Promise((r) => setTimeout(r, 5));
    await fs.appendFile(transcript, said("預けた発言", Date.now()));

    const again = make();
    await again.loadManaged();
    await again.refresh();
    await until(() => again.managed.pending(SID) === 0 && again.flushing.size === 0, "the input was dealt with");
    assert.deepEqual(term.entered, []);
  } finally {
    await done();
  }
});

const SECOND_INPUTS = [
  ["続けて", "続けて"],
  ["はい、この方針で進めてください", "はい"],
  ["@/home/u/.local/share/gasho/attachments/s/a.png", "@/home/u/.local/share/gasho/attachments/s/b.png"],
];
for (const [first, second] of SECOND_INPUTS) {
  test(`a second kept input is typed after a restart: ${first} / ${second}`, async () => {
    const s = await setup();
    const { d, make, term, done } = s;
    try {
      const transcript = await backButNotTyped(s, [first!, second!]);
      d.managed.next(SID);
      d.managed.typed(SID);
      await d.managed.save();
      await new Promise((r) => setTimeout(r, 5));
      await fs.appendFile(transcript, said(first!, Date.now()));

      const again = make();
      await again.loadManaged();
      await again.refresh();
      await until(() => term.entered.includes(second!), "the second input was typed");
      assert.deepEqual(term.entered, [second]);
    } finally {
      await done();
    }
  });
}

test("a kept input is marked in the file before its first key is typed", async () => {
  const s = await setup();
  const { d, term, done } = s;
  const { paste } = d.terminals;
  try {
    await backButNotTyped(s);
    const file = path.join(d.cfg.stateDir, "managed.json");
    const before = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(before[0].wokenFrom.inputs[0].typingAt, undefined);
    let marked: unknown;
    d.terminals.paste = async (name: string, text: string) => {
      marked = JSON.parse(await fs.readFile(file, "utf8"))[0].wokenFrom.inputs[0].typingAt;
      return paste(name, text);
    };
    await d.flushInput(SID);
    assert.equal(typeof marked, "number");
    assert.deepEqual(term.entered, ["預けた発言"]);
  } finally {
    d.terminals.paste = paste;
    await done();
  }
});

test("an input being typed at a restart is compared from when typing began", async () => {
  const s = await setup();
  const { d, make, term, done } = s;
  try {
    const transcript = await backButNotTyped(s, ["続けて", "続けて"]);
    d.managed.next(SID);
    d.managed.typed(SID);
    await fs.appendFile(transcript, said("続けて", Date.now()));
    await new Promise((r) => setTimeout(r, 5));
    d.managed.next(SID).typingAt = Date.now();
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    await again.refresh();
    await until(() => term.entered.includes("続けて"), "the input was typed");
  } finally {
    await done();
  }
});

test("an input being typed at a restart is compared whole", async () => {
  const s = await setup();
  const { d, make, term, done } = s;
  try {
    const transcript = await backButNotTyped(s, ["はい"]);
    d.managed.next(SID).typingAt = Date.now();
    await d.managed.save();
    await new Promise((r) => setTimeout(r, 5));
    await fs.appendFile(transcript, said("はい、この方針で進めてください", Date.now()));

    const again = make();
    await again.loadManaged();
    await again.refresh();
    await until(() => term.entered.includes("はい"), "the input was typed");
  } finally {
    await done();
  }
});

test("a session whose Claude Code ends with inputs still kept is hibernated again, and says so", async () => {
  const s = await setup();
  const { d, term, started, killed, agents, procs, shown, done } = s;
  try {
    await backButNotTyped(s);
    const name = started[0]!.name;
    const resumed = procs.at(-1)!;
    resumed.kill("SIGKILL");
    await once(resumed, "exit");
    agents([]);
    delete d.refresh;
    delete d.flushWaitingInputs;

    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    assert.equal(d.managed.pending(SID), 1);
    assert.equal(shown().hibernation, "hibernated");
    assert.match(shown().resumeError, /Claude Code が終了しました/);
    assert.ok(killed.includes(name));
    assert.equal(started.length, 1);

    await d.wake(SID);
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    assert.equal(started.length, 2);
  } finally {
    await done();
  }
});

test("a terminal slow to answer at a restart does not start a second Claude Code", async () => {
  const s = await setup();
  const { make, term, started, procs, done } = s;
  try {
    await backButNotTyped(s);
    term.live.clear();

    const again = make();
    await again.loadManaged();
    assert.equal(again.managed.get(SID).hibernated, undefined);
    assert.equal(again.managed.pending(SID), 1);
    again.wakeInterrupted();
    await again.refresh();
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    assert.equal(started.length, 1);
    assert.equal(procs.at(-1)!.signalCode, null);
  } finally {
    await done();
  }
});

test("a PID that another process has taken at a restart counts as ended", async () => {
  const s = await setup();
  const { make, term, agents, done } = s;
  try {
    await backButNotTyped(s);
    term.live.clear();
    agents([]);

    const again = make();
    await again.loadManaged();
    assert.ok(again.managed.get(SID).hibernated);
    assert.equal(again.managed.pending(SID), 1);
  } finally {
    await done();
  }
});

test("a session that ended before the kept input was typed is hibernated again, and comes back with it", async () => {
  const s = await setup();
  const { make, term, started, agents, procs, done } = s;
  try {
    await backButNotTyped(s);
    const resumed = procs.at(-1)!;
    resumed.kill("SIGKILL");
    await once(resumed, "exit");
    agents([]);

    const again = make();
    await again.loadManaged();
    assert.equal(again.managed.get(SID).hibernated.permissionMode, "auto");
    assert.equal(again.managed.pending(SID), 1);
    again.wakeInterrupted();
    await again.waking.get(SID);
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    assert.equal(started.length, 2);
  } finally {
    await done();
  }
});

test("a session that used the 1M context window comes back with it", async () => {
  const { d, started, agents, done } = await setup();
  try {
    d.tracked.get(SID).meta.namedModel = "Haiku 5.5 (1M context)";
    await d.hibernateIdle();
    agents([]);
    await d.wake(SID);
    assert.equal(started[0]!.args[started[0]!.args.indexOf("--model") + 1], "claude-haiku-5-5[1m]");
  } finally {
    await done();
  }
});

test("a session that cannot come back says why, keeps the input, and comes back when asked again", async () => {
  const { d, make, term, agents, shown, done } = await setup();
  const start = d.terminals.start;
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async () => {
      throw new Error("no terminal");
    };
    assert.equal((await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "失いたくない発言" })).ok, true);
    await d.waking.get(SID);
    assert.equal(shown().hibernation, "hibernated");
    assert.match(shown().resumeError, /起動できませんでした/);
    assert.equal(shown().pendingInputs, 1);

    // Kept over a restart of gasho-daemon too.
    const again = make();
    await again.loadManaged();
    assert.equal(again.managed.waiting(SID)[0].text, "失いたくない発言");
    assert.match(again.managed.get(SID).hibernated.resumeError, /起動できませんでした/);

    d.terminals.start = start;
    assert.equal(d.wakeAsked(SID).ok, true);
    await d.waking.get(SID);
    await until(() => term.entered.includes("失いたくない発言"), "the input was typed");
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart of gasho-daemon keeps a hibernated session, and its conversation can still be read", async () => {
  const { d, make, agents, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    const again = make();
    await again.loadManaged();
    await again.refresh();
    assert.equal(shown(again).hibernation, "hibernated");
    assert.equal(shown(again).name, "眠るセッション");
    assert.equal(shown(again).model, "Haiku 5.5");
    assert.equal(shown(again).effort, "low");
    assert.ok(again.tracked.get(SID).tail);
  } finally {
    await done();
  }
});

test("renaming a hibernated session does not wake it; Claude Code is told once it is back", async () => {
  const { d, term, started, agents, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    assert.equal((await d.rename(SID, "新しい名前", "r1")).ok, true);
    assert.equal(started.length, 0);
    assert.equal(d.managed.get(SID).name, "新しい名前");
    await d.wake(SID);
    await until(() => term.entered.includes("/rename 新しい名前"), "/rename was typed");
    assert.equal(started[0]!.args[0], "--remote-control=新しい名前");
  } finally {
    await done();
  }
});

test("a hibernated session opened outside Gasho is no longer Gasho's", async () => {
  const { d, agents, row, procs, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([row(procs[0]!.pid!)]);
    // The Claude Code that was ended, still in a list read before it ended, changes nothing.
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    const outside = await claudeProcess();
    procs.push(outside);
    agents([row(outside.pid!)]);
    await d.refresh();
    assert.equal(d.managed.has(SID), false);
    assert.equal(shown().managed, undefined);
    assert.equal(shown().hibernation, undefined);
    assert.equal(shown().pid, outside.pid);
  } finally {
    await done();
  }
});

test("inputs waiting for a session opened outside Gasho are kept, and it comes back only once that has ended", async () => {
  const { d, term, started, agents, row, procs, shown, done } = await setup();
  const start = d.terminals.start;
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async () => {
      throw new Error("no terminal");
    };
    await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "預けた発言" });
    await d.waking.get(SID);
    d.terminals.start = start;

    const outside = await claudeProcess();
    procs.push(outside);
    agents([row(outside.pid!)]);
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    assert.equal(d.managed.pending(SID), 1);
    assert.equal(shown().hibernation, "hibernated");
    assert.match(shown().resumeError, /Gasho の外/);

    // Asked to come back meanwhile: no second Claude Code on the conversation.
    await d.wake(SID);
    assert.equal(started.length, 0);
    assert.match(d.managed.get(SID).hibernated.resumeError, /Gasho の外/);

    outside.kill("SIGKILL");
    await once(outside, "exit");
    agents([]);
    await d.wake(SID);
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("the terminal a session comes back in is saved before it starts", async () => {
  const { d, agents, started, done } = await setup();
  const start = d.terminals.start;
  let saved: { hibernated?: { resumingIn?: string } }[] = [];
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async (o: TerminalStart) => {
      saved = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
      return start(o);
    };
    await d.wake(SID);
    assert.equal(saved[0]?.hibernated?.resumingIn, started[0]!.name);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended: one that goes on running is not hibernated, and nothing starts a second", async () => {
  const { d, make, term, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    d.managed.enqueue(SID, { id: "r1", text: "止まらなかった発言" });
    await d.managed.save();
    term.live.set("t1", { pid: procs[0]!.pid! });

    const again = make();
    again.endWaitMs = 300;
    await again.loadManaged();
    again.wakeInterrupted();
    assert.equal(again.managed.get(SID).hibernated, undefined);
    await again.refresh();
    await until(() => term.entered.includes("止まらなかった発言"), "the input was typed");
    assert.equal(started.length, 0);
    assert.equal(procs[0]!.signalCode, null);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended, with its terminal slow to answer: it goes on, and nothing starts a second", async () => {
  const { d, make, term, started, procs, shown, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    d.managed.enqueue(SID, { id: "r1", text: "遅い端末への発言" });
    await d.managed.save();
    term.live.clear();

    const again = make();
    again.endWaitMs = 300;
    await again.loadManaged();
    again.wakeInterrupted();
    assert.equal(again.managed.get(SID).hibernated, undefined);
    await again.refresh();
    await until(() => term.entered.includes("遅い端末への発言"), "the input was typed");
    assert.equal(started.length, 0);
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(shown(again).hibernation, undefined);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended, with its terminal slow to answer: one that ends in time stays hibernated", async () => {
  const { d, make, term, killed, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    await d.managed.save();
    term.live.clear();

    const again = make();
    again.endWaitMs = 5000;
    setTimeout(() => procs[0]!.kill("SIGTERM"), 100);
    await again.loadManaged();
    assert.ok(again.managed.get(SID).hibernated);
    assert.deepEqual(killed, ["t1"]);
    assert.equal(started.length, 0);
  } finally {
    await done();
  }
});

test("a Claude Code not listed at the restart is still found before a second is started", async () => {
  const { d, make, term, agents, row, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    await d.managed.save();
    term.live.clear();
    agents([]);

    const again = make();
    again.endWaitMs = 300;
    await again.loadManaged();
    assert.ok(again.managed.get(SID).hibernated);

    agents([row(procs[0]!.pid!)]);
    await again.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "あとから届いた発言" });
    await again.waking.get(SID);
    await until(() => term.entered.includes("あとから届いた発言"), "the input was typed");
    assert.equal(again.managed.get(SID).hibernated, undefined);
    assert.equal(started.length, 0);
    assert.equal(procs[0]!.signalCode, null);
  } finally {
    await done();
  }
});

test("a PID that another conversation's Claude Code has taken does not keep a session from sleeping or coming back", async () => {
  const { d, make, term, agents, row, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    await d.managed.save();
    term.live.clear();
    agents([{ ...row(procs[0]!.pid!), sessionId: NEXT }]);

    const again = make();
    await again.loadManaged();
    assert.ok(again.managed.get(SID).hibernated);
    await again.wake(SID);
    assert.equal(started.length, 1);
    assert.equal(procs[0]!.signalCode, null);
  } finally {
    await done();
  }
});

test("a restart keeps the tokens counted per day, and when each fork was made", async () => {
  const { d, make, done } = await setup();
  try {
    const today = tokenDayOf(Date.now());
    await fs.writeFile(path.join(d.cfg.stateDir, "token-days.json"), JSON.stringify({ "removed-session": { [today]: 1234 } }));
    await fs.writeFile(path.join(d.cfg.stateDir, "token-forks.json"), JSON.stringify({ "removed-fork": Date.now() - HOUR }));
    d.managed.get(SID).forkedAt = Date.now() - 2 * HOUR;
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    assert.deepEqual(again.tokenDays.all(), [[today, 1234]]);
    assert.ok(again.tokenDays.forkedAt("removed-fork"));
    assert.equal(again.tokenDays.forkedAt(SID), d.managed.get(SID).forkedAt);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended: one that has ended stays hibernated, and its terminal is closed", async () => {
  const { d, make, term, killed, agents, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    await d.managed.save();
    term.live.set("t1", { pid: procs[0]!.pid! });
    procs[0]!.kill("SIGTERM");
    await once(procs[0]!, "exit");
    agents([]);

    const again = make();
    await again.loadManaged();
    assert.deepEqual(killed, ["t1"]);
    assert.ok(again.managed.get(SID).hibernated);
    assert.equal(started.length, 0);
  } finally {
    await done();
  }
});

test("a restart while a session is coming back takes its terminal over, and keeps what waits for it", async () => {
  const { d, make, term, started, killed, agents, row, procs, done } = await setup();
  try {
    procs[0]!.kill("SIGKILL");
    await once(procs[0]!, "exit");
    const resumed = await claudeProcess();
    procs.push(resumed);
    agents([row(resumed.pid!)]);
    term.live.set("t2", { pid: resumed.pid! });
    // "もう一度再開": the reason of the last try is no longer saved once this one has begun.
    d.managed.get(SID).hibernated = { at: Date.now(), resumingIn: "t2" };
    d.managed.enqueue(SID, { id: "r1", text: "再開を待つ発言" });
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    // Listed before it is gone on with: it is Gasho's own, not a conversation opened outside.
    await again.refresh();
    assert.equal(again.managed.has(SID), true);
    assert.equal(again.managed.pending(SID), 1);

    again.wakeInterrupted();
    await again.waking.get(SID);
    await until(() => term.entered.includes("再開を待つ発言"), "the input was typed");
    assert.equal(started.length, 0);
    assert.deepEqual(killed, []);
    assert.equal(again.managed.get(SID).terminal, "t2");
    assert.equal(again.managed.get(SID).pid, resumed.pid);
    assert.equal(again.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart after the terminal it was coming back in has gone starts it once more", async () => {
  const { d, make, term, started, killed, agents, procs, done } = await setup();
  try {
    procs[0]!.kill("SIGKILL");
    await once(procs[0]!, "exit");
    agents([]);
    d.managed.get(SID).hibernated = { at: Date.now(), resumingIn: "t2" };
    d.managed.enqueue(SID, { id: "r1", text: "やり直す発言" });
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    assert.deepEqual(killed, ["t2"]);
    assert.equal(again.managed.get(SID).hibernated.resumingIn, undefined);
    again.wakeInterrupted();
    await again.waking.get(SID);
    await until(() => term.entered.includes("やり直す発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("a session that something is typing into is not hibernated", async () => {
  const { d, procs, done } = await setup();
  try {
    d.flushing.add("t1");
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("an id the session had before /clear reaches it while it is hibernated", async () => {
  const OLD = "00000000-2222-3333-4444-777777777777";
  const { d, term, started, agents, done } = await setup();
  try {
    d.managed.get(SID).previousIds = [OLD];
    await d.hibernateIdle();
    agents([]);

    assert.equal((await d.rename(OLD, "新しい名前", "r1")).ok, true);
    assert.equal(d.managed.get(SID).name, "新しい名前");
    assert.equal(d.managed.get(SID).hibernated.renamed, true);
    assert.equal(started.length, 0);

    assert.deepEqual(await d.input({ type: "session.input", requestId: "r2", sessionId: OLD, text: "前の ID への発言" }), { ok: true, queued: true });
    await d.waking.get(SID);
    await until(() => term.entered.includes("前の ID への発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("a session whose hibernation cannot be saved goes on running, and takes what is sent to it", async () => {
  const { d, term, started, procs, shown, done } = await setup();
  const save = d.managed.save;
  try {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    d.managed.save = async () => {
      await held;
      throw new Error("no space left on device");
    };
    const going = d.hibernateIdle();
    await until(() => d.hibernating.has(SID), "it began to hibernate");

    // Sent while the save is under way: it must not start a second Claude Code.
    d.managed.save = save;
    assert.equal((await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "保存できなかったときの発言" })).ok, true);
    release();
    await going;
    await d.waking.get(SID);

    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
    assert.equal(started.length, 0);
    await d.refresh();
    assert.equal(shown().hibernation, undefined);
    await until(() => term.entered.includes("保存できなかったときの発言"), "the input was typed");
  } finally {
    await done();
  }
});

test("opening a conversation from before /clear opens that one, and leaves the hibernated session asleep", async () => {
  const OLD = "00000000-2222-3333-4444-777777777777";
  const { d, agents, folder, done } = await setup();
  try {
    d.managed.get(SID).previousIds = [OLD];
    await fs.writeFile(
      path.join(d.cfg.claudeDir, "projects", "p", `${OLD}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd: folder, message: { role: "user", content: "前の会話" } })}\n`,
    );
    await d.hibernateIdle();
    agents([]);
    const asked: string[][] = [];
    d.terminals.start = async (o: TerminalStart) => {
      asked.push(o.args);
      throw new Error("no need to go on");
    };
    await d.resume(OLD);
    assert.equal(asked[0]?.[asked[0].indexOf("--resume") + 1], OLD);
    assert.equal(d.waking.has(SID), false);
    assert.ok(d.managed.get(SID).hibernated);
  } finally {
    await done();
  }
});

test("removing a hibernated session signals nothing, and forgets it", async () => {
  const { d, killed, agents, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    killed.length = 0;
    assert.equal((await d.remove(SID)).ok, true);
    assert.deepEqual(killed, []);
    assert.equal(d.managed.has(SID), false);
    assert.equal(d.tracked.has(SID), false);
    assert.equal(shown(), undefined);
  } finally {
    await done();
  }
});

// Claude's question (AskUserQuestion), left unanswered hours ago, as Claude Code writes it in the transcript.
const QUESTION = "どちらの案で進めますか？";
const askLine = (at: string) =>
  JSON.stringify({
    type: "assistant",
    uuid: "a2",
    timestamp: at,
    message: {
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions: [{ question: QUESTION, header: "案", options: [{ label: "A 案" }, { label: "B 案" }], multiSelect: false }] } }],
    },
  });

test("a session whose question has no answer in its transcript is not hibernated, even when its state and screen miss it", async () => {
  // Claude Code's state says idle and its prompt box is shown: the hook held for the question went with a restart of
  // gasho-daemon, or the dialog is not drawn. The transcript still says it waits for an answer (#250).
  const { d, procs, transcript, done } = await setup();
  try {
    await fs.appendFile(transcript, `${askLine(new Date(Date.now() - 4 * HOUR).toISOString())}\n`);
    await d.pollTails();
    assert.ok(d.tracked.get(SID).meta.question);
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("the question a session was hibernated with is shown, and its answer brings the session back and is typed", async () => {
  const { d, make, term, agents, transcript, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    assert.ok(d.managed.get(SID).hibernated);
    agents([]);
    // Hibernated with the question open (by gasho-daemon 0.36.0 or before), and gasho-daemon restarted since.
    await fs.appendFile(transcript, `${askLine(new Date(Date.now() - 4 * HOUR).toISOString())}\n`);
    const again = make();
    await again.loadManaged();
    await again.refresh();
    const [card] = shown(again).permissionRequests ?? [];
    assert.equal(card?.id, "question:toolu_q");
    assert.equal(card?.answerAsMessage, true);

    const result = await again.answerQuestion({
      type: "permission.answer",
      requestId: "r1",
      sessionId: SID,
      permissionId: "question:toolu_q",
      decision: "allow",
      answers: [{ picked: [1] }],
    });
    assert.deepEqual(result, { ok: true, queued: true });
    // Not answerable twice, and not forgotten over a restart before it is back.
    assert.equal(shown(again).permissionRequests, undefined);
    const third = make();
    await third.loadManaged();
    assert.equal(third.managed.get(SID).hibernated.answeredQuestion, "toolu_q");
    assert.match(third.managed.waiting(SID)[0].text, /「どちらの案で進めますか？」→ B 案/);

    await again.waking.get(SID);
    await until(() => term.entered.some((e) => e.includes("→ B 案")), "the answer was typed");
    assert.match(term.entered.at(-1)!, /休止したため、再開してから送っています/);
    assert.equal(again.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("declining the question a session was hibernated with only stops showing it, and does not wake the session", async () => {
  const { d, agents, transcript, started, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    await fs.appendFile(transcript, `${askLine(new Date(Date.now() - 4 * HOUR).toISOString())}\n`);
    await d.pollTails();
    d.emitSessions();
    assert.equal(shown().permissionRequests?.[0]?.id, "question:toolu_q");
    const result = await d.answerQuestion({ type: "permission.answer", requestId: "r1", sessionId: SID, permissionId: "question:toolu_q", decision: "deny" });
    assert.deepEqual(result, { ok: true });
    assert.equal(shown().permissionRequests, undefined);
    assert.equal(d.waking.has(SID), false);
    assert.equal(started.length, 0);
    assert.equal(d.managed.pending(SID), 0);
  } finally {
    await done();
  }
});

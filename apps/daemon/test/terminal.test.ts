// The terminals Gasho gives the sessions it starts (terminal.ts, terminal-host.ts): real pseudo-terminals and real
// host processes, with a shell in place of Claude Code. No claude, no zellij, no systemd (a fake systemd-run at most).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cleanEnv, isAlive } from "../src/managed.ts";
import { keyBytes, pasteBytes, Terminals, type HostHello } from "../src/terminal.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A state folder of its own; every terminal still in it is closed afterwards. */
async function withTerminals(run: (t: Terminals, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const t = new Terminals({ stateDir, env: cleanEnv(), scopes: false });
  try {
    await run(t, stateDir);
  } finally {
    for (const name of (await t.live()).keys()) await t.kill(name);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const shell = (name: string, script: string) => ({ name, cwd: os.tmpdir(), file: "/bin/sh", args: ["-c", script], env: cleanEnv() });

test("keys are sent as a terminal sends them, the arrows in the program's cursor key mode", () => {
  const normal = { applicationCursorKeysMode: false };
  const app = { applicationCursorKeysMode: true };
  assert.equal(keyBytes("Enter", normal), "\r");
  assert.equal(keyBytes("Esc", normal), "\x1b");
  assert.equal(keyBytes("Backspace", normal), "\x7f");
  assert.equal(keyBytes("Ctrl u", normal), "\x15");
  assert.equal(keyBytes("Ctrl c", normal), "\x03");
  assert.equal(keyBytes("Down", normal), "\x1b[B");
  assert.equal(keyBytes("Down", app), "\x1bOB");
  assert.equal(keyBytes("Left", app), "\x1bOD");
  assert.equal(keyBytes("s", normal), "s");
  assert.equal(keyBytes("0", normal), "0");
  assert.equal(keyBytes("あ", normal), "あ");
  for (const bad of ["F13", "Ctrl", "ab", "\x1b", ""]) assert.throws(() => keyBytes(bad, normal), /unknown key/);
});

test("a paste is bracketed when the program asks for it, and no escape character gets through", () => {
  assert.equal(pasteBytes("一行目\n二行目", true), "\x1b[200~一行目\n二行目\x1b[201~");
  assert.equal(pasteBytes("x\x1b[201~\ry", true), "\x1b[200~x[201~\ry\x1b[201~");
  assert.equal(pasteBytes("plain", false), "plain");
});

test("a terminal runs its program, shows its screen with dim text told apart, and takes keys and pastes", async () => {
  await withTerminals(async (t) => {
    // Bracketed paste and the application cursor keys on, a dim word and a wide one, then everything typed comes back
    // through cat -v (the terminal echoes it too) with escape characters shown as ^[.
    const script = "printf '\\033[?2004h\\033[?1h\\033[2mdim\\033[22m ok 日本語\\n'; exec cat -v";
    const pid = await t.start(shell("gasho-sh-0001", script));
    assert.ok(isAlive(pid));
    const first = await until("the first line", async () => {
      const s = await t.screen("gasho-sh-0001");
      return s.plain.startsWith("dim ok 日本語") ? s : undefined;
    });
    assert.equal(first.typed.split("\n")[0]?.trimEnd(), " ok 日本語");
    assert.equal(first.plain.split("\n").length, 50);

    await t.keys("gasho-sh-0001", "a", "b", "Enter", "Up", "Enter");
    await t.paste("gasho-sh-0001", "hi\x1b");
    await t.keys("gasho-sh-0001", "Enter");
    const lines = await until("what was typed", async () => {
      const l = (await t.screen("gasho-sh-0001")).plain.split("\n").map((x) => x.trimEnd());
      return l.filter((x) => x === "^[[200~hi^[[201~").length === 2 ? l : undefined;
    });
    assert.equal(lines.filter((x) => x === "ab").length, 2);
    assert.equal(lines.filter((x) => x === "^[OA").length, 2);

    await assert.rejects(t.keys("gasho-sh-0001", "a", "F13"), /unknown key/);
  });
});

test("a terminal outlives the process that started it, and a new daemon finds it; closing it ends its program", async () => {
  await withTerminals(async (t, stateDir) => {
    // Another process starts the terminal and exits, as gasho-daemon does when it is restarted.
    const terminal = path.resolve(import.meta.dirname, "../src/terminal.ts");
    const managed = path.resolve(import.meta.dirname, "../src/managed.ts");
    const code = `
      import { Terminals } from ${JSON.stringify(terminal)};
      import { cleanEnv } from ${JSON.stringify(managed)};
      const t = new Terminals({ stateDir: ${JSON.stringify(stateDir)}, env: cleanEnv(), scopes: false });
      const pid = await t.start({ name: "gasho-left-0002", cwd: "/", file: "/bin/sh", args: ["-c", "echo still here; exec cat"], env: cleanEnv() });
      console.log(pid);
    `;
    const { stdout } = await execFileP(process.execPath, ["--input-type=module", "-e", code]);
    const pid = Number(stdout.trim());
    assert.ok(isAlive(pid));

    const live = await t.live();
    const hello = live.get("gasho-left-0002") as HostHello;
    assert.equal(hello.pid, pid);
    assert.equal(hello.cwd, "/");
    assert.equal(hello.exited, undefined);
    assert.ok(isAlive(hello.hostPid));
    await until("its screen", async () => ((await t.screen("gasho-left-0002")).plain.startsWith("still here") ? true : undefined));

    await t.kill("gasho-left-0002");
    await until("the program to end", async () => (isAlive(pid) || isAlive(hello.hostPid) ? undefined : true));
    assert.deepEqual([...(await t.live()).keys()], []);
    assert.deepEqual(await fs.readdir(t.dir).then((f) => f.filter((x) => !x.endsWith(".log"))), []);
  });
});

test("the last screen of a program that exited stays readable, and nothing more is typed into it", async () => {
  await withTerminals(async (t) => {
    await t.start(shell("gasho-done-0003", "echo did not start"));
    const hello = await until("the end", async () => {
      const h = await t.hello("gasho-done-0003");
      return h.exited ? h : undefined;
    });
    assert.deepEqual(hello.exited, { code: 0 });
    assert.ok((await t.screen("gasho-done-0003")).plain.startsWith("did not start"));
    await assert.rejects(t.keys("gasho-done-0003", "Enter"), /the program has exited/);
    await assert.rejects(t.paste("gasho-done-0003", "x"), /the program has exited/);
  });
});

test("a terminal that cannot start says why, and leaves nothing behind", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const bin = path.join(stateDir, "bin");
  await fs.mkdir(bin);
  // A systemd-run that can make scopes (it runs `true`), but not this one.
  const failing = `#!/bin/sh\n[ "$5" = "true" ] && exit 0\necho "Failed to start transient scope unit: Unit $5 already exists." >&2\nexit 1\n`;
  await fs.writeFile(path.join(bin, "systemd-run"), failing, { mode: 0o755 });
  const t = new Terminals({ stateDir, env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}` } });
  try {
    const started = Date.now();
    await assert.rejects(t.start(shell("gasho-bad-0004", "exec cat")), /did not start \(it exited \(code 1\)\):\nFailed to start transient scope unit/);
    // It gives up as soon as the host is gone, not after the whole wait.
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await fs.readdir(t.dir), []);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

// A systemd-run that writes its arguments to $LOG and runs the command after "--", as `--scope` does.
const FAKE_SYSTEMD_RUN = `#!/bin/sh
echo "systemd-run $*" >> "$LOG"
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ $# -gt 0 ] && shift
[ $# -gt 0 ] && exec "$@"
exit 0
`;

test("where systemd runs for the user, a terminal gets a scope of its own, outside gasho-daemon's service", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const bin = path.join(stateDir, "bin");
  await fs.mkdir(bin);
  const log = path.join(stateDir, "systemd-run.log");
  await fs.writeFile(path.join(bin, "systemd-run"), FAKE_SYSTEMD_RUN, { mode: 0o755 });
  const t = new Terminals({ stateDir, env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, LOG: log } });
  try {
    await t.start(shell("gasho-scoped-0005", "exec cat"));
    await t.start(shell("gasho-scoped-0006", "exec cat"));
    const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
    // Whether scopes can be made is asked once; each terminal is started in its own.
    assert.equal(calls.length, 3);
    assert.equal(calls[0], "systemd-run --user --scope --quiet --collect true");
    for (const [i, name] of [[1, "gasho-scoped-0005"], [2, "gasho-scoped-0006"]] as const) {
      assert.ok(calls[i]?.startsWith(`systemd-run --user --scope --quiet --collect --unit=${name} -- ${process.execPath} `), calls[i]);
      assert.ok(calls[i]?.endsWith(path.join(t.dir, `${name}.json`)), calls[i]);
    }
    assert.deepEqual([...(await t.live()).keys()].sort(), ["gasho-scoped-0005", "gasho-scoped-0006"]);
  } finally {
    for (const name of (await t.live()).keys()) await t.kill(name);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanEnv, launchableFolders, launchArgs, ManagedSessions, zellijSessionName } from "../src/managed.ts";

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
    assert.equal(a.enqueue("s1", "one"), 1);
    assert.equal(a.enqueue("s1", "two"), 2);
    assert.equal(a.next("s1"), "one");
    a.unshift("s1", "one");
    assert.deepEqual([a.next("s1"), a.next("s1"), a.next("s1")], ["one", "two", undefined]);

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

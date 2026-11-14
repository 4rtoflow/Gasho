// Updating gasho-daemon from Gasho: the versions are installed with a fake npm (which "installs" a cli.js that prints
// its version), in a layout in a temporary folder; nothing is downloaded and no process ends.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonUpdateInfo, HubToDaemon } from "@gasho/protocol";
import { Daemon } from "../src/daemon.ts";
import { cliIn, type Install, layoutOf, type Layout } from "../src/install.ts";
import { currentVersion, installedVersions, switchTo, UPDATE_EXIT_CODE, Updater, versionsInUse } from "../src/self-update.ts";

/**
 * A stand-in for npm: `install <name>@<version>` makes node_modules/<name>/lib/cli.js in the folder it runs in, which
 * prints the version (FAKE_PRINTS: another one; FAKE_NPM_FAIL: npm fails instead).
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.FAKE_NPM_FAIL) {
  console.error("npm error code E404");
  console.error("npm error 404 Not Found - GET https://npm.pkg.github.com/@4rtoflow%2fgasho-daemon");
  process.exit(1);
}
const spec = process.argv[process.argv.length - 1];
const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const version = process.env.FAKE_PRINTS || spec.slice(at + 1);
const lib = path.join(process.cwd(), "node_modules", ...name.split("/"), "lib");
fs.mkdirSync(lib, { recursive: true });
fs.writeFileSync(path.join(lib, "cli.js"), "console.log(" + JSON.stringify(version) + ");\\n");
`;

async function setup(): Promise<{ dir: string; layout: Layout; npm: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-update-"));
  const layout = layoutOf({ GASHO_DAEMON_HOME: path.join(dir, "daemon") });
  const npm = path.join(dir, "npm");
  await fs.writeFile(npm, FAKE_NPM, { mode: 0o755 });
  return { dir, layout, npm };
}

/** A version installed as an update would have installed it. */
async function installed(layout: Layout, version: string): Promise<void> {
  const cli = cliIn(path.join(layout.versions, version));
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(cli, `console.log(${JSON.stringify(version)});\n`);
}

interface Run {
  updater: Updater;
  /** The update's state at each change. */
  states: DaemonUpdateInfo[];
  exited: Promise<number>;
}

function updater(
  o: { layout: Layout; npm: string; version?: string; install?: Install; service?: boolean; env?: NodeJS.ProcessEnv; waiting?: () => number; waitMs?: number },
): Run {
  const states: DaemonUpdateInfo[] = [];
  let exit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const version = o.version ?? "0.14.0";
  const u = new Updater({
    install: o.install ?? { kind: "managed", version },
    layout: o.layout,
    version,
    service: o.service ?? true,
    npm: o.npm,
    node: process.execPath,
    env: { ...process.env, ...o.env },
    waiting: o.waiting ?? (() => 0),
    changed: () => states.push(u.info()),
    exit: (code) => exit(code),
    log: () => undefined,
    waitMs: o.waitMs,
    pollMs: 10,
  });
  return { updater: u, states, exited };
}

/** Waits until the update has ended, by failing or by ending the process. */
async function settled(r: Run): Promise<"exited" | "failed"> {
  for (let i = 0; i < 500; i++) {
    if (r.states.at(-1)?.failed) return "failed";
    if (r.states.at(-1)?.progress?.step === "restart") {
      assert.equal(await r.exited, UPDATE_EXIT_CODE);
      return "exited";
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("the update did not end");
}

test("only a gasho-daemon installed by service install and run as its service can be updated from Gasho", async () => {
  const { layout, npm } = await setup();
  const repo = updater({ layout, npm, install: { kind: "repo", repo: "/r" } }).updater.info();
  assert.equal(repo.canUpdate, false);
  assert.match(repo.reason ?? "", /git pull/);
  assert.equal(repo.command, undefined);

  const npx = updater({ layout, npm, install: { kind: "npx" } }).updater.info();
  assert.equal(npx.canUpdate, false);
  assert.equal(npx.command, "npx @4rtoflow/gasho-daemon@latest service install");

  const foreground = updater({ layout, npm, service: false }).updater.info();
  assert.equal(foreground.canUpdate, false);
  assert.match(foreground.reason ?? "", /常駐させずに/);
  assert.equal(foreground.command, "npx @4rtoflow/gasho-daemon@latest service install");

  const r = updater({ layout, npm });
  assert.deepEqual(r.updater.info(), { canUpdate: true, installed: undefined, previous: undefined, progress: undefined, failed: undefined });
  assert.deepEqual(r.updater.start("latest"), { ok: false, error: "版の指定が正しくありません。" });
  assert.deepEqual(r.updater.start("0.14.0"), { ok: false, error: "すでに 0.14.0 で動いています。" });
  assert.equal(updater({ layout, npm, install: { kind: "npx" } }).updater.start("0.15.0").ok, false);
});

test("an update installs the version beside the running one, checks it, switches current and ends for the service to start it", async () => {
  const { layout, npm } = await setup();
  await installed(layout, "0.14.0");
  await switchTo(layout, "0.14.0");
  const r = updater({ layout, npm });
  await r.updater.load();
  assert.deepEqual(r.updater.start("0.15.0"), { ok: true });
  assert.equal(r.updater.start("0.15.1").error, "0.15.0 に更新している途中です。");
  assert.equal(await settled(r), "exited");
  assert.deepEqual(
    r.states.map((s) => s.progress?.step),
    ["install", "check", "restart"],
  );
  assert.equal(await currentVersion(layout), "0.15.0");
  assert.equal(await fs.readlink(layout.current), path.join("versions", "0.15.0"));
  assert.deepEqual(await installedVersions(layout), ["0.14.0", "0.15.0"]);
  // Nothing half-done is left in versions.
  assert.deepEqual((await fs.readdir(layout.versions)).sort(), ["0.14.0", "0.15.0"]);

  // The new version knows the one it replaced, to go back to; going back installs nothing.
  const next = updater({ layout, npm, version: "0.15.0", env: { FAKE_NPM_FAIL: "1" } });
  await next.updater.load();
  assert.equal(next.updater.info().previous, "0.14.0");
  assert.deepEqual(next.updater.info().installed, ["0.14.0"]);
  assert.deepEqual(next.updater.start("0.14.0"), { ok: true });
  assert.equal(await settled(next), "exited");
  assert.equal(await currentVersion(layout), "0.14.0");
});

test("a failed install or a version that does not start changes nothing, and says why", async () => {
  const { layout, npm } = await setup();
  await installed(layout, "0.14.0");
  await switchTo(layout, "0.14.0");

  const notFound = updater({ layout, npm, env: { FAKE_NPM_FAIL: "1" } });
  notFound.updater.start("0.15.0");
  assert.equal(await settled(notFound), "failed");
  const failed = notFound.states.at(-1)?.failed;
  assert.equal(failed?.version, "0.15.0");
  assert.match(failed?.error ?? "", /npm で @4rtoflow\/gasho-daemon@0\.15\.0 を入れられませんでした/);
  assert.match(failed?.error ?? "", /404 Not Found/);
  assert.equal(notFound.states.at(-1)?.progress, undefined);
  assert.equal(await currentVersion(layout), "0.14.0");
  assert.deepEqual(await fs.readdir(layout.versions), ["0.14.0"]);

  const wrong = updater({ layout, npm, env: { FAKE_PRINTS: "0.13.9" } });
  wrong.updater.start("0.15.0");
  assert.equal(await settled(wrong), "failed");
  assert.equal(wrong.states.at(-1)?.failed?.error, "入れた gasho-daemon が 0.15.0 ではなく 0.13.9 でした。");
  assert.equal(await currentVersion(layout), "0.14.0");
  // A new update clears the failure.
  const again = updater({ layout, npm });
  await again.updater.load();
  assert.deepEqual(again.updater.info().installed, ["0.15.0"]);
});

test("an update waits for the inputs still to be typed, and gives up when they stay", async () => {
  const { layout, npm } = await setup();
  await installed(layout, "0.14.0");
  await switchTo(layout, "0.14.0");

  let left = 3;
  const waits = updater({ layout, npm, waiting: () => (left > 0 ? left-- : 0) });
  waits.updater.start("0.15.0");
  assert.equal(await settled(waits), "exited");
  assert.deepEqual(
    waits.states.map((s) => s.progress?.step),
    ["install", "check", "wait", "restart"],
  );

  await switchTo(layout, "0.14.0");
  const stuck = updater({ layout, npm, waiting: () => 2, waitMs: 50 });
  stuck.updater.start("0.15.1");
  assert.equal(await settled(stuck), "failed");
  assert.match(stuck.states.at(-1)?.failed?.error ?? "", /送るのを待っている入力が 2 件残っているので、更新をやめました/);
  assert.equal(await currentVersion(layout), "0.14.0");
  assert.ok(existsSync(cliIn(path.join(layout.versions, "0.15.1"))), "the installed version stays, for the next try");
});

test("the versions no longer used are removed, but not the one to go back to nor one a session's terminal runs from", async () => {
  const { layout, npm } = await setup();
  for (const v of ["0.12.0", "0.13.0", "0.14.0", "0.15.0"]) await installed(layout, v);
  await fs.mkdir(path.join(layout.versions, ".0.16.0-123-abc"));
  await switchTo(layout, "0.15.0");
  await fs.writeFile(layout.updateFile, JSON.stringify({ from: "0.14.0", to: "0.15.0", at: 1 }));
  const terminal = `${process.execPath} ${path.join(layout.versions, "0.12.0", "node_modules/@4rtoflow/gasho-daemon/lib/terminal-host.js")} /x/y.json`;
  const ps = async () => ["/usr/bin/zsh", terminal, ""].join("\n");
  assert.deepEqual(await versionsInUse(layout, ps), new Set(["0.12.0"]));

  const r = updater({ layout, npm, version: "0.15.0" });
  await r.updater.load();
  assert.deepEqual(await r.updater.prune(ps), ["0.13.0"]);
  assert.deepEqual((await fs.readdir(layout.versions)).sort(), ["0.12.0", "0.14.0", "0.15.0"]);
  assert.deepEqual(r.updater.info().installed, ["0.12.0", "0.14.0"]);

  // When the processes cannot be listed, nothing is removed.
  assert.deepEqual(
    await r.updater.prune(async () => {
      throw new Error("no ps");
    }),
    [],
  );
});

test("gasho-daemon answers daemon.update and tells the Gasho server whether it can be updated", async () => {
  const { dir, layout } = await setup();
  const make = (update?: ConstructorParameters<typeof Daemon>[1]) => {
    const d = new Daemon(
      {
        hubUrl: "ws://127.0.0.1:1",
        machineId: "m",
        token: "t",
        hookPort: 0,
        claudeDir: path.join(dir, "claude-dir"),
        claudeBin: "claude",
        ghBin: "gh",
        pollIntervalMs: 60_000,
        stateDir: dir,
        attachmentsDir: path.join(dir, "attachments"),
      } as ConstructorParameters<typeof Daemon>[0],
      update,
    ) as unknown as Record<string, any>;
    const sent: unknown[] = [];
    d.hub = { connected: true, send: (m: unknown) => sent.push(m) };
    return { d, sent };
  };
  // Run from a clone (as in these tests): not updatable from Gasho.
  const repo = make();
  repo.d.emitCapabilities();
  assert.equal((repo.sent[0] as { update: DaemonUpdateInfo }).update.canUpdate, false);
  await repo.d.onHubMessage({ type: "daemon.update", requestId: "r1", version: "9.9.9" } satisfies HubToDaemon);
  const result = repo.sent.at(-1) as { type: string; requestId: string; result: { ok: boolean; error?: string } };
  assert.equal(result.type, "command.result");
  assert.equal(result.requestId, "r1");
  assert.equal(result.result.ok, false);
  assert.match(result.result.error ?? "", /git pull/);

  // Installed by service install and run as its service: it can be.
  const managed = make({ update: { install: { kind: "managed", version: "0.14.0" }, layout, service: true } });
  managed.d.emitCapabilities();
  assert.equal((managed.sent[0] as { update: DaemonUpdateInfo }).update.canUpdate, true);
  await fs.rm(dir, { recursive: true, force: true });
});

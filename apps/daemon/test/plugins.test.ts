import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonToHub } from "@gasho/protocol";
import { PluginRunner } from "../src/plugins.ts";

const V1 = `
export default {
  start(ctx) { globalThis.startedOn = ctx.machine.id; },
  methods: {
    echo: async (params, ctx) => ({
      params,
      settings: ctx.settings,
      machine: globalThis.startedOn,
      cwd: ctx.session?.cwd,
      app: ctx.session?.repo("app").dir,
    }),
    local: (params, ctx) => ({ folders: ctx.folders(), dataDir: ctx.dataDir }),
    outside: (params, ctx) => ctx.session.repo("../etc"),
    oops: () => { const e = new Error("見せてよい理由"); e.gashoPluginError = true; throw e; },
    crash: () => { throw new Error("secret detail"); },
    slow: (params, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("aborted"))),
    sh: async (params, ctx) => (await ctx.exec("echo", ["hi"])).stdout.trim(),
    missing: async (params, ctx) => { try { await ctx.exec("no-such-command-gasho", []); } catch (e) { return e.code; } },
    version: () => 1,
  },
};
`;
const V2 = `export default { methods: { version: () => 2 } };`;
const HASH1 = "aaaaaaaaaaaaaaaa";
const HASH2 = "bbbbbbbbbbbbbbbb";

function setup(enabled = true) {
  const sent: DaemonToHub[] = [];
  const logs: string[] = [];
  const codes: Record<string, string> = { [HASH1]: V1, [HASH2]: V2 };
  let runner: PluginRunner;
  const local = { folders: ["/work"], dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugin-data-")) };
  const send = (m: DaemonToHub) => {
    sent.push(m);
    // The Gasho server hands over the code asked for.
    if (m.type === "plugin.code.get") setTimeout(() => runner.onCode({ type: "plugin.code", plugin: m.plugin, hash: m.hash, code: codes[m.hash] }), 5);
  };
  runner = new PluginRunner({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-daemon-plugins-")),
    send,
    machine: () => ({ id: "m1", name: "ubuntu" }),
    session: async (id) => (id === "s1" ? { sessionId: "s1", cwd: "/work/zen", managed: true, repos: [{ path: "app" }] } : undefined),
    folders: () => local.folders,
    dataDir: local.dataDir,
    enabled,
    log: (s) => logs.push(s),
  });
  const call = async (method: string, extra: { sessionId?: string; timeoutMs?: number; params?: unknown } = {}) => {
    const requestId = `${method}-${Math.random()}`;
    await runner.request({ type: "plugin.request", requestId, plugin: "hello", method, timeoutMs: extra.timeoutMs ?? 10_000, ...extra });
    const r = sent.find((m) => m.type === "plugin.response" && m.requestId === requestId);
    assert.ok(r?.type === "plugin.response");
    return r;
  };
  const state = () => {
    const s = sent.filter((m) => m.type === "plugin.status").at(-1);
    return s?.type === "plugin.status" ? s.plugins.find((p) => p.id === "hello") : undefined;
  };
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(ok(), "timed out");
  };
  return { runner, sent, logs, call, state, until, local };
}

test("a daemon part runs in a process of its own, gets its session and settings, and answers calls", async () => {
  const { runner, call, state, until, sent, local } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: { interval: 60 } }]);
    assert.ok(sent.some((m) => m.type === "plugin.code.get" && m.hash === HASH1));
    await until(() => state()?.state === "running");
    assert.equal(state()?.hash, HASH1);

    const echo = await call("echo", { sessionId: "s1", params: { a: 1 } });
    assert.deepEqual(echo.result, { params: { a: 1 }, settings: { interval: 60 }, machine: "m1", cwd: "/work/zen", app: "/work/zen/app" });
    assert.equal((await call("echo", { sessionId: "nope" })).error, "このセッションは見つかりません。");
    // A repository the daemon did not find is refused (the path comes from a browser).
    assert.equal((await call("outside", { sessionId: "s1" })).error, "このリポジトリは見つかりません。");
    assert.equal((await call("oops")).error, "見せてよい理由");
    assert.match((await call("crash")).error ?? "", /^処理に失敗しました/);
    assert.match((await call("nothing")).error ?? "", /nothing という処理はありません/);
    assert.equal((await call("sh")).result, "hi");
    assert.equal((await call("missing")).result, "ENOENT");
    assert.equal((await call("slow", { timeoutMs: 1000 })).error, "working server から応答がありません。");

    // Its own folder is made before it starts; the folders reach the running process when they change.
    const dataDir = path.join(local.dataDir, "hello");
    assert.deepEqual((await call("local")).result, { folders: ["/work"], dataDir });
    assert.ok(fs.statSync(dataDir).isDirectory());
    local.folders = ["/work", "/home/rg/repos"];
    runner.foldersChanged();
    assert.deepEqual((await call("local")).result, { folders: ["/work", "/home/rg/repos"], dataDir });
  } finally {
    await runner.stopAll();
  }
});

test("a new version replaces the old one (hot reload), and turning the plugin off stops it", async () => {
  const { runner, call, state, until } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
    await until(() => state()?.state === "running");
    assert.equal((await call("version")).result, 1);
    runner.update([{ id: "hello", hash: HASH2, run: true, settings: {} }]);
    await until(() => state()?.hash === HASH2);
    assert.equal((await call("version")).result, 2);
    runner.update([{ id: "hello", hash: HASH2, run: false, settings: {} }]);
    assert.equal(state()?.state, "off");
    assert.equal((await call("version")).error, "このプラグインは、この working server では動いていません。");
  } finally {
    await runner.stopAll();
  }
});

test("with GASHO_PLUGINS=none no daemon part runs", async () => {
  const { runner, call, state, sent } = setup(false);
  runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
  assert.equal(state()?.state, "off");
  assert.ok(!sent.some((m) => m.type === "plugin.code.get"));
  assert.match((await call("version")).error ?? "", /GASHO_PLUGINS/);
  await runner.stopAll();
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HubToClient, HubToDaemon, PluginInfo, PluginSettingSpec } from "@gasho/protocol";
import { Hub } from "../src/hub.ts";
import { checkManifest, PluginRegistry, settingProblem } from "../src/plugins.ts";
import { Store } from "../src/store.ts";

const manifest = {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  api: "1.2",
  web: { js: "web.js", css: "web.css" },
  daemon: { js: "daemon.js" },
  methods: { greet: { kind: "read" }, save: { kind: "write", timeoutSeconds: 30 } },
  settings: {
    interval: { type: "number", scope: "server", label: "間隔", default: 60, min: 0, max: 3600 },
    compact: { type: "boolean", scope: "browser", label: "詰めて出す" },
  },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugins-"));
}

function writePlugin(dir: string, m: object = manifest, files: Record<string, string> = {}): string {
  const folder = path.join(dir, (m as { id: string }).id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "gasho-plugin.json"), JSON.stringify(m));
  const all = { "web.js": "export default {}", "web.css": ".x{}", "daemon.js": "export default { methods: {} }", ...files };
  for (const [name, text] of Object.entries(all)) fs.writeFileSync(path.join(folder, name), text);
  return folder;
}

function fakePeer<T>(deviceId = "") {
  const peer = {
    deviceId,
    machineId: undefined as string | undefined,
    sent: [] as T[],
    send(m: T) {
      peer.sent.push(m);
    },
    close() {},
  };
  return peer;
}

test("checkManifest takes a good manifest and says what is wrong with a bad one", () => {
  const files = new Set(["gasho-plugin.json", "web.js", "web.css", "daemon.js"]);
  const ok = checkManifest(manifest, "hello", files);
  assert.ok("manifest" in ok);
  assert.equal(ok.manifest.methods?.save?.timeoutSeconds, 30);
  const bad = (m: object, folder = "hello", f = files) => {
    const r = checkManifest({ ...manifest, ...m }, folder, f);
    return "error" in r ? r.error : "";
  };
  assert.match(bad({ id: "Hello" }), /id/);
  assert.match(bad({}, "other"), /フォルダーの名前/);
  assert.match(bad({ api: "2.0" }), /API 2\.0/);
  assert.match(bad({ api: "1.9" }), /API 1\.9/);
  assert.match(bad({ api: "1.7" }), /この Gasho は 1\.6 までです/);
  assert.match(bad({ version: "1" }), /version/);
  assert.match(bad({ web: { js: "../x.js" } }), /web\.js/);
  assert.match(bad({}, "hello", new Set(["gasho-plugin.json", "web.js", "web.css"])), /daemon\.js のファイル（daemon\.js）がありません/);
  assert.match(bad({ web: undefined, daemon: undefined }), /web・daemon・theme/);
  assert.match(bad({ methods: { go: { kind: "maybe" } } }), /kind/);
  assert.match(bad({ permissions: ["root"] }), /permissions/);
  assert.match(bad({ settings: { x: { type: "select", scope: "server", label: "x", options: [] } } }), /options/);

  // A theme alone is a plugin (API 1.6). Only Gasho's names, and values that stay one CSS value.
  const theme = { id: "hello", name: "Hello", version: "1.0.0", api: "1.6", theme: { background: " #10141c ", "neutral-950": "oklch(0.2 0 0)" } };
  const onlyManifest = new Set(["gasho-plugin.json"]);
  const t = checkManifest(theme, "hello", onlyManifest);
  assert.ok("manifest" in t);
  assert.deepEqual(t.manifest.theme, { background: "#10141c", "neutral-950": "oklch(0.2 0 0)" });
  const badTheme = (m: object) => {
    const r = checkManifest({ ...theme, ...m }, "hello", onlyManifest);
    return "error" in r ? r.error : "";
  };
  assert.match(badTheme({ api: "1.5" }), /api を 1\.6 以上/);
  assert.match(badTheme({ theme: {} }), /1つ以上/);
  assert.match(badTheme({ theme: { "color-white": "#fff" } }), /color-white という名前はありません/);
  assert.match(badTheme({ theme: JSON.parse('{"__proto__": "#fff"}') }), /__proto__ という名前はありません/);
  assert.match(badTheme({ theme: { background: "red; color: blue" } }), /theme\.background/);
  assert.match(badTheme({ theme: { background: "#000 } body { display: none" } }), /theme\.background/);
  assert.match(badTheme({ theme: { background: "x".repeat(65) } }), /theme\.background/);
});

test("settingProblem checks values against their settings", () => {
  const n: PluginSettingSpec = { type: "number", scope: "server", label: "n", min: 0, max: 10 };
  assert.equal(settingProblem(n, 5), undefined);
  assert.match(settingProblem(n, 11) ?? "", /10 以下/);
  assert.match(settingProblem(n, "5") ?? "", /数/);
  const s: PluginSettingSpec = { type: "select", scope: "server", label: "s", options: [{ value: "a", label: "A" }] };
  assert.equal(settingProblem(s, "a"), undefined);
  assert.ok(settingProblem(s, "b"));
});

test("the registry reads plugin folders, copies each version into the cache, and keeps the last good one on errors", async () => {
  const dir = tmp();
  const cache = tmp();
  const folder = writePlugin(dir);
  const reg = new PluginRegistry({ dir, cacheDir: cache });
  await reg.scan();
  const first = reg.get("hello");
  assert.ok(first?.revision);
  assert.equal(first.dev, false);
  const hash = first.revision.hash;
  assert.match(hash, /^[0-9a-f]{16}$/);
  const served = reg.filePath("hello", hash, "web.js");
  assert.ok(served?.startsWith(cache));
  assert.equal(fs.readFileSync(served ?? "", "utf8"), "export default {}");
  assert.equal(reg.filePath("hello", hash, "../hello/web.js"), undefined);
  assert.equal(await reg.daemonCode("hello", hash), "export default { methods: {} }");

  // A new build is a new version; the old one stays in the cache (browsers may still read its files).
  fs.writeFileSync(path.join(folder, "web.js"), "export default { sidebar: [] }");
  await reg.scan();
  const second = reg.get("hello")?.revision?.hash;
  assert.ok(second && second !== hash);
  assert.ok(reg.filePath("hello", hash, "web.js"));

  // A broken build keeps the version in use, with the error.
  fs.writeFileSync(path.join(folder, "gasho-plugin.json"), "{");
  await reg.scan();
  assert.equal(reg.get("hello")?.revision?.hash, second);
  assert.match(reg.get("hello")?.error ?? "", /新しい版に問題があります/);

  // A link is a plugin being developed.
  fs.rmSync(path.join(dir, "hello"), { recursive: true });
  const dev = writePlugin(tmp());
  fs.symlinkSync(dev, path.join(dir, "hello"));
  await reg.scan();
  assert.equal(reg.get("hello")?.dev, true);
  reg.close();
});

async function setup(...more: object[]) {
  const dir = tmp();
  writePlugin(dir);
  for (const m of more) writePlugin(dir, m);
  const registry = new PluginRegistry({ dir, cacheDir: tmp() });
  await registry.scan();
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store, { plugins: registry });
  const client = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(client);
  const daemon = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(daemon, { type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.12.0" });
  return { hub, store, registry, client, daemon, machineId: machine.device.id };
}

const lastPlugins = (sent: HubToClient[]): PluginInfo[] | undefined => {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m?.type === "plugins") return m.plugins;
    if (m?.type === "snapshot") return m.plugins;
  }
  return undefined;
};

test("browsers get the plugins with their files' URLs, and the daemon part's state per working server", async () => {
  const { client, daemon, hub, machineId } = await setup();
  const snapshot = client.sent[0];
  assert.ok(snapshot?.type === "snapshot");
  const p = snapshot.plugins?.[0];
  assert.equal(p?.id, "hello");
  assert.equal(p?.enabled, true);
  assert.equal(p?.machines, "all");
  assert.match(p?.web?.js ?? "", /^\/plugins\/hello\/[0-9a-f]{16}\/web\.js$/);
  assert.deepEqual(p?.values, { interval: 60 });

  // The daemon is told which daemon parts to run.
  const told = daemon.sent.find((m) => m.type === "plugins");
  assert.ok(told?.type === "plugins");
  assert.deepEqual(told.plugins, [{ id: "hello", hash: p?.hash, run: true, settings: { interval: 60 } }]);

  // A gasho-daemon that says nothing about plugins is too old, and so is one of API 1.0 or 1.1 for this 1.2 plugin;
  // once it runs 1.2, its state shows.
  assert.equal(lastPlugins(client.sent)?.[0]?.daemon?.[machineId]?.state, "old");
  hub.onDaemonMessage(daemon, { type: "plugin.status", api: "1.0", plugins: [{ id: "hello", hash: p?.hash, state: "running" }] });
  assert.equal(lastPlugins(client.sent)?.[0]?.daemon?.[machineId]?.state, "old");
  hub.onDaemonMessage(daemon, { type: "plugin.status", api: "1.1", plugins: [{ id: "hello", hash: p?.hash, state: "running" }] });
  assert.equal(lastPlugins(client.sent)?.[0]?.daemon?.[machineId]?.state, "old");
  hub.onDaemonMessage(daemon, { type: "plugin.status", api: "1.2", plugins: [{ id: "hello", hash: p?.hash, state: "running" }] });
  assert.equal(lastPlugins(client.sent)?.[0]?.daemon?.[machineId]?.state, "running");

  // It gets the code it asks for.
  hub.onDaemonMessage(daemon, { type: "plugin.code.get", plugin: "hello", hash: p?.hash ?? "" });
  await new Promise((r) => setTimeout(r, 50));
  const code = daemon.sent.find((m) => m.type === "plugin.code");
  assert.ok(code?.type === "plugin.code");
  assert.equal(code.code, "export default { methods: {} }");
});

test("calls of a plugin are relayed to the working server and the answer goes back to the asking browser", async () => {
  const { client, daemon, hub, machineId, store } = await setup();
  const call = (method: string, extra: object = {}) =>
    hub.onClientMessage(client, { type: "plugin.request", requestId: `r-${method}`, plugin: "hello", machine: machineId, method, params: { a: 1 }, ...extra });
  const answer = (id: string) => client.sent.find((m) => m.type === "plugin.response" && m.requestId === id);

  call("greet");
  assert.match((answer("r-greet") as { error?: string }).error ?? "", /古い/);

  hub.onDaemonMessage(daemon, { type: "plugin.status", api: "1.2", plugins: [{ id: "hello", state: "running" }] });
  client.sent.length = 0;
  call("greet", { requestId: "r2", sessionId: "s1" });
  const relayed = daemon.sent.find((m) => m.type === "plugin.request");
  assert.ok(relayed?.type === "plugin.request");
  assert.equal(relayed.plugin, "hello");
  assert.equal(relayed.sessionId, "s1");
  assert.deepEqual(relayed.params, { a: 1 });
  assert.equal(relayed.timeoutMs, 15_000);
  assert.equal(relayed.write, undefined);
  hub.onDaemonMessage(daemon, { type: "plugin.response", requestId: relayed.requestId, result: { hello: "world" } });
  assert.deepEqual(answer("r2"), { type: "plugin.response", requestId: "r2", result: { hello: "world" } });

  call("nope");
  assert.match((answer("r-nope") as { error?: string }).error ?? "", /nope/);
  call("greet", { requestId: "r-big", params: "x".repeat(70_000) });
  assert.match((answer("r-big") as { error?: string }).error ?? "", /大きすぎ/);

  // A write is recorded in the operations log, and gasho-daemon is told it is one: only it may change GitHub.
  call("save", { summary: "メモを保存" });
  assert.ok(store.recentEvents().some((e) => e.event === "Gasho:plugin.call" && e.summary?.includes("メモを保存")));
  const save = daemon.sent.filter((m) => m.type === "plugin.request").at(-1);
  assert.ok(save?.type === "plugin.request" && save.method === "save" && save.write === true);

  // Disabled, or not chosen for this working server.
  hub.onClientMessage(client, { type: "plugin.enable", requestId: "e1", plugin: "hello", enabled: false });
  assert.deepEqual(client.sent.find((m) => m.type === "plugin.result" && m.requestId === "e1"), { type: "plugin.result", requestId: "e1", result: { ok: true } });
  assert.equal(lastPlugins(client.sent)?.[0]?.enabled, false);
  const toDaemon = daemon.sent.filter((m) => m.type === "plugins").at(-1);
  assert.ok(toDaemon?.type === "plugins" && toDaemon.plugins[0]?.run === false);
  call("greet", { requestId: "r-off" });
  assert.match((answer("r-off") as { error?: string }).error ?? "", /無効/);
  hub.onClientMessage(client, { type: "plugin.enable", requestId: "e2", plugin: "hello", enabled: true });
  hub.onClientMessage(client, { type: "plugin.machines", requestId: "m1", plugin: "hello", machines: [] });
  call("greet", { requestId: "r-none" });
  assert.match((answer("r-none") as { error?: string }).error ?? "", /動かしていません/);
});

test("only one theme is enabled at a time: enabling one disables the others, recorded in the operations log", async () => {
  const theme = (id: string) => ({ id, name: id, version: "1.0.0", api: "1.6", theme: { background: "#000" } });
  const { client, hub, store } = await setup(theme("ayu-dark"), theme("vscode-dark"));
  const enabled = () => Object.fromEntries((lastPlugins(client.sent) ?? []).map((p) => [p.id, p.enabled]));
  const enable = (plugin: string, on = true) => hub.onClientMessage(client, { type: "plugin.enable", requestId: `e-${plugin}-${on}`, plugin, enabled: on });
  // Plugins never switched count as enabled, so two themes can be (the screen uses the first).
  assert.deepEqual(enabled(), { "ayu-dark": true, hello: true, "vscode-dark": true });

  enable("ayu-dark");
  assert.deepEqual(enabled(), { "ayu-dark": true, hello: true, "vscode-dark": false });
  assert.ok(store.recentEvents().some((e) => e.event === "Gasho:plugin.enable" && e.summary?.startsWith("vscode-dark [off]（ayu-dark に切り替え）")));
  enable("vscode-dark");
  assert.deepEqual(enabled(), { "ayu-dark": false, hello: true, "vscode-dark": true });
  // Turning a theme off turns no other on; a plugin that is no theme leaves the themes as they are.
  enable("vscode-dark", false);
  enable("hello");
  assert.deepEqual(enabled(), { "ayu-dark": false, hello: true, "vscode-dark": false });
});

test("server settings are checked against the manifest, kept, and sent to browsers and gasho-daemon", async () => {
  const { client, daemon, hub } = await setup();
  const result = (id: string) => client.sent.find((m) => m.type === "plugin.result" && m.requestId === id);
  hub.onClientMessage(client, { type: "plugin.setting", requestId: "s1", plugin: "hello", key: "interval", value: 9999 });
  assert.match((result("s1") as { result: { error?: string } }).result.error ?? "", /3600 以下/);
  hub.onClientMessage(client, { type: "plugin.setting", requestId: "s2", plugin: "hello", key: "compact", value: true });
  assert.match((result("s2") as { result: { error?: string } }).result.error ?? "", /ブラウザーごと/);
  hub.onClientMessage(client, { type: "plugin.setting", requestId: "s3", plugin: "hello", key: "interval", value: 120 });
  assert.equal((result("s3") as { result: { ok: boolean } }).result.ok, true);
  assert.deepEqual(lastPlugins(client.sent)?.[0]?.values, { interval: 120 });
  const toDaemon = daemon.sent.filter((m) => m.type === "plugins").at(-1);
  assert.ok(toDaemon?.type === "plugins");
  assert.deepEqual(toDaemon.plugins[0]?.settings, { interval: 120 });
});

test("events of a daemon part go to every browser, and those to keep (retain) reach browsers that connect later", async () => {
  const { client, daemon, hub, machineId, registry, store } = await setup();
  const event = (m: object) => hub.onDaemonMessage(daemon, { type: "plugin.event", plugin: "hello", topic: "state", data: { n: 1 }, ...m });
  const relayed = (sent: HubToClient[]) => sent.flatMap((m) => (m.type === "plugin.event" ? [m.event] : []));
  const later = () => {
    const c = fakePeer<HubToClient>(store.createDevice("browser", "Mac").device.id);
    hub.onClientConnect(c);
    const snap = c.sent[0];
    return snap?.type === "snapshot" ? snap.pluginEvents : undefined;
  };

  event({ topic: "progress", data: 40 });
  assert.deepEqual(relayed(client.sent), [{ plugin: "hello", machine: machineId, topic: "progress", data: 40 }]);
  assert.deepEqual(later(), []);
  event({ retain: true });
  event({ retain: true, topic: "other", data: null });
  assert.deepEqual(later(), [
    { plugin: "hello", machine: machineId, topic: "state", data: { n: 1 } },
    { plugin: "hello", machine: machineId, topic: "other", data: null },
  ]);
  // The newest of a topic replaces the one kept.
  event({ retain: true, data: { n: 2 } });
  assert.deepEqual(later()?.find((e) => e.topic === "state")?.data, { n: 2 });

  // Not passed on: a topic or data that is not right, a plugin that is not there.
  client.sent.length = 0;
  event({ topic: "" });
  event({ topic: "x".repeat(101) });
  event({ data: "a".repeat(300 * 1024) });
  hub.onDaemonMessage(daemon, { type: "plugin.event", plugin: "nope", topic: "state", data: 1 });
  assert.deepEqual(relayed(client.sent), []);

  // Not chosen for this working server, or disabled: nothing goes on, and what was kept is dropped.
  hub.onClientMessage(client, { type: "plugin.machines", requestId: "m1", plugin: "hello", machines: [] });
  assert.deepEqual(later(), []);
  event({ retain: true });
  assert.deepEqual(relayed(client.sent), []);
  hub.onClientMessage(client, { type: "plugin.machines", requestId: "m2", plugin: "hello", machines: "all" });
  event({ retain: true });
  assert.equal(later()?.length, 1);
  hub.onClientMessage(client, { type: "plugin.enable", requestId: "e1", plugin: "hello", enabled: false });
  assert.deepEqual(later(), []);
  hub.onClientMessage(client, { type: "plugin.enable", requestId: "e2", plugin: "hello", enabled: true });

  // A new version of the plugin sends its own from its start: the old version's are dropped.
  event({ retain: true });
  assert.equal(later()?.length, 1);
  fs.writeFileSync(path.join(registry.dir, "hello", "daemon.js"), "export default { methods: { v2: () => 2 } }");
  await registry.scan();
  assert.deepEqual(later(), []);
});

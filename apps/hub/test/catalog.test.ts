import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import type { CatalogPlugin, HubToClient, PluginCatalog, PluginInfo } from "@gasho/protocol";
import { type GhRun, parseCatalog, PluginCatalogSource, sha256 } from "../src/catalog.ts";
import { Hub } from "../src/hub.ts";
import { compareVersions, PluginRegistry } from "../src/plugins.ts";
import { Store } from "../src/store.ts";
import { readTgz } from "../src/tar.ts";

const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 50 };

/** One entry of a tar archive (ustar). */
function entry(name: string, data: string | Buffer = "", type = "0", linkname = ""): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tgz = (...entries: Buffer[]) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

function pax(records: Record<string, string>): Buffer {
  const lines = Object.entries(records).map(([k, v]) => {
    const body = ` ${k}=${v}\n`;
    let n = body.length + 1;
    while (`${n}${body}`.length !== n) n = `${n}${body}`.length;
    return `${n}${body}`;
  });
  return entry("PaxHeader", lines.join(""), "x");
}

const refused = (gz: Buffer) => {
  try {
    readTgz(gz, LIMITS);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

test("readTgz reads files and folders, and refuses links, odd paths and archives over the limits", () => {
  const { files, dirs } = readTgz(tgz(entry("./", "", "5"), entry("./assets/", "", "5"), entry("./web.js", "export {}"), entry("./assets/a.js", "a")), LIMITS);
  assert.deepEqual(dirs, ["assets"]);
  assert.deepEqual(
    files.map((f) => [f.path, f.data.toString()]),
    [
      ["web.js", "export {}"],
      ["assets/a.js", "a"],
    ],
  );
  // A long name in a pax header.
  const long = `${"d".repeat(120)}/x.js`;
  assert.equal(readTgz(tgz(pax({ path: long }), entry("short", "x")), LIMITS).files[0]?.path, long);

  assert.match(refused(tgz(entry("/etc/passwd", "x"))), /パス/);
  assert.match(refused(tgz(entry("../up.js", "x"))), /パス/);
  assert.match(refused(tgz(entry("a/../../b", "x"))), /パス/);
  assert.match(refused(tgz(entry("link", "", "2", "/etc/passwd"))), /リンク/);
  assert.match(refused(tgz(entry("hard", "", "1", "web.js"))), /リンク/);
  assert.match(refused(tgz(entry("fifo", "", "6"))), /ふつうのファイル/);
  assert.match(refused(tgz(entry("a.js", "1"), entry("a.js", "2"))), /2回/);
  assert.match(refused(tgz(entry("a", "1"), entry("a/b", "2"))), /同じ名前/);
  assert.match(refused(tgz(entry("big", Buffer.alloc(LIMITS.maxBytes + 1)))), /大きすぎ/);
  assert.match(refused(tgz(...Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => entry(`f${i}`, "x")))), /多すぎ/);
  assert.match(refused(Buffer.from("not gzip")), /gzip/);
  const broken = Buffer.concat([entry("a.js", "x")]);
  broken[0] = "b".charCodeAt(0); // the checksum no longer fits
  assert.match(refused(zlib.gzipSync(broken)), /壊れて/);
});

test("readTgz reads what tar makes of a dist folder", (t) => {
  let tar = "";
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    tar = "tar";
  } catch {
    return t.skip("no tar");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-tar-"));
  fs.mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "gasho-plugin.json"), "{}");
  fs.writeFileSync(path.join(dir, "dist", "assets", `${"n".repeat(110)}.js`), "chunk");
  const out = path.join(dir, "p.tgz");
  execFileSync(tar, ["-czf", out, "-C", path.join(dir, "dist"), "."]);
  const { files } = readTgz(fs.readFileSync(out), LIMITS);
  assert.deepEqual(files.map((f) => f.path).sort(), [`assets/${"n".repeat(110)}.js`, "gasho-plugin.json"]);
});

test("compareVersions orders plugin versions", () => {
  assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
});

// ---- the catalog and the Gasho server ----

const manifest = (version: string, extra: object = {}) => ({
  id: "hello",
  name: "Hello",
  version,
  api: "1.0",
  web: { js: "web.js" },
  daemon: { js: "daemon.js" },
  methods: { greet: { kind: "read" } },
  settings: { interval: { type: "number", scope: "server", label: "間隔", default: 60 } },
  ...extra,
});

function release(version: string, extra: object = {}): { file: Buffer; entry: CatalogPlugin } {
  const file = tgz(
    entry("./", "", "5"),
    entry("./gasho-plugin.json", JSON.stringify(manifest(version, extra))),
    entry("./web.js", `export default { v: "${version}" }`),
    entry("./daemon.js", "export default { methods: {} }"),
  );
  return {
    file,
    entry: { id: "hello", name: "Hello", version, api: "1.0", daemon: true, release: `hello-v${version}`, file: `hello-${version}.tgz`, sha256: sha256(file), size: file.length },
  };
}

/** A gh that serves releases from memory, and records what it was asked. */
function fakeGh(assets: Map<string, Buffer>): GhRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const [, , tag, , , , file, , out] = args;
    const data = assets.get(`${tag}/${file}`);
    if (!data) throw Object.assign(new Error("gh failed"), { stderr: "release not found\n" });
    fs.writeFileSync(out ?? "", data);
  };
  return Object.assign(run, { calls });
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

const catalogJson = (plugins: object[]) => Buffer.from(JSON.stringify({ repo: "o/plugins", updatedAt: "2026-11-14T09:00:00Z", plugins }));

test("parseCatalog keeps the right entries and names the others", () => {
  const good = release("1.0.0").entry;
  const r = parseCatalog({ plugins: [good, { ...good, id: "x/y" }, { ...good, id: "other", release: "evil" }, { ...good, sha256: "nope" }, good] });
  assert.ok("plugins" in r);
  assert.deepEqual(r.plugins, [good]);
  assert.equal(r.skipped.length, 3);
  assert.ok("error" in parseCatalog({ nope: true }));
});

async function setup(assets: Map<string, Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugins-"));
  const registry = new PluginRegistry({ dir, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugin-cache-")) });
  await registry.scan();
  const gh = fakeGh(assets);
  let now = 1_000_000;
  const catalog = new PluginCatalogSource({ repo: "o/plugins", gh, now: () => now });
  const store = new Store(":memory:");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store, { plugins: registry, catalog });
  const client = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(client);
  const result = async (requestId: string) => {
    for (let i = 0; i < 200; i++) {
      const r = client.sent.find((m) => m.type === "plugin.result" && m.requestId === requestId);
      if (r?.type === "plugin.result") return r.result;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`no result for ${requestId}`);
  };
  return { dir, registry, gh, catalog, store, hub, client, result, later: (ms: number) => (now += ms) };
}

const lastCatalog = (sent: HubToClient[]): PluginCatalog | undefined =>
  sent.flatMap((m) => (m.type === "plugin.catalog" ? [m.catalog] : m.type === "snapshot" && m.catalog ? [m.catalog] : [])).at(-1);
const lastPlugins = (sent: HubToClient[]): PluginInfo[] | undefined =>
  sent.flatMap((m) => (m.type === "plugins" || m.type === "snapshot" ? [m.plugins ?? []] : [])).at(-1);

test("the catalog is read with gh when a browser asks (at most every 10 minutes), and kept when it cannot be read", async () => {
  const one = release("1.0.0");
  const assets = new Map([["catalog/catalog.json", catalogJson([one.entry])]]);
  const { client, hub, gh, later } = await setup(assets);
  assert.deepEqual(lastCatalog(client.sent), { repo: "o/plugins", plugins: [] });

  hub.onClientMessage(client, { type: "plugin.catalog.get" });
  await new Promise((r) => setTimeout(r, 50));
  const read = lastCatalog(client.sent);
  assert.equal(read?.plugins[0]?.version, "1.0.0");
  assert.equal(read?.updatedAt, "2026-11-14T09:00:00Z");
  assert.ok(read?.checkedAt);
  assert.deepEqual(gh.calls[0]?.slice(0, 7), ["release", "download", "catalog", "--repo", "o/plugins", "--pattern", "catalog.json"]);

  // Not again within 10 minutes, unless asked to.
  hub.onClientMessage(client, { type: "plugin.catalog.get" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gh.calls.length, 1);
  assets.delete("catalog/catalog.json");
  hub.onClientMessage(client, { type: "plugin.catalog.get", refresh: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gh.calls.length, 2);
  const failed = lastCatalog(client.sent);
  assert.match(failed?.error ?? "", /カタログ（リリース catalog）がまだありません/);
  assert.equal(failed?.plugins[0]?.version, "1.0.0");
  assert.equal(failed?.loading, undefined);

  // After a failure, a browser's ask tries again once a minute has passed.
  assets.set("catalog/catalog.json", Buffer.from("{"));
  hub.onClientMessage(client, { type: "plugin.catalog.get" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gh.calls.length, 2);
  later(61_000);
  hub.onClientMessage(client, { type: "plugin.catalog.get" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gh.calls.length, 3);
  assert.match(lastCatalog(client.sent)?.error ?? "", /JSON/);
});

test("a plugin of the catalog is added, updated and removed from a browser, and each is recorded", async () => {
  const one = release("1.0.0");
  const assets = new Map([
    ["catalog/catalog.json", catalogJson([one.entry])],
    ["hello-v1.0.0/hello-1.0.0.tgz", one.file],
  ]);
  const { dir, client, hub, catalog, store, result } = await setup(assets);
  await catalog.read(0);

  hub.onClientMessage(client, { type: "plugin.install", requestId: "i1", plugin: "hello", machines: ["m1"] });
  assert.deepEqual(await result("i1"), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "hello", "gasho-plugin.json"), "utf8")).version, "1.0.0");
  const installed = lastPlugins(client.sent)?.find((p) => p.id === "hello");
  assert.equal(installed?.manifest.version, "1.0.0");
  assert.equal(installed?.enabled, true);
  assert.deepEqual(installed?.machines, ["m1"]);
  assert.ok(store.recentEvents().some((e) => e.event === "Gasho:plugin.install" && e.summary?.startsWith("Hello 1.0.0")));
  assert.deepEqual(fs.readdirSync(dir), ["hello"]);

  // Twice: it is there already.
  hub.onClientMessage(client, { type: "plugin.install", requestId: "i2", plugin: "hello", machines: "all" });
  assert.match((await result("i2")).error ?? "", /すでに入っています/);

  // Nothing newer to update to; then a newer version, whose file does not match the catalog; then one that does.
  hub.onClientMessage(client, { type: "plugin.update", requestId: "u1", plugin: "hello" });
  assert.match((await result("u1")).error ?? "", /新しい版はありません/);
  const two = release("1.1.0");
  assets.set("catalog/catalog.json", catalogJson([{ ...two.entry, sha256: "0".repeat(64) }]));
  assets.set("hello-v1.1.0/hello-1.1.0.tgz", two.file);
  await catalog.read(0);
  hub.onClientMessage(client, { type: "plugin.update", requestId: "u2", plugin: "hello" });
  assert.match((await result("u2")).error ?? "", /SHA-256/);
  assert.equal(lastPlugins(client.sent)?.find((p) => p.id === "hello")?.manifest.version, "1.0.0");
  store.setPluginSetting("hello", "interval", 30);
  assets.set("catalog/catalog.json", catalogJson([two.entry]));
  await catalog.read(0);
  hub.onClientMessage(client, { type: "plugin.update", requestId: "u3", plugin: "hello" });
  assert.deepEqual(await result("u3"), { ok: true });
  const updated = lastPlugins(client.sent)?.find((p) => p.id === "hello");
  assert.equal(updated?.manifest.version, "1.1.0");
  // What was chosen for it stays.
  assert.deepEqual(updated?.machines, ["m1"]);
  assert.deepEqual(updated?.values, { interval: 30 });
  assert.ok(store.recentEvents().some((e) => e.event === "Gasho:plugin.update" && e.summary?.startsWith("Hello 1.0.0 → 1.1.0")));
  assert.deepEqual(fs.readdirSync(dir), ["hello"]);

  hub.onClientMessage(client, { type: "plugin.remove", requestId: "r1", plugin: "hello" });
  assert.deepEqual(await result("r1"), { ok: true });
  assert.equal(fs.existsSync(path.join(dir, "hello")), false);
  assert.equal(lastPlugins(client.sent)?.length, 0);
  assert.equal(store.pluginState("hello"), undefined);
  assert.deepEqual(store.pluginSettings("hello"), {});
  assert.ok(store.recentEvents().some((e) => e.event === "Gasho:plugin.remove" && e.summary?.startsWith("Hello")));
  hub.onClientMessage(client, { type: "plugin.remove", requestId: "r2", plugin: "hello" });
  assert.match((await result("r2")).error ?? "", /入っていません/);
});

test("a release that is not what the catalog says, or needs a newer plugin API, is not added", async () => {
  const wrongId = tgz(entry("gasho-plugin.json", JSON.stringify({ ...manifest("1.0.0"), id: "other" })), entry("web.js", "x"), entry("daemon.js", "x"));
  const newApi = release("1.0.0", { api: "1.99" });
  const assets = new Map([["hello-v1.0.0/hello-1.0.0.tgz", wrongId]]);
  const { dir, client, hub, catalog, store, result } = await setup(assets);
  assets.set("catalog/catalog.json", catalogJson([{ ...release("1.0.0").entry, sha256: sha256(wrongId), size: wrongId.length }]));
  await catalog.read(0);
  hub.onClientMessage(client, { type: "plugin.install", requestId: "i1", plugin: "hello", machines: "all" });
  assert.match((await result("i1")).error ?? "", /id（other）/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(store.pluginState("hello"), undefined);

  assets.set("catalog/catalog.json", catalogJson([{ ...newApi.entry, api: "1.99" }]));
  await catalog.read(0);
  hub.onClientMessage(client, { type: "plugin.install", requestId: "i2", plugin: "hello", machines: "all" });
  assert.match((await result("i2")).error ?? "", /API 1\.99/);
  hub.onClientMessage(client, { type: "plugin.install", requestId: "i3", plugin: "nope", machines: "all" });
  assert.match((await result("i3")).error ?? "", /カタログにこのプラグインはありません/);
});

test("a plugin being developed (a link) is not updated from the catalog, and removing it removes only the link", async () => {
  const one = release("1.0.0");
  const two = release("2.0.0");
  const assets = new Map([["catalog/catalog.json", catalogJson([two.entry])]]);
  const { dir, client, hub, catalog, registry, result } = await setup(assets);
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-dev-"));
  const { files } = readTgz(one.file, LIMITS);
  for (const f of files) fs.writeFileSync(path.join(src, f.path), f.data);
  fs.symlinkSync(src, path.join(dir, "hello"));
  await registry.scan();
  await catalog.read(0);
  hub.onClientMessage(client, { type: "plugin.update", requestId: "u1", plugin: "hello" });
  assert.match((await result("u1")).error ?? "", /開発中/);
  hub.onClientMessage(client, { type: "plugin.remove", requestId: "r1", plugin: "hello" });
  assert.deepEqual(await result("r1"), { ok: true });
  assert.equal(fs.existsSync(path.join(dir, "hello")), false);
  assert.ok(fs.existsSync(path.join(src, "gasho-plugin.json")));
});

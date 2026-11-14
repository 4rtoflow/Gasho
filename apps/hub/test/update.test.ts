// Updating gasho-daemon from Gasho, as the Gasho server sees it: what each working server says about it, the update
// command relayed only to one that can take it, and the latest versions looked up on the registry (a fake lookup).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToClient, HubToDaemon } from "@gasho/protocol";
import { Hub, updateInfoOf, validateCommand } from "../src/hub.ts";
import { DAEMON_PACKAGE, LatestCheck } from "../src/latest.ts";
import { Store } from "../src/store.ts";

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

function setup(latest?: LatestCheck) {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store, { latest });
  const c = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.15.0" });
  return { store, hub, c, d, machineId: machine.device.id };
}

const caps = { type: "capabilities" as const, canLaunch: true, folders: [] };

test("what a gasho-daemon says about updating it reaches browsers, kept to what is expected", () => {
  const { hub, c, d, machineId } = setup();
  hub.onDaemonMessage(d, {
    ...caps,
    update: {
      canUpdate: true,
      installed: ["0.14.0", "latest", "0.13.2"],
      previous: "0.14.0",
      progress: { version: "0.16.0", step: "check", at: 5 },
      failed: { version: "../x", error: "e", at: 1 },
    },
  });
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.id === machineId);
  assert.deepEqual(m.machine.update, {
    canUpdate: true,
    reason: undefined,
    command: undefined,
    installed: ["0.14.0", "0.13.2"],
    previous: "0.14.0",
    progress: { version: "0.16.0", step: "check", at: 5 },
    failed: undefined,
  });
  assert.equal(updateInfoOf("yes"), undefined);
  assert.equal(updateInfoOf({ canUpdate: "true" })?.canUpdate, false);
  assert.equal(updateInfoOf({ canUpdate: true, progress: { version: "0.16.0", step: "reboot", at: 5 } })?.progress, undefined);
});

test("the update goes only to a gasho-daemon that can take it, is checked, and is recorded from which version to which", () => {
  const { hub, c, d, machineId } = setup();
  const result = () => {
    const r = c.sent.at(-1);
    assert.ok(r?.type === "command.result");
    return r.result;
  };
  // A gasho-daemon from before updates from Gasho says nothing about them.
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u0", machine: machineId, version: "0.16.0" });
  assert.match(result().error ?? "", /service install/);
  // One that cannot says why.
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: false, reason: "常駐させずに動かしているので", command: "npx x" } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u1", machine: machineId, version: "0.16.0" });
  assert.equal(result().error, "常駐させずに動かしているので");
  assert.equal(d.sent.at(-1)?.type, "welcome");

  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u2", machine: machineId, version: "latest" });
  assert.equal(result().error, "版の指定が正しくありません。");
  assert.equal(validateCommand({ type: "daemon.update", version: "0.16.0; rm -rf ~" }), "版の指定が正しくありません。");

  hub.onClientMessage(c, { type: "daemon.update", requestId: "u3", machine: machineId, version: "0.16.0" });
  const sent = d.sent.at(-1);
  assert.ok(sent?.type === "daemon.update" && sent.version === "0.16.0");
  const event = c.sent.findLast((m) => m.type === "event");
  assert.ok(event?.type === "event");
  assert.equal(event.event.event, "Gasho:daemon.update");
  assert.match(event.event.summary ?? "", /^0\.15\.0 → 0\.16\.0 \(by /);
  hub.onDaemonMessage(d, { type: "command.result", requestId: sent.requestId, result: { ok: true } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "u3", machine: machineId, result: { ok: true } });

  // Its steps come with the capabilities; the restart closes the connection, and the new version's hello ends it.
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true, progress: { version: "0.16.0", step: "restart", at: 9 } } });
  hub.onDaemonClose(d);
  const offline = c.sent.at(-1);
  assert.ok(offline?.type === "machine" && !offline.machine.connected && offline.machine.update?.progress?.step === "restart");
});

test("a new connection of the working server clears what the old one said about an update", () => {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const hub = new Hub(store);
  const c = fakePeer<HubToClient>("b");
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  const hello = (v: string) => ({ type: "hello" as const, machineId: machine.device.id, token: machine.token, daemonVersion: v });
  hub.onDaemonMessage(d, hello("0.15.0"));
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true, progress: { version: "0.16.0", step: "restart", at: 9 } } });
  hub.onDaemonClose(d);
  const next = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(next, hello("0.16.0"));
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.daemonVersion === "0.16.0" && m.machine.update === undefined);
});

test("the latest versions are in the snapshot, looked up again when a browser asks, and kept when a look-up fails", async () => {
  const answers: (string | Error)[] = ["0.16.0", new Error("npm error code E401"), "0.16.1"];
  const asked: string[] = [];
  const latest = new LatestCheck({
    lookup: async (name) => {
      asked.push(name);
      const a = answers.shift();
      if (a instanceof Error || a === undefined) throw a ?? new Error("no more");
      return a;
    },
  });
  await latest.check();
  const { hub, c } = setup(latest);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.equal(snap.latest?.daemon, "0.16.0");
  assert.deepEqual(asked, [DAEMON_PACKAGE]);

  // Just looked up: a browser's "check now" is answered with what is known.
  hub.onClientMessage(c, { type: "latest.check" });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1);
  const known = c.sent.at(-1);
  assert.ok(known?.type === "latest" && known.latest.daemon === "0.16.0");

  // A failed look-up keeps the version known before, and says why.
  await latest.check();
  const failed = latest.latest();
  assert.equal(failed.daemon, "0.16.0");
  assert.match(failed.error ?? "", /最新の版を調べられませんでした：npm error code E401/);
  assert.equal(failed.checking, undefined);
  const steps = c.sent.filter((m) => m.type === "latest").map((m) => (m.type === "latest" ? m.latest.checking === true : false));
  assert.deepEqual(steps, [false, true, false]);

  await latest.check();
  assert.deepEqual(latest.latest().daemon, "0.16.1");
  assert.equal(latest.latest().error, undefined);
});

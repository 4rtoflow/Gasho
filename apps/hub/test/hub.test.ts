import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToClient, HubToDaemon, SessionInfo } from "@gasho/protocol";
import { CLOSE_INVALID_CREDENTIALS, CLOSE_UNAUTHORIZED, Hub } from "../src/hub.ts";
import { notificationFor } from "../src/notify.ts";
import { Store } from "../src/store.ts";

function fakePeer<T>(deviceId = "") {
  const peer = {
    deviceId,
    machineId: undefined as string | undefined,
    sent: [] as T[],
    closed: undefined as [number, string] | undefined,
    send(m: T) {
      peer.sent.push(m);
    },
    close(code: number, reason: string) {
      peer.closed = [code, reason];
    },
  };
  return peer;
}

function setup() {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store);
  return { store, hub, machineId: machine.device.id, machineToken: machine.token, browserId: browser.device.id };
}

const session: SessionInfo = {
  sessionId: "s1",
  cwd: "/home/rg/repos/Bobert",
  title: "プラグインの整理",
  status: "idle",
  rcMode: "server",
  prLinks: [],
};

test("a daemon with a wrong token, or with a browser's id, is closed", () => {
  const { hub, machineId, browserId, store } = setup();
  const browserToken = store.createDevice("browser", "x").token;
  const d1 = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d1, { type: "hello", machineId, token: "wrong", daemonVersion: "0.1.0" });
  assert.equal(d1.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  const d2 = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d2, { type: "hello", machineId: browserId, token: browserToken, daemonVersion: "0.1.0" });
  assert.equal(d2.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  assert.equal(d1.sent.length + d2.sent.length, 0);
});

test("sessions and hooks reach the browser, and Stop becomes a notification", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(c.sent[0]?.type, "snapshot");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  assert.deepEqual(d.sent, [{ type: "welcome" }]);
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event: "Stop", at: 1000, summary: "終わりました" } });

  assert.deepEqual(
    c.sent.map((m) => m.type),
    ["snapshot", "machine", "machine", "event", "notification"],
  );
  const first = c.sent[1];
  assert.ok(first?.type === "machine");
  assert.equal(first.machine.id, machineId);
  assert.equal(first.machine.name, "ubuntu");
  const n = c.sent.at(-1);
  assert.ok(n?.type === "notification");
  assert.equal(n.notification.title, "プラグインの整理 の応答が終わりました");
  assert.equal(n.notification.machine, machineId);

  hub.onDaemonClose(d);
  const last = c.sent.at(-1);
  assert.ok(last?.type === "machine" && last.machine.connected === false);
});

test("transcript.get is relayed to the daemon and the page goes back to the asking browser", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const asking = fakePeer<HubToClient>(browserId);
  const other = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  hub.onClientMessage(asking, { type: "transcript.get", machine: machineId, sessionId: "s1", limit: 50 });
  const req = d.sent.at(-1);
  assert.ok(req?.type === "transcript.get");
  hub.onDaemonMessage(d, {
    type: "transcript.page",
    requestId: req.requestId,
    sessionId: "s1",
    entries: [{ uuid: "u1", role: "user", blocks: [{ type: "text", text: "hi" }] }],
    start: 0,
    total: 1,
  });
  const page = asking.sent.at(-1);
  assert.ok(page?.type === "transcript.page");
  assert.equal(page.machine, machineId);
  assert.equal(page.entries.length, 1);
  assert.ok(!other.sent.some((m) => m.type === "transcript.page"));
});

test("transcript.get for an offline machine answers with an error", () => {
  const { hub, machineId, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "transcript.get", machine: machineId, sessionId: "s1", limit: 50 });
  const page = c.sent.at(-1);
  assert.ok(page?.type === "transcript.page");
  assert.equal(page.error, "machine is offline");
});

test("revoking a machine disconnects it and removes it from browsers", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(hub.revokeDevice(machineId), true);
  assert.equal(d.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  assert.deepEqual(c.sent.at(-1), { type: "machine.removed", id: machineId });
  assert.equal(hub.revokeDevice(machineId), false);
});

test("renaming a machine is broadcast", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  hub.onDaemonMessage(fakePeer<HubToDaemon>(), { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(hub.renameDevice(machineId, "Ubuntu Server"), true);
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.name === "Ubuntu Server");
});

test("browsers revoked from the command line are disconnected by checkRevocations", () => {
  const { hub, store, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  store.revokeDevice(browserId); // what `cli.ts revoke` does in another process
  hub.checkRevocations();
  assert.equal(c.closed?.[0], CLOSE_UNAUTHORIZED);
});

test("machines are restored from the store as disconnected; revoked ones are not", () => {
  const store = new Store(":memory:");
  const keep = store.createDevice("machine", "ubuntu").device;
  const gone = store.createDevice("machine", "old-mac").device;
  store.saveMachine({ id: keep.id, name: "ubuntu", connected: true, lastSeen: 5, sessions: [session] });
  store.revokeDevice(gone.id);
  const hub = new Hub(store);
  const c = fakePeer<HubToClient>("b");
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.deepEqual(
    snap.machines.map((m) => [m.name, m.connected]),
    [["ubuntu", false]],
  );
  assert.equal(snap.machines[0]?.sessions[0]?.title, "プラグインの整理");
});

test("notificationFor covers permission, idle and errors, and ignores other events", () => {
  const ev = { sessionId: "s1", at: 1 };
  assert.equal(
    notificationFor("m", { ...ev, event: "Notification", notificationType: "permission_prompt" }, session, "1")?.kind,
    "permission",
  );
  assert.equal(notificationFor("m", { ...ev, event: "Notification", notificationType: "idle_prompt" }, session, "2")?.kind, "idle");
  assert.equal(notificationFor("m", { ...ev, event: "StopFailure" }, session, "3")?.kind, "error");
  assert.equal(notificationFor("m", { ...ev, event: "PreToolUse" }, session, "4"), null);
  assert.equal(notificationFor("m", { ...ev, event: "Stop" }, undefined, "5")?.title, "s1 の応答が終わりました");
});

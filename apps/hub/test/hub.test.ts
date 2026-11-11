import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToClient, HubToDaemon, SessionInfo } from "@gasho/protocol";
import { Hub } from "../src/hub.ts";
import { notificationFor } from "../src/notify.ts";
import { Store } from "../src/store.ts";

function fakePeer<T>() {
  const peer = {
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

const session: SessionInfo = {
  sessionId: "s1",
  cwd: "/home/rg/repos/Bobert",
  title: "プラグインの整理",
  status: "idle",
  rcMode: "server",
  prLinks: [],
};

test("a daemon with a wrong token is closed", () => {
  const hub = new Hub(new Store(":memory:"), "t0ken");
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machine: "rg", token: "wrong", daemonVersion: "0.1.0" });
  assert.deepEqual(d.closed, [4001, "invalid token"]);
  assert.equal(d.sent.length, 0);
});

test("sessions and hooks reach the browser, and Stop becomes a notification", () => {
  const hub = new Hub(new Store(":memory:"), "t0ken");
  const c = fakePeer<HubToClient>();
  hub.onClientConnect(c);
  assert.equal(c.sent[0]?.type, "snapshot");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machine: "rg", token: "t0ken", daemonVersion: "0.1.0" });
  assert.deepEqual(d.sent, [{ type: "welcome" }]);
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  hub.onDaemonMessage(d, {
    type: "hook",
    event: { sessionId: "s1", event: "Stop", at: 1000, summary: "終わりました" },
  });

  const types = c.sent.map((m) => m.type);
  assert.deepEqual(types, ["snapshot", "machine", "machine", "event", "notification"]);
  const n = c.sent.at(-1);
  assert.ok(n?.type === "notification");
  assert.equal(n.notification.title, "プラグインの整理 の応答が終わりました");
  assert.equal(n.notification.machine, "rg");

  hub.onDaemonClose(d);
  const last = c.sent.at(-1);
  assert.ok(last?.type === "machine" && last.machine.connected === false);
});

test("transcript.get is relayed to the daemon and the page goes back to the asking browser", () => {
  const hub = new Hub(new Store(":memory:"), "t0ken");
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machine: "rg", token: "t0ken", daemonVersion: "0.1.0" });
  const asking = fakePeer<HubToClient>();
  const other = fakePeer<HubToClient>();
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  hub.onClientMessage(asking, { type: "transcript.get", machine: "rg", sessionId: "s1", limit: 50 });
  const req = d.sent.at(-1);
  assert.ok(req?.type === "transcript.get");
  assert.equal(req.limit, 50);
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
  assert.equal(page.machine, "rg");
  assert.equal(page.entries.length, 1);
  assert.ok(!other.sent.some((m) => m.type === "transcript.page"));
});

test("transcript.get for an offline machine answers with an error", () => {
  const hub = new Hub(new Store(":memory:"), "t0ken");
  const c = fakePeer<HubToClient>();
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "transcript.get", machine: "mac", sessionId: "s1", limit: 50 });
  const page = c.sent.at(-1);
  assert.ok(page?.type === "transcript.page");
  assert.equal(page.error, "machine is offline");
});

test("machines are restored from the store as disconnected", () => {
  const store = new Store(":memory:");
  store.saveMachine({ name: "rg", connected: true, lastSeen: 5, sessions: [session] });
  const hub = new Hub(store, "t0ken");
  const c = fakePeer<HubToClient>();
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.equal(snap.machines[0]?.connected, false);
  assert.equal(snap.machines[0]?.sessions[0]?.title, "プラグインの整理");
});

test("notificationFor covers permission, idle and errors, and ignores other events", () => {
  const ev = { sessionId: "s1", at: 1 };
  assert.equal(
    notificationFor("rg", { ...ev, event: "Notification", notificationType: "permission_prompt" }, session, "1")?.kind,
    "permission",
  );
  assert.equal(
    notificationFor("rg", { ...ev, event: "Notification", notificationType: "idle_prompt" }, session, "2")?.kind,
    "idle",
  );
  assert.equal(notificationFor("rg", { ...ev, event: "StopFailure" }, session, "3")?.kind, "error");
  assert.equal(notificationFor("rg", { ...ev, event: "PreToolUse" }, session, "4"), null);
  assert.equal(notificationFor("rg", { ...ev, event: "Stop" }, undefined, "5")?.title, "s1 の応答が終わりました");
});

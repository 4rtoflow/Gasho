import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { sessionsByLastUse } from "../src/lib/sessions.ts";

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/repo",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});
const machine = (id: string, sessions: SessionInfo[]): MachineInfo => ({ id, name: id, connected: true, lastSeen: 0, sessions });

test("the sessions of all working servers make one list, the one used last first", () => {
  const list = sessionsByLastUse([
    machine("mac", [session("a", { lastActivityAt: 300 }), session("b", { lastActivityAt: 100 })]),
    machine("ubuntu", [session("c", { lastActivityAt: 200 }), session("d", { lastActivityAt: 400 })]),
  ]);
  assert.deepEqual(
    list.map((x) => `${x.machine.id}/${x.session.sessionId}`),
    ["ubuntu/d", "mac/a", "ubuntu/c", "mac/b"],
  );
});

test("a session with no conversation yet counts from when it started; sessions Gasho did not start are left out", () => {
  const list = sessionsByLastUse([
    machine("mac", [session("old", { lastActivityAt: 100 }), session("new", { startedAt: 500 }), session("rc", { lastActivityAt: 900, managed: undefined })]),
  ]);
  assert.deepEqual(
    list.map((x) => x.session.sessionId),
    ["new", "old"],
  );
});

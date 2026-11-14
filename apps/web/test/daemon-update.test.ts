import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo } from "@gasho/protocol";
import { changesUrl, compareVersions, newerPublished, pendingWork, updateTo } from "../src/lib/daemon-update.ts";

const machine = (o: Partial<MachineInfo>): MachineInfo => ({ id: "m", name: "ubuntu", connected: true, lastSeen: 0, sessions: [], ...o });

test("versions compare part by part, as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.15.0", "0.15.0"), 0);
  assert.equal(compareVersions("0.14.2", "0.15.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("an update is offered only for a newer version, to a connected gasho-daemon that can take it and is not updating", () => {
  const latest = { daemon: "0.16.0", checkedAt: 1 };
  const can = { canUpdate: true };
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can }), latest), "0.16.0");
  assert.equal(updateTo(machine({ daemonVersion: "0.16.0", update: can }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.17.0", update: can }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can, connected: false }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: { canUpdate: false } }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.14.0" }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: { canUpdate: true, progress: { version: "0.16.0", step: "check", at: 1 } } }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can }), undefined), undefined);
  // Published, but not updatable from Gasho: the row still says so.
  assert.ok(newerPublished(machine({ daemonVersion: "0.14.0" }), latest));
  assert.ok(!newerPublished(machine({ daemonVersion: "0.16.0" }), latest));
});

test("the inputs to send and the permission requests an update would affect are counted; questions read from the screen are not", () => {
  const s = { cwd: "/r", status: "idle" as const, rcMode: "server", prLinks: [] };
  const m = machine({
    sessions: [
      { ...s, sessionId: "a", pendingInputs: 2, permissionRequests: [{ id: "p1", toolName: "Bash", at: 1 }] },
      { ...s, sessionId: "b", permissionRequests: [{ id: "question:1", toolName: "AskUserQuestion", at: 1 }] },
    ],
  } as Partial<MachineInfo>);
  assert.deepEqual(pendingWork(m), { inputs: 2, requests: 1 });
  assert.equal(changesUrl("0.15.0", "0.16.0"), "https://github.com/4rtoflow/Gasho/compare/daemon-v0.15.0...daemon-v0.16.0");
});

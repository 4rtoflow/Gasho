import assert from "node:assert/strict";
import { test } from "node:test";
import { hrefOf, parseHash, type Route } from "../src/lib/route.ts";

test("routes survive a round trip through the URL, including a session's panel and a repository path with slashes", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "devices" },
    { name: "session", machine: "m1", sessionId: "s/1" },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "graph" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "graph", repo: "org/web app" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "issues" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "pulls", repo: "api" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "issues", number: 42 } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "pulls", repo: "org/web app", number: 7 } },
  ];
  for (const r of routes) assert.deepEqual(parseHash(hrefOf(r)), r);
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "graph", repo: "org/web" } }), "#/s/m/s/graph/org%2Fweb");
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "pulls" } }), "#/s/m/s/pulls");
  assert.deepEqual(parseHash("#/s/m/s/graph/a/b"), { name: "home" });
  assert.deepEqual(parseHash("#/s/m/s/wiki"), { name: "home" });
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "issues", number: 42 } }), "#/s/m/s/issue/42");
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "pulls", repo: "api", number: 7 } }), "#/s/m/s/pull/7/api");
  // Numbers are positive whole numbers.
  assert.deepEqual(parseHash("#/s/m/s/issue/0"), { name: "home" });
  assert.deepEqual(parseHash("#/s/m/s/pull/1e3"), { name: "home" });
});

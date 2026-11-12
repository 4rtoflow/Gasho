import assert from "node:assert/strict";
import { test } from "node:test";
import { hrefOf, parseHash } from "../src/lib/route.ts";

test("routes survive a round trip through the URL, including a repository path with slashes", () => {
  const routes = [
    { name: "home" },
    { name: "devices" },
    { name: "session", machine: "m1", sessionId: "s/1" },
    { name: "graph", machine: "m1", sessionId: "s1" },
    { name: "graph", machine: "m1", sessionId: "s1", repo: "org/web app" },
  ] as const;
  for (const r of routes) assert.deepEqual(parseHash(hrefOf(r)), r);
  assert.equal(hrefOf({ name: "graph", machine: "m", sessionId: "s", repo: "org/web" }), "#/s/m/s/graph/org%2Fweb");
  assert.deepEqual(parseHash("#/s/m/s/graph/a/b"), { name: "home" });
});

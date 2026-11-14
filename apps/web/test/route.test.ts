import assert from "node:assert/strict";
import { test } from "node:test";
import { hrefOf, isOldGitHubLink, parseHash, type Route } from "../src/lib/route.ts";

test("routes survive a round trip through the URL, including a session's panel and a repository path with slashes", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "devices" },
    { name: "settings" },
    { name: "session", machine: "m1", sessionId: "s/1" },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "graph" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "graph", repo: "org/web app" } },
    { name: "worktree", machine: "m1", path: "/Users/me/Gasho issue/a" },
  ];
  for (const r of routes) assert.deepEqual(parseHash(hrefOf(r)), r);
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "graph", repo: "org/web" } }), "#/s/m/s/graph/org%2Fweb");
  assert.deepEqual(parseHash("#/s/m/s/graph/a/b"), { name: "home" });
  assert.deepEqual(parseHash("#/s/m/s/wiki"), { name: "home" });
});

test("plugins' pages, panels and worktree screens keep their params in the query, sorted, and a bad plugin id goes home", () => {
  const routes: Route[] = [
    { name: "plugins" },
    { name: "plugin", plugin: "kanban", page: "board", params: {} },
    { name: "plugin", plugin: "kanban", page: "board", params: { view: "すべて", q: "a&b=c" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "plugin", plugin: "github", id: "list", params: { kind: "pulls" } } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "plugin", plugin: "github", id: "item", params: { kind: "issues", number: "42", repo: "org/web app" } } },
    { name: "worktree", machine: "m1", path: "/Users/me/Gasho issue/a?b", view: { plugin: "github-allmighty", id: "issue", params: { number: "17" } } },
    { name: "worktree", machine: "m1", path: "/src/app", view: { plugin: "kanban", id: "board", params: {} } },
  ];
  for (const r of routes) assert.deepEqual(parseHash(hrefOf(r)), r);
  assert.equal(hrefOf({ name: "plugin", plugin: "kanban", page: "board", params: { b: "2", a: "1" } }), "#/p/kanban/board?a=1&b=2");
  assert.equal(
    hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "plugin", plugin: "github", id: "list", params: { kind: "issues" } } }),
    "#/s/m/s/p/github/list?kind=issues",
  );
  assert.equal(
    hrefOf({ name: "worktree", machine: "m", path: "/src/app", view: { plugin: "gh", id: "issue", params: { number: "17" } } }),
    "#/w/m/%2Fsrc%2Fapp/p/gh/issue?number=17",
  );
  for (const bad of ["#/p/GitHub/list", "#/p/x/list", "#/p/a_b/list", "#/s/m/s/p/Kanban/board", "#/s/m/s/p/x/board", "#/w/m/%2Fa/p/Gh/issue", "#/w/m/%2Fa/p/gh"]) {
    assert.deepEqual(parseHash(bad), { name: "home" }, bad);
  }
});

test("links to Gasho's own issues and pull requests, from before the GitHub plugin, open the plugin's panels", () => {
  const panel = (id: string, params: Record<string, string>): Route => ({
    name: "session",
    machine: "m",
    sessionId: "s",
    panel: { kind: "plugin", plugin: "github", id, params },
  });
  assert.deepEqual(parseHash("#/s/m/s/issues"), panel("list", { kind: "issues" }));
  assert.deepEqual(parseHash("#/s/m/s/pulls/api"), panel("list", { kind: "pulls", repo: "api" }));
  assert.deepEqual(parseHash("#/s/m/s/issue/42"), panel("item", { kind: "issues", number: "42" }));
  assert.deepEqual(parseHash("#/s/m/s/pull/7/org%2Fweb%20app"), panel("item", { kind: "pulls", number: "7", repo: "org/web app" }));
  // Numbers are positive whole numbers.
  assert.deepEqual(parseHash("#/s/m/s/issue/0"), { name: "home" });
  assert.deepEqual(parseHash("#/s/m/s/pull/1e3"), { name: "home" });
  // Such a link is told apart, so the address bar can get the plugin panel's URL instead.
  for (const old of ["#/s/m/s/issues", "#/s/m/s/pulls/api", "#/s/m/s/issue/42", "#/s/m/s/pull/7/api"]) assert.equal(isOldGitHubLink(old), true, old);
  for (const now of ["#/s/m/s", "#/s/m/s/graph", "#/s/m/s/p/github/list?kind=pulls", "#/s/m/s/files/issues", "#/"]) assert.equal(isOldGitHubLink(now), false, now);
});

test("the files panel keeps a folder's or a file's path in the URL, slashes and all, and refuses paths that leave the folder", () => {
  const routes: Route[] = [
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "files" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "files", path: "apps/web" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "file", path: "apps/web/src/App.tsx" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "file", path: "メモ/今日 の#予定?.md" } },
    { name: "session", machine: "m1", sessionId: "s1", panel: { kind: "file", path: ".claude/settings.json" } },
  ];
  for (const r of routes) assert.deepEqual(parseHash(hrefOf(r)), r);
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "files" } }), "#/s/m/s/files");
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "files", path: "" } }), "#/s/m/s/files");
  assert.equal(hrefOf({ name: "session", machine: "m", sessionId: "s", panel: { kind: "file", path: "src/a b.ts" } }), "#/s/m/s/file/src/a%20b.ts");
  for (const bad of ["#/s/m/s/file", "#/s/m/s/file/", "#/s/m/s/files/../x", "#/s/m/s/file/a//b", "#/s/m/s/file/a/./b", "#/s/m/s/file/%E0%A4%A", "#/s/m/s/file/a%2F..%2Fb"]) {
    assert.deepEqual(parseHash(bad), { name: "home" }, bad);
  }
  // An encoded slash is just another way of writing the path.
  assert.deepEqual(parseHash("#/s/m/s/file/src%2Fapp.ts"), { name: "session", machine: "m", sessionId: "s", panel: { kind: "file", path: "src/app.ts" } });
});

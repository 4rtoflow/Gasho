import assert from "node:assert/strict";
import { test } from "node:test";
import { ghError, parseGhItems } from "../src/github.ts";

test("gh's issue and pull request lists are read, and anything odd is left out", () => {
  const json = JSON.stringify([
    {
      number: 12,
      title: "ブランチグラフが崩れる",
      url: "https://github.com/4rtoflow/Gasho/pull/12",
      author: { login: "ama", is_bot: false },
      createdAt: "2026-11-01T10:00:00Z",
      updatedAt: "2026-11-02T10:00:00Z",
      labels: [{ id: "x", name: "bug", color: "d73a4a" }, { name: "odd", color: "red;" }, null],
      isDraft: true,
      headRefName: "fix/graph",
      baseRefName: "main",
      reviewDecision: "CHANGES_REQUESTED",
    },
    { number: 13, title: "no url" },
    { number: 14, title: "elsewhere", url: "javascript:alert(1)" },
    { number: 15, title: "plain", url: "https://github.com/4rtoflow/Gasho/issues/15", author: null, labels: null, reviewDecision: "" },
  ]);
  assert.deepEqual(parseGhItems(json, "pulls"), [
    {
      number: 12,
      title: "ブランチグラフが崩れる",
      url: "https://github.com/4rtoflow/Gasho/pull/12",
      author: "ama",
      createdAt: "2026-11-01T10:00:00Z",
      updatedAt: "2026-11-02T10:00:00Z",
      labels: [{ name: "bug", color: "d73a4a" }, { name: "odd" }],
      draft: true,
      head: "fix/graph",
      base: "main",
      review: "changes_requested",
    },
    { number: 15, title: "plain", url: "https://github.com/4rtoflow/Gasho/issues/15", createdAt: "", updatedAt: "", labels: [] },
  ]);
  // Issues carry no pull request fields.
  assert.equal(parseGhItems(json, "issues")[0]?.draft, undefined);
  assert.deepEqual(parseGhItems("{}", "issues"), []);
});

test("a failed gh call is explained", () => {
  assert.match(ghError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })), /GitHub CLI（gh）がありません/);
  assert.match(ghError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }), /ログインしていません/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a Repository with the name 'x/y'." }), /権限がないか/);
  assert.match(ghError({ killed: true }), /応答が遅く/);
  assert.match(ghError({ message: "Command failed: gh issue list\nsomething else happened" }), /something else happened/);
});

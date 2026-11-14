import assert from "node:assert/strict";
import { test } from "node:test";
import { ghError } from "../src/github.ts";

test("a failed gh call is explained", () => {
  assert.match(ghError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })), /GitHub CLI（gh）がありません/);
  assert.match(ghError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }), /ログインしていません/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a Repository with the name 'x/y'." }), /権限がないか/);
  assert.match(ghError({ killed: true }), /応答が遅く/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)" }), /この番号の/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)" }), /この番号の/);
  assert.match(ghError({ message: "Command failed: gh issue list\nsomething else happened" }), /something else happened/);
});

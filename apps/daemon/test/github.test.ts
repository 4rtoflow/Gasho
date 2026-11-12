import assert from "node:assert/strict";
import { test } from "node:test";
import { checkState, ghError, parseGhItemDetail, parseGhItems } from "../src/github.ts";

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
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)" }), /この番号の/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)" }), /この番号の/);
  assert.match(ghError({ message: "Command failed: gh issue list\nsomething else happened" }), /something else happened/);
});

test("one pull request is read with its reviews, changes and checks", () => {
  const json = JSON.stringify({
    number: 7,
    title: "Use REST",
    url: "https://github.com/o/r/pull/7",
    state: "MERGED",
    author: { login: "ama" },
    createdAt: "2026-11-01T10:00:00Z",
    updatedAt: "2026-11-02T10:00:00Z",
    closedAt: "2026-11-02T10:00:00Z",
    mergedAt: "2026-11-02T10:00:00Z",
    labels: [],
    assignees: [{ login: "kyota" }, { name: "no login" }],
    body: "本文 **太字**",
    isDraft: false,
    headRefName: "feat/x",
    baseRefName: "main",
    reviewDecision: "APPROVED",
    additions: 19,
    deletions: 16,
    changedFiles: 2,
    files: [{ path: "a.ts", additions: 7, deletions: 7, changeType: "MODIFIED" }, { additions: 1 }],
    commits: [{ oid: "1" }, { oid: "2" }],
    comments: [
      { author: { login: "bot" }, body: "spam", createdAt: "2026-11-01T11:00:00Z", isMinimized: true, url: "https://github.com/o/r/pull/7#c1" },
      { author: { login: "ama" }, body: "試しました", createdAt: "2026-11-01T12:00:00Z", url: "javascript:alert(1)" },
    ],
    reviews: [
      { author: { login: "kyota" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-11-02T09:00:00Z" },
      { author: { login: "kyota" }, body: "", state: "COMMENTED", submittedAt: "2026-11-02T09:30:00Z" },
    ],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/1" },
      { __typename: "CheckRun", name: "lint", workflowName: "lint", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", context: "deploy", state: "ERROR", targetUrl: "http://example.com" },
    ],
  });
  const item = parseGhItemDetail(json, "pulls");
  assert.ok(item);
  assert.equal(item.state, "merged");
  assert.equal(item.review, "approved");
  assert.deepEqual(item.assignees, ["kyota"]);
  assert.deepEqual(item.comments, [
    { author: "bot", createdAt: "2026-11-01T11:00:00Z", body: "", url: "https://github.com/o/r/pull/7#c1", minimized: true },
    { author: "ama", createdAt: "2026-11-01T12:00:00Z", body: "試しました" },
  ]);
  assert.deepEqual(item.reviews, [{ author: "kyota", submittedAt: "2026-11-02T09:00:00Z", state: "approved", body: "LGTM" }]);
  assert.deepEqual(item.files, [{ path: "a.ts", additions: 7, deletions: 7 }]);
  assert.equal(item.commits, 2);
  assert.deepEqual([item.additions, item.deletions, item.changedFiles], [19, 16, 2]);
  assert.deepEqual(item.checks, [
    { name: "CI / build", state: "success", url: "https://github.com/o/r/actions/runs/1" },
    { name: "lint", state: "pending" },
    { name: "deploy", state: "failure" },
  ]);
});

test("one issue is read; a closed one says how, long text is cut, and only the latest comments are kept", () => {
  const comments = Array.from({ length: 205 }, (_, i) => ({ author: { login: "u" }, body: `c${i}`, createdAt: `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}Z` }));
  const json = JSON.stringify({
    number: 3,
    title: "落ちる",
    url: "https://github.com/o/r/issues/3",
    state: "CLOSED",
    stateReason: "NOT_PLANNED",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    labels: [{ name: "bug", color: "d73a4a" }],
    assignees: [],
    body: "x".repeat(70_000),
    comments,
  });
  const item = parseGhItemDetail(json, "issues");
  assert.ok(item);
  assert.equal(item.state, "closed");
  assert.equal(item.stateReason, "not_planned");
  assert.ok(item.body.length < 61_000 && item.body.includes("GitHub で読んでください"));
  assert.equal(item.comments.length, 200);
  assert.equal(item.comments[0]?.body, "c5");
  assert.equal(item.commentsLeftOut, 5);
  assert.equal(item.reviews, undefined);
  assert.equal(parseGhItemDetail("null", "issues"), undefined);
  assert.equal(parseGhItemDetail(JSON.stringify({ number: 1, title: "t", url: "https://evil.example/x" }), "issues"), undefined);
});

test("checks are summed up by their result", () => {
  assert.equal(checkState({ status: "COMPLETED", conclusion: "TIMED_OUT" }), "failure");
  assert.equal(checkState({ status: "COMPLETED", conclusion: "SKIPPED" }), "skipped");
  assert.equal(checkState({ status: "COMPLETED", conclusion: "CANCELLED" }), "cancelled");
  assert.equal(checkState({ status: "QUEUED" }), "pending");
  assert.equal(checkState({ state: "SUCCESS" }), "success");
  assert.equal(checkState({ state: "EXPECTED" }), "pending");
});

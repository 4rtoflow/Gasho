import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignSessions,
  cardsOf,
  failedChecks,
  judge,
  parseWorktrees,
  settle,
  type GhCheck,
  type GhPr,
  type GhReview,
  type RepoMaterial,
  type SessionLike,
} from "../src/kanban.ts";

const ME = "me";

const pr = (over: Partial<GhPr> = {}): GhPr => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  headRefName: "feat/1-x",
  headRefOid: "h1",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviews: [],
  statusCheckRollup: [],
  ...over,
});
const run = (name: string, conclusion: string | null, id: number, status = "COMPLETED"): GhCheck => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status,
  conclusion,
  detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1`,
});
const review = (who: string, state: string, oid = "h1", at = "2026-01-01T00:00:00Z"): GhReview => ({
  author: { login: who },
  state,
  commit: { oid },
  submittedAt: at,
});
const session = (status: SessionLike["status"], cwd = "/r/wt", over: Partial<SessionLike> = {}): SessionLike => ({ sessionId: `s-${status}`, cwd, status, ...over });
const column = (p: GhPr | undefined, sessions: SessionLike[] = []) => judge(p, undefined, ME, sessions).column;

test("the rules go in the Dashboard's order: what only I can move before CI running, CI before the draft and the review", () => {
  assert.equal(column(undefined), "mine");
  assert.deepEqual(judge(undefined, { number: 3, headRefName: "x", state: "MERGED", title: "", url: "" }, ME), {
    column: "done",
    reason: { kind: "merged", pr: 3 },
  });
  const running = [run("a", null, 1, "IN_PROGRESS")];
  assert.equal(column(pr({ mergeable: "CONFLICTING", statusCheckRollup: running })), "mine");
  assert.equal(column(pr({ statusCheckRollup: [...running, run("b", "FAILURE", 1)] })), "mine");
  assert.equal(column(pr({ statusCheckRollup: running })), "github");
  // A draft waits for its CI first, then it is mine to make ready.
  assert.equal(column(pr({ isDraft: true, statusCheckRollup: running })), "github");
  assert.equal(column(pr({ isDraft: true })), "mine");
  // Changes asked on the current head are mine; after a push, the reviewer's again.
  assert.deepEqual(judge(pr({ reviews: [review("ama", "CHANGES_REQUESTED")] }), undefined, ME).reason, { kind: "changes_requested", who: ["ama"] });
  assert.deepEqual(judge(pr({ reviews: [review("ama", "CHANGES_REQUESTED", "h0")] }), undefined, ME).reason, { kind: "rereview", who: ["ama"] });
  // Approved is mine to merge, unless someone else still asks for changes.
  assert.equal(column(pr({ reviews: [review("ama", "APPROVED")] })), "mine");
  assert.equal(column(pr({ reviews: [review("ama", "APPROVED"), review("bob", "CHANGES_REQUESTED", "h0")] })), "review");
  assert.equal(column(pr()), "review");
});

test("only the latest review of each person and the latest run of each check count; mine and comments do not", () => {
  assert.equal(column(pr({ reviews: [review("ama", "CHANGES_REQUESTED", "h1", "2026-01-01"), review("ama", "APPROVED", "h1", "2026-01-02")] })), "mine");
  assert.equal(column(pr({ reviews: [review(ME, "CHANGES_REQUESTED"), review("ama", "COMMENTED")] })), "review");
  // A re-run that passed is not a failure, even when gh lists the failed run after it.
  assert.deepEqual(failedChecks(pr({ statusCheckRollup: [run("test", "SUCCESS", 20), run("test", "FAILURE", 10)] })), []);
  assert.deepEqual(failedChecks(pr({ statusCheckRollup: [{ __typename: "StatusContext", context: "ci/x", state: "ERROR" }] })), ["status/ci/x"]);
});

test("a session awaiting an answer comes first even after a merge; a working one before the pull request; an idle one leaves it", () => {
  const merged = { number: 3, headRefName: "x", state: "MERGED", title: "", url: "" };
  assert.deepEqual(judge(undefined, merged, ME, [session("busy"), session("waiting", "/r/wt", { waitingFor: "permission prompt" })]), {
    column: "mine",
    reason: { kind: "agent_waiting", waitingFor: "permission prompt" },
  });
  assert.equal(column(pr({ mergeable: "CONFLICTING" }), [session("busy")]), "agent");
  assert.equal(column(pr({ mergeable: "CONFLICTING" }), [session("idle")]), "mine");
});

test("mergeable stays as it was while GitHub computes it again, and closed pull requests are forgotten", () => {
  const memory = new Map<number, string>();
  settle([pr({ mergeable: "CONFLICTING" })], memory);
  assert.equal(settle([pr({ mergeable: "UNKNOWN" })], memory)[0]?.mergeable, "CONFLICTING");
  settle([], memory);
  assert.equal(memory.size, 0);
});

test("cards: a worktree without a pull request, a pull request without a worktree, and the primary checkout only when needed", () => {
  const m: RepoMaterial = {
    repo: "o/r",
    me: ME,
    primary: { path: "/r/main", branch: "main" },
    worktrees: new Map([
      ["feat/2-a", "/r/wt-a"],
      ["feat/3-b", "/r/wt-b"],
    ]),
    prs: [pr({ number: 9, headRefName: "feat/9-c", title: "C", updatedAt: "2026-01-01T00:00:00Z" })],
    closed: new Map([["feat/3-b", { number: 4, headRefName: "feat/3-b", state: "CLOSED", title: "B", url: "https://github.com/o/r/pull/4" }]]),
  };
  const cards = cardsOf(m, new Map());
  assert.deepEqual(
    cards.map((c) => [c.label, c.column, c.reason.kind, c.issue, c.pr?.state]),
    [
      ["wt-a", "mine", "no_pr", 2, undefined],
      ["wt-b", "done", "closed", 3, "closed"],
      ["PR #9", "review", "review_waiting", 9, "open"],
    ],
  );
  const busy = cardsOf(m, new Map([["/r/main", [session("busy", "/r/main", { managed: true })]]]));
  assert.deepEqual(busy.find((c) => c.primary)?.sessions, [{ sessionId: "s-busy", status: "busy", managed: true }]);
});

test("sessions go to the deepest worktree that holds their folder, and git's worktree list is read", () => {
  const byPath = assignSessions([session("busy", "/r/main/sub"), session("idle", "/r/main/wt/x"), session("waiting", "/elsewhere")], ["/r/main", "/r/main/wt"]);
  assert.deepEqual([...byPath].map(([p, ss]) => [p, ss.map((s) => s.status)]), [
    ["/r/main", ["busy"]],
    ["/r/main/wt", ["idle"]],
  ]);
  const porcelain = ["worktree /r/main", "HEAD a", "branch refs/heads/main", "", "worktree /r/wt", "HEAD b", "branch refs/heads/feat/1-x", "", "worktree /r/d", "HEAD c", "detached", ""].join("\n");
  assert.deepEqual(parseWorktrees(porcelain), { primary: { path: "/r/main", branch: "main" }, worktrees: new Map([["feat/1-x", "/r/wt"]]) });
  assert.equal(parseWorktrees("worktree /r/bare.git\nbare\n").primary?.bare, true);
});

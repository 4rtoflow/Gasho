import assert from "node:assert/strict";
import { test } from "node:test";
import { assignSessions, cardsOf, parseWorktrees, type GhPr, type RepoMaterial, type SessionLike } from "../src/kanban.ts";

const pr = (over: Partial<GhPr> = {}): GhPr => ({ number: 1, title: "t", url: "https://github.com/o/r/pull/1", headRefName: "feat/1-x", ...over });
const session = (status: SessionLike["status"], cwd = "/r/wt", over: Partial<SessionLike> = {}): SessionLike => ({ sessionId: `s-${status}`, cwd, status, ...over });

test("cards: a worktree without a pull request, a pull request without a worktree, and the primary checkout only when needed", () => {
  const m: RepoMaterial = {
    repo: "o/r",
    primary: { path: "/r/main", branch: "main" },
    worktrees: new Map([
      ["feat/2-a", "/r/wt-a"],
      ["feat/3-b", "/r/wt-b"],
    ]),
    prs: [pr({ number: 9, headRefName: "feat/9-c", title: "C", isDraft: true, updatedAt: "2026-01-01T00:00:00Z" })],
    closed: new Map([["feat/3-b", { number: 4, headRefName: "feat/3-b", state: "MERGED", title: "B", url: "https://github.com/o/r/pull/4" }]]),
  };
  assert.deepEqual(
    cardsOf(m, new Map()).map((c) => [c.label, c.title, c.issue, c.pr?.state, c.pr?.draft, c.column]),
    [
      ["wt-a", "feat/2-a", 2, undefined, undefined, "mine"],
      ["wt-b", "B", 3, "merged", undefined, "mine"],
      ["PR #9", "C", 9, "open", true, "mine"],
    ],
  );
  // The primary checkout shows while a session there works or awaits an answer; an idle one does not bring it.
  assert.equal(cardsOf(m, new Map([["/r/main", [session("idle", "/r/main")]]])).some((c) => c.primary), false);
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

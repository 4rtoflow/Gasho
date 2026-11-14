import assert from "node:assert/strict";
import { test } from "node:test";
import { ghError, GitHubProxy } from "../src/github.ts";

test("a failed gh call is explained", () => {
  assert.match(ghError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })), /GitHub CLI（gh）がありません/);
  assert.match(ghError({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }), /ログインしていません/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a Repository with the name 'x/y'." }), /権限がないか/);
  assert.match(ghError({ killed: true }), /応答が遅く/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)" }), /この番号の/);
  assert.match(ghError({ stderr: "GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)" }), /この番号の/);
  assert.match(ghError({ message: "Command failed: gh issue list\nsomething else happened" }), /something else happened/);
});

/** A GitHubProxy whose gh answers when the test says (each run's answer is "<args> #<run>"). */
function proxy() {
  const runs: { args: string[]; limits: { timeoutMs: number; maxBuffer: number }; answer: () => void }[] = [];
  let now = 0;
  const p = new GitHubProxy({
    ghBin: "gh",
    now: () => now,
    run: (args, limits) =>
      new Promise((resolve) => {
        const n = runs.length + 1;
        runs.push({ args, limits, answer: () => resolve({ stdout: `${args.join(" ")} #${n}`, stderr: "" }) });
      }),
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { p, runs, tick, later: (ms: number) => (now += ms) };
}

test("reads of the same arguments run gh once, and are answered from it while new enough", async () => {
  const { p, runs, tick, later } = proxy();
  const list = ["pr", "list", "--repo", "O/N"];
  const a = p.read({ args: list });
  const b = p.read({ args: list });
  assert.equal(runs.length, 1);
  runs[0]?.answer();
  assert.deepEqual([(await a).stdout, (await b).stdout], ["pr list --repo O/N #1", "pr list --repo O/N #1"]);
  later(29_000);
  assert.equal((await p.read({ args: list })).stdout, "pr list --repo O/N #1");
  assert.equal(runs.length, 1);
  later(2000);
  void p.read({ args: list });
  await tick();
  assert.equal(runs.length, 2);
  // 0: gh runs again.
  runs[1]?.answer();
  await tick();
  void p.read({ args: list, maxAgeSeconds: 0 });
  assert.equal(runs.length, 3);
});

test("a read with other limits does not wait for gh run with another's, so that it does not fail by them", () => {
  const { p, runs } = proxy();
  const list = ["pr", "list", "--repo", "o/n"];
  void p.read({ args: list, timeoutMs: 1000 });
  void p.read({ args: list, timeoutMs: 120_000 });
  void p.read({ args: list, maxBuffer: 1024 });
  // The same limits, given or not, still run gh once.
  void p.read({ args: list });
  void p.read({ args: list, timeoutMs: 30_000 });
  assert.deepEqual(
    runs.map((r) => r.limits),
    [
      { timeoutMs: 1000, maxBuffer: 8 * 1024 * 1024 },
      { timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024 },
      { timeoutMs: 30_000, maxBuffer: 1024 },
      { timeoutMs: 30_000, maxBuffer: 8 * 1024 * 1024 },
    ],
  );
});

test("a write drops what is kept of its repository, and a read that ran across it is not kept", async () => {
  const { p, runs, tick } = proxy();
  const pulls = ["pr", "list", "--repo", "o/n"];
  const issue = ["api", "repos/o/n/issues/1"];
  const other = ["pr", "list", "-R", "o/other"];
  const search = ["search", "prs", "--author", "@me"];
  for (const args of [pulls, issue, other, search]) void p.read({ args });
  for (const r of runs) r.answer();
  await tick();
  assert.equal(runs.length, 4);

  // Asked before the write ends: what gh says may be from before it.
  void p.read({ args: pulls, maxAgeSeconds: 0 });
  const write = p.write({ args: ["issue", "edit", "1", "--repo", "o/n", "--add-assignee", "@me"], repo: "o/n" });
  runs[5]?.answer();
  await write;
  runs[4]?.answer();
  await tick();

  const before = runs.length;
  for (const args of [pulls, issue, other, search]) void p.read({ args });
  // o/n and the search (its repository is not known) run gh again; o/other is answered from what was kept.
  assert.deepEqual(runs.slice(before).map((r) => r.args), [pulls, issue, search]);
  await assert.rejects(p.write({ args: ["issue", "comment", "1"] }), /repo/);
});

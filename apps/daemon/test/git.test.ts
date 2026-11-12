import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitHubUrl, parseLog, parseRefs, parseStatus, parseTrack, readGitGraph } from "../src/git.ts";

test("parseGitHubUrl handles https, ssh and credentials, and rejects other hosts", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/4rtoflow/Gasho.git\n"), {
    owner: "4rtoflow",
    name: "Gasho",
    url: "https://github.com/4rtoflow/Gasho",
  });
  assert.deepEqual(parseGitHubUrl("git@github.com:4rtoflow/nakamaba"), {
    owner: "4rtoflow",
    name: "nakamaba",
    url: "https://github.com/4rtoflow/nakamaba",
  });
  assert.equal(parseGitHubUrl("https://user:secret@github.com/a/b.git")?.url, "https://github.com/a/b");
  assert.equal(parseGitHubUrl("https://gitlab.com/a/b.git"), undefined);
});

test("parseTrack reads ahead, behind and a deleted upstream", () => {
  assert.deepEqual(parseTrack("ahead 2, behind 1"), { ahead: 2, behind: 1 });
  assert.deepEqual(parseTrack("behind 3"), { behind: 3 });
  assert.deepEqual(parseTrack("gone"), { upstreamGone: true });
  assert.deepEqual(parseTrack(""), {});
});

test("parseRefs lists branches and decorates commits, skipping origin/HEAD and peeling annotated tags", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const t = "c".repeat(40);
  const out = [
    `refs/heads/main\0${a}\0\0origin/main\0ahead 1`,
    `refs/heads/feat/x\0${b}\0\0\0`,
    `refs/remotes/origin/HEAD\0${a}\0\0\0`,
    `refs/remotes/origin/main\0${b}\0\0\0`,
    `refs/tags/v1\0${t}\0${a}\0\0`,
    "",
  ].join("\n");
  const { branches, tips } = parseRefs(out);
  assert.deepEqual(branches, [
    { name: "main", remote: false, hash: a, upstream: "origin/main", ahead: 1 },
    { name: "feat/x", remote: false, hash: b },
    { name: "origin/main", remote: true, hash: b },
  ]);
  assert.deepEqual(tips.get(a), [
    { name: "main", kind: "local" },
    { name: "v1", kind: "tag" },
  ]);
  assert.deepEqual(tips.get(b), [
    { name: "feat/x", kind: "local" },
    { name: "origin/main", kind: "remote" },
  ]);
});

test("parseLog and parseStatus read git's machine-readable output", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const commits = parseLog(`${a}\0${b}\0Ama\x001700000000\0マージする\n${b}\0\0Ama\x001600000000\0最初\n`, new Map());
  assert.deepEqual(
    commits.map((c) => [c.hash, c.parents, c.subject, c.at]),
    [
      [a, [b], "マージする", 1700000000000],
      [b, [], "最初", 1600000000000],
    ],
  );
  const status = ["# branch.oid x", "1 M. N... 100644 100644 100644 x y a.ts", "1 .M N... 100644 100644 100644 x y b.ts", "1 MM N... x", "? new.txt", ""].join("\n");
  assert.deepEqual(parseStatus(status), { staged: 2, unstaged: 2, untracked: 1 });
});

test("readGitGraph reads branches, upstream counts, merges and changes from a real repository", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-git-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString();
  const commit = (cwd: string, msg: string) => run(cwd, "-c", "user.name=Ama", "-c", "user.email=a@example.com", "commit", "--allow-empty", "-m", msg);
  try {
    const remote = path.join(dir, "remote.git");
    const repo = path.join(dir, "repo");
    run(dir, "init", "--bare", "-b", "main", remote);
    run(dir, "init", "-b", "main", repo);
    commit(repo, "first");
    run(repo, "remote", "add", "origin", remote);
    run(repo, "push", "-u", "origin", "main");
    run(repo, "switch", "-c", "feat");
    commit(repo, "feat work");
    run(repo, "switch", "main");
    commit(repo, "main work");
    run(repo, "-c", "user.name=Ama", "-c", "user.email=a@example.com", "merge", "--no-ff", "-m", "merge feat", "feat");
    fs.writeFileSync(path.join(repo, "new.txt"), "x");

    const g = await readGitGraph(repo);
    assert.equal(g.root, fs.realpathSync(repo));
    assert.equal(g.head, "main");
    assert.equal(g.truncated, false);
    assert.deepEqual(g.changes, { staged: 0, unstaged: 0, untracked: 1 });
    const main = g.branches.find((b) => b.name === "main");
    assert.equal(main?.upstream, "origin/main");
    assert.equal(main?.ahead, 3);
    assert.ok(g.branches.some((b) => b.name === "origin/main" && b.remote));
    assert.deepEqual(g.commits.map((c) => c.subject).sort(), ["feat work", "first", "main work", "merge feat"]);
    assert.equal(g.commits[0]?.parents.length, 2);
    assert.equal(g.commits[0]?.hash, g.headHash);
    assert.deepEqual(g.commits[0]?.refs, [{ name: "main", kind: "local" }]);
    assert.deepEqual(g.commits.at(-1)?.refs, [{ name: "origin/main", kind: "remote" }]);
    // children always come before their parents
    const index = new Map(g.commits.map((c, i) => [c.hash, i]));
    for (const [i, c] of g.commits.entries()) for (const p of c.parents) assert.ok((index.get(p) ?? Infinity) > i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitGraph rejects a folder that is not a repository", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-nogit-"));
  try {
    await assert.rejects(readGitGraph(dir), /not a git repository/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

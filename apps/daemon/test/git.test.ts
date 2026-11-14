import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findRepos,
  listWorktrees,
  nestedRepos,
  parseGitHubUrl,
  parseLog,
  parseRefs,
  parseStatus,
  parseTrack,
  readGitGraph,
  worktreeOf,
} from "../src/git.ts";

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

test("nestedRepos lists the repositories inside a folder that is not one, with their branch and GitHub repository", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-ws-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString();
  try {
    for (const p of ["api", "org/web", ".hidden/secret", "node_modules/pkg", "deep/a/b"]) {
      fs.mkdirSync(path.join(dir, p), { recursive: true });
      run(path.join(dir, p), "init", "-b", p === "api" ? "main" : "dev");
    }
    run(path.join(dir, "api"), "remote", "add", "origin", "git@github.com:4rtoflow/zen-api.git");
    fs.mkdirSync(path.join(dir, "notes"));

    // Two levels down at most; hidden folders and node_modules are skipped.
    assert.deepEqual(
      (await findRepos(dir)).map((d) => path.relative(dir, d)),
      ["api", "org/web"],
    );
    assert.deepEqual(await nestedRepos(dir), [
      { path: "api", branch: "main", github: { owner: "4rtoflow", name: "zen-api", url: "https://github.com/4rtoflow/zen-api" } },
      { path: "org/web", branch: "dev" },
    ]);
    // A folder inside a repository is that repository, not a workspace.
    assert.equal(await nestedRepos(path.join(dir, "api")), undefined);
    // A folder with no repository at all.
    assert.equal(await nestedRepos(path.join(dir, "notes")), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worktreeOf gives every worktree of a repository the same repository, and listWorktrees names them the same way", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-wt-"));
  // macOS's temporary folder is reached through a symbolic link (/var → /private/var); git names the real folders.
  const real = fs.realpathSync(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString();
  try {
    const main = path.join(dir, "app");
    fs.mkdirSync(path.join(main, "src"), { recursive: true });
    run(main, "init", "-b", "main");
    run(main, "-c", "user.name=Ama", "-c", "user.email=a@example.com", "commit", "--allow-empty", "-m", "first");
    run(main, "worktree", "add", "-b", "feat/x", path.join(dir, "app-x"));
    run(main, "worktree", "add", "--detach", path.join(dir, "app-detached"));
    const bare = path.join(dir, "lib.git");
    run(dir, "clone", "--bare", main, bare);
    run(bare, "worktree", "add", path.join(dir, "lib-main"), "main");
    fs.mkdirSync(path.join(dir, "notes"));
    // A worktree whose folder was deleted without git (prunable).
    run(main, "worktree", "add", "-b", "gone", path.join(dir, "app-gone"));
    fs.rmSync(path.join(dir, "app-gone"), { recursive: true });

    const repo = path.join(real, "app");
    assert.deepEqual(await worktreeOf(path.join(main, "src")), { path: repo, repo, branch: "main" });
    assert.deepEqual(await worktreeOf(path.join(dir, "app-x")), { path: path.join(real, "app-x"), repo, branch: "feat/x" });
    assert.deepEqual(await worktreeOf(path.join(dir, "app-detached")), { path: path.join(real, "app-detached"), repo });
    // A bare repository has no main worktree; the repository is its own folder.
    assert.deepEqual(await worktreeOf(path.join(dir, "lib-main")), {
      path: path.join(real, "lib-main"),
      repo: path.join(real, "lib.git"),
      branch: "main",
    });
    assert.equal(await worktreeOf(path.join(dir, "notes")), undefined);

    // The sidebar puts a registered repository's worktree and the sessions in it in one row only if both name it alike.
    assert.deepEqual(await listWorktrees(repo), [
      { path: repo, branch: "main" },
      { path: path.join(real, "app-detached") },
      { path: path.join(real, "app-x"), branch: "feat/x" },
    ]);
    assert.deepEqual(await listWorktrees(path.join(real, "lib.git")), [{ path: path.join(real, "lib-main"), branch: "main" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepos stops after the folder limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-many-"));
  try {
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(dir, `d${String(i).padStart(2, "0")}`, ".git"), { recursive: true });
    assert.equal((await findRepos(dir, { maxDirs: 11 })).length, 10);
    assert.equal((await findRepos(dir, { maxRepos: 5 })).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

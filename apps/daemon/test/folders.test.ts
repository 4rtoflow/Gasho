// Folders made from the launcher: names that cannot be misread, nothing overwritten, and `gh repo clone` (a fake one
// here) run in the chosen folder, without a terminal, with its failures put in words.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloneError, cloneRepo, createFolder, folderNameProblem, type Made, repoFolderName, repoProblem } from "../src/folders.ts";

/** The error of what came back, or "" when the folder was made. */
const errorOf = (m: Made): string => ("error" in m ? m.error : "");

async function tmp(): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-folders-"));
  return { dir, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A fake `gh` that logs its arguments, folder and environment, then runs `body` (sh). */
async function fakeGh(dir: string, body: string): Promise<{ gh: string; log: string }> {
  const gh = path.join(dir, "gh");
  const log = path.join(dir, "gh.log");
  await fs.writeFile(
    gh,
    `#!/bin/sh\nprintf '%s\\n' "$*" "$PWD" "GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" >> '${log}'\n${body}\n`,
    { mode: 0o755 },
  );
  return { gh, log };
}

test("a folder's name is one name that gh, git and the shell cannot misread", () => {
  for (const ok of ["ws", "my-repo_2", "日本語のフォルダー", ".config", "a b"]) assert.equal(folderNameProblem(ok), undefined, ok);
  for (const [bad, why] of [
    ["", /入れて/],
    [" ws", /空白/],
    ["ws ", /空白/],
    [".", /使えません/],
    ["..", /使えません/],
    ["a/b", /\//],
    ["-rf", /「-」/],
    ["a\nb", /改行/],
    ["x".repeat(256), /長すぎ/],
    ["あ".repeat(86), /長すぎ/],
  ] as const) {
    assert.match(folderNameProblem(bad) ?? "", why, JSON.stringify(bad));
  }
});

test("a repository is owner/name, a name, or a GitHub URL; its folder is its name", () => {
  const cases: [string, string | undefined][] = [
    ["4rtoflow/Gasho", "Gasho"],
    ["Gasho", "Gasho"],
    ["github.com/cli/cli", "cli"],
    ["https://github.com/cli/cli", "cli"],
    ["https://github.com/cli/cli.git", "cli"],
    ["https://github.com/cli/cli/", "cli"],
    ["git@github.com:cli/go-gh.git", "go-gh"],
    ["ssh://git@github.com/cli/go-gh.git", "go-gh"],
  ];
  for (const [repo, folder] of cases) {
    assert.equal(repoProblem(repo), undefined, repo);
    assert.equal(repoFolderName(repo), folder, repo);
  }
  for (const bad of ["", "  ", "-c", "--upload-pack=x", "owner/repo extra", "https://github.com/cli", "http://github.com/cli/cli", "file:///etc/passwd", "a/b/c/d", "owner/..", "../x"]) {
    assert.ok(repoProblem(bad), JSON.stringify(bad));
  }
});

test("a folder is made inside the chosen one; what is there already, a relative or missing folder, is refused", async () => {
  const { dir, done } = await tmp();
  try {
    const made = await createFolder(dir, "ws");
    assert.deepEqual(made, { path: path.join(dir, "ws") });
    assert.ok((await fs.stat(path.join(dir, "ws"))).isDirectory());
    // A trailing slash on the chosen folder is fine.
    assert.deepEqual(await createFolder(`${dir}/ws/`, "inner"), { path: path.join(dir, "ws", "inner") });

    assert.match(errorOf(await createFolder(dir, "ws")), /すでにあります/);
    await fs.writeFile(path.join(dir, "file"), "");
    assert.match(errorOf(await createFolder(dir, "file")), /すでにあります/);
    assert.match(errorOf(await createFolder("relative/path", "x")), /絶対パス/);
    assert.match(errorOf(await createFolder(path.join(dir, "missing"), "x")), /フォルダーがありません/);
    assert.match(errorOf(await createFolder(dir, "a/b")), /\//);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["file", "ws"]);
  } finally {
    await done();
  }
});

test("gh repo clone runs in the chosen folder with the folder named, and without prompts", async () => {
  const { dir, done } = await tmp();
  try {
    const { gh, log } = await fakeGh(dir, 'mkdir "$4" && echo cloned > "$4/README.md"');
    const parent = path.join(dir, "repos");
    await fs.mkdir(parent);
    assert.deepEqual(await cloneRepo(gh, parent, "cli/cli"), { path: path.join(parent, "cli") });
    assert.equal(await fs.readFile(path.join(parent, "cli", "README.md"), "utf8"), "cloned\n");
    assert.deepEqual(await cloneRepo(gh, parent, "https://github.com/cli/cli.git", "gh-cli"), { path: path.join(parent, "gh-cli") });
    const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(lines, [
      "repo clone cli/cli cli",
      parent,
      "GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0",
      "repo clone https://github.com/cli/cli.git gh-cli",
      parent,
      "GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0",
    ]);
  } finally {
    await done();
  }
});

test("a clone into a folder that is there already, or that runs already, does not start gh", async () => {
  const { dir, done } = await tmp();
  try {
    const { gh, log } = await fakeGh(dir, 'sleep 0.5; mkdir "$4"');
    await fs.mkdir(path.join(dir, "taken"));
    assert.match(errorOf(await cloneRepo(gh, dir, "o/taken")), /すでにあります/);
    const first = cloneRepo(gh, dir, "o/twice");
    const second = await cloneRepo(gh, dir, "o/twice");
    assert.match(errorOf(second), /すでに進めています/);
    assert.deepEqual(await first, { path: path.join(dir, "twice") });
    assert.equal((await fs.readFile(log, "utf8")).split("\n").filter((l) => l.startsWith("repo clone")).length, 1);
    assert.match(errorOf(await cloneRepo(gh, dir, "o/x", "../escape")), /\//);
    assert.match(errorOf(await cloneRepo(gh, dir, "--upload-pack=touch /tmp/x")), /owner\/name/);
  } finally {
    await done();
  }
});

test("gh's failures are put in words: not found, not logged in, no gh, too slow", async () => {
  const { dir, done } = await tmp();
  try {
    const notFound = await fakeGh(dir, "echo \"GraphQL: Could not resolve to a Repository with the name 'o/nope'. (repository)\" >&2; exit 1");
    assert.match(errorOf(await cloneRepo(notFound.gh, dir, "o/nope")), /見つかりません/);

    const loggedOut = await fakeGh(dir, "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4");
    assert.match(errorOf(await cloneRepo(loggedOut.gh, dir, "o/r")), /gh auth login/);

    assert.match(errorOf(await cloneRepo(path.join(dir, "no-gh"), dir, "o/r")), /GitHub CLI（gh）がありません/);

    const slow = await fakeGh(dir, "sleep 30");
    const started = Date.now();
    assert.match(errorOf(await cloneRepo(slow.gh, dir, "o/slow", undefined, { timeoutMs: 300 })), /止めました/);
    assert.ok(Date.now() - started < 5000, "the clone was stopped (SIGTERM to its group)");

    assert.match(cloneError({ stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository." }), /SSH/);
    assert.match(cloneError({ stderr: "Cloning into 'x'...\nfatal: something odd\n" }), /clone できませんでした：fatal: something odd/);
  } finally {
    await done();
  }
});

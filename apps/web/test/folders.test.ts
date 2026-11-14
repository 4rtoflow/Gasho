import assert from "node:assert/strict";
import { test } from "node:test";
import * as daemon from "../../daemon/src/folders.ts";
import { childPath, folderChoices, folderNameProblem, repoFolderName, repoProblem } from "../src/lib/folders.ts";

test("the launcher takes the folder names and repositories gasho-daemon takes, and names a clone's folder as it does", () => {
  for (const name of ["ws", "", " ws", ".", "..", "a/b", "-x", "a\nb", "日本語", ".config", "x".repeat(255), "x".repeat(256), "あ".repeat(85), "あ".repeat(86)]) {
    assert.equal(folderNameProblem(name), daemon.folderNameProblem(name), JSON.stringify(name));
  }
  const repos = [
    "cli/cli",
    "cli",
    "github.com/cli/cli",
    "https://github.com/cli/cli.git",
    "https://github.com/cli/cli/",
    "git@github.com:cli/go-gh.git",
    "ssh://git@github.com/cli/go-gh.git",
    "",
    "-c",
    "owner/repo extra",
    "http://github.com/cli/cli",
    "owner/..",
    "a/b/c/d",
    "owner/.git",
  ];
  for (const repo of repos) {
    assert.equal(repoProblem(repo), daemon.repoProblem(repo), repo);
    assert.equal(repoFolderName(repo), daemon.repoFolderName(repo), repo);
  }
});

test("the folders offered: the trusted ones, the folders holding them (never a home folder), and those made here", () => {
  const trusted = ["/home/rg/repos/Gasho", "/home/rg/repos/zen", "/home/rg/notes"];
  assert.deepEqual(folderChoices(trusted, ["/home/rg/repos/zen/ws", "/home/rg/repos/Gasho"]), [
    "/home/rg/notes",
    "/home/rg/repos",
    "/home/rg/repos/Gasho",
    "/home/rg/repos/zen",
    "/home/rg/repos/zen/ws",
  ]);
  // A gasho-daemon that cannot answer Claude Code's question gets only the trusted folders (and none made).
  assert.deepEqual(folderChoices(trusted, [], false), ["/home/rg/notes", "/home/rg/repos/Gasho", "/home/rg/repos/zen"]);
  assert.deepEqual(folderChoices(["/srv/x", "/x"]), ["/srv/x", "/x"]);
  assert.equal(childPath("/home/rg/repos/", "ws"), "/home/rg/repos/ws");
  assert.equal(childPath("/", "ws"), "/ws");
});

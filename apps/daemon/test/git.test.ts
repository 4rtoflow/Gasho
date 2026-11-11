import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGitHubUrl } from "../src/git.ts";

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

// Inputs in Claude Code's shell mode ("!" and a command): gasho-daemon types them like any input, but not without a
// command, and not with files (their @path lines would follow the command and be run by the shell too).
import assert from "node:assert/strict";
import { test } from "node:test";
import { shellInputProblem } from "../src/managed.ts";

test("a shell-mode input needs a command after its \"!\" and cannot carry files", () => {
  assert.equal(shellInputProblem("!ls -la", 0), undefined);
  assert.equal(shellInputProblem("テストを流して", 2), undefined);
  assert.match(shellInputProblem("!", 0) ?? "", /コマンドを入れて/);
  assert.match(shellInputProblem("! \n ", 0) ?? "", /コマンドを入れて/);
  assert.match(shellInputProblem("!cat", 1) ?? "", /ファイルを添付できません/);
});

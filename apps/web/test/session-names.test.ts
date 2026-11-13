import assert from "node:assert/strict";
import { test } from "node:test";
import { forkName as daemonForkName, sessionName } from "../../daemon/src/managed.ts";
import { forkName, MAX_SESSION_NAME, nameProblem } from "../src/lib/session-names.ts";

test("the dialog takes the names gasho-daemon takes, and suggests the fork's name it would give", () => {
  for (const name of ["調査", `  ${"x".repeat(MAX_SESSION_NAME)} `, "", "   ", "x".repeat(MAX_SESSION_NAME + 1), "二行\n目", "tab\tx", "🙏 合掌"]) {
    assert.equal(nameProblem(name) === undefined, !("error" in sessionName(name)), JSON.stringify(name));
  }
  for (const source of ["Bobert-gasho", "あ".repeat(80), "x".repeat(54) + "   y"]) {
    assert.equal(forkName(source), daemonForkName(source));
    assert.equal(nameProblem(forkName(source)), undefined);
  }
});

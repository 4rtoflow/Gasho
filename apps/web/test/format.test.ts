import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsedTime } from "../src/lib/format.ts";

test("how long something has been going on: seconds, minutes, hours and minutes, days", () => {
  const now = Date.parse("2026-11-14T16:00:00Z");
  assert.equal(elapsedTime(now - 40_000, now), "40秒");
  assert.equal(elapsedTime(now - 12 * 60_000 - 5_000, now), "12分");
  assert.equal(elapsedTime(now - 65 * 60_000, now), "1時間5分");
  assert.equal(elapsedTime(now - 2 * 3600_000, now), "2時間");
  assert.equal(elapsedTime(now - 50 * 3600_000, now), "2日");
  // A clock a little ahead on the working server.
  assert.equal(elapsedTime(now + 3_000, now), "0秒");
});

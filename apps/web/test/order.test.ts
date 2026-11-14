import assert from "node:assert/strict";
import { test } from "node:test";
import { arrangeSessions, arrangeTiles, rememberSessions, sameOrder } from "../src/lib/order.ts";

const TILES = ["busy", "waiting", "idle", "sent", "sessions", "notifications"];

test("the tiles keep the default order until they are dragged", () => {
  assert.deepEqual(arrangeTiles(TILES, undefined), TILES);
  assert.deepEqual(arrangeTiles(TILES, ["sessions", "busy", "waiting", "idle", "sent", "notifications"]), [
    "sessions",
    "busy",
    "waiting",
    "idle",
    "sent",
    "notifications",
  ]);
});

test("a tile missing from the saved order goes after the tile it follows by default; ids no longer tiles are left out", () => {
  // "idle" was added after the order was saved; "old" is a tile that went away; a repeated id counts once.
  assert.deepEqual(arrangeTiles(TILES, ["notifications", "waiting", "old", "busy", "sent", "sessions", "busy"]), [
    "notifications",
    "waiting",
    "idle",
    "busy",
    "sent",
    "sessions",
  ]);
  // The first tile, when missing, goes first.
  assert.deepEqual(arrangeTiles(["a", "b", "c"], ["c", "b"]), ["a", "c", "b"]);
});

test("the dragged order of the sessions stays; sessions started since come first, in the order of last use", () => {
  const byLastUse = ["new2", "s3", "new1", "s1", "s2"];
  assert.deepEqual(arrangeSessions(byLastUse, undefined), byLastUse);
  assert.deepEqual(arrangeSessions(byLastUse, ["s1", "gone", "s2", "s3"]), ["new2", "new1", "s1", "s2", "s3"]);
});

test("saving the sessions' order keeps the saved sessions not shown now, after the shown ones", () => {
  assert.deepEqual(rememberSessions(["b", "a"], undefined), ["b", "a"]);
  assert.deepEqual(rememberSessions(["b", "a"], ["a", "offline", "b"]), ["b", "a", "offline"]);
  const many = Array.from({ length: 300 }, (_, i) => `old${i}`);
  assert.equal(rememberSessions(["a"], many).length, 200);
  assert.equal(rememberSessions(["a"], many)[0], "a");
});

test("sameOrder compares the ids one by one", () => {
  assert.ok(sameOrder(["a", "b"], ["a", "b"]));
  assert.ok(!sameOrder(["a", "b"], ["b", "a"]));
  assert.ok(!sameOrder(["a"], ["a", "b"]));
});

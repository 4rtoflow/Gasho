import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph } from "../src/lib/graph-layout.ts";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

test("a straight history stays in one lane", () => {
  const { rows, width } = layoutGraph([c("c3", "c2"), c("c2", "c1"), c("c1")]);
  assert.equal(width, 1);
  assert.deepEqual(rows, [
    { col: 0, through: [], into: [], out: [0] },
    { col: 0, through: [], into: [0], out: [0] },
    { col: 0, through: [], into: [0], out: [] },
  ]);
});

test("a merge opens a lane for its second parent, and the lanes meet again at the common parent", () => {
  const { rows, width } = layoutGraph([c("m", "a", "b"), c("a", "base"), c("b", "base"), c("base")]);
  assert.equal(width, 2);
  assert.deepEqual(rows, [
    { col: 0, through: [], into: [], out: [0, 1] },
    { col: 0, through: [1], into: [0], out: [0] },
    { col: 1, through: [0], into: [1], out: [1] },
    { col: 0, through: [], into: [0, 1], out: [] },
  ]);
});

test("two branch tips on the same parent get their own lanes, and a freed lane is reused", () => {
  const { rows } = layoutGraph([c("x", "base"), c("y", "base"), c("base", "root"), c("z", "root"), c("root")]);
  assert.deepEqual(
    rows.map((r) => r.col),
    [0, 1, 0, 1, 0],
  );
  assert.deepEqual(rows[2], { col: 0, through: [], into: [0, 1], out: [0] });
  // z starts in lane 1 again, which base freed.
  assert.deepEqual(rows[3], { col: 1, through: [0], into: [], out: [1] });
});

test("a merge into a lane that already waits for the parent joins it", () => {
  const { rows } = layoutGraph([c("m", "a", "base"), c("b", "base"), c("a", "base"), c("base")]);
  // m's second parent opens lane 1 for base, b is a new tip in lane 2, and all three lanes meet at base.
  assert.deepEqual(rows[0], { col: 0, through: [], into: [], out: [0, 1] });
  assert.deepEqual(rows[1], { col: 2, through: [0, 1], into: [], out: [2] });
  assert.deepEqual(rows[3], { col: 0, through: [], into: [0, 1, 2], out: [] });
});

test("parents beyond the list keep their lane to the bottom", () => {
  const { rows, width } = layoutGraph([c("m", "a", "old"), c("a", "older")]);
  assert.equal(width, 2);
  assert.deepEqual(rows[1], { col: 0, through: [1], into: [0], out: [0] });
});

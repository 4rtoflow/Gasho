import assert from "node:assert/strict";
import { test } from "node:test";
import { arrayMove, gridIndex, listIndex, type Rect } from "../src/lib/sortable.ts";

test("arrayMove takes the item out and puts it at the new place", () => {
  assert.deepEqual(arrayMove(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(arrayMove(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(arrayMove(["a", "b"], 1, 1), ["a", "b"]);
});

const rows = (n: number, height = 36): Rect[] => Array.from({ length: n }, (_, i) => ({ left: 0, top: i * height, width: 200, height }));

test("in a list, the dragged item goes to the place whose middle is nearest its own", () => {
  // Item 0 (middle 18) dragged down: it passes item 1 once its middle is past the line between them (36).
  assert.equal(listIndex(rows(4), 30), 0);
  assert.equal(listIndex(rows(4), 40), 1);
  assert.equal(listIndex(rows(4), 200), 3);
  assert.equal(listIndex(rows(4), -50), 0);
});

/**
 * Where CSS grid puts tiles of these sizes ([columns, rows]) with `grid-auto-flow: row`: each after the one before,
 * in the first cells free. Cells of 100 × 100, no gaps.
 */
function place(spans: readonly (readonly [number, number])[], columns: number): Rect[] {
  const taken = new Set<string>();
  let row = 0;
  let col = 0;
  return spans.map(([w, h]) => {
    const free = () => {
      for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (taken.has(`${r},${c}`)) return false;
      return true;
    };
    while (col + w > columns || !free()) {
      col++;
      if (col + w > columns) {
        row++;
        col = 0;
      }
    }
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) taken.add(`${r},${c}`);
    const rect = { left: col * 100, top: row * 100, width: w * 100, height: h * 100 };
    col += w;
    return rect;
  });
}

// The home screen's tiles: on a computer (4 columns) and on a phone (2 columns).
const DESKTOP: Record<string, readonly [number, number]> = {
  busy: [1, 1],
  waiting: [1, 1],
  idle: [1, 1],
  sent: [1, 1],
  sessions: [3, 1],
  notifications: [1, 2],
  tokens: [1, 1],
  tokenBreakdown: [2, 1],
  operations: [2, 1],
  github: [1, 1],
  machines: [1, 1],
};
const PHONE: Record<string, readonly [number, number]> = {
  ...Object.fromEntries(Object.keys(DESKTOP).map((id) => [id, [2, 1] as const])),
  busy: [1, 1],
  waiting: [1, 1],
  idle: [1, 1],
  sent: [1, 1],
};
const TILES = Object.keys(DESKTOP);

test("in a grid, a tile goes before the tile under the pointer, or after it past its middle", () => {
  const rects = place(TILES.map((id) => DESKTOP[id]!), 4);
  // "busy" over the left half of "waiting" stays; past its middle, it goes after it.
  assert.equal(gridIndex(rects, 0, { x: 120, y: 50 }, 400), 0);
  assert.equal(gridIndex(rects, 0, { x: 180, y: 50 }, 400), 1);
  // "sent" over the left half of "busy" goes first; "busy" over the right half of "sessions" goes after it.
  assert.equal(gridIndex(rects, 3, { x: 20, y: 50 }, 400), 0);
  assert.equal(gridIndex(rects, 0, { x: 290, y: 150 }, 400), 4);
  // Over its own place, it goes back there; over an empty cell, nothing changes.
  assert.equal(gridIndex(rects, 2, { x: 250, y: 50 }, 400), 2);
  assert.equal(gridIndex(rects, 0, { x: 450, y: 50 }, 400), undefined);
  // On a phone, a tile as wide as the grid splits into upper and lower halves.
  const phone = place(TILES.map((id) => PHONE[id]!), 2);
  assert.equal(gridIndex(phone, 0, { x: 150, y: 220 }, 200), 3);
  assert.equal(gridIndex(phone, 0, { x: 50, y: 280 }, 200), 4);
});

test("in a grid, the tiles' places when the drag began decide: judged by the places now, a tile held still can keep swapping", () => {
  // "busy" held at the right of the third row. Judged by the places now, it goes before "notifications", which puts
  // the token breakdown under the pointer; after that, then before "notifications" again, and so on.
  const p = { x: 305, y: 205 };
  let order = TILES;
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const from = order.indexOf("busy");
    const to = gridIndex(place(order.map((id) => DESKTOP[id]!), 4), from, p, 400);
    if (to === undefined || to === from) break;
    order = arrayMove(order, from, to);
    seen.push(order.join(" "));
  }
  assert.ok(new Set(seen).size < seen.length, "judged by the places now, the order goes back and forth");
  // Judged by the places when the drag began, the place depends on the pointer alone.
  const places = place(TILES.map((id) => DESKTOP[id]!), 4);
  assert.equal(gridIndex(places, 0, p, 400), 4);
});

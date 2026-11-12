// Places commits on lanes for the branch graph. Commits come newest first with children before parents
// (git log --topo-order). Each lane waits for one commit; a commit takes the leftmost lane waiting for it,
// lanes keep their column until they end, and a freed column is reused by the next new lane.

export interface GraphRow {
  /** Lane of the commit's dot. */
  col: number;
  /** Lanes that pass this row without touching the dot. */
  through: number[];
  /** Lanes that end at the dot from above (the commit's children); includes `col` when it has a child above. */
  into: number[];
  /** Lanes that leave the dot downwards, towards the parents; the first parent stays in `col`. */
  out: number[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Number of lanes the widest row needs. */
  width: number;
}

export function layoutGraph(commits: readonly { hash: string; parents: readonly string[] }[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;
  const freeLane = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (const c of commits) {
    const into: number[] = [];
    const through: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) into.push(i);
      else if (h !== null) through.push(i);
    });
    const col = into[0] ?? freeLane();
    for (const i of into) lanes[i] = null;

    const out: number[] = [];
    c.parents.forEach((p, n) => {
      let k: number;
      if (n === 0) k = col;
      else {
        // A merge: join the lane already waiting for this parent, or open a new one.
        const waiting = lanes.indexOf(p);
        k = waiting === -1 ? freeLane() : waiting;
      }
      lanes[k] = p;
      if (!out.includes(k)) out.push(k);
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    width = Math.max(width, col + 1, ...out.map((k) => k + 1), ...through.map((k) => k + 1));
    rows.push({ col, through, into, out });
  }
  return { rows, width };
}

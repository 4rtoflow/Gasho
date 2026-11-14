// The kanban's columns and the order of its cards. Nothing decides the columns yet:
// gasho-daemon puts every card in the first one.
import type { KanbanCard, KanbanColumn, MachineInfo } from "@gasho/protocol";
import { daemonAtLeast } from "@/lib/sessions";

export const KANBAN_COLUMNS: { id: KanbanColumn; label: string }[] = [
  { id: "mine", label: "自分の番" },
  { id: "agent", label: "エージェント作業中" },
  { id: "github", label: "GitHub 待ち" },
  { id: "review", label: "レビュー待ち" },
  { id: "done", label: "完了" },
];

/** The kanban needs gasho-daemon 0.11.0. */
export const kanbanReady = (m: MachineInfo): boolean => daemonAtLeast(m, 0, 11);

export interface PlacedCard {
  machine: MachineInfo;
  card: KanbanCard;
}

const ORDER = new Map(KANBAN_COLUMNS.map((c, i) => [c.id, i]));

/** By column, and in a column the pull request that has not moved for the longest first; cards without one last. */
export function sortCards(cards: PlacedCard[]): PlacedCard[] {
  return [...cards].sort(
    (a, b) =>
      (ORDER.get(a.card.column) ?? 0) - (ORDER.get(b.card.column) ?? 0) ||
      Number(a.card.updatedAt === undefined) - Number(b.card.updatedAt === undefined) ||
      (a.card.updatedAt ?? "").localeCompare(b.card.updatedAt ?? ""),
  );
}

/**
 * Each column's width at first (they fit a 1440-wide screen beside the sidebar), and whether its cards start as one
 * line: the columns I cannot move myself, as in the personal worktree-board.
 */
export const COLUMN_DEFAULTS: Record<KanbanColumn, { width: number; compact: boolean }> = {
  mine: { width: 300, compact: false },
  agent: { width: 220, compact: false },
  github: { width: 220, compact: false },
  review: { width: 220, compact: true },
  done: { width: 200, compact: true },
};
export const COLUMN_WIDTH = { min: 180, max: 720 };

export type KanbanSortKey = "issue" | "pr" | "updated";
export interface KanbanSort {
  key: KanbanSortKey;
  desc: boolean;
}

/** The orders a column can take besides the default one; `asc` and `desc` say what each direction means. */
export const KANBAN_SORTS: Record<KanbanSortKey, { label: string; short: string; value: (c: KanbanCard) => number | undefined; asc: string; desc: string }> = {
  issue: { label: "Issue 番号", short: "Issue", value: (c) => c.issue, asc: "小さい順", desc: "大きい順" },
  pr: { label: "PR 番号", short: "PR", value: (c) => c.pr?.number, asc: "小さい順", desc: "大きい順" },
  updated: { label: "最終更新", short: "更新", value: (c) => (c.updatedAt ? Date.parse(c.updatedAt) : undefined), asc: "古い順", desc: "新しい順" },
};

/** A column's cards in `sort`; cards without the value stay below in either direction, ties keep the default order. */
export function arrangeCards(rows: PlacedCard[], sort: KanbanSort | undefined): PlacedCard[] {
  if (!sort) return rows;
  const value = KANBAN_SORTS[sort.key].value;
  return [...rows].sort((a, b) => {
    const x = value(a.card);
    const y = value(b.card);
    if (x === undefined || y === undefined) return Number(x === undefined) - Number(y === undefined);
    return sort.desc ? y - x : x - y;
  });
}

/** The cards of the connected working servers. */
export function kanbanCards(machines: MachineInfo[]): PlacedCard[] {
  return sortCards(machines.filter((m) => m.connected).flatMap((machine) => (machine.kanban?.cards ?? []).map((card) => ({ machine, card }))));
}

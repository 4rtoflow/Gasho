// The words of the kanban (its columns, why a card is in its column, what to do next) and the order of its cards.
// gasho-daemon decides the column; the texts follow 4rtoflow/Dashboard's.
import type { KanbanCard, KanbanColumn, KanbanReason, MachineInfo } from "@gasho/protocol";
import { waitingLabel } from "@/lib/format";
import { daemonAtLeast } from "@/lib/sessions";

export const KANBAN_COLUMNS: { id: KanbanColumn; label: string }[] = [
  { id: "mine", label: "自分の番" },
  { id: "agent", label: "エージェント作業中" },
  { id: "github", label: "GitHub 待ち" },
  { id: "review", label: "レビュー待ち" },
  { id: "done", label: "完了" },
];

/** The kanban needs gasho-daemon 0.10.0. */
export const kanbanReady = (m: MachineInfo): boolean => daemonAtLeast(m, 0, 10);

const names = (xs: string[]): string => xs.join("、");

export function reasonText(r: KanbanReason): string {
  switch (r.kind) {
    case "agent_waiting":
      return r.waitingFor ? `Claude Code が答えを待っている：${waitingLabel(r.waitingFor)}` : "Claude Code が答えを待っている";
    case "agent_working":
      return "Claude Code が作業している";
    case "merged":
      return `PR #${r.pr} がマージされた`;
    case "closed":
      return `PR #${r.pr} がマージされずにクローズされた`;
    case "no_pr":
      return "PR がまだない";
    case "conflict":
      return "ベースブランチとコンフリクトしている";
    case "ci_failed":
      return `CI が失敗：${names(r.checks)}`;
    case "changes_requested":
      return `${names(r.who)} が変更を求めた`;
    case "ci_running":
      return `CI が走っている：${names(r.checks)}`;
    case "draft":
      return "Draft のまま";
    case "rereview":
      return `${names(r.who)} の再レビュー待ち`;
    case "approved":
      return "承認された";
    case "review_waiting":
      return "レビュー待ち";
  }
}

const NEXT: Record<KanbanReason["kind"], string> = {
  agent_waiting: "その会話で答える",
  agent_working: "待つ",
  merged: "worktree を片付ける",
  closed: "worktree を片付ける",
  no_pr: "作業を進めるか、PR を作る",
  conflict: "ベースブランチを取り込んでコンフリクトを解く",
  ci_failed: "ログを見て直し、push する",
  changes_requested: "指摘を直して push する",
  ci_running: "待つ",
  draft: "Ready にする",
  rereview: "待つ",
  approved: "マージする",
  review_waiting: "待つ",
};

/** What to do next, shown only when the move is mine. */
export function nextStep(card: KanbanCard): string | undefined {
  return card.column === "mine" ? NEXT[card.reason.kind] : undefined;
}

export function badges(card: KanbanCard): string[] {
  return [
    card.pr?.state === "open" && card.pr.draft && "Draft",
    // The primary checkout is used without pull requests.
    !card.pr && !card.primary && "PR なし",
    !card.path && "worktree なし",
  ].filter((b): b is string => Boolean(b));
}

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

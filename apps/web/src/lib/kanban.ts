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

/** The cards of the connected working servers. */
export function kanbanCards(machines: MachineInfo[]): PlacedCard[] {
  return sortCards(machines.filter((m) => m.connected).flatMap((machine) => (machine.kanban?.cards ?? []).map((card) => ({ machine, card }))));
}

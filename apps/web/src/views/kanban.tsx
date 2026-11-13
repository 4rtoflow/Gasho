// The kanban: the worktrees and my pull requests of the watched repositories, in the column of whoever has to move
// next (after 4rtoflow/Dashboard). Each working server's gasho-daemon reads its repositories and decides the columns;
// the repositories are chosen here, per working server, from the repositories in the folders Claude Code trusts there.
import { ExternalLink, RefreshCw, Settings2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import type { KanbanCard, KanbanColumn, MachineInfo } from "@gasho/protocol";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { relativeTime, sessionLabel } from "@/lib/format";
import { badges, KANBAN_COLUMNS, kanbanCards, kanbanReady, nextStep, reasonText, type PlacedCard } from "@/lib/kanban";
import { go } from "@/lib/route";
import { refreshKanban, useAppState, watchKanbanRepos } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** gasho-daemon reads every minute; an older reading means it stopped. */
const STALE_MS = 5 * 60_000;
/** How long the refresh button waits for a working server to start reading. */
const REFRESH_WAIT_MS = 3000;
/** Repositories one working server can watch (the Gasho server's limit). */
const MAX_REPOS = 30;

const COLUMN_STYLE: Record<KanbanColumn, { tone: "warning" | "success" | "neutral"; card?: string }> = {
  mine: { tone: "warning", card: "bg-amber-500/[0.06] ring-amber-500/40" },
  agent: { tone: "success", card: "border-l-2 border-l-emerald-500" },
  github: { tone: "neutral" },
  review: { tone: "neutral" },
  done: { tone: "neutral", card: "opacity-75" },
};

const time = (ms: number): string => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

export function KanbanView() {
  const { machines } = useAppState();
  const now = useNow(15_000);
  const [choosing, setChoosing] = useState(false);
  const [asked, setAsked] = useState(false);

  const cards = useMemo(() => kanbanCards(machines), [machines]);
  const ready = machines.filter((m) => m.connected && kanbanReady(m));
  const boards = ready.flatMap((m) => (m.kanban ? [m.kanban] : []));
  const watched = machines.reduce((n, m) => n + (m.kanbanRepos?.length ?? 0), 0);
  const updatedAt = Math.max(0, ...boards.map((b) => b.updatedAt ?? 0)) || undefined;
  const stale = updatedAt !== undefined && now - updatedAt > STALE_MS;
  const checking = asked || boards.some((b) => b.checking);
  const errors = ready.flatMap((m) => (m.kanban?.errors ?? []).map((e) => ({ machine: m, ...e })));
  const old = machines.filter((m) => m.connected && !kanbanReady(m));
  const offline = machines.filter((m) => !m.connected && (m.kanbanRepos?.length ?? 0) > 0);
  // Where the cards come from, on each card only when it is not obvious.
  const several = { machines: new Set(cards.map((c) => c.machine.id)).size > 1, repos: new Set(cards.map((c) => c.card.repo)).size > 1 };

  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => setAsked(false), REFRESH_WAIT_MS);
    return () => clearTimeout(t);
  }, [asked]);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">カンバン</h1>
          <p className="text-sm text-muted-foreground">
            {watched} 個の repo・{cards.length} 枚のカード
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {watched > 0 && (
            <span className={cn("text-xs tabular-nums", stale ? "font-medium text-red-400" : "text-muted-foreground")}>
              {updatedAt === undefined ? "まだ読んでいない" : `${time(updatedAt)} 更新${stale ? "（5 分以上更新されていない）" : ""}`}
            </span>
          )}
          <button type="button" onClick={() => setChoosing(true)} disabled={ready.length === 0} className={BUTTON_SECONDARY}>
            <Settings2 className="mr-1.5 size-4" />
            見る repo
          </button>
          {watched > 0 && (
            <button
              type="button"
              disabled={checking || ready.length === 0}
              onClick={() => {
                setAsked(true);
                refreshKanban();
              }}
              className={BUTTON_SECONDARY}
            >
              <RefreshCw className={cn("mr-1.5 size-4", checking && "animate-spin")} />
              {checking ? "見直し中…" : "今すぐ見直す"}
            </button>
          )}
        </div>
      </div>

      {(errors.length > 0 || old.length > 0 || offline.length > 0) && (
        <div className="space-y-1 rounded-xl border border-red-500/40 bg-red-500/[0.06] px-3 py-2 text-sm text-red-400" role="alert">
          {errors.map((e) => (
            <p key={`${e.machine.id}/${e.repo}`} className="break-words">
              {ready.length > 1 && `${e.machine.name} · `}
              {e.repo}：{e.error}
            </p>
          ))}
          {old.map((m) => (
            <p key={m.id}>{m.name} の gasho-daemon は古いため、カンバンを出せません。0.10.0 以上に更新してください。</p>
          ))}
          {offline.map((m) => (
            <p key={m.id}>{m.name} はオフラインのため、その repo のカードを出していません。</p>
          ))}
        </div>
      )}

      {watched === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            見る repo を選ぶと、その worktree と自分の PR を、次に動く人ごとの列に並べます。
            <br />
            選べるのは、working server で Claude Code が信頼しているフォルダーにある repo です。
          </p>
          <button type="button" onClick={() => setChoosing(true)} disabled={ready.length === 0} className={BUTTON_SECONDARY}>
            <Settings2 className="mr-1.5 size-4" />
            見る repo を選ぶ
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] items-start gap-3">
          {KANBAN_COLUMNS.map((col) => {
            const rows = cards.filter((c) => c.card.column === col.id);
            return (
              <section key={col.id} aria-label={`${col.label}：${rows.length} 枚`} className={cn(TILE, "flex flex-col p-2")} style={{ boxShadow: TILE_SHADOW }}>
                <h2 className="flex items-center gap-2 px-2 pt-1 pb-2 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                  {col.label}
                  <Badge tone={rows.length > 0 ? COLUMN_STYLE[col.id].tone : "neutral"}>{rows.length}</Badge>
                </h2>
                {rows.length === 0 ? (
                  <p className="px-2 pb-2 text-xs text-muted-foreground">なし</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {rows.map((row) => (
                      <li key={`${row.machine.id}/${row.card.id}`}>
                        <Card row={row} now={now} several={several} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <ReposDialog open={choosing} onClose={() => setChoosing(false)} machines={ready} />
    </div>
  );
}

function Card({ row: { machine, card }, now, several }: { row: PlacedCard; now: number; several: { machines: boolean; repos: boolean } }) {
  const next = nextStep(card);
  const updated = card.updatedAt ? Date.parse(card.updatedAt) : undefined;
  // The reason already says when Claude Code works or waits; an idle one is noted, like the Dashboard's "指示待ち".
  const idle = card.sessions.some((s) => !s.managed && s.status === "idle");
  const managed = card.sessions.flatMap((s) => {
    const info = s.managed ? machine.sessions.find((x) => x.sessionId === s.sessionId) : undefined;
    return info ? [{ s, info }] : [];
  });
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-xl bg-white/[0.03] p-3 ring-1 ring-black/[0.06] dark:ring-white/[0.06]", COLUMN_STYLE[card.column].card)}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={card.path ?? card.branch}>
          {card.label}
        </span>
        {updated !== undefined && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title="PR の最終更新">
            {relativeTime(updated, now)}
          </span>
        )}
      </div>
      {card.pr ? (
        <a
          href={card.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-xs break-words text-neutral-700 hover:underline dark:text-neutral-300"
        >
          {card.title}
        </a>
      ) : (
        <p className="line-clamp-2 text-xs break-words text-neutral-700 dark:text-neutral-300">{card.title}</p>
      )}
      <p className="text-xs text-muted-foreground">{reasonText(card.reason)}</p>
      {next && <p className="text-xs text-amber-500 dark:text-amber-400">次：{next}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {several.machines && <Chip>{machine.name}</Chip>}
        {several.repos && <Chip>{card.repo.split("/").pop()}</Chip>}
        {card.pr && card.label !== `PR #${card.pr.number}` && (
          <a href={card.pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 rounded-md bg-black/[0.04] px-1.5 py-0.5 hover:text-foreground dark:bg-white/[0.06]">
            PR #{card.pr.number}
            <ExternalLink className="size-3" />
          </a>
        )}
        {card.issue !== undefined && <Chip>Issue #{card.issue}</Chip>}
        {badges(card).map((b) => (
          <Chip key={b}>{b}</Chip>
        ))}
        {idle && <Chip>Claude Code 指示待ち</Chip>}
        {managed.map(({ s, info }) => (
          <button
            key={s.sessionId}
            type="button"
            onClick={() => go({ name: "session", machine: machine.id, sessionId: s.sessionId })}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-black/[0.04] px-1.5 py-0.5 hover:text-foreground dark:bg-white/[0.06]"
            title="このセッションを開く"
          >
            <StatusDot status={s.status} />
            <span className="truncate">{sessionLabel(info)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-black/[0.04] px-1.5 py-0.5 dark:bg-white/[0.06]">{children}</span>;
}

/** Chooses the repositories each working server's kanban watches. */
function ReposDialog({ open, onClose, machines }: { open: boolean; onClose: () => void; machines: MachineInfo[] }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (open) setPicked(Object.fromEntries(machines.map((m) => [m.id, m.kanbanRepos ?? []])));
    // Only when it opens: what is ticked stays while the machines change.
  }, [open]);

  const toggle = (machine: string, p: string) =>
    setPicked((cur) => {
      const list = cur[machine] ?? [];
      return { ...cur, [machine]: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] };
    });
  const save = () => {
    for (const m of machines) {
      const next = picked[m.id] ?? [];
      if (JSON.stringify(next) !== JSON.stringify(m.kanbanRepos ?? [])) watchKanbanRepos(m.id, next);
    }
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content className={cn(DIALOG_PANEL, "w-[min(36rem,calc(100vw-2rem))] space-y-4")}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="text-base font-semibold tracking-tight">見る repo</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                選んだ repo の worktree と自分の PR を、working server の gh で 1 分おきに読みます。一覧に出るのは、Claude Code が信頼しているフォルダーにある repo です。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="閉じる">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          {machines.map((m) => {
            const list = picked[m.id] ?? [];
            const options = m.kanbanOptions ?? [];
            // Chosen before, but no longer among the options: shown so they can be taken off.
            const gone = list.filter((p) => !options.some((o) => o.path === p));
            return (
              <section key={m.id} className="space-y-2">
                {machines.length > 1 && <h3 className="text-sm font-medium">{m.name}</h3>}
                {options.length === 0 && gone.length === 0 ? (
                  <p className="text-xs text-muted-foreground">選べる repo がありません。</p>
                ) : (
                  <ul className="max-h-[50dvh] space-y-1 overflow-y-auto rounded-xl border border-border p-1">
                    {[...options, ...gone.map((path) => ({ path, github: undefined, gone: true }))].map((o) => {
                      const checked = list.includes(o.path);
                      const disabled = (!o.github && !checked) || (!checked && list.length >= MAX_REPOS);
                      return (
                        <li key={o.path}>
                          <label
                            className={cn(
                              "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
                              disabled && "cursor-default opacity-50 hover:bg-transparent",
                            )}
                          >
                            <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={() => toggle(m.id, o.path)} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm">
                                {o.github ?? ("gone" in o ? "見つからない repo" : "GitHub にない repo")}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">{o.path}</span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </Dialog.Close>
            <button type="button" onClick={save} className={BUTTON_PRIMARY}>
              保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The kanban: the worktrees and my pull requests of the watched repositories, in the column of whoever has to move
// next (after 4rtoflow/Dashboard). Each working server's gasho-daemon reads its repositories and decides the columns;
// the repositories are chosen here, per working server, from the repositories in the folders Claude Code trusts there.
// The look follows easyui.site: dark tiles with hairline borders, color only where it tells a state (the column's dot,
// the reason's icon, the next step), and cards that glide to their new column with a spring. On a phone one column shows at a time, picked with a sliding pill.
import {
  ArrowRight,
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  Eye,
  FolderGit2,
  GitCompareArrows,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestCreateArrow,
  GitPullRequestDraft,
  Hand,
  LoaderCircle,
  MessageSquareWarning,
  Moon,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings2,
  SquareKanban,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { KanbanCard, KanbanColumn, KanbanReason, MachineInfo } from "@gasho/protocol";
import { DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DrawCheckbox } from "@/components/ui/draw-checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { relativeTime, sessionLabel } from "@/lib/format";
import { badges, KANBAN_COLUMNS, kanbanCards, kanbanReady, nextStep, reasonText, type PlacedCard } from "@/lib/kanban";
import { DESKTOP, useMediaQuery } from "@/lib/media";
import { motionTransitions } from "@/lib/motion-tokens";
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

/** Each column's dot and count, in the colors Gasho gives the same states elsewhere (amber: needs me; green: working). */
const COLUMN_LOOK: Record<KanbanColumn, { dot: string; tone: BadgeTone; pulse?: boolean }> = {
  mine: { dot: "bg-amber-500", tone: "warning" },
  agent: { dot: "bg-emerald-500", tone: "success", pulse: true },
  github: { dot: "bg-sky-500", tone: "neutral" },
  review: { dot: "bg-violet-400", tone: "neutral" },
  done: { dot: "bg-neutral-500", tone: "neutral" },
};

const REASON_ICON: Record<KanbanReason["kind"], { Icon: LucideIcon; className: string }> = {
  agent_waiting: { Icon: Hand, className: "text-amber-400" },
  agent_working: { Icon: Zap, className: "text-emerald-400" },
  merged: { Icon: GitMerge, className: "text-violet-400" },
  closed: { Icon: GitPullRequestClosed, className: "text-neutral-500" },
  no_pr: { Icon: GitPullRequestCreateArrow, className: "text-neutral-400" },
  conflict: { Icon: GitCompareArrows, className: "text-red-400" },
  ci_failed: { Icon: CircleX, className: "text-red-400" },
  changes_requested: { Icon: MessageSquareWarning, className: "text-red-400" },
  ci_running: { Icon: LoaderCircle, className: "text-sky-400 motion-safe:animate-spin" },
  draft: { Icon: GitPullRequestDraft, className: "text-neutral-400" },
  rereview: { Icon: RotateCw, className: "text-neutral-400" },
  approved: { Icon: CircleCheck, className: "text-emerald-400" },
  review_waiting: { Icon: Eye, className: "text-neutral-400" },
};

const time = (ms: number): string => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

interface Where {
  machines: boolean;
  repos: boolean;
}

export function KanbanView() {
  const { machines } = useAppState();
  const now = useNow(15_000);
  const wide = useMediaQuery(DESKTOP);
  const [choosing, setChoosing] = useState(false);
  const [asked, setAsked] = useState(false);
  const [tab, setTab] = useState<KanbanColumn>("mine");

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
  // Nothing read yet, and nothing failed: the first reading is under way.
  const loading = updatedAt === undefined && errors.length === 0 && ready.some((m) => (m.kanbanRepos?.length ?? 0) > 0);
  // Where the cards come from, on each card only when it is not obvious.
  const where: Where = { machines: new Set(cards.map((c) => c.machine.id)).size > 1, repos: new Set(cards.map((c) => c.card.repo)).size > 1 };
  const byColumn = (id: KanbanColumn) => cards.filter((c) => c.card.column === id);

  useEffect(() => {
    if (!asked) return;
    const t = setTimeout(() => setAsked(false), REFRESH_WAIT_MS);
    return () => clearTimeout(t);
  }, [asked]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">カンバン</h1>
            <p className="text-sm text-muted-foreground">
              {watched} 個の repo・{cards.length} 枚のカード
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {watched > 0 && (
              <Badge variant="outline" tone={stale ? "danger" : "neutral"} dot={stale} title="gasho-daemon が最後に repo を読んだ時刻">
                {updatedAt === undefined ? "まだ読んでいない" : stale ? `${time(updatedAt)} から更新されていない` : `${time(updatedAt)} 更新`}
              </Badge>
            )}
            <Button size="sm" leftIcon={<Settings2 />} onClick={() => setChoosing(true)} disabled={ready.length === 0}>
              見る repo
            </Button>
            {watched > 0 && (
              <Button
                size="sm"
                leftIcon={<RefreshCw />}
                isLoading={checking}
                loadingText="見直し中…"
                disabled={ready.length === 0}
                onClick={() => {
                  setAsked(true);
                  refreshKanban();
                }}
              >
                今すぐ見直す
              </Button>
            )}
          </div>
        </header>

        {errors.length > 0 && (
          <Alert tone="danger">
            <AlertTitle>読めなかった repo があります</AlertTitle>
            <AlertDescription>
              <ul className="space-y-0.5">
                {errors.map((e) => (
                  <li key={`${e.machine.id}/${e.repo}`} className="break-words">
                    {ready.length > 1 && `${e.machine.name} · `}
                    <span className="text-neutral-200">{e.repo}</span>：{e.error}
                  </li>
                ))}
              </ul>
              <p className="mt-1">前に読めたカードは、そのまま出しています。</p>
            </AlertDescription>
          </Alert>
        )}
        {old.length > 0 && (
          <Alert tone="warning">
            <AlertTitle>gasho-daemon を更新してください</AlertTitle>
            <AlertDescription>{old.map((m) => m.name).join("、")} の gasho-daemon は 0.10.0 より前なので、カンバンを出せません。</AlertDescription>
          </Alert>
        )}
        {offline.length > 0 && (
          <Alert>
            <AlertTitle>オフラインの working server があります</AlertTitle>
            <AlertDescription>{offline.map((m) => m.name).join("、")} の repo のカードは、つながるまで出しません。</AlertDescription>
          </Alert>
        )}

        {watched === 0 ? (
          <EmptyState canChoose={ready.length > 0} onChoose={() => setChoosing(true)} />
        ) : wide ? (
          <LayoutGroup>
            <div className="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6">
              <div className="grid auto-cols-[minmax(248px,1fr)] grid-flow-col items-start gap-3">
                {KANBAN_COLUMNS.map((col) => (
                  <Column key={col.id} id={col.id} label={col.label} rows={byColumn(col.id)} loading={loading} now={now} where={where} />
                ))}
              </div>
            </div>
          </LayoutGroup>
        ) : (
          <div className="flex flex-col gap-3">
            <ColumnTabs value={tab} onChange={setTab} count={(id) => byColumn(id).length} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={motionTransitions.springGentle}>
                <Column
                  id={tab}
                  label={KANBAN_COLUMNS.find((c) => c.id === tab)?.label ?? ""}
                  rows={byColumn(tab)}
                  loading={loading}
                  now={now}
                  where={where}
                  heading={false}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        )}

        <ReposDialog open={choosing} onClose={() => setChoosing(false)} machines={ready} />
      </div>
    </MotionConfig>
  );
}

function ColumnDot({ id }: { id: KanbanColumn }) {
  const look = COLUMN_LOOK[id];
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {look.pulse && <span className={cn("absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping", look.dot)} />}
      <span className={cn("relative inline-flex size-2 rounded-full", look.dot)} />
    </span>
  );
}

/** `heading`: false on a phone, where the tab above already names the column and counts its cards. */
function Column({
  id,
  label,
  rows,
  loading,
  now,
  where,
  heading = true,
}: {
  id: KanbanColumn;
  label: string;
  rows: PlacedCard[];
  loading: boolean;
  now: number;
  where: Where;
  heading?: boolean;
}) {
  return (
    <section aria-label={`${label}：${rows.length} 枚`} className={cn(TILE, "flex min-w-0 flex-col", !heading && "pt-2")} style={{ boxShadow: TILE_SHADOW }}>
      {heading && (
        <h2 className="flex items-center gap-2 px-3.5 pt-3 pb-2.5 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          <ColumnDot id={id} />
          {label}
          <Badge tone={rows.length > 0 ? COLUMN_LOOK[id].tone : "neutral"} className="ml-auto h-5 px-2">
            {rows.length}
          </Badge>
        </h2>
      )}
      <div className="flex flex-col gap-2 px-2 pb-2">
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-black/[0.08] px-3 py-5 text-center text-xs text-neutral-500 dark:border-white/[0.06] dark:text-neutral-600">なし</p>
        ) : (
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row) => (
              <motion.div
                key={`${row.machine.id}/${row.card.id}`}
                layout
                layoutId={`kanban/${row.machine.id}/${row.card.id}`}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={motionTransitions.springSmooth}
              >
                <Card row={row} now={now} where={where} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </section>
  );
}

function Card({ row: { machine, card }, now, where }: { row: PlacedCard; now: number; where: Where }) {
  const next = nextStep(card);
  const reason = REASON_ICON[card.reason.kind];
  const updated = card.updatedAt ? Date.parse(card.updatedAt) : undefined;
  // The reason already says when Claude Code works or waits; an idle one is noted, like the Dashboard's "指示待ち".
  const idle = card.sessions.some((s) => !s.managed && s.status === "idle");
  const managed = card.sessions.flatMap((s) => {
    const info = s.managed ? machine.sessions.find((x) => x.sessionId === s.sessionId) : undefined;
    return info ? [{ s, info }] : [];
  });
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border border-black/[0.06] bg-black/[0.015] p-3 transition-colors hover:border-black/[0.12] dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.035]",
        card.column === "done" && "opacity-70 hover:opacity-100",
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100" title={card.path ?? card.branch}>
          {card.label}
        </span>
        {updated !== undefined && (
          <span className="shrink-0 text-[11px] text-neutral-500 tabular-nums" title="PR の最終更新">
            {relativeTime(updated, now)}
          </span>
        )}
      </div>
      {card.pr ? (
        <a
          href={card.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="-mt-1 line-clamp-2 text-xs break-words text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {card.title}
        </a>
      ) : (
        <p className="-mt-1 truncate font-mono text-[11px] text-neutral-500">{card.title}</p>
      )}
      <p className="flex items-start gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
        <reason.Icon className={cn("mt-px size-3.5 shrink-0", reason.className)} />
        <span className="min-w-0 break-words">{reasonText(card.reason)}</span>
      </p>
      {next && (
        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <ArrowRight className="mt-px size-3.5 shrink-0" />
          {next}
        </p>
      )}
      <Chips machine={machine} card={card} where={where} idle={idle}>
        {managed.map(({ s, info }) => (
          <button
            key={s.sessionId}
            type="button"
            onClick={() => go({ name: "session", machine: machine.id, sessionId: s.sessionId })}
            className={cn(CHIP, "max-w-full cursor-pointer text-neutral-700 hover:bg-black/[0.08] dark:text-neutral-300 dark:hover:bg-white/[0.1]")}
            title="このセッションを開く"
          >
            <StatusDot status={s.status} />
            <span className="truncate">{sessionLabel(info)}</span>
          </button>
        ))}
      </Chips>
    </article>
  );
}

const CHIP = "inline-flex h-5 items-center gap-1 rounded-full bg-black/[0.05] px-2 text-[11px] whitespace-nowrap text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-400";

function Chips({ machine, card, where, idle, children }: { machine: MachineInfo; card: KanbanCard; where: Where; idle: boolean; children: ReactNode }) {
  const pr = card.pr && card.label !== `PR #${card.pr.number}` ? card.pr : undefined;
  const marks = badges(card);
  const any = where.machines || where.repos || pr || card.issue !== undefined || marks.length > 0 || idle || card.sessions.some((s) => s.managed);
  if (!any) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {where.machines && (
        <span className={CHIP}>
          <Server className="size-3" />
          {machine.name}
        </span>
      )}
      {where.repos && (
        <span className={CHIP}>
          <FolderGit2 className="size-3" />
          {card.repo.split("/").pop()}
        </span>
      )}
      {pr && (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className={cn(CHIP, "hover:text-neutral-900 dark:hover:text-neutral-200")}>
          PR #{pr.number}
          <ExternalLink className="size-3" />
        </a>
      )}
      {card.issue !== undefined && <span className={CHIP}>Issue #{card.issue}</span>}
      {marks.map((b) => (
        <span key={b} className={cn(CHIP, "bg-transparent ring-1 ring-black/[0.1] ring-inset dark:bg-transparent dark:ring-white/[0.1]")}>
          {b}
        </span>
      ))}
      {idle && (
        <span className={CHIP}>
          <Moon className="size-3" />
          Claude Code 指示待ち
        </span>
      )}
      {children}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="space-y-2.5 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.06]">
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** The columns as tabs, for a phone: a pill slides to the one shown (after EasyUI's Animated Tabs). */
function ColumnTabs({ value, onChange, count }: { value: KanbanColumn; onChange: (id: KanbanColumn) => void; count: (id: KanbanColumn) => number }) {
  return (
    <div className="scrollbar-none -mx-4 overflow-x-auto px-4">
      <div role="tablist" aria-label="列" className="inline-flex gap-1 rounded-full border border-border bg-surface-raised p-1 dark:border-[#1F1F1F] dark:bg-[#0E0E0E]">
        {KANBAN_COLUMNS.map((c) => {
          const active = c.id === value;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(c.id)}
              className={cn(
                "relative flex cursor-pointer items-center rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                active ? "text-foreground" : "text-neutral-500 hover:text-neutral-300",
              )}
            >
              {active && (
                <motion.span
                  layoutId="kanban-column-tab"
                  transition={motionTransitions.springMorph}
                  className="absolute inset-0 rounded-full border border-border-hover bg-surface shadow-xs dark:border-[#1F1F1F] dark:bg-[#141414]"
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <ColumnDot id={c.id} />
                {c.label}
                <span className="text-[11px] text-neutral-500 tabular-nums">{count(c.id)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ canChoose, onChoose }: { canChoose: boolean; onChoose: () => void }) {
  return (
    <div className={cn(TILE, "flex flex-col items-center gap-4 px-6 py-12 text-center")} style={{ boxShadow: TILE_SHADOW }}>
      <span className="grid size-11 place-items-center rounded-xl border border-black/[0.08] bg-black/[0.02] text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-neutral-300">
        <SquareKanban className="size-5" />
      </span>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">見る repo を選んでください</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          選んだ repo の worktree と自分の Pull request を、次に動く人ごとの列に並べます。選べるのは、working server で Claude Code が信頼しているフォルダーにある repo です。
        </p>
      </div>
      <Button variant="primary" size="sm" leftIcon={<Settings2 />} onClick={onChoose} disabled={!canChoose}>
        見る repo を選ぶ
      </Button>
      {!canChoose && <p className="text-xs text-muted-foreground">選べる working server がありません。gasho-daemon 0.10.0 以上の working server がつながると選べます。</p>}
    </div>
  );
}

/** Chooses the repositories each working server's kanban watches. */
function ReposDialog({ open, onClose, machines }: { open: boolean; onClose: () => void; machines: MachineInfo[] }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [query, setQuery] = useState("");
  const [others, setOthers] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Only when it opens: what is ticked stays while the machines change.
    setPicked(Object.fromEntries(machines.map((m) => [m.id, m.kanbanRepos ?? []])));
    setQuery("");
    setOthers(false);
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
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const chosen = Object.values(picked).reduce((n, l) => n + l.length, 0);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content className={cn(DIALOG_PANEL, "flex w-[min(36rem,calc(100vw-2rem))] flex-col gap-4")}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="text-base font-semibold tracking-tight">見る repo</Dialog.Title>
              <Dialog.Description className="text-xs leading-relaxed text-muted-foreground">
                選んだ repo の worktree と自分の PR を、working server の gh で 1 分おきに読みます。working server ごとに {MAX_REPOS} 個まで選べます。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="閉じる">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm transition-colors focus-within:border-border-hover">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="repo の名前やフォルダーで絞り込む"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              spellCheck={false}
            />
          </label>

          {machines.map((m) => {
            const list = picked[m.id] ?? [];
            const options = m.kanbanOptions ?? [];
            const onGitHub = options.filter((o) => o.github && matches(`${o.github} ${o.path}`));
            const elsewhere = options.filter((o) => !o.github && matches(o.path));
            // Chosen before, but no longer among the options: shown first so they can be taken off.
            const gone = list.filter((p) => !options.some((o) => o.path === p) && matches(p));
            return (
              <section key={m.id} className="space-y-2">
                <h3 className="flex items-center gap-2 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  <Server className="size-3.5 text-muted-foreground" />
                  {m.name}
                  <span className="ml-auto text-[11px] font-normal text-muted-foreground tabular-nums">
                    {list.length} / {MAX_REPOS} を選択中
                  </span>
                </h3>
                <ul className="max-h-[45dvh] divide-y divide-black/[0.05] overflow-y-auto rounded-xl border border-border dark:divide-white/[0.05]">
                  {gone.map((p) => (
                    <li key={p} className="px-3 py-2.5">
                      <DrawCheckbox
                        checked
                        onChange={() => toggle(m.id, p)}
                        label={<span className="text-amber-700 dark:text-amber-300">見つからない repo</span>}
                        description={<span className="font-mono break-all">{p}</span>}
                      />
                    </li>
                  ))}
                  {onGitHub.map((o) => {
                    const checked = list.includes(o.path);
                    const [owner, name] = (o.github ?? "").split("/");
                    return (
                      <li key={o.path} className="px-3 py-2.5 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                        <DrawCheckbox
                          checked={checked}
                          disabled={!checked && list.length >= MAX_REPOS}
                          onChange={() => toggle(m.id, o.path)}
                          label={
                            <>
                              <span className="text-muted-foreground">{owner}/</span>
                              <span className="font-medium">{name}</span>
                            </>
                          }
                          description={<span className="font-mono break-all">{o.path}</span>}
                        />
                      </li>
                    );
                  })}
                  {gone.length + onGitHub.length === 0 && (
                    <li className="px-3 py-6 text-center text-xs text-muted-foreground">{q ? "一致する repo がありません。" : "選べる repo がありません。"}</li>
                  )}
                </ul>
                {elsewhere.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <button type="button" onClick={() => setOthers(!others)} aria-expanded={others} className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground">
                      <ChevronDown className={cn("size-3.5 transition-transform", others && "rotate-180")} />
                      GitHub にない repo（{elsewhere.length}）
                    </button>
                    {others && (
                      <ul className="mt-1.5 space-y-0.5 pl-5 font-mono text-[11px]">
                        <li className="font-sans">origin が GitHub にないので、選べません。</li>
                        {elsewhere.map((o) => (
                          <li key={o.path} className="break-all">
                            {o.path}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <span className="text-xs text-muted-foreground tabular-nums">{chosen} 個の repo を見る</span>
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <Button size="sm">キャンセル</Button>
              </Dialog.Close>
              <Button size="sm" variant="primary" onClick={save}>
                保存
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The kanban: the worktrees and my pull requests of the watched repositories (after 4rtoflow/Dashboard), read by
// each working server's gasho-daemon from the repositories chosen here. Nothing decides the columns yet, so every card
// is in the first one; the columns, their widths, views and orders are ready for that. Pressing a card opens its menu:
// instructions sent in one press to Claude in its worktree, its Gasho sessions, and its pull request. The look follows easyui.site: dark tiles with hairline borders,
// color only where it tells a state, and springs. On a phone one column shows at a time, picked with a sliding pill.
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hand,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  SquareKanban,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import { Dialog, DropdownMenu, Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { KanbanAction, KanbanCard, KanbanColumn, MachineInfo, SessionInfo } from "@gasho/protocol";
import { DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DrawCheckbox } from "@/components/ui/draw-checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { relativeTime, sessionLabel } from "@/lib/format";
import {
  arrangeCards,
  COLUMN_WIDTH,
  KANBAN_COLUMNS,
  KANBAN_SORTS,
  kanbanCards,
  kanbanReady,
  type KanbanSort,
  type KanbanSortKey,
  type PlacedCard,
} from "@/lib/kanban";
import {
  clampWidth,
  columnCompact,
  columnWidth,
  setColumnCompact,
  setColumnSort,
  setColumnWidth,
  useKanbanPrefs,
  type KanbanPrefs,
} from "@/lib/kanban-prefs";
import { DESKTOP, useMediaQuery } from "@/lib/media";
import { motionTransitions } from "@/lib/motion-tokens";
import { go } from "@/lib/route";
import { refreshKanban, sendCommand, useAppState, watchKanbanRepos } from "@/lib/store";
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
  // What a card's menu is doing or did: starting a session, sending an instruction.
  const [notice, setNotice] = useState<Notice>();

  const prefs = useKanbanPrefs();
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
      {/* On a computer the board fills the page's height and each column scrolls by itself; on a phone the page scrolls. */}
      <div className={cn("flex flex-col gap-4 p-4 md:p-6", wide && watched > 0 && "h-full min-h-0")}>
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
                {errors.map((e, i) => (
                  // Two clones of one repository have the same name.
                  <li key={`${e.machine.id}/${i}`} className="break-words">
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
            <AlertDescription>{old.map((m) => m.name).join("、")} の gasho-daemon は 0.11.0 より前なので、カンバンを出せません。</AlertDescription>
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
            {/* layoutScroll: cards that move between columns start from where they show, however far the board scrolled. */}
            <motion.div layoutScroll className="-mx-4 min-h-0 flex-1 overflow-x-auto pb-2 pl-4 md:-mx-6 md:pl-6">
              <div className="flex h-full w-max gap-3 pr-4 md:pr-6">
                {KANBAN_COLUMNS.map((col) => (
                  <Column
                    key={col.id}
                    id={col.id}
                    label={col.label}
                    rows={byColumn(col.id)}
                    loading={loading}
                    now={now}
                    where={where}
                    prefs={prefs}
                    onNotice={setNotice}
                    wide
                  />
                ))}
              </div>
            </motion.div>
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
                  prefs={prefs}
                  onNotice={setNotice}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        )}

        <ReposDialog open={choosing} onClose={() => setChoosing(false)} machines={ready} />
        <Toast notice={notice} onClose={() => setNotice(undefined)} />
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

/**
 * One column. `wide`: on the board of a computer, with its heading, a width that can be changed, and its own scroll
 * once its cards pass the bottom of the page; on a phone the tab above names the column and counts its cards, and the
 * column takes the screen's width.
 */
function Column({
  id,
  label,
  rows,
  loading,
  now,
  where,
  prefs,
  onNotice,
  wide = false,
}: {
  id: KanbanColumn;
  label: string;
  rows: PlacedCard[];
  loading: boolean;
  now: number;
  where: Where;
  prefs: KanbanPrefs;
  onNotice: (n: Notice) => void;
  wide?: boolean;
}) {
  // The width while its grip is dragged; stored only when the drag ends.
  const [dragged, setDragged] = useState<number>();
  const width = dragged ?? columnWidth(prefs, id);
  const compact = columnCompact(prefs, id);
  const sort = prefs.sort[id];
  const shown = arrangeCards(rows, sort);
  const column = (
    <section
      aria-label={`${label}：${rows.length} 枚`}
      className={cn(TILE, "relative flex min-w-0 flex-col", wide ? "max-h-full min-h-0" : "pt-2")}
      style={{ boxShadow: TILE_SHADOW }}
    >
      {wide && (
        <h2 className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-2 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          <ColumnDot id={id} />
          <span className="truncate">{label}</span>
          <Badge tone={rows.length > 0 ? COLUMN_LOOK[id].tone : "neutral"} className="ml-auto h-5 px-2">
            {rows.length}
          </Badge>
        </h2>
      )}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-2">
        <SortMenu label={label} sort={sort} onChange={(next) => setColumnSort(id, next)} />
        <ModeSwitch id={id} label={label} compact={compact} onChange={(c) => setColumnCompact(id, c)} />
      </div>
      <motion.div
        layoutScroll
        className={cn(
          "relative flex flex-col px-2 pb-2",
          compact ? "gap-1" : "gap-2",
          // Sideways scrolling over a column goes on to the board.
          wide && "scrollbar-none min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-contain",
        )}
      >
        {loading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-black/[0.08] px-3 py-5 text-center text-xs text-neutral-500 dark:border-white/[0.06] dark:text-neutral-600">なし</p>
        ) : (
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((row) => (
              <motion.div
                key={`${row.machine.id}/${row.card.id}`}
                // Only the position glides: a width or a view that changes shows at once, without the card stretching.
                layout="position"
                layoutId={`kanban/${row.machine.id}/${row.card.id}`}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={motionTransitions.springSmooth}
              >
                {compact ? <CompactCard row={row} now={now} where={where} onNotice={onNotice} /> : <Card row={row} now={now} where={where} onNotice={onNotice} />}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </motion.div>
    </section>
  );
  if (!wide) return column;
  // On the board, the grip sits beside the column in a box as tall as the board, so it is as long in every column
  // however many cards each holds.
  return (
    <div className="relative flex shrink-0 flex-col" style={{ width }}>
      {column}
      <Grip
        label={label}
        width={width}
        onDrag={setDragged}
        onDone={(w) => {
          setDragged(undefined);
          setColumnWidth(id, w);
        }}
      />
    </div>
  );
}

/** The grip on a column's right edge: drag it, or use ← → (with Shift, four times as far); a double click goes back. */
function Grip({
  label,
  width,
  onDrag,
  onDone,
}: {
  label: string;
  width: number;
  /** The width while dragging; undefined when a press ends without a move. */
  onDrag: (w: number | undefined) => void;
  /** The width chosen; undefined goes back to the default one. */
  onDone: (w: number | undefined) => void;
}) {
  const from = useRef<{ x: number; width: number } | null>(null);
  const [active, setActive] = useState(false);
  const at = (x: number) => clampWidth((from.current?.width ?? width) + x - (from.current?.x ?? x));
  const end = (x: number) => {
    if (!from.current) return;
    const w = at(x);
    const moved = w !== from.current.width;
    from.current = null;
    setActive(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    // A press without a move keeps the width as it was, the default one included.
    if (moved) onDone(w);
    else onDrag(undefined);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`${label}の列の幅`}
      aria-valuemin={COLUMN_WIDTH.min}
      aria-valuemax={COLUMN_WIDTH.max}
      aria-valuenow={width}
      title="ドラッグか左右キーで幅を変える（ダブルクリックで元の幅）"
      className={cn(
        "absolute top-3 -right-[9px] bottom-3 z-10 w-1.5 cursor-col-resize touch-none rounded-full outline-none transition-colors hover:bg-white/20 focus-visible:bg-primary",
        active && "bg-primary hover:bg-primary",
      )}
      onPointerDown={(e) => {
        // preventDefault keeps text from being selected, but also keeps the grip from taking focus for ← →.
        e.preventDefault();
        e.currentTarget.focus();
        from.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        // The cursor stays a resize cursor, and no text is selected, while the pointer leaves the grip.
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        if (from.current) onDrag(at(e.clientX));
      }}
      onPointerUp={(e) => end(e.clientX)}
      onPointerCancel={(e) => end(e.clientX)}
      onDoubleClick={() => onDone(undefined)}
      onKeyDown={(e) => {
        const step = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[e.key];
        if (!step) return;
        e.preventDefault();
        onDone(clampWidth(width + step * (e.shiftKey ? 4 : 1)));
      }}
    />
  );
}

const BAR_BUTTON =
  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** The order of a column's cards: the default one, or Issue number, PR number or last update, either way. */
function SortMenu({ label, sort, onChange }: { label: string; sort: KanbanSort | undefined; onChange: (sort: KanbanSort | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const name = sort ? `${KANBAN_SORTS[sort.key].short} ${sort.desc ? "降順" : "昇順"}` : "既定の順";
  const pick = (next: KanbanSort | undefined) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label}の並び：${name}`}
          title={`並びを変える（今は${name}）`}
          className={cn(
            BAR_BUTTON,
            sort
              ? "border-border-hover bg-surface-raised text-foreground"
              : "border-transparent text-neutral-500 hover:border-border hover:text-neutral-300 data-[state=open]:border-border data-[state=open]:text-neutral-300",
          )}
        >
          <ArrowUpDown className="size-3.5" />
          {sort && name}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-64 rounded-xl border border-border bg-surface p-1.5 text-xs shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <button
            type="button"
            aria-pressed={!sort}
            onClick={() => pick(undefined)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-neutral-300 hover:bg-surface-raised aria-pressed:text-foreground"
          >
            <Check className={cn("size-3.5", sort && "invisible")} />
            既定の順
            <span className="ml-auto text-[11px] text-muted-foreground">更新の古い順</span>
          </button>
          <div className="mt-1 space-y-0.5 border-t border-border pt-1">
            {(Object.keys(KANBAN_SORTS) as KanbanSortKey[]).map((key) => (
              <div key={key} role="group" aria-label={KANBAN_SORTS[key].label} className="flex items-center gap-2 px-2 py-1">
                <Check className={cn("size-3.5 shrink-0", sort?.key !== key && "invisible")} />
                <span className="flex-1 text-neutral-300">{KANBAN_SORTS[key].label}</span>
                <span className="inline-flex rounded-md border border-border p-0.5">
                  {[false, true].map((desc) => {
                    const on = sort?.key === key && sort.desc === desc;
                    return (
                      <button
                        key={String(desc)}
                        type="button"
                        aria-pressed={on}
                        title={desc ? KANBAN_SORTS[key].desc : KANBAN_SORTS[key].asc}
                        onClick={() => pick({ key, desc })}
                        className={cn(
                          "cursor-pointer rounded-[5px] px-2 py-0.5 text-[11px] transition-colors",
                          on ? "bg-primary text-primary-foreground" : "text-neutral-400 hover:bg-surface-raised hover:text-foreground",
                        )}
                      >
                        {desc ? "降順" : "昇順"}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
          <p className="px-2 pt-1.5 pb-0.5 text-[11px] leading-relaxed text-muted-foreground">番号や更新の時刻が無いカードは、どちらの向きでも下に並べます。</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 詳細 (the full card) or 簡潔 (one line), with a pill that slides to the one chosen. */
function ModeSwitch({ id, label, compact, onChange }: { id: KanbanColumn; label: string; compact: boolean; onChange: (compact: boolean) => void }) {
  return (
    <div role="group" aria-label={`${label}の表示`} className="ml-auto inline-flex rounded-md border border-border p-0.5">
      {[false, true].map((c) => {
        const on = compact === c;
        return (
          <button
            key={String(c)}
            type="button"
            aria-pressed={on}
            title={c ? "1 行で表示する" : "PR の題・Issue・会話の状態も表示する"}
            onClick={() => onChange(c)}
            className={cn("relative cursor-pointer rounded-[5px] px-2 py-0.5 text-[11px] transition-colors", on ? "text-foreground" : "text-neutral-500 hover:text-neutral-300")}
          >
            {on && <motion.span layoutId={`kanban-mode/${id}`} transition={motionTransitions.springMorph} className="absolute inset-0 rounded-[5px] bg-surface-raised" />}
            <span className="relative">{c ? "簡潔" : "詳細"}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The pull request's state, as an icon in GitHub's colors: none yet, open, draft, merged or closed. */
function prLook(card: KanbanCard): { Icon: LucideIcon; className: string; label: string } {
  if (!card.pr) return { Icon: GitBranch, className: "text-neutral-500", label: "PR なし" };
  if (card.pr.state === "merged") return { Icon: GitMerge, className: "text-violet-400", label: "マージ済み" };
  if (card.pr.state === "closed") return { Icon: GitPullRequestClosed, className: "text-red-400", label: "クローズ済み" };
  if (card.pr.draft) return { Icon: GitPullRequestDraft, className: "text-neutral-400", label: "Draft" };
  return { Icon: GitPullRequest, className: "text-emerald-400", label: "開いている PR" };
}

/** The pull request's state as an icon, named when the pointer rests on it. */
function PrIcon({ card, className }: { card: KanbanCard; className?: string }) {
  const look = prLook(card);
  return (
    <span title={look.label} className={cn("inline-flex shrink-0", className)}>
      <look.Icon className={cn("size-3.5", look.className)} aria-label={look.label} />
    </span>
  );
}

/** What a Claude Code session started outside Gasho is doing; Gasho's own show with their names instead. */
const AGENT: Record<"busy" | "waiting" | "idle", { Icon: LucideIcon; text: string }> = {
  busy: { Icon: Zap, text: "Claude Code 作業中" },
  waiting: { Icon: Hand, text: "Claude Code 答え待ち" },
  idle: { Icon: Moon, text: "Claude Code 指示待ち" },
};

/** One line: the pull request's state, the name and the age. Pressing it opens the card's menu. */
function CompactCard({ row, now, where, onNotice }: { row: PlacedCard; now: number; where: Where; onNotice: (n: Notice) => void }) {
  const { machine, card } = row;
  const updated = card.updatedAt ? Date.parse(card.updatedAt) : undefined;
  const tip = [where.machines && machine.name, where.repos && card.repo, card.title].filter(Boolean).join("\n");
  return (
    <CardMenu row={row} onNotice={onNotice}>
      <button
        type="button"
        title={tip}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-black/[0.06] bg-black/[0.015] px-2.5 py-1.5 text-left text-xs text-neutral-800 transition-colors outline-none hover:border-black/[0.12] focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:border-border-hover dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-neutral-200 dark:hover:border-white/[0.12] dark:hover:bg-white/[0.035]"
      >
        <PrIcon card={card} />
        <span className="min-w-0 flex-1 truncate">{card.label}</span>
        {card.sessions.some((s) => s.status === "busy" || s.status === "waiting") && (
          <StatusDot status={card.sessions.some((s) => s.status === "waiting") ? "waiting" : "busy"} />
        )}
        {updated !== undefined && <span className="shrink-0 text-[11px] text-neutral-500 tabular-nums">{relativeTime(updated, now)}</span>}
      </button>
    </CardMenu>
  );
}

/**
 * The full card. Pressing it anywhere but its session buttons opens the card's menu: a button covers the card under
 * its content, and only the session buttons of the content take the pointer. The pull request opens from the menu
 * only, so a press meant for the menu does not leave for GitHub.
 */
function Card({ row, now, where, onNotice }: { row: PlacedCard; now: number; where: Where; onNotice: (n: Notice) => void }) {
  const { machine, card } = row;
  const updated = card.updatedAt ? Date.parse(card.updatedAt) : undefined;
  const managed = card.sessions.flatMap((s) => {
    const info = s.managed ? machine.sessions.find((x) => x.sessionId === s.sessionId) : undefined;
    return info ? [{ s, info }] : [];
  });
  return (
    <article className="relative flex min-w-0 flex-col rounded-xl border border-black/[0.06] bg-black/[0.015] transition-colors hover:border-black/[0.12] dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.035]">
      <CardMenu row={row} onNotice={onNotice}>
        <button
          type="button"
          aria-label={`${card.label} のメニュー`}
          className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:ring-1 data-[state=open]:ring-border-hover"
        />
      </CardMenu>
      <div className="pointer-events-none relative flex flex-col gap-2 p-3">
        <div className="flex items-baseline gap-2">
          <PrIcon card={card} className="self-center" />
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
          <p className="-mt-1 line-clamp-2 text-xs break-words text-neutral-600 dark:text-neutral-400">{card.title}</p>
        ) : (
          <p className="-mt-1 truncate font-mono text-[11px] text-neutral-500">{card.title}</p>
        )}
        <Chips machine={machine} card={card} where={where}>
          {managed.map(({ s, info }) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => go({ name: "session", machine: machine.id, sessionId: s.sessionId })}
              className={cn(CHIP, "pointer-events-auto max-w-full cursor-pointer text-neutral-700 hover:bg-black/[0.08] dark:text-neutral-300 dark:hover:bg-white/[0.1]")}
              title="このセッションを開く"
            >
              <StatusDot status={s.status} />
              <span className="truncate">{sessionLabel(info)}</span>
            </button>
          ))}
        </Chips>
      </div>
    </article>
  );
}

const CHIP = "inline-flex h-5 items-center gap-1 rounded-full bg-black/[0.05] px-2 text-[11px] whitespace-nowrap text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-400";

function Chips({ machine, card, where, children }: { machine: MachineInfo; card: KanbanCard; where: Where; children: ReactNode }) {
  const pr = card.pr && card.label !== `PR #${card.pr.number}` ? card.pr : undefined;
  // Sessions Gasho did not start, once per state.
  const others = [...new Set(card.sessions.filter((s) => !s.managed && s.status !== "unknown").map((s) => s.status as keyof typeof AGENT))];
  const any = where.machines || where.repos || pr || card.issue !== undefined || !card.path || others.length > 0 || card.sessions.some((s) => s.managed);
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
      {pr && <span className={CHIP}>PR #{pr.number}</span>}
      {card.issue !== undefined && <span className={CHIP}>Issue #{card.issue}</span>}
      {!card.path && <span className={cn(CHIP, "bg-transparent ring-1 ring-black/[0.1] ring-inset dark:bg-transparent dark:ring-white/[0.1]")}>worktree なし</span>}
      {others.map((status) => {
        const a = AGENT[status];
        return (
          <span key={status} className={CHIP}>
            <a.Icon className={cn("size-3", status === "waiting" && "text-amber-400", status === "busy" && "text-emerald-400")} />
            {a.text}
          </span>
        );
      })}
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
      {!canChoose && <p className="text-xs text-muted-foreground">選べる working server がありません。gasho-daemon 0.11.0 以上の working server がつながると選べます。</p>}
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
  useEffect(() => {
    if (!open) return;
    // A working server that connects while this is open starts from what it watches, so saving does not empty it.
    setPicked((cur) => {
      const added = machines.filter((m) => !(m.id in cur));
      return added.length === 0 ? cur : { ...cur, ...Object.fromEntries(added.map((m) => [m.id, m.kanbanRepos ?? []])) };
    });
  }, [open, machines]);

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
            const elsewhere = options.filter((o) => !o.github && !list.includes(o.path) && matches(o.path));
            // Chosen before, but no longer among the options on GitHub: shown first so they can be taken off.
            const gone = list.filter((p) => !options.some((o) => o.path === p && o.github) && matches(p));
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
                        label={
                          <span className="text-amber-700 dark:text-amber-300">
                            {options.some((o) => o.path === p) ? "GitHub にない repo" : "見つからない repo"}
                          </span>
                        }
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

/** How a session started from Gasho was last used: its latest activity, or for one with no conversation, its start. */
const lastUsed = (s: SessionInfo): number => s.lastActivityAt ?? s.startedAt ?? 0;

/** The sessions Gasho started in a card's worktree, the one used last first. Only these take input from Gasho. */
function gashoSessions({ machine, card }: PlacedCard): SessionInfo[] {
  const ids = new Set(card.sessions.filter((s) => s.managed).map((s) => s.sessionId));
  return machine.sessions.filter((s) => ids.has(s.sessionId)).sort((a, b) => lastUsed(b) - lastUsed(a));
}

/** What a card's menu is doing or did, shown at the bottom of the page. */
interface Notice {
  text: string;
  tone?: "danger";
  /** Still going: the notice stays until it is done. */
  busy?: boolean;
  /** The session it went to, to open from the notice. */
  session?: { machine: string; sessionId: string };
}

/** Starts a session in a card's worktree; its id, or undefined (with the reason noticed) when it could not start. */
async function startSession({ machine, card }: PlacedCard, notify: (n: Notice) => void): Promise<string | undefined> {
  if (!card.path) return undefined;
  notify({ text: `${card.label} でセッションを起動しています…`, busy: true });
  const r = await sendCommand(machine.id, { type: "session.launch", cwd: card.path }, 60_000);
  if (r.ok && r.sessionId) return r.sessionId;
  notify({ text: r.error ?? "セッションを起動できませんでした。", tone: "danger" });
  return undefined;
}

/** Sends one of a card's instructions to the Gasho session used last in its worktree, or to one started there for it. */
async function instruct(row: PlacedCard, action: KanbanAction, notify: (n: Notice) => void): Promise<void> {
  const sessionId = gashoSessions(row)[0]?.sessionId ?? (await startSession(row, notify));
  if (!sessionId) return;
  notify({ text: `「${action.label}」を送っています…`, busy: true });
  // A little longer than the Gasho server waits for the working server.
  const r = await sendCommand(row.machine.id, { type: "session.input", sessionId, text: action.prompt }, 160_000);
  const session = { machine: row.machine.id, sessionId };
  if (!r.ok) notify({ text: r.error ?? "指示を送れませんでした。", tone: "danger", session });
  else notify({ text: r.queued ? `「${action.label}」を預けました。作業が終わってから送ります。` : `「${action.label}」を送りました。`, session });
}

/**
 * The menu that opens from a card, from the edge nearest it (after EasyUI's OriginDropdown): the card's instructions,
 * sent in one press to Claude in its worktree; its Gasho sessions to open, or one to start there and open; and its pull
 * request on GitHub. Free instructions are written in the session itself.
 */
function CardMenu({ row, onNotice, children }: { row: PlacedCard; onNotice: (n: Notice) => void; children: ReactElement }) {
  const { machine, card } = row;
  const [open, setOpen] = useState(false);
  // A touch opens the menu on a tap, not when the finger lands: a swipe over the cards must only scroll the page.
  const touch = useRef(false);
  const sessions = gashoSessions(row);
  const actions = card.actions ?? [];
  const canStart = Boolean(card.path && machine.canLaunch);
  const reachable = sessions.length > 0 || canStart;
  const hint = !card.path
    ? "worktree が無いので、Claude に指示を送れません。"
    : !reachable
      ? "この working server には zellij が無いので、セッションを起動できません。"
      : undefined;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        asChild
        onPointerDown={(e) => {
          touch.current = e.pointerType !== "mouse";
          // Keeps Radix from opening the menu now.
          if (touch.current) e.preventDefault();
        }}
        onClick={() => {
          if (touch.current) setOpen((o) => !o);
          touch.current = false;
        }}
      >
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            MENU,
            "origin-(--radix-dropdown-menu-content-transform-origin) data-[side=bottom]:slide-in-from-top-1.5 data-[side=left]:slide-in-from-right-1.5 data-[side=right]:slide-in-from-left-1.5 data-[side=top]:slide-in-from-bottom-1.5",
          )}
        >
          <DropdownMenu.Label className="truncate px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">{card.label}</DropdownMenu.Label>
          {actions.length > 0 && (
            <>
              {actions.map((a) => (
                <DropdownMenu.Item key={a.label} disabled={!reachable} onSelect={() => void instruct(row, a, onNotice)} className={MENU_ITEM} title={a.prompt}>
                  <Send />
                  <span className="truncate">{a.label}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border" />
            </>
          )}
          {sessions.map((s) => (
            <DropdownMenu.Item key={s.sessionId} onSelect={() => go({ name: "session", machine: machine.id, sessionId: s.sessionId })} className={MENU_ITEM}>
              <span className="flex size-4 items-center justify-center">
                <StatusDot status={s.status} />
              </span>
              <span className="truncate">{sessionLabel(s)} を開く</span>
            </DropdownMenu.Item>
          ))}
          {sessions.length === 0 && (
            <DropdownMenu.Item
              disabled={!canStart}
              onSelect={() =>
                void startSession(row, onNotice).then((sessionId) => {
                  if (!sessionId) return;
                  onNotice({ text: `${card.label} でセッションを起動しました。`, session: { machine: machine.id, sessionId } });
                  go({ name: "session", machine: machine.id, sessionId });
                })
              }
              className={MENU_ITEM}
            >
              <Plus />
              セッションを起動して開く
            </DropdownMenu.Item>
          )}
          {card.pr && (
            <DropdownMenu.Item asChild className={MENU_ITEM}>
              <a href={card.pr.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                PR #{card.pr.number} を GitHub で開く
              </a>
            </DropdownMenu.Item>
          )}
          {hint && <p className="max-w-64 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{hint}</p>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A notice at the bottom of the page (after EasyUI's VelocityToast); it goes after a few seconds once nothing is going on. */
function Toast({ notice, onClose }: { notice: Notice | undefined; onClose: () => void }) {
  useEffect(() => {
    if (!notice || notice.busy) return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
    // Restarts only for a new notice.
  }, [notice]);
  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          key={notice.text}
          role={notice.tone === "danger" ? "alert" : "status"}
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={motionTransitions.springSnappy}
          className={cn(
            "fixed bottom-4 left-1/2 z-[95] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border bg-surface px-4 py-2.5 text-sm shadow-xl",
            notice.tone === "danger" ? "border-red-500/40 text-red-300" : "border-border text-foreground",
          )}
        >
          {notice.busy && <LoaderCircle className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />}
          <span className="min-w-0">{notice.text}</span>
          {notice.session && !notice.busy && (
            <button
              type="button"
              onClick={() => {
                const { machine, sessionId } = notice.session ?? {};
                onClose();
                if (machine && sessionId) go({ name: "session", machine, sessionId });
              }}
              className="shrink-0 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              セッションを開く
            </button>
          )}
          {!notice.busy && (
            <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

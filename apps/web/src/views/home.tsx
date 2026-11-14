// The home screen: a dashboard of tiles of several sizes (a bento grid). On a computer, four columns: the states of
// the sessions and the instructions sent lately as number tiles, the sessions as the largest tile, the notifications,
// the tokens used, then the latest operations and the working servers, with the plugins' tiles among them. On a
// phone, the number tiles two by two and the rest one under the other. Only sessions started from Gasho are shown.
import {
  CircleDot,
  Cpu,
  GitFork,
  Hand,
  Layers,
  Moon,
  Pencil,
  Plus,
  Puzzle,
  Rocket,
  Send,
  Server,
  Square,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type {
  GashoNotification,
  MachineHookEvent,
  MachineInfo,
  SessionInfo,
  SessionStatus,
  TokenUsage,
} from "@gasho/protocol";
import { EFFORTS } from "@/components/session-controls";
import { StatusBadge } from "@/components/status-badge";
import { NotificationStack, type NotificationItem } from "@/components/ui/notification-stack";
import { CHART_BLUE, StatCard, TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { branchLabel, formatCost, relativeTime, repoLabel, sessionLabel, waitingLabel } from "@/lib/format";
import { go } from "@/lib/route";
import { notificationShown, shownSessions } from "@/lib/sessions";
import { markRead, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { usePluginTiles, type PluginTile } from "@/plugins/parts";
import { LaunchPanel } from "@/views/launch";

interface Row {
  machine: MachineInfo;
  s: SessionInfo;
}

const NOTIFICATION_TYPE: Record<GashoNotification["kind"], NotificationItem["type"]> = {
  done: "success",
  permission: "warning",
  idle: "info",
  error: "warning",
};

/** Waiting first (they need an answer), then working, then idle; the latest activity first within each. */
const STATUS_ORDER: Record<SessionStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3 };
const HOUR = 3600_000;
/** The snapshot the Gasho server sends holds this many of the latest events (Store.recentEvents). */
const SNAPSHOT_EVENTS = 200;
/** Sessions shown before "すべて表示". */
const SESSIONS_SHOWN = 9;
/** Operations shown in their tile. */
const OPERATIONS_SHOWN = 6;

/** Gasho's own tiles in their order, by the ids that plugins' tiles name in `after` (docs/plugins.md, P6). */
const TILE_IDS = ["busy", "waiting", "idle", "sent", "sessions", "notifications", "tokens", "tokenBreakdown", "operations", "machines"];
const isTile = (id: string): boolean => TILE_IDS.includes(id);

/**
 * The order with the plugins' tiles: each after the tile it names in `after` (after the plugin tiles already put
 * there), or at the end.
 */
function withPluginTiles(ids: readonly string[], tiles: readonly PluginTile[]): string[] {
  const out = [...ids];
  const placed = new Map<string, number>();
  for (const t of tiles) {
    const at = t.after ? out.indexOf(t.after) : -1;
    if (at < 0) {
      out.push(t.id);
      continue;
    }
    const n = placed.get(t.after ?? "") ?? 0;
    out.splice(at + 1 + n, 0, t.id);
    placed.set(t.after ?? "", n + 1);
  }
  return out;
}

function openSession(machine: string, sessionId: string): void {
  go({ name: "session", machine, sessionId });
}

export function HomeView() {
  const { machines, notifications, events } = useAppState();
  const now = useNow();
  const [launching, setLaunching] = useState(false);

  const rows = useMemo<Row[]>(
    () =>
      machines
        .flatMap((machine) => shownSessions(machine).map((s) => ({ machine, s })))
        .sort(
          (a, b) =>
            STATUS_ORDER[a.machine.connected ? a.s.status : "unknown"] - STATUS_ORDER[b.machine.connected ? b.s.status : "unknown"] ||
            (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0),
        ),
    [machines],
  );
  const online = rows.filter((r) => r.machine.connected);
  const count = (status: SessionStatus) => online.filter((r) => r.s.status === status).length;
  // Under each count, the sessions it counts.
  const names = (status: SessionStatus) => {
    const list = online.filter((r) => r.s.status === status).map((r) => sessionLabel(r.s));
    if (list.length === 0) return "なし";
    return list.length <= 2 ? list.join("、") : `${list.slice(0, 2).join("、")} ほか ${list.length - 2} 件`;
  };
  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines));
  const sent = useMemo(() => sentTrend(events, now), [events, now]);
  const tokens = useMemo(() => tokenTrend(rows, now), [rows, now]);
  // The plugins' tiles, each after the tile it names (see withPluginTiles).
  const pluginTiles = usePluginTiles();
  const order = withPluginTiles(TILE_IDS, pluginTiles);
  const pluginById = new Map(pluginTiles.map((t) => [t.id, t]));
  /** The plugins' tiles between Gasho's tile `id` and the next of Gasho's own. */
  const after = (id: string) => {
    const out: ReactNode[] = [];
    for (let i = order.indexOf(id) + 1; i < order.length && !isTile(order[i] ?? ""); i++) {
      const t = pluginById.get(order[i] ?? "");
      if (t) {
        out.push(
          <div key={t.id} className={t.className}>
            {t.content}
          </div>,
        );
      }
    }
    return out;
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ホーム</h1>
          <p className="text-sm text-muted-foreground">
            {machines.length} 台の working server・{rows.length} セッション
          </p>
        </div>
        {!launching && (
          <button
            type="button"
            onClick={() => setLaunching(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" />
            新しいセッション
          </button>
        )}
      </div>

      {launching && <LaunchPanel onClose={() => setLaunching(false)} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {/* The meters: each state's share of the sessions, in the colors of the state dots elsewhere in Gasho. */}
        <StatCard
          label="作業中"
          icon={<Zap className="size-3.5" />}
          value={count("busy")}
          period={names("busy")}
          meter={{ total: online.length, color: "#10b981" }}
        />
        {after("busy")}
        <StatCard
          label="確認待ち"
          icon={<Hand className="size-3.5" />}
          value={count("waiting")}
          period={names("waiting")}
          valueClassName={count("waiting") > 0 ? "text-amber-400 dark:text-amber-400" : undefined}
          meter={{ total: online.length, color: "#f59e0b" }}
        />
        {after("waiting")}
        <StatCard
          label="待機中"
          icon={<Moon className="size-3.5" />}
          value={count("idle")}
          period={names("idle")}
          meter={{ total: online.length, color: "#737373" }}
        />
        {after("idle")}
        <StatCard
          label="送った指示"
          icon={<Send className="size-3.5" />}
          value={sent.total}
          trend={sent.trend}
          trendLabels={sent.labels}
          {...(sent.previous !== undefined ? { previous: sent.previous, deltaLabel: "前の24時間と比べて" } : {})}
          goodWhen="neither"
          period="過去24時間"
          color={CHART_BLUE}
        />
        {after("sent")}

        <Tile title="セッション" icon={<Layers className="size-4" />} className="col-span-2 lg:col-span-3">
          <Sessions rows={rows} now={now} onLaunch={() => setLaunching(true)} />
        </Tile>
        {after("sessions")}

        <Tile className="col-span-2 lg:col-span-1 lg:row-span-2">
          <NotificationStack
            notifications={unread.map((n) => ({
              id: n.id,
              title: n.title,
              description: n.body ?? "",
              type: NOTIFICATION_TYPE[n.kind],
              time: relativeTime(n.at, now),
            }))}
            onDismiss={(id) => markRead([id])}
            onSelect={(id) => {
              const n = unread.find((x) => x.id === id);
              if (!n) return;
              markRead([id]);
              openSession(n.machine, n.sessionId);
            }}
          />
        </Tile>
        {after("notifications")}

        <StatCard
          label="トークン"
          icon={<Cpu className="size-3.5" />}
          value={tokens.total}
          trend={tokens.trend}
          trendLabels={tokens.labels}
          {...(tokens.previous ? { previous: tokens.previous, deltaLabel: "前の24時間と比べて" } : {})}
          goodWhen="neither"
          period="過去24時間（サブエージェントを含む）"
          format={compact}
          color={CHART_BLUE}
          className="col-span-2 lg:col-span-1"
        />
        {after("tokens")}
        <Tile title="トークンの内訳（過去24時間）" icon={<Cpu className="size-4" />} className="col-span-2">
          <TokenBreakdown tokens={tokens} />
        </Tile>
        {after("tokenBreakdown")}

        <Tile title="最近の操作" icon={<CircleDot className="size-4" />} className="col-span-2">
          <Operations events={events} machines={machines} now={now} />
        </Tile>
        {after("operations")}
        <Tile title="working server" icon={<Server className="size-4" />} className="col-span-2 lg:col-span-1">
          <Machines machines={machines} now={now} />
        </Tile>
        {after("machines")}
      </div>
    </div>
  );
}

/** A tile of the grid, with the same surface as the number tiles. */
function Tile({ title, icon, className, children }: { title?: string; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn(TILE, "flex flex-col p-4", className)} style={{ boxShadow: TILE_SHADOW }}>
      {title && (
        <h2 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          <span className="text-neutral-500">{icon}</span>
          {title}
        </h2>
      )}
      <div className="@container min-h-0 flex-1">{children}</div>
    </section>
  );
}

const compactFormat = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });
const plainFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
/** 75,808 → "7.6万", 1,847 → "1,847": token counts at a glance. */
const compact = (n: number) => (n < 10_000 ? plainFormat.format(n) : compactFormat.format(n));
/** A share in percent, one decimal; a share too small for that is not shown as 0. */
const share = (part: number, whole: number) => {
  const pct = whole > 0 ? (part / whole) * 100 : 0;
  return pct > 0 && pct < 0.1 ? "0.1% 未満" : `${Math.round(pct * 10) / 10}%`;
};
const sumUsage = (u: TokenUsage) => u.input + u.output + u.cacheWrite + u.cacheRead;

/**
 * The kinds of tokens, in the order of the validated categorical palette (dark steps, all checks passed against the
 * tiles' surface #0b0b0c): the colors follow the kind, never its size.
 */
const TOKEN_KINDS: { key: keyof TokenUsage; name: string; color: string }[] = [
  { key: "input", name: "入力", color: "#3987e5" },
  { key: "output", name: "出力", color: "#d95926" },
  { key: "cacheWrite", name: "キャッシュへの書き込み", color: "#199e70" },
  { key: "cacheRead", name: "キャッシュからの読み込み", color: "#c98500" },
];

interface TokenTrend {
  /** The last 24 hours, in all, in twelve 2-hour steps, per kind and per session (the most first). */
  total: number;
  trend: number[];
  labels: string[];
  byKind: TokenUsage;
  bySession: { key: string; label: string; total: number }[];
  /** The 24 hours before, when any tokens were used then. */
  previous?: number;
}

/** The tokens the shown sessions used in the last 24 hours (the current hour and the 23 before it). */
function tokenTrend(rows: Row[], now: number): TokenTrend {
  const hourNow = Math.floor(now / HOUR) * HOUR;
  const start = hourNow - 23 * HOUR;
  const steps = Array.from({ length: 12 }, () => 0);
  const byKind: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const bySession: TokenTrend["bySession"] = [];
  let previous = 0;
  for (const { machine, s } of rows) {
    let mine = 0;
    for (const [hour, u] of s.tokenHours ?? []) {
      const n = sumUsage(u);
      if (hour >= start && hour <= hourNow) {
        const i = Math.floor((hour - start) / (2 * HOUR));
        steps[i] = (steps[i] ?? 0) + n;
        for (const k of TOKEN_KINDS) byKind[k.key] += u[k.key];
        mine += n;
      } else if (hour >= start - 24 * HOUR && hour < start) previous += n;
    }
    if (mine > 0) bySession.push({ key: `${machine.id}/${s.sessionId}`, label: sessionLabel(s), total: mine });
  }
  const hm = (ms: number) => `${new Date(ms).getHours()}時`;
  return {
    total: sumUsage(byKind),
    trend: steps,
    labels: steps.map((_, i) => `${hm(start + i * 2 * HOUR)}〜${hm(start + (i + 1) * 2 * HOUR)}`),
    byKind,
    bySession: bySession.sort((a, b) => b.total - a.total),
    ...(previous > 0 ? { previous } : {}),
  };
}

/**
 * The last 24 hours' tokens by kind (a thin bar of the whole, then each kind with its swatch, amount and share) and by
 * session (bars from a common baseline, the most first).
 */
function TokenBreakdown({ tokens }: { tokens: TokenTrend }) {
  if (tokens.total === 0) return <p className="text-sm text-muted-foreground">過去24時間に使ったトークンはありません。</p>;
  const max = tokens.bySession[0]?.total ?? 0;
  return (
    <div className="grid gap-5 @xl:grid-cols-2">
      <div className="space-y-3">
        {/* The whole, split by kind: a 2px gap of the surface between the parts, no text on the bar. */}
        <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden>
          {TOKEN_KINDS.filter((k) => tokens.byKind[k.key] > 0).map((k) => (
            <div key={k.key} style={{ flexGrow: tokens.byKind[k.key], backgroundColor: k.color }} />
          ))}
        </div>
        <ul className="space-y-1.5 text-xs">
          {TOKEN_KINDS.map((k) => (
            <li key={k.key} className="flex items-center gap-2">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: k.color }} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{k.name}</span>
              <span className="tabular-nums text-foreground">{compact(tokens.byKind[k.key])}</span>
              <span className="w-16 text-right tabular-nums text-muted-foreground">{share(tokens.byKind[k.key], tokens.total)}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          キャッシュからの読み込みは、それまでの会話を毎回読み直した分です。
        </p>
      </div>
      <ul className="space-y-2" aria-label="セッションごとのトークン">
        {tokens.bySession.slice(0, 5).map((t) => (
          <li key={t.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">{t.label}</span>
              <span className="shrink-0 tabular-nums text-foreground">{compact(t.total)}</span>
            </div>
            {/* A thin bar from a common baseline: square at the start, rounded at the data end. */}
            <div className="h-2 rounded-r-[4px] bg-white/[0.04]">
              <div className="h-full rounded-r-[4px]" style={{ width: `${max ? Math.max(2, (t.total / max) * 100) : 0}%`, backgroundColor: CHART_BLUE }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The instructions sent from Gasho in the last 24 hours, in twelve 2-hour steps, and in the 24 hours before when the
 * events on hand reach back that far.
 */
function sentTrend(events: MachineHookEvent[], now: number): { total: number; trend: number[]; labels: string[]; previous?: number } {
  const sent = events.filter((e) => e.event === "Gasho:session.input").map((e) => e.at);
  const start = now - 24 * HOUR;
  const trend = Array.from({ length: 12 }, (_, i) => {
    const from = start + i * 2 * HOUR;
    return sent.filter((at) => at >= from && at < from + 2 * HOUR).length;
  });
  const labels = Array.from({ length: 12 }, (_, i) => {
    const from = new Date(start + i * 2 * HOUR);
    const to = new Date(start + (i + 1) * 2 * HOUR);
    const hm = (d: Date) => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    return `${hm(from)}〜${hm(to)}`;
  });
  const total = trend.reduce((a, b) => a + b, 0);
  // All events are on hand when fewer than a snapshot holds arrived, or when the oldest is older than 48 hours.
  const oldest = events[0]?.at ?? now;
  const covered = events.length < SNAPSHOT_EVENTS || oldest <= now - 48 * HOUR;
  const previous = covered ? sent.filter((at) => at >= now - 48 * HOUR && at < start).length : undefined;
  return { total, trend, labels, ...(previous !== undefined ? { previous } : {}) };
}

function Sessions({ rows, now, onLaunch }: { rows: Row[]; now: number; onLaunch: () => void }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">Gasho から起動したセッションはまだありません。</p>
        <button
          type="button"
          onClick={onLaunch}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:border-border-hover"
        >
          <Rocket className="size-4" />
          セッションを起動する
        </button>
      </div>
    );
  }
  const shown = all ? rows : rows.slice(0, SESSIONS_SHOWN);
  return (
    <>
      <ul className="grid gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
        {shown.map((r) => (
          <li key={`${r.machine.id}/${r.s.sessionId}`}>
            <SessionCard row={r} now={now} />
          </li>
        ))}
      </ul>
      {rows.length > SESSIONS_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className="mt-3 text-xs text-muted-foreground hover:text-foreground">
          {all ? "少なく表示" : `すべて表示（${rows.length}）`}
        </button>
      )}
    </>
  );
}

function SessionCard({ row: { machine, s }, now }: { row: Row; now: number }) {
  const waiting = machine.connected && s.status === "waiting";
  const branch = branchLabel(s);
  const effort = EFFORTS.find((e) => e.id === s.effort)?.name;
  const cost = formatCost(s.costUSD);
  return (
    <button
      type="button"
      onClick={() => openSession(machine.id, s.sessionId)}
      className={cn(
        "flex h-full w-full min-w-0 flex-col gap-2 rounded-xl p-3 text-left ring-1 transition-colors",
        waiting ? "bg-amber-500/[0.06] ring-amber-500/40 hover:ring-amber-500/60" : "bg-white/[0.03] ring-white/[0.06] hover:bg-white/[0.05] hover:ring-white/[0.12]",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {machine.connected ? <StatusBadge status={s.status} /> : <span>オフライン</span>}
        <span className="shrink-0">{relativeTime(s.lastActivityAt, now)}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{sessionLabel(s)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {repoLabel(s)}
          {branch && ` · ${branch}`}
          {` · ${machine.name}`}
        </p>
      </div>
      {waiting && <p className="text-xs text-amber-400">{waitingLabel(s.waitingFor) ?? "確認を待っています"}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {s.model && <Chip>{s.model.replace(/\s*\(default\)\s*$/i, "")}</Chip>}
        {effort && <Chip>{effort}</Chip>}
        {s.ultracode && <Chip className="bg-violet-500/15 text-violet-200">Ultracode</Chip>}
        {s.pendingInputs ? <Chip className="bg-amber-500/10 text-amber-300">送信待ち {s.pendingInputs}</Chip> : null}
        {s.tokens && sumUsage(s.tokens) > 0 && (
          <span className="ml-auto tabular-nums" title="このセッションでこれまでに使ったトークン（サブエージェントを含む）">
            {compact(sumUsage(s.tokens))} トークン
          </span>
        )}
        {cost && <span className={cn("tabular-nums", !(s.tokens && sumUsage(s.tokens) > 0) && "ml-auto")}>{cost}</span>}
      </div>
    </button>
  );
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rounded-md bg-white/[0.06] px-1.5 py-0.5", className)}>{children}</span>;
}

/** The operations shown, by the event the Gasho server records for each, with their icons. */
const OPERATION_ICONS: Record<string, LucideIcon> = {
  "Gasho:session.launch": Rocket,
  "Gasho:session.input": Send,
  "Gasho:session.interrupt": Square,
  "Gasho:session.rename": Pencil,
  "Gasho:session.fork": GitFork,
  "Gasho:session.remove": Trash2,
  "Gasho:plugin.call": Puzzle,
  "Gasho:plugin.enable": Puzzle,
  "Gasho:plugin.machines": Puzzle,
  "Gasho:plugin.setting": Puzzle,
};

/**
 * What Gasho was asked to do lately: starting, forking, renaming and removing sessions, instructions and stops (the
 * Gasho server's records).
 */
function Operations({ events, machines, now }: { events: MachineHookEvent[]; machines: MachineInfo[]; now: number }) {
  const items = events
    .filter((e) => Object.hasOwn(OPERATION_ICONS, e.event))
    .slice(-OPERATIONS_SHOWN)
    .reverse();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">まだ操作はありません。</p>;
  return (
    <ol className="space-y-0.5">
      {items.map((e, i) => {
        const m = machines.find((x) => x.id === e.machine);
        const s = m?.sessions.find((x) => x.sessionId === e.sessionId);
        const Icon = OPERATION_ICONS[e.event] ?? Send;
        const what = operationText(e);
        // A launch's session is not known yet, a removed one is gone, and a plugin's record may have none: these show
        // the working server instead (or "プラグイン").
        const where = s
          ? sessionLabel(s)
          : !e.sessionId || e.event === "Gasho:session.launch" || e.event === "Gasho:session.remove"
            ? (m?.name ?? (e.event.startsWith("Gasho:plugin.") ? "プラグイン" : ""))
            : "終了したセッション";
        const body = (
          <>
            <Icon className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{what}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {where} · {relativeTime(e.at, now)}
              </span>
            </span>
          </>
        );
        return (
          <li key={`${e.at}-${i}`}>
            {s && m ? (
              <button
                type="button"
                onClick={() => openSession(m.id, s.sessionId)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]"
              >
                {body}
              </button>
            ) : (
              <div className="flex items-start gap-2.5 px-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** One record in words: the instruction's text, or what was done. The device that asked is left out. */
function operationText(e: MachineHookEvent): string {
  const summary = (e.summary ?? "").replace(/\s*\(by [^)]*\)\s*$/, "");
  // The plugins (docs/plugins.md): "Name [on]", "Name：where", "Name：label = value", "Name：what was done".
  if (e.event === "Gasho:plugin.enable") {
    const on = summary.endsWith("[on]");
    return `プラグインを${on ? "有効" : "無効"}にした：${summary.replace(/\s*\[(on|off)\]$/, "")}`;
  }
  if (e.event === "Gasho:plugin.machines") return `プラグインを動かす working server を変更：${summary}`;
  if (e.event === "Gasho:plugin.setting") return `プラグインの設定を変更：${summary.replace(/ = .*$/, "")}`;
  if (e.event === "Gasho:plugin.call") return summary;
  if (e.event === "Gasho:session.launch") return `起動：${summary.split("/").filter(Boolean).pop() ?? summary}`;
  if (e.event === "Gasho:session.interrupt") return "作業を止めた";
  // The new name, the fork's name, the removed session's name.
  if (e.event === "Gasho:session.rename") return summary ? `名前を変更：${summary}` : "名前を変えた";
  if (e.event === "Gasho:session.fork") return summary ? `フォーク：${summary}` : "フォークした";
  if (e.event === "Gasho:session.remove") return summary ? `削除：${summary}` : "セッションを削除した";
  const text = summary.replace(/\s*\[(model|effort|ultracode|file|via): [^\]]*\]/g, "").trim();
  const files = (summary.match(/\[file: /g) ?? []).length;
  return text || (files > 0 ? `ファイルを ${files} 件送った` : "指示を送った");
}

function Machines({ machines, now }: { machines: MachineInfo[]; now: number }) {
  if (machines.length === 0) return <p className="text-sm text-muted-foreground">登録された working server はありません。</p>;
  return (
    <ul className="space-y-2.5">
      {machines.map((m) => (
        <li key={m.id} className="flex items-start gap-2.5">
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", m.connected ? "bg-emerald-500" : "bg-neutral-600")} aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
            <p className="text-xs text-muted-foreground">
              {m.connected
                ? `接続中・セッション ${shownSessions(m).length}${m.daemonVersion ? `・gasho-daemon ${m.daemonVersion}` : ""}`
                : `オフライン・最後の接続 ${relativeTime(m.lastSeen, now)}`}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

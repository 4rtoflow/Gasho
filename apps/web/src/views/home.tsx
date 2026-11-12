// The home screen: a dashboard of tiles of several sizes (a bento grid). On a computer, four columns: the states of
// the sessions and the instructions sent lately as number tiles, the sessions as the largest tile, then the
// notifications, the latest operations, the open issues and pull requests, and the working servers. On a phone, the
// number tiles two by two and the rest one under the other. Only sessions started from Gasho are shown.
import { CircleDot, FolderGit2, GitPullRequest, Hand, Layers, Moon, Plus, Rocket, Send, Server, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  GashoNotification,
  GitHubListKind,
  GitHubRepo,
  MachineHookEvent,
  MachineInfo,
  SessionInfo,
  SessionStatus,
} from "@gasho/protocol";
import { EFFORTS } from "@/components/session-controls";
import { StatusBadge } from "@/components/status-badge";
import { NotificationStack, type NotificationItem } from "@/components/ui/notification-stack";
import { CHART_BLUE, StatCard, TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { branchLabel, formatCost, relativeTime, repoLabel, sessionLabel, waitingLabel } from "@/lib/format";
import { go } from "@/lib/route";
import { daemonAtLeast, notificationShown, shownSessions } from "@/lib/sessions";
import { githubKey, loadGitHubList, markRead, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
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
/** The open issues and pull requests on the home screen are read again when older than this. */
const GITHUB_STALE_MS = 5 * 60_000;

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
        <StatCard
          label="確認待ち"
          icon={<Hand className="size-3.5" />}
          value={count("waiting")}
          period={names("waiting")}
          valueClassName={count("waiting") > 0 ? "text-amber-400 dark:text-amber-400" : undefined}
          meter={{ total: online.length, color: "#f59e0b" }}
        />
        <StatCard
          label="待機中"
          icon={<Moon className="size-3.5" />}
          value={count("idle")}
          period={names("idle")}
          meter={{ total: online.length, color: "#737373" }}
        />
        <StatCard
          label="送った指示"
          icon={<Send className="size-3.5" />}
          value={sent.total}
          trend={sent.trend}
          trendLabels={sent.labels}
          {...(sent.previous !== undefined ? { previous: sent.previous, deltaLabel: "前の24時間と比べて" } : {})}
          period="過去24時間"
          color={CHART_BLUE}
        />

        <Tile title="セッション" icon={<Layers className="size-4" />} className="col-span-2 lg:col-span-3 lg:row-span-2">
          <Sessions rows={rows} now={now} onLaunch={() => setLaunching(true)} />
        </Tile>

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

        <Tile title="最近の操作" icon={<CircleDot className="size-4" />} className="col-span-2">
          <Operations events={events} machines={machines} now={now} />
        </Tile>
        <Tile title="GitHub" icon={<FolderGit2 className="size-4" />} className="col-span-2 lg:col-span-1">
          <GitHubCounts rows={rows} />
        </Tile>
        <Tile title="working server" icon={<Server className="size-4" />} className="col-span-2 lg:col-span-1">
          <Machines machines={machines} now={now} />
        </Tile>
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
        {cost && <span className="ml-auto tabular-nums">{cost}</span>}
      </div>
    </button>
  );
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("rounded-md bg-white/[0.06] px-1.5 py-0.5", className)}>{children}</span>;
}

/** What Gasho was asked to do lately: starting sessions, instructions and stops (the Gasho server's records). */
function Operations({ events, machines, now }: { events: MachineHookEvent[]; machines: MachineInfo[]; now: number }) {
  const items = events
    .filter((e) => e.event === "Gasho:session.launch" || e.event === "Gasho:session.input" || e.event === "Gasho:session.interrupt")
    .slice(-OPERATIONS_SHOWN)
    .reverse();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">まだ操作はありません。</p>;
  return (
    <ol className="space-y-0.5">
      {items.map((e, i) => {
        const m = machines.find((x) => x.id === e.machine);
        const s = m?.sessions.find((x) => x.sessionId === e.sessionId);
        const Icon = e.event === "Gasho:session.launch" ? Rocket : e.event === "Gasho:session.interrupt" ? Square : Send;
        const what = operationText(e);
        const where = s ? sessionLabel(s) : e.event === "Gasho:session.launch" ? (m?.name ?? "") : "終了したセッション";
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
  if (e.event === "Gasho:session.launch") return `起動：${summary.split("/").filter(Boolean).pop() ?? summary}`;
  if (e.event === "Gasho:session.interrupt") return "作業を止めた";
  const text = summary.replace(/\s*\[(model|effort|ultracode|file): [^\]]*\]/g, "").trim();
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

/** A repository on GitHub that a shown session works in, with the session (and folder) whose panels show it. */
interface RepoRef {
  github: GitHubRepo;
  machine: string;
  sessionId: string;
  repo?: string;
}

/**
 * The open issues and pull requests of each repository the sessions work in, read with gh on the working server
 * (gasho-daemon 0.7 and later). Each count opens the session's panel with the list.
 */
function GitHubCounts({ rows }: { rows: Row[] }) {
  const { githubLists } = useAppState();
  const repos = useMemo(() => {
    const seen = new Map<string, RepoRef>();
    for (const { machine, s } of rows) {
      if (!machine.connected || !daemonAtLeast(machine, 0, 7)) continue;
      const here: { github: GitHubRepo; repo?: string }[] = s.repos?.length
        ? s.repos.flatMap((r) => (r.github ? [{ github: r.github, repo: r.path }] : []))
        : s.github
          ? [{ github: s.github }]
          : [];
      for (const h of here) {
        const key = `${h.github.owner}/${h.github.name}`.toLowerCase();
        if (!seen.has(key)) seen.set(key, { ...h, machine: machine.id, sessionId: s.sessionId });
      }
    }
    return [...seen.values()];
  }, [rows]);

  // Read each list once, and again when it is old. A list that failed is not asked again on its own.
  useEffect(() => {
    for (const r of repos) {
      for (const kind of ["issues", "pulls"] as const) {
        const g = githubLists[githubKey(r.machine, r.sessionId, kind, r.repo)];
        if (!g || (!g.loading && g.at !== undefined && Date.now() - g.at > GITHUB_STALE_MS)) loadGitHubList(r.machine, r.sessionId, kind, r.repo);
      }
    }
  }, [repos, githubLists]);

  if (repos.length === 0) return <p className="text-sm text-muted-foreground">GitHub のリポジトリで作業しているセッションはありません。</p>;
  return (
    <ul className="space-y-3">
      {repos.map((r) => {
        const list = (kind: GitHubListKind) => githubLists[githubKey(r.machine, r.sessionId, kind, r.repo)];
        const error = list("issues")?.error ?? list("pulls")?.error;
        return (
          <li key={`${r.github.owner}/${r.github.name}`} className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={`${r.github.owner}/${r.github.name}`}>
              {r.github.owner}/{r.github.name}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {(["issues", "pulls"] as const).map((kind) => {
                const g = list(kind);
                const n = g?.list ? `${g.list.items.length}${g.list.truncated ? "+" : ""}` : g?.loading ? "…" : "-";
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => go({ name: "session", machine: r.machine, sessionId: r.sessionId, panel: { kind, ...(r.repo ? { repo: r.repo } : {}) } })}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    {kind === "issues" ? <CircleDot className="size-3.5" /> : <GitPullRequest className="size-3.5" />}
                    {kind === "issues" ? "Issues" : "Pull requests"}
                    <span className="tabular-nums text-foreground">{n}</span>
                  </button>
                );
              })}
            </div>
            {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
          </li>
        );
      })}
    </ul>
  );
}

import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import type { GashoNotification, SessionInfo, SessionStatus } from "@gasho/protocol";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { NotificationStack, type NotificationItem } from "@/components/ui/notification-stack";
import { branchLabel, claudeUrl, relativeTime, repoLabel, sessionLabel, waitingLabel } from "@/lib/format";
import { go } from "@/lib/route";
import { markRead, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";

interface Row {
  id: string;
  /** machine id */
  machine: string;
  machineName: string;
  online: boolean;
  s: SessionInfo;
}

const STATUS_ORDER: Record<SessionStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3 };

const NOTIFICATION_TYPE: Record<GashoNotification["kind"], NotificationItem["type"]> = {
  done: "success",
  permission: "warning",
  idle: "info",
  error: "warning",
};

function openSession(machine: string, sessionId: string): void {
  go({ name: "session", machine, sessionId });
}

export function HomeView() {
  const { machines, notifications } = useAppState();
  const now = useNow();

  const rows = useMemo<Row[]>(
    () =>
      machines.flatMap((m) =>
        m.sessions.map((s) => ({ id: `${m.id}/${s.sessionId}`, machine: m.id, machineName: m.name, online: m.connected, s })),
      ),
    [machines],
  );
  const waiting = rows.filter((r) => r.online && r.s.status === "waiting");
  const unread = notifications.filter((n) => !n.read);

  const columns = useMemo<DataTableColumn<Row>[]>(
    () => [
      {
        key: "label",
        header: "セッション",
        primary: true,
        width: "minmax(0, 2.4fr)",
        accessor: (r) => sessionLabel(r.s),
        cell: (r) => {
          const branch = branchLabel(r.s);
          return (
            <div className="min-w-0">
              <div className="truncate font-medium">{sessionLabel(r.s)}</div>
              <div className="truncate text-xs text-neutral-500">
                {repoLabel(r.s)}
                {branch && ` · ${branch}`}
              </div>
            </div>
          );
        },
      },
      {
        key: "status",
        header: "状態",
        width: "120px",
        accessor: (r) => (r.online ? STATUS_ORDER[r.s.status] : 9),
        cell: (r) => (r.online ? <StatusBadge status={r.s.status} /> : <span className="text-xs text-neutral-500">オフライン</span>),
      },
      { key: "machine", header: "マシン", width: "140px", accessor: (r) => r.machineName },
      {
        key: "updated",
        header: "最終更新",
        width: "110px",
        align: "right",
        accessor: (r) => r.s.lastActivityAt ?? 0,
        cell: (r) => relativeTime(r.s.lastActivityAt, now),
      },
      {
        key: "app",
        header: "公式アプリ",
        width: "96px",
        align: "center",
        sortable: false,
        hideOnMobile: true,
        cell: (r) => {
          const url = claudeUrl(r.s);
          return url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white"
            >
              開く <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-xs text-neutral-600">-</span>
          );
        },
      },
    ],
    [now],
  );

  const items: NotificationItem[] = unread.map((n) => ({
    id: n.id,
    title: n.title,
    description: n.body ?? "",
    type: NOTIFICATION_TYPE[n.kind],
    time: relativeTime(n.at, now),
  }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">ホーム</h1>
        <p className="text-sm text-muted-foreground">
          {machines.length} 台のマシン・{rows.length} セッション
        </p>
      </div>

      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-amber-400">確認を待っているセッション</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {waiting.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => openSession(r.machine, r.s.sessionId)}
                className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-left hover:border-amber-500/60"
              >
                <div className="truncate text-sm font-medium">{sessionLabel(r.s)}</div>
                <div className="text-xs text-muted-foreground">
                  {r.machineName} · {waitingLabel(r.s.waitingFor) ?? "確認待ち"}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <DataTable
            rows={rows}
            columns={columns}
            defaultSort={{ key: "updated", dir: "desc" }}
            searchable
            searchPlaceholder="セッションを検索…"
            searchText={(r) => `${sessionLabel(r.s)} ${r.s.cwd} ${r.s.gitBranch ?? ""} ${r.machineName}`}
            getRowLabel={(r) => sessionLabel(r.s)}
            onRowClick={(r) => openSession(r.machine, r.s.sessionId)}
            selectable={false}
            cardBreakpoint={560}
            pageSize={50}
            ariaLabel="セッション一覧"
            emptyState={<p className="text-sm text-neutral-500">セッションはまだありません。gasho-daemon が接続するとここに出ます。</p>}
          />
        </section>
        <aside>
          <NotificationStack
            notifications={items}
            onDismiss={(id) => markRead([id])}
            onSelect={(id) => {
              const n = unread.find((x) => x.id === id);
              if (!n) return;
              markRead([id]);
              openSession(n.machine, n.sessionId);
            }}
          />
        </aside>
      </div>
    </div>
  );
}

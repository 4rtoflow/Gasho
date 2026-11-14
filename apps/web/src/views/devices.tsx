import { Copy, KeyRound, Laptop, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeviceInfo, PairingCode } from "@gasho/protocol";
import { DaemonUpdates } from "@/components/daemon-updates";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  createPairingCode,
  errorText,
  listDevices,
  renameDevice,
  revokeDevice,
  unregisterThisBrowser,
} from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { becomeUnregistered, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { copyToClipboard } from "@/lib/utils";

const KIND_LABEL: Record<DeviceInfo["kind"], string> = { browser: "ブラウザ", machine: "working server" };

/** Counts down every second; kept separate so the device table is not re-rendered every second. */
function CodePanel({ code }: { code: PairingCode }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.round((code.expiresAt - now) / 1000));
  const command = `node apps/daemon/src/cli.ts register --server ${location.origin} --code ${code.code}`;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-background p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-3xl tracking-[0.2em]">{code.code}</span>
        <span className={left > 0 ? "text-xs text-muted-foreground" : "text-xs text-red-400"}>
          {left > 0 ? `あと ${Math.floor(left / 60)} 分 ${left % 60} 秒` : "期限切れ"}
        </span>
      </div>
      <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        <li>ブラウザ：新しい端末で Gasho を開き、このコードを入力する</li>
        <li>
          working server：そのマシンの Gasho のフォルダで次を実行する
          <button
            type="button"
            onClick={() => void copyToClipboard(command)}
            className="mt-1 flex w-full items-start gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-left font-mono text-[11px] text-foreground/80 hover:border-border-hover"
            title="コピー"
          >
            <span className="min-w-0 flex-1 break-all">{command}</span>
            <Copy className="mt-0.5 size-3.5 shrink-0" />
          </button>
        </li>
      </ul>
    </div>
  );
}

export function DevicesView() {
  const { machines } = useAppState();
  const now = useNow();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [code, setCode] = useState<PairingCode>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setDevices(await listDevices());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, machines.length]);

  const online = useMemo(() => new Set(machines.filter((m) => m.connected).map((m) => m.id)), [machines]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const columns = useMemo<DataTableColumn<DeviceInfo>[]>(
    () => [
      {
        key: "name",
        header: "名前",
        primary: true,
        width: "minmax(0, 2fr)",
        cell: (d) => (
          <div className="flex min-w-0 items-center gap-2">
            {d.kind === "machine" ? <Monitor className="size-4 shrink-0 text-neutral-500" /> : <Laptop className="size-4 shrink-0 text-neutral-500" />}
            <span className="truncate font-medium">{d.name}</span>
            {d.current && <Badge tone="success">この端末</Badge>}
          </div>
        ),
      },
      {
        key: "kind",
        header: "種類",
        width: "140px",
        accessor: (d) => KIND_LABEL[d.kind],
        cell: (d) =>
          d.kind === "machine" ? (
            <Badge tone={online.has(d.id) ? "success" : "neutral"} dot>
              {online.has(d.id) ? "接続中" : "未接続"}
            </Badge>
          ) : (
            <span className="text-xs text-neutral-400">ブラウザ</span>
          ),
      },
      { key: "createdAt", header: "登録", width: "110px", align: "right", cell: (d) => relativeTime(d.createdAt, now) },
      {
        key: "lastSeenAt",
        header: "最後の接続",
        width: "110px",
        align: "right",
        accessor: (d) => d.lastSeenAt ?? 0,
        cell: (d) => relativeTime(d.lastSeenAt, now),
      },
      {
        key: "actions",
        header: "",
        width: "210px",
        align: "right",
        sortable: false,
        cell: (d) => (
          <div className="flex justify-end gap-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-border-hover"
              onClick={() => {
                const name = window.prompt("新しい名前", d.name)?.trim();
                if (name && name !== d.name) void act(() => renameDevice(d.id, name));
              }}
            >
              名前を変更
            </button>
            <button
              type="button"
              className="rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-400 hover:border-red-500"
              onClick={() => {
                const what = d.current ? "このブラウザ" : `「${d.name}」`;
                if (!window.confirm(`${what}の登録を取り消しますか？取り消すと、もう一度登録するまで使えません。`)) return;
                if (d.current) void unregisterThisBrowser().then(becomeUnregistered, (e) => setError(errorText(e)));
                else void act(() => revokeDevice(d.id));
              }}
            >
              取り消す
            </button>
          </div>
        ),
      },
    ],
    [now, online],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">端末</h1>
          <p className="text-sm text-muted-foreground">Gasho サーバーに登録したブラウザと working server です。</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-border-hover"
        >
          <RefreshCw className="size-3.5" />
          更新
        </button>
      </div>

      <section className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4" />
              登録コード
            </h2>
            <p className="text-xs text-muted-foreground">新しいブラウザや working server を登録するときに使います。10分間有効で、1回だけ使えます。</p>
          </div>
          <button
            type="button"
            onClick={() => void createPairingCode().then(setCode, (e) => setError(errorText(e)))}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            {code ? "新しいコードを発行" : "コードを発行"}
          </button>
        </div>
        {code && <CodePanel code={code} />}
      </section>

      <DaemonUpdates />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <DataTable
        rows={devices}
        columns={columns}
        defaultSort={{ key: "createdAt", dir: "asc" }}
        selectable={false}
        cardBreakpoint={640}
        pageSize={Infinity}
        ariaLabel="登録済みの端末"
        emptyState={<p className="text-sm text-neutral-500">登録済みの端末はありません。</p>}
      />
    </div>
  );
}

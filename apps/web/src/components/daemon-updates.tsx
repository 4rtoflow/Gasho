// The 端末 screen's section for updating gasho-daemon: each working server's version, the latest one published, and
// the update (daemon.update) with what it will do, its steps while it runs, and why one cannot be updated from here.
import { CircleArrowUp, Copy, ExternalLink, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useState } from "react";
import type { MachineInfo } from "@gasho/protocol";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import {
  changesUrl,
  compareVersions,
  INSTALL_COMMAND,
  newerPublished,
  pendingWork,
  RESTART_SLOW_MS,
  STEP_LABEL,
  updateTo,
} from "@/lib/daemon-update";
import { relativeTime } from "@/lib/format";
import { checkLatest, sendCommand, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn, copyToClipboard } from "@/lib/utils";

const SMALL_BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-border-hover disabled:opacity-50";

/** A command to run on the working server, copied with a click. */
function CommandLine({ command }: { command: string }) {
  return (
    <button
      type="button"
      onClick={() => void copyToClipboard(command)}
      className="mt-1.5 flex w-full items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left font-mono text-[11px] text-foreground/80 hover:border-border-hover"
      title="コピー"
    >
      <span className="min-w-0 flex-1 break-all">{command}</span>
      <Copy className="mt-0.5 size-3.5 shrink-0" />
    </button>
  );
}

export function DaemonUpdates() {
  const { machines, latest, connected } = useAppState();
  const now = useNow(5000);
  // The update the dialog asks about.
  const [asking, setAsking] = useState<{ machine: MachineInfo; version: string }>();
  // The versions this browser updated working servers to: "updated" is shown once they run them.
  const [started, setStarted] = useState<Record<string, string>>({});

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <CircleArrowUp className="size-4" />
            gasho-daemon の更新
          </h2>
          <p className="text-xs text-muted-foreground">
            {!latest
              ? "この Gasho サーバーは、公開されている最新の版を調べていません。"
              : latest.checking && !latest.daemon
                ? "公開されている最新の版を調べています…"
                : latest.daemon
                  ? `公開されている最新の版：${latest.daemon}（${relativeTime(latest.checkedAt, now)}に調べました）`
                  : "公開されている最新の版は、まだわかりません。"}
          </p>
          {latest?.error && <p className="mt-1 text-xs text-red-400">{latest.error}</p>}
        </div>
        {latest && (
          <button type="button" className={SMALL_BUTTON} disabled={!connected || latest.checking} onClick={checkLatest}>
            <RefreshCw className={cn("size-3.5", latest.checking && "animate-spin")} />
            今すぐ調べる
          </button>
        )}
      </div>

      {machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">登録された working server はありません。</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-background">
          {machines.map((m) => (
            <MachineRow
              key={m.id}
              machine={m}
              now={now}
              updated={started[m.id] !== undefined && started[m.id] === m.daemonVersion}
              onUpdate={(version) => setAsking({ machine: m, version })}
            />
          ))}
        </ul>
      )}

      {asking && (
        <ConfirmUpdate
          machine={asking.machine}
          version={asking.version}
          onClose={() => setAsking(undefined)}
          onStarted={() => setStarted((s) => ({ ...s, [asking.machine.id]: asking.version }))}
        />
      )}
    </section>
  );
}

function MachineRow({ machine: m, now, updated, onUpdate }: { machine: MachineInfo; now: number; updated: boolean; onUpdate: (version: string) => void }) {
  const { latest } = useAppState();
  const u = m.update;
  const to = updateTo(m, latest);
  const previous = m.connected && u?.canUpdate && !u.progress ? u.previous : undefined;

  let status: React.ReactNode;
  if (u?.progress && (m.connected || u.progress.step === "restart")) {
    const slow = !m.connected && now - u.progress.at > RESTART_SLOW_MS;
    status = (
      <>
        <p className="flex items-center gap-1.5 text-xs text-foreground/80">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          {u.progress.version} に更新しています：{STEP_LABEL[u.progress.step]}
        </p>
        {slow && (
          <p className="mt-1 text-xs text-amber-500">
            動かし直してから2分以上たっても、つながりません。working server のログを見てください（Ubuntu：journalctl --user -u gasho-daemon、Mac：~/Library/Logs/gasho-daemon.log）。
          </p>
        )}
      </>
    );
  } else if (!m.connected) {
    status = <p className="text-xs text-muted-foreground">オフライン・最後の接続 {relativeTime(m.lastSeen, now)}</p>;
  } else if (!u) {
    // A gasho-daemon from before updates from Gasho says nothing about them.
    status = (
      <>
        <p className="text-xs text-muted-foreground">
          この版の gasho-daemon は、Gasho からは更新できません。working server でこのコマンドを一度実行すると、最新の版になり、これからは Gasho から更新できます。
        </p>
        <CommandLine command={INSTALL_COMMAND} />
      </>
    );
  } else if (!u.canUpdate) {
    status = (
      <>
        {newerPublished(m, latest) && <p className="text-xs text-foreground/80">{latest?.daemon} が公開されています。</p>}
        <p className="text-xs text-muted-foreground">{u.reason ?? "Gasho からは更新できません。"}</p>
        {u.command && <CommandLine command={u.command} />}
      </>
    );
  } else {
    status = (
      <p className={cn("text-xs", updated ? "text-emerald-500" : "text-muted-foreground")}>
        {updated ? `${m.daemonVersion} に更新しました。` : to ? `${to} に更新できます。` : latest?.daemon ? "最新の版です。" : ""}
      </p>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{m.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{m.daemonVersion ? `gasho-daemon ${m.daemonVersion}` : "版は不明"}</span>
        </p>
        <div className="mt-0.5">{status}</div>
        {m.connected && u?.failed && !u.progress && (
          <p className="mt-1 text-xs text-red-400">
            {u.failed.version} への更新に失敗しました（{relativeTime(u.failed.at, now)}）。何も変えていません。{u.failed.error}
          </p>
        )}
      </div>
      {(to || previous) && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {previous && (
            <button type="button" className={SMALL_BUTTON} onClick={() => onUpdate(previous)}>
              <RotateCcw className="size-3.5" />
              {previous} に戻す
            </button>
          )}
          {to && (
            <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={() => onUpdate(to)}>
              {to} に更新
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ConfirmUpdate({ machine, version, onClose, onStarted }: { machine: MachineInfo; version: string; onClose: () => void; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const from = machine.daemonVersion;
  const back = from !== undefined && compareVersions(version, from) < 0;
  const installed = machine.update?.installed?.includes(version) ?? false;
  const { inputs, requests } = pendingWork(machine);
  const lines = [
    installed
      ? `入っている ${version} に切り替えて、gasho-daemon を動かし直します。`
      : `${version} を取り込み、起動できることを確かめてから切り替えて、gasho-daemon を動かし直します。うまくいかなかったときは、何も変えません。`,
    "セッションは止まりません。動かし直すあいだ（10秒ほど）は、この working server の様子が届きません。",
    inputs > 0 && `送るのを待っている入力が ${inputs} 件あります。送り終えてから切り替えます。5分たっても残っているときは、更新をやめます。`,
    requests > 0 &&
      `権限の確認を待っているものが ${requests} 件あります。動かし直したあとは Gasho から答えられなくなるので、端末か公式アプリで答えてください。`,
  ].filter((l): l is string => typeof l === "string");

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "daemon.update", version }, 20_000);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "更新を始められませんでした。");
      return;
    }
    onStarted();
    onClose();
  };

  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={DIALOG_OVERLAY} />
        <AlertDialog.Content className={DIALOG_PANEL}>
          <AlertDialog.Title className="text-base font-semibold tracking-tight">
            「{machine.name}」の gasho-daemon を {version} に{back ? "戻しますか" : "更新しますか"}？
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {from && !back && (
                <a
                  href={changesUrl(from, version)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  {from} からの変更を GitHub で見る
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </AlertDialog.Description>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void start()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "始めています…" : back ? "戻す" : "更新する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

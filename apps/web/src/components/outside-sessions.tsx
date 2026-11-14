// Above a worktree's tabs: how many conversations Claude Codes started outside Gasho (in Orca, a terminal) have open in
// the worktree. "Gasho に移す" ends those Claude Codes (session.end), after a dialog that lists them; their
// conversations are then among the worktree's past conversations (see session-history), to be opened again from Gasho
// one by one: opening them all at once could start a great many sessions.
import { X } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useState } from "react";
import { BUTTON_DANGER, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { relativeTime, sessionLabel } from "@/lib/format";
import type { WorktreeSessions } from "@/lib/sessions";
import { sendCommand } from "@/lib/store";

/** A little longer than the Gasho server waits for the Claude Codes to end. */
const END_WAIT_MS = 35_000;

export function OutsideSessions({ worktree }: { worktree: WorktreeSessions }) {
  const { machine, outside } = worktree;
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string>();
  if (outside.length === 0 && !notice && !confirming) return null;
  const usable = machine.connected && machine.canEnd === true;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground md:px-4">
      <p className="min-w-0 flex-1">{notice ?? `Gasho の外で ${outside.length} 件の会話が開いています`}</p>
      {notice ? (
        <button
          type="button"
          onClick={() => setNotice(undefined)}
          aria-label="閉じる"
          className="grid size-6 shrink-0 place-items-center rounded-md hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!usable}
          title={usable ? undefined : "接続していて、gasho-daemon が Gasho の外の会話を終了できる working server でだけ使えます"}
          className="shrink-0 rounded-md border border-border px-2 py-1 font-medium text-foreground transition-colors hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-40"
        >
          Gasho に移す
        </button>
      )}
      {confirming && <EndDialog worktree={worktree} onClose={() => setConfirming(false)} onEnded={setNotice} />}
    </div>
  );
}

function EndDialog({ worktree, onClose, onEnded }: { worktree: WorktreeSessions; onClose: () => void; onEnded: (notice: string) => void }) {
  const { machine } = worktree;
  // As listed when the dialog opened: those that end leave the worktree's list before the answer comes.
  const [outside] = useState(worktree.outside);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const working = outside.some((s) => s.status === "busy" || s.status === "waiting");

  const end = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "session.end", sessionIds: outside.map((s) => s.sessionId) }, END_WAIT_MS);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "終了できませんでした。");
      return;
    }
    const ended = `${r.ended?.length ?? 0} 件の会話の Claude Code を終了しました。タブの左の過去の会話から、Gasho で開き直せます。`;
    onEnded([ended, r.warning].filter(Boolean).join(" "));
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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">この worktree の会話を Gasho に移しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>
                Gasho の外（Orca や端末）で開いている次の会話の Claude Code を終了します。{working && "作業中の会話は、作業が途中で止まります。"}
              </p>
              <p>会話の記録は {machine.name} に残ります。タブの左の過去の会話から、続けたい会話を Gasho で開き直せます。</p>
            </div>
          </AlertDialog.Description>
          <ul className="mt-3 max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 text-sm">
            {outside.map((s) => (
              <li key={s.sessionId} className="flex items-center gap-2 px-2 py-1.5">
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate" title={sessionLabel(s)}>
                  {sessionLabel(s)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(s.lastActivityAt ?? s.startedAt)}</span>
              </li>
            ))}
          </ul>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void end()} disabled={busy || outside.length === 0} className={BUTTON_DANGER}>
              {busy ? "終了しています…" : "終了する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

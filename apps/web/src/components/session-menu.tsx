// What can be done to a session from its place in the sidebar: rename it, fork it, or remove it. The menu opens with a
// right-click (a long press on a touch screen, the context menu key on a keyboard). Each item opens a dialog, which the
// app keeps at its top (SessionActionDialog): it stays open while the sidebar redraws or the drawer closes.
import { GitFork, Pencil, Trash2 } from "lucide-react";
import { AlertDialog, ContextMenu, Dialog } from "radix-ui";
import { useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { sessionLabel } from "@/lib/format";
import { go, useRoute } from "@/lib/route";
import { forkName, MAX_SESSION_NAME, nameProblem } from "@/lib/session-names";
import { daemonAtLeast } from "@/lib/sessions";
import { sendCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";

export type SessionAction = "rename" | "fork" | "remove";

/** A session, as it was when an item of its menu was picked, and what to do with it. */
export interface SessionActionRequest {
  action: SessionAction;
  machine: MachineInfo;
  session: SessionInfo;
}

/**
 * How long to wait for each answer, a little longer than the Gasho server does: a fork starts Claude Code and then
 * names the copy; a removal waits for Claude Code to end.
 */
const RENAME_WAIT_MS = 50_000;
const FORK_WAIT_MS = 95_000;
const REMOVE_WAIT_MS = 50_000;


/** The menu of a session in the sidebar; `children` is the item's button, which opens it. */
export function SessionContextMenu({
  machine,
  session,
  onPick,
  children,
}: {
  machine: MachineInfo;
  session: SessionInfo;
  onPick: (request: SessionActionRequest) => void;
  children: ReactElement;
}) {
  // Focus goes back to the item when the menu closes, unless a dialog is opening from it.
  const picked = useRef(false);
  const unavailable = !machine.connected
    ? `${machine.name} はオフラインです。`
    : !daemonAtLeast(machine, 0, 9)
      ? `${machine.name} の gasho-daemon を 0.9.0 以上に更新すると使えます。`
      : undefined;
  const pick = (action: SessionAction) => {
    picked.current = true;
    onPick({ action, machine, session });
  };
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) picked.current = false;
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          collisionPadding={8}
          className={MENU}
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault();
          }}
        >
          <ContextMenu.Label className="truncate px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">{sessionLabel(session)}</ContextMenu.Label>
          <ContextMenu.Item disabled={unavailable !== undefined} onSelect={() => pick("rename")} className={cn(MENU_ITEM, "[&>svg]:text-muted-foreground")}>
            <Pencil />
            名前を変更…
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={unavailable !== undefined || !machine.canLaunch}
            onSelect={() => pick("fork")}
            className={cn(MENU_ITEM, "[&>svg]:text-muted-foreground")}
          >
            <GitFork />
            フォーク…
          </ContextMenu.Item>
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-border" />
          <ContextMenu.Item
            disabled={unavailable !== undefined}
            onSelect={() => pick("remove")}
            className={cn(MENU_ITEM, "text-red-400 data-[highlighted]:bg-red-500/10")}
          >
            <Trash2 />
            削除…
          </ContextMenu.Item>
          {unavailable && <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{unavailable}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The dialog for a picked menu item. `onNavigate` is called after it went to another page (to a fork, or home after
 * the open session was removed): the app closes the sidebar's drawer then.
 */
export function SessionActionDialog({
  request,
  onClose,
  onNavigate,
}: {
  request: SessionActionRequest | null;
  onClose: () => void;
  onNavigate?: () => void;
}) {
  if (!request) return null;
  // A new pick starts a fresh dialog.
  const key = `${request.action}/${request.machine.id}/${request.session.sessionId}`;
  if (request.action === "remove") return <RemoveDialog key={key} request={request} onClose={onClose} onNavigate={onNavigate} />;
  return <NameDialog key={key} request={request} onClose={onClose} onNavigate={onNavigate} />;
}

interface DialogProps {
  request: SessionActionRequest;
  onClose: () => void;
  onNavigate?: () => void;
}

/** Renaming a session, or forking it under a new name. */
function NameDialog({ request: { action, machine, session }, onClose, onNavigate }: DialogProps) {
  const fork = action === "fork";
  const current = sessionLabel(session);
  const [name, setName] = useState(() => (fork ? forkName(current) : current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Done, with something to tell: shown in place of the form.
  const [notice, setNotice] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const problem = nameProblem(name);
  const unchanged = !fork && name.trim() === current;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || unchanged) return;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    const sessionId = session.sessionId;
    const r = fork
      ? await sendCommand(machine.id, { type: "session.fork", sessionId, name: name.trim() }, FORK_WAIT_MS)
      : await sendCommand(machine.id, { type: "session.rename", sessionId, name: name.trim() }, RENAME_WAIT_MS);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? (fork ? "フォークできませんでした。" : "名前を変えられませんでした。"));
      return;
    }
    if (fork && r.sessionId) {
      go({ name: "session", machine: machine.id, sessionId: r.sessionId });
      onNavigate?.();
    }
    if (r.warning) setNotice(r.warning);
    else onClose();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        // While waiting, the answer is still to come: the dialog stays to show it.
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          className={DIALOG_PANEL}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
            input.current?.select();
          }}
        >
          <Dialog.Title className="text-base font-semibold tracking-tight">{fork ? "フォーク" : "名前を変更"}</Dialog.Title>
          {notice ? (
            <>
              <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                {fork ? "フォークしたセッションを開きました。" : "名前を変えました。"}
              </Dialog.Description>
              <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice}</p>
              <div className="mt-5 flex justify-end">
                <Dialog.Close asChild>
                  <button type="button" className={BUTTON_PRIMARY}>
                    閉じる
                  </button>
                </Dialog.Close>
              </div>
            </>
          ) : (
            <form onSubmit={submit}>
              <Dialog.Description asChild>
                <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                  {fork ? (
                    <>
                      <p>会話をここまで引き継いだ新しいセッションを、同じフォルダーで起動します。元のセッションは、そのまま続けられます。</p>
                      <p className="truncate font-mono text-xs" title={session.cwd}>
                        {machine.name} · {session.cwd}
                      </p>
                    </>
                  ) : (
                    <p>Gasho と公式アプリでの名前を変えます。Claude Code には /rename で伝えます（作業中なら、作業が終わってから）。</p>
                  )}
                </div>
              </Dialog.Description>
              <label className="mt-4 block space-y-1.5">
                <span className="text-xs text-muted-foreground">{fork ? "新しいセッションの名前（公式アプリにもこの名前で出ます）" : "名前"}</span>
                <input
                  ref={input}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(undefined);
                  }}
                  maxLength={MAX_SESSION_NAME}
                  disabled={busy}
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover disabled:opacity-60"
                />
              </label>
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                    キャンセル
                  </button>
                </Dialog.Close>
                <button type="submit" disabled={busy || unchanged || !name.trim()} className={BUTTON_PRIMARY}>
                  {busy ? (fork ? "起動しています…" : "変更しています…") : fork ? "フォークする" : "変更する"}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Removing a session: its Claude Code ends, and its conversation stays on the working server. */
function RemoveDialog({ request: { machine, session }, onClose, onNavigate }: DialogProps) {
  const route = useRoute();
  const { machines } = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // What the session is doing now (it may have started working since the menu was opened).
  const live = machines.find((m) => m.id === machine.id)?.sessions.find((s) => s.sessionId === session.sessionId) ?? session;
  const working = live.status === "busy" || live.status === "waiting";

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "session.remove", sessionId: session.sessionId }, REMOVE_WAIT_MS);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "削除できませんでした。");
      return;
    }
    // The open session is gone: back home, in place of its page.
    if (route.name === "session" && route.machine === machine.id && route.sessionId === session.sessionId) {
      go({ name: "home" }, { replace: true });
      onNavigate?.();
    }
    onClose();
  };

  const lines: ReactNode[] = [
    <>
      「{sessionLabel(session)}」の Claude Code を終了し、Gasho の一覧から外します。
      {working && "作業の途中で止まります。"}
      {live.pendingInputs ? `送信待ちの ${live.pendingInputs} 件は送りません。` : ""}
    </>,
    <>
      会話の記録は {machine.name} に残ります。端末で <code className="font-mono text-[0.92em]">claude --resume</code> を使うと開き直せます。
    </>,
  ];

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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">セッションを削除しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
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
            <button type="button" onClick={() => void remove()} disabled={busy} className={BUTTON_DANGER}>
              {busy ? "削除しています…" : "削除する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

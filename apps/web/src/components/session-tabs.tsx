// The tabs above a session: the sessions Gasho shows in the same worktree, in the order they started. A tab opens its
// session; a right-click (a long press on a phone) opens the session's menu (see session-menu). "＋" after the tabs
// starts a new session in the worktree.
import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { sessionLabel } from "@/lib/format";
import { go } from "@/lib/route";
import { sendCommand } from "@/lib/store";
import { worktreeId, worktreesByLastUse } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export function SessionTabs({
  machine,
  session,
  onAction,
}: {
  machine: MachineInfo;
  session: SessionInfo;
  onAction: (request: SessionActionRequest) => void;
}) {
  const id = worktreeId(machine.id, session);
  const sessions = worktreesByLastUse([machine]).find((w) => w.id === id)?.sessions ?? [session];
  const current = useRef<HTMLButtonElement>(null);
  // With more tabs than fit, the open one is scrolled into view.
  useEffect(() => {
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  // The new session opens only while these tabs are still shown: one picked meanwhile is not left for it.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const canLaunch = machine.connected && machine.canLaunch === true;
  const launch = async () => {
    if (!canLaunch || launching) return;
    setLaunching(true);
    setError(undefined);
    // In the worktree's top folder, or the session's own folder when it is not in a repository.
    const r = await sendCommand(machine.id, { type: "session.launch", cwd: session.worktree?.path ?? session.cwd }, 60_000);
    if (!shown.current) return;
    setLaunching(false);
    if (!r.ok || !r.sessionId) {
      setError(r.error ?? "起動できませんでした。");
      return;
    }
    go({ name: "session", machine: machine.id, sessionId: r.sessionId });
  };

  return (
    <nav
      aria-label="この worktree のセッション"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 [scrollbar-width:none] md:px-4 [&::-webkit-scrollbar]:hidden"
    >
      {sessions.map((s) => {
        const active = s.sessionId === session.sessionId;
        return (
          <SessionContextMenu key={s.sessionId} machine={machine} session={s} onPick={onAction}>
            <button
              ref={active ? current : undefined}
              type="button"
              onClick={() => {
                if (!active) go({ name: "session", machine: machine.id, sessionId: s.sessionId });
              }}
              aria-current={active ? "page" : undefined}
              title={sessionLabel(s)}
              className={cn(
                "relative flex h-9 max-w-56 shrink-0 items-center gap-2 px-2.5 text-xs transition-colors",
                "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
                active ? "text-foreground after:bg-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <StatusDot status={machine.connected ? s.status : "unknown"} />
              <span className="truncate">{sessionLabel(s)}</span>
            </button>
          </SessionContextMenu>
        );
      })}
      <button
        type="button"
        onClick={() => void launch()}
        disabled={!canLaunch || launching}
        aria-label="この worktree で新しいセッションを起動"
        title={canLaunch ? "この worktree で新しいセッションを起動" : "接続していて、セッションの端末を作れる working server でだけ起動できます"}
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {launching ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
      </button>
      {error && (
        <p role="alert" title={error} className="self-center truncate text-xs text-red-400">
          {error}
        </p>
      )}
    </nav>
  );
}

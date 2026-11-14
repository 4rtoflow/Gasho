// The tabs above a session: the sessions Gasho shows in the same worktree, in the order they started. A tab opens its
// session; a right-click (a long press on a phone) opens the session's menu (see session-menu). The button before the
// tabs lists the worktree's past conversations (see session-history); "＋" after them starts a new session in it. The
// plugins' tabs of the worktree come last (docs/plugins.md, P14).
import { LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionHistory } from "@/components/session-history";
import { SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { sessionLabel } from "@/lib/format";
import { go, type WorktreeView } from "@/lib/route";
import type { WorktreeSessions } from "@/lib/sessions";
import { sendCommand } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PluginWorktreeTabs } from "@/plugins/parts";

/** `current`: the session open below, if any. `view`: the plugin's screen open below instead, if any. */
export function SessionTabs({
  worktree,
  current,
  view,
  onAction,
}: {
  worktree: WorktreeSessions;
  current?: string;
  view?: WorktreeView;
  onAction: (request: SessionActionRequest) => void;
}) {
  const { machine, sessions } = worktree;
  const active = useRef<HTMLButtonElement>(null);
  // With more tabs than fit, the open one is scrolled into view.
  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    const r = await sendCommand(machine.id, { type: "session.launch", cwd: worktree.path }, 60_000);
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
      <SessionHistory worktree={worktree} />
      {sessions.map((s) => {
        const open = s.sessionId === current;
        return (
          <SessionContextMenu key={s.sessionId} machine={machine} session={s} onPick={onAction}>
            <button
              ref={open ? active : undefined}
              type="button"
              onClick={() => {
                if (!open) go({ name: "session", machine: machine.id, sessionId: s.sessionId });
              }}
              aria-current={open ? "page" : undefined}
              title={sessionLabel(s)}
              className={cn(
                "relative flex h-9 max-w-56 shrink-0 items-center gap-2 px-2.5 text-xs transition-colors",
                "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
                open ? "text-foreground after:bg-foreground" : "text-muted-foreground hover:text-foreground",
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
      <PluginWorktreeTabs worktree={worktree} open={view} />
      {error && (
        <p role="alert" title={error} className="self-center truncate text-xs text-red-400">
          {error}
        </p>
      )}
    </nav>
  );
}

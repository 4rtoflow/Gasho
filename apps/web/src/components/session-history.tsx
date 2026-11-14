// The button before the session tabs: the worktree's past conversations, those Claude Code keeps for its folder that no
// Claude Code has open now, the latest first. Picking one opens it again as a session started from Gasho.
import { History, LoaderCircle } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { PastConversation } from "@gasho/protocol";
import { BUTTON_PRIMARY } from "@/components/dialog-styles";
import { relativeTime } from "@/lib/format";
import { go } from "@/lib/route";
import type { WorktreeSessions } from "@/lib/sessions";
import { sendCommand } from "@/lib/store";
import { cn } from "@/lib/utils";

/** A little longer than the Gasho server waits for Claude Code to start. */
const RESUME_WAIT_MS = 50_000;

export function SessionHistory({ worktree }: { worktree: WorktreeSessions }) {
  const { machine } = worktree;
  const usable = machine.connected && machine.canResume === true && machine.canLaunch === true;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PastConversation[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [resuming, setResuming] = useState<string>();
  // Opened, with something to tell before going to it.
  const [notice, setNotice] = useState<{ sessionId: string; text: string }>();
  // An answer that comes once these tabs are gone (another session picked meanwhile) opens nothing.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "session.history", cwd: worktree.path, subfolders: worktree.subfolders }, 20_000);
    if (!shown.current) return;
    setLoading(false);
    if (!r.ok) return setError(r.error ?? "過去の会話を読み込めませんでした。");
    setList(r.history ?? []);
  };

  const resume = async (c: PastConversation) => {
    if (resuming) return;
    setResuming(c.sessionId);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "session.resume", sessionId: c.sessionId }, RESUME_WAIT_MS);
    if (!shown.current) return;
    setResuming(undefined);
    if (!r.ok || !r.sessionId) return setError(r.error ?? "会話を開き直せませんでした。");
    if (r.warning) return setNotice({ sessionId: r.sessionId, text: r.warning });
    setOpen(false);
    go({ name: "session", machine: machine.id, sessionId: r.sessionId });
  };

  const where = (cwd: string) => (cwd === worktree.path ? undefined : cwd.startsWith(`${worktree.path}/`) ? cwd.slice(worktree.path.length + 1) : cwd);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setNotice(undefined);
          void load();
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={!usable}
          aria-label="過去の会話"
          title={usable ? "過去の会話を開き直す" : "接続していて、gasho-daemon が過去の会話を扱える working server でだけ使えます"}
          className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:text-foreground"
        >
          <History className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={12}
          className="z-50 w-96 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-surface p-1.5 text-sm shadow-xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">過去の会話</p>
          {notice ? (
            <div className="space-y-3 px-2 pb-1.5">
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{notice.text}</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  onClick={() => {
                    setOpen(false);
                    go({ name: "session", machine: machine.id, sessionId: notice.sessionId });
                  }}
                >
                  開く
                </button>
              </div>
            </div>
          ) : loading && !list ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              読み込んでいます…
            </p>
          ) : list && list.length === 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground">開いていない過去の会話はありません。</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {(list ?? []).map((c) => {
                const sub = where(c.cwd);
                return (
                  <li key={c.sessionId}>
                    <button
                      type="button"
                      onClick={() => void resume(c)}
                      disabled={resuming !== undefined}
                      title={c.title}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-raised disabled:pointer-events-none",
                        resuming !== undefined && resuming !== c.sessionId && "opacity-50",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.title ?? "（題のない会話）"}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {relativeTime(c.lastActivityAt)}
                          {sub && ` · ${sub}`}
                        </span>
                      </span>
                      {resuming === c.sessionId && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="px-2 pt-1.5 pb-1 text-xs text-red-400">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

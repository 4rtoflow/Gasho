// A worktree with no session open: a plugin's screen that one of its tabs opened (docs/plugins.md, P15), a worktree of a
// repository registered with its working server, or one whose sessions are all gone, kept in the sidebar by this
// browser. Its tabs row still starts a new session ("＋") and opens a past conversation again.
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { BUTTON_SECONDARY } from "@/components/dialog-styles";
import type { SessionActionRequest } from "@/components/session-menu";
import { SessionTabs } from "@/components/session-tabs";
import { forgetWorktree } from "@/lib/remembered-worktrees";
import { go, type WorktreeView as PluginView } from "@/lib/route";
import { sessionToOpen, type WorktreeSessions } from "@/lib/sessions";
import { PluginWorktreeView } from "@/plugins/parts";

export function WorktreeView({
  worktree,
  view,
  onSessionAction,
}: {
  worktree: WorktreeSessions | undefined;
  view?: PluginView;
  onSessionAction: (request: SessionActionRequest) => void;
}) {
  // Without a plugin's screen, once it has a session (started here, or elsewhere), that session opens instead.
  const open = worktree && !view ? sessionToOpen(worktree) : undefined;
  useEffect(() => {
    if (worktree && open) go({ name: "session", machine: worktree.machine.id, sessionId: open.sessionId }, { replace: true });
  }, [worktree, open]);

  if (!worktree) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        <HomeLink />
        <p className="mt-4">この worktree はサイドバーにありません。</p>
      </div>
    );
  }
  if (view) {
    return (
      <div className="flex h-full flex-col">
        <SessionTabs worktree={worktree} view={view} onAction={onSessionAction} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PluginWorktreeView worktree={worktree} view={view} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <SessionTabs worktree={worktree} onAction={onSessionAction} />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6 text-sm text-muted-foreground">
        <HomeLink />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{worktree.label}</h1>
          <p className="truncate text-xs">
            {worktree.machine.name} · {worktree.path}
          </p>
        </div>
        <p>この worktree にセッションはありません。タブの右の「＋」で新しいセッションを起動するか、左の履歴から過去の会話を開き直せます。</p>
        {worktree.registered ? (
          <p>登録したリポジトリ{worktree.repo ? `（${worktree.repo}）` : ""}の worktree なので、git の一覧にあるあいだはサイドバーに出ます。</p>
        ) : (
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => {
              forgetWorktree(worktree.machine.id, worktree.path);
              go({ name: "home" }, { replace: true });
            }}
          >
            サイドバーから外す
          </button>
        )}
      </div>
    </div>
  );
}

function HomeLink() {
  return (
    <button
      type="button"
      onClick={() => go({ name: "home" })}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      ホーム
    </button>
  );
}

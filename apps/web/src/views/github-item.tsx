// One issue or pull request of the session's GitHub repository, read in Gasho: its text, its conversation (comments
// and reviews), and for a pull request its branches, checks and changed files. A panel of the session (see
// SidePanel); it opens from the list in place of it, and goes back to it.
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { GitHubCheck, GitHubComment, GitHubItemDetail, GitHubListKind, GitHubReview } from "@gasho/protocol";
import { MarkdownText } from "@/components/markdown";
import { PANEL_BUTTON, panelRepo, SidePanel } from "@/components/side-panel";
import { relativeTime } from "@/lib/format";
import { backTo } from "@/lib/route";
import { githubItemKey, loadGitHubItem, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const NAME: Record<GitHubListKind, string> = { issues: "Issue", pulls: "Pull request" };
const LIST: Record<GitHubListKind, string> = { issues: "Issues", pulls: "Pull requests" };

export function GitHubItemPanel({
  machine,
  sessionId,
  kind,
  number,
  repo,
  docked,
  onClose,
}: {
  machine: string;
  sessionId: string;
  kind: GitHubListKind;
  number: number;
  repo?: string;
  docked: boolean;
  onClose: () => void;
}) {
  const { machines, githubItems } = useAppState();
  const now = useNow(60_000);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const { selected } = s ? panelRepo(s, repo, (r) => Boolean(r.github)) : {};
  const g = githubItems[githubItemKey(machine, sessionId, kind, number, selected?.path)];
  const item = g?.item;
  const github = selected ? selected.github : s?.github;
  const url = item?.url ?? (github ? `${github.url}/${kind === "issues" ? "issues" : "pull"}/${number}` : undefined);
  const back = () =>
    backTo({ name: "session", machine, sessionId, panel: { kind, ...(selected ? { repo: selected.path } : {}) } });

  useEffect(() => {
    if (m?.connected) loadGitHubItem(machine, sessionId, kind, number, selected?.path);
  }, [machine, sessionId, kind, number, selected?.path, m?.connected]);

  return (
    <SidePanel
      title={`${NAME[kind]} #${number}`}
      subtitle={github ? `${github.owner}/${github.name}` : undefined}
      docked={docked}
      onClose={onClose}
      actions={
        <>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className={PANEL_BUTTON}>
              GitHub <ExternalLink className="size-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => loadGitHubItem(machine, sessionId, kind, number, selected?.path)}
            disabled={g?.loading || !m?.connected}
            aria-label="再読み込み"
            title="再読み込み"
            className={PANEL_BUTTON}
          >
            <RefreshCw className={cn("size-3.5", g?.loading && "animate-spin")} />
          </button>
        </>
      }
    >
      <button type="button" onClick={back} className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        {LIST[kind]} の一覧
      </button>
      {!m || !s ? (
        <p className="text-sm text-muted-foreground">このセッションは見つかりません。</p>
      ) : (
        <div className="space-y-4">
          {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
          {g?.error && <p className="text-sm text-red-400">{g.error}</p>}
          {!item && g?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {item && <ItemView item={item} now={now} />}
        </div>
      )}
    </SidePanel>
  );
}

function ItemView({ item, now }: { item: GitHubItemDetail; now: number }) {
  // Comments and reviews, oldest first, as GitHub shows them.
  const timeline = [
    ...item.comments.map((c) => ({ at: c.createdAt, comment: c })),
    ...(item.reviews ?? []).map((r) => ({ at: r.submittedAt, review: r })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <header className="space-y-2">
        <h3 className="text-lg leading-snug font-semibold break-words">{item.title}</h3>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <StateBadge item={item} />
          <span>
            {item.author ?? "不明"} が<Time at={item.createdAt} now={now} />に作成
          </span>
          <span>
            更新 <Time at={item.updatedAt} now={now} />
          </span>
          {item.assignees.length > 0 && <span>担当：{item.assignees.join("、")}</span>}
        </div>
        {item.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            {item.labels.map((l) => (
              <span key={l.name} className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px">
                {l.color && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: `#${l.color}` }} />}
                {l.name}
              </span>
            ))}
          </div>
        )}
      </header>

      {item.kind === "pulls" && <PullSummary item={item} />}

      <Card author={item.author} at={item.createdAt} now={now}>
        {item.body.trim() ? <MarkdownText text={item.body} /> : <p className="text-sm text-muted-foreground">説明はありません。</p>}
      </Card>

      {item.commentsLeftOut ? (
        <p className="text-xs text-muted-foreground">古いコメント {item.commentsLeftOut} 件は省いています。GitHub で読めます。</p>
      ) : null}
      {timeline.map((t, i) =>
        "comment" in t && t.comment ? (
          <CommentCard key={`c${i}`} comment={t.comment} now={now} />
        ) : "review" in t && t.review ? (
          <ReviewCard key={`r${i}`} review={t.review} now={now} />
        ) : null,
      )}
      {timeline.length === 0 && <p className="text-xs text-muted-foreground">コメントはまだありません。</p>}

      {item.kind === "pulls" && item.files && item.files.length > 0 && <Files item={item} />}
    </>
  );
}

/** "3 日前" for an ISO time, with the exact time on hover. */
function Time({ at, now }: { at: string; now: number }) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return <time dateTime={at} title={new Date(ms).toLocaleString("ja-JP")}>{relativeTime(ms, now)}</time>;
}

function StateBadge({ item }: { item: GitHubItemDetail }) {
  const [label, tone, Icon] =
    item.state === "merged"
      ? (["Merged", "bg-violet-500/15 text-violet-300", GitPullRequest] as const)
      : item.state === "closed"
        ? item.kind === "pulls"
          ? (["Closed", "bg-red-500/15 text-red-300", GitPullRequest] as const)
          : item.stateReason === "not_planned"
            ? (["Closed（対応しない）", "bg-white/[0.08] text-neutral-300", CircleSlash] as const)
            : (["Closed", "bg-violet-500/15 text-violet-300", CircleCheck] as const)
        : item.draft
          ? (["Draft", "bg-white/[0.08] text-neutral-300", GitPullRequest] as const)
          : (["Open", "bg-emerald-500/15 text-emerald-300", item.kind === "pulls" ? GitPullRequest : CircleDot] as const);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", tone)}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

const REVIEW_DECISION: Record<NonNullable<GitHubItemDetail["review"]>, { label: string; className: string }> = {
  approved: { label: "承認済み", className: "text-emerald-400" },
  changes_requested: { label: "修正の依頼あり", className: "text-amber-400" },
  review_required: { label: "レビュー待ち", className: "" },
};

/** A pull request's branches, size, review state and checks. */
function PullSummary({ item }: { item: GitHubItemDetail }) {
  const decision = item.review ? REVIEW_DECISION[item.review] : undefined;
  const checks = item.checks ?? [];
  const failing = checks.filter((c) => c.state === "failure").length;
  const pending = checks.filter((c) => c.state === "pending").length;
  const passed = checks.filter((c) => c.state === "success").length;
  return (
    <section className="space-y-2 rounded-xl border border-border px-3 py-2.5 text-xs text-muted-foreground">
      {item.head && item.base && (
        <p className="font-mono break-all">
          {item.head} → {item.base}
        </p>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        {item.additions !== undefined && item.deletions !== undefined && (
          <span className="tabular-nums">
            <span className="text-emerald-400">+{item.additions.toLocaleString()}</span>{" "}
            <span className="text-red-400">−{item.deletions.toLocaleString()}</span>
          </span>
        )}
        {item.changedFiles !== undefined && <span>{item.changedFiles} ファイル</span>}
        {item.commits !== undefined && <span>{item.commits} コミット</span>}
        {decision && <span className={decision.className}>{decision.label}</span>}
      </p>
      {checks.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
            チェック：
            {failing > 0 && <span className="text-red-400">失敗 {failing}</span>}
            {pending > 0 && <span className="text-amber-400">実行中 {pending}</span>}
            {passed > 0 && <span className="text-emerald-400">成功 {passed}</span>}
            {checks.length - failing - pending - passed > 0 && <span>その他 {checks.length - failing - pending - passed}</span>}
          </summary>
          <ul className="mt-1.5 space-y-1 pl-5">
            {checks.map((c, i) => (
              <li key={`${c.name}${i}`} className="flex min-w-0 items-center gap-1.5">
                <CheckIcon state={c.state} />
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:text-foreground hover:underline" title={c.name}>
                    {c.name}
                  </a>
                ) : (
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CheckIcon({ state }: { state: GitHubCheck["state"] }) {
  if (state === "success") return <CircleCheck aria-label="成功" className="size-3.5 shrink-0 text-emerald-400" />;
  if (state === "failure") return <CircleX aria-label="失敗" className="size-3.5 shrink-0 text-red-400" />;
  if (state === "pending") return <CircleDashed aria-label="実行中" className="size-3.5 shrink-0 text-amber-400" />;
  return <CircleMinus aria-label="スキップ" className="size-3.5 shrink-0" />;
}

/** A bordered block of the conversation: who wrote it and when, then the text. */
function Card({ author, at, now, badge, children }: { author?: string; at: string; now: number; badge?: ReactNode; children: ReactNode }) {
  return (
    <article className="overflow-hidden rounded-xl border border-border">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/90">{author ?? "不明"}</span>
        <Time at={at} now={now} />
        {badge}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </article>
  );
}

function CommentCard({ comment: c, now }: { comment: GitHubComment; now: number }) {
  return (
    <Card author={c.author} at={c.createdAt} now={now}>
      {c.minimized ? (
        <p className="text-sm text-muted-foreground">GitHub で非表示にされたコメントです。</p>
      ) : c.body.trim() ? (
        <MarkdownText text={c.body} />
      ) : (
        <p className="text-sm text-muted-foreground">（本文なし）</p>
      )}
    </Card>
  );
}

const REVIEW_STATE: Record<GitHubReview["state"], { label: string; className: string }> = {
  approved: { label: "承認", className: "bg-emerald-500/15 text-emerald-300" },
  changes_requested: { label: "修正を依頼", className: "bg-amber-500/15 text-amber-300" },
  commented: { label: "レビューのコメント", className: "bg-white/[0.08] text-neutral-300" },
  dismissed: { label: "取り消されたレビュー", className: "bg-white/[0.08] text-neutral-400" },
  pending: { label: "未送信のレビュー", className: "bg-white/[0.08] text-neutral-400" },
};

function ReviewCard({ review: r, now }: { review: GitHubReview; now: number }) {
  const state = REVIEW_STATE[r.state];
  return (
    <Card author={r.author} at={r.submittedAt} now={now} badge={<span className={cn("rounded-full px-1.5 py-px", state.className)}>{state.label}</span>}>
      {r.body.trim() ? <MarkdownText text={r.body} /> : <p className="text-sm text-muted-foreground">（本文なし）</p>}
    </Card>
  );
}

/** The files a pull request changes, folded. */
function Files({ item }: { item: GitHubItemDetail }) {
  const files = item.files ?? [];
  return (
    <details className="group rounded-xl border border-border text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        変更したファイル（{item.changedFiles ?? files.length}）
      </summary>
      <ul className="divide-y divide-border border-t border-border">
        {files.map((f) => (
          <li key={f.path} className="flex items-center gap-3 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
              {f.path}
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="text-emerald-400">+{f.additions}</span> <span className="text-red-400">−{f.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
      {item.changedFiles !== undefined && item.changedFiles > files.length && (
        <p className="border-t border-border px-3 py-1.5 text-muted-foreground">ほかに {item.changedFiles - files.length} ファイルあります。GitHub で見られます。</p>
      )}
    </details>
  );
}

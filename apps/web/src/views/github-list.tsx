// The open issues or pull requests of the GitHub repository a session works in, as a panel of the session (see
// SidePanel). gasho-daemon reads them with the GitHub CLI (gh) of the working server.
import { CircleDot, ExternalLink, GitPullRequest, GitPullRequestDraft, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type { GitHubItem, GitHubListKind } from "@gasho/protocol";
import { PANEL_BUTTON, panelRepo, RepoTabs, SidePanel } from "@/components/side-panel";
import { relativeTime } from "@/lib/format";
import { go, hrefOf, noteOpenedFrom, type Route, type SessionPanel } from "@/lib/route";
import { daemonAtLeast } from "@/lib/sessions";
import { githubKey, loadGitHubList, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const TITLE: Record<GitHubListKind, string> = { issues: "Issues", pulls: "Pull requests" };
const EMPTY: Record<GitHubListKind, string> = {
  issues: "開いている Issue はありません。",
  pulls: "開いている Pull request はありません。",
};
const REVIEW: Record<NonNullable<GitHubItem["review"]>, { label: string; className: string }> = {
  approved: { label: "承認済み", className: "text-emerald-400" },
  changes_requested: { label: "修正の依頼あり", className: "text-amber-400" },
  review_required: { label: "レビュー待ち", className: "" },
};

export function GitHubListPanel({
  machine,
  sessionId,
  kind,
  repo,
  docked,
  onClose,
}: {
  machine: string;
  sessionId: string;
  kind: GitHubListKind;
  repo?: string;
  docked: boolean;
  onClose: () => void;
}) {
  const { machines, githubLists } = useAppState();
  const now = useNow(60_000);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  // In a folder that holds repositories, the ones on GitHub are tabs (the first one by default).
  const { repos, selected } = s ? panelRepo(s, repo, (r) => Boolean(r.github)) : {};
  const key = githubKey(machine, sessionId, kind, selected?.path);
  const g = githubLists[key];
  const list = g?.list;
  const github = list?.repo ?? (selected ? selected.github : s?.github);
  const noRepo = Boolean(s && (repos ? repos.length === 0 : !s.github));
  const listPanel: SessionPanel = { kind, ...(selected ? { repo: selected.path } : {}) };
  const listRoute: Route = { name: "session", machine, sessionId, panel: listPanel };
  // An item opens in Gasho, in place of the list (the panel's GitHub button and the item's own still lead to GitHub).
  const itemRoute = (number: number): Route => ({ name: "session", machine, sessionId, panel: { ...listPanel, number } });

  useEffect(() => {
    if (m?.connected && !noRepo) loadGitHubList(machine, sessionId, kind, selected?.path);
  }, [machine, sessionId, kind, selected?.path, m?.connected, noRepo]);

  if (!m || !s) {
    return (
      <SidePanel title={TITLE[kind]} docked={docked} onClose={onClose}>
        <p className="text-sm text-muted-foreground">このセッションは見つかりません。終了したか、{m?.name ?? "この working server"} の gasho-daemon が接続していません。</p>
      </SidePanel>
    );
  }

  return (
    <SidePanel
      title={TITLE[kind]}
      subtitle={github ? `${github.owner}/${github.name}` : s.cwd}
      docked={docked}
      onClose={onClose}
      actions={
        <>
          {github && (
            <a href={`${github.url}/${kind === "issues" ? "issues" : "pulls"}`} target="_blank" rel="noreferrer" className={PANEL_BUTTON}>
              GitHub <ExternalLink className="size-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => loadGitHubList(machine, sessionId, kind, selected?.path)}
            disabled={g?.loading || !m.connected || noRepo}
            aria-label="再読み込み"
            title="再読み込み"
            className={PANEL_BUTTON}
          >
            <RefreshCw className={cn("size-3.5", g?.loading && "animate-spin")} />
          </button>
        </>
      }
    >
      {repos && repos.length >= 2 && selected && (
        <RepoTabs
          repos={repos}
          selected={selected.path}
          onSelect={(path) => go({ name: "session", machine, sessionId, panel: { kind, repo: path } }, { replace: true })}
        />
      )}
      <div className="space-y-3">
        {noRepo && <p className="text-sm text-muted-foreground">このセッションのフォルダーには、GitHub のリポジトリがありません。</p>}
        {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
        {g?.error && <p className="text-sm text-red-400">{g.error}</p>}
        {!list && g?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {list &&
          (list.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{EMPTY[kind]}</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {list.items.map((item) => (
                // gasho-daemon 0.8 reads one item; with an older one, the item opens on GitHub.
                <ItemRow
                  key={item.number}
                  item={item}
                  kind={kind}
                  now={now}
                  {...(daemonAtLeast(m, 0, 8)
                    ? { href: hrefOf(itemRoute(item.number)), onOpen: () => noteOpenedFrom(listRoute) }
                    : { href: item.url, external: true })}
                />
              ))}
            </ul>
          ))}
        {list?.truncated && (
          <p className="text-xs text-muted-foreground">新しいものから {list.items.length} 件を表示しています。すべては GitHub で見られます。</p>
        )}
        {g?.at && <p className="text-xs text-muted-foreground">{new Date(g.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に読み込み</p>}
      </div>
    </SidePanel>
  );
}

function ItemRow({
  item,
  kind,
  now,
  href,
  onOpen,
  external = false,
}: {
  item: GitHubItem;
  kind: GitHubListKind;
  now: number;
  href: string;
  onOpen?: () => void;
  /** A page on GitHub, opened in a new tab. */
  external?: boolean;
}) {
  const Icon = kind === "issues" ? CircleDot : item.draft ? GitPullRequestDraft : GitPullRequest;
  const review = item.review ? REVIEW[item.review] : undefined;
  const updated = Date.parse(item.updatedAt);
  return (
    <li>
      <a
        href={href}
        onClick={onOpen}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        className="flex gap-2.5 px-3 py-2.5 hover:bg-surface-raised"
      >
        <Icon
          aria-label={kind === "issues" ? "Issue" : item.draft ? "下書きの Pull request" : "Pull request"}
          className={cn("mt-0.5 size-4 shrink-0", item.draft ? "text-muted-foreground" : "text-emerald-400")}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug break-words">{item.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">#{item.number}</span>
            {item.author && <span>{item.author}</span>}
            {Number.isFinite(updated) && <span title={new Date(updated).toLocaleString("ja-JP")}>更新 {relativeTime(updated, now)}</span>}
            {item.draft && <span>下書き</span>}
            {review && <span className={review.className}>{review.label}</span>}
            {item.head && item.base && (
              <span className="min-w-0 truncate font-mono" title={`${item.head} → ${item.base}`}>
                {item.head} → {item.base}
              </span>
            )}
            {item.labels.map((l) => (
              <span key={l.name} className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px">
                {l.color && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: `#${l.color}` }} />}
                {l.name}
              </span>
            ))}
          </div>
        </div>
      </a>
    </li>
  );
}

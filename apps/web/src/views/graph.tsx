// Branch graph of the repository a session works in: its branches and the latest commits of all of them. A panel of
// the session (see SidePanel).
import { ChevronRight, Cloud, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type { GitBranch as Branch, GitGraph } from "@gasho/protocol";
import { CommitGraph } from "@/components/commit-graph";
import { PANEL_BUTTON, panelRepo, RepoTabs, SidePanel } from "@/components/side-panel";
import { githubTreeUrl } from "@/lib/format";
import { useFlag } from "@/lib/flag";
import { go } from "@/lib/route";
import { graphKey, loadGraph, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export function GraphPanel({
  machine,
  sessionId,
  repo,
  docked,
  onClose,
}: {
  machine: string;
  sessionId: string;
  repo?: string;
  docked: boolean;
  onClose: () => void;
}) {
  const { machines, graphs } = useAppState();
  const now = useNow(60_000);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  // In a folder that holds repositories, show the one picked in the tabs (the first one by default).
  const { repos, selected } = s ? panelRepo(s, repo) : {};
  const g = graphs[graphKey(machine, sessionId, selected?.path)];
  const graph = g?.graph;

  useEffect(() => {
    if (m?.connected) loadGraph(machine, sessionId, selected?.path);
  }, [machine, sessionId, selected?.path, m?.connected]);

  if (!m || !s) {
    return (
      <SidePanel title="ブランチグラフ" docked={docked} onClose={onClose}>
        <p className="text-sm text-muted-foreground">このセッションは見つかりません。終了したか、{m?.name ?? "この working server"} の gasho-daemon が接続していません。</p>
      </SidePanel>
    );
  }

  return (
    <SidePanel
      title="ブランチグラフ"
      subtitle={graph?.root ?? s.cwd}
      docked={docked}
      onClose={onClose}
      actions={
        <>
          {graph?.github && (
            <a href={graph.github.url} target="_blank" rel="noreferrer" className={PANEL_BUTTON}>
              GitHub <ExternalLink className="size-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => loadGraph(machine, sessionId, selected?.path)}
            disabled={g?.loading || !m.connected}
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
          onSelect={(path) => go({ name: "session", machine, sessionId, panel: { kind: "graph", repo: path } }, { replace: true })}
        />
      )}
      <div className="space-y-5">
        {graph && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3.5" />
              {graph.head ?? "特定のブランチを指していません（detached HEAD）"}
            </span>
            {graph.changes && <span>{changesLabel(graph.changes)}</span>}
            {g?.at && <span>{new Date(g.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に読み込み</span>}
          </div>
        )}
        {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
        {g?.error && <p className="text-sm text-red-400">{g.error}</p>}
        {!graph && g?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {graph && (
          <>
            <BranchList graph={graph} />
            <section className="space-y-2">
              <h3 className="text-sm font-medium">コミット</h3>
              {graph.commits.length === 0 ? (
                <p className="text-sm text-muted-foreground">コミットはまだありません。</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border py-1">
                  <CommitGraph graph={graph} now={now} />
                </div>
              )}
              {graph.truncated && <p className="text-xs text-muted-foreground">新しいものから {graph.commits.length} 件を表示しています。</p>}
            </section>
          </>
        )}
      </div>
    </SidePanel>
  );
}

function changesLabel(c: NonNullable<GitGraph["changes"]>): string {
  const parts = [
    c.staged > 0 && `ステージ済み ${c.staged}`,
    c.unstaged > 0 && `未ステージ ${c.unstaged}`,
    c.untracked > 0 && `未追跡 ${c.untracked}`,
  ].filter(Boolean);
  return parts.length === 0 ? "未コミットの変更なし" : `未コミットの変更：${parts.join("・")}`;
}

/** The branch's page on GitHub, when it is on origin (the remote the GitHub repository comes from). */
function githubBranchUrl(graph: GitGraph, b: Branch): string | undefined {
  if (!graph.github) return undefined;
  const remoteName = b.remote ? b.name : b.upstream;
  if (!remoteName?.startsWith("origin/")) return undefined;
  return githubTreeUrl(graph.github, remoteName.slice("origin/".length));
}

/** Local branches first (the checked-out one at the top), then remote branches that no local branch tracks. */
function BranchList({ graph }: { graph: GitGraph }) {
  const [open, setOpen] = useFlag("gasho.branchList", true);
  const local = graph.branches
    .filter((b) => !b.remote)
    .sort((a, b) => Number(b.name === graph.head) - Number(a.name === graph.head) || a.name.localeCompare(b.name));
  const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
  const remoteOnly = graph.branches.filter((b) => b.remote && !tracked.has(b.name)).sort((a, b) => a.name.localeCompare(b.name));
  const branches = [...local, ...remoteOnly];

  return (
    <section className="space-y-2">
      <h3>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-sm font-medium hover:text-foreground"
        >
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
          ブランチ（{branches.length}）
        </button>
      </h3>
      {open && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {branches.map((b) => (
            <BranchRow key={`${b.remote ? "r" : "l"}:${b.name}`} branch={b} head={!b.remote && b.name === graph.head} url={githubBranchUrl(graph, b)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BranchRow({ branch: b, head, url }: { branch: Branch; head: boolean; url?: string }) {
  const Icon = b.remote ? Cloud : GitBranch;
  return (
    <li className={cn("flex items-center gap-2 px-3 py-2 text-[13px]", head && "bg-emerald-500/[0.07]")}>
      <Icon
        aria-label={b.remote ? "リモートのブランチ" : "ローカルのブランチ"}
        className={cn("size-3.5 shrink-0", head ? "text-emerald-400" : b.remote ? "text-sky-300" : "text-muted-foreground")}
      />
      <span className="min-w-0 truncate font-mono" title={b.name}>
        {b.name}
      </span>
      {head && <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 text-[11px] text-emerald-300">チェックアウト中</span>}
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {!b.remote && <UpstreamState branch={b} />}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`${b.name} を GitHub で開く`}
            title="GitHub で開く"
            className="grid size-6 place-items-center rounded-md hover:bg-surface-raised hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </span>
    </li>
  );
}

function UpstreamState({ branch: b }: { branch: Branch }) {
  if (b.upstreamGone) return <span title={`${b.upstream ?? ""} は削除されています`}>上流は削除済み</span>;
  if (!b.upstream) return <span>上流なし</span>;
  if (!b.ahead && !b.behind) return <span title={`${b.upstream} と同じ`}>同期済み</span>;
  return (
    <span className="flex items-center gap-2 tabular-nums">
      {b.ahead ? (
        <span className="text-amber-300" title={`${b.upstream} にまだ push していないコミット ${b.ahead} 件`}>
          ↑{b.ahead}
        </span>
      ) : null}
      {b.behind ? (
        <span className="text-sky-300" title={`${b.upstream} にあって、まだ取り込んでいないコミット ${b.behind} 件`}>
          ↓{b.behind}
        </span>
      ) : null}
    </span>
  );
}

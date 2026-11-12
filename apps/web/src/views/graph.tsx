// Branch graph of the repository a session works in: its branches and the latest commits of all of them.
import { ArrowLeft, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type { GitBranch as Branch, GitGraph } from "@gasho/protocol";
import { CommitGraph } from "@/components/commit-graph";
import { githubTreeUrl, sessionLabel } from "@/lib/format";
import { go } from "@/lib/route";
import { loadGraph, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export function GraphView({ machine, sessionId }: { machine: string; sessionId: string }) {
  const { machines, graphs } = useAppState();
  const now = useNow(60_000);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const g = graphs[transcriptKey(machine, sessionId)];
  const graph = g?.graph;

  useEffect(() => {
    if (m?.connected) loadGraph(machine, sessionId);
  }, [machine, sessionId, m?.connected]);

  const back = (
    <button
      type="button"
      onClick={() => go({ name: "session", machine, sessionId })}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      セッションに戻る
    </button>
  );

  if (!m || !s) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        {back}
        <p className="mt-4">このセッションは見つかりません。終了したか、{m?.name ?? "この working server"} の gasho-daemon が接続していません。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-4 md:px-6">
      <header className="space-y-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">ブランチグラフ</h1>
            <p className="truncate text-xs text-muted-foreground">
              {sessionLabel(s)} · {m.name} · {graph?.root ?? s.cwd}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {graph?.github && (
              <a
                href={graph.github.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover"
              >
                GitHub で開く <ExternalLink className="size-3.5" />
              </a>
            )}
            <button
              type="button"
              onClick={() => loadGraph(machine, sessionId)}
              disabled={g?.loading || !m.connected}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3.5", g?.loading && "animate-spin")} />
              再読み込み
            </button>
          </div>
        </div>
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
      </header>

      {!m.connected && <p className="text-sm text-muted-foreground">{m.name} はオフラインです。</p>}
      {g?.error && <p className="text-sm text-red-400">{g.error}</p>}
      {!graph && g?.loading && <p className="text-sm text-muted-foreground">読み込み中…</p>}

      {graph && (
        <>
          <BranchList graph={graph} />
          <section className="space-y-2">
            <h2 className="text-sm font-medium">コミット</h2>
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

function BranchList({ graph }: { graph: GitGraph }) {
  const local = graph.branches
    .filter((b) => !b.remote)
    .sort((a, b) => Number(b.name === graph.head) - Number(a.name === graph.head) || a.name.localeCompare(b.name));
  const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
  const remoteOnly = graph.branches.filter((b) => b.remote && !tracked.has(b.name));

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">ブランチ（{local.length}）</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {local.map((b) => (
          <BranchRow key={b.name} branch={b} head={b.name === graph.head} url={githubBranchUrl(graph, b)} />
        ))}
      </ul>
      {remoteOnly.length > 0 && (
        <details className="group text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            リモートにだけあるブランチ（{remoteOnly.length}）
          </summary>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {remoteOnly.map((b) => (
              <BranchRow key={b.name} branch={b} head={false} url={githubBranchUrl(graph, b)} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function BranchRow({ branch: b, head, url }: { branch: Branch; head: boolean; url?: string }) {
  return (
    <li className={cn("flex items-center gap-2 px-3 py-2 text-[13px]", head && "bg-emerald-500/[0.07]")}>
      <GitBranch className={cn("size-3.5 shrink-0", head ? "text-emerald-400" : "text-muted-foreground")} />
      <span className="min-w-0 truncate font-mono">{b.name}</span>
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

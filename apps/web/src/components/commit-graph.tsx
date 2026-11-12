// The commit graph of a repository: one table row per commit, newest first, with its lane lines drawn in SVG.
// Nothing is cut short: subjects and branch names stay on one line in full, and the table scrolls sideways
// inside its box. The lanes column stays at the left edge while scrolling.
import { Cloud, Tag } from "lucide-react";
import { useMemo } from "react";
import type { GitCommit, GitGraph, GitHubRepo, GitRef } from "@gasho/protocol";
import { githubCommitUrl, relativeTime } from "@/lib/format";
import { layoutGraph, type GraphRow } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

const LANE = 14;
const ROW = 32;
const PAD = 4;
const COLORS = ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#fb923c", "#a3e635"];
const color = (lane: number) => COLORS[lane % COLORS.length];
const x = (lane: number) => PAD + LANE / 2 + lane * LANE;
const MID = ROW / 2;
/** The checked-out commit's tint, also painted over the opaque background of the pinned lanes cell. */
const HEAD_TINT = "rgb(16 185 129 / 0.07)";

export function CommitGraph({ graph, now }: { graph: GitGraph; now: number }) {
  const { rows, width } = useMemo(() => layoutGraph(graph.commits), [graph.commits]);
  const upstreams = useMemo(
    () => new Map(graph.branches.flatMap((b) => (!b.remote && b.upstream ? [[b.name, b.upstream] as const] : []))),
    [graph.branches],
  );
  const svgWidth = PAD * 2 + width * LANE;
  return (
    <table aria-label="コミットの履歴" className="w-max min-w-full text-[13px]">
      <tbody>
        {graph.commits.map((c, i) => {
          const row = rows[i];
          if (!row) return null;
          const isHead = c.hash === graph.headHash;
          return (
            <tr key={c.hash} style={{ height: ROW, backgroundColor: isHead ? HEAD_TINT : undefined }}>
              <td
                className="sticky left-0 z-10 bg-background p-0"
                style={isHead ? { backgroundImage: `linear-gradient(${HEAD_TINT}, ${HEAD_TINT})` } : undefined}
              >
                <Lanes row={row} width={svgWidth} head={isHead} merge={c.parents.length > 1} />
              </td>
              <td className="w-full whitespace-nowrap py-0 pr-6 pl-1">
                <span className="flex items-center gap-1.5">
                  <Refs commit={c} head={isHead} headBranch={graph.head} upstreams={upstreams} />
                  <span>{c.subject}</span>
                </span>
              </td>
              <td className="whitespace-nowrap py-0 pr-4 text-xs text-muted-foreground">{c.author}</td>
              <td className="whitespace-nowrap py-0 pr-4 text-right text-xs text-muted-foreground" title={new Date(c.at).toLocaleString("ja-JP")}>
                {relativeTime(c.at, now)}
              </td>
              <td className="whitespace-nowrap py-0 pr-3">
                <ShortHash hash={c.hash} github={graph.github} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Lanes({ row, width, head, merge }: { row: GraphRow; width: number; head: boolean; merge: boolean }) {
  const col = x(row.col);
  return (
    <svg width={width} height={ROW} className="block" aria-hidden>
      <g fill="none" strokeWidth={2} strokeLinecap="round">
        {row.through.map((i) => (
          <line key={`t${i}`} x1={x(i)} y1={0} x2={x(i)} y2={ROW} stroke={color(i)} />
        ))}
        {row.into.map((i) =>
          i === row.col ? (
            <line key={`i${i}`} x1={col} y1={0} x2={col} y2={MID} stroke={color(i)} />
          ) : (
            <path key={`i${i}`} d={`M ${x(i)} 0 C ${x(i)} ${MID} ${col} 0 ${col} ${MID}`} stroke={color(i)} />
          ),
        )}
        {row.out.map((k) =>
          k === row.col ? (
            <line key={`o${k}`} x1={col} y1={MID} x2={col} y2={ROW} stroke={color(k)} />
          ) : (
            <path key={`o${k}`} d={`M ${col} ${MID} C ${col} ${ROW} ${x(k)} ${MID} ${x(k)} ${ROW}`} stroke={color(k)} />
          ),
        )}
      </g>
      {head && <circle cx={col} cy={MID} r={7.5} fill="none" stroke={color(row.col)} strokeWidth={1.5} opacity={0.6} />}
      <circle
        cx={col}
        cy={MID}
        r={head ? 5 : 4}
        fill={merge ? "var(--background)" : color(row.col)}
        stroke={color(row.col)}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  );
}

const KIND_ORDER: Record<GitRef["kind"], number> = { local: 0, remote: 1, tag: 2 };

function Refs({
  commit,
  head,
  headBranch,
  upstreams,
}: {
  commit: GitCommit;
  head: boolean;
  headBranch?: string;
  upstreams: Map<string, string>;
}) {
  // A local branch and the remote branch it tracks on the same commit make one badge, with a cloud mark.
  const here = new Set(commit.refs.map((r) => `${r.kind}:${r.name}`));
  const synced = new Set(
    commit.refs.flatMap((r) => {
      const up = r.kind === "local" ? upstreams.get(r.name) : undefined;
      return up && here.has(`remote:${up}`) ? [up] : [];
    }),
  );
  const refs = commit.refs
    .filter((r) => !(r.kind === "remote" && synced.has(r.name)))
    .sort(
      (a, b) =>
        Number(b.name === headBranch && b.kind === "local") - Number(a.name === headBranch && a.kind === "local") ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    );
  return (
    <>
      {head && !headBranch && <RefBadge label="HEAD" tone="head" title="HEAD（特定のブランチを指していません）" />}
      {refs.map((r) => {
        const up = r.kind === "local" ? upstreams.get(r.name) : undefined;
        const onRemote = up !== undefined && synced.has(up);
        const title =
          r.kind === "local"
            ? `${r.name}${r.name === headBranch ? "（チェックアウト中）" : ""}${onRemote ? `。${up} と同じコミット` : ""}`
            : r.kind === "remote"
              ? `${r.name}（リモート）`
              : `タグ ${r.name}`;
        return (
          <RefBadge
            key={`${r.kind}:${r.name}`}
            label={r.name}
            tone={r.kind === "local" && r.name === headBranch ? "head" : r.kind}
            title={title}
            onRemote={onRemote}
          />
        );
      })}
    </>
  );
}

const TONE: Record<"head" | GitRef["kind"], string> = {
  head: "bg-emerald-500 text-emerald-950 ring-emerald-400",
  local: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  remote: "bg-sky-500/10 text-sky-300 ring-sky-500/25",
  tag: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
};

function RefBadge({
  label,
  tone,
  title,
  onRemote = false,
}: {
  label: string;
  tone: "head" | GitRef["kind"];
  title: string;
  onRemote?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px font-mono text-[11px] font-medium ring-1", TONE[tone])}
    >
      {tone === "tag" && <Tag className="size-3 shrink-0" />}
      {label}
      {onRemote && <Cloud className="size-3 shrink-0 opacity-80" aria-label="リモートと同じ" />}
    </span>
  );
}

function ShortHash({ hash, github }: { hash: string; github?: GitHubRepo }) {
  const short = hash.slice(0, 7);
  const cls = "font-mono text-xs text-muted-foreground";
  return github ? (
    <a href={githubCommitUrl(github, hash)} target="_blank" rel="noreferrer" title="GitHub でコミットを開く" className={cn(cls, "hover:text-foreground hover:underline")}>
      {short}
    </a>
  ) : (
    <span className={cls}>{short}</span>
  );
}

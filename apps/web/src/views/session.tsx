import { ArrowLeft, ExternalLink, GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { ToolActivity } from "@/components/tool-activity";
import { Transcript } from "@/components/transcript";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import {
  RC_MODE_LABEL,
  branchLabel,
  claudeUrl,
  formatCost,
  relativeTime,
  repoLabel,
  sessionLabel,
  waitingLabel,
} from "@/lib/format";
import { go } from "@/lib/route";
import { loadTranscript, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";

type Tab = "chat" | "tools" | "events";

export function SessionView({ machine, sessionId }: { machine: string; sessionId: string }) {
  const { machines, transcripts, events } = useAppState();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("chat");
  const m = machines.find((x) => x.name === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const t = transcripts[transcriptKey(machine, sessionId)];
  const sessionEvents = useMemo(
    () => events.filter((e) => e.machine === machine && e.sessionId === sessionId).reverse(),
    [events, machine, sessionId],
  );

  useEffect(() => {
    if (m?.connected) loadTranscript(machine, sessionId);
  }, [machine, sessionId, m?.connected]);

  if (!s) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        <BackLink />
        <p className="mt-4">このセッションは見つかりません。終了したか、{machine} の gasho-daemon が接続していません。</p>
      </div>
    );
  }

  const url = claudeUrl(s);
  const branch = branchLabel(s);
  const cost = formatCost(s.costUSD);
  const toolCount = t?.entries.reduce((n, e) => n + e.blocks.filter((b) => b.type === "tool_use").length, 0) ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 space-y-3 border-b border-border px-4 py-3 md:px-6">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{sessionLabel(s)}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {machine} · {s.cwd} · {RC_MODE_LABEL[s.rcMode]}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {m?.connected ? <StatusBadge status={s.status} /> : <span className="text-xs text-muted-foreground">オフライン</span>}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover"
              >
                公式アプリで開く <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {s.status === "waiting" && <span className="text-amber-400">{waitingLabel(s.waitingFor) ?? "確認待ち"}</span>}
          {s.github ? (
            <a href={s.github.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
              {repoLabel(s)}
            </a>
          ) : (
            <span>{repoLabel(s)}</span>
          )}
          {branch &&
            (s.github ? (
              <a
                href={`${s.github.url}/tree/${encodeURIComponent(branch)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <GitBranch className="size-3.5" />
                {branch}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" />
                {branch}
              </span>
            ))}
          {s.prLinks.map((p) => (
            <a
              key={p.url}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
              title={p.repository}
            >
              <GitPullRequest className="size-3.5" />#{p.number}
            </a>
          ))}
          <span>最終更新 {relativeTime(s.lastActivityAt, now)}</span>
          {cost && <span>費用 {cost}</span>}
        </div>
        <AnimatedTabs
          tabs={[
            { id: "chat", label: "会話" },
            { id: "tools", label: "ツール", badge: toolCount || undefined },
            { id: "events", label: "イベント", badge: sessionEvents.length || undefined },
          ]}
          activeTab={tab}
          onChange={(id) => setTab(id as Tab)}
          renderContent={false}
          variant="pill"
        />
      </header>
      <div className="min-h-0 flex-1">
        {tab === "chat" && (
          <Transcript
            key={`${machine}/${sessionId}`}
            state={t}
            onLoadOlder={() => loadTranscript(machine, sessionId, true)}
          />
        )}
        {tab === "tools" && (
          <div className="h-full overflow-y-auto p-4 md:p-6">
            <div className="mx-auto max-w-3xl">
              <ToolActivity entries={t?.entries ?? []} busy={s.status === "busy"} agentName={sessionLabel(s)} />
            </div>
          </div>
        )}
        {tab === "events" && (
          <div className="h-full overflow-y-auto p-4 md:p-6">
            <ul className="mx-auto max-w-3xl divide-y divide-border text-sm">
              {sessionEvents.length === 0 && (
                <li className="py-8 text-center text-muted-foreground">
                  hooks のイベントはまだ届いていません。hooks を設定すると、ツールの実行や応答の完了がここに出ます。
                </li>
              )}
              {sessionEvents.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex gap-3 py-2">
                  <span className="w-14 shrink-0 text-xs text-muted-foreground">
                    {new Date(e.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="w-36 shrink-0 font-mono text-xs">{e.event}</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {[e.toolName, e.notificationType, e.summary].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function BackLink() {
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

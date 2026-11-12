import { ArrowLeft, ExternalLink, GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { StatusBadge } from "@/components/status-badge";
import { Transcript } from "@/components/transcript";
import { PromptInput } from "@/components/ui/prompt-input";
import {
  branchLabel,
  claudeUrl,
  formatCost,
  relativeTime,
  repoLabel,
  sessionLabel,
  waitingLabel,
} from "@/lib/format";
import { go } from "@/lib/route";
import { loadTranscript, sendCommand, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";

export function SessionView({ machine, sessionId }: { machine: string; sessionId: string }) {
  const { machines, transcripts } = useAppState();
  const now = useNow();
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const t = transcripts[transcriptKey(machine, sessionId)];

  useEffect(() => {
    if (m?.connected) loadTranscript(machine, sessionId);
  }, [machine, sessionId, m?.connected]);

  if (!m || !s) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        <BackLink />
        <p className="mt-4">このセッションは見つかりません。終了したか、{m?.name ?? "この working server"} の gasho-daemon が接続していません。</p>
      </div>
    );
  }

  const url = claudeUrl(s);
  const branch = branchLabel(s);
  const cost = formatCost(s.costUSD);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-3 md:px-6">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{sessionLabel(s)}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {m.name} · {s.cwd}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {m.connected ? <StatusBadge status={s.status} /> : <span className="text-xs text-muted-foreground">オフライン</span>}
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
      </header>
      <div className="min-h-0 flex-1">
        <Transcript
          key={`${machine}/${sessionId}`}
          state={t}
          onLoadOlder={() => loadTranscript(machine, sessionId, true)}
          footer={<Composer machine={m} session={s} />}
        />
      </div>
    </div>
  );
}

/** The chat box. It floats over the bottom of the conversation (see the footer of Transcript). */
function Composer({ machine, session: s }: { machine: MachineInfo; session: SessionInfo }) {
  const [error, setError] = useState<string>();
  const url = claudeUrl(s);

  if (!s.managed) {
    return (
      <div>
        <PromptInput
          variant="pill"
          onSend={() => undefined}
          disabled
          models={[]}
          allowAttachments={false}
          placeholder="Gasho からは入力できません"
          hint={false}
        />
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-xs text-muted-foreground">
          <span>claude rc が起動したセッションには、外から入力する公式の手段がありません。入力は公式アプリで行ってください。</span>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground/80 hover:text-foreground">
              公式アプリで開く <ExternalLink className="size-3" />
            </a>
          )}
        </p>
      </div>
    );
  }

  const busy = s.status === "busy";
  const offline = !machine.connected;
  const status = offline
    ? "working server がオフラインです。"
    : s.pendingInputs
      ? `送信待ち ${s.pendingInputs} 件。作業が終わったら順に送ります。`
      : s.status === "waiting"
        ? "権限の確認を待っています。公式アプリで答えてください。"
        : undefined;

  const stop = async () => {
    const r = await sendCommand(machine.id, { type: "session.interrupt", sessionId: s.sessionId });
    if (!r.ok) setError(r.error);
  };

  return (
    <div>
      <PromptInput
        variant="pill"
        onSend={async ({ text }) => {
          setError(undefined);
          const r = await sendCommand(machine.id, { type: "session.input", sessionId: s.sessionId, text });
          if (!r.ok) {
            setError(r.error);
            throw new Error(r.error);
          }
        }}
        // While Claude is working, the send button turns into a stop button (Esc also stops).
        streaming={busy}
        onStop={() => void stop()}
        disabled={offline}
        models={[]}
        allowAttachments={false}
        maxLength={20_000}
        placeholder="Agent への指示を入力…"
        hint={false}
      />
      {(status || error) && (
        <p className={error ? "mt-1.5 px-3 text-xs text-red-400" : "mt-1.5 px-3 text-xs text-muted-foreground"}>{error ?? status}</p>
      )}
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

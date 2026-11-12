import { ArrowLeft, ExternalLink, GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { MachineInfo, SessionInfo, SessionModel } from "@gasho/protocol";
import { RepoPicker } from "@/components/repo-picker";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { StatusBadge } from "@/components/status-badge";
import { Transcript } from "@/components/transcript";
import { PromptInput, type PromptModel } from "@/components/ui/prompt-input";
import {
  branchLabel,
  claudeUrl,
  formatCost,
  githubTreeUrl,
  relativeTime,
  repoLabel,
  sessionLabel,
  waitingLabel,
} from "@/lib/format";
import { go } from "@/lib/route";
import { useSessionHeaderShown } from "@/lib/session-header";
import { loadTranscript, sendCommand, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export function SessionView({ machine, sessionId }: { machine: string; sessionId: string }) {
  const { machines, transcripts } = useAppState();
  const now = useNow();
  const headerShown = useSessionHeaderShown();
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
  const cost = formatCost(s.costUSD);
  // A folder that is not a repository but holds several shows "複数のリポジトリ…" and "ブランチ…"; one that holds
  // exactly one shows that repository as if the session worked in it.
  const several = s.repos && s.repos.length >= 2 ? s.repos : undefined;
  const only = s.repos?.length === 1 ? s.repos[0] : undefined;
  const github = only ? only.github : s.github;
  const branch = only ? only.branch : branchLabel(s);
  const repoText = github ? `${github.owner}/${github.name}` : only ? only.path : repoLabel(s);
  const status = m.connected ? <StatusBadge status={s.status} /> : <span className="text-xs text-muted-foreground">オフライン</span>;

  return (
    <div className="flex h-full flex-col">
      {headerShown ? (
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
              {status}
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
              <SessionHeaderToggle className="-my-1 hidden md:grid" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {s.status === "waiting" && <span className="text-amber-400">{waitingLabel(s.waitingFor) ?? "確認待ち"}</span>}
            {several ? (
              <>
                <RepoPicker repos={several} />
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  <button
                    type="button"
                    onClick={() => go({ name: "graph", machine, sessionId })}
                    title="ブランチグラフを開き、リポジトリを切り替えて見る"
                    className="underline-offset-2 hover:text-foreground hover:underline"
                  >
                    ブランチ…
                  </button>
                </span>
              </>
            ) : github ? (
              <a href={github.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
                {repoText}
              </a>
            ) : (
              <span>{repoText}</span>
            )}
            {!several && branch && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" />
                <button
                  type="button"
                  onClick={() => go({ name: "graph", machine, sessionId, ...(only ? { repo: only.path } : {}) })}
                  title="ブランチグラフを開く"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  {branch}
                </button>
                {github && (
                  <a
                    href={githubTreeUrl(github, branch)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${branch} を GitHub で開く`}
                    title="GitHub で開く"
                    className="grid size-5 place-items-center rounded hover:bg-surface-raised hover:text-foreground"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </span>
            )}
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
      ) : (
        // Header hidden: one line keeps the session's name and status on screen. On phones the toggle is in the top bar.
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 md:px-6">
          <h1 className="min-w-0 truncate text-sm font-medium">{sessionLabel(s)}</h1>
          {status}
          <SessionHeaderToggle className="ml-auto hidden md:grid" />
        </header>
      )}
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

/** The models of Claude Code's /model picker. Picking one switches the session, for this session only, before sending. */
const MODELS: PromptModel[] = [
  { id: "default", name: "既定", description: "Claude Code の既定のモデル" },
  { id: "opus", name: "Opus", description: "複雑な作業にも、普段の作業にも" },
  { id: "fable", name: "Fable", description: "いちばん難しい課題に" },
  { id: "sonnet", name: "Sonnet", description: "簡単な作業を効率よく" },
  { id: "haiku", name: "Haiku", description: "短い質問に、いちばん速く答える" },
];
/** Files sent with one input, in all (the Gasho server checks it too). */
const MAX_FILES_BYTES = 10 * 1024 * 1024;

/** "Opus 5.5" → "opus". */
function modelFamily(label: string | undefined): SessionModel | undefined {
  const m = /^(opus|fable|sonnet|haiku)\b/.exec(label?.toLowerCase() ?? "");
  return m?.[1] as SessionModel | undefined;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}

/** The chat box. It floats over the bottom of the conversation (see the footer of Transcript). */
function Composer({ machine, session: s }: { machine: MachineInfo; session: SessionInfo }) {
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [picked, setPicked] = useState<SessionModel>();
  const current = modelFamily(s.model);
  // Once the session runs on the model that was picked, follow the session again.
  useEffect(() => {
    if (picked && picked === current) setPicked(undefined);
  }, [picked, current]);
  const url = claudeUrl(s);

  if (!s.managed) {
    return (
      <div>
        <PromptInput
          onSend={() => undefined}
          disabled
          models={MODELS}
          model={current ?? "default"}
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
        onSend={async ({ text, files, model }) => {
          setError(undefined);
          setWarning(undefined);
          const fail = (message: string): never => {
            setError(message);
            throw new Error(message);
          };
          if (files.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) fail("添付できるのは、合わせて 10MB までです。");
          // Switch only when another model was picked than the one the session uses.
          const wanted = model?.id as SessionModel | undefined;
          const switchTo = wanted && wanted !== (current ?? "default") ? wanted : undefined;
          const encoded = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
          const r = await sendCommand(
            machine.id,
            {
              type: "session.input",
              sessionId: s.sessionId,
              text,
              ...(switchTo ? { model: switchTo } : {}),
              ...(encoded.length > 0 ? { files: encoded } : {}),
            },
            120_000,
          );
          if (!r.ok) fail(r.error ?? "送れませんでした。");
          if (r.warning) setWarning(r.warning);
        }}
        // While Claude is working, the send button turns into a stop button (Esc also stops).
        streaming={busy}
        onStop={() => void stop()}
        disabled={offline}
        models={MODELS.map((m) => (m.id === current ? { ...m, badge: "いま" } : m))}
        model={picked ?? current ?? "default"}
        onModelChange={(id) => setPicked(id as SessionModel)}
        allowAttachments
        maxFiles={5}
        maxFileSizeMB={10}
        maxLength={20_000}
        placeholder="Agent への指示を入力…"
        showCount
      />
      {(status || error || warning) && (
        <p className={cn("mt-1.5 px-3 text-xs", error ? "text-red-400" : warning ? "text-amber-400" : "text-muted-foreground")}>
          {error ?? warning ?? status}
        </p>
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

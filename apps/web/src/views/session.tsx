import { ArrowLeft, ExternalLink, FolderOpen, GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { CommandResult, InputFeature, MachineInfo, SessionInfo, SessionModel } from "@gasho/protocol";
import { RepoPicker } from "@/components/repo-picker";
import { EffortPicker, UltracodeToggle } from "@/components/session-controls";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { StatusBadge } from "@/components/status-badge";
import { PermissionRequests } from "@/components/permission-card";
import { Transcript } from "@/components/transcript";
import { PromptInput, type PromptModel } from "@/components/ui/prompt-input";
import {
  branchLabel,
  formatCost,
  githubTreeUrl,
  relativeTime,
  repoLabel,
  sessionLabel,
  waitingLabel,
} from "@/lib/format";
import { promptDraft, usePicks } from "@/lib/drafts";
import { addPending, noneWaiting, pendingShown, removePending, sessionWorking, settlePending, usePending } from "@/lib/pending";
import { go, type SessionPanel } from "@/lib/route";
import { closeSessionHeaderOnPhone, useSessionHeaderShown } from "@/lib/session-header";
import { daemonAtLeast } from "@/lib/sessions";
import { loadTranscript, sendCommand, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { PluginConversationEnd, PluginHeaderItems } from "@/plugins/parts";

/** `panel`: the panel open beside the session (a computer), if any; its link in the header shows as open. */
export function SessionView({ machine, sessionId, panel }: { machine: string; sessionId: string; panel?: SessionPanel }) {
  const { machines, transcripts } = useAppState();
  const now = useNow();
  const headerShown = useSessionHeaderShown();
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const t = transcripts[transcriptKey(machine, sessionId)];
  // Messages sent from here that the conversation does not show yet.
  const sent = usePending(transcriptKey(machine, sessionId));
  // Gasho shows only the sessions it started.
  const shown = s?.managed === true;

  useEffect(() => {
    if (m?.connected && shown) loadTranscript(machine, sessionId);
  }, [machine, sessionId, m?.connected, shown]);
  useEffect(() => closeSessionHeaderOnPhone(), [machine, sessionId]);

  if (!m || !s || !shown) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
        <BackLink />
        <p className="mt-4">
          {s
            ? "このセッションは Gasho から起動したものではないので、表示しません。"
            : `このセッションは見つかりません。終了したか、${m?.name ?? "この working server"} の gasho-daemon が接続していません。`}
        </p>
      </div>
    );
  }

  // Opens a panel beside the session (in its place on a phone); one already open is swapped, not stacked in the history.
  const open = (p: SessionPanel) => go({ name: "session", machine, sessionId, panel: p }, { replace: panel !== undefined });

  const cost = formatCost(s.costUSD);
  // A folder that is not a repository but holds several shows "複数のリポジトリ…" and "ブランチ…"; one that holds
  // exactly one shows that repository as if the session worked in it.
  const several = s.repos && s.repos.length >= 2 ? s.repos : undefined;
  const only = s.repos?.length === 1 ? s.repos[0] : undefined;
  const github = only ? only.github : s.github;
  const branch = only ? only.branch : branchLabel(s);
  const repoText = github ? `${github.owner}/${github.name}` : only ? only.path : repoLabel(s);
  const status = <SessionState machine={m} session={s} />;
  const pending = sent.filter((p) => pendingShown(p, t?.entries ?? [], t?.start ?? 0, s.pendingInputs ?? 0, now));

  return (
    <div className="flex h-full flex-col">
      {headerShown ? (
        <header className="shrink-0 space-y-2 border-b border-border px-4 py-3 md:px-6">
          <BackLink />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {/* A phone has the name and the state in its top bar (see App). */}
              <h1 className="hidden truncate text-lg font-semibold tracking-tight md:block">{sessionLabel(s)}</h1>
              <p className="truncate text-xs text-muted-foreground">
                {m.name} · {s.cwd}
              </p>
            </div>
            <div className="hidden items-center gap-2 md:flex">
              {status}
              <SessionHeaderToggle className="-my-1" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {/* The plugins' items go between Gasho's own by their order (docs/plugins.md): waiting 0, repository 100,
                branch 200, files 400, pull request links 800, last activity 900, cost 1000. */}
            <PluginHeaderItems machine={m} session={s} panel={panel} from={-Infinity} to={0} />
            {s.status === "waiting" && <span className="text-amber-400">{waitingLabel(s.waitingFor) ?? "確認待ち"}</span>}
            <PluginHeaderItems machine={m} session={s} panel={panel} from={0} to={100} />
            {several ? (
              <>
                <RepoPicker repos={several} />
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3.5" />
                  <button
                    type="button"
                    onClick={() => open({ kind: "graph" })}
                    title="ブランチグラフを開き、リポジトリを切り替えて見る"
                    aria-pressed={panel?.kind === "graph"}
                    className={cn("underline-offset-2 hover:text-foreground hover:underline", panel?.kind === "graph" && "text-foreground")}
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
            <PluginHeaderItems machine={m} session={s} panel={panel} from={100} to={200} />
            {!several && branch && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" />
                <button
                  type="button"
                  onClick={() => open({ kind: "graph", ...(only ? { repo: only.path } : {}) })}
                  title="ブランチグラフを開く"
                  aria-pressed={panel?.kind === "graph"}
                  className={cn("underline-offset-2 hover:text-foreground hover:underline", panel?.kind === "graph" && "text-foreground")}
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
            <PluginHeaderItems machine={m} session={s} panel={panel} from={200} to={400} />
            {/* gasho-daemon 0.11 reads and writes the files of the session's folder. */}
            {daemonAtLeast(m, 0, 11) && (
              <PanelLink
                icon={<FolderOpen className="size-3.5" />}
                open={panel?.kind === "files" || panel?.kind === "file"}
                title="このセッションのフォルダーのファイルを開く"
                onClick={() => open({ kind: "files" })}
              >
                ファイル
              </PanelLink>
            )}
            <PluginHeaderItems machine={m} session={s} panel={panel} from={400} to={800} />
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
            <PluginHeaderItems machine={m} session={s} panel={panel} from={800} to={900} />
            <span>最終更新 {relativeTime(s.lastActivityAt, now)}</span>
            <PluginHeaderItems machine={m} session={s} panel={panel} from={900} to={1000} />
            {cost && <span>費用 {cost}</span>}
            <PluginHeaderItems machine={m} session={s} panel={panel} from={1000} to={Infinity} />
          </div>
        </header>
      ) : (
        // Header hidden: one line keeps the session's name and state on screen. A phone has them in its top bar (see
        // App), with the toggle, so it leaves this line out and the conversation gets the room.
        <header className="hidden shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 md:flex md:px-6">
          <h1 className="min-w-0 truncate text-sm font-medium">{sessionLabel(s)}</h1>
          {status}
          <SessionHeaderToggle className="ml-auto" />
        </header>
      )}
      <div className="min-h-0 flex-1">
        <Transcript
          key={`${machine}/${sessionId}`}
          state={t}
          pending={pending}
          onLoadOlder={() => loadTranscript(machine, sessionId, true)}
          footer={<Composer machine={m} session={s} entries={t?.total ?? 0} />}
          end={<PluginConversationEnd machine={m} session={s} />}
        />
      </div>
    </div>
  );
}

/** The session's state, or "オフライン" while its working server is not connected. Also in a phone's top bar (see App). */
export function SessionState({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  return machine.connected ? (
    <StatusBadge status={session.status} />
  ) : (
    <span className="shrink-0 text-xs text-muted-foreground">オフライン</span>
  );
}

/**
 * The models of Claude Code's /model picker. Picking one switches the session, for this session only, before sending.
 * The names with their versions ("Opus 5.5") come from the working server, which reads them from the picker.
 */
const MODELS: { id: SessionModel; name: string; description: string }[] = [
  { id: "default", name: "既定", description: "Claude Code の既定（おすすめ）のモデル" },
  { id: "opus", name: "Opus", description: "複雑な作業にも、普段の作業にも" },
  { id: "fable", name: "Fable", description: "いちばん難しい課題に" },
  { id: "sonnet", name: "Sonnet", description: "簡単な作業を効率よく" },
  { id: "haiku", name: "Haiku", description: "短い質問に、いちばん速く答える" },
];

/**
 * The first option when the session's model is not one of the picker's: a model the picker does not list by that
 * name (say "Opus 4.6"). Picking it switches nothing.
 */
const KEEP_MODEL = "keep";
/**
 * How long after the working server read the picker the name of the model that the default stands for is shown
 * ("既定（Sonnet 5.5）"): the default can move to another model, the other names hardly change. After an hour, the
 * option says when it was read.
 */
const DEFAULT_NAME_MAX_AGE_MS = 24 * 3600_000;
const DEFAULT_NAME_AGE_NOTE_MS = 3600_000;

/**
 * What a gasho-daemon that does not list its features (older than 0.6.0) can do with an input: 0.5 switches the model
 * and carries files; older ones only type the text.
 */
function legacyFeatures(daemonVersion: string | undefined): InputFeature[] {
  const [major = 0, minor = 0] = (daemonVersion ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return major > 0 || minor >= 5 ? ["model", "files"] : [];
}

/**
 * The picker's options with the names the working server read ("既定（Sonnet 5.5）", "Opus 5.5"). The session's
 * model and the picked one are always among them; a model that is not one of the picker's comes first.
 */
function modelOptions(
  machine: MachineInfo,
  current: SessionModel | typeof KEEP_MODEL | undefined,
  label: string | undefined,
  picked?: SessionModel,
): PromptModel[] {
  const now = Date.now();
  const named = new Map(machine.models?.map((m) => [m.id, m.name]));
  // The session's own name for the default ("Sonnet 5.5 (default)") is the surest; the picker's is from when it was read.
  const ownDefault = current === "default" ? label?.replace(/\s*\(default\)\s*$/i, "").trim() : undefined;
  const readAt = machine.modelsAt;
  const fresh = readAt !== undefined && now - readAt < DEFAULT_NAME_MAX_AGE_MS;
  const options: PromptModel[] = MODELS.filter((m) => !machine.models || named.has(m.id) || m.id === current || m.id === picked).map(
    (m) => {
      const name = named.get(m.id);
      let shown = name ?? m.name;
      let description = m.description;
      if (m.id === "default") {
        shown = ownDefault ? `既定（${ownDefault}）` : name && fresh ? `既定（${name}）` : m.name;
        if (!ownDefault && name && fresh && readAt !== undefined && now - readAt > DEFAULT_NAME_AGE_NOTE_MS) {
          description = `${m.description}（${relativeTime(readAt, now)}に確認）`;
        }
      }
      return { id: m.id, name: shown, description, ...(m.id === current ? { badge: "いま" } : {}) };
    },
  );
  if (current === KEEP_MODEL && label) {
    options.unshift({ id: KEEP_MODEL, name: label, description: "このセッションがいま使っているモデル", badge: "いま" });
  }
  return options;
}
/** Files sent with one input, in all (the Gasho server checks it too). */
const MAX_FILES_BYTES = 10 * 1024 * 1024;

/**
 * Which of the picker's models the session uses, from Claude Code's name for it: "Sonnet 5.5 (default)" (its name
 * after picking the default) is the default, and other names must equal a name the picker gives ("Opus 5.5"). A
 * session on a model the picker does not list ("Opus 4.6") is KEEP_MODEL. Without the picker's names, the family
 * ("opus") is the best guess. Undefined while not known: gasho-daemon reads it from Claude Code's welcome banner
 * soon after the session starts, so this is brief; the default is shown meanwhile.
 */
function currentModel(machine: MachineInfo, label: string | undefined): SessionModel | typeof KEEP_MODEL | undefined {
  if (!label) return undefined;
  if (/\(default\)/i.test(label)) return "default";
  const name = label.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
  if (machine.models) {
    return machine.models.find((m) => m.id !== "default" && m.name.toLowerCase() === name)?.id ?? KEEP_MODEL;
  }
  return (/^(opus|fable|sonnet|haiku)\b/.exec(name)?.[1] as SessionModel | undefined) ?? KEEP_MODEL;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}

/**
 * The chat box. It floats over the bottom of the conversation (see the footer of Transcript). What is typed and picked
 * in it is kept per session (see lib/drafts), and a message sent shows in the conversation at once (see lib/pending).
 * `entries`: how many entries the conversation has.
 */
function Composer({ machine, session: s, entries }: { machine: MachineInfo; session: SessionInfo; entries: number }) {
  const key = transcriptKey(machine.id, s.sessionId);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [picks, setPicks] = usePicks(key);
  const { model: picked, effort: pickedEffort, ultracode: pickedUltracode } = picks;
  const current = currentModel(machine, s.model);
  const ultracode = Boolean(s.ultracode);
  const features = machine.features ?? legacyFeatures(machine.daemonVersion);
  // Once the session runs with what was picked, follow the session again.
  useEffect(() => {
    if (picked && picked === current) setPicks((p) => (p.model === current ? { ...p, model: undefined } : p));
  }, [picked, current, setPicks]);
  useEffect(() => {
    if (pickedEffort && pickedEffort === s.effort) setPicks((p) => (p.effort === s.effort ? { ...p, effort: undefined } : p));
  }, [pickedEffort, s.effort, setPicks]);
  useEffect(() => {
    if (pickedUltracode !== undefined && pickedUltracode === ultracode) {
      setPicks((p) => (p.ultracode === ultracode ? { ...p, ultracode: undefined } : p));
    }
  }, [pickedUltracode, ultracode, setPicks]);
  // Messages that waited on the working server have been typed into the session once it has none waiting.
  useEffect(() => {
    if (!s.pendingInputs) noneWaiting(key);
  }, [key, s.pendingInputs]);
  // A shell command typed from here runs while the session works; Claude Code records it once it has ended.
  useEffect(() => sessionWorking(key, s.status === "busy"), [key, s.status]);

  if (!s.managed) {
    return (
      <div>
        <PermissionRequests machine={machine} session={s} />
        <PromptInput
          onSend={() => undefined}
          disabled
          models={modelOptions(machine, current, s.model)}
          model={current ?? "default"}
          placeholder="Gasho からは入力できません"
          hint={false}
        />
        <p className="mt-1.5 px-3 text-xs text-muted-foreground">
          claude rc が起動したセッションには、外から入力する公式の手段がありません。入力は公式アプリで行ってください。
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
      : s.status === "waiting" && !s.permissionRequests?.length
        ? "確認を待っています。端末か公式アプリで答えてください。"
        : undefined;

  const stop = async () => {
    const r = await sendCommand(machine.id, { type: "session.interrupt", sessionId: s.sessionId });
    if (!r.ok) setError(r.error);
  };

  return (
    <div>
      <PermissionRequests machine={machine} session={s} />
      <PromptInput
        onSend={async ({ text, files }) => {
          setError(undefined);
          setWarning(undefined);
          const fail = (message: string): never => {
            setError(message);
            throw new Error(message);
          };
          if (files.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) fail("添付できるのは、合わせて 10MB までです。");
          // Switch only what was picked and differs from what the session uses (any pick, while its model is not known).
          const switchTo = picked && picked !== current ? picked : undefined;
          const effort = pickedEffort && pickedEffort !== s.effort ? pickedEffort : undefined;
          const ultra = pickedUltracode !== undefined && pickedUltracode !== ultracode ? pickedUltracode : undefined;
          // Shown at the end of the conversation at once: Claude Code records the message only once it is typed into
          // the session, after switching the model (/model) and the like.
          const pending = addPending(key, { text, files: files.map((f) => f.name), after: entries });
          let r: CommandResult;
          try {
            const encoded = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) })));
            r = await sendCommand(
              machine.id,
              {
                type: "session.input",
                sessionId: s.sessionId,
                text,
                ...(switchTo ? { model: switchTo } : {}),
                ...(effort ? { effort } : {}),
                ...(ultra !== undefined ? { ultracode: ultra } : {}),
                ...(encoded.length > 0 ? { files: encoded } : {}),
              },
              // A little longer than the Gasho server waits for the working server.
              160_000,
            );
          } catch (e) {
            removePending(key, pending);
            throw e;
          }
          if (!r.ok) {
            removePending(key, pending);
            fail(r.error ?? "送れませんでした。");
          }
          settlePending(key, pending, r.queued ? "queued" : "sent");
          if (r.warning) setWarning(r.warning);
          // What could not be switched stays as the session has it: drop the pick, so the control shows that again.
          // A pick changed while this was being sent is for the next message, and stays.
          for (const field of r.unapplied ?? []) {
            if (field === "model") setPicks((p) => (p.model === switchTo ? { ...p, model: undefined } : p));
            else if (field === "effort") setPicks((p) => (p.effort === effort ? { ...p, effort: undefined } : p));
            else setPicks((p) => (p.ultracode === ultra ? { ...p, ultracode: undefined } : p));
          }
        }}
        // While Claude is working, the send button turns into a stop button (Esc also stops).
        streaming={busy}
        onStop={() => void stop()}
        disabled={offline}
        models={features.includes("model") ? modelOptions(machine, current, s.model, picked) : []}
        model={picked ?? current ?? "default"}
        onModelChange={(id) => setPicks((p) => ({ ...p, model: id === KEEP_MODEL ? undefined : (id as SessionModel) }))}
        actions={
          <>
            {features.includes("effort") && (
              <EffortPicker
                value={pickedEffort ?? s.effort}
                current={s.effort}
                onChange={(level) => setPicks((p) => ({ ...p, effort: level }))}
                disabled={offline}
              />
            )}
            {features.includes("ultracode") && (
              <UltracodeToggle
                value={pickedUltracode ?? ultracode}
                current={ultracode}
                onChange={(on) => setPicks((p) => ({ ...p, ultracode: on }))}
                disabled={offline}
              />
            )}
          </>
        }
        draft={promptDraft(key)}
        allowAttachments={features.includes("files")}
        maxFiles={5}
        maxFileSizeMB={10}
        maxLength={20_000}
        placeholder="Agent への指示を入力…"
        showCount
        shell
      />
      {(status || error || warning) && (
        <p className={cn("mt-1.5 px-3 text-xs", error ? "text-red-400" : warning ? "text-amber-400" : "text-muted-foreground")}>
          {error ?? warning ?? status}
        </p>
      )}
    </div>
  );
}

/** A text in the session's header that opens one of its panels. */
function PanelLink({
  icon,
  open,
  title,
  onClick,
  children,
}: {
  icon: ReactNode;
  open: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={open}
      className={cn("inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline", open && "text-foreground")}
    >
      {icon}
      {children}
    </button>
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

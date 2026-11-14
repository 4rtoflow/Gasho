// Starts a new session on a working server: `claude --remote-control` in a terminal of its own. The same form shows on
// the home screen (LaunchPanel) and in a dialog opened from the sidebar's "＋" (LaunchDialog). Before starting, a new
// folder can be made inside the chosen folder, or a GitHub repository cloned into it (`gh repo clone`). Claude Code is
// told to trust a folder only once the person has read why it asks and said so.
import { Check, FolderGit2, FolderPlus, LoaderCircle, Plus, TriangleAlert, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { childPath, folderChoices, folderNameProblem, repoFolderName, repoProblem } from "@/lib/folders";
import { go } from "@/lib/route";
import { daemonAtLeast } from "@/lib/sessions";
import { sendCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";

const OTHER = "\u0000other";
const TITLE = "新しいセッションを起動する";
const NONE: readonly string[] = [];
/** How long to wait for each answer, a little longer than the Gasho server does: gasho-daemon stops a clone after 10 minutes. */
const LAUNCH_WAIT_MS = 60_000;
const FOLDER_WAIT_MS = 20_000;
const CLONE_WAIT_MS = 660_000;

type Tool = "folder" | "clone";

function Description() {
  return (
    <>
      working server で <code className="font-mono">claude --remote-control</code> を起動します。Gasho から入力でき、公式アプリからも操作できます。
    </>
  );
}

/** Enter in a field of a tool runs the tool, not the form's launch (and not while a Japanese input method converts). */
const onEnter = (run: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
  e.preventDefault();
  run();
};

/**
 * The form: working server, name and folder, with the tools that make a folder or clone a repository into the chosen
 * one. Once the session has started, `onLaunched` is called and the session opens. `onBusyChange` tells whether
 * something waits for its answer.
 */
function LaunchForm({
  header,
  className,
  onLaunched,
  onBusyChange,
}: {
  header: ReactNode;
  className?: string;
  onLaunched: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { machines } = useAppState();
  const candidates = useMemo(() => machines.filter((m) => m.connected && m.canLaunch), [machines]);
  const [machineId, setMachineId] = useState(candidates[0]?.id ?? "");
  const machine = candidates.find((m) => m.id === machineId) ?? candidates[0];
  // gasho-daemon 0.10.0 makes folders, clones, and answers Claude Code's question whether to trust a folder.
  const canMake = machine !== undefined && daemonAtLeast(machine, 0, 10);
  // Folders made here, per working server: offered until the working server lists them itself (once they are trusted).
  const [made, setMade] = useState<Record<string, string[]>>({});
  const madeHere = (machine && made[machine.id]) || NONE;
  const folders = useMemo(() => folderChoices(machine?.folders ?? [], madeHere, canMake), [machine, madeHere, canMake]);
  const [folder, setFolder] = useState(machine?.folders?.[0] ?? OTHER);
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A launch that stopped at Claude Code's question whether to trust the folder, and what Claude Code pointed out.
  const [trustAsk, setTrustAsk] = useState<{ cwd: string; warnings: string[] }>();
  // A session that started with something to tell, shown before it opens.
  const [started, setStarted] = useState<{ machine: string; sessionId: string; warning: string }>();
  const [tool, setTool] = useState<Tool>();
  const [folderName, setFolderName] = useState("");
  const [repo, setRepo] = useState("");
  const [cloneAs, setCloneAs] = useState("");
  const [working, setWorking] = useState<Tool>();
  const [toolError, setToolError] = useState<string>();
  // What the last tool made; a clone offers to start in it.
  const [madeNotice, setMadeNotice] = useState<{ text: string; path: string; offer: boolean }>();

  const cwd = folder === OTHER ? custom.trim() : folder;
  const pending = busy || working !== undefined;
  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  const open = (machine: string, sessionId: string) => {
    onLaunched();
    go({ name: "session", machine, sessionId });
  };

  const launch = async (dir: string, trust: boolean) => {
    if (!machine || !dir || pending) return;
    setBusy(true);
    setError(undefined);
    setTrustAsk(undefined);
    const r = await sendCommand(
      machine.id,
      { type: "session.launch", cwd: dir, name: name.trim() || undefined, ...(trust ? { trust: true } : {}) },
      LAUNCH_WAIT_MS,
    );
    setBusy(false);
    if (!r.ok || !r.sessionId) {
      if (r.needsTrust) setTrustAsk({ cwd: dir, warnings: r.trustWarnings ?? [] });
      else setError(r.error ?? "起動できませんでした。");
      return;
    }
    if (r.warning) setStarted({ machine: machine.id, sessionId: r.sessionId, warning: r.warning });
    else open(machine.id, r.sessionId);
  };

  const remember = (machine: string, dir: string) => setMade((m) => ({ ...m, [machine]: [...(m[machine] ?? []), dir] }));

  const makeFolder = async () => {
    if (!machine || !cwd || pending) return;
    const n = folderName.trim();
    const problem = folderNameProblem(n);
    if (problem) {
      setToolError(problem);
      return;
    }
    setWorking("folder");
    setToolError(undefined);
    setMadeNotice(undefined);
    const r = await sendCommand(machine.id, { type: "folder.create", parent: cwd, name: n }, FOLDER_WAIT_MS);
    setWorking(undefined);
    if (!r.ok || !r.path) {
      setToolError(r.error ?? "フォルダーを作れませんでした。");
      return;
    }
    remember(machine.id, r.path);
    // The new folder is where the next clone goes and where the session starts.
    setFolder(r.path);
    setTrustAsk(undefined);
    setFolderName("");
    setTool(undefined);
    setMadeNotice({ text: "フォルダーを作って、選びました", path: r.path, offer: false });
  };

  const clone = async () => {
    if (!machine || !cwd || pending) return;
    const what = repo.trim();
    const as = cloneAs.trim();
    const problem = repoProblem(what) ?? (as ? folderNameProblem(as) : repoFolderName(what) ? undefined : "clone 先のフォルダーの名前を入れてください。");
    if (problem) {
      setToolError(problem);
      return;
    }
    setWorking("clone");
    setToolError(undefined);
    setMadeNotice(undefined);
    const r = await sendCommand(machine.id, { type: "repo.clone", parent: cwd, repo: what, ...(as ? { name: as } : {}) }, CLONE_WAIT_MS);
    setWorking(undefined);
    if (!r.ok || !r.path) {
      setToolError(r.error ?? "clone できませんでした。");
      return;
    }
    remember(machine.id, r.path);
    // The chosen folder stays, so that more repositories can be cloned next to this one.
    setRepo("");
    setCloneAs("");
    setMadeNotice({ text: `${what} を clone しました`, path: r.path, offer: true });
  };

  const toggle = (t: Tool) => {
    setTool((open) => (open === t ? undefined : t));
    setToolError(undefined);
  };

  const field =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover disabled:opacity-60";
  const toolButton = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 [&>svg]:size-3.5",
      active ? "border-border-hover bg-surface-raised text-foreground" : "border-border text-muted-foreground hover:bg-surface-raised hover:text-foreground",
    );
  const cloneTarget = cwd && childPath(cwd, cloneAs.trim() || repoFolderName(repo.trim()) || "…");

  if (started) {
    return (
      <div className={cn("space-y-4", className)}>
        {header}
        <p className="flex items-center gap-2 text-sm text-foreground">
          <Check className="size-4 text-emerald-400" />
          起動しました。
        </p>
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{started.warning}</p>
        <div className="flex justify-end">
          <button type="button" onClick={() => open(started.machine, started.sessionId)} className={BUTTON_PRIMARY}>
            セッションを開く
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void launch(cwd, false);
      }}
      className={cn("space-y-4", className)}
    >
      {header}

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          起動できる working server がありません。接続していて、セッションの端末を作れる working server が必要です（gasho-daemon の doctor の「端末」）。
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">working server</span>
              <select
                value={machine?.id}
                disabled={pending}
                onChange={(e) => {
                  setMachineId(e.target.value);
                  const next = candidates.find((m) => m.id === e.target.value);
                  setFolder(next?.folders?.[0] ?? OTHER);
                  setTrustAsk(undefined);
                  setError(undefined);
                  setToolError(undefined);
                  setMadeNotice(undefined);
                }}
                className={field}
              >
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">名前（任意。公式アプリにこの名前で出ます）</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                // gasho-daemon 0.10.0 and later name a session started without one after its first message.
                placeholder={machine && daemonAtLeast(machine, 0, 10) ? "空なら、最初のメッセージから付けます" : "例：Bobert の調査"}
                className={field}
              />
            </label>
          </div>

          <div className="space-y-2">
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">フォルダー</span>
              <select
                value={folder}
                disabled={pending}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setTrustAsk(undefined);
                  setError(undefined);
                }}
                className={field}
              >
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
                <option value={OTHER}>ほかのフォルダーを入力する…</option>
              </select>
            </label>
            {folder === OTHER && (
              <input
                value={custom}
                disabled={pending}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setTrustAsk(undefined);
                }}
                placeholder="/home/rg/repos/…（絶対パス）"
                className={`${field} font-mono`}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            )}

            {canMake ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => toggle("folder")} disabled={!cwd || pending} aria-expanded={tool === "folder"} className={toolButton(tool === "folder")}>
                  <FolderPlus />
                  新しいフォルダー
                </button>
                <button type="button" onClick={() => toggle("clone")} disabled={!cwd || pending} aria-expanded={tool === "clone"} className={toolButton(tool === "clone")}>
                  <FolderGit2 />
                  GitHub から clone
                </button>
              </div>
            ) : (
              machine && (
                <p className="text-xs text-muted-foreground">
                  フォルダーの作成と clone は、{machine.name} の gasho-daemon を 0.10.0 以上に更新すると使えます。
                </p>
              )
            )}

            {canMake && tool === "folder" && cwd && (
              <div className="space-y-2 rounded-lg border border-border bg-background/40 p-3">
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">選んだフォルダーの中に作るフォルダーの名前</span>
                  <input
                    autoFocus
                    value={folderName}
                    disabled={pending}
                    onChange={(e) => {
                      setFolderName(e.target.value);
                      setToolError(undefined);
                    }}
                    onKeyDown={onEnter(() => void makeFolder())}
                    placeholder="例：my-workspace"
                    className={`${field} font-mono`}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">{childPath(cwd, folderName.trim() || "…")}</p>
                  <button type="button" onClick={() => void makeFolder()} disabled={pending || !folderName.trim()} className={cn(BUTTON_SECONDARY, "ml-auto h-8 shrink-0 px-3")}>
                    {working === "folder" ? "作っています…" : "作る"}
                  </button>
                </div>
              </div>
            )}

            {canMake && tool === "clone" && cwd && (
              <div className="space-y-2 rounded-lg border border-border bg-background/40 p-3">
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">リポジトリ（owner/name か、GitHub の URL）</span>
                  <input
                    autoFocus
                    value={repo}
                    disabled={pending}
                    onChange={(e) => {
                      setRepo(e.target.value);
                      setToolError(undefined);
                    }}
                    onKeyDown={onEnter(() => void clone())}
                    placeholder="例：owner/repo"
                    className={`${field} font-mono`}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">フォルダーの名前（任意。空ならリポジトリの名前）</span>
                  <input
                    value={cloneAs}
                    disabled={pending}
                    onChange={(e) => {
                      setCloneAs(e.target.value);
                      setToolError(undefined);
                    }}
                    onKeyDown={onEnter(() => void clone())}
                    placeholder={repoFolderName(repo.trim()) ?? ""}
                    className={`${field} font-mono`}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">{cloneTarget}</p>
                  <button type="button" onClick={() => void clone()} disabled={pending || !repo.trim()} className={cn(BUTTON_SECONDARY, "ml-auto h-8 shrink-0 px-3")}>
                    {working === "clone" ? (
                      <>
                        <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
                        clone しています…
                      </>
                    ) : (
                      "clone する"
                    )}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {machine?.name} の GitHub CLI で <code className="font-mono">gh repo clone</code> します。gh のログインが要ります。大きいリポジトリでは数分かかります。
                </p>
              </div>
            )}

            {toolError && <p className="text-sm text-red-400">{toolError}</p>}
            {madeNotice && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm">
                <p className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-emerald-300">
                    <Check className="size-4 shrink-0" />
                    {madeNotice.text}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">{madeNotice.path}</span>
                </p>
                {madeNotice.offer && folder !== madeNotice.path && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setFolder(madeNotice.path);
                      // Done cloning: left open, the tool would clone into the repository just picked.
                      setTool(undefined);
                      setTrustAsk(undefined);
                      setError(undefined);
                    }}
                    className={cn(BUTTON_SECONDARY, "ml-auto h-8 shrink-0 px-3")}
                  >
                    このフォルダーを選ぶ
                  </button>
                )}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {canMake
              ? "一覧には、Claude Code が信頼しているフォルダーと、その親フォルダーが出ます。Claude Code がまだ信頼していないフォルダーで起動するときは、信頼するかを先に確かめます。"
              : "一覧に出るのは、Claude Code がすでに信頼しているフォルダーです。ほかのフォルダーは、端末で一度 claude を起動して信頼してから使ってください。"}
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {trustAsk ? (
            <TrustQuestion
              cwd={trustAsk.cwd}
              warnings={trustAsk.warnings}
              onTrust={() => void launch(trustAsk.cwd, true)}
              onCancel={() => setTrustAsk(undefined)}
            />
          ) : (
            <button
              type="submit"
              disabled={pending || !cwd}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Plus className="size-4" />
              {busy ? "起動しています…（最大30秒）" : "起動する"}
            </button>
          )}
        </>
      )}
    </form>
  );
}

/**
 * Claude Code asked whether to trust the folder, and the launch stopped there: what trusting means, what Claude Code
 * pointed out about the folder (in its own words), and the choice. Only "信頼して起動する" lets gasho-daemon answer yes.
 */
function TrustQuestion({ cwd, warnings, onTrust, onCancel }: { cwd: string; warnings: string[]; onTrust: () => void; onCancel: () => void }) {
  return (
    <section aria-labelledby="launch-trust-title" className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm">
      <p id="launch-trust-title" className="flex items-center gap-2 font-medium text-amber-200">
        <TriangleAlert className="size-4 shrink-0" />
        このフォルダーは、まだ Claude Code に信頼されていません
      </p>
      <p className="break-all font-mono text-xs text-amber-100/80">{cwd}</p>
      <p className="text-amber-100/90">
        信頼すると、Claude Code はこのフォルダーのファイルを読み書きし、コマンドを実行できるようになります。フォルダーの中の設定（.claude/settings.json
        の許可や hooks など）も使われます。自分で作ったものや、よく知っているリポジトリだけを信頼してください。信頼したことは Claude Code
        に保存され、次からは確かめません。
      </p>
      {warnings.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-200">Claude Code からの注意</p>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="rounded-md bg-black/20 px-2 py-1.5 text-xs break-words text-amber-50/90">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-amber-100/70">フォルダーの .mcp.json に MCP サーバーがあっても、Gasho は有効にしません（使わない設定にして起動します）。</p>
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" autoFocus onClick={onCancel} className={BUTTON_SECONDARY}>
          やめる
        </button>
        <button type="button" onClick={onTrust} className={BUTTON_PRIMARY}>
          信頼して起動する
        </button>
      </div>
    </section>
  );
}

/** The form on the home screen, under its "新しいセッション" button. */
export function LaunchPanel({ onClose }: { onClose: () => void }) {
  return (
    <LaunchForm
      className="rounded-2xl border border-border bg-surface/50 p-4"
      onLaunched={onClose}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">{TITLE}</h2>
            <p className="text-xs text-muted-foreground">
              <Description />
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="閉じる">
            <X className="size-4" />
          </button>
        </div>
      }
    />
  );
}

/**
 * The form in a dialog, from any page (the sidebar's "＋"). While something waits for its answer (a launch, a new
 * folder, a clone), the dialog stays open to show it: a launch's answer opens the new session. `onLaunched` is called
 * once it has started.
 */
export function LaunchDialog({ open, onClose, onLaunched }: { open: boolean; onClose: () => void; onLaunched?: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          className={cn(DIALOG_PANEL, "w-[min(36rem,calc(100vw-2rem))]")}
          onOpenAutoFocus={(e) => {
            // The first field rather than the close button; a select does not bring up a phone's keyboard.
            const first = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("select, input");
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }}
        >
          <LaunchForm
            onBusyChange={setBusy}
            onLaunched={() => {
              onClose();
              onLaunched?.();
            }}
            header={
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <Dialog.Title className="text-base font-semibold tracking-tight">{TITLE}</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted-foreground">
                    <Description />
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="閉じる">
                    <X className="size-4" />
                  </button>
                </Dialog.Close>
              </div>
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

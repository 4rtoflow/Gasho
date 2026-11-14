// Registers repositories with each working server and takes them off (repo.register, repo.unregister). The sidebar lists
// the worktrees of a registered repository as git lists them, also those without a session (see worktreesByLastUse).
import { FolderGit2, LoaderCircle, Plus, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useMemo, useState } from "react";
import type { MachineInfo, SessionCommand } from "@gasho/protocol";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { registeredRepoName } from "@/lib/sessions";
import { sendCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";

const OTHER = "\u0000other";
/** A little longer than the Gasho server waits. */
const WAIT_MS = 20_000;
const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover disabled:opacity-60";

/**
 * The folders offered to register on a working server: the repositories its sessions are in (also those started
 * elsewhere), then the folders Claude Code trusts there. Registered repositories and their worktrees are left out.
 */
function folderChoices(m: MachineInfo): string[] {
  const taken = new Set((m.repos ?? []).flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)]));
  const inSessions = m.sessions.flatMap((s) => (s.worktree ? [s.worktree.repo] : [])).sort();
  return [...new Set([...inSessions, ...(m.folders ?? [])])].filter((f) => !taken.has(f));
}

export function ReposDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { machines } = useAppState();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content className={cn(DIALOG_PANEL, "w-[min(36rem,calc(100vw-2rem))] space-y-5")}>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="text-base font-semibold tracking-tight">リポジトリの登録</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                登録したリポジトリの worktree は、Gasho の会話が無くてもサイドバーに出ます。working server ごとに登録します。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="閉じる">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          {machines.length === 0 ? (
            <p className="text-sm text-muted-foreground">working server がありません。</p>
          ) : (
            machines.map((m) => <MachineRepos key={m.id} machine={m} />)
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MachineRepos({ machine }: { machine: MachineInfo }) {
  const repos = machine.repos;
  const choices = useMemo(() => folderChoices(machine), [machine]);
  const [folder, setFolder] = useState<string>();
  const [custom, setCustom] = useState("");
  // The folder being registered, or the repository being taken off.
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // A folder picked before it was registered meanwhile (from another browser, say) is no longer offered.
  const picked = folder === OTHER || (folder !== undefined && choices.includes(folder)) ? folder : (choices[0] ?? OTHER);
  const dir = picked === OTHER ? custom.trim() : picked;

  const send = async (cmd: Extract<SessionCommand, { type: "repo.register" | "repo.unregister" }>, failed: string) => {
    setBusy(cmd.path);
    setError(undefined);
    setNotice(undefined);
    const r = await sendCommand(machine.id, cmd, WAIT_MS);
    setBusy(undefined);
    if (!r.ok) setError(r.error ?? failed);
    return r;
  };
  const register = async () => {
    if (!dir || busy) return;
    if (!dir.startsWith("/")) return setError("フォルダーを絶対パスで入れてください。");
    const r = await send({ type: "repo.register", path: dir }, "登録できませんでした。");
    if (!r.ok) return;
    setNotice(`登録しました：${r.path ?? dir}`);
    setFolder(undefined);
    setCustom("");
  };

  return (
    <section aria-label={machine.name} className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {machine.name}
        {!machine.connected && <span className="text-xs font-normal text-muted-foreground">オフライン</span>}
      </h3>
      {repos === undefined ? (
        <p className="text-xs text-muted-foreground">
          {machine.connected
            ? "この working server の gasho-daemon は古いため、リポジトリを登録できません。gasho-daemon を更新してください。"
            : "つながると、登録したリポジトリがここに出ます。"}
        </p>
      ) : (
        <>
          {repos.length === 0 ? (
            <p className="text-xs text-muted-foreground">登録したリポジトリはありません。</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {repos.map((r) => (
                <li key={r.path} className="flex items-center gap-3 px-3 py-2">
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {registeredRepoName(r)}
                      <span className="text-xs text-muted-foreground"> · worktree {r.worktrees.length}</span>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={r.path}>
                      {r.path}
                    </p>
                    {r.error && <p className="text-xs text-red-400">{r.error}</p>}
                  </div>
                  <button
                    type="button"
                    disabled={!machine.connected || busy !== undefined}
                    onClick={() => void send({ type: "repo.unregister", path: r.path }, "解除できませんでした。")}
                    className={cn(BUTTON_SECONDARY, "h-8 shrink-0 px-3")}
                  >
                    {busy === r.path ? "解除しています…" : "解除"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {machine.connected && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void register();
              }}
              className="space-y-2"
            >
              <label className="block space-y-1.5">
                <span className="text-xs text-muted-foreground">登録するフォルダー（worktree のフォルダーや、worktree を並べた親フォルダーなら、そのリポジトリを登録します）</span>
                <select value={picked} disabled={busy !== undefined} onChange={(e) => setFolder(e.target.value)} className={FIELD}>
                  {choices.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                  <option value={OTHER}>ほかのフォルダーを入力する…</option>
                </select>
              </label>
              {picked === OTHER && (
                <input
                  value={custom}
                  disabled={busy !== undefined}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="/home/rg/repos/…（絶対パス）"
                  aria-label="登録するフォルダー（絶対パス）"
                  className={cn(FIELD, "font-mono")}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              )}
              <button type="submit" disabled={busy !== undefined || !dir} className={cn(BUTTON_PRIMARY, "gap-1.5")}>
                {busy !== undefined && busy === dir ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                登録する
              </button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          {notice && <p className="break-all text-sm text-emerald-400">{notice}</p>}
        </>
      )}
    </section>
  );
}

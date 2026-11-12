// Starts a new session on a working server: `claude --remote-control` in its own zellij session.
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { go } from "@/lib/route";
import { sendCommand, useAppState } from "@/lib/store";

const OTHER = "\u0000other";

export function LaunchPanel({ onClose }: { onClose: () => void }) {
  const { machines } = useAppState();
  const candidates = useMemo(() => machines.filter((m) => m.connected && m.canLaunch), [machines]);
  const [machineId, setMachineId] = useState(candidates[0]?.id ?? "");
  const machine = candidates.find((m) => m.id === machineId) ?? candidates[0];
  const folders = machine?.folders ?? [];
  const [folder, setFolder] = useState(folders[0] ?? OTHER);
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const cwd = folder === OTHER ? custom.trim() : folder;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!machine || !cwd) return;
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "session.launch", cwd, name: name.trim() || undefined }, 60_000);
    setBusy(false);
    if (!r.ok || !r.sessionId) {
      setError(r.error ?? "起動できませんでした。");
      return;
    }
    onClose();
    go({ name: "session", machine: machine.id, sessionId: r.sessionId });
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-surface/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">新しいセッションを起動する</h2>
          <p className="text-xs text-muted-foreground">
            working server で <code className="font-mono">claude --remote-control</code> を起動します。Gasho から入力でき、公式アプリからも操作できます。
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="閉じる">
          <X className="size-4" />
        </button>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          起動できる working server がありません。接続していて、zellij が入っている working server が必要です。
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">working server</span>
              <select
                value={machine?.id}
                onChange={(e) => {
                  setMachineId(e.target.value);
                  const next = candidates.find((m) => m.id === e.target.value);
                  setFolder(next?.folders?.[0] ?? OTHER);
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
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="例：Bobert の調査" className={field} />
            </label>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">フォルダー</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)} className={field}>
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
              onChange={(e) => setCustom(e.target.value)}
              placeholder="/home/rg/repos/…（絶対パス）"
              className={`${field} font-mono`}
              spellCheck={false}
            />
          )}
          <p className="text-xs text-muted-foreground">
            一覧に出るのは、Claude Code がすでに信頼しているフォルダーです。ほかのフォルダーは、端末で一度 claude を起動して信頼してから使ってください。
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy || !cwd}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="size-4" />
            {busy ? "起動しています…（最大30秒）" : "起動する"}
          </button>
        </>
      )}
    </form>
  );
}

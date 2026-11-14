// The plugins screen (docs/plugins.md, P9), opened from "プラグイン" in the sidebar: the plugins installed on the Gasho
// server, whether each is enabled, where its daemon part runs and how it stands on each working server, and why it
// cannot be used when it cannot. Changes go live at once (hot reload). Adding plugins from GashoPlugins (the catalog)
// comes in a later stage; until then they are installed with the Gasho server's command (npm run hub:plugin).
import { Puzzle, Settings2 } from "lucide-react";
import { useState } from "react";
import type { MachineInfo, PluginDaemonState, PluginInfo, PluginMachines } from "@gasho/protocol";
import { go } from "@/lib/route";
import { sendPluginCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { usePluginRegistry } from "@/plugins/registry";

const STATE: Record<PluginDaemonState, { label: string; className: string }> = {
  running: { label: "動いている", className: "text-emerald-400" },
  stopped: { label: "起動中", className: "text-muted-foreground" },
  off: { label: "動かさない", className: "text-muted-foreground" },
  old: { label: "gasho-daemon が古い", className: "text-amber-400" },
  failed: { label: "失敗", className: "text-red-400" },
  offline: { label: "オフライン", className: "text-muted-foreground" },
};

const PERMISSION_NAMES: Record<string, string> = { "session.input": "セッションに発言を送る" };
const BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover disabled:opacity-50";

export function PluginsView() {
  const { infos, errors, loading } = usePluginRegistry();
  const { machines } = useAppState();
  const sorted = [...infos].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "ja"));
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">プラグイン</h1>
        <p className="text-sm text-muted-foreground">Gasho サーバーに入っているプラグインです。有効にすると、すぐに画面と working server で動き始めます。</p>
      </div>

      <section aria-labelledby="installed" className="space-y-3">
        <h2 id="installed" className="text-sm font-medium">
          入れたもの
        </h2>
        {sorted.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted-foreground">まだプラグインは入っていません。</p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((info) => (
              <PluginCard key={info.id} info={info} machines={machines} loadError={errors[info.id]} loading={Boolean(loading[info.id])} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5 rounded-2xl border border-dashed border-border p-4 text-xs text-muted-foreground">
        <p>
          GashoPlugins（4rtoflow/GashoPlugins）から選んで追加する機能は、次の段階で作ります。いまは、Gasho サーバーで次のコマンドを実行して入れます。
        </p>
        <pre className="overflow-x-auto rounded-lg bg-surface/60 px-3 py-2 font-mono text-[11px] text-foreground/90">
          npm run hub:plugin -- add &lt;プラグインの dist フォルダー&gt;{"\n"}npm run hub:plugin -- add --link &lt;dist フォルダー&gt;   # 作っているあいだ（ホットリロード）
        </pre>
      </section>
    </div>
  );
}

function PluginCard({ info, machines, loadError, loading }: { info: PluginInfo; machines: MachineInfo[]; loadError?: string; loading: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const m = info.manifest;
  const hasSettings = Object.keys(m.settings ?? {}).length > 0;
  const run = async (cmd: Parameters<typeof sendPluginCommand>[0]) => {
    setBusy(true);
    setError(undefined);
    const r = await sendPluginCommand(cmd);
    setBusy(false);
    if (!r.ok) setError(r.error ?? "変えられませんでした。");
  };
  const problem = info.error ?? (info.enabled ? loadError : undefined);
  return (
    <li className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <Puzzle className="size-4 text-muted-foreground" />
            {m.name}
            {m.version && <span className="text-xs font-normal text-muted-foreground tabular-nums">{m.version}</span>}
            {info.dev && <span className="rounded-full border border-sky-500/40 px-1.5 py-px text-[11px] font-normal text-sky-300">開発中</span>}
            {!info.enabled && <span className="rounded-full border border-border px-1.5 py-px text-[11px] font-normal text-muted-foreground">無効</span>}
            {info.enabled && loading && <span className="text-[11px] font-normal text-muted-foreground">読み込み中…</span>}
          </p>
          {m.description && <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{info.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasSettings && info.enabled && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                go({ name: "settings" });
                requestAnimationFrame(() => document.getElementById(`plugin-settings-${info.id}`)?.scrollIntoView({ block: "start" }));
              }}
            >
              <Settings2 className="size-3.5" />
              設定
            </button>
          )}
          <label className={cn(BUTTON, "cursor-pointer")}>
            <input
              type="checkbox"
              checked={info.enabled}
              disabled={busy}
              onChange={(e) => void run({ type: "plugin.enable", plugin: info.id, enabled: e.currentTarget.checked })}
              className="size-3.5 accent-foreground"
            />
            有効
          </label>
        </div>
      </div>

      {problem && <p className="text-xs text-red-400">{problem}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {(m.permissions?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">権限：{m.permissions?.map((p) => PERMISSION_NAMES[p] ?? p).join("、")}</p>
      )}
      {m.daemon && <DaemonMachines info={info} machines={machines} busy={busy} onChange={(machinesValue) => void run({ type: "plugin.machines", plugin: info.id, machines: machinesValue })} />}
    </li>
  );
}

/** Where the daemon part runs: on every working server, or on those chosen; and how it stands on each. */
function DaemonMachines({ info, machines, busy, onChange }: { info: PluginInfo; machines: MachineInfo[]; busy: boolean; onChange: (m: PluginMachines) => void }) {
  const all = info.machines === "all";
  const chosen = new Set(all ? machines.map((m) => m.id) : info.machines);
  return (
    <div className="space-y-2 rounded-xl border border-border px-3 py-2.5 text-xs">
      <p className="text-muted-foreground">working server で動く部分を動かす場所</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={`machines-${info.id}`} checked={all} disabled={busy} onChange={() => onChange("all")} className="accent-foreground" />
          すべて（あとから登録したものも）
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name={`machines-${info.id}`}
            checked={!all}
            disabled={busy}
            onChange={() => onChange(machines.map((m) => m.id))}
            className="accent-foreground"
          />
          選んだものだけ
        </label>
      </div>
      <ul className="space-y-1">
        {machines.map((m) => {
          const d = info.daemon?.[m.id];
          const s = d ? STATE[d.state] : undefined;
          return (
            <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={chosen.has(m.id)}
                  disabled={busy || all}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.currentTarget.checked) next.add(m.id);
                    else next.delete(m.id);
                    onChange([...next]);
                  }}
                  className="size-3.5 accent-foreground"
                />
                {m.name}
              </label>
              {s && <span className={s.className}>{s.label}</span>}
              {d?.error && <span className="text-red-400">{d.error}</span>}
            </li>
          );
        })}
        {machines.length === 0 && <li className="text-muted-foreground">working server はまだ登録されていません。</li>}
      </ul>
    </div>
  );
}

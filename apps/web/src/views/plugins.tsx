// The plugins screen (docs/plugins.md, P9), opened from "プラグイン" in the sidebar: the plugins installed on the Gasho
// server, whether each is enabled, where its daemon part runs and how it stands on each working server, and why it
// cannot be used when it cannot; and the plugins of GashoPlugins (its catalog, P10), to add, update and remove. Every
// change goes live at once (hot reload). Plugins being developed are linked with the Gasho server's command instead
// (npm run hub:plugin -- add --link), and are never updated from the catalog.
import { ArrowUpCircle, LoaderCircle, Plus, Puzzle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { AlertDialog, Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { CatalogPlugin, MachineInfo, PluginCatalog, PluginDaemonState, PluginInfo, PluginMachines } from "@gasho/protocol";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { relativeTime } from "@/lib/format";
import { updatesOf } from "@/lib/plugin-catalog";
import { go } from "@/lib/route";
import { requestCatalog, sendPluginCommand, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { apiSupported, usePluginRegistry } from "@/plugins/registry";

const STATE: Record<PluginDaemonState, { label: string; className: string }> = {
  running: { label: "動いている", className: "text-emerald-400" },
  stopped: { label: "起動中", className: "text-muted-foreground" },
  off: { label: "動かさない", className: "text-muted-foreground" },
  old: { label: "gasho-daemon が古い", className: "text-amber-400" },
  failed: { label: "失敗", className: "text-red-400" },
  offline: { label: "オフライン", className: "text-muted-foreground" },
};

const PERMISSION_NAMES: Record<string, string> = { "session.input": "セッションに発言を送る", "session.launch": "セッションを起動する" };
const BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover disabled:opacity-50";
/** Adding or updating fetches the plugin's file first (the Gasho server gives up after 2 minutes). */
const INSTALL_WAIT_MS = 150_000;

const permissionsText = (permissions: readonly string[] | undefined) =>
  permissions && permissions.length > 0 ? `権限：${permissions.map((p) => PERMISSION_NAMES[p] ?? p).join("、")}` : undefined;

const needsApi = (api: string) => `この Gasho では使えません（プラグインの API ${api} が要ります）。`;

export function PluginsView() {
  const { infos, errors, loading } = usePluginRegistry();
  const { machines, catalog, connected } = useAppState();
  const [adding, setAdding] = useState<CatalogPlugin>();
  const [removing, setRemoving] = useState<PluginInfo>();
  // Opening the screen (or connecting while it is open) reads the catalog again when it is older than 10 minutes.
  useEffect(() => {
    if (connected) requestCatalog();
  }, [connected]);
  const sorted = [...infos].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "ja"));
  const updates = updatesOf(infos, catalog);
  const installed = new Set(infos.map((i) => i.id));
  const available = (catalog?.plugins ?? []).filter((p) => !installed.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">プラグイン</h1>
          <CatalogStatus catalog={catalog} />
        </div>
        {catalog && (
          <button type="button" className={BUTTON} disabled={catalog.loading} onClick={() => requestCatalog(true)}>
            <RefreshCw className={cn("size-3.5", catalog.loading && "animate-spin")} />
            再読み込み
          </button>
        )}
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
              <PluginCard
                key={info.id}
                info={info}
                machines={machines}
                loadError={errors[info.id]}
                loading={Boolean(loading[info.id])}
                update={updates.get(info.id)}
                onRemove={() => setRemoving(info)}
              />
            ))}
          </ul>
        )}
      </section>

      {catalog && (
        <section aria-labelledby="catalog" className="space-y-3">
          <h2 id="catalog" className="text-sm font-medium">
            GashoPlugins にあるもの
          </h2>
          {available.length === 0 ? (
            <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted-foreground">
              {catalog.checkedAt ? "ほかに入れられるプラグインはありません。" : catalog.loading ? "一覧を読んでいます…" : "一覧をまだ読めていません。"}
            </p>
          ) : (
            <ul className="space-y-3">
              {available.map((p) => (
                <CatalogCard key={p.id} plugin={p} onAdd={() => setAdding(p)} />
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        作っているプラグインは、Gasho サーバーで <code className="font-mono text-[0.92em]">npm run hub:plugin -- add --link &lt;dist フォルダー&gt;</code>{" "}
        を実行して入れます。ビルドするたびに、画面と gasho-daemon が新しい版に入れ替わります。
      </p>

      {adding && <AddDialog plugin={adding} machines={machines} onClose={() => setAdding(undefined)} />}
      {removing && <RemoveDialog info={removing} onClose={() => setRemoving(undefined)} />}
    </div>
  );
}

/** Which repository the catalog is read from, when it was last read, and why it could not be read. */
function CatalogStatus({ catalog }: { catalog: PluginCatalog | undefined }) {
  const now = useNow();
  if (!catalog) return <p className="text-sm text-muted-foreground">Gasho サーバーに入っているプラグインです。</p>;
  const rel = catalog.checkedAt ? relativeTime(catalog.checkedAt, now) : undefined;
  const when = rel === "たった今" ? rel : `${rel}に`;
  // After a failure, the list shown is the one read before (if any).
  const note = catalog.loading ? "（読んでいます…）" : !rel ? "" : catalog.error ? `（${when}読んだもの）` : `（${when}確認）`;
  return (
    <div className="space-y-0.5">
      <p className="text-sm text-muted-foreground">
        {catalog.repo} の一覧{note}
      </p>
      {catalog.error && <p className="text-xs text-red-400">一覧を読めませんでした：{catalog.error}</p>}
    </div>
  );
}

function PluginCard({
  info,
  machines,
  loadError,
  loading,
  update,
  onRemove,
}: {
  info: PluginInfo;
  machines: MachineInfo[];
  loadError?: string;
  loading: boolean;
  /** The catalog's newer version of it. */
  update?: CatalogPlugin;
  onRemove: () => void;
}) {
  const [busy, setBusy] = useState<"change" | "update">();
  const [error, setError] = useState<string>();
  const m = info.manifest;
  const hasSettings = Object.keys(m.settings ?? {}).length > 0;
  const run = async (cmd: Parameters<typeof sendPluginCommand>[0], what: "change" | "update" = "change") => {
    setBusy(what);
    setError(undefined);
    const r = await sendPluginCommand(cmd, what === "update" ? INSTALL_WAIT_MS : undefined);
    setBusy(undefined);
    if (!r.ok) setError(r.error ?? (what === "update" ? "更新できませんでした。" : "変えられませんでした。"));
  };
  const problem = info.error ?? (info.enabled ? loadError : undefined);
  const canUpdate = update && apiSupported(update.api);
  return (
    <li className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <Puzzle className="size-4 text-muted-foreground" />
            {m.name}
            {m.version && <span className="text-xs font-normal text-muted-foreground tabular-nums">{m.version}</span>}
            {update && (
              <span className={cn("text-xs font-normal", canUpdate ? "text-sky-300" : "text-muted-foreground")}>
                {canUpdate ? `（${update.version} に更新できる）` : `（${update.version} は API ${update.api} が要る）`}
              </span>
            )}
            {info.dev && <span className="rounded-full border border-sky-500/40 px-1.5 py-px text-[11px] font-normal text-sky-300">開発中</span>}
            {!info.enabled && <span className="rounded-full border border-border px-1.5 py-px text-[11px] font-normal text-muted-foreground">無効</span>}
            {info.enabled && loading && <span className="text-[11px] font-normal text-muted-foreground">読み込み中…</span>}
          </p>
          {m.description && <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{info.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canUpdate && (
            <button type="button" className={BUTTON} disabled={Boolean(busy)} onClick={() => void run({ type: "plugin.update", plugin: info.id }, "update")}>
              {busy === "update" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
              {busy === "update" ? "更新しています…" : "更新"}
            </button>
          )}
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
              disabled={Boolean(busy)}
              onChange={(e) => void run({ type: "plugin.enable", plugin: info.id, enabled: e.currentTarget.checked })}
              className="size-3.5 accent-foreground"
            />
            有効
          </label>
          <button type="button" className={BUTTON} disabled={Boolean(busy)} onClick={onRemove} title={`${m.name} を外す`}>
            <Trash2 className="size-3.5" />
            外す
          </button>
        </div>
      </div>

      {problem && <p className="text-xs text-red-400">{problem}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {permissionsText(m.permissions) && <p className="text-xs text-muted-foreground">{permissionsText(m.permissions)}</p>}
      {m.daemon && (
        <DaemonMachines info={info} machines={machines} busy={Boolean(busy)} onChange={(machinesValue) => void run({ type: "plugin.machines", plugin: info.id, machines: machinesValue })} />
      )}
    </li>
  );
}

/** A plugin of the catalog that is not installed: added after the questions of AddDialog. */
function CatalogCard({ plugin, onAdd }: { plugin: CatalogPlugin; onAdd: () => void }) {
  const problem = apiSupported(plugin.api) ? undefined : needsApi(plugin.api);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <Puzzle className="size-4 text-muted-foreground" />
          {plugin.name}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{plugin.version}</span>
        </p>
        {plugin.description && <p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>}
        {permissionsText(plugin.permissions) && <p className="mt-1 text-xs text-muted-foreground">{permissionsText(plugin.permissions)}</p>}
        {problem && <p className="mt-1 text-xs text-amber-400">{problem}</p>}
      </div>
      <button type="button" className={BUTTON} disabled={Boolean(problem)} onClick={onAdd}>
        <Plus className="size-3.5" />
        追加
      </button>
    </li>
  );
}

/** Adding a plugin of the catalog: what it may do, and where its daemon part is to run. */
function AddDialog({ plugin, machines, onClose }: { plugin: CatalogPlugin; machines: MachineInfo[]; onClose: () => void }) {
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(machines.map((m) => m.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendPluginCommand({ type: "plugin.install", plugin: plugin.id, machines: all ? "all" : [...chosen] }, INSTALL_WAIT_MS);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "追加できませんでした。");
      return;
    }
    onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content className={DIALOG_PANEL}>
          <Dialog.Title className="text-base font-semibold tracking-tight">{plugin.name} を追加</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>
                <span className="tabular-nums">{plugin.version}</span>
                {plugin.description ? `　${plugin.description}` : ""}
              </p>
              {permissionsText(plugin.permissions) && <p>{permissionsText(plugin.permissions)}</p>}
              <p>追加すると、すぐに有効になります。プラグインは、Gasho の画面と同じ権限で動きます。</p>
            </div>
          </Dialog.Description>
          {plugin.daemon && (
            <fieldset className="mt-4 space-y-2 rounded-xl border border-border px-3 py-2.5 text-sm">
              <legend className="px-1 text-xs text-muted-foreground">working server で動く部分を動かす場所</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="add-machines" checked={all} disabled={busy} onChange={() => setAll(true)} className="accent-foreground" />
                すべて（あとから登録したものも）
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="add-machines" checked={!all} disabled={busy} onChange={() => setAll(false)} className="accent-foreground" />
                選んだものだけ
              </label>
              {!all && (
                <ul className="space-y-1 pl-6">
                  {machines.map((m) => (
                    <li key={m.id}>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={chosen.has(m.id)}
                          disabled={busy}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.currentTarget.checked) next.add(m.id);
                            else next.delete(m.id);
                            setChosen(next);
                          }}
                          className="size-3.5 accent-foreground"
                        />
                        {m.name}
                      </label>
                    </li>
                  ))}
                  {machines.length === 0 && <li className="text-xs text-muted-foreground">working server はまだ登録されていません。</li>}
                </ul>
              )}
            </fieldset>
          )}
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                やめる
              </button>
            </Dialog.Close>
            <button type="button" onClick={() => void add()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "追加しています…" : "追加して有効にする"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Removing a plugin: its files and the settings the Gasho server keeps; only the link for one being developed. */
function RemoveDialog({ info, onClose }: { info: PluginInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = info.manifest.name;
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendPluginCommand({ type: "plugin.remove", plugin: info.id });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "外せませんでした。");
      return;
    }
    onClose();
  };
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={DIALOG_OVERLAY} />
        <AlertDialog.Content className={DIALOG_PANEL}>
          <AlertDialog.Title className="text-base font-semibold tracking-tight">{name} を外しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {info.dev ? (
                <p>Gasho サーバーに置いたリンクだけを消します。作っているプラグインのフォルダーは、そのまま残ります。</p>
              ) : (
                <>
                  <p>プラグインのファイルと、Gasho サーバーに保存したこのプラグインの設定を消します。開いている画面と gasho-daemon からも、すぐに外れます。</p>
                  <p>ブラウザーに覚えた設定は、それぞれのブラウザーに残ります。</p>
                </>
              )}
            </div>
          </AlertDialog.Description>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void remove()} disabled={busy} className={BUTTON_DANGER}>
              {busy ? "外しています…" : "外す"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
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

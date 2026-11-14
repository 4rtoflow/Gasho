// Where the plugins' parts go on Gasho's screen (docs/plugins.md): sidebar items and their badges (P1), pages (P2),
// session header items (P3), session panels (P4), settings (P5), home tiles (P6), the end of a session's
// conversation (P13), the line under its chat box (P14) and a worktree's tabs and their screens (P15). Every part is
// drawn in the scope of its plugin (the SDK's hooks find it there) and inside an error boundary of its own, so that a
// plugin that throws shows an error in its place while the rest of Gasho goes on.
import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  ComposerFooterItem,
  ConversationEndItem,
  OpenPanel,
  Params,
  PluginDefinition,
  SessionContext,
  SessionHeaderItem,
  TileSize,
  WorktreeContext,
  WorktreeInfo,
  WorktreeTab,
  WorktreeTabItem,
} from "@gasho/plugin-sdk";
import type { MachineInfo, PluginInfo, PluginSettingSpec, SessionInfo } from "@gasho/protocol";
import { SidePanel } from "@/components/side-panel";
import { go, hrefOf, type Route, type SessionPanel, type WorktreeView } from "@/lib/route";
import type { WorktreeSessions } from "@/lib/sessions";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { reportPluginError, usePluginRegistry, type PluginPart } from "./registry";
import { PanelScopeContext, PluginScopeContext, readiness, SessionScopeContext, usePluginInfo, useSetting } from "./sdk";

// ---- scope and error boundary ----

export function PluginScope({ id, children }: { id: string; children: ReactNode }) {
  return <PluginScopeContext.Provider value={id}>{children}</PluginScopeContext.Provider>;
}

interface BoundaryProps {
  plugin: string;
  name: string;
  /** What to show instead of the part when it throws; by default a short notice with "もう一度". */
  fallback?: ReactNode;
  children: ReactNode;
}

export class PluginBoundary extends Component<BoundaryProps, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`gasho: plugin ${this.props.plugin} threw`, error);
    reportPluginError(this.props.plugin, `表示でエラーが起きました：${error.message}`);
  }

  componentDidUpdate(prev: BoundaryProps) {
    // A new version of the plugin (hot reload) gets another chance.
    if (prev.children !== this.props.children && this.state.error && prev.name !== this.props.name) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
        {this.props.name} の表示でエラーが起きました。
        <button type="button" onClick={() => this.setState({ error: undefined })} className="ml-2 underline underline-offset-2 hover:text-red-200">
          もう一度
        </button>
      </div>
    );
  }
}

/**
 * A part of a plugin, in its scope and boundary. `hash` makes a new version start afresh. What the plugin draws sits
 * in an element of its own, the only place its web.css applies to (registry.ts); `bare` leaves that out where Gasho
 * draws the part itself (header items) or nothing is drawn (badges).
 */
function Part({ part, fallback, bare, children }: { part: PluginPart; fallback?: ReactNode; bare?: boolean; children: ReactNode }) {
  return (
    <PluginScope id={part.info.id}>
      <PluginBoundary key={part.info.hash} plugin={part.info.id} name={part.info.manifest.name} fallback={fallback}>
        {bare ? (
          children
        ) : (
          <div data-gasho-plugin={part.info.id} className="contents">
            {children}
          </div>
        )}
      </PluginBoundary>
    </PluginScope>
  );
}

// ---- pages (P2) ----

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl p-6 text-sm text-muted-foreground">
      <h1 className="mb-2 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      {children}
    </div>
  );
}

const toPlugins = (
  <a href={hrefOf({ name: "plugins" })} className="underline underline-offset-2 hover:text-foreground">
    プラグインの画面
  </a>
);

/** Why a plugin's part cannot be drawn (undefined when it can). */
function unavailable(info: PluginInfo | undefined, part: PluginPart | undefined, errors: Record<string, string>, loading: Record<string, boolean>): string | undefined {
  if (!info) return "このプラグインは、Gasho サーバーに入っていません。";
  if (!info.enabled) return `${info.manifest.name} は無効になっています。`;
  if (part) return undefined;
  if (errors[info.id]) return errors[info.id];
  if (info.error && !info.hash) return info.error;
  return loading[info.id] || info.hash ? "読み込み中…" : "読み込めません。";
}

export function PluginPageView({ plugin, page, params }: { plugin: string; page: string; params: Params }) {
  const { infos, parts, errors, loading } = usePluginRegistry();
  const info = infos.find((p) => p.id === plugin);
  const part = parts.find((p) => p.info.id === plugin);
  const why = unavailable(info, part, errors, loading);
  if (why || !part) {
    return (
      <Notice title={info?.manifest.name ?? plugin}>
        <p>{why}</p>
        <p className="mt-2">{toPlugins}で、入っているプラグインと、その状態を見られます。</p>
      </Notice>
    );
  }
  const Page = Object.hasOwn(part.def.pages ?? {}, page) ? part.def.pages?.[page] : undefined;
  if (!Page) return <Notice title={part.info.manifest.name}>このページはありません。</Notice>;
  return (
    <Part part={part}>
      <Page params={params} />
    </Part>
  );
}

// ---- session panels (P4) ----

export function PluginPanelView({ machine, sessionId, panel, docked, onClose }: { machine: string; sessionId: string; panel: SessionPanel; docked: boolean; onClose: () => void }) {
  const { infos, parts, errors, loading } = usePluginRegistry();
  const { machines } = useAppState();
  const plugin = panel.plugin ?? "";
  const info = infos.find((p) => p.id === plugin);
  const part = parts.find((p) => p.info.id === plugin);
  const m = machines.find((x) => x.id === machine);
  const s = m?.sessions.find((x) => x.sessionId === sessionId);
  const why = unavailable(info, part, errors, loading);
  const Panel = part && Object.hasOwn(part.def.sessionPanels ?? {}, panel.id ?? "") ? part.def.sessionPanels?.[panel.id ?? ""] : undefined;
  const problem = why ?? (!m || !s ? `このセッションは見つかりません。終了したか、${m?.name ?? "この working server"} の gasho-daemon が接続していません。` : !Panel ? "このパネルはありません。" : undefined);
  if (problem || !part || !m || !s || !Panel) {
    return (
      <SidePanel title={info?.manifest.name ?? plugin} docked={docked} onClose={onClose}>
        <p className="text-sm text-muted-foreground">{problem}</p>
      </SidePanel>
    );
  }
  const ctx: SessionContext = { machine: m, session: s, daemon: readiness(part.info, m.id) };
  return (
    <PanelScopeContext.Provider value={{ docked, onClose }}>
      <SessionScopeContext.Provider value={ctx}>
        <Part
          part={part}
          fallback={
            <SidePanel title={part.info.manifest.name} docked={docked} onClose={onClose}>
              <p className="text-sm text-red-400">{part.info.manifest.name} の表示でエラーが起きました。プラグインの画面で理由を見られます。</p>
            </SidePanel>
          }
        >
          <Panel machine={m} session={s} params={panel.params ?? {}} docked={docked} />
        </Part>
      </SessionScopeContext.Provider>
    </PanelScopeContext.Provider>
  );
}

// ---- session header items (P3) ----

const DEFAULT_ORDER = 500;

/**
 * The plugins' items of an extension point whose `order` is in [from, to): by their order, then in the plugins' order,
 * then as each plugin wrote them.
 */
function ordered<T extends { order?: number }>(parts: PluginPart[], pick: (def: PluginDefinition) => T[] | undefined, from = -Infinity, to = Infinity) {
  return parts
    .flatMap((part, p) => (pick(part.def) ?? []).map((item, i) => ({ part, item, rank: [item.order ?? DEFAULT_ORDER, p, i] as const })))
    .filter(({ rank }) => rank[0] >= from && rank[0] < to)
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
}

/** The header items of the plugins whose `order` is in [from, to), for a place in the header's row. */
export function PluginHeaderItems({
  machine,
  session,
  panel,
  from,
  to,
}: {
  machine: MachineInfo;
  session: SessionInfo;
  panel: SessionPanel | undefined;
  from: number;
  to: number;
}) {
  const { parts } = usePluginRegistry();
  const items = ordered(parts, (def) => def.sessionHeader, from, to);
  return (
    <>
      {items.map(({ part, item }) => (
        <Part key={`${part.info.id}.${item.id}`} part={part} fallback={null} bare>
          <HeaderItem part={part} item={item} machine={machine} session={session} panel={panel} />
        </Part>
      ))}
    </>
  );
}

function HeaderItem({ part, item, machine, session, panel }: { part: PluginPart; item: SessionHeaderItem; machine: MachineInfo; session: SessionInfo; panel: SessionPanel | undefined }) {
  const ctx: SessionContext = { machine, session, daemon: readiness(part.info, machine.id) };
  if (item.when && !item.when(ctx)) return null;
  return (
    <SessionScopeContext.Provider value={ctx}>
      <HeaderButton part={part} item={item} ctx={ctx} panel={panel} />
    </SessionScopeContext.Provider>
  );
}

function HeaderButton({ part, item, ctx, panel }: { part: PluginPart; item: SessionHeaderItem; ctx: SessionContext; panel: SessionPanel | undefined }) {
  const badge = item.useBadge?.(ctx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const open: OpenPanel | undefined =
    panel?.kind === "plugin" && panel.plugin === part.info.id ? { plugin: part.info.id, id: panel.id ?? "", params: panel.params ?? {} } : undefined;
  const pressed =
    Boolean(item.panel && open) &&
    (item.isOpen && open
      ? item.isOpen(open)
      : open?.id === item.panel?.id && Object.entries(item.panel?.params ?? {}).every(([k, v]) => open?.params[k] === v));
  const Icon = item.icon;
  const onClick = async () => {
    setError(undefined);
    const where = { machine: ctx.machine.id, sessionId: ctx.session.sessionId };
    if (item.panel) {
      // A panel already open is swapped, not stacked in the history (as Gasho's own panels).
      go({ name: "session", ...where, panel: { kind: "plugin", plugin: part.info.id, id: item.panel.id, params: item.panel.params ?? {} } }, { replace: panel !== undefined });
    } else if (item.page) {
      go({ name: "plugin", plugin: part.info.id, page: item.page.id, params: item.page.params ?? {} });
    } else if (item.href) {
      const url = item.href(ctx);
      if (url?.startsWith("https://")) window.open(url, "_blank", "noopener,noreferrer");
    } else if (item.onClick) {
      setBusy(true);
      try {
        await item.onClick(ctx);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        title={item.title}
        aria-pressed={item.panel ? pressed : undefined}
        className={cn("inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50", pressed && "text-foreground")}
      >
        {Icon && <Icon className="size-3.5" />}
        {item.label}
        {badge !== undefined && <span className="rounded bg-surface-raised px-1 text-[10px] tabular-nums">{badge}</span>}
      </button>
      {error && <span className="text-red-400">{error}</span>}
    </>
  );
}

// ---- the end of a session's conversation (P13) ----

/** The plugins' parts at the end of a session's conversation, below its newest entry. */
export function PluginConversationEnd({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  const { parts } = usePluginRegistry();
  return (
    <>
      {ordered(parts, (def) => def.conversationEnd).map(({ part, item }) => (
        // A `when` that throws leaves the part out, as a header item's does.
        <Part key={`${part.info.id}.${item.id}`} part={part} fallback={null}>
          <ConversationEndPart part={part} item={item} machine={machine} session={session} />
        </Part>
      ))}
    </>
  );
}

function ConversationEndPart({ part, item, machine, session }: { part: PluginPart; item: ConversationEndItem; machine: MachineInfo; session: SessionInfo }) {
  const ctx: SessionContext = { machine, session, daemon: readiness(part.info, machine.id) };
  if (item.when && !item.when(ctx)) return null;
  const Shown = item.component;
  return (
    <SessionScopeContext.Provider value={ctx}>
      <Part part={part}>
        <Shown machine={machine} session={session} />
      </Part>
    </SessionScopeContext.Provider>
  );
}

// ---- the line under a session's chat box (P14) ----

/** The plugins' parts in the line under a session's chat box, left of the character count. */
export function PluginComposerFooter({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  const { parts } = usePluginRegistry();
  return (
    <>
      {ordered(parts, (def) => def.composerFooter).map(({ part, item }) => (
        // A `when` that throws leaves the part out, as a header item's does.
        <Part key={`${part.info.id}.${item.id}`} part={part} fallback={null}>
          <ComposerFooterPart part={part} item={item} machine={machine} session={session} />
        </Part>
      ))}
    </>
  );
}

function ComposerFooterPart({ part, item, machine, session }: { part: PluginPart; item: ComposerFooterItem; machine: MachineInfo; session: SessionInfo }) {
  const ctx: SessionContext = { machine, session, daemon: readiness(part.info, machine.id) };
  if (item.when && !item.when(ctx)) return null;
  const Shown = item.component;
  return (
    <SessionScopeContext.Provider value={ctx}>
      {/* What throws is left out: the line is too small for the notice with "もう一度". */}
      <Part part={part} fallback={null}>
        <Shown machine={machine} session={session} />
      </Part>
    </SessionScopeContext.Provider>
  );
}

// ---- a worktree's tabs and their screens (P15) ----

/** What a plugin gets of a worktree. */
function worktreeInfo(w: WorktreeSessions): WorktreeInfo {
  return {
    path: w.path,
    ...(w.branch ? { branch: w.branch } : {}),
    ...(w.repoFolder ? { repo: w.repoFolder } : {}),
    ...(w.github ? { github: w.github } : {}),
    sessions: w.sessions,
  };
}

/** The plugins' tabs of a worktree, after its sessions' tabs. `open`: the plugin's screen open below, if any. */
export function PluginWorktreeTabs({ worktree, open }: { worktree: WorktreeSessions; open?: WorktreeView }) {
  const { parts } = usePluginRegistry();
  const items = ordered(parts, (def) => def.worktreeTabs);
  return (
    // Without any tab (none of the hooks gave one), nothing shows, the line before them neither.
    <div className="flex shrink-0 gap-1 empty:hidden before:my-2 before:mr-1 before:w-px before:bg-border">
      {items.map(({ part, item }) => (
        // A hook that throws leaves its tabs out, as a header item's `when` does.
        <Part key={`${part.info.id}.${item.id}`} part={part} fallback={null} bare>
          <WorktreeTabs part={part} item={item} worktree={worktree} open={open} />
        </Part>
      ))}
    </div>
  );
}

function WorktreeTabs({ part, item, worktree, open }: { part: PluginPart; item: WorktreeTabItem; worktree: WorktreeSessions; open?: WorktreeView }) {
  const ctx: WorktreeContext = { machine: worktree.machine, worktree: worktreeInfo(worktree), daemon: readiness(part.info, worktree.machine.id) };
  const tabs = item.useTabs(ctx) ?? [];
  return (
    <>
      {tabs.map((tab, i) => (
        <WorktreeTabButton key={i} plugin={part.info.id} tab={tab} worktree={worktree} open={open} />
      ))}
    </>
  );
}

function WorktreeTabButton({ plugin, tab, worktree, open }: { plugin: string; tab: WorktreeTab; worktree: WorktreeSessions; open?: WorktreeView }) {
  const params = tab.params ?? {};
  // As a header item's panel: the same screen, with every param the tab has.
  const pressed = open?.plugin === plugin && open.id === tab.view && Object.entries(params).every(([k, v]) => open.params[k] === v);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pressed) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pressed]);
  const to: Route = { name: "worktree", machine: worktree.machine.id, path: worktree.path, view: { plugin, id: tab.view, params } };
  const Icon = tab.icon;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        if (location.hash !== hrefOf(to)) go(to);
      }}
      aria-current={pressed ? "page" : undefined}
      title={tab.title ?? tab.label}
      className={cn(
        "relative flex h-9 max-w-56 shrink-0 items-center gap-1.5 px-2.5 text-xs transition-colors",
        "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
        pressed ? "text-foreground after:bg-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" />}
      <span className="truncate">{tab.label}</span>
      {tab.badge !== undefined && <span className="rounded bg-surface-raised px-1 text-[10px] tabular-nums">{tab.badge}</span>}
    </button>
  );
}

/** The plugin's screen a worktree's tab opened, below the tabs. */
export function PluginWorktreeView({ worktree, view }: { worktree: WorktreeSessions; view: WorktreeView }) {
  const { infos, parts, errors, loading } = usePluginRegistry();
  const info = infos.find((p) => p.id === view.plugin);
  const part = parts.find((p) => p.info.id === view.plugin);
  const why = unavailable(info, part, errors, loading);
  const View = part && Object.hasOwn(part.def.worktreeViews ?? {}, view.id) ? part.def.worktreeViews?.[view.id] : undefined;
  if (why || !part || !View) {
    return (
      <Notice title={info?.manifest.name ?? view.plugin}>
        <p>{why ?? "この画面はありません。"}</p>
        {why && <p className="mt-2">{toPlugins}で、入っているプラグインと、その状態を見られます。</p>}
      </Notice>
    );
  }
  return (
    <Part part={part}>
      <View machine={worktree.machine} worktree={worktreeInfo(worktree)} params={view.params} />
    </Part>
  );
}

// ---- home tiles (P6) ----

const TILE_CLASSES: Record<TileSize, string> = {
  stat: "",
  small: "col-span-2 lg:col-span-1",
  medium: "col-span-2",
  large: "col-span-2 lg:col-span-3",
};

export interface PluginTile {
  /** `<plugin>.<tile>` */
  id: string;
  name: string;
  after?: string;
  className: string;
  content: ReactNode;
}

/** The plugins' home tiles, for the bento grid of the home screen. */
export function usePluginTiles(): PluginTile[] {
  const { parts } = usePluginRegistry();
  return parts.flatMap((part) =>
    (part.def.homeTiles ?? []).map((t) => {
      const Tile = t.component;
      return {
        id: `${part.info.id}.${t.id}`,
        name: t.title,
        ...(t.after ? { after: t.after } : {}),
        className: cn(TILE_CLASSES[t.size ?? "small"] ?? TILE_CLASSES.small, t.tall && "lg:row-span-2"),
        content: (
          <Part part={part}>
            <Tile />
          </Part>
        ),
      };
    }),
  );
}

// ---- sidebar badges (P1) ----

const badges = new Map<string, string | number | undefined>();
const badgeListeners = new Set<() => void>();
let badgeSnapshot = new Map(badges);

function setBadge(id: string, value: string | number | undefined): void {
  if (badges.get(id) === value) return;
  badges.set(id, value);
  badgeSnapshot = new Map(badges);
  for (const l of badgeListeners) l();
}

/** The badges of the plugins' sidebar items, by `plugin:<plugin>:<item>`. */
export function usePluginBadges(): Map<string, string | number | undefined> {
  return useSyncExternalStore(
    (l) => {
      badgeListeners.add(l);
      return () => badgeListeners.delete(l);
    },
    () => badgeSnapshot,
  );
}

function BadgeProbe({ id, use }: { id: string; use: () => string | number | undefined }) {
  const value = use();
  useEffect(() => setBadge(id, value), [id, value]);
  useEffect(() => () => setBadge(id, undefined), [id]);
  return null;
}

/** Runs the plugins' sidebar badge hooks out of sight; the sidebar reads the values (usePluginBadges). */
export function PluginBadgeProbes() {
  const { parts } = usePluginRegistry();
  return (
    <>
      {parts.flatMap((part) =>
        (part.def.sidebar ?? []).flatMap((item) => {
          const use = item.useBadge;
          if (!use) return [];
          const id = `plugin:${part.info.id}:${item.id}`;
          return [
            <Part key={id} part={part} fallback={null} bare>
              <BadgeProbe id={id} use={use} />
            </Part>,
          ];
        }),
      )}
    </>
  );
}

// ---- settings (P5) ----

/** The settings of the enabled plugins, one section each, for the settings screen. */
export function PluginSettingsSections() {
  const { infos, parts } = usePluginRegistry();
  const shown = infos
    .filter((info) => info.enabled && (Object.keys(info.manifest.settings ?? {}).length > 0 || parts.find((p) => p.info.id === info.id)?.def.settings))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "ja"));
  return (
    <>
      {shown.map((info) => {
        const part = parts.find((p) => p.info.id === info.id);
        const Custom = part?.def.settings;
        return (
          <section
            key={info.id}
            id={`plugin-settings-${info.id}`}
            aria-labelledby={`plugin-settings-title-${info.id}`}
            className="space-y-4 rounded-2xl border border-border bg-surface/40 p-4"
          >
            <div>
              <h2 id={`plugin-settings-title-${info.id}`} className="text-sm font-medium">
                {info.manifest.name}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">プラグインの設定です。</p>
            </div>
            <PluginScope id={info.id}>
              {Object.entries(info.manifest.settings ?? {}).map(([key, spec]) => (
                <SettingRow key={key} settingKey={key} spec={spec} />
              ))}
            </PluginScope>
            {part && Custom && (
              <Part part={part}>
                <Custom />
              </Part>
            )}
          </section>
        );
      })}
    </>
  );
}

const FIELD = "rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-border-hover";

function SettingRow({ settingKey, spec }: { settingKey: string; spec: PluginSettingSpec }) {
  const info = usePluginInfo();
  const id = `plugin-setting-${info.id}-${settingKey}`;
  const [error, setError] = useState<string>();
  const [value, setValue] = useSetting<unknown>(settingKey);
  const saved = { value, set: setValue };
  const [draft, setDraft] = useState<string>();
  const commit = async (value: unknown) => {
    setError(undefined);
    try {
      await saved.set(value);
      setDraft(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  let control: ReactNode;
  if (spec.type === "boolean") {
    control = <input id={id} type="checkbox" checked={saved.value === true} onChange={(e) => void commit(e.currentTarget.checked)} className="size-4 accent-foreground" />;
  } else if (spec.type === "select") {
    control = (
      <select id={id} value={String(saved.value ?? "")} onChange={(e) => void commit(e.currentTarget.value)} className={FIELD}>
        {spec.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    const text = draft ?? (saved.value === undefined ? "" : String(saved.value));
    const done = () => {
      if (draft === undefined) return;
      if (spec.type === "number") {
        const n = Number(draft);
        if (draft.trim() === "" || !Number.isFinite(n)) {
          setError("数を入れてください。");
          return;
        }
        void commit(n);
      } else void commit(draft);
    };
    control = (
      <input
        id={id}
        type={spec.type === "number" ? "number" : "text"}
        value={text}
        {...(spec.type === "number" ? { min: spec.min, max: spec.max, step: spec.step } : { maxLength: spec.maxLength })}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === "Enter") done();
        }}
        className={cn(FIELD, spec.type === "number" ? "w-28" : "w-full max-w-sm")}
      />
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {spec.label}
        </label>
        {spec.description && <p className="text-xs text-muted-foreground">{spec.description}</p>}
        <p className="text-[11px] text-muted-foreground">{spec.scope === "browser" ? "このブラウザーだけの設定" : "すべてのブラウザーで共通の設定"}</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      {control}
    </div>
  );
}

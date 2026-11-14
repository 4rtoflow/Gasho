// What Gasho's screen provides to plugins as "@gasho/plugin-sdk" (GashoSdk of packages/plugin-sdk), and the modules it
// shares with them (installShared). A plugin's build turns its imports of these into reads of globalThis.__gasho, so
// that the plugin draws with Gasho's own React, state and parts. The hooks find which plugin calls them through the
// scope Gasho draws each plugin part in (PluginScope in parts.tsx).
import * as React from "react";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import type {
  CallResult,
  DaemonReadiness,
  GashoSdk,
  LaunchResult,
  Navigation,
  Params,
  PluginDefinition,
  RequestOptions,
  RequestTarget,
  SessionActivity,
  SessionContext,
} from "@gasho/plugin-sdk";
import { PLUGIN_API, SDK_EXPORTS } from "@gasho/plugin-sdk/exports";
import type { PluginInfo, PluginSettingSpec, SessionInfo } from "@gasho/protocol";
import { MarkdownText } from "@/components/markdown";
import { PANEL_BUTTON, panelRepo, RepoTabs, SidePanel } from "@/components/side-panel";
import { TILE, TILE_SHADOW } from "@/components/ui/stat-card";
import { sessionActivity } from "@/lib/activity";
import { relativeTime } from "@/lib/format";
import { addPending, removePending, settlePending } from "@/lib/pending";
import { backTo, go, hrefOf, noteOpenedFrom, useRoute, type Route } from "@/lib/route";
import { getAppState, sendCommand, sendPluginCommand, transcriptKey, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { callPlugin, useRequestFor } from "./requests";

/** The plugin a part belongs to (set by PluginScope). */
export const PluginScopeContext = createContext<string | undefined>(undefined);
/** The session of a header item or a panel. */
export const SessionScopeContext = createContext<SessionContext | undefined>(undefined);
/** The panel being drawn: beside the session or in its place, and how it closes. */
export const PanelScopeContext = createContext<{ docked: boolean; onClose: () => void } | undefined>(undefined);

/** The plugin of the part being drawn, as the Gasho server last described it. */
export function usePluginInfo(): PluginInfo {
  const id = useContext(PluginScopeContext);
  const { plugins } = useAppState();
  const info = id ? plugins.find((p) => p.id === id) : undefined;
  if (!id || !info) throw new Error("@gasho/plugin-sdk のフックは、プラグインの部品の中で使ってください。");
  return info;
}

/** Whether a plugin's daemon part runs (or is starting) on a working server, and why not. */
export function readiness(info: PluginInfo, machine: string): DaemonReadiness {
  if (!info.manifest.daemon) return { ready: false, reason: "このプラグインには、working server で動く部分がありません。" };
  const d = info.daemon?.[machine];
  switch (d?.state) {
    case "running":
    case "stopped":
      return { ready: true };
    case "offline":
      return { ready: false, reason: "working server がオフラインです。" };
    case "old":
      return { ready: false, reason: "この working server の gasho-daemon は古いため、プラグインを使えません。" };
    case "off":
      return { ready: false, reason: "この working server では動かしていません。" };
    case "failed":
      return { ready: false, reason: d.error ?? "動かせませんでした。" };
    default:
      return { ready: false, reason: "この working server のことが分かりません。" };
  }
}

// ---- settings and state Gasho keeps for plugins ----

const LOCAL_PREFIX = "gasho.plugin.";
const local = new Map<string, unknown>();
const localListeners = new Set<() => void>();

function readLocal(key: string): unknown {
  if (local.has(key)) return local.get(key);
  let v: unknown;
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key);
    v = raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    v = undefined;
  }
  local.set(key, v);
  return v;
}

function writeLocal(key: string, value: unknown): void {
  local.set(key, value);
  try {
    localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value));
  } catch {
    // kept for this page view only
  }
  for (const l of localListeners) l();
}

/** Whether a value fits a setting (as the Gasho server checks the ones it keeps). */
export function fits(spec: PluginSettingSpec, v: unknown): boolean {
  switch (spec.type) {
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number" && Number.isFinite(v) && (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
    case "string":
      return typeof v === "string" && v.length <= (spec.maxLength ?? 10_000);
    case "select":
      return spec.options.some((o) => o.value === v);
  }
}

/** A setting of the plugin being drawn (gasho-plugin.json `settings`), and a function that changes it. */
export function useSetting<T>(key: string): [T, (value: T) => Promise<void>] {
  const info = usePluginInfo();
  const spec = info.manifest.settings?.[key];
  const storageKey = `${info.id}.${key}`;
  const saved = useSyncExternalStore(
    (l) => {
      localListeners.add(l);
      return () => localListeners.delete(l);
    },
    () => readLocal(storageKey),
  );
  if (!spec) throw new Error(`${info.manifest.name} の gasho-plugin.json の settings に ${key} がありません。`);
  const value = spec.scope === "browser" ? (fits(spec, saved) ? saved : spec.default) : (info.values[key] ?? spec.default);
  const change = async (v: T) => {
    if (spec.scope === "browser") {
      if (!fits(spec, v)) throw new Error("この値は使えません。");
      writeLocal(storageKey, v);
      return;
    }
    const r = await sendPluginCommand({ type: "plugin.setting", plugin: info.id, key, value: v });
    if (!r.ok) throw new Error(r.error ?? "設定を変えられませんでした。");
  };
  return [value as T, change];
}

const states = new Map<string, unknown>();
const stateListeners = new Set<() => void>();

function usePluginState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const id = useContext(PluginScopeContext) ?? "";
  const k = `${id}\0${key}`;
  const value = useSyncExternalStore(
    (l) => {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    () => (states.has(k) ? states.get(k) : initial),
  ) as T;
  const set = (v: T | ((prev: T) => T)) => {
    const prev = (states.has(k) ? states.get(k) : initial) as T;
    states.set(k, typeof v === "function" ? (v as (p: T) => T)(prev) : v);
    for (const l of stateListeners) l();
  };
  return [value, set];
}

// ---- moving between pages and panels ----

function useNavigation(): Navigation {
  const plugin = useContext(PluginScopeContext) ?? "";
  const route = useRoute();
  const session = useContext(SessionScopeContext);
  const here =
    route.name === "session"
      ? { machine: route.machine, sessionId: route.sessionId }
      : session
        ? { machine: session.machine.id, sessionId: session.session.sessionId }
        : undefined;
  const panelRoute = (id: string, params?: Params, at?: { machine: string; sessionId: string }): Route => {
    const w = at ?? here;
    if (!w) throw new Error("どのセッションのパネルかが分かりません（openPanel に at を渡してください）。");
    return { name: "session", machine: w.machine, sessionId: w.sessionId, panel: { kind: "plugin", plugin, id, params: params ?? {} } };
  };
  const pageRoute = (id: string, params?: Params): Route => ({ name: "plugin", plugin, page: id, params: params ?? {} });
  // The worktree on screen, or the worktree of the session on screen (see worktreeId).
  const worktreeRoute = (id: string, params?: Params, at?: { machine: string; path: string }): Route => {
    const s = here && getAppState().machines.find((m) => m.id === here.machine)?.sessions.find((x) => x.sessionId === here.sessionId);
    const w = at ?? (route.name === "worktree" ? route : s && here ? { machine: here.machine, path: s.worktree?.path ?? s.cwd } : undefined);
    if (!w) throw new Error("どの worktree の画面かが分かりません（openWorktreeView に at を渡してください）。");
    return { name: "worktree", machine: w.machine, path: w.path, view: { plugin, id, params: params ?? {} } };
  };
  return {
    pageHref: (id, params) => hrefOf(pageRoute(id, params)),
    openPage: (id, params) => go(pageRoute(id, params)),
    panelHref: (id, params, at) => hrefOf(panelRoute(id, params, at)),
    openPanel: (id, params, at) => {
      noteOpenedFrom(route);
      go(panelRoute(id, params, at));
    },
    replacePanel: (id, params) => go(panelRoute(id, params), { replace: true }),
    closePanel: () => {
      if (route.name === "session") go({ name: "session", machine: route.machine, sessionId: route.sessionId }, { replace: true });
    },
    back: (panel) => backTo(panelRoute(panel.id, panel.params)),
    sessionHref: (machine, sessionId) => hrefOf({ name: "session", machine, sessionId }),
    openSession: (machine, sessionId) => go({ name: "session", machine, sessionId }),
    worktreeHref: (id, params, at) => hrefOf(worktreeRoute(id, params, at)),
    openWorktreeView: (id, params, at) => go(worktreeRoute(id, params, at)),
  };
}

// ---- what a session is working on ----

/** Kept while its inputs stay the same, so that a part using it is drawn again only when something changed. */
function useSessionActivity(machine: string, sessionId: string): SessionActivity {
  const { machines, events, transcripts } = useAppState();
  const status = machines.find((m) => m.id === machine)?.sessions.find((s) => s.sessionId === sessionId)?.status;
  const entries = transcripts[transcriptKey(machine, sessionId)]?.entries;
  return useMemo(() => sessionActivity({ machine, sessionId, status }, events, entries), [machine, sessionId, status, events, entries]);
}

// ---- parts ----

function Page({ title, description, actions, children }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, subtitle, actions, children }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  const scope = useContext(PanelScopeContext);
  return (
    <SidePanel title={title} subtitle={subtitle} actions={actions} docked={scope?.docked ?? true} onClose={scope?.onClose ?? (() => undefined)}>
      {children}
    </SidePanel>
  );
}

function Tile({ title, icon, className, children }: { title?: string; icon?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <section className={cn(TILE, "flex h-full flex-col p-4", className)} style={{ boxShadow: TILE_SHADOW }}>
      {title && (
        <h2 className="mb-3 flex items-center gap-2 text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          <span className="text-neutral-500">{icon}</span>
          {title}
        </h2>
      )}
      <div className="@container min-h-0 flex-1">{children}</div>
    </section>
  );
}

function RelativeTime({ at, now }: { at: string | number; now: number }) {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return (
    <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString("ja-JP")}>
      {relativeTime(ms, now)}
    </time>
  );
}

function githubRepos(s: SessionInfo) {
  if (s.repos?.length) return s.repos.flatMap((r) => (r.github ? [{ path: r.path, github: r.github, ...(r.branch ? { branch: r.branch } : {}) }] : []));
  return s.github ? [{ github: s.github, ...(s.gitBranch ? { branch: s.gitBranch } : {}) }] : [];
}

/** The SDK, as plugins get it. */
export const sdk: GashoSdk = {
  definePlugin: (def: PluginDefinition) => def,
  useMachines: () => useAppState().machines,
  useSessionContext: () => useContext(SessionScopeContext),
  useDaemonReady: (machine: string) => readiness(usePluginInfo(), machine),
  useRequest: <T,>(target: RequestTarget | undefined, options?: RequestOptions) => useRequestFor<T>(useContext(PluginScopeContext) ?? "", target, options),
  useCall: () => {
    const plugin = useContext(PluginScopeContext) ?? "";
    return async <T,>(target: RequestTarget & { summary?: string }): Promise<CallResult<T>> => {
      const r = await callPlugin(plugin, target);
      return r.error !== undefined ? { ok: false, error: r.error } : { ok: true, data: r.result as T };
    };
  },
  useSetting,
  usePluginState,
  useNavigation,
  useSendInput: () => {
    const info = usePluginInfo();
    return async ({ machine, sessionId, text }): Promise<CallResult<undefined>> => {
      if (!info.manifest.permissions?.includes("session.input")) {
        return { ok: false, error: `${info.manifest.name} には、セッションに発言を送る権限がありません（gasho-plugin.json の permissions）。` };
      }
      const key = transcriptKey(machine, sessionId);
      const pending = addPending(key, { text: text.trim(), files: [], after: getAppState().transcripts[key]?.total ?? 0 });
      const r = await sendCommand(machine, { type: "session.input", sessionId, text, via: info.id }, 160_000);
      if (!r.ok) {
        removePending(key, pending);
        return { ok: false, error: r.error ?? "送れませんでした。" };
      }
      settlePending(key, pending, r.queued ? "queued" : "sent");
      return { ok: true, data: undefined };
    };
  },
  useLaunchSession: () => {
    const info = usePluginInfo();
    return async ({ machine, cwd, name, trust }): Promise<LaunchResult> => {
      if (!info.manifest.permissions?.includes("session.launch")) {
        return { ok: false, error: `${info.manifest.name} には、セッションを起動する権限がありません（gasho-plugin.json の permissions）。` };
      }
      const r = await sendCommand(machine, { type: "session.launch", cwd, name: name?.trim() || undefined, ...(trust ? { trust: true } : {}) }, 60_000);
      if (r.ok && r.sessionId) return { ok: true, sessionId: r.sessionId };
      if (r.needsTrust) {
        return { ok: false, error: "Claude Code がこのフォルダーを信頼するかを聞いています。", needsTrust: true, ...(r.trustWarnings ? { trustWarnings: r.trustWarnings } : {}) };
      }
      return { ok: false, error: r.error ?? "起動できませんでした。" };
    };
  },
  useSessionActivity,
  useNow,
  githubRepos,
  panelRepo,
  relativeTime: (ms, now) => relativeTime(ms, now),
  cn: (...classes) => cn(...(classes as Parameters<typeof cn>)),
  Page,
  Panel,
  PANEL_BUTTON,
  RepoTabs,
  Tile,
  Markdown: MarkdownText,
  RelativeTime,
};

let installed = false;

/** Puts the modules plugins share with Gasho's screen on globalThis.__gasho (once, before the first plugin loads). */
export function installShared(): void {
  if (installed) return;
  installed = true;
  const missing = SDK_EXPORTS.filter((name) => !Object.hasOwn(sdk, name));
  if (missing.length > 0) console.error(`gasho: the plugin SDK lacks ${missing.join(", ")}`);
  (globalThis as { __gasho?: unknown }).__gasho = {
    api: PLUGIN_API,
    modules: {
      react: React,
      "react/jsx-runtime": jsxRuntime,
      "react-dom": ReactDOM,
      "react-dom/client": ReactDOMClient,
      "@gasho/plugin-sdk": sdk,
    },
  };
}

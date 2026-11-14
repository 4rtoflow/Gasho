// The plugin SDK for the web part of a Gasho plugin (web.js). Gasho's screen provides everything here at run time: a
// plugin's build (gasho-plugin build) replaces `import … from "@gasho/plugin-sdk"` with what Gasho puts on globalThis,
// so this file only describes it (GashoSdk), for TypeScript. See docs/plugins.md of Gasho.
import type { ComponentType, ReactNode } from "react";
import type { GitHubRepo, MachineInfo, PluginInfo, SessionInfo, SessionRepo } from "@gasho/protocol";

export type { GitHubRepo, MachineInfo, PluginInfo, SessionInfo, SessionRepo } from "@gasho/protocol";

/** The arguments of a page or a panel: the query of its URL. */
export type Params = Record<string, string>;

/** Whether a plugin's daemon part can run on a working server, and why not when it cannot. */
export interface DaemonReadiness {
  ready: boolean;
  reason?: string;
}

/** A session, for the parts a plugin adds to it (header items, panels). */
export interface SessionContext {
  machine: MachineInfo;
  session: SessionInfo;
  /** This plugin's daemon part on the session's working server. */
  daemon: DaemonReadiness;
}

/** The panel open beside a session. */
export interface OpenPanel {
  plugin: string;
  id: string;
  params: Params;
}

type Icon = ComponentType<{ className?: string }>;

/** An item of the sidebar (P1). It opens a page of the plugin. */
export interface SidebarItem {
  id: string;
  label: string;
  icon: Icon;
  page: { id: string; params?: Params };
  /** A number or a short text beside the label. A React hook, called whenever the sidebar is drawn. */
  useBadge?: () => string | number | undefined;
}

/** A page of the plugin (P2): #/p/<plugin>/<page>?<params>. */
export interface PageProps {
  params: Params;
}

/** A panel of a session (P4): #/s/<machine>/<session>/p/<plugin>/<panel>?<params>. */
export interface PanelProps {
  machine: MachineInfo;
  session: SessionInfo;
  params: Params;
  /** Beside the session (a computer), rather than in its place (a phone). */
  docked: boolean;
}

/**
 * An item of the row of a session's header (P3), where "Issues" and "ファイル" are. Pressing it does one of: open a
 * panel of the plugin, open a page of the plugin, open a link (https) in a new tab, or call `onClick`.
 */
export interface SessionHeaderItem {
  id: string;
  label: string;
  icon?: Icon;
  /** Shown on hover. */
  title?: string;
  /**
   * Where it goes in the row: Gasho's own items are at 0 (waiting), 100 (repository), 200 (branch), 400 (files),
   * 800 (pull request links), 900 (last activity) and 1000 (cost). By default 500.
   */
  order?: number;
  /** Whether it shows for this session. */
  when?: (ctx: SessionContext) => boolean;
  panel?: { id: string; params?: Params };
  page?: { id: string; params?: Params };
  href?: (ctx: SessionContext) => string | undefined;
  onClick?: (ctx: SessionContext) => void | Promise<void>;
  /** Whether the open panel is this item's (it then shows as pressed). By default: the same panel with the item's params. */
  isOpen?: (panel: OpenPanel) => boolean;
  /** A React hook, as SidebarItem.useBadge. */
  useBadge?: (ctx: SessionContext) => string | number | undefined;
}

/**
 * The size of a home tile: stat (1 of 4 columns on a computer, 1 of 2 on a phone), small (1 of 4; the phone's width),
 * medium (2 of 4; the phone's width), large (3 of 4; the phone's width).
 */
export type TileSize = "stat" | "small" | "medium" | "large";

/** A tile of the home screen (P6). */
export interface HomeTile {
  id: string;
  /** The tile's name (its drag handle is read out with it). */
  title: string;
  size?: TileSize;
  /** Two rows high on a computer. */
  tall?: boolean;
  /** The tile it follows by default: one of Gasho's ("operations") or "<plugin>.<tile>". At the end without it. */
  after?: string;
  component: ComponentType;
}

/** What the web part of a plugin adds to Gasho's screen (its web.js exports it as default). */
export interface PluginDefinition {
  sidebar?: SidebarItem[];
  pages?: Record<string, ComponentType<PageProps>>;
  sessionHeader?: SessionHeaderItem[];
  sessionPanels?: Record<string, ComponentType<PanelProps>>;
  homeTiles?: HomeTile[];
  /** More on the settings screen, below the inputs made from gasho-plugin.json `settings` (P5). */
  settings?: ComponentType;
}

/** A call of a method of the plugin's daemon part (P7). */
export interface RequestTarget {
  /** The working server (machine id). */
  machine: string;
  /** The session the call is about, if any: the daemon part gets its folder. */
  sessionId?: string;
  method: string;
  /** JSON, up to 64 KB. */
  params?: unknown;
}

export interface RequestOptions {
  /** Read again when shown, if the result is older than this. */
  staleSeconds?: number;
  /** Read again at this interval while shown and the page is visible. */
  refreshSeconds?: number;
}

/** The result of a call, kept while the page is open and shared by every part that asks the same. */
export interface RequestState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** When `data` was read (ms since the epoch). */
  at?: number;
  /** Call again. */
  reload: () => void;
}

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Moving between the plugin's pages and panels. */
export interface Navigation {
  pageHref(id: string, params?: Params): string;
  openPage(id: string, params?: Params): void;
  /** A panel of the session on screen, or of `at` (from outside a session, such as a home tile). */
  panelHref(id: string, params?: Params, at?: { machine: string; sessionId: string }): string;
  /** Opens a panel (a new entry of the browser's history: back returns to what was open). */
  openPanel(id: string, params?: Params, at?: { machine: string; sessionId: string }): void;
  /** Shows another panel, or the same with other params, in place of the open one (no new history entry): tabs. */
  replacePanel(id: string, params?: Params): void;
  closePanel(): void;
  /** Back to `panel`: through the browser's history when the current one was opened from it, else by replacing. */
  back(panel: { id: string; params?: Params }): void;
}

/** A session's folder, or one of the repositories gasho-daemon found inside it. */
export interface RepoChoice {
  repos?: SessionRepo[];
  selected?: SessionRepo;
}

/** Everything Gasho's screen provides to plugins under "@gasho/plugin-sdk". */
export interface GashoSdk {
  /** Returns `def`; Gasho checks it when loading the plugin. */
  definePlugin(def: PluginDefinition): PluginDefinition;
  /** The working servers and their sessions, as Gasho's screen has them (read only). */
  useMachines(): MachineInfo[];
  /** In a session's header items and panels: that session. */
  useSessionContext(): SessionContext | undefined;
  /** Whether this plugin's daemon part runs on a working server. */
  useDaemonReady(machine: string): DaemonReadiness;
  /** Calls a method of the daemon part and keeps the result; undefined `target` calls nothing. */
  useRequest<T = unknown>(target: RequestTarget | undefined, options?: RequestOptions): RequestState<T>;
  /** A function that calls a method once (for `write` methods; `summary` goes to the operations log). */
  useCall(): <T = unknown>(target: RequestTarget & { summary?: string }) => Promise<CallResult<T>>;
  /** A setting of gasho-plugin.json `settings` and a function that changes it. */
  useSetting<T = unknown>(key: string): [T, (value: T) => Promise<void>];
  /** A value Gasho keeps while the page is open; it outlives a hot reload of the plugin. */
  usePluginState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void];
  useNavigation(): Navigation;
  /** Sends a message to a session (needs the permission "session.input"), as the chat box does. */
  useSendInput(): (input: { machine: string; sessionId: string; text: string }) => Promise<CallResult<undefined>>;
  /** The current time, renewed every `intervalMs` (30 s by default). */
  useNow(intervalMs?: number): number;
  /** The GitHub repositories of a session: its folder's, or those of the repositories inside it. */
  githubRepos(session: SessionInfo): { path?: string; github: GitHubRepo; branch?: string }[];
  /** Of the repositories inside the session's folder, those that `fit`, and the one asked for (else the first). */
  panelRepo(session: SessionInfo, asked: string | undefined, fit?: (r: SessionRepo) => boolean): RepoChoice;
  /** "3分前" */
  relativeTime(ms: number | undefined, now: number): string;
  /** Joins class names, as Gasho does (clsx and tailwind-merge). */
  cn(...classes: unknown[]): string;
  /** The frame of a page: title, description, buttons at the top right. */
  Page: ComponentType<{ title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
  /** The frame of a panel: Gasho adds the close button (computer) and "セッションに戻る" (phone). */
  Panel: ComponentType<{ title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
  /** The class of the small bordered buttons in a panel's header (reload, open on GitHub). */
  PANEL_BUTTON: string;
  /** Tabs of the repositories inside a session's folder. */
  RepoTabs: ComponentType<{ repos: SessionRepo[]; selected: string; onSelect: (path: string) => void }>;
  /** The frame of a home tile: title and icon. */
  Tile: ComponentType<{ title?: string; icon?: ReactNode; className?: string; children?: ReactNode }>;
  /** Markdown as the conversation shows it: no HTML, images as links. */
  Markdown: ComponentType<{ text: string }>;
  /** "3分前", with the exact time on hover. */
  RelativeTime: ComponentType<{ at: string | number; now: number }>;
}

export declare const definePlugin: GashoSdk["definePlugin"];
export declare const useMachines: GashoSdk["useMachines"];
export declare const useSessionContext: GashoSdk["useSessionContext"];
export declare const useDaemonReady: GashoSdk["useDaemonReady"];
export declare const useRequest: GashoSdk["useRequest"];
export declare const useCall: GashoSdk["useCall"];
export declare const useSetting: GashoSdk["useSetting"];
export declare const usePluginState: GashoSdk["usePluginState"];
export declare const useNavigation: GashoSdk["useNavigation"];
export declare const useSendInput: GashoSdk["useSendInput"];
export declare const useNow: GashoSdk["useNow"];
export declare const githubRepos: GashoSdk["githubRepos"];
export declare const panelRepo: GashoSdk["panelRepo"];
export declare const relativeTime: GashoSdk["relativeTime"];
export declare const cn: GashoSdk["cn"];
export declare const Page: GashoSdk["Page"];
export declare const Panel: GashoSdk["Panel"];
export declare const PANEL_BUTTON: GashoSdk["PANEL_BUTTON"];
export declare const RepoTabs: GashoSdk["RepoTabs"];
export declare const Tile: GashoSdk["Tile"];
export declare const Markdown: GashoSdk["Markdown"];
export declare const RelativeTime: GashoSdk["RelativeTime"];

/**
 * What Gasho's screen puts on globalThis.__gasho for plugins: the version of the plugin API, and the modules plugins
 * share with it (react, react/jsx-runtime, react-dom, @gasho/plugin-sdk).
 */
export interface GashoGlobal {
  api: string;
  modules: Record<string, unknown>;
}

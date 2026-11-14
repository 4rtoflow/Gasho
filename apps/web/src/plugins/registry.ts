// The web parts of the plugins installed on the Gasho server (docs/plugins.md). An enabled plugin's web.js is loaded
// with import() (and its web.css, limited to its parts) from the Gasho server, where its URL holds the hash of its files; when the
// Gasho server announces a new hash, the new version is loaded beside the old one and takes its place once it loaded
// (hot reload): its parts are drawn anew, while what Gasho keeps for it (the results of its calls, its settings, its
// state, the open page or panel) stays. When the new version cannot be loaded, the old one stays in use. A plugin that
// is disabled or removed is unloaded at once. A module once imported cannot be dropped from the page; its code stays
// in memory until the page is reloaded.
import { useSyncExternalStore } from "react";
import type { PluginDefinition } from "@gasho/plugin-sdk";
import { PLUGIN_API } from "@gasho/plugin-sdk/exports";
import type { PluginInfo } from "@gasho/protocol";
import { getAppState, subscribeAppState, useAppState } from "@/lib/store";
import { installShared } from "./sdk";

/** How long a plugin's files may take to load. */
const LOAD_MS = 15_000;

interface Loaded {
  hash: string;
  def: PluginDefinition;
}

interface RegistryState {
  loaded: Record<string, Loaded>;
  /** Why a plugin's web part could not be loaded (the version before stays, if there was one). */
  errors: Record<string, string>;
  /** Plugins whose web part is being loaded. */
  loading: Record<string, boolean>;
}

let state: RegistryState = { loaded: {}, errors: {}, loading: {} };
const listeners = new Set<() => void>();
/** The stylesheet of the version in use, per plugin. */
const sheets = new Map<string, CSSStyleSheet>();
/** The version being loaded, per plugin. */
const loadingHash = new Map<string, string>();

function set(next: Partial<RegistryState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Whether this screen runs plugins written for `api` (the same major, a minor up to its own). */
export function apiSupported(api: string): boolean {
  const [major, minor] = PLUGIN_API.split(".").map(Number);
  const m = /^(\d+)\.(\d+)$/.exec(api);
  return Boolean(m && Number(m[1]) === major && Number(m[2]) <= (minor ?? 0));
}

function timeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}が${LOAD_MS / 1000}秒たっても読み込めませんでした。`)), LOAD_MS))]);
}

/** The layers of a plugin's web.css that are left for the whole page: the theme's variables (on :root) and Tailwind's own. */
const PAGE_LAYERS = new Set(["theme", "properties"]);

/**
 * The rules of a plugin's web.css, with each style rule applying only inside the elements its parts are drawn in
 * (parts.tsx). A plugin's Tailwind classes share Gasho's layer and come after Gasho's, so that, unlimited, the plugin's
 * `.flex` would win over Gasho's `md:hidden` on Gasho's own elements (and over another plugin's). `:where()` keeps the
 * specificity of each rule as it is.
 */
function scopeRules(rules: CSSRuleList, plugin: string, top = true): string {
  const scope = `:where([data-gasho-plugin="${plugin}"])`;
  let out = "";
  let run = "";
  const flush = () => {
    if (run) out += `${scope}{${run}}`;
    run = "";
  };
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSLayerBlockRule) {
      flush();
      out += top && PAGE_LAYERS.has(rule.name) ? rule.cssText : `@layer ${rule.name}{${scopeRules(rule.cssRules, plugin, false)}}`;
    } else if (rule instanceof CSSStyleRule || rule instanceof CSSGroupingRule) {
      run += rule.cssText;
    } else {
      // @property, @keyframes, @font-face and the like name things for the whole page; they cannot be nested in a rule.
      flush();
      out += rule.cssText;
    }
  }
  flush();
  return out;
}

/** A plugin's web.css, limited to the plugin's parts; not on the page yet (addSheet). */
async function readSheet(href: string, plugin: string): Promise<CSSStyleSheet> {
  const res = await fetch(href).catch(() => undefined);
  if (!res?.ok) throw new Error("web.css を読み込めませんでした。");
  // baseURL: a url() in the CSS stays relative to web.css.
  const sheet = new CSSStyleSheet({ baseURL: href });
  sheet.replaceSync(await res.text());
  sheet.replaceSync(scopeRules(sheet.cssRules, plugin));
  return sheet;
}

function addSheet(sheet: CSSStyleSheet): void {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function removeSheet(sheet: CSSStyleSheet | undefined): void {
  if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a web.js exports, checked enough that drawing it cannot fail on its shape. */
export function checkDefinition(d: unknown): PluginDefinition {
  if (!isRecord(d)) throw new Error("web.js が、プラグイン（export default definePlugin({ … })）を書き出していません。");
  for (const k of ["sidebar", "sessionHeader", "homeTiles", "conversationEnd"] as const) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`${k} は配列にしてください。`);
    for (const item of (d[k] as unknown[] | undefined) ?? []) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) throw new Error(`${k} の項目に id がありません。`);
    }
  }
  for (const k of ["pages", "sessionPanels"] as const) {
    if (d[k] !== undefined && !isRecord(d[k])) throw new Error(`${k} はオブジェクトにしてください。`);
  }
  if (d.settings !== undefined && typeof d.settings !== "function") throw new Error("settings は部品にしてください。");
  return d as PluginDefinition;
}

async function load(info: PluginInfo): Promise<void> {
  const { id, hash, web } = info;
  if (!hash || !web) return;
  loadingHash.set(id, hash);
  set({ loading: { ...state.loading, [id]: true } });
  let sheet: CSSStyleSheet | undefined;
  try {
    if (!apiSupported(info.manifest.api)) throw new Error(`プラグインの API ${info.manifest.api} に、この画面は対応していません。Gasho を更新してください。`);
    installShared();
    if (web.css) {
      sheet = await timeout(readSheet(web.css, id), "web.css ");
      addSheet(sheet);
    }
    const mod = (await timeout(import(/* @vite-ignore */ web.js), "web.js ")) as { default?: unknown };
    const def = checkDefinition(mod.default);
    // Another version was asked for meanwhile, or the plugin was turned off.
    const now = getAppState().plugins.find((p) => p.id === id);
    if (loadingHash.get(id) !== hash || !now?.enabled || now.hash !== hash) {
      removeSheet(sheet);
      return;
    }
    removeSheet(sheets.get(id));
    if (sheet) sheets.set(id, sheet);
    else sheets.delete(id);
    const errors = { ...state.errors };
    delete errors[id];
    set({ loaded: { ...state.loaded, [id]: { hash, def } }, errors });
  } catch (e) {
    removeSheet(sheet);
    const why = e instanceof Error ? e.message : String(e);
    console.error(`gasho: plugin ${id} (${hash}) could not be loaded`, e);
    set({ errors: { ...state.errors, [id]: state.loaded[id] ? `新しい版を読み込めませんでした（前の版のまま動いています）：${why}` : `読み込めませんでした：${why}` } });
  } finally {
    if (loadingHash.get(id) === hash) {
      loadingHash.delete(id);
      const loading = { ...state.loading };
      delete loading[id];
      set({ loading });
    }
  }
}

function unload(id: string): void {
  removeSheet(sheets.get(id));
  sheets.delete(id);
  loadingHash.delete(id);
  const loaded = { ...state.loaded };
  const errors = { ...state.errors };
  delete loaded[id];
  delete errors[id];
  set({ loaded, errors });
}

/** Loads what is enabled and new, unloads what is disabled or gone. */
function sync(plugins: PluginInfo[]): void {
  const want = new Map(plugins.filter((p) => p.enabled && p.web && p.hash).map((p) => [p.id, p]));
  for (const id of Object.keys(state.loaded)) if (!want.has(id)) unload(id);
  for (const [id, info] of want) {
    if (state.loaded[id]?.hash === info.hash || loadingHash.get(id) === info.hash) continue;
    void load(info);
  }
}

let lastPlugins: PluginInfo[] | undefined;
subscribeAppState(() => {
  const plugins = getAppState().plugins;
  if (plugins === lastPlugins) return;
  lastPlugins = plugins;
  sync(plugins);
});

/** A plugin's part threw while being drawn: shown on the plugins screen. */
export function reportPluginError(id: string, message: string): void {
  if (state.errors[id] === message) return;
  set({ errors: { ...state.errors, [id]: message } });
}

export interface PluginPart {
  info: PluginInfo;
  def: PluginDefinition;
}

/** The installed plugins, the loaded web parts of the enabled ones (in the plugins' order), and their troubles. */
export function usePluginRegistry(): { infos: PluginInfo[]; parts: PluginPart[]; errors: Record<string, string>; loading: Record<string, boolean> } {
  const { plugins } = useAppState();
  const s = useSyncExternalStore(subscribe, () => state);
  const parts = [...plugins]
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "ja"))
    .flatMap((info) => {
      const l = info.enabled ? s.loaded[info.id] : undefined;
      return l ? [{ info, def: l.def }] : [];
    });
  return { infos: plugins, parts, errors: s.errors, loading: s.loading };
}

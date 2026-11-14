// Hash routes, so the hub can serve the app from any path without server-side routing.
import { useSyncExternalStore } from "react";

/**
 * A panel of a session: the branch graph, the files of its folder ("files": a folder in it, "file": a file), or a
 * panel of a plugin. On a computer it opens beside the session, on a phone in its place.
 */
export interface SessionPanel {
  kind: "graph" | "files" | "file" | "plugin";
  /** graph: one of the repositories inside the session's folder, when the folder itself is not a repository. */
  repo?: string;
  /** files, file: where, from the session's folder, "/"-separated (no `path` for the folder itself). */
  path?: string;
  /** plugin: a panel of a plugin (docs/plugins.md): the plugin, its panel, and the panel's params (the URL's query). */
  plugin?: string;
  id?: string;
  params?: Record<string, string>;
}

/** The params of a plugin's page or panel, from the query of the URL. */
function paramsOf(query: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  try {
    for (const [k, v] of new URLSearchParams(query)) out[k] = v;
  } catch {
    // none
  }
  return out;
}

/** The query of a plugin's page or panel, its params sorted so that one place has one URL. */
function queryOf(params: Record<string, string> | undefined): string {
  const entries = Object.entries(params ?? {}).filter(([, v]) => typeof v === "string").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** A path inside a session's folder from the URL, each name encoded: undefined when it is not one. */
function decodePath(encoded: string): string | undefined {
  try {
    const parts = encoded.split("/").map(decodeURIComponent);
    const path = parts.join("/");
    // A name may hold an encoded "/" only as a way of writing the path; what counts are the names it makes.
    return path.split("/").every((p) => p !== "" && p !== "." && p !== "..") ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A path inside a session's folder for the URL: its names encoded, its slashes kept. */
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** `machine` is a machine id. */
export type Route =
  | { name: "home" }
  | { name: "devices" }
  | { name: "settings" }
  /** The plugins screen (docs/plugins.md). */
  | { name: "plugins" }
  /** A page of a plugin: #/p/<plugin>/<page>?<params>. */
  | { name: "plugin"; plugin: string; page: string; params: Record<string, string> }
  | { name: "session"; machine: string; sessionId: string; panel?: SessionPanel };

export function parseHash(hash: string): Route {
  if (hash === "#/devices") return { name: "devices" };
  if (hash === "#/settings") return { name: "settings" };
  if (hash === "#/plugins") return { name: "plugins" };
  // A plugin's page, and a plugin's panel of a session: …/p/<plugin>/<id>, with the params as the query.
  const [where, query] = hash.split("?", 2) as [string, string | undefined];
  const page = where.match(/^#\/p\/([^/]+)\/([^/]+)$/);
  if (page?.[1] && page[2]) {
    try {
      const plugin = decodeURIComponent(page[1]);
      if (PLUGIN_ID.test(plugin)) return { name: "plugin", plugin, page: decodeURIComponent(page[2]), params: paramsOf(query) };
    } catch {
      // not one
    }
    return { name: "home" };
  }
  const panel = where.match(/^#\/s\/([^/]+)\/([^/]+)\/p\/([^/]+)\/([^/]+)$/);
  if (panel?.[1] && panel[2] && panel[3] && panel[4]) {
    try {
      const plugin = decodeURIComponent(panel[3]);
      if (!PLUGIN_ID.test(plugin)) return { name: "home" };
      const ids = { machine: decodeURIComponent(panel[1]), sessionId: decodeURIComponent(panel[2]) };
      return { name: "session", ...ids, panel: { kind: "plugin", plugin, id: decodeURIComponent(panel[4]), params: paramsOf(query) } };
    } catch {
      return { name: "home" };
    }
  }
  // The files of the session's folder: …/files (the folder itself), …/files/<folder>, …/file/<file>; paths keep their slashes.
  const f = hash.match(/^#\/s\/([^/]+)\/([^/]+)\/(files|file)(?:\/(.+))?$/);
  if (f?.[1] && f[2] && f[3]) {
    const ids = { machine: decodeURIComponent(f[1]), sessionId: decodeURIComponent(f[2]) };
    const path = f[4] === undefined ? undefined : decodePath(f[4]);
    if (f[4] !== undefined && path === undefined) return { name: "home" };
    if (f[3] === "file") return path ? { name: "session", ...ids, panel: { kind: "file", path } } : { name: "home" };
    return { name: "session", ...ids, panel: path ? { kind: "files", path } : { kind: "files" } };
  }
  // …/graph (with /<repo>). Before the GitHub plugin, Gasho itself had …/issues and …/pulls (with /<repo>), and one
  // issue or pull request at …/issue/<number> and …/pull/<number> (with /<repo>): those links open the plugin's panels.
  const m = hash.match(/^#\/s\/([^/]+)\/([^/]+)(?:\/(graph|issues|pulls)(?:\/([^/]+))?|\/(issue|pull)\/([1-9]\d{0,8})(?:\/([^/]+))?)?$/);
  if (m?.[1] && m[2]) {
    try {
      const ids = { machine: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
      const repo = m[4] ?? m[7];
      const where: Record<string, string> = repo ? { repo: decodeURIComponent(repo) } : {};
      if (m[3] === "graph") return { name: "session", ...ids, panel: { kind: "graph", ...where } };
      if (m[3]) return { name: "session", ...ids, panel: { kind: "plugin", plugin: "github", id: "list", params: { kind: m[3], ...where } } };
      if (m[5] && m[6]) {
        const params = { kind: m[5] === "issue" ? "issues" : "pulls", number: m[6], ...where };
        return { name: "session", ...ids, panel: { kind: "plugin", plugin: "github", id: "item", params } };
      }
      return { name: "session", ...ids };
    } catch {
      return { name: "home" };
    }
  }
  return { name: "home" };
}

/** A link to Gasho's own issues and pull requests, from before the GitHub plugin (parseHash opens the plugin's panels). */
export const isOldGitHubLink = (hash: string): boolean => /^#\/s\/[^/]+\/[^/]+\/(issues|pulls|issue|pull)(\/|$)/.test(hash);

export function hrefOf(r: Route): string {
  if (r.name === "home") return "#/";
  if (r.name === "devices") return "#/devices";
  if (r.name === "settings") return "#/settings";
  if (r.name === "plugins") return "#/plugins";
  if (r.name === "plugin") return `#/p/${encodeURIComponent(r.plugin)}/${encodeURIComponent(r.page)}${queryOf(r.params)}`;
  const base = `#/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.sessionId)}`;
  if (!r.panel) return base;
  if (r.panel.kind === "plugin") {
    return `${base}/p/${encodeURIComponent(r.panel.plugin ?? "")}/${encodeURIComponent(r.panel.id ?? "")}${queryOf(r.panel.params)}`;
  }
  if (r.panel.kind === "files" || r.panel.kind === "file") {
    return `${base}/${r.panel.kind}${r.panel.path ? `/${encodePath(r.panel.path)}` : ""}`;
  }
  // A repository path such as "org/app" is one segment, its slashes encoded.
  return `${base}/graph${r.panel.repo ? `/${encodeURIComponent(r.panel.repo)}` : ""}`;
}

/** The panel or page a plugin's panel was opened from, so going back to it can use the browser's history. */
let openedFrom: string | undefined;

export function noteOpenedFrom(r: Route): void {
  openedFrom = hrefOf(r);
}

/** Back to `r`: through the history when the current page was opened from it, otherwise by replacing this page. */
export function backTo(r: Route): void {
  if (openedFrom === hrefOf(r) && history.length > 1) {
    openedFrom = undefined;
    history.back();
  } else go(r, { replace: true });
}

/** `replace` swaps the current history entry, for switching tabs without filling the back button's history. */
export function go(r: Route, { replace = false } = {}): void {
  if (replace) location.replace(hrefOf(r));
  else location.hash = hrefOf(r);
}

function subscribe(l: () => void): () => void {
  window.addEventListener("hashchange", l);
  return () => window.removeEventListener("hashchange", l);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseHash(hash);
}

// Hash routes, so the hub can serve the app from any path without server-side routing.
import { useSyncExternalStore } from "react";

/**
 * A panel of a session: the branch graph, or the open issues or pull requests of its GitHub repository. On a computer
 * it opens beside the session, on a phone in its place. `repo` picks one of the repositories inside the session's
 * folder when the folder itself is not a repository.
 */
export interface SessionPanel {
  kind: "graph" | "issues" | "pulls";
  repo?: string;
}

/** `machine` is a machine id. */
export type Route =
  | { name: "home" }
  | { name: "devices" }
  | { name: "session"; machine: string; sessionId: string; panel?: SessionPanel };

export function parseHash(hash: string): Route {
  if (hash === "#/devices") return { name: "devices" };
  const m = hash.match(/^#\/s\/([^/]+)\/([^/]+)(?:\/(graph|issues|pulls)(?:\/([^/]+))?)?$/);
  if (m?.[1] && m[2]) {
    const ids = { machine: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
    const kind = m[3] as SessionPanel["kind"] | undefined;
    if (!kind) return { name: "session", ...ids };
    return { name: "session", ...ids, panel: m[4] ? { kind, repo: decodeURIComponent(m[4]) } : { kind } };
  }
  return { name: "home" };
}

export function hrefOf(r: Route): string {
  if (r.name === "home") return "#/";
  if (r.name === "devices") return "#/devices";
  const base = `#/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.sessionId)}`;
  if (!r.panel) return base;
  // A repository path such as "org/app" is one segment, its slashes encoded.
  return `${base}/${r.panel.kind}${r.panel.repo ? `/${encodeURIComponent(r.panel.repo)}` : ""}`;
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

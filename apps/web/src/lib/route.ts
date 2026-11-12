// Hash routes, so the hub can serve the app from any path without server-side routing.
import { useSyncExternalStore } from "react";

/** `machine` is a machine id. */
export type Route =
  | { name: "home" }
  | { name: "devices" }
  | { name: "session"; machine: string; sessionId: string }
  /**
   * The branch graph of the repository the session works in. `repo` picks one of the repositories inside the
   * session's folder when the folder itself is not a repository.
   */
  | { name: "graph"; machine: string; sessionId: string; repo?: string };

export function parseHash(hash: string): Route {
  if (hash === "#/devices") return { name: "devices" };
  const m = hash.match(/^#\/s\/([^/]+)\/([^/]+)(\/graph(?:\/([^/]+))?)?$/);
  if (m?.[1] && m[2]) {
    const ids = { machine: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
    if (!m[3]) return { name: "session", ...ids };
    return m[4] ? { name: "graph", ...ids, repo: decodeURIComponent(m[4]) } : { name: "graph", ...ids };
  }
  return { name: "home" };
}

export function hrefOf(r: Route): string {
  if (r.name === "home") return "#/";
  if (r.name === "devices") return "#/devices";
  const base = `#/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.sessionId)}`;
  if (r.name !== "graph") return base;
  // A repository path such as "org/app" is one segment, its slashes encoded.
  return r.repo ? `${base}/graph/${encodeURIComponent(r.repo)}` : `${base}/graph`;
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

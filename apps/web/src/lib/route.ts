// Hash routes, so the hub can serve the app from any path without server-side routing.
import { useSyncExternalStore } from "react";

/**
 * A panel of a session: the branch graph, or the open issues or pull requests of its GitHub repository (`number`: one
 * of them, with its conversation). On a computer it opens beside the session, on a phone in its place. `repo` picks
 * one of the repositories inside the session's folder when the folder itself is not a repository.
 */
export interface SessionPanel {
  kind: "graph" | "issues" | "pulls";
  repo?: string;
  number?: number;
}

/** `machine` is a machine id. */
export type Route =
  | { name: "home" }
  | { name: "devices" }
  | { name: "session"; machine: string; sessionId: string; panel?: SessionPanel };

export function parseHash(hash: string): Route {
  if (hash === "#/devices") return { name: "devices" };
  // …/graph, …/issues, …/pulls (with /<repo>); one issue or pull request: …/issue/<number>, …/pull/<number> (with /<repo>).
  const m = hash.match(/^#\/s\/([^/]+)\/([^/]+)(?:\/(graph|issues|pulls)(?:\/([^/]+))?|\/(issue|pull)\/([1-9]\d{0,8})(?:\/([^/]+))?)?$/);
  if (m?.[1] && m[2]) {
    const ids = { machine: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
    const repo = m[4] ?? m[7];
    const where = repo ? { repo: decodeURIComponent(repo) } : {};
    if (m[3]) return { name: "session", ...ids, panel: { kind: m[3] as SessionPanel["kind"], ...where } };
    if (m[5] && m[6]) return { name: "session", ...ids, panel: { kind: m[5] === "issue" ? "issues" : "pulls", ...where, number: Number(m[6]) } };
    return { name: "session", ...ids };
  }
  return { name: "home" };
}

export function hrefOf(r: Route): string {
  if (r.name === "home") return "#/";
  if (r.name === "devices") return "#/devices";
  const base = `#/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.sessionId)}`;
  if (!r.panel) return base;
  // A repository path such as "org/app" is one segment, its slashes encoded.
  const repo = r.panel.repo ? `/${encodeURIComponent(r.panel.repo)}` : "";
  if (r.panel.number !== undefined && r.panel.kind !== "graph") return `${base}/${r.panel.kind === "issues" ? "issue" : "pull"}/${r.panel.number}${repo}`;
  return `${base}/${r.panel.kind}${repo}`;
}

/** The list an issue or pull request was opened from, so going back to it can use the browser's history. */
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

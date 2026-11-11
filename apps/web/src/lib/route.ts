// Hash routes, so the hub can serve the app from any path without server-side routing.
import { useSyncExternalStore } from "react";

/** `machine` is a machine id. */
export type Route = { name: "home" } | { name: "devices" } | { name: "session"; machine: string; sessionId: string };

export function parseHash(hash: string): Route {
  if (hash === "#/devices") return { name: "devices" };
  const m = hash.match(/^#\/s\/([^/]+)\/([^/]+)$/);
  if (m?.[1] && m[2]) return { name: "session", machine: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
  return { name: "home" };
}

export function hrefOf(r: Route): string {
  if (r.name === "home") return "#/";
  if (r.name === "devices") return "#/devices";
  return `#/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.sessionId)}`;
}

export function go(r: Route): void {
  location.hash = hrefOf(r);
}

function subscribe(l: () => void): () => void {
  window.addEventListener("hashchange", l);
  return () => window.removeEventListener("hashchange", l);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return parseHash(hash);
}

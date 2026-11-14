// The calls of plugins' web parts to their daemon parts (docs/plugins.md, P7). useRequest keeps each result while the
// page is open, shared by every part that asks the same (a home tile and a panel read one list), keeps the last result
// when a call fails, and calls again when the connection to the Gasho server comes back. A plugin's hot reload does not
// touch any of it. callPlugin calls once (useCall, for `write` methods).
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { RequestOptions, RequestState, RequestTarget } from "@gasho/plugin-sdk";
import type { ClientToHub } from "@gasho/protocol";
import { onConnected, onHubMessage, sendToHub } from "@/lib/store";

/** A little longer than the Gasho server waits for the longest method (120 s). */
const CALL_MS = 130_000;

interface Entry {
  loading: boolean;
  data?: unknown;
  error?: string;
  at?: number;
}

type PluginRequest = Extract<ClientToHub, { type: "plugin.request" }>;

interface Waiting {
  msg: PluginRequest;
  resolve: (r: { result?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  /** A read, asked again on a new connection; a write is not (it may have run). */
  again: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const waiting = new Map<string, Waiting>();
let seq = 0;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

onHubMessage((m) => {
  if (m.type !== "plugin.response") return;
  const w = waiting.get(m.requestId);
  if (!w) return;
  waiting.delete(m.requestId);
  clearTimeout(w.timer);
  w.resolve(typeof m.error === "string" ? { error: m.error } : { result: m.result });
});

// The Gasho server forgets the calls of a connection that closed.
onConnected(() => {
  for (const [id, w] of waiting) {
    if (w.again) {
      sendToHub(w.msg);
      continue;
    }
    waiting.delete(id);
    clearTimeout(w.timer);
    w.resolve({ error: "Gasho サーバーとの接続が切れたので、結果が分かりません。" });
  }
});

/** Calls a method of a plugin's daemon part once. `again`: a read, which waits for the connection and is asked again. */
export function callPlugin(plugin: string, t: RequestTarget & { summary?: string }, again = false): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const requestId = `p${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const msg: PluginRequest = {
      type: "plugin.request",
      requestId,
      plugin,
      machine: t.machine,
      method: t.method,
      ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
      ...(t.params !== undefined ? { params: t.params } : {}),
      ...(t.summary ? { summary: t.summary } : {}),
    };
    const timer = setTimeout(() => {
      if (waiting.delete(requestId)) resolve({ error: "応答がありませんでした。" });
    }, CALL_MS);
    waiting.set(requestId, { msg, resolve, timer, again });
    if (!sendToHub(msg) && !again) {
      waiting.delete(requestId);
      clearTimeout(timer);
      resolve({ error: "Gasho サーバーにつながっていません。" });
    }
  });
}

const keyOf = (plugin: string, t: RequestTarget): string => JSON.stringify([plugin, t.machine, t.sessionId ?? "", t.method, t.params ?? null]);

function load(plugin: string, t: RequestTarget, key: string): void {
  const cur = entries.get(key);
  if (cur?.loading) return;
  entries.set(key, { ...cur, loading: true, error: undefined });
  emit();
  void callPlugin(plugin, t, true).then((r) => {
    const was = entries.get(key);
    // On an error, what was read before stays, with the error.
    entries.set(key, r.error !== undefined ? { ...was, loading: false, error: r.error } : { loading: false, data: r.result, at: Date.now() });
    emit();
  });
}

/** useRequest of plugin `plugin`. */
export function useRequestFor<T>(plugin: string, target: RequestTarget | undefined, opts: RequestOptions = {}): RequestState<T> {
  const key = target ? keyOf(plugin, target) : undefined;
  const entry = useSyncExternalStore(subscribe, () => (key ? entries.get(key) : undefined));
  const targetRef = useRef(target);
  targetRef.current = target;
  const { staleSeconds, refreshSeconds } = opts;

  useEffect(() => {
    const t = targetRef.current;
    if (!key || !t) return;
    const e = entries.get(key);
    const stale = staleSeconds !== undefined && e?.at !== undefined && Date.now() - e.at >= staleSeconds * 1000;
    if (!e || (e.at === undefined && e.error === undefined) || stale) load(plugin, t, key);
  }, [plugin, key, staleSeconds]);

  useEffect(() => {
    if (!key || !refreshSeconds || refreshSeconds <= 0) return;
    const timer = setInterval(() => {
      const t = targetRef.current;
      if (t && document.visibilityState === "visible") load(plugin, t, key);
    }, refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [plugin, key, refreshSeconds]);

  const reload = useCallback(() => {
    const t = targetRef.current;
    if (key && t) load(plugin, t, key);
  }, [plugin, key]);

  return {
    data: entry?.data as T | undefined,
    error: entry?.error,
    // Asked for but not read yet: loading (the effect calls once the part is on screen).
    loading: entry ? entry.loading : key !== undefined,
    at: entry?.at,
    reload,
  };
}

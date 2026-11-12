// Client state, kept in sync with gasho-hub over /ws/client.
import { useSyncExternalStore } from "react";
import type {
  ClientToHub,
  CommandResult,
  DeviceInfo,
  GashoNotification,
  GitGraph,
  GitHubList,
  GitHubListKind,
  HubToClient,
  MachineHookEvent,
  MachineInfo,
  SessionCommand,
  TranscriptEntry,
} from "@gasho/protocol";
import { fetchMe } from "./api";

/** Close code the Gasho server uses when this browser is not (or no longer) registered. */
const CLOSE_UNAUTHORIZED = 4401;

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** Index of entries[0] in the whole transcript. */
  start: number;
  total: number;
  loading: boolean;
  error?: string;
}

/** The branch graph of a session's repository. */
export interface GraphState {
  loading: boolean;
  graph?: GitGraph;
  error?: string;
  /** When the graph was read. */
  at?: number;
}

/** The open issues or pull requests of a session's GitHub repository. */
export interface GitHubListState {
  loading: boolean;
  list?: GitHubList;
  error?: string;
  /** When the list was read. */
  at?: number;
}

export type AuthState = "checking" | "registered" | "unregistered" | "unreachable";

export interface State {
  auth: AuthState;
  me?: DeviceInfo;
  connected: boolean;
  machines: MachineInfo[];
  notifications: GashoNotification[];
  events: MachineHookEvent[];
  transcripts: Record<string, TranscriptState>;
  /** Keyed by graphKey(machine, sessionId, repo). */
  graphs: Record<string, GraphState>;
  /** Keyed by githubKey(machine, sessionId, kind, repo). */
  githubLists: Record<string, GitHubListState>;
}

const PAGE_SIZE = 80;
const MAX_EVENTS = 300;
const MAX_NOTIFICATIONS = 200;

export const transcriptKey = (machine: string, sessionId: string): string => `${machine}\u0000${sessionId}`;
/** A branch graph per session and, in a folder of several repositories, per repository. */
export const graphKey = (machine: string, sessionId: string, repo?: string): string => `${machine}\u0000${sessionId}\u0000${repo ?? ""}`;
/** A GitHub list per session, kind and, in a folder of several repositories, per repository. */
export const githubKey = (machine: string, sessionId: string, kind: GitHubListKind, repo?: string): string =>
  `${machine}\u0000${sessionId}\u0000${kind}\u0000${repo ?? ""}`;

const EMPTY: Omit<State, "auth"> = { connected: false, machines: [], notifications: [], events: [], transcripts: {}, graphs: {}, githubLists: {} };
let state: State = { auth: "checking", ...EMPTY };
const listeners = new Set<() => void>();

function update(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function setTranscript(key: string, t: TranscriptState): void {
  update({ transcripts: { ...state.transcripts, [key]: t } });
}

function setGraph(key: string, g: GraphState): void {
  update({ graphs: { ...state.graphs, [key]: g } });
}

function setGitHubList(key: string, g: GitHubListState): void {
  update({ githubLists: { ...state.githubLists, [key]: g } });
}

let socket: WebSocket | undefined;
let backoff = 1000;

/** Checks the registration of this browser and connects when it is registered. */
export async function start(): Promise<void> {
  update({ auth: "checking" });
  try {
    const me = await fetchMe();
    if (!me) {
      update({ auth: "unregistered", me: undefined });
      return;
    }
    update({ auth: "registered", me });
    if (!socket) connect();
  } catch {
    update({ auth: "unreachable" });
    setTimeout(() => void start(), 5000);
  }
}

/** Forgets everything after this browser's registration ended. */
export function becomeUnregistered(): void {
  const ws = socket;
  socket = undefined;
  ws?.close();
  state = { auth: "unregistered", ...EMPTY };
  for (const l of listeners) l();
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/client`);
  socket = ws;
  ws.onopen = () => {
    backoff = 1000;
    update({ connected: true });
    // Reload the transcripts that are on screen; appends may have been missed while offline.
    for (const key of Object.keys(state.transcripts)) {
      const [machine, sessionId] = key.split("\u0000");
      if (machine && sessionId) requestPage(machine, sessionId, undefined);
    }
    // Requests sent just before the connection dropped are lost; ask again.
    for (const [key, g] of Object.entries(state.graphs)) {
      const [machine, sessionId, repo] = key.split("\u0000");
      if (g.loading && machine && sessionId) send({ type: "git.graph.get", machine, sessionId, repo: repo || undefined });
    }
    for (const [key, g] of Object.entries(state.githubLists)) {
      const [machine, sessionId, kind, repo] = key.split("\u0000");
      if (g.loading && machine && sessionId && (kind === "issues" || kind === "pulls")) {
        send({ type: "github.list.get", machine, sessionId, kind, repo: repo || undefined });
      }
    }
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)) as HubToClient);
    } catch (e) {
      console.error("gasho: bad message", e);
    }
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return; // replaced or closed on purpose
    socket = undefined;
    if (ev.code === CLOSE_UNAUTHORIZED) {
      becomeUnregistered();
      return;
    }
    update({ connected: false });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
}

function send(m: ClientToHub): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
}

const pendingCommands = new Map<string, (r: CommandResult) => void>();

/** crypto.randomUUID() is unavailable over plain HTTP on the LAN (it needs a secure context). */
function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sends a command to a working server through the Gasho server and waits for its result. */
export function sendCommand(machine: string, cmd: SessionCommand, timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (socket?.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: "Gasho サーバーにつながっていません。" });
      return;
    }
    const id = requestId();
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      resolve({ ok: false, error: "応答がありませんでした。" });
    }, timeoutMs);
    pendingCommands.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    send({ ...cmd, requestId: id, machine });
  });
}

function sameEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.uuid !== "" && a.uuid === b.uuid;
}

function handle(m: HubToClient): void {
  switch (m.type) {
    case "snapshot":
      update({ machines: m.machines, notifications: m.notifications, events: m.events.slice(-MAX_EVENTS) });
      break;
    case "machine": {
      const machines = state.machines.filter((x) => x.id !== m.machine.id);
      machines.push(m.machine);
      machines.sort((a, b) => a.name.localeCompare(b.name));
      update({ machines });
      break;
    }
    case "machine.removed": {
      const prefix = transcriptKey(m.id, "");
      const transcripts = Object.fromEntries(Object.entries(state.transcripts).filter(([k]) => !k.startsWith(prefix)));
      const graphs = Object.fromEntries(Object.entries(state.graphs).filter(([k]) => !k.startsWith(prefix)));
      const githubLists = Object.fromEntries(Object.entries(state.githubLists).filter(([k]) => !k.startsWith(prefix)));
      update({ machines: state.machines.filter((x) => x.id !== m.id), transcripts, graphs, githubLists });
      break;
    }
    case "transcript.page": {
      const key = transcriptKey(m.machine, m.sessionId);
      const cur = state.transcripts[key];
      if (m.error) {
        setTranscript(key, { entries: cur?.entries ?? [], start: cur?.start ?? 0, total: cur?.total ?? 0, loading: false, error: m.error });
        break;
      }
      const isOlderPage = cur && cur.entries.length > 0 && m.start + m.entries.length <= cur.start;
      if (isOlderPage) {
        setTranscript(key, { entries: [...m.entries, ...cur.entries], start: m.start, total: m.total, loading: false });
      } else {
        // Keep live entries that arrived after the page was read.
        const extra = (cur?.entries ?? []).filter((e) => e.uuid && !m.entries.some((p) => sameEntry(p, e)));
        const lastTs = m.entries.at(-1)?.ts;
        // With an empty page (a brand-new session) every live entry is newer than the page.
        const tail = lastTs ? extra.filter((e) => e.ts && e.ts > lastTs) : extra;
        setTranscript(key, { entries: [...m.entries, ...tail], start: m.start, total: m.total + tail.length, loading: false });
      }
      break;
    }
    case "transcript.append": {
      const key = transcriptKey(m.machine, m.sessionId);
      const cur = state.transcripts[key];
      if (!cur) break;
      const add = m.entries.filter((e) => !cur.entries.some((c) => sameEntry(c, e)));
      if (add.length === 0) break;
      setTranscript(key, { ...cur, entries: [...cur.entries, ...add], total: cur.total + add.length });
      break;
    }
    case "notification":
      update({ notifications: [m.notification, ...state.notifications].slice(0, MAX_NOTIFICATIONS) });
      break;
    case "notification.read": {
      const ids = new Set(m.ids);
      update({ notifications: state.notifications.map((n) => (ids.has(n.id) ? { ...n, read: true } : n)) });
      break;
    }
    case "event":
      update({ events: [...state.events, m.event].slice(-MAX_EVENTS) });
      break;
    case "command.result":
      pendingCommands.get(m.requestId)?.(m.result);
      pendingCommands.delete(m.requestId);
      break;
    case "git.graph": {
      const key = graphKey(m.machine, m.sessionId, m.repo);
      const cur = state.graphs[key];
      // On an error, keep showing the graph read before, with the error.
      setGraph(key, m.graph ? { loading: false, graph: m.graph, at: Date.now() } : { ...cur, loading: false, error: m.error ?? "読み込めませんでした。" });
      break;
    }
    case "github.list": {
      const key = githubKey(m.machine, m.sessionId, m.kind, m.repo);
      const cur = state.githubLists[key];
      // On an error, keep showing the list read before, with the error.
      setGitHubList(key, m.list ? { loading: false, list: m.list, at: Date.now() } : { ...cur, loading: false, error: m.error ?? "読み込めませんでした。" });
      break;
    }
  }
}

/** Reads the branch graph of the session's repository (or of `repo` inside its folder) again. */
export function loadGraph(machine: string, sessionId: string, repo?: string): void {
  const key = graphKey(machine, sessionId, repo);
  const cur = state.graphs[key];
  if (cur?.loading) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    setGraph(key, { ...cur, loading: false, error: "Gasho サーバーにつながっていません。" });
    return;
  }
  setGraph(key, { ...cur, loading: true, error: undefined });
  send({ type: "git.graph.get", machine, sessionId, repo });
}

/** Reads the open issues or pull requests of the session's GitHub repository (or of `repo` inside its folder) again. */
export function loadGitHubList(machine: string, sessionId: string, kind: GitHubListKind, repo?: string): void {
  const key = githubKey(machine, sessionId, kind, repo);
  const cur = state.githubLists[key];
  if (cur?.loading) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    setGitHubList(key, { ...cur, loading: false, error: "Gasho サーバーにつながっていません。" });
    return;
  }
  setGitHubList(key, { ...cur, loading: true, error: undefined });
  send({ type: "github.list.get", machine, sessionId, kind, repo });
}

function requestPage(machine: string, sessionId: string, before: number | undefined): void {
  const key = transcriptKey(machine, sessionId);
  const cur = state.transcripts[key];
  setTranscript(key, {
    entries: cur?.entries ?? [],
    start: cur?.start ?? 0,
    total: cur?.total ?? 0,
    loading: true,
  });
  send({ type: "transcript.get", machine, sessionId, before, limit: PAGE_SIZE });
}

/** Loads the latest page, or the page before what is loaded when `older` is true. */
export function loadTranscript(machine: string, sessionId: string, older = false): void {
  const cur = state.transcripts[transcriptKey(machine, sessionId)];
  if (cur?.loading) return;
  if (older) {
    if (!cur || cur.start === 0) return;
    requestPage(machine, sessionId, cur.start);
  } else {
    requestPage(machine, sessionId, undefined);
  }
}

export function markRead(ids: string[]): void {
  if (ids.length > 0) send({ type: "notification.read", ids });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

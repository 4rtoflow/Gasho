// Client state, kept in sync with gasho-hub over /ws/client.
import { useSyncExternalStore } from "react";
import type {
  ClientToHub,
  CommandResult,
  DeviceInfo,
  DirListing,
  FileContent,
  GashoNotification,
  GitGraph,
  HubToClient,
  MachineHookEvent,
  MachineInfo,
  PluginCommand,
  PluginInfo,
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

/** A folder inside a session's folder. */
export interface DirState {
  loading: boolean;
  dir?: DirListing;
  error?: string;
  at?: number;
}

/** A file inside a session's folder. */
export interface FileState {
  loading: boolean;
  file?: FileContent;
  error?: string;
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
  /** Keyed by fileKey(machine, sessionId, path). */
  dirs: Record<string, DirState>;
  files: Record<string, FileState>;
  /** The plugins installed on the Gasho server (docs/plugins.md). */
  plugins: PluginInfo[];
}

const PAGE_SIZE = 80;
const MAX_EVENTS = 300;
const MAX_NOTIFICATIONS = 200;

export const transcriptKey = (machine: string, sessionId: string): string => `${machine}\u0000${sessionId}`;
/** A branch graph per session and, in a folder of several repositories, per repository. */
export const graphKey = (machine: string, sessionId: string, repo?: string): string => `${machine}\u0000${sessionId}\u0000${repo ?? ""}`;
/** A folder or a file inside a session's folder, by its path from there ("" for the folder itself). */
export const fileKey = (machine: string, sessionId: string, path: string): string => `${machine}\u0000${sessionId}\u0000${path}`;

const EMPTY: Omit<State, "auth"> = {
  connected: false,
  machines: [],
  notifications: [],
  events: [],
  transcripts: {},
  graphs: {},
  dirs: {},
  files: {},
  plugins: [],
};
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

function setDir(key: string, d: DirState): void {
  update({ dirs: { ...state.dirs, [key]: d } });
}

function setFile(key: string, f: FileState): void {
  update({ files: { ...state.files, [key]: f } });
}

let socket: WebSocket | undefined;
let backoff = 1000;
/** The next try after a failure: start() while the Gasho server is unreachable, connect() after the connection dropped. */
let retry: { timer: ReturnType<typeof setTimeout>; run: () => void } | undefined;

function retryLater(run: () => void, ms: number): void {
  cancelRetry();
  retry = {
    run,
    timer: setTimeout(() => {
      retry = undefined;
      run();
    }, ms),
  };
}

function cancelRetry(): void {
  if (retry) clearTimeout(retry.timer);
  retry = undefined;
}

/**
 * Tries again at once, instead of after the back-off, when the app comes back on screen or the network comes back.
 * A phone suspends a web app in the background, so its connection is often gone by the time it is opened again.
 */
function retryNow(): void {
  if (!retry || document.visibilityState !== "visible") return;
  const { run } = retry;
  cancelRetry();
  backoff = 1000;
  run();
}

let watchingResume = false;

function watchResume(): void {
  if (watchingResume) return;
  watchingResume = true;
  document.addEventListener("visibilitychange", retryNow);
  window.addEventListener("pageshow", retryNow);
  window.addEventListener("online", retryNow);
}

/** Checks the registration of this browser and connects when it is registered. */
export async function start(): Promise<void> {
  watchResume();
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
    retryLater(() => void start(), 5000);
  }
}

/** Forgets everything after this browser's registration ended. */
export function becomeUnregistered(): void {
  cancelRetry();
  const ws = socket;
  socket = undefined;
  ws?.close();
  state = { auth: "unregistered", ...EMPTY };
  for (const l of listeners) l();
}

function connect(): void {
  if (socket) return; // already connecting or connected
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/client`);
  socket = ws;
  ws.onopen = () => {
    backoff = 1000;
    update({ connected: true });
    for (const l of connectedListeners) l();
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
    for (const [key, d] of Object.entries(state.dirs)) {
      const [machine, sessionId, path] = key.split("\u0000");
      if (d.loading && machine && sessionId && path !== undefined) send({ type: "dir.get", machine, sessionId, path });
    }
    for (const [key, f] of Object.entries(state.files)) {
      const [machine, sessionId, path] = key.split("\u0000");
      if (f.loading && machine && sessionId && path) send({ type: "file.get", machine, sessionId, path });
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
    retryLater(connect, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
}

/** Listeners of every message from the Gasho server (the plugins' calls listen to theirs), and of each connection. */
const messageListeners = new Set<(m: HubToClient) => void>();
const connectedListeners = new Set<() => void>();

export function onHubMessage(l: (m: HubToClient) => void): () => void {
  messageListeners.add(l);
  return () => messageListeners.delete(l);
}

/** Called whenever the connection to the Gasho server is (again) open: requests sent before may have been lost. */
export function onConnected(l: () => void): () => void {
  connectedListeners.add(l);
  return () => connectedListeners.delete(l);
}

/** Sends a message to the Gasho server; false when it is not connected. */
export function sendToHub(m: ClientToHub): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(m));
  return true;
}

const pluginResults = new Map<string, (r: CommandResult) => void>();

/** Enables or disables a plugin, chooses where its daemon part runs, or changes one of its settings. */
export function sendPluginCommand(cmd: PluginCommand, timeoutMs = 20_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const id = requestId();
    const timer = setTimeout(() => {
      pluginResults.delete(id);
      resolve({ ok: false, error: "応答がありませんでした。" });
    }, timeoutMs);
    pluginResults.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    if (!sendToHub({ ...cmd, requestId: id })) {
      clearTimeout(timer);
      pluginResults.delete(id);
      resolve({ ok: false, error: "Gasho サーバーにつながっていません。" });
    }
  });
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
  for (const l of messageListeners) l(m);
  switch (m.type) {
    case "plugins":
      update({ plugins: m.plugins });
      break;
    case "plugin.result":
      pluginResults.get(m.requestId)?.(m.result);
      pluginResults.delete(m.requestId);
      break;
    case "snapshot":
      update({ machines: m.machines, notifications: m.notifications, events: m.events.slice(-MAX_EVENTS), plugins: m.plugins ?? [] });
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
      const dirs = Object.fromEntries(Object.entries(state.dirs).filter(([k]) => !k.startsWith(prefix)));
      const files = Object.fromEntries(Object.entries(state.files).filter(([k]) => !k.startsWith(prefix)));
      update({ machines: state.machines.filter((x) => x.id !== m.id), transcripts, graphs, dirs, files });
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
    case "dir": {
      const key = fileKey(m.machine, m.sessionId, m.path);
      const cur = state.dirs[key];
      // On an error, keep showing what was read before, with the error.
      setDir(key, m.dir ? { loading: false, dir: m.dir, at: Date.now() } : { ...cur, loading: false, error: m.error ?? "読み込めませんでした。" });
      break;
    }
    case "file": {
      const key = fileKey(m.machine, m.sessionId, m.path);
      const cur = state.files[key];
      setFile(key, m.file ? { loading: false, file: m.file, at: Date.now() } : { ...cur, loading: false, error: m.error ?? "読み込めませんでした。" });
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

/** Reads a folder inside the session's folder again ("" for the folder itself). */
export function loadDir(machine: string, sessionId: string, path: string): void {
  const key = fileKey(machine, sessionId, path);
  const cur = state.dirs[key];
  if (cur?.loading) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    setDir(key, { ...cur, loading: false, error: "Gasho サーバーにつながっていません。" });
    return;
  }
  setDir(key, { ...cur, loading: true, error: undefined });
  send({ type: "dir.get", machine, sessionId, path });
}

/** Reads a file inside the session's folder again. */
export function loadFile(machine: string, sessionId: string, path: string): void {
  const key = fileKey(machine, sessionId, path);
  const cur = state.files[key];
  if (cur?.loading) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    setFile(key, { ...cur, loading: false, error: "Gasho サーバーにつながっていません。" });
    return;
  }
  setFile(key, { ...cur, loading: true, error: undefined });
  send({ type: "file.get", machine, sessionId, path });
}

/**
 * Writes a text file inside the session's folder (see the file.write command), or makes it with `create`. Once
 * written, the file is known as it was written, so that it can be saved again over this version.
 */
export async function saveFile(
  machine: string,
  sessionId: string,
  path: string,
  content: string,
  opts: { baseHash?: string; create?: boolean } = {},
): Promise<CommandResult> {
  // A little longer than the Gasho server waits for the working server.
  const r = await sendCommand(machine, { type: "file.write", sessionId, path, content, ...opts }, 20_000);
  if (r.ok && r.written) {
    const key = fileKey(machine, sessionId, path);
    const was = state.files[key]?.file;
    // Written just now, so it can be written.
    const file: FileContent = { ...was, path, ...r.written, text: content, writable: true };
    delete file.binary;
    delete file.tooLarge;
    delete file.image;
    setFile(key, { loading: false, file, at: Date.now() });
  }
  return r;
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

/** The state now, outside React (the plugins' loader follows it). */
export function getAppState(): State {
  return state;
}

export function subscribeAppState(l: () => void): () => void {
  return subscribe(l);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAppState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

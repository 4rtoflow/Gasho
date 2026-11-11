// Client state, kept in sync with gasho-hub over /ws/client.
import { useSyncExternalStore } from "react";
import type {
  ClientToHub,
  GashoNotification,
  HubToClient,
  MachineHookEvent,
  MachineInfo,
  TranscriptEntry,
} from "@gasho/protocol";

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** Index of entries[0] in the whole transcript. */
  start: number;
  total: number;
  loading: boolean;
  error?: string;
}

export interface State {
  connected: boolean;
  machines: MachineInfo[];
  notifications: GashoNotification[];
  events: MachineHookEvent[];
  transcripts: Record<string, TranscriptState>;
}

const PAGE_SIZE = 80;
const MAX_EVENTS = 300;
const MAX_NOTIFICATIONS = 200;

export const transcriptKey = (machine: string, sessionId: string): string => `${machine}\u0000${sessionId}`;

let state: State = { connected: false, machines: [], notifications: [], events: [], transcripts: {} };
const listeners = new Set<() => void>();

function update(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function setTranscript(key: string, t: TranscriptState): void {
  update({ transcripts: { ...state.transcripts, [key]: t } });
}

let socket: WebSocket | undefined;
let backoff = 1000;

export function connect(): void {
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
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(String(ev.data)) as HubToClient);
    } catch (e) {
      console.error("gasho: bad message", e);
    }
  };
  ws.onclose = () => {
    socket = undefined;
    update({ connected: false });
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };
}

function send(m: ClientToHub): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
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
      const machines = state.machines.filter((x) => x.name !== m.machine.name);
      machines.push(m.machine);
      machines.sort((a, b) => a.name.localeCompare(b.name));
      update({ machines });
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
        const tail = extra.filter((e) => e.ts && m.entries.at(-1)?.ts && e.ts > (m.entries.at(-1)?.ts ?? ""));
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
  }
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

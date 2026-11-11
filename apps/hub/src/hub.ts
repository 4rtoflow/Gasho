// Hub state and message handling, independent of the transport so it can be tested without sockets.
import { randomUUID } from "node:crypto";
import type {
  ClientToHub,
  DaemonToHub,
  HubToClient,
  HubToDaemon,
  MachineHookEvent,
  MachineInfo,
} from "@gasho/protocol";
import { notificationFor } from "./notify.ts";
import type { Store } from "./store.ts";

export interface Peer<T> {
  send(msg: T): void;
  close(code: number, reason: string): void;
}

export type DaemonPeer = Peer<HubToDaemon> & { machine?: string };
export type ClientPeer = Peer<HubToClient>;

interface PendingRequest {
  client: ClientPeer;
  machine: string;
  sessionId: string;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class Hub {
  private store: Store;
  private token: string;
  private machines = new Map<string, MachineInfo>();
  private daemons = new Map<string, DaemonPeer>();
  private clients = new Set<ClientPeer>();
  private pending = new Map<string, PendingRequest>();

  constructor(store: Store, token: string) {
    this.store = store;
    this.token = token;
    for (const m of store.loadMachines()) this.machines.set(m.name, m);
  }

  // ---- daemons ----

  onDaemonMessage(peer: DaemonPeer, msg: DaemonToHub): void {
    if (msg.type === "hello") {
      if (msg.token !== this.token) {
        peer.close(4001, "invalid token");
        return;
      }
      const previous = this.daemons.get(msg.machine);
      if (previous && previous !== peer) previous.close(4002, "replaced by a new connection");
      peer.machine = msg.machine;
      this.daemons.set(msg.machine, peer);
      const m = this.machine(msg.machine);
      m.connected = true;
      m.lastSeen = Date.now();
      m.daemonVersion = msg.daemonVersion;
      this.store.saveMachine(m);
      peer.send({ type: "welcome" });
      this.broadcast({ type: "machine", machine: m });
      return;
    }
    const name = peer.machine;
    if (!name) {
      peer.close(4001, "hello first");
      return;
    }
    const m = this.machine(name);
    m.lastSeen = Date.now();
    switch (msg.type) {
      case "sessions":
        m.sessions = msg.sessions;
        this.store.saveMachine(m);
        this.broadcast({ type: "machine", machine: m });
        break;
      case "transcript.append":
        this.broadcast({ type: "transcript.append", machine: name, sessionId: msg.sessionId, entries: msg.entries });
        break;
      case "transcript.page": {
        const req = this.pending.get(msg.requestId);
        if (!req) break;
        clearTimeout(req.timer);
        this.pending.delete(msg.requestId);
        const { type: _type, requestId: _requestId, ...page } = msg;
        req.client.send({ type: "transcript.page", machine: name, ...page });
        break;
      }
      case "hook": {
        const event: MachineHookEvent = { ...msg.event, machine: name };
        this.store.addEvent(event);
        this.broadcast({ type: "event", event });
        const session = m.sessions.find((s) => s.sessionId === event.sessionId);
        const n = notificationFor(name, event, session, randomUUID());
        if (n) {
          this.store.addNotification(n);
          this.broadcast({ type: "notification", notification: n });
        }
        break;
      }
    }
  }

  onDaemonClose(peer: DaemonPeer): void {
    const name = peer.machine;
    if (!name || this.daemons.get(name) !== peer) return;
    this.daemons.delete(name);
    const m = this.machine(name);
    m.connected = false;
    m.lastSeen = Date.now();
    this.store.saveMachine(m);
    this.broadcast({ type: "machine", machine: m });
    for (const [id, req] of this.pending) {
      if (req.machine !== name) continue;
      clearTimeout(req.timer);
      this.pending.delete(id);
      req.client.send({
        type: "transcript.page",
        machine: name,
        sessionId: req.sessionId,
        entries: [],
        start: 0,
        total: 0,
        error: "machine disconnected",
      });
    }
  }

  // ---- browsers ----

  onClientConnect(peer: ClientPeer): void {
    this.clients.add(peer);
    peer.send({
      type: "snapshot",
      machines: [...this.machines.values()],
      notifications: this.store.recentNotifications(),
      events: this.store.recentEvents(),
    });
  }

  onClientMessage(peer: ClientPeer, msg: ClientToHub): void {
    switch (msg.type) {
      case "transcript.get": {
        const daemon = this.daemons.get(msg.machine);
        if (!daemon) {
          peer.send({
            type: "transcript.page",
            machine: msg.machine,
            sessionId: msg.sessionId,
            entries: [],
            start: 0,
            total: 0,
            error: "machine is offline",
          });
          return;
        }
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          peer.send({
            type: "transcript.page",
            machine: msg.machine,
            sessionId: msg.sessionId,
            entries: [],
            start: 0,
            total: 0,
            error: "timed out",
          });
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(requestId, { client: peer, machine: msg.machine, sessionId: msg.sessionId, timer });
        const limit = Math.min(Math.max(1, msg.limit), 500);
        daemon.send({ type: "transcript.get", requestId, sessionId: msg.sessionId, before: msg.before, limit });
        break;
      }
      case "notification.read":
        this.store.markRead(msg.ids);
        this.broadcast({ type: "notification.read", ids: msg.ids });
        break;
    }
  }

  onClientClose(peer: ClientPeer): void {
    this.clients.delete(peer);
    for (const [id, req] of this.pending) {
      if (req.client !== peer) continue;
      clearTimeout(req.timer);
      this.pending.delete(id);
    }
  }

  // ---- helpers ----

  private machine(name: string): MachineInfo {
    let m = this.machines.get(name);
    if (!m) {
      m = { name, connected: false, lastSeen: Date.now(), sessions: [] };
      this.machines.set(name, m);
    }
    return m;
  }

  private broadcast(msg: HubToClient): void {
    for (const c of this.clients) c.send(msg);
  }
}

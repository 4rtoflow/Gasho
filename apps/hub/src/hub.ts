// Gasho server state and message handling, independent of the transport so it can be tested without sockets.
import { randomUUID } from "node:crypto";
import type {
  ClientToHub,
  DaemonToHub,
  DeviceInfo,
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

/** A gasho-daemon connection; `machineId` is set once its hello is accepted. */
export type DaemonPeer = Peer<HubToDaemon> & { machineId?: string };
/** A browser connection of a registered device. */
export type ClientPeer = Peer<HubToClient> & { deviceId: string };

/** WebSocket close codes. */
export const CLOSE_INVALID_CREDENTIALS = 4001;
export const CLOSE_REPLACED = 4002;
export const CLOSE_UNAUTHORIZED = 4401;

interface PendingRequest {
  client: ClientPeer;
  machine: string;
  sessionId: string;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class Hub {
  private store: Store;
  private machines = new Map<string, MachineInfo>();
  private daemons = new Map<string, DaemonPeer>();
  private clients = new Set<ClientPeer>();
  private pending = new Map<string, PendingRequest>();

  constructor(store: Store) {
    this.store = store;
    for (const m of store.loadMachines()) this.machines.set(m.id, m);
  }

  // ---- daemons ----

  onDaemonMessage(peer: DaemonPeer, msg: DaemonToHub): void {
    if (msg.type === "hello") {
      const device = this.store.verifyDevice(msg.machineId, msg.token, "machine");
      if (!device) {
        peer.close(CLOSE_INVALID_CREDENTIALS, "invalid credentials");
        return;
      }
      const previous = this.daemons.get(device.id);
      if (previous && previous !== peer) previous.close(CLOSE_REPLACED, "replaced by a new connection");
      peer.machineId = device.id;
      this.daemons.set(device.id, peer);
      const m = this.machine(device.id, device.name);
      m.name = device.name;
      m.connected = true;
      m.lastSeen = Date.now();
      m.daemonVersion = msg.daemonVersion;
      this.store.saveMachine(m);
      this.store.touchDevice(device.id);
      peer.send({ type: "welcome" });
      this.broadcast({ type: "machine", machine: m });
      return;
    }
    const id = peer.machineId;
    if (!id) {
      peer.close(CLOSE_INVALID_CREDENTIALS, "hello first");
      return;
    }
    const m = this.machines.get(id);
    if (!m) return;
    m.lastSeen = Date.now();
    switch (msg.type) {
      case "sessions":
        m.sessions = msg.sessions;
        this.store.saveMachine(m);
        this.broadcast({ type: "machine", machine: m });
        break;
      case "transcript.append":
        this.broadcast({ type: "transcript.append", machine: id, sessionId: msg.sessionId, entries: msg.entries });
        break;
      case "transcript.page": {
        const req = this.pending.get(msg.requestId);
        if (!req) break;
        clearTimeout(req.timer);
        this.pending.delete(msg.requestId);
        const { type: _type, requestId: _requestId, ...page } = msg;
        req.client.send({ type: "transcript.page", machine: id, ...page });
        break;
      }
      case "hook": {
        const event: MachineHookEvent = { ...msg.event, machine: id };
        this.store.addEvent(event);
        this.broadcast({ type: "event", event });
        const session = m.sessions.find((s) => s.sessionId === event.sessionId);
        const n = notificationFor(id, event, session, randomUUID());
        if (n) {
          this.store.addNotification(n);
          this.broadcast({ type: "notification", notification: n });
        }
        break;
      }
    }
  }

  onDaemonClose(peer: DaemonPeer): void {
    const id = peer.machineId;
    if (!id || this.daemons.get(id) !== peer) return;
    this.daemons.delete(id);
    const m = this.machines.get(id);
    if (m) {
      m.connected = false;
      m.lastSeen = Date.now();
      this.store.saveMachine(m);
      this.broadcast({ type: "machine", machine: m });
    }
    this.failPending((req) => req.machine === id, "machine disconnected");
  }

  // ---- browsers ----

  onClientConnect(peer: ClientPeer): void {
    this.clients.add(peer);
    this.store.touchDevice(peer.deviceId);
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
        const reply = { type: "transcript.page" as const, machine: msg.machine, sessionId: msg.sessionId, entries: [], start: 0, total: 0 };
        if (!daemon) {
          peer.send({ ...reply, error: "machine is offline" });
          return;
        }
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          if (this.pending.delete(requestId)) peer.send({ ...reply, error: "timed out" });
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

  // ---- devices ----

  listDevices(currentId?: string): DeviceInfo[] {
    return this.store.listDevices().map(({ revokedAt: _revoked, ...d }) => ({ ...d, current: d.id === currentId }));
  }

  renameDevice(id: string, name: string): boolean {
    if (!this.store.renameDevice(id, name)) return false;
    const m = this.machines.get(id);
    if (m) {
      m.name = name;
      this.broadcast({ type: "machine", machine: m });
    }
    return true;
  }

  revokeDevice(id: string): boolean {
    if (!this.store.revokeDevice(id)) return false;
    this.disconnectRevoked([id]);
    return true;
  }

  /** Closes connections of devices revoked elsewhere, e.g. with the command line tool. */
  checkRevocations(): void {
    const ids = [...this.daemons.keys(), ...[...this.clients].map((c) => c.deviceId)];
    const revoked = this.store.revokedSince([...new Set(ids)]);
    if (revoked.length > 0) this.disconnectRevoked(revoked);
  }

  private disconnectRevoked(ids: string[]): void {
    for (const id of ids) {
      const daemon = this.daemons.get(id);
      if (daemon) {
        this.daemons.delete(id);
        daemon.close(CLOSE_INVALID_CREDENTIALS, "registration revoked");
      }
      for (const c of [...this.clients]) {
        if (c.deviceId !== id) continue;
        this.clients.delete(c);
        c.close(CLOSE_UNAUTHORIZED, "registration revoked");
      }
      if (this.machines.delete(id)) {
        this.failPending((req) => req.machine === id, "machine was removed");
        this.broadcast({ type: "machine.removed", id });
      }
    }
  }

  // ---- helpers ----

  private machine(id: string, name: string): MachineInfo {
    let m = this.machines.get(id);
    if (!m) {
      m = { id, name, connected: false, lastSeen: Date.now(), sessions: [] };
      this.machines.set(id, m);
    }
    return m;
  }

  private failPending(match: (req: PendingRequest) => boolean, error: string): void {
    for (const [id, req] of this.pending) {
      if (!match(req)) continue;
      clearTimeout(req.timer);
      this.pending.delete(id);
      req.client.send({ type: "transcript.page", machine: req.machine, sessionId: req.sessionId, entries: [], start: 0, total: 0, error });
    }
  }

  private broadcast(msg: HubToClient): void {
    for (const c of this.clients) c.send(msg);
  }
}

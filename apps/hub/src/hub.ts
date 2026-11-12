// Gasho server state and message handling, independent of the transport so it can be tested without sockets.
import { randomUUID } from "node:crypto";
import type {
  ClientToHub,
  CommandResult,
  DaemonToHub,
  DeviceInfo,
  HubToClient,
  HubToDaemon,
  InputFeature,
  MachineHookEvent,
  MachineInfo,
  SessionCommand,
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

/** A browser's request that a working server answers: a transcript page or a branch graph. */
interface PendingRequest {
  kind: "transcript" | "graph";
  client: ClientPeer;
  machine: string;
  sessionId: string;
  /** graph: the repository inside the session's folder, if one was asked for. */
  repo?: string;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 45_000;
/**
 * An input may wait for Claude Code to switch the model, the effort level and ultracode before it is typed, each
 * step checked on the screen; the browser waits a little longer than this.
 */
const INPUT_TIMEOUT_MS = 150_000;
const MAX_INPUT = 20_000;
const MODELS = new Set(["default", "opus", "fable", "sonnet", "haiku"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FEATURES = new Set<InputFeature>(["model", "effort", "ultracode", "files"]);

/**
 * What a gasho-daemon that does not list its features (older than 0.6.0) can do with an input: 0.5 switches the model
 * and carries files; older ones only type the text.
 */
export function legacyFeatures(daemonVersion: string | undefined): InputFeature[] {
  const [major = 0, minor = 0] = (daemonVersion ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return major > 0 || minor >= 5 ? ["model", "files"] : [];
}
/** Files sent with one input: how many, and their size in all. */
export const MAX_FILES = 5;
export const MAX_FILES_BYTES = 10 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Size of the data a base64 string holds. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

interface PendingCommand {
  client: ClientPeer;
  clientRequestId: string;
  machine: string;
  timer: NodeJS.Timeout;
}

/** Checks a command from a browser; returns an error message or undefined. */
export function validateCommand(cmd: SessionCommand): string | undefined {
  switch (cmd.type) {
    case "session.launch":
      if (typeof cmd.cwd !== "string" || !cmd.cwd.startsWith("/") || cmd.cwd.length > 1024) return "フォルダーを絶対パスで指定してください。";
      if (cmd.name !== undefined && (typeof cmd.name !== "string" || cmd.name.length > 60)) return "名前は60文字までです。";
      return undefined;
    case "session.input": {
      const files = cmd.files ?? [];
      if (typeof cmd.text !== "string" || !Array.isArray(files)) return "入力が正しくありません。";
      if (!cmd.text.trim() && files.length === 0) return "入力が空です。";
      if (cmd.text.length > MAX_INPUT) return `入力が長すぎます（${MAX_INPUT} 文字まで）。`;
      if (cmd.model !== undefined && !MODELS.has(cmd.model)) return "モデルの指定が正しくありません。";
      if (cmd.effort !== undefined && !EFFORTS.has(cmd.effort)) return "Effort の指定が正しくありません。";
      if (cmd.ultracode !== undefined && typeof cmd.ultracode !== "boolean") return "Ultracode の指定が正しくありません。";
      // These change Claude Code's defaults for every new session; the chat box switches them for this session.
      if (/^\s*\/model(?=\s|$)/i.test(cmd.text)) {
        return "モデルは、入力欄のモデルの選択で切り替えてください。/model で切り替えると、これから始めるすべてのセッションの既定のモデルも変わります。";
      }
      if (/^\s*\/effort(?=\s|$)/i.test(cmd.text) && !/^\s*\/effort\s+ultracode\s+(on|off)\s*$/i.test(cmd.text)) {
        return "Effort は、入力欄の Effort のボタンで切り替えてください。/effort で切り替えると、これから始めるすべてのセッションの既定の Effort も変わります（/effort ultracode on と off は、このセッションだけなので送れます）。";
      }
      if (files.length > MAX_FILES) return `添付できるファイルは ${MAX_FILES} 個までです。`;
      let total = 0;
      for (const f of files) {
        if (typeof f?.name !== "string" || !f.name || f.name.length > 255) return "ファイル名が正しくありません。";
        if (typeof f.data !== "string" || f.data.length % 4 !== 0 || !BASE64_RE.test(f.data)) return "ファイルの中身が正しくありません。";
        total += base64Bytes(f.data);
      }
      if (total > MAX_FILES_BYTES) return `添付できるのは、合わせて ${MAX_FILES_BYTES / 1024 / 1024}MB までです。`;
      return undefined;
    }
    case "session.interrupt":
      return undefined;
    default:
      return "不明な命令です。";
  }
}

export class Hub {
  private store: Store;
  private machines = new Map<string, MachineInfo>();
  private daemons = new Map<string, DaemonPeer>();
  private clients = new Set<ClientPeer>();
  private pending = new Map<string, PendingRequest>();
  private commands = new Map<string, PendingCommand>();

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
      case "capabilities":
        m.canLaunch = msg.canLaunch;
        m.folders = msg.folders;
        m.models = Array.isArray(msg.models)
          ? msg.models
              .filter((o) => MODELS.has(o?.id) && typeof o.name === "string" && o.name.length > 0 && o.name.length <= 60)
              .map((o) => ({ id: o.id, name: o.name }))
          : undefined;
        m.modelsAt = typeof msg.modelsAt === "number" && Number.isFinite(msg.modelsAt) ? msg.modelsAt : undefined;
        m.features = Array.isArray(msg.features) ? [...new Set(msg.features.filter((f) => FEATURES.has(f)))] : undefined;
        this.broadcast({ type: "machine", machine: m });
        break;
      case "command.result": {
        const cmd = this.commands.get(msg.requestId);
        if (!cmd) break;
        clearTimeout(cmd.timer);
        this.commands.delete(msg.requestId);
        cmd.client.send({ type: "command.result", requestId: cmd.clientRequestId, machine: id, result: msg.result });
        break;
      }
      case "transcript.page": {
        const req = this.pending.get(msg.requestId);
        if (!req || req.kind !== "transcript") break;
        clearTimeout(req.timer);
        this.pending.delete(msg.requestId);
        const { type: _type, requestId: _requestId, ...page } = msg;
        req.client.send({ type: "transcript.page", machine: id, ...page });
        break;
      }
      case "git.graph": {
        const req = this.pending.get(msg.requestId);
        if (!req || req.kind !== "graph") break;
        clearTimeout(req.timer);
        this.pending.delete(msg.requestId);
        req.client.send({ type: "git.graph", machine: id, sessionId: msg.sessionId, repo: req.repo, graph: msg.graph, error: msg.error });
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
    this.failCommands((c) => c.machine === id, "working server との接続が切れました。");
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
        }, REQUEST_TIMEOUT_MS).unref();
        this.pending.set(requestId, { kind: "transcript", client: peer, machine: msg.machine, sessionId: msg.sessionId, timer });
        const limit = Math.min(Math.max(1, msg.limit), 500);
        daemon.send({ type: "transcript.get", requestId, sessionId: msg.sessionId, before: msg.before, limit });
        break;
      }
      case "git.graph.get": {
        const daemon = this.daemons.get(msg.machine);
        const repo = msg.repo;
        const reply = { type: "git.graph" as const, machine: msg.machine, sessionId: msg.sessionId, repo };
        if (repo !== undefined && (typeof repo !== "string" || repo.length === 0 || repo.length > 500)) {
          peer.send({ ...reply, error: "リポジトリの指定が正しくありません。" });
          return;
        }
        if (!daemon) {
          peer.send({ ...reply, error: "この working server はオフラインです。" });
          return;
        }
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          if (this.pending.delete(requestId)) peer.send({ ...reply, error: "working server から応答がありません。" });
        }, REQUEST_TIMEOUT_MS).unref();
        this.pending.set(requestId, { kind: "graph", client: peer, machine: msg.machine, sessionId: msg.sessionId, repo, timer });
        daemon.send({ type: "git.graph.get", requestId, sessionId: msg.sessionId, repo });
        break;
      }
      case "notification.read":
        this.store.markRead(msg.ids);
        this.broadcast({ type: "notification.read", ids: msg.ids });
        break;
      case "session.launch":
      case "session.input":
      case "session.interrupt": {
        const { requestId: clientRequestId, machine, ...cmd } = msg;
        this.relayCommand(peer, clientRequestId, machine, cmd);
        break;
      }
    }
  }

  private relayCommand(peer: ClientPeer, clientRequestId: string, machine: string, cmd: SessionCommand): void {
    const reply = (result: CommandResult) => peer.send({ type: "command.result", requestId: clientRequestId, machine, result });
    const invalid = validateCommand(cmd) ?? this.unsupported(machine, cmd);
    if (invalid) return reply({ ok: false, error: invalid });
    const daemon = this.daemons.get(machine);
    if (!daemon) return reply({ ok: false, error: "この working server はオフラインです。" });
    // Audit trail of what browsers asked working servers to do.
    const sessionId = "sessionId" in cmd ? cmd.sessionId : "";
    const summary =
      cmd.type === "session.input"
        ? [
            cmd.text.slice(0, 300),
            cmd.model && `[model: ${cmd.model}]`,
            cmd.effort && `[effort: ${cmd.effort}]`,
            cmd.ultracode !== undefined && `[ultracode: ${cmd.ultracode ? "on" : "off"}]`,
            ...(cmd.files ?? []).map((f) => `[file: ${f.name.slice(0, 100)}, ${Math.ceil(base64Bytes(f.data) / 1024)}KB]`),
          ]
            .filter(Boolean)
            .join(" ")
        : cmd.type === "session.launch"
          ? cmd.cwd
          : "";
    const event: MachineHookEvent = { machine, sessionId, event: `Gasho:${cmd.type}`, at: Date.now(), summary: `${summary} (by ${peer.deviceId})` };
    this.store.addEvent(event);

    const requestId = randomUUID();
    // Launching waits for Claude Code to start; an input may switch the model, effort and ultracode first.
    const timeout = cmd.type === "session.interrupt" ? REQUEST_TIMEOUT_MS : cmd.type === "session.input" ? INPUT_TIMEOUT_MS : LAUNCH_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (this.commands.delete(requestId)) reply({ ok: false, error: "working server から応答がありません。" });
    }, timeout);
    // The server's sockets keep the process running; a reply still awaited does not need to (tests end sooner).
    timer.unref();
    this.commands.set(requestId, { client: peer, clientRequestId, machine, timer });
    daemon.send({ requestId, ...cmd });
  }

  /** An input that asks for more than the working server's gasho-daemon can do: the error to show, or undefined. */
  private unsupported(machine: string, cmd: SessionCommand): string | undefined {
    if (cmd.type !== "session.input") return undefined;
    const m = this.machines.get(machine);
    const features = m?.features ?? legacyFeatures(m?.daemonVersion);
    const missing = [
      cmd.model !== undefined && !features.includes("model") && "モデル",
      cmd.effort !== undefined && !features.includes("effort") && "Effort",
      cmd.ultracode !== undefined && !features.includes("ultracode") && "Ultracode",
      (cmd.files?.length ?? 0) > 0 && !features.includes("files") && "ファイルの添付",
    ].filter(Boolean);
    if (missing.length === 0) return undefined;
    return `この working server の gasho-daemon は古いため、次のものを扱えません：${missing.join("、")}。gasho-daemon を更新してください。`;
  }

  onClientClose(peer: ClientPeer): void {
    this.clients.delete(peer);
    for (const [id, c] of this.commands) {
      if (c.client !== peer) continue;
      clearTimeout(c.timer);
      this.commands.delete(id);
    }
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
      if (req.kind === "graph") req.client.send({ type: "git.graph", machine: req.machine, sessionId: req.sessionId, repo: req.repo, error });
      else req.client.send({ type: "transcript.page", machine: req.machine, sessionId: req.sessionId, entries: [], start: 0, total: 0, error });
    }
  }

  private failCommands(match: (c: PendingCommand) => boolean, error: string): void {
    for (const [id, c] of this.commands) {
      if (!match(c)) continue;
      clearTimeout(c.timer);
      this.commands.delete(id);
      c.client.send({ type: "command.result", requestId: c.clientRequestId, machine: c.machine, result: { ok: false, error } });
    }
  }

  private broadcast(msg: HubToClient): void {
    for (const c of this.clients) c.send(msg);
  }
}

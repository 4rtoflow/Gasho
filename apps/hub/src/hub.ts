// Gasho server state and message handling, independent of the transport so it can be tested without sockets.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ClientToHub,
  CommandResult,
  DaemonToHub,
  DaemonUpdateInfo,
  DeviceInfo,
  HubToClient,
  HubToDaemon,
  InputFeature,
  MachineHookEvent,
  MachineInfo,
  PermissionRequestInfo,
  SessionCommand,
} from "@gasho/protocol";
import type { LatestCheck } from "./latest.ts";
import { notificationFor } from "./notify.ts";
import type { PluginCatalogSource } from "./catalog.ts";
import { PluginHub } from "./plugin-hub.ts";
import type { PluginRegistry } from "./plugins.ts";
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

/**
 * A browser's request that a working server answers: a transcript page, a branch graph, or a folder or file inside the
 * session's folder. (Plugins' requests are relayed by PluginHub.)
 */
interface PendingRequest {
  kind: "transcript" | "graph" | "dir" | "file";
  client: ClientPeer;
  machine: string;
  sessionId: string;
  /** graph: the repository inside the session's folder, if one was asked for. */
  repo?: string;
  /** dir, file: where, from the session's folder. */
  path?: string;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 45_000;
/**
 * An input may wait for Claude Code to switch the model, the effort level and ultracode before it is typed, each
 * step checked on the screen; the browser waits a little longer than this.
 */
const INPUT_TIMEOUT_MS = 150_000;
/**
 * A fork starts Claude Code like a launch (up to 30 s), waits for its prompt box (up to 15 s), then names the copy with
 * `/rename`, checked on the screen like an input, and waits for its transcript.
 */
const FORK_TIMEOUT_MS = 90_000;
/** A rename may type `/rename` at once, checked on the screen like an input. */
const RENAME_TIMEOUT_MS = 45_000;
/** Removing waits for Claude Code to end (it is stopped harder after a while). */
const REMOVE_TIMEOUT_MS = 30_000;
/** gasho-daemon stops a clone after 10 minutes, and gives it a few seconds to end. */
const CLONE_TIMEOUT_MS = 630_000;
/**
 * Stopping work in the background goes through Claude Code's list of it, one task at a time, each step checked on the
 * screen (a stop of Claude does that too while Claude only waits for its subagents).
 */
const STOP_TIMEOUT_MS = 60_000;
/** Claude Code's ids of background work (a shell's "b…", a subagent's agentId). */
const MAX_TASK_ID = 100;
const MAX_PATH = 1024;
const MAX_REPO = 300;
const MAX_INPUT = 20_000;
/** Names of sessions started from Gasho. */
const MAX_NAME = 60;
const MAX_SESSION_ID = 100;
const MODELS = new Set(["default", "opus", "fable", "sonnet", "haiku"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const FEATURES = new Set<InputFeature>(["model", "effort", "ultracode", "files"]);

/**
 * What a gasho-daemon that does not list its features (older than 0.6.0) can do with an input: 0.5 switches the model
 * and carries files; older ones only type the text.
 */
export function legacyFeatures(daemonVersion: string | undefined): InputFeature[] {
  return versionAtLeast(daemonVersion, 0, 5) ? ["model", "files"] : [];
}

/** Whether a gasho-daemon's version is at least `major.minor`. */
export function versionAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const [a = 0, b = 0] = (version ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return a > major || (a === major && b >= minor);
}

/** A version of gasho-daemon (daemon.update). */
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const UPDATE_STEPS = new Set(["install", "check", "wait", "restart"]);
/** Said when a gasho-daemon does not say whether Gasho can update it (one from before updates from Gasho). */
const UPDATE_TOO_OLD =
  "この working server の gasho-daemon は古いため、Gasho からは更新できません。working server で npx @4rtoflow/gasho-daemon@latest service install を実行してください。";

/** What a gasho-daemon says about updating it, kept to what is expected (it is shown to browsers). */
export function updateInfoOf(u: unknown): DaemonUpdateInfo | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
  const version = (v: unknown) => (typeof v === "string" && VERSION_RE.test(v) ? v : undefined);
  const at = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const p = (x.progress ?? {}) as Record<string, unknown>;
  const f = (x.failed ?? {}) as Record<string, unknown>;
  const pv = version(p.version);
  const pat = at(p.at);
  const fv = version(f.version);
  const fe = text(f.error, 2000);
  const fat = at(f.at);
  const installed = Array.isArray(x.installed) ? (x.installed.filter((v) => version(v) !== undefined).slice(0, 50) as string[]) : [];
  const step = typeof p.step === "string" && UPDATE_STEPS.has(p.step) ? (p.step as NonNullable<DaemonUpdateInfo["progress"]>["step"]) : undefined;
  return {
    canUpdate: x.canUpdate === true,
    reason: text(x.reason, 500),
    command: text(x.command, 300),
    installed: installed.length > 0 ? installed : undefined,
    previous: version(x.previous),
    progress: pv && step && pat !== undefined ? { version: pv, step, at: pat } : undefined,
    failed: fv && fe && fat !== undefined ? { version: fv, error: fe, at: fat } : undefined,
  };
}

/** gasho-daemon 0.9.0 renames, forks and removes sessions. */
const SESSION_ACTIONS_SINCE: [number, number] = [0, 9];
/** gasho-daemon 0.10.0 makes folders, clones repositories, and answers Claude Code's question whether to trust a folder. */
const FOLDER_ACTIONS_SINCE: [number, number] = [0, 10];
/** gasho-daemon 0.11.0 lists, reads and writes the files of a session's folder. */
const FILES_SINCE: [number, number] = [0, 11];
const FILES_TOO_OLD = "この working server の gasho-daemon は古いため、ファイルを扱えません。gasho-daemon を 0.11.0 以上に更新してください。";
/** A path inside a session's folder, and the text written to a file at most (gasho-daemon checks both again). */
const MAX_FILE_PATH = 4096;
export const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * A path inside a session's folder ("" for the folder itself, "src/app.ts"): an error message, or undefined. Never
 * one that leaves the folder; gasho-daemon checks it again, links included.
 */
function filePathError(p: unknown, file: boolean): string | undefined {
  if (typeof p !== "string" || p.length > MAX_FILE_PATH || p.includes("\0")) return "パスの指定が正しくありません。";
  if (p === "") return file ? "ファイルを指定してください。" : undefined;
  if (p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return "セッションのフォルダーの中のパスを指定してください。";
  return undefined;
}

/** A session's name: an error message, or undefined when it is fine (or omitted where `required` is false). */
function nameError(name: unknown, required: boolean): string | undefined {
  if (name === undefined && !required) return undefined;
  if (typeof name !== "string" || !name.trim()) return "名前を入れてください。";
  if (name.trim().length > MAX_NAME) return `名前は${MAX_NAME}文字までです。`;
  // One line: Claude Code's /rename takes the rest of the line.
  if (/\p{Cc}/u.test(name)) return "名前に改行や制御文字は使えません。";
  return undefined;
}

/** An absolute path on a working server: an error message, or undefined. */
function folderError(dir: unknown): string | undefined {
  if (typeof dir !== "string" || !dir.startsWith("/") || dir.length > MAX_PATH || /\p{Cc}/u.test(dir)) return "フォルダーを絶対パスで指定してください。";
  return undefined;
}

/** The name of a folder to make (one name, not a path): an error message, or undefined. gasho-daemon checks it again. */
function folderNameError(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return "フォルダーの名前を入れてください。";
  if (name !== name.trim()) return "フォルダーの名前の前後に空白は使えません。";
  if (name === "." || name === ".." || name.includes("/") || name.startsWith("-") || /\p{Cc}/u.test(name)) return "このフォルダーの名前は使えません。";
  if (Buffer.byteLength(name) > 255) return "フォルダーの名前が長すぎます。";
  return undefined;
}

/** Answers to Claude's questions (AskUserQuestion asks up to 4, with up to 4 options each; with room to spare). */
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;
const MAX_ANSWER = 4000;

/** The answers to an AskUserQuestion: an error message, or undefined. gasho-daemon checks them against the questions. */
function answersError(answers: unknown): string | undefined {
  const wrong = "質問への答えが正しくありません。";
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_QUESTIONS) return wrong;
  for (const a of answers as unknown[]) {
    const { picked, text } = (a ?? {}) as { picked?: unknown; text?: unknown };
    if (!Array.isArray(picked) || picked.length > MAX_OPTIONS) return wrong;
    if (!picked.every((k) => Number.isInteger(k) && (k as number) >= 0 && (k as number) < MAX_OPTIONS)) return wrong;
    if (text !== undefined && typeof text !== "string") return wrong;
    if (typeof text === "string" && text.length > MAX_ANSWER) return `答えは${MAX_ANSWER}文字までです。`;
  }
  return undefined;
}

/**
 * How an answer to a permission request is recorded (`r`: the request, when it is known): "[allow] Bash npm test" (the
 * decision, the tool, what it asked for), "[answer] Color → Blue / Fruits → Apple, Cherry" (Claude's questions),
 * "[approve] Plan title" (a plan approved), "[revise] what to change" (a plan sent back), and a denial's message after
 * " — ".
 */
export function answerSummary(cmd: Extract<SessionCommand, { type: "permission.answer" }>, r: PermissionRequestInfo | undefined): string {
  const message = cmd.message?.trim();
  if (cmd.decision !== "deny" && r?.questions && cmd.answers) {
    const answers = r.questions.map((q, i) => {
      const a = cmd.answers?.[i];
      const chosen = [...(a?.picked ?? []).map((k) => q.options[k]?.label ?? "?"), ...(a?.text?.trim() ? [a.text.trim()] : [])];
      return `${q.header ?? q.question} → ${chosen.join(", ")}`;
    });
    return `[answer] ${answers.join(" / ")}`.slice(0, 300);
  }
  if (r?.plan !== undefined) {
    if (cmd.decision !== "deny") return `[approve] ${r.summary ?? ""}`.trim().slice(0, 300);
    if (message) return `[revise] ${message}`.slice(0, 300);
  }
  const what = r ? `${r.toolName} ${r.summary ?? ""}`.trim() : "";
  return `[${cmd.decision}] ${what}${message ? ` — ${message}` : ""}`.trim().slice(0, 300);
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
  if ("sessionId" in cmd && (typeof cmd.sessionId !== "string" || !cmd.sessionId || cmd.sessionId.length > MAX_SESSION_ID)) {
    return "セッションの指定が正しくありません。";
  }
  switch (cmd.type) {
    case "session.launch":
      if (typeof cmd.cwd !== "string" || !cmd.cwd.startsWith("/") || cmd.cwd.length > 1024) return "フォルダーを絶対パスで指定してください。";
      if (cmd.name !== undefined && (typeof cmd.name !== "string" || cmd.name.length > 60)) return "名前は60文字までです。";
      if (cmd.trust !== undefined && typeof cmd.trust !== "boolean") return "信頼の指定が正しくありません。";
      return undefined;
    case "folder.create":
      return folderError(cmd.parent) ?? folderNameError(cmd.name);
    case "repo.clone":
      if (typeof cmd.repo !== "string" || !cmd.repo.trim()) return "clone するリポジトリを入れてください。";
      // gh would read a leading "-" as an option.
      if (cmd.repo.length > MAX_REPO || /\s|\p{Cc}/u.test(cmd.repo) || cmd.repo.startsWith("-")) return "リポジトリの指定が正しくありません。";
      return folderError(cmd.parent) ?? (cmd.name === undefined ? undefined : folderNameError(cmd.name));
    case "session.input": {
      const files = cmd.files ?? [];
      if (typeof cmd.text !== "string" || !Array.isArray(files)) return "入力が正しくありません。";
      if (!cmd.text.trim() && files.length === 0) return "入力が空です。";
      if (cmd.text.length > MAX_INPUT) return `入力が長すぎます（${MAX_INPUT} 文字まで）。`;
      if (cmd.model !== undefined && !MODELS.has(cmd.model)) return "モデルの指定が正しくありません。";
      if (cmd.effort !== undefined && !EFFORTS.has(cmd.effort)) return "Effort の指定が正しくありません。";
      if (cmd.ultracode !== undefined && typeof cmd.ultracode !== "boolean") return "Ultracode の指定が正しくありません。";
      if (cmd.via !== undefined && (typeof cmd.via !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(cmd.via))) return "送ったプラグインの指定が正しくありません。";
      // These change Claude Code's defaults for every new session; the chat box switches them for this session.
      if (/^\s*\/model(?=\s|$)/i.test(cmd.text)) {
        return "モデルは、入力欄のモデルの選択で切り替えてください。/model で切り替えると、これから始めるすべてのセッションの既定のモデルも変わります。";
      }
      if (/^\s*\/effort(?=\s|$)/i.test(cmd.text) && !/^\s*\/effort\s+ultracode\s+(on|off)\s*$/i.test(cmd.text)) {
        return "Effort は、入力欄の Effort のボタンで切り替えてください。/effort で切り替えると、これから始めるすべてのセッションの既定の Effort も変わります（/effort ultracode on と off は、このセッションだけなので送れます）。";
      }
      // Claude Code's shell mode: what follows the "!" is run as a shell command. Files would be mentioned on lines of
      // their own after it (@path), which the shell would run too.
      if (/^\s*!/.test(cmd.text)) {
        if (!cmd.text.trimStart().slice(1).trim()) return "「!」のあとに、実行するコマンドを入れてください。";
        if (files.length > 0) return "シェルのコマンド（「!」で始まる入力）には、ファイルを添付できません。";
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
    case "session.remove":
    case "session.resume":
      return undefined;
    case "session.stopTask":
      if (cmd.taskId !== undefined && (typeof cmd.taskId !== "string" || !cmd.taskId || cmd.taskId.length > MAX_TASK_ID)) return "タスクの指定が正しくありません。";
      return undefined;
    case "session.history":
      if (typeof cmd.cwd !== "string" || !cmd.cwd.startsWith("/") || cmd.cwd.length > 1024) return "フォルダーを絶対パスで指定してください。";
      if (cmd.subfolders !== undefined && typeof cmd.subfolders !== "boolean") return "中のフォルダーの指定が正しくありません。";
      return undefined;
    case "session.rename":
      return nameError(cmd.name, true);
    case "session.fork":
      return nameError(cmd.name, false);
    case "permission.answer":
      if (typeof cmd.permissionId !== "string" || !cmd.permissionId || cmd.permissionId.length > 100) return "確認の指定が正しくありません。";
      if (!["allow", "always", "deny"].includes(cmd.decision)) return "答えの指定が正しくありません。";
      if (cmd.answers !== undefined) {
        const wrong = answersError(cmd.answers);
        if (wrong) return wrong;
      }
      if (cmd.mode !== undefined && cmd.mode !== "auto" && cmd.mode !== "default") return "計画を承認したあとの進め方の指定が正しくありません。";
      if (cmd.message !== undefined && (typeof cmd.message !== "string" || cmd.message.length > MAX_INPUT)) return `伝えることは${MAX_INPUT}文字までです。`;
      return undefined;
    case "daemon.update":
      return typeof cmd.version === "string" && VERSION_RE.test(cmd.version) ? undefined : "版の指定が正しくありません。";
    case "file.write": {
      const wrong = filePathError(cmd.path, true);
      if (wrong) return wrong;
      if (typeof cmd.content !== "string") return "ファイルの中身が正しくありません。";
      if (Buffer.byteLength(cmd.content) > MAX_WRITE_BYTES) return `保存できるのは ${MAX_WRITE_BYTES / 1024 / 1024}MB までです。`;
      if (cmd.baseHash !== undefined && (typeof cmd.baseHash !== "string" || !/^[0-9a-f]{64}$/.test(cmd.baseHash))) return "ファイルの版の指定が正しくありません。";
      if (cmd.create !== undefined && typeof cmd.create !== "boolean") return "作成の指定が正しくありません。";
      return undefined;
    }
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
  /** The plugins (docs/plugins.md); absent when the Gasho server was started without a plugins folder (tests). */
  private plugins: PluginHub | undefined;
  /** The latest published versions; absent when they are not looked up. */
  private latest: LatestCheck | undefined;

  constructor(store: Store, opts: { plugins?: PluginRegistry; catalog?: PluginCatalogSource; latest?: LatestCheck } = {}) {
    this.store = store;
    this.latest = opts.latest;
    opts.latest?.subscribe((latest) => this.broadcast({ type: "latest", latest }));
    for (const m of store.loadMachines()) this.machines.set(m.id, m);
    if (opts.plugins) {
      this.plugins = new PluginHub({
        store,
        registry: opts.plugins,
        machines: () => this.machines,
        daemon: (machine) => this.daemons.get(machine),
        daemons: () => this.daemons.entries(),
        broadcast: (m) => this.broadcast(m),
        audit: (event) => {
          this.store.addEvent(event);
          this.broadcast({ type: "event", event });
        },
        ...(opts.catalog ? { catalog: opts.catalog } : {}),
      });
    }
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
      // Said again by its capabilities; an update that ended with the restart is over.
      m.update = undefined;
      this.store.saveMachine(m);
      this.store.touchDevice(device.id);
      peer.send({ type: "welcome" });
      this.broadcast({ type: "machine", machine: m });
      this.plugins?.onDaemonReady(device.id, peer);
      this.plugins?.toClients();
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
        m.canResume = msg.canResume === true || undefined;
        m.update = updateInfoOf(msg.update);
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
      case "dir":
      case "file": {
        const req = this.pending.get(msg.requestId);
        if (!req || req.kind !== msg.type || req.path === undefined) break;
        clearTimeout(req.timer);
        this.pending.delete(msg.requestId);
        // The path asked for goes back, whatever the answer says.
        const where = { machine: id, sessionId: req.sessionId, path: req.path };
        if (msg.type === "dir") req.client.send({ type: "dir", ...where, dir: msg.dir, error: msg.error });
        else req.client.send({ type: "file", ...where, file: msg.file, error: msg.error });
        break;
      }
      case "plugin.status":
      case "plugin.code.get":
      case "plugin.response":
      case "plugin.event":
        this.plugins?.onDaemonMessage(id, peer, msg);
        break;
      case "hook": {
        const event: MachineHookEvent = { ...msg.event, machine: id };
        this.store.addEvent(event);
        this.broadcast({ type: "event", event });
        const session = m.sessions.find((s) => s.sessionId === event.sessionId);
        // Gasho shows only the sessions it started; one known to be started elsewhere gets no notification.
        if (session && !session.managed) break;
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
    this.plugins?.onDaemonClose(id);
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
      ...(this.plugins ? { plugins: this.plugins.infos(), pluginEvents: this.plugins.retainedEvents() } : {}),
      ...(this.plugins?.catalog() ? { catalog: this.plugins.catalog() } : {}),
      ...(this.latest ? { latest: this.latest.latest() } : {}),
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
      case "dir.get":
      case "file.get": {
        const kind = msg.type === "dir.get" ? "dir" : "file";
        // Not answered at all when the path is not a string: there is nothing to answer for.
        if (typeof msg.path !== "string") return;
        const where = { machine: msg.machine, sessionId: msg.sessionId, path: msg.path };
        const fail = (error: string) => peer.send(kind === "dir" ? { type: "dir", ...where, error } : { type: "file", ...where, error });
        const wrong = filePathError(msg.path, kind === "file");
        if (wrong) return fail(wrong);
        const daemon = this.daemons.get(msg.machine);
        if (!daemon) return fail("この working server はオフラインです。");
        if (!versionAtLeast(this.machines.get(msg.machine)?.daemonVersion, ...FILES_SINCE)) return fail(FILES_TOO_OLD);
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          if (this.pending.delete(requestId)) fail("working server から応答がありません。");
        }, REQUEST_TIMEOUT_MS).unref();
        this.pending.set(requestId, { kind, client: peer, machine: msg.machine, sessionId: msg.sessionId, path: msg.path, timer });
        daemon.send(kind === "dir" ? { type: "dir.get", requestId, sessionId: msg.sessionId, path: msg.path } : { type: "file.get", requestId, sessionId: msg.sessionId, path: msg.path });
        break;
      }
      case "notification.read":
        this.store.markRead(msg.ids);
        this.broadcast({ type: "notification.read", ids: msg.ids });
        break;
      case "latest.check":
        if (this.latest) void this.latest.check(true);
        break;
      case "plugin.catalog.get":
        this.plugins?.onClientMessage(peer, msg);
        break;
      case "plugin.request":
      case "plugin.enable":
      case "plugin.machines":
      case "plugin.setting":
      case "plugin.install":
      case "plugin.update":
      case "plugin.remove":
        if (this.plugins) this.plugins.onClientMessage(peer, msg);
        else if (msg.type === "plugin.request") peer.send({ type: "plugin.response", requestId: msg.requestId, error: "この Gasho サーバーではプラグインを使えません。" });
        else peer.send({ type: "plugin.result", requestId: msg.requestId, result: { ok: false, error: "この Gasho サーバーではプラグインを使えません。" } });
        break;
      case "session.launch":
      case "session.input":
      case "session.interrupt":
      case "session.stopTask":
      case "session.rename":
      case "session.fork":
      case "session.remove":
      case "session.history":
      case "session.resume":
      case "permission.answer":
      case "folder.create":
      case "repo.clone":
      case "file.write":
      case "daemon.update": {
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
    // Audit trail of what browsers asked working servers to do (a listing changes nothing).
    if (cmd.type !== "session.history") {
      const sessionId = "sessionId" in cmd ? cmd.sessionId : "";
      const summary = this.summaryOf(machine, cmd);
      const event: MachineHookEvent = { machine, sessionId, event: `Gasho:${cmd.type}`, at: Date.now(), summary: `${summary} (by ${peer.deviceId})` };
      this.store.addEvent(event);
      // Browsers show the latest operations on the home screen.
      this.broadcast({ type: "event", event });
    }

    const requestId = randomUUID();
    // Launching, forking and resuming wait for Claude Code to start; an input may switch the model, effort and ultracode first;
    // removing waits for Claude Code to end; a clone takes as long as the repository needs.
    const timeout = {
      "session.launch": LAUNCH_TIMEOUT_MS,
      "session.input": INPUT_TIMEOUT_MS,
      "session.interrupt": STOP_TIMEOUT_MS,
      "session.stopTask": STOP_TIMEOUT_MS,
      "session.rename": RENAME_TIMEOUT_MS,
      "session.fork": FORK_TIMEOUT_MS,
      "session.remove": REMOVE_TIMEOUT_MS,
      "session.history": REQUEST_TIMEOUT_MS,
      "session.resume": LAUNCH_TIMEOUT_MS,
      "permission.answer": REQUEST_TIMEOUT_MS,
      "folder.create": REQUEST_TIMEOUT_MS,
      "repo.clone": CLONE_TIMEOUT_MS,
      "file.write": REQUEST_TIMEOUT_MS,
      // Answered as soon as the update has begun; its steps follow with the capabilities.
      "daemon.update": REQUEST_TIMEOUT_MS,
    }[cmd.type];
    const timer = setTimeout(() => {
      if (this.commands.delete(requestId)) reply({ ok: false, error: "working server から応答がありません。" });
    }, timeout);
    // The server's sockets keep the process running; a reply still awaited does not need to (tests end sooner).
    timer.unref();
    this.commands.set(requestId, { client: peer, clientRequestId, machine, timer });
    daemon.send({ requestId, ...cmd });
  }

  /**
   * The audit log's words for a command: an input's text (with what it switches and the names and sizes of its files,
   * never their contents), the folder of a launch (and whether Claude Code was told to trust it), a session's name (the
   * new one for a rename, the copy's for a fork, the removed session's for a removal), the folder made, the
   * repository cloned and where to, or the file written (its path from the session's folder and its size, never what
   * was written; "[new]" when it was made).
   */
  private summaryOf(machine: string, cmd: SessionCommand): string {
    switch (cmd.type) {
      case "file.write":
        return `${cmd.path.slice(0, 300)}${cmd.create ? " [new]" : ""} [${Math.ceil(Buffer.byteLength(cmd.content) / 1024)}KB]`;
      case "session.input":
        return [
          cmd.text.slice(0, 300),
          cmd.model && `[model: ${cmd.model}]`,
          cmd.effort && `[effort: ${cmd.effort}]`,
          cmd.ultracode !== undefined && `[ultracode: ${cmd.ultracode ? "on" : "off"}]`,
          ...(cmd.files ?? []).map((f) => `[file: ${f.name.slice(0, 100)}, ${Math.ceil(base64Bytes(f.data) / 1024)}KB]`),
          cmd.via && `[via: ${cmd.via}]`,
        ]
          .filter(Boolean)
          .join(" ");
      case "session.launch":
        return cmd.trust ? `${cmd.cwd} [trust]` : cmd.cwd;
      case "folder.create":
        return path.posix.join(cmd.parent, cmd.name);
      case "repo.clone":
        return `${cmd.repo} → ${cmd.name ? path.posix.join(cmd.parent, cmd.name) : cmd.parent}`;
      case "session.rename":
        return cmd.name.trim();
      case "session.fork":
        return cmd.name?.trim() ?? "";
      case "session.remove": {
        // Once removed, the session is gone from the list: the record keeps its name.
        const s = this.machines.get(machine)?.sessions.find((x) => x.sessionId === cmd.sessionId);
        return s?.name ?? s?.title ?? "";
      }
      case "permission.answer":
        // What was asked, as the request said: it is gone once answered.
        return answerSummary(cmd, this.request(machine, cmd.sessionId, cmd.permissionId));
      case "session.resume":
        return cmd.sessionId;
      case "session.stopTask": {
        // What was stopped, as the session showed it: it is gone once stopped.
        if (cmd.taskId === undefined) return "[all]";
        const task = this.machines.get(machine)?.sessions.find((x) => x.sessionId === cmd.sessionId)?.background?.find((x) => x.id === cmd.taskId);
        return task ? `${task.title.slice(0, 300)} [${task.kind}]` : cmd.taskId;
      }
      case "daemon.update":
        // From which version to which.
        return `${this.machines.get(machine)?.daemonVersion ?? "?"} → ${cmd.version}`;
      case "session.interrupt":
      case "session.history":
        return "";
    }
  }

  /** One of a session's permission requests, as its working server last sent them. */
  private request(machine: string, sessionId: string, id: string): PermissionRequestInfo | undefined {
    return this.machines
      .get(machine)
      ?.sessions.find((x) => x.sessionId === sessionId)
      ?.permissionRequests?.find((x) => x.id === id);
  }

  /** A command that asks for more than the working server's gasho-daemon can do: the error to show, or undefined. */
  private unsupported(machine: string, cmd: SessionCommand): string | undefined {
    const m = this.machines.get(machine);
    if (cmd.type === "daemon.update") return m?.update?.canUpdate ? undefined : (m?.update?.reason ?? UPDATE_TOO_OLD);
    if (cmd.type === "file.write") return !m || versionAtLeast(m.daemonVersion, ...FILES_SINCE) ? undefined : FILES_TOO_OLD;
    if (cmd.type === "session.history" || cmd.type === "session.resume") {
      return !m || m.canResume ? undefined : "この working server の gasho-daemon は古いため、過去の会話を一覧にも開き直しもできません。gasho-daemon を更新してください。";
    }
    if (cmd.type === "permission.answer" && cmd.decision !== "deny") {
      // Claude Code takes neither a question nor a plan with "allow" alone: its dialog would stay open, and the hook
      // that Gasho answers through would be spent.
      const r = this.request(machine, cmd.sessionId, cmd.permissionId);
      if (r?.toolName === "AskUserQuestion") {
        // A gasho-daemon that sends no questions would pass "allow" on without the answers.
        if (!r.questions) return "この working server の gasho-daemon は古いため、Gasho からは質問に答えられません。端末か公式アプリで答えてください。";
        if (!cmd.answers?.length) return "質問には、選んだ答えを添えて答えてください。画面を読み込み直すと、答えを選べます。";
      }
      if (r?.toolName === "ExitPlanMode" && r.plan === undefined) {
        return "この working server の gasho-daemon は古いため、Gasho からは計画を承認できません。端末か公式アプリで答えてください。";
      }
      return undefined;
    }
    if (cmd.type === "session.rename" || cmd.type === "session.fork" || cmd.type === "session.remove") {
      if (!m || versionAtLeast(m.daemonVersion, ...SESSION_ACTIONS_SINCE)) return undefined;
      return "この working server の gasho-daemon は古いため、セッションの名前の変更、フォーク、削除を扱えません。gasho-daemon を更新してください。";
    }
    if (cmd.type === "folder.create" || cmd.type === "repo.clone" || (cmd.type === "session.launch" && cmd.trust)) {
      if (!m || versionAtLeast(m.daemonVersion, ...FOLDER_ACTIONS_SINCE)) return undefined;
      return cmd.type === "session.launch"
        ? "この working server の gasho-daemon は古いため、Gasho からフォルダーを信頼できません。gasho-daemon を更新してください。"
        : "この working server の gasho-daemon は古いため、フォルダーの作成と clone を扱えません。gasho-daemon を更新してください。";
    }
    if (cmd.type !== "session.input") return undefined;
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
    this.plugins?.onClientClose(peer);
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
        this.plugins?.onDaemonClose(id);
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
      else if ((req.kind === "dir" || req.kind === "file") && req.path !== undefined) {
        req.client.send({ type: req.kind, machine: req.machine, sessionId: req.sessionId, path: req.path, error });
      } else req.client.send({ type: "transcript.page", machine: req.machine, sessionId: req.sessionId, entries: [], start: 0, total: 0, error });
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

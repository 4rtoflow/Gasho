// The Gasho server's part in plugins (docs/plugins.md): it tells browsers which plugins are installed and how they
// stand, tells each gasho-daemon which daemon parts to run (and hands it their code), relays the calls of web parts to
// daemon parts, and keeps which plugins are enabled, where their daemon parts run, and their settings. The plugins'
// files come from PluginRegistry (plugins.ts); this never runs a plugin's code. It also adds, updates and removes
// plugins for browsers, from the catalog of GashoPlugins (catalog.ts). The events of daemon parts go on to every
// browser; the Gasho server keeps the last of each topic that asked for it (retain) for browsers that connect later.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ClientToHub,
  CommandResult,
  DaemonPluginEntry,
  DaemonPluginStatus,
  DaemonToHub,
  HubToClient,
  HubToDaemon,
  MachineHookEvent,
  MachineInfo,
  PluginCatalog,
  PluginCommand,
  PluginDaemonState,
  PluginEvent,
  PluginInfo,
  PluginMachines,
  PluginManifest,
} from "@gasho/protocol";
import { CATALOG_MAX_AGE_MS, installRelease, type PluginCatalogSource } from "./catalog.ts";
import {
  apiProblem,
  compareVersions,
  DEFAULT_TIMEOUT_SECONDS,
  ID_RE,
  PLUGIN_API,
  PLUGIN_API_MAJOR,
  removePluginFolder,
  settingProblem,
  settingValue,
  type PluginEntry,
  type PluginRegistry,
} from "./plugins.ts";
import type { Store } from "./store.ts";

/** The arguments of a call, at most (as JSON). */
export const MAX_PARAMS_BYTES = 64 * 1024;
/** A daemon part's code that can be handed over the daemon's WebSocket (16 MB) with room to spare. */
const MAX_CODE_BYTES = 15 * 1024 * 1024;
/** The Gasho server waits this much longer than the daemon part may take, so that gasho-daemon's own answer arrives. */
const RELAY_MARGIN_MS = 3000;
const MAX_MACHINES = 100;
/** An event's topic (characters) and data (as JSON, in bytes), at most. */
const MAX_TOPIC = 100;
const MAX_EVENT_BYTES = 256 * 1024;
/** Kept events (retain) of a plugin on one working server, at most: the oldest go first. */
const MAX_RETAINED = 32;

const OLD_DAEMON = "この working server の gasho-daemon は古いため、プラグインを使えません。gasho-daemon を更新してください。";

interface Peer<T> {
  send(msg: T): void;
}
type ClientPeer = Peer<HubToClient> & { deviceId: string };

interface PendingCall {
  client: ClientPeer;
  clientRequestId: string;
  machine: string;
  timer: NodeJS.Timeout;
}

export interface PluginHubDeps {
  store: Store;
  registry: PluginRegistry;
  machines: () => Map<string, MachineInfo>;
  daemon: (machine: string) => Peer<HubToDaemon> | undefined;
  daemons: () => Iterable<[string, Peer<HubToDaemon>]>;
  broadcast: (m: HubToClient) => void;
  /** Records an operation (operations log) and shows it to browsers. */
  audit: (e: MachineHookEvent) => void;
  /** The catalog of GashoPlugins, which plugins are added and updated from (absent in tests that do not need it). */
  catalog?: PluginCatalogSource;
}

type PluginRequest = Extract<ClientToHub, { type: "plugin.request" }>;
type CatalogGet = Extract<ClientToHub, { type: "plugin.catalog.get" }>;
type ManageCommand = Extract<PluginCommand, { type: "plugin.install" | "plugin.update" | "plugin.remove" }>;
type PluginStatusMessage = Extract<DaemonToHub, { type: "plugin.status" }>;
type PluginEventMessage = Extract<DaemonToHub, { type: "plugin.event" }>;

/** Whether a plugin's daemon part is meant to run on a working server. */
export function chosen(machines: PluginMachines, machine: string): boolean {
  return machines === "all" || machines.includes(machine);
}

/** Where to run a plugin's daemon part, as a browser asked: undefined when that is not right. */
function machinesOf(m: unknown): PluginMachines | undefined {
  if (m === "all") return "all";
  const ok = Array.isArray(m) && m.length <= MAX_MACHINES && m.every((x) => typeof x === "string" && x.length > 0 && x.length <= 100);
  return ok ? [...new Set(m as string[])] : undefined;
}

export class PluginHub {
  private deps: PluginHubDeps;
  /** What each connected gasho-daemon said about the plugins it runs (only those that know plugins say anything). */
  private status = new Map<string, { api: string; plugins: Map<string, DaemonPluginStatus> }>();
  private calls = new Map<string, PendingCall>();
  private lastInfos = "";
  /** Plugins being added, updated or removed (one thing at a time for each). */
  private busy = new Set<string>();
  /** The kept events (retain), by "<plugin>\0<machine>\0<topic>", with the version of the plugin that sent each. */
  private retained = new Map<string, { event: PluginEvent; hash: string }>();

  constructor(deps: PluginHubDeps) {
    this.deps = deps;
    deps.registry.on("change", () => this.changed());
    const catalog = deps.catalog;
    catalog?.on("change", () => deps.broadcast({ type: "plugin.catalog", catalog: catalog.get() }));
  }

  /** The catalog of plugins as last read, for a browser that connects. */
  catalog(): PluginCatalog | undefined {
    return this.deps.catalog?.get();
  }

  /** The installed plugins, as browsers see them. */
  infos(): PluginInfo[] {
    return this.deps.registry.entries().map((e) => this.info(e));
  }

  /** The kept events of daemon parts (retain), for a browser that connects. */
  retainedEvents(): PluginEvent[] {
    return [...this.retained.values()].map((r) => r.event);
  }

  /** A plugin, its files, its state or its settings changed: browsers and gasho-daemons hear of it. */
  changed(): void {
    this.forgetEvents();
    this.toClients();
    for (const [machine, peer] of this.deps.daemons()) peer.send({ type: "plugins", plugins: this.daemonEntries(machine) });
  }

  /** What browsers see changed (a daemon part's state, a working server connected or gone). */
  toClients(): void {
    const plugins = this.infos();
    const json = JSON.stringify(plugins);
    if (json === this.lastInfos) return;
    this.lastInfos = json;
    this.deps.broadcast({ type: "plugins", plugins });
  }

  onDaemonReady(machine: string, peer: Peer<HubToDaemon>): void {
    peer.send({ type: "plugins", plugins: this.daemonEntries(machine) });
  }

  onDaemonClose(machine: string): void {
    this.status.delete(machine);
    for (const [id, c] of this.calls) {
      if (c.machine !== machine) continue;
      clearTimeout(c.timer);
      this.calls.delete(id);
      c.client.send({ type: "plugin.response", requestId: c.clientRequestId, error: "working server との接続が切れました。" });
    }
    this.toClients();
  }

  /** plugin.status, plugin.code.get, plugin.response and plugin.event from a gasho-daemon. */
  onDaemonMessage(
    machine: string,
    peer: Peer<HubToDaemon>,
    msg: Extract<DaemonToHub, { type: "plugin.status" | "plugin.code.get" | "plugin.response" | "plugin.event" }>,
  ): void {
    switch (msg.type) {
      case "plugin.event":
        this.onEvent(machine, msg);
        return;
      case "plugin.status":
        this.onStatus(machine, msg);
        return;
      case "plugin.code.get":
        void this.sendCode(peer, msg.plugin, msg.hash);
        return;
      case "plugin.response": {
        const c = this.calls.get(msg.requestId);
        if (!c || c.machine !== machine) return;
        clearTimeout(c.timer);
        this.calls.delete(msg.requestId);
        const answer = typeof msg.error === "string" ? { error: msg.error.slice(0, 2000) } : { result: msg.result };
        c.client.send({ type: "plugin.response", requestId: c.clientRequestId, ...answer });
        return;
      }
    }
  }

  onClientMessage(peer: ClientPeer, msg: PluginRequest | ({ requestId: string } & PluginCommand) | CatalogGet): void {
    if (msg.type === "plugin.catalog.get") {
      // Every browser hears of the catalog read again (plugin.catalog).
      void this.deps.catalog?.read(msg.refresh === true ? 0 : CATALOG_MAX_AGE_MS);
      return;
    }
    if (typeof msg.requestId !== "string" || !msg.requestId || msg.requestId.length > 100) return;
    if (msg.type === "plugin.request") {
      this.call(peer, msg);
      return;
    }
    if (msg.type === "plugin.install" || msg.type === "plugin.update" || msg.type === "plugin.remove") {
      const requestId = msg.requestId;
      void this.manage(peer, msg).then((result) => peer.send({ type: "plugin.result", requestId, result }));
      return;
    }
    const result = this.command(peer, msg);
    peer.send({ type: "plugin.result", requestId: msg.requestId, result });
  }

  onClientClose(peer: ClientPeer): void {
    for (const [id, c] of this.calls) {
      if (c.client !== peer) continue;
      clearTimeout(c.timer);
      this.calls.delete(id);
    }
  }

  // ---- calls ----

  private call(peer: ClientPeer, msg: PluginRequest): void {
    const reply = (error: string) => peer.send({ type: "plugin.response", requestId: msg.requestId, error });
    const entry = typeof msg.plugin === "string" ? this.deps.registry.get(msg.plugin) : undefined;
    const manifest = entry?.revision?.manifest;
    if (!entry || !manifest) return reply("このプラグインはありません。");
    const state = this.state(entry.id);
    if (!state.enabled) return reply(`${manifest.name} は無効になっています。`);
    if (!manifest.daemon) return reply(`${manifest.name} には working server で動く部分がありません。`);
    const spec = typeof msg.method === "string" && Object.hasOwn(manifest.methods ?? {}, msg.method) ? manifest.methods?.[msg.method] : undefined;
    if (!spec) return reply(`${manifest.name} に ${String(msg.method)} という処理はありません。`);
    if (msg.sessionId !== undefined && (typeof msg.sessionId !== "string" || !msg.sessionId || msg.sessionId.length > 100)) {
      return reply("セッションの指定が正しくありません。");
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(msg.params);
    } catch {
      return reply("引数を JSON にできません。");
    }
    if ((json?.length ?? 0) > MAX_PARAMS_BYTES) return reply(`引数が大きすぎます（${MAX_PARAMS_BYTES / 1024}KB まで）。`);
    const machine = typeof msg.machine === "string" ? msg.machine : "";
    const daemon = this.deps.daemon(machine);
    if (!daemon) return reply("この working server はオフラインです。");
    const status = this.status.get(machine);
    if (!status || !supports(status.api, manifest.api)) return reply(OLD_DAEMON);
    if (!chosen(state.machines, machine)) {
      return reply(`この working server では、${manifest.name} の working server で動く部分を動かしていません。プラグインの画面で選んでください。`);
    }
    const own = status.plugins.get(entry.id);
    if (own?.state === "off") return reply("この working server の gasho-daemon は、プラグインを動かさない設定です（GASHO_PLUGINS）。");

    const requestId = randomUUID();
    const timeoutMs = (spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const timer = setTimeout(() => {
      if (this.calls.delete(requestId)) reply("working server から応答がありません。");
    }, timeoutMs + RELAY_MARGIN_MS);
    timer.unref();
    this.calls.set(requestId, { client: peer, clientRequestId: msg.requestId, machine, timer });
    if (spec.kind === "write") {
      const summary = typeof msg.summary === "string" ? msg.summary.trim().slice(0, 300) : "";
      this.deps.audit({
        machine,
        sessionId: msg.sessionId ?? "",
        event: "Gasho:plugin.call",
        at: Date.now(),
        summary: `${manifest.name}：${summary || msg.method} (by ${peer.deviceId} via ${entry.id})`,
      });
    }
    daemon.send({
      type: "plugin.request",
      requestId,
      plugin: entry.id,
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
      method: msg.method,
      ...(msg.params !== undefined ? { params: msg.params } : {}),
      timeoutMs,
      ...(spec.kind === "write" ? { write: true } : {}),
    });
  }

  // ---- managing plugins ----

  private audit(peer: ClientPeer, event: string, summary: string): void {
    this.deps.audit({ machine: "", sessionId: "", event, at: Date.now(), summary: `${summary} (by ${peer.deviceId})` });
  }

  private command(peer: ClientPeer, cmd: Exclude<PluginCommand, ManageCommand>): CommandResult {
    const entry = typeof cmd.plugin === "string" ? this.deps.registry.get(cmd.plugin) : undefined;
    if (!entry) return { ok: false, error: "このプラグインはありません。" };
    const name = entry.revision?.manifest.name ?? entry.id;
    const state = this.state(entry.id);
    const audit = (event: string, summary: string) => this.audit(peer, event, summary);
    switch (cmd.type) {
      case "plugin.enable": {
        if (typeof cmd.enabled !== "boolean") return { ok: false, error: "有効か無効かの指定が正しくありません。" };
        this.deps.store.setPluginState(entry.id, { ...state, enabled: cmd.enabled });
        audit("Gasho:plugin.enable", `${name} [${cmd.enabled ? "on" : "off"}]`);
        break;
      }
      case "plugin.machines": {
        const machines = machinesOf(cmd.machines);
        if (!machines) return { ok: false, error: "working server の指定が正しくありません。" };
        this.deps.store.setPluginState(entry.id, { ...state, machines });
        const names = machines === "all" ? "すべて" : machines.map((id) => this.deps.machines().get(id)?.name ?? id).join("、") || "なし";
        audit("Gasho:plugin.machines", `${name}：${names}`);
        break;
      }
      case "plugin.setting": {
        const spec = entry.revision?.manifest.settings?.[cmd.key];
        if (typeof cmd.key !== "string" || !spec || !Object.hasOwn(entry.revision?.manifest.settings ?? {}, cmd.key)) {
          return { ok: false, error: "この設定はありません。" };
        }
        if (spec.scope !== "server") return { ok: false, error: "この設定は、ブラウザーごとの設定です。" };
        const wrong = settingProblem(spec, cmd.value);
        if (wrong) return { ok: false, error: wrong };
        this.deps.store.setPluginSetting(entry.id, cmd.key, cmd.value);
        audit("Gasho:plugin.setting", `${name}：${spec.label} = ${JSON.stringify(cmd.value).slice(0, 100)}`);
        break;
      }
      default:
        return { ok: false, error: "不明な命令です。" };
    }
    this.changed();
    return { ok: true };
  }

  /** Adds a plugin from the catalog, updates one to the catalog's version, or removes one. */
  private async manage(peer: ClientPeer, cmd: ManageCommand): Promise<CommandResult> {
    const id = typeof cmd.plugin === "string" && ID_RE.test(cmd.plugin) ? cmd.plugin : undefined;
    if (!id) return { ok: false, error: "このプラグインはありません。" };
    if (this.busy.has(id)) return { ok: false, error: "このプラグインは、ほかの操作の途中です。終わってから、もう一度試してください。" };
    this.busy.add(id);
    try {
      if (cmd.type === "plugin.install") return await this.install(peer, id, cmd.machines);
      if (cmd.type === "plugin.update") return await this.update(peer, id);
      return await this.remove(peer, id);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.busy.delete(id);
    }
  }

  private async install(peer: ClientPeer, id: string, asked: unknown): Promise<CommandResult> {
    const catalog = this.deps.catalog;
    if (!catalog) return { ok: false, error: "この Gasho サーバーでは、カタログからプラグインを入れられません。" };
    const entry = catalog.find(id);
    if (!entry) return { ok: false, error: "カタログにこのプラグインはありません。一覧を読み直してください。" };
    if (this.deps.registry.get(id) || (await fsp.lstat(path.join(this.deps.registry.dir, id)).catch(() => undefined))) {
      return { ok: false, error: `${entry.name} はすでに入っています。` };
    }
    const wrongApi = apiProblem(entry.api);
    if (wrongApi) return { ok: false, error: wrongApi };
    const machines = machinesOf(asked);
    if (!machines) return { ok: false, error: "working server の指定が正しくありません。" };
    const tgz = await catalog.fetch(entry);
    // Before the files, so that its daemon part starts only where it was chosen to.
    this.deps.store.setPluginState(id, { enabled: true, machines });
    try {
      await installRelease(this.deps.registry.dir, entry, tgz);
    } catch (e) {
      this.deps.store.forgetPlugin(id);
      throw e;
    }
    this.audit(peer, "Gasho:plugin.install", `${entry.name} ${entry.version}`);
    await this.deps.registry.scan();
    return { ok: true };
  }

  private async update(peer: ClientPeer, id: string): Promise<CommandResult> {
    const catalog = this.deps.catalog;
    if (!catalog) return { ok: false, error: "この Gasho サーバーでは、カタログからプラグインを入れられません。" };
    const installed = this.deps.registry.get(id);
    if (!installed) return { ok: false, error: "このプラグインは入っていません。" };
    if (installed.dev) return { ok: false, error: "開発中のプラグイン（リンクしたもの）は、カタログから更新しません。" };
    const entry = catalog.find(id);
    if (!entry) return { ok: false, error: "カタログにこのプラグインはありません。一覧を読み直してください。" };
    const current = installed.revision?.manifest.version;
    if (current && compareVersions(entry.version, current) <= 0) return { ok: false, error: `カタログに ${current} より新しい版はありません。` };
    const wrongApi = apiProblem(entry.api);
    if (wrongApi) return { ok: false, error: wrongApi };
    const tgz = await catalog.fetch(entry);
    await installRelease(this.deps.registry.dir, entry, tgz);
    this.audit(peer, "Gasho:plugin.update", `${entry.name} ${current ?? "?"} → ${entry.version}`);
    await this.deps.registry.scan();
    return { ok: true };
  }

  private async remove(peer: ClientPeer, id: string): Promise<CommandResult> {
    const entry = this.deps.registry.get(id);
    const name = entry?.revision?.manifest.name ?? id;
    if (!(await removePluginFolder(this.deps.registry.dir, id))) return { ok: false, error: "このプラグインは入っていません。" };
    this.deps.store.forgetPlugin(id);
    this.audit(peer, "Gasho:plugin.remove", `${name}${entry?.dev ? " [link]" : ""}`);
    await this.deps.registry.scan();
    return { ok: true };
  }

  // ---- what gasho-daemon is told and tells ----

  private daemonEntries(machine: string): DaemonPluginEntry[] {
    return this.deps.registry.entries().flatMap((e) => {
      const r = e.revision;
      if (!r?.manifest.daemon) return [];
      const state = this.state(e.id);
      return [{ id: e.id, hash: r.hash, run: state.enabled && chosen(state.machines, machine), settings: this.values(e.id, r.manifest) }];
    });
  }

  private onStatus(machine: string, msg: PluginStatusMessage): void {
    if (typeof msg.api !== "string" || !Array.isArray(msg.plugins)) return;
    const plugins = new Map<string, DaemonPluginStatus>();
    for (const p of msg.plugins.slice(0, 200)) {
      if (typeof p?.id !== "string" || !["running", "stopped", "off", "failed"].includes(p.state)) continue;
      plugins.set(p.id, {
        id: p.id,
        state: p.state,
        ...(typeof p.hash === "string" ? { hash: p.hash.slice(0, 64) } : {}),
        ...(typeof p.error === "string" ? { error: p.error.slice(0, 500) } : {}),
      });
    }
    this.status.set(machine, { api: msg.api.slice(0, 20), plugins });
    this.toClients();
  }

  /**
   * An event of a daemon part: passed on to every browser when the plugin is enabled and runs on that working server,
   * and kept when it asks for it (retain). Others are dropped (gasho-daemon checks them already).
   */
  private onEvent(machine: string, msg: PluginEventMessage): void {
    const entry = typeof msg.plugin === "string" ? this.deps.registry.get(msg.plugin) : undefined;
    const hash = entry?.revision?.hash;
    if (!entry || !hash || !entry.revision?.manifest.daemon) return;
    const state = this.state(entry.id);
    if (!state.enabled || !chosen(state.machines, machine)) return;
    const topic = msg.topic;
    if (typeof topic !== "string" || topic.length === 0 || topic.length > MAX_TOPIC || /[\u0000-\u001f]/.test(topic)) return;
    const json = JSON.stringify(msg.data ?? null);
    if (Buffer.byteLength(json) > MAX_EVENT_BYTES) return;
    const event: PluginEvent = { plugin: entry.id, machine, topic, data: msg.data ?? null };
    this.deps.broadcast({ type: "plugin.event", event });
    if (msg.retain !== true) return;
    const key = `${entry.id}\0${machine}\0${topic}`;
    // Kept in the order they came: the oldest of the plugin on the working server is dropped first.
    this.retained.delete(key);
    this.retained.set(key, { event, hash });
    const prefix = `${entry.id}\0${machine}\0`;
    const own = [...this.retained.keys()].filter((k) => k.startsWith(prefix));
    for (const k of own.slice(0, Math.max(0, own.length - MAX_RETAINED))) this.retained.delete(k);
  }

  /**
   * Drops kept events that no longer stand: of a plugin removed, disabled, not run on that working server any more, or
   * replaced by a new version (whose daemon part sends its own from `start`).
   */
  private forgetEvents(): void {
    for (const [key, r] of this.retained) {
      const entry = this.deps.registry.get(r.event.plugin);
      const state = this.state(r.event.plugin);
      if (entry?.revision?.hash === r.hash && state.enabled && chosen(state.machines, r.event.machine)) continue;
      this.retained.delete(key);
    }
  }

  private async sendCode(peer: Peer<HubToDaemon>, plugin: unknown, hash: unknown): Promise<void> {
    if (typeof plugin !== "string" || typeof hash !== "string") return;
    const code = await this.deps.registry.daemonCode(plugin, hash).catch(() => undefined);
    if (code === undefined) {
      peer.send({ type: "plugin.code", plugin, hash, error: "このプラグインの版は、Gasho サーバーにもうありません。" });
    } else if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
      peer.send({ type: "plugin.code", plugin, hash, error: "daemon.js が大きすぎます。" });
    } else peer.send({ type: "plugin.code", plugin, hash, code });
  }

  // ---- helpers ----

  private state(id: string): { enabled: boolean; machines: PluginMachines } {
    return this.deps.store.pluginState(id) ?? { enabled: true, machines: "all" };
  }

  /** The values of the settings the Gasho server keeps (scope "server"), with the defaults of those not set. */
  private values(id: string, manifest: PluginManifest): Record<string, unknown> {
    const saved = this.deps.store.pluginSettings(id);
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(manifest.settings ?? {})) {
      if (spec.scope !== "server") continue;
      const v = settingValue(spec, saved[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  private info(e: PluginEntry): PluginInfo {
    const r = e.revision;
    const manifest: PluginManifest = r?.manifest ?? { id: e.id, name: e.id, version: "", api: "" };
    const state = this.state(e.id);
    const info: PluginInfo = { id: e.id, manifest, dev: e.dev, enabled: state.enabled, machines: state.machines, values: r ? this.values(e.id, manifest) : {} };
    if (r) {
      info.hash = r.hash;
      if (manifest.web) {
        const url = (file: string) => `/plugins/${encodeURIComponent(e.id)}/${r.hash}/${file.split("/").map(encodeURIComponent).join("/")}`;
        info.web = { js: url(manifest.web.js), ...(manifest.web.css ? { css: url(manifest.web.css) } : {}) };
      }
    }
    if (e.error) info.error = e.error;
    if (manifest.daemon) {
      const daemon: NonNullable<PluginInfo["daemon"]> = {};
      for (const m of this.deps.machines().values()) daemon[m.id] = this.daemonState(e, state, m);
      info.daemon = daemon;
    }
    return info;
  }

  private daemonState(e: PluginEntry, state: { enabled: boolean; machines: PluginMachines }, m: MachineInfo): { state: PluginDaemonState; error?: string } {
    if (!m.connected || !this.deps.daemon(m.id)) return { state: "offline" };
    const status = this.status.get(m.id);
    if (!status || !supports(status.api, e.revision?.manifest.api ?? PLUGIN_API)) return { state: "old" };
    if (!state.enabled || !chosen(state.machines, m.id)) return { state: "off" };
    const own = status.plugins.get(e.id);
    if (!own) return { state: "stopped" };
    return own.error ? { state: own.state, error: own.error } : { state: own.state };
  }
}

/**
 * Whether a gasho-daemon (its plugin API `api`) runs a plugin written for `wants`: the same major as this Gasho server,
 * and a minor up to the daemon's (a 1.1 plugin may use what a 1.0 gasho-daemon does not give its daemon part).
 */
function supports(api: string, wants: string): boolean {
  const [major, minor] = (/^(\d+)\.(\d+)/.exec(api) ?? []).slice(1).map(Number);
  const [wantsMajor, wantsMinor] = (/^(\d+)\.(\d+)/.exec(wants) ?? []).slice(1).map(Number);
  return major === PLUGIN_API_MAJOR && wantsMajor === major && (minor ?? 0) >= (wantsMinor ?? 0);
}

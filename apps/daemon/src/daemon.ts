import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandResult,
  EffortLevel,
  GitHubRepo,
  HubToDaemon,
  InputFeature,
  InputFile,
  ModelOption,
  SessionInfo,
  SessionModel,
  SessionRepo,
  SwitchField,
  TranscriptEntry,
} from "@gasho/protocol";
import type { DaemonConfig } from "./config.ts";
import { githubRepoOf, nestedRepos, readGitGraph } from "./git.ts";
import { ghError, listGitHub, viewGitHub } from "./github.ts";
import { startHookServer, summarizeHook } from "./hooks.ts";
import { HubClient } from "./hub-client.ts";
import {
  atBottom,
  cleanEnv,
  clearPromptKeys,
  dialogOpen,
  EFFORT_LEVELS,
  isAlive,
  launchableFolders,
  launchArgs,
  ManagedSessions,
  type ManagedSession,
  modelPickerOptions,
  PERMISSION_PROMPT_RE,
  pickerCatalog,
  pickerEffort,
  pickerMatches,
  type PickerOption,
  promptBoxLines,
  promptHolds,
  promptRuleUltracode,
  refusedCommand,
  safeFileName,
  type Screen,
  statusLine,
  surveyOpen,
  switchedForSession,
  switchQuestion,
  TRUST_PROMPT_RE,
  typedInBox,
  Zellij,
  zellijSessionName,
} from "./managed.ts";
import { findTranscript, listAgents, mapStatus, rcModeOf, readRegistry, type AgentRow } from "./sessions.ts";
import { emptyMeta, readTranscript, TranscriptTail, type TranscriptMeta } from "./transcript.ts";
import { log } from "./util.ts";

export const DAEMON_VERSION = "0.8.0";
const GITHUB_CACHE_MS = 5 * 60_000;
/** How long the list of repositories inside a folder (and their branches) is reused. */
const REPOS_CACHE_MS = 60_000;
const FOLDERS_REFRESH_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const MAX_INPUT = 20_000;
const INTERRUPT_SETTLE_MS = 1500;
const MODEL_NAMES: Record<SessionModel, string> = { default: "既定のモデル", opus: "Opus", fable: "Fable", sonnet: "Sonnet", haiku: "Haiku" };
const EFFORT_NAMES: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };
/** What this gasho-daemon can switch or carry with an input (MachineInfo.features). */
const INPUT_FEATURES: readonly InputFeature[] = ["model", "effort", "ultracode", "files"];
/** How long the prompt box may take to let go of a text after Enter (see typeInput). */
const ENTER_WAIT_MS = 8000;
/** When it did not, how long to wait before looking at the box again. */
const UNSURE_RETRY_MS = 20_000;
/** When nothing could be typed, how long to wait before trying again. */
const RETRY_MS = 5000;
/** How long to watch for a /model picker that Claude Code may still open (see closeLatePicker). */
const LATE_PICKER_WAIT_MS = 10_000;
/** A session is used to read the model names only once it has run this long (Claude Code has finished starting). */
const PROBE_MIN_AGE_MS = 30_000;
/** After a look at the model names whose "/model" was not taken in time, how long to watch for the picker it opens. */
const LATE_PICKER_WATCH_MS = 5 * 60_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long the model names read from the /model picker are trusted before an idle session is asked again. */
const MODELS_MAX_AGE_MS = 24 * 3600_000;
/** At most one look at the /model picker just to read the model names, per this interval. */
const MODELS_PROBE_INTERVAL_MS = 10 * 60_000;

interface Tracked {
  info: SessionInfo;
  transcript?: string;
  tail?: TranscriptTail;
  meta: TranscriptMeta;
  /** The transcript did not exist yet when the session was first seen (Claude Code writes it on the first message). */
  sawWithoutTranscript?: boolean;
}

/** What happened to the switches asked for with an input (`id`: the request of the input that was handled). */
interface InputOutcome {
  id?: string;
  warnings: string[];
  unapplied: SwitchField[];
}

/** See Daemon.typeInput. */
type TypeResult = "sent" | "not-typed" | "unsure";

/**
 * Claude Code did not show that it took the Enter of a command ("/model", "/effort ultracode …"). It may still take
 * it, so nothing else is typed now (keys typed behind it could land in what it opens); the input is tried again later.
 */
class EnterNotTaken extends Error {
  constructor(command: string) {
    super(`Claude Code did not take the Enter of ${command} yet`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Daemon {
  private cfg: DaemonConfig;
  private hub: HubClient;
  private tracked = new Map<string, Tracked>();
  private lastSent = "";
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private github = new Map<string, { at: number; repo?: GitHubRepo }>();
  private repos = new Map<string, { at: number; repos?: SessionRepo[] }>();
  private zellij: Zellij;
  private managed: ManagedSessions;
  private canLaunch = false;
  private folders: string[] = [];
  private flushing = new Set<string>();
  /** Until when input must wait after an interrupt, so Claude Code has put the stopped prompt back first. */
  private settleUntil = new Map<string, number>();
  /** The models as Claude Code's /model picker names them on this machine, and when they were read. */
  private models: { at: number; options: ModelOption[] } | undefined;
  /** No look at the /model picker just for the model names before this time. */
  private nextModelsProbe = 0;
  /** Sessions where a /model picker may still open from a look at the model names, and until when to watch them. */
  private latePicker = new Map<string, number>();
  /** The user's messages Claude Code recorded lately, per session: to tell whether an Enter it took late went through. */
  private prompts = new Map<string, { at: number; text: string }[]>();

  /** How long the prompt box may take to let go of a text after Enter (see typeInput). */
  private enterWaitMs: number;

  constructor(cfg: DaemonConfig, opts: { enterWaitMs?: number } = {}) {
    this.cfg = cfg;
    this.enterWaitMs = opts.enterWaitMs ?? ENTER_WAIT_MS;
    this.zellij = new Zellij(cleanEnv());
    this.managed = new ManagedSessions(path.join(cfg.stateDir, "managed.json"));
    this.hub = new HubClient({
      url: cfg.hubUrl,
      hello: () => ({ type: "hello", machineId: cfg.machineId, token: cfg.token, daemonVersion: DAEMON_VERSION }),
      onReady: () => {
        this.lastSent = "";
        this.emitSessions();
        this.emitCapabilities();
      },
      onMessage: (m) => void this.onHubMessage(m),
      onRejected: (reason) => {
        log(`the Gasho server rejected this machine (${reason}). Its registration was revoked or is unknown;`);
        log("register again: node src/cli.ts register --server <url> --code <code>");
        process.exit(1);
      },
    });
  }

  async start(): Promise<void> {
    log(`machine ${this.cfg.machineId}, Gasho server ${this.cfg.hubUrl}`);
    if (!this.cfg.hookSecret) log("GASHO_HOOK_SECRET is not set; hook requests are accepted without a secret");
    this.canLaunch = await this.zellij.available();
    if (!this.canLaunch) log("zellij is not available; sessions cannot be started from Gasho on this machine");
    const live = this.canLaunch ? await this.zellij.liveSessions() : new Set<string>();
    await this.managed.load(async (m) => isAlive(m.pid) && live.has(m.zellijSession));
    await this.pruneAttachments();
    this.models = await fsp
      .readFile(this.modelsFile(), "utf8")
      .then((t) => JSON.parse(t) as { at: number; options: ModelOption[] })
      .catch(() => undefined);
    await this.refreshFolders();
    setInterval(() => void this.refreshFolders(), FOLDERS_REFRESH_MS).unref();

    this.hub.connect();
    startHookServer({
      host: "127.0.0.1",
      port: this.cfg.hookPort,
      secret: this.cfg.hookSecret,
      onEvent: (payload) => {
        const ev = summarizeHook(payload);
        if (!ev) return;
        this.hub.send({ type: "hook", event: ev });
        // Hooks often mean the status changed; refresh soon instead of waiting for the next poll.
        this.scheduleRefresh(250);
      },
    });
    setInterval(() => void this.refresh(), this.cfg.pollIntervalMs);
    setInterval(() => void this.pollTails(), 1000);
    try {
      fs.watch(path.join(this.cfg.claudeDir, "sessions"), () => this.scheduleRefresh(300));
    } catch (e) {
      log("cannot watch the sessions directory; relying on polling", e);
    }
    void this.refresh();
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const rows = await listAgents(this.cfg.claudeBin);
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.sessionId || !row.cwd) continue;
        seen.add(row.sessionId);
        const t = this.tracked.get(row.sessionId) ?? this.newTracked(row);
        this.tracked.set(row.sessionId, t);
        await this.update(t, row);
      }
      for (const id of [...this.tracked.keys()]) {
        if (!seen.has(id)) this.tracked.delete(id);
      }
      await this.forgetEndedSessions(seen);
      await this.readManagedScreens();
      this.emitSessions();
      for (const m of this.managed.all()) {
        if (this.managed.pending(m.sessionId) === 0) continue;
        // A failure leaves the input on the queue for the next try.
        void this.flushInput(m.sessionId).catch((e) => log(`could not send the waiting input to ${m.name}`, e));
      }
    } catch (e) {
      log("refresh failed", e);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  /** Managed sessions whose Claude Code has exited: drop them and close their zellij session. */
  private async forgetEndedSessions(seen: Set<string>): Promise<void> {
    let changed = false;
    for (const m of this.managed.all()) {
      if (seen.has(m.sessionId) || isAlive(m.pid)) continue;
      this.managed.remove(m.sessionId);
      for (const map of [this.settleUntil, this.latePicker, this.prompts]) map.delete(m.sessionId);
      await this.zellij.kill(m.zellijSession);
      await fsp.rm(this.attachmentsOf(m.sessionId), { recursive: true, force: true });
      log(`session ${m.name} ended; closed zellij session ${m.zellijSession}`);
      changed = true;
    }
    if (changed) await this.managed.save();
  }

  private newTracked(row: AgentRow): Tracked {
    return {
      meta: emptyMeta(),
      info: { sessionId: row.sessionId ?? "", cwd: row.cwd ?? "", status: "unknown", rcMode: "none", prLinks: [] },
    };
  }

  private async update(t: Tracked, row: AgentRow): Promise<void> {
    const info = t.info;
    info.pid = row.pid;
    info.kind = row.kind;
    info.name = row.name;
    info.startedAt = row.startedAt;
    info.status = mapStatus(row);
    info.waitingFor = row.waitingFor;

    const reg = row.pid ? await readRegistry(this.cfg.claudeDir, row.pid) : undefined;
    info.rcMode = rcModeOf(reg);

    if (!t.transcript) {
      const found = await findTranscript(this.cfg.claudeDir, info.sessionId);
      if (!found) {
        t.sawWithoutTranscript = true;
      } else if (t.sawWithoutTranscript) {
        // Written after we started following the session: stream it from the start, so browsers that
        // loaded the (then empty) conversation receive the first messages too.
        t.transcript = found;
        t.meta = emptyMeta();
        t.tail = new TranscriptTail(found, 0);
      } else {
        try {
          const { meta, consumed } = await readTranscript(found);
          t.transcript = found;
          t.meta = meta;
          t.tail = new TranscriptTail(found, consumed);
        } catch (e) {
          log(`cannot read ${found}`, e);
        }
      }
    }
    info.bridgeSessionId = reg?.bridgeSessionId ?? t.meta.bridgeSessionId;
    this.applyMeta(t);
    info.github = await this.githubOf(info.cwd);
    info.repos = await this.reposOf(info.cwd);
  }

  private applyMeta(t: Tracked): void {
    const { info, meta } = t;
    info.title = meta.title;
    info.gitBranch = meta.gitBranch;
    info.prLinks = meta.prLinks;
    info.costUSD = meta.costUSD;
    info.lastActivityAt = meta.lastActivityAt;
    info.model = meta.model;
    info.effort = meta.effort;
    info.ultracode = meta.ultracode;
  }

  private async githubOf(cwd: string): Promise<GitHubRepo | undefined> {
    const hit = this.github.get(cwd);
    if (hit && Date.now() - hit.at < GITHUB_CACHE_MS) return hit.repo;
    const repo = await githubRepoOf(cwd);
    this.github.set(cwd, { at: Date.now(), repo });
    return repo;
  }

  /** Repositories inside a folder that is not itself in one (see nestedRepos). */
  private async reposOf(cwd: string): Promise<SessionRepo[] | undefined> {
    const hit = this.repos.get(cwd);
    if (hit && Date.now() - hit.at < REPOS_CACHE_MS) return hit.repos;
    const repos = await nestedRepos(cwd).catch(() => undefined);
    this.repos.set(cwd, { at: Date.now(), repos });
    return repos;
  }

  private emitSessions(): void {
    const sessions = [...this.tracked.values()]
      .map((t) => {
        const m = this.managed.get(t.info.sessionId);
        const pending = this.managed.pending(t.info.sessionId);
        // A session started from Gasho keeps the name it was given (also its Remote Control name).
        return { ...t.info, name: m?.name ?? t.info.name, managed: m ? true : undefined, pendingInputs: pending || undefined };
      })
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const json = JSON.stringify(sessions);
    if (json === this.lastSent || !this.hub.connected) return;
    this.lastSent = json;
    this.hub.send({ type: "sessions", sessions });
  }

  private async refreshFolders(): Promise<void> {
    const cwds = [...this.tracked.values()].map((t) => t.info.cwd);
    const folders = await launchableFolders(os.homedir(), cwds);
    if (JSON.stringify(folders) === JSON.stringify(this.folders)) return;
    this.folders = folders;
    this.emitCapabilities();
  }

  private emitCapabilities(): void {
    if (!this.hub.connected) return;
    this.hub.send({
      type: "capabilities",
      canLaunch: this.canLaunch,
      folders: this.folders,
      models: this.models?.options,
      modelsAt: this.models?.at,
      features: [...INPUT_FEATURES],
    });
  }

  private modelsFile(): string {
    return path.join(this.cfg.stateDir, "models.json");
  }

  /**
   * Keeps the model names read from a /model picker on screen, and tells the Gasho server. A list with fewer models
   * than a recent one is not taken (part of the picker may have been cut off). Returns whether the names were taken.
   */
  private async rememberModels(screen: string): Promise<boolean> {
    const options = pickerCatalog(modelPickerOptions(screen));
    if (options.length === 0) return false;
    const kept = this.models;
    if (kept && Date.now() - kept.at < MODELS_MAX_AGE_MS && options.length < kept.options.length) return false;
    this.models = { at: Date.now(), options };
    await fsp.writeFile(this.modelsFile(), `${JSON.stringify(this.models)}\n`, { mode: 0o600 }).catch(() => undefined);
    this.emitCapabilities();
    return true;
  }

  /** The name of a model for messages: the picker's name with its version when known ("Opus 5.5"). */
  private modelName(model: SessionModel): string {
    if (model === "default") return MODEL_NAMES.default;
    return this.models?.options.find((o) => o.id === model)?.name ?? MODEL_NAMES[model];
  }

  /**
   * Whether the session already uses the model asked for: its name ("Opus 5.5") is the one the picker gives for that
   * model. A session on another version ("Opus 4.6") is switched. "default" always switches: the session's name does
   * not say whether it follows the default.
   */
  private sameModel(current: string | undefined, model: SessionModel): boolean {
    if (model === "default" || !current) return false;
    const name = this.models?.options.find((o) => o.id === model)?.name;
    return name !== undefined && name.toLowerCase() === current.replace(/\s*\(default\)\s*$/i, "").toLowerCase();
  }

  /**
   * Sessions started from Gasho: reads the effort level and ultracode shown above the prompt box. When the model
   * names are unknown or old, one idle session's /model picker is opened and closed again (Esc) to read them.
   */
  private async readManagedScreens(): Promise<void> {
    for (const m of this.managed.all()) {
      const t = this.tracked.get(m.sessionId);
      if (!t || this.flushing.has(m.sessionId)) continue;
      // What the screen shows now wins over the transcript: the line above the prompt box ("◐ medium · ultracode ·
      // /effort", shown for a while after a change) and the "ultracode" in the rule above the box (while it is on).
      const screen = (await this.zellij.screen(m.zellijSession).catch(() => undefined))?.plain ?? "";
      const state = statusLine(screen);
      if (state) {
        t.info.effort = state.effort;
        t.info.ultracode = state.ultracode;
      }
      const ultracode = promptRuleUltracode(screen);
      if (ultracode !== undefined) t.info.ultracode = ultracode;
      await this.closeProbePicker(m, screen);
    }
    const stale = !this.models || Date.now() - this.models.at > MODELS_MAX_AGE_MS;
    if (!stale || Date.now() < this.nextModelsProbe) return;
    // The newest session that has been running for a while: its conversation is the shortest, so the /model note
    // disturbs the least, and its Claude Code has finished starting.
    const idle = this.managed
      .all()
      .sort((a, b) => b.launchedAt - a.launchedAt)
      .find(
        (m) =>
          Date.now() - m.launchedAt > PROBE_MIN_AGE_MS &&
          this.tracked.get(m.sessionId)?.info.status === "idle" &&
          this.managed.pending(m.sessionId) === 0 &&
          !this.flushing.has(m.sessionId),
      );
    if (idle) await this.probeModelsIn(idle);
  }

  /**
   * Closes a /model picker that a look at the model names opened late (see probeModelsIn), while it is watched for.
   * A picker opened by someone at the session's terminal is left alone after that.
   */
  private async closeProbePicker(m: ManagedSession, screen: string): Promise<void> {
    const until = this.latePicker.get(m.sessionId);
    if (until === undefined) return;
    if (Date.now() > until) {
      this.latePicker.delete(m.sessionId);
      return;
    }
    if (modelPickerOptions(screen).length === 0 && !switchQuestion(screen)) return;
    this.latePicker.delete(m.sessionId);
    this.flushing.add(m.sessionId);
    try {
      await this.closePicker(m.zellijSession);
    } catch (e) {
      log(`could not close the /model picker in ${m.name}`, e);
    } finally {
      this.flushing.delete(m.sessionId);
    }
  }

  /**
   * Reads the model names in a session's /model picker (opened and closed again); nothing else types meanwhile. Not
   * while someone is typing in the session's terminal (their text would be erased). After a failure, the next try
   * waits as long as the names are trusted: a picker that could not be read once is likely to stay so.
   */
  private async probeModelsIn(m: ManagedSession): Promise<void> {
    if (this.flushing.has(m.sessionId)) return;
    this.flushing.add(m.sessionId);
    this.nextModelsProbe = Date.now() + MODELS_PROBE_INTERVAL_MS;
    try {
      if ((await this.currentStatus(m.pid)) !== "idle") return;
      if (typedInBox(await this.zellij.screen(m.zellijSession)) !== "") return;
      const result = await this.probeModels(m.zellijSession);
      if (result === "read") return;
      this.nextModelsProbe = Date.now() + MODELS_MAX_AGE_MS;
      log(`could not read the model names in ${m.name}; trying again in a day`);
      // The picker may open later still; it is closed when it does (see readManagedScreens).
      if (result === "unsure") this.latePicker.set(m.sessionId, Date.now() + LATE_PICKER_WATCH_MS);
    } catch (e) {
      this.nextModelsProbe = Date.now() + MODELS_MAX_AGE_MS;
      log(`could not read the model names in ${m.name}`, e);
    } finally {
      this.flushing.delete(m.sessionId);
    }
  }

  private async pollTails(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let changed = false;
      for (const t of this.tracked.values()) {
        if (!t.tail) continue;
        const entries = await t.tail.poll(t.meta);
        if (entries.length === 0) continue;
        this.notePrompts(t.info.sessionId, entries);
        this.hub.send({ type: "transcript.append", sessionId: t.info.sessionId, entries });
        this.applyMeta(t);
        changed = true;
      }
      if (changed) this.emitSessions();
    } finally {
      this.polling = false;
    }
  }

  /** Keeps the last user messages of a session (see `prompts`). */
  private notePrompts(sessionId: string, entries: TranscriptEntry[]): void {
    const list = this.prompts.get(sessionId) ?? [];
    for (const e of entries) {
      if (e.role !== "user" || e.isSidechain) continue;
      const text = e.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (text) list.push({ at: Date.now(), text });
    }
    this.prompts.set(sessionId, list.slice(-20));
  }

  /** Whether Claude Code recorded `text` as a user message since `since` (ms). */
  private promptTaken(sessionId: string, text: string, since: number): boolean {
    const head = text.replace(/^\s*!/, "").replace(/\s+/g, "").slice(0, 24);
    return (this.prompts.get(sessionId) ?? []).some((p) => p.at >= since && p.text.replace(/\s+/g, "").includes(head));
  }

  private async onHubMessage(m: HubToDaemon): Promise<void> {
    switch (m.type) {
      case "transcript.get":
        return this.sendTranscriptPage(m);
      case "git.graph.get":
        return this.sendGitGraph(m);
      case "github.list.get":
        return this.sendGitHubList(m);
      case "github.item.get":
        return this.sendGitHubItem(m);
      case "session.launch":
      case "session.input":
      case "session.interrupt": {
        let result: CommandResult;
        try {
          if (m.type === "session.launch") result = await this.launch(m.cwd, m.name);
          else if (m.type === "session.input") result = await this.input(m);
          else result = await this.interrupt(m.sessionId);
        } catch (e) {
          log(`${m.type} failed`, e);
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        this.hub.send({ type: "command.result", requestId: m.requestId, result });
        return;
      }
    }
  }

  private async sendTranscriptPage(m: Extract<HubToDaemon, { type: "transcript.get" }>): Promise<void> {
    const t = this.tracked.get(m.sessionId);
    const reply = { type: "transcript.page" as const, requestId: m.requestId, sessionId: m.sessionId };
    if (!t) {
      this.hub.send({ ...reply, entries: [], start: 0, total: 0, error: "session not found" });
      return;
    }
    if (!t.transcript) {
      // A new session has no transcript until its first message; that is an empty conversation, not an error.
      this.hub.send({ ...reply, entries: [], start: 0, total: 0 });
      return;
    }
    try {
      const { entries } = await readTranscript(t.transcript);
      const total = entries.length;
      const end = Math.min(m.before ?? total, total);
      const start = Math.max(0, end - m.limit);
      this.hub.send({ ...reply, entries: entries.slice(start, end), start, total });
    } catch (e) {
      this.hub.send({ ...reply, entries: [], start: 0, total: 0, error: String(e) });
    }
  }

  /**
   * The folder of a session's repository: its own folder, or `repo` inside it. Only sessions this daemon tracks, and
   * only a repository it found inside the folder, never a path the browser made up.
   */
  private async repoDir(sessionId: string, repo: string | undefined): Promise<{ dir: string } | { error: string }> {
    const t = this.tracked.get(sessionId);
    if (!t) return { error: "このセッションは見つかりません。" };
    if (repo === undefined) return { dir: t.info.cwd };
    const found = (await this.reposOf(t.info.cwd))?.find((r) => r.path === repo);
    return found ? { dir: path.join(t.info.cwd, found.path) } : { error: "このリポジトリは見つかりません。" };
  }

  /** Branches and history of the repository the session works in. */
  private async sendGitGraph(m: Extract<HubToDaemon, { type: "git.graph.get" }>): Promise<void> {
    const reply = { type: "git.graph" as const, requestId: m.requestId, sessionId: m.sessionId, repo: m.repo };
    const where = await this.repoDir(m.sessionId, m.repo);
    if ("error" in where) {
      this.hub.send({ ...reply, error: where.error });
      return;
    }
    const dir = where.dir;
    try {
      const [graph, github] = await Promise.all([readGitGraph(dir), this.githubOf(dir)]);
      this.hub.send({ ...reply, graph: github ? { ...graph, github } : graph });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      const error = /not a git repository/i.test(text)
        ? "このフォルダーは Git のリポジトリではありません。"
        : `Git の情報を読めませんでした：${text.split("\n")[0]}`;
      this.hub.send({ ...reply, error });
    }
  }

  /** The open issues or pull requests of the GitHub repository the session works in, read with `gh`. */
  private async sendGitHubList(m: Extract<HubToDaemon, { type: "github.list.get" }>): Promise<void> {
    const reply = { type: "github.list" as const, requestId: m.requestId, sessionId: m.sessionId, repo: m.repo, kind: m.kind };
    const where = await this.repoDir(m.sessionId, m.repo);
    if ("error" in where) {
      this.hub.send({ ...reply, error: where.error });
      return;
    }
    const github = await this.githubOf(where.dir);
    if (!github) {
      this.hub.send({ ...reply, error: "このリポジトリは GitHub にありません（origin が GitHub のリポジトリではありません）。" });
      return;
    }
    try {
      this.hub.send({ ...reply, list: await listGitHub(this.cfg.ghBin, github, m.kind) });
    } catch (e) {
      log(`gh could not list ${m.kind} of ${github.owner}/${github.name}`, e);
      this.hub.send({ ...reply, error: ghError(e) });
    }
  }

  /** One issue or pull request of the GitHub repository the session works in, with its conversation, read with `gh`. */
  private async sendGitHubItem(m: Extract<HubToDaemon, { type: "github.item.get" }>): Promise<void> {
    const reply = { type: "github.item" as const, requestId: m.requestId, sessionId: m.sessionId, repo: m.repo, kind: m.kind, number: m.number };
    const where = await this.repoDir(m.sessionId, m.repo);
    if ("error" in where) {
      this.hub.send({ ...reply, error: where.error });
      return;
    }
    const github = await this.githubOf(where.dir);
    if (!github) {
      this.hub.send({ ...reply, error: "このリポジトリは GitHub にありません（origin が GitHub のリポジトリではありません）。" });
      return;
    }
    try {
      this.hub.send({ ...reply, item: await viewGitHub(this.cfg.ghBin, github, m.kind, m.number) });
    } catch (e) {
      log(`gh could not read ${m.kind} #${m.number} of ${github.owner}/${github.name}`, e);
      this.hub.send({ ...reply, error: ghError(e) });
    }
  }

  // ---- sessions started by Gasho ----

  /** Starts `claude --remote-control` in `cwd` inside a new zellij session and waits for its session id. */
  private async launch(cwd: string, name: string | undefined): Promise<CommandResult> {
    if (!this.canLaunch) return { ok: false, error: "この working server には zellij がないので、セッションを起動できません。" };
    const dir = path.resolve(cwd);
    const stat = await fsp.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return { ok: false, error: `フォルダーがありません：${dir}` };
    const rcName = name?.trim() || `${path.basename(dir)}-gasho`;
    const zellijSession = zellijSessionName(rcName);
    const pidFile = path.join(this.cfg.stateDir, `${zellijSession}.pid`);
    await fsp.mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    await this.zellij.run(
      launchArgs({ zellijSession, pidFile, cwd: dir, claudeBin: this.cfg.claudeBin, rcName, env: cleanEnv() }),
    );
    log(`launching "${rcName}" in ${dir} (zellij session ${zellijSession})`);

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let pid: number | undefined;
    while (Date.now() < deadline) {
      await sleep(500);
      pid ??= Number((await fsp.readFile(pidFile, "utf8").catch(() => "")).trim()) || undefined;
      if (!pid) continue;
      // A new session has no conversation yet, so the whole screen can be searched.
      const screen = (await this.zellij.screen(zellijSession).catch(() => undefined))?.plain ?? "";
      if (TRUST_PROMPT_RE.test(screen)) {
        await this.zellij.kill(zellijSession);
        return {
          ok: false,
          error: "このフォルダーは、まだ Claude Code に信頼されていません。端末で一度 claude を起動して信頼してから、もう一度試してください。",
        };
      }
      const row = (await listAgents(this.cfg.claudeBin)).find((r) => r.pid === pid && r.sessionId);
      if (row?.sessionId) {
        this.managed.add({ sessionId: row.sessionId, zellijSession, pid, cwd: dir, name: rcName, launchedAt: Date.now() });
        await this.managed.save();
        await fsp.rm(pidFile, { force: true });
        await this.refresh();
        return { ok: true, sessionId: row.sessionId };
      }
      if (!isAlive(pid)) break;
    }
    await this.zellij.kill(zellijSession);
    await fsp.rm(pidFile, { force: true });
    return { ok: false, error: "Claude Code を起動できませんでした（時間内にセッションを確認できませんでした）。" };
  }

  private async input(m: Extract<HubToDaemon, { type: "session.input" }>): Promise<CommandResult> {
    const { sessionId, text, model, effort, ultracode, files } = m;
    if (!this.managed.has(sessionId)) {
      return { ok: false, error: "このセッションには Gasho から入力できません。入力できるのは、Gasho が起動したセッションだけです。" };
    }
    const body = text.trim();
    if (!body && !files?.length) return { ok: false, error: "入力が空です。" };
    if (body.length > MAX_INPUT) return { ok: false, error: `入力が長すぎます（${MAX_INPUT} 文字まで）。` };
    const refused = refusedCommand(body);
    if (refused) return { ok: false, error: refused };
    let message = body;
    if (files?.length) {
      // Claude Code reads the files mentioned as @path when the message is sent.
      const paths = await this.saveAttachments(sessionId, files);
      message = [body, paths.map((p) => `@${p}`).join("\n")].filter(Boolean).join("\n\n");
    }
    this.managed.enqueue(sessionId, {
      id: m.requestId,
      text: message,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
    });
    let outcome: InputOutcome | undefined;
    let failed: string | undefined;
    try {
      // The queue may have held earlier inputs: what happened to those is not this request's to report.
      const flushed = await this.flushInput(sessionId);
      if (flushed?.id === m.requestId) outcome = flushed;
    } catch (e) {
      // The input is back on the queue and is sent later: saying that it failed would invite sending it again.
      log(`could not send the input to ${sessionId} yet`, e);
      failed = "Claude Code の画面を操作できませんでした。入力は待たせてあり、あとで送ります。";
    }
    const queued = this.managed.pending(sessionId) > 0;
    this.emitSessions();
    const warning = [...(outcome?.warnings ?? []), failed].filter(Boolean).join(" ");
    const unapplied = [...new Set(outcome?.unapplied ?? [])];
    return { ok: true, queued, ...(warning ? { warning } : {}), ...(unapplied.length > 0 ? { unapplied } : {}) };
  }

  private attachmentsOf(sessionId: string): string {
    return path.join(this.cfg.attachmentsDir, sessionId);
  }

  /** Saves files sent with an input into the session's attachment folder; returns their paths. */
  private async saveAttachments(sessionId: string, files: InputFile[]): Promise<string[]> {
    const dir = this.attachmentsOf(sessionId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // 20261112T130512
    const paths: string[] = [];
    for (const [i, f] of files.entries()) {
      const file = path.join(dir, `${stamp}-${i + 1}-${safeFileName(f.name)}`);
      await fsp.writeFile(file, Buffer.from(f.data, "base64"), { mode: 0o600, flag: "wx" });
      paths.push(file);
    }
    return paths;
  }

  /** Removes attachment folders of sessions that are no longer running from Gasho. */
  private async pruneAttachments(): Promise<void> {
    const dirs = await fsp.readdir(this.cfg.attachmentsDir).catch(() => [] as string[]);
    for (const d of dirs) {
      if (SESSION_ID_RE.test(d) && !this.managed.has(d)) await fsp.rm(this.attachmentsOf(d), { recursive: true, force: true });
    }
  }

  /** The session's status right now (not the last poll), so input is never typed into a busy session. */
  private async currentStatus(pid: number): Promise<string | undefined> {
    const row = (await listAgents(this.cfg.claudeBin)).find((r) => r.pid === pid);
    return row ? mapStatus(row) : undefined;
  }

  /**
   * Types the next waiting input if the session is idle and no dialog is open. One message per idle period. Returns
   * what happened to the switches asked for with it (undefined when nothing was tried). Throws when a /model picker
   * cannot be closed; the input is then back on the queue.
   */
  private async flushInput(sessionId: string): Promise<InputOutcome | undefined> {
    if (this.flushing.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      const m = this.managed.get(sessionId);
      if (!m || this.managed.pending(sessionId) === 0) return;
      const wait = (this.settleUntil.get(sessionId) ?? 0) - Date.now();
      if (wait > 0) {
        this.scheduleRefresh(wait + 100);
        return;
      }
      this.settleUntil.delete(sessionId);
      if ((await this.currentStatus(m.pid)) !== "idle") {
        // Busy after an Enter that came back "unsure": Claude Code took it.
        const head = this.managed.peek(sessionId);
        if (head?.entered) head.seenBusy = true;
        return;
      }
      const screen = (await this.zellij.screen(m.zellijSession)).plain;
      // A /model picker (or its question) still open, e.g. from an Enter that Claude Code took late: close it first
      // (Esc changes nothing there). Any other dialog, such as a permission request, is the person's to answer.
      if (modelPickerOptions(screen).length > 0 || switchQuestion(screen)) await this.closePicker(m.zellijSession);
      else if (dialogOpen(screen)) return;
      const item = this.managed.next(sessionId);
      if (item === undefined) return;
      const out: InputOutcome = { ...(item.id ? { id: item.id } : {}), warnings: [], unapplied: [] };
      const later = (ms: number, why: string) => {
        this.settleUntil.set(sessionId, Date.now() + ms);
        this.scheduleRefresh(ms + 100);
        log(`${m.name}: ${why}`);
      };
      const t = this.tracked.get(sessionId);
      if (item.entered) {
        // Taken since the Enter: by its transcript when it is followed (the box can hold the text again after a stop),
        // or else by the session having been busy.
        if (t?.tail) await this.pollTails();
        if (t?.tail ? this.promptTaken(sessionId, item.text, item.enteredAt ?? 0) : item.seenBusy) {
          log(`${m.name}: the input whose Enter was late has been taken`);
          this.emitSessions();
          return out;
        }
      }
      let typed: TypeResult;
      const enteredAt = Date.now();
      try {
        if (!item.entered) {
          // Compared with the session's state first, so what an earlier try switched is not switched again.
          const model = item.model && !this.sameModel(t?.info.model, item.model) ? item.model : undefined;
          const effort = item.effort && item.effort !== t?.info.effort ? item.effort : undefined;
          if (model || effort) await this.switchModel(m.zellijSession, model, effort, t, out);
          if (item.ultracode !== undefined && item.ultracode !== t?.info.ultracode) {
            await this.setUltracode(m.zellijSession, item.ultracode, out);
          }
        }
        typed = await this.typeInput(m.zellijSession, item.text, item.entered);
      } catch (e) {
        this.managed.unshift(sessionId, item);
        if (!(e instanceof EnterNotTaken)) throw e;
        later(UNSURE_RETRY_MS, `${e.message}; trying the input again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`Claude Code がすぐに反応しなかったので、${UNSURE_RETRY_MS / 1000} 秒後にやり直します。`);
        this.emitSessions();
        return out;
      }
      // Kept on a retry: the item and its Enter stay as they were.
      const base = { ...(item.id ? { id: item.id } : {}), text: item.text };
      const entered = item.entered ? { entered: true, enteredAt: item.enteredAt ?? enteredAt, ...(item.seenBusy ? { seenBusy: true } : {}) } : {};
      if (typed === "not-typed") {
        // Model, effort and ultracode are switched already; only the text waits for the next try. A text whose Enter
        // was pressed before stays marked so: it must never be pasted again.
        this.managed.unshift(sessionId, { ...base, ...entered });
        later(RETRY_MS, "could not type the input; trying again later");
        out.warnings.push("入力欄に入れられませんでした。少ししてから送り直します。");
      } else if (typed === "unsure") {
        // Enter was pressed, but the box still held the text: Claude Code may take it late. It is never typed again;
        // a later look drops it if it was taken, and presses Enter only if the box still holds it.
        this.managed.unshift(sessionId, { ...base, entered: true, enteredAt: item.enteredAt ?? enteredAt });
        later(UNSURE_RETRY_MS, `the input was not taken yet; looking again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`送ったことを画面で確かめられませんでした。${UNSURE_RETRY_MS / 1000} 秒後に入力欄を見て、まだ残っていれば送ります。`);
      } else {
        this.scheduleRefresh(500);
      }
      this.emitSessions();
      return out;
    } finally {
      this.flushing.delete(sessionId);
    }
  }

  /**
   * Types `text` into Claude Code's prompt box and presses Enter once, checking each step on the screen:
   * - nothing is typed unless the prompt box is shown and no picker or dialog has the keys; the feedback survey above
   *   the box is dismissed ("0");
   * - the box is emptied first (Claude Code may have put a stopped prompt back, or a key may have gone into it);
   * - the text must be in the box before Enter, and the box must let go of it after Enter.
   * Enter is never pressed twice for one paste: if Claude Code takes an Enter late, a second one could land in what
   * the first one opened (Enter in the /model picker saves the default model for every session). With `entered`
   * (an earlier call returned "unsure"), nothing is typed: Enter is pressed again only if the box still holds the text.
   * Returns "sent", "not-typed" (nothing was sent; try again later), or "unsure" (Enter may have been pressed, but the
   * box still holds the text).
   */
  private async typeInput(session: string, text: string, entered = false): Promise<TypeResult> {
    const look = () => this.zellij.screen(session).catch(() => undefined);
    const waitFor = async (done: (s: Screen) => boolean, ms: number): Promise<Screen | undefined> => {
      for (let waited = 0; waited < ms; waited += 150) {
        await sleep(150);
        const s = await look();
        if (s && done(s)) return s;
      }
      return undefined;
    };
    const enter = async (): Promise<TypeResult> => {
      try {
        await this.zellij.keys(session, "Enter");
      } catch (e) {
        // The key may have reached the pane before the call failed.
        log("pressing Enter failed", e);
        return "unsure";
      }
      // Taken: the box lets go of the text (or a picker, such as /model's, takes its place).
      return (await waitFor((s) => !promptHolds(s, text), this.enterWaitMs)) ? "sent" : "unsure";
    };
    const clear = (s: Screen) => this.zellij.keys(session, ...clearPromptKeys(promptBoxLines(s.plain)?.length ?? 1));
    // Right after a picker or a command, Claude Code is still redrawing; wait for the prompt box.
    let ready = await waitFor((s) => typedInBox(s) !== undefined, 3000);
    if (!ready) return "not-typed";
    if (entered) {
      // Taken after all if the box no longer holds the text. Otherwise press Enter, unless the survey has the keys.
      if (!promptHolds(ready, text)) return "sent";
      return surveyOpen(ready.plain) ? "not-typed" : enter();
    }
    if (surveyOpen(ready.plain)) {
      await this.zellij.keys(session, "0");
      // Decide on what the screen shows now: had the survey not taken the "0", it is in the box.
      ready = await waitFor((s) => !surveyOpen(s.plain) && typedInBox(s) !== undefined, 1500);
      if (!ready) return "not-typed";
    }
    if (typedInBox(ready)) {
      await clear(ready);
      if (!(await waitFor((s) => typedInBox(s) === "", 1500))) return "not-typed";
    }
    await this.zellij.paste(session, text);
    // Enter only once the text is in the box. Otherwise an empty box after Enter could not tell "sent" from
    // "never typed" (a redraw can drop a paste).
    if (!(await waitFor((s) => promptHolds(s, text), 2000))) {
      const s = await look();
      if (s && typedInBox(s)) await clear(s);
      return "not-typed";
    }
    return enter();
  }

  /** Waits until the screen satisfies `done` (polling every 200 ms, up to `ms`). */
  private async waitForScreen(
    session: string,
    done: (r: { screen: string; options: PickerOption[] }) => boolean,
    ms = 3000,
  ): Promise<{ screen: string; options: PickerOption[] } | undefined> {
    for (let waited = 0; waited < ms; waited += 200) {
      await sleep(200);
      const s = await this.zellij.screen(session).catch(() => undefined);
      if (!s) continue;
      const r = { screen: s.plain, options: modelPickerOptions(s.plain) };
      if (done(r)) return r;
    }
    return undefined;
  }

  /**
   * Closes the /model picker, and the question it may have asked, with Esc (nothing is changed). Closed means that
   * the prompt box is back and nothing else has the keys; throws when that does not happen, so nothing is typed into
   * them.
   */
  private async closePicker(session: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.zellij.keys(session, "Esc");
      if (await this.waitForScreen(session, (r) => promptBoxLines(r.screen) !== undefined && !dialogOpen(r.screen))) return;
    }
    throw new Error("the /model picker did not close");
  }

  /** After "/model" came back "unsure" from typeInput, Claude Code may still open the picker: close it if it does. */
  private async closeLatePicker(session: string): Promise<void> {
    const opened = await this.waitForScreen(session, (r) => r.options.length > 0 || switchQuestion(r.screen) !== undefined, LATE_PICKER_WAIT_MS);
    if (opened) await this.closePicker(session);
  }

  /**
   * Switches the model and/or the effort level for this session only, through Claude Code's /model picker: the
   * cursor is moved to the model (it starts on the current one), ←/→ step the effort level, and "s" applies both to
   * this session only. Enter would save them as the default for every new session, so Enter is never pressed while
   * the picker is open. What could not be switched goes into `out`. Throws EnterNotTaken when Claude Code did not
   * take the Enter of "/model", and an Error when the picker cannot be closed.
   */
  private async switchModel(
    session: string,
    model: SessionModel | undefined,
    effort: EffortLevel | undefined,
    t: Tracked | undefined,
    out: InputOutcome,
  ): Promise<void> {
    // Nothing is switched: the session keeps its model and effort level.
    const kept = (why: string) => {
      out.warnings.push(`${why}${model && effort ? "いまのモデルと Effort" : model ? "いまのモデル" : "いまの Effort"}のまま送ります。`);
      if (model) out.unapplied.push("model");
      if (effort) out.unapplied.push("effort");
    };
    const giveUp = async (why: string) => {
      await this.closePicker(session);
      kept(why);
    };
    const switchesBefore = t?.meta.sessionSwitches ?? 0;
    const typed = await this.typeInput(session, "/model");
    if (typed === "unsure") throw new EnterNotTaken("/model");
    if (typed === "not-typed") return kept("モデルの選択画面を開けませんでした。");
    const opened = await this.waitForScreen(session, (r) => r.options.length > 0);
    if (!opened) return giveUp("モデルの選択画面を開けませんでした。");
    await this.rememberModels(opened.screen);

    const cursorAt = opened.options.findIndex((o) => o.cursor);
    let target = cursorAt;
    if (model) {
      target = opened.options.findIndex((o) => pickerMatches(o.label, model));
      if (target < 0) return giveUp(`${this.modelName(model)} はこのセッションでは選べません。`);
      const steps = target - Math.max(0, cursorAt);
      if (steps !== 0) await this.zellij.keys(session, ...Array<string>(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up"));
      if (!(await this.waitForScreen(session, (r) => r.options[target]?.cursor === true))) return giveUp("モデルを選べませんでした。");
    } else if (!opened.options[cursorAt]?.current) {
      // Effort only: "s" applies the model under the cursor too, so it must be the one the session uses (✔).
      return giveUp("選択画面で、いまのモデルが見つかりませんでした。");
    }
    // The effort level the picker must show when "s" is pressed (undefined: the picker shows none).
    let level: EffortLevel | undefined;
    if (effort) {
      const r = await this.stepEffort(session, effort);
      level = r.level;
      if (r.outcome !== "set") {
        const why = `Effort を ${EFFORT_NAMES[effort]} にできませんでした${r.outcome === "unsupported" ? "（このモデルでは選べません）" : ""}。`;
        if (r.outcome === "lost" || !model) return giveUp(why);
        // The level is as it was; the model is still switched.
        out.warnings.push(`${why}モデルだけ切り替えます。`);
        out.unapplied.push("effort");
      }
    }
    // Right before "s": the cursor must still be on the row to apply, and the picker must show the level to apply (an
    // arrow key taken late would have changed it).
    const ready = await this.waitForScreen(
      session,
      (r) => r.options[target]?.cursor === true && (level === undefined || pickerEffort(r.screen) === level),
    );
    if (!ready) return giveUp("モデルを選べませんでした。");
    await this.zellij.keys(session, "s");
    // In a conversation Claude Code has cached, switching asks first, because the whole history is read again. The
    // switch was asked for in Gasho, so the answer is "Yes" (still for this session only). Any other question with
    // the same choices (a hook may ask to confirm) is for the person, and the switch is cancelled.
    // Done when the transcript records a new "… for this session only" (the screen can still show earlier ones);
    // a session whose transcript is not followed yet falls back to the output of the latest /model on the screen.
    let note: string | undefined;
    let answered = false;
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      await sleep(200);
      const s = await this.zellij.screen(session).catch(() => undefined);
      if (!s) continue;
      const question = switchQuestion(s.plain);
      if (question) {
        if (answered) continue; // answered already; the question is going away
        if (!question.aboutCache || !question.onYes) return giveUp("Claude Code が切り替えの確認を求めたので、切り替えませんでした。");
        await this.zellij.keys(session, "Enter");
        answered = true;
        note = `${model ? "モデル" : "Effort "}を切り替えたので、次の返答では会話の履歴を読み直します（時間とトークンが多くかかります）。`;
        continue;
      }
      if (dialogOpen(s.plain) || !promptBoxLines(s.plain)) continue;
      if (t?.tail) await this.pollTails();
      done = t?.tail ? (t.meta.sessionSwitches ?? 0) > switchesBefore : switchedForSession(s.plain);
    }
    if (!done) {
      await this.closePicker(session);
      out.warnings.push("モデルと Effort を切り替えられたか確かめられませんでした。");
      return;
    }
    if (note) out.warnings.push(note);
  }

  /**
   * Steps the /model picker's effort level to `to` with ←/→, one press at a time, reading the picker after each: a
   * model may lack some levels, and the picker then skips them. When `to` cannot be reached, the level is put back.
   * `outcome` — "set": done; "unsupported": the model does not have `to` (put back as it was); "unread": the picker
   * shows no effort level (nothing pressed); "lost": the level could not be put back. `level`: what the picker shows
   * at the end, when known.
   */
  private async stepEffort(
    session: string,
    to: EffortLevel,
  ): Promise<{ outcome: "set" | "unsupported" | "unread" | "lost"; level?: EffortLevel }> {
    const at = (e: EffortLevel) => EFFORT_LEVELS.indexOf(e);
    const walk = async (from: EffortLevel, goal: EffortLevel): Promise<EffortLevel> => {
      let now = from;
      for (let i = 0; i < EFFORT_LEVELS.length && now !== goal; i++) {
        await this.zellij.keys(session, at(goal) > at(now) ? "Right" : "Left");
        const moved = await this.waitForScreen(
          session,
          (r) => {
            const e = pickerEffort(r.screen);
            return e !== undefined && e !== now;
          },
          1500,
        );
        const next = moved && pickerEffort(moved.screen);
        if (!next) break; // it did not move: the last level in that direction
        const passed = (at(next) - at(goal)) * (at(now) - at(goal)) < 0;
        now = next;
        if (passed) break; // the model skips `goal`
      }
      return now;
    };
    const before = pickerEffort((await this.waitForScreen(session, () => true))?.screen ?? "");
    if (!before) return { outcome: "unread" };
    const reached = await walk(before, to);
    if (reached === to) return { outcome: "set", level: to };
    if (reached === before) return { outcome: "unsupported", level: before };
    const back = await walk(reached, before);
    return back === before ? { outcome: "unsupported", level: before } : { outcome: "lost" };
  }

  /**
   * Turns ultracode on or off for this session only (`/effort ultracode on|off`; the effort level stays). Throws
   * EnterNotTaken when Claude Code did not take the command's Enter.
   */
  private async setUltracode(session: string, on: boolean, out: InputOutcome): Promise<void> {
    const failed = () => {
      out.warnings.push(`Ultracode を${on ? "オン" : "オフ"}にできませんでした。`);
      out.unapplied.push("ultracode");
    };
    const typed = await this.typeInput(session, `/effort ultracode ${on ? "on" : "off"}`);
    if (typed === "unsure") throw new EnterNotTaken("/effort ultracode");
    if (typed === "not-typed") return failed();
    // The mark in the rule above the prompt box must show the new state twice in a row: a frame being redrawn can
    // lack the rule's label for a moment.
    let seen = 0;
    const done = await this.waitForScreen(session, (r) => {
      seen = promptRuleUltracode(r.screen) === on ? seen + 1 : 0;
      return seen >= 2;
    });
    if (!done) failed();
  }

  /**
   * Opens the /model picker only to read the model names, and closes it again without changing anything (Esc).
   * "unsure": Claude Code did not take the Enter of "/model" in time, and may still open the picker.
   */
  private async probeModels(session: string): Promise<"read" | "not-read" | "unsure"> {
    const typed = await this.typeInput(session, "/model");
    if (typed === "not-typed") return "not-read";
    if (typed === "unsure") {
      await this.closeLatePicker(session);
      return "unsure";
    }
    const opened = await this.waitForScreen(session, (r) => r.options.length > 0);
    const read = opened ? await this.rememberModels(opened.screen) : false;
    await this.closePicker(session);
    return read ? "read" : "not-read";
  }

  private async interrupt(sessionId: string): Promise<CommandResult> {
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは Gasho から止められません。公式アプリで止めてください。" };
    if ((await this.currentStatus(m.pid)) !== "busy") return { ok: false, error: "作業中ではありません。" };
    // An input whose Enter came back "unsure" has been taken if the session is busy: it must not be sent again when
    // Claude Code puts the stopped text back into the box.
    const head = this.managed.peek(sessionId);
    if (head?.entered) head.seenBusy = true;
    await this.zellij.keys(m.zellijSession, "Esc");
    this.settleUntil.set(sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    this.scheduleRefresh(500);
    return { ok: true };
  }
}

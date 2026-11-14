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
  PermissionRequestInfo,
  SessionInfo,
  SessionModel,
  SessionRepo,
  SwitchField,
  TranscriptEntry,
} from "@gasho/protocol";
import type { DaemonConfig } from "./config.ts";
import { listDir, readFileAt, writeFileAt } from "./files.ts";
import { cloneRepo, createFolder } from "./folders.ts";
import { githubRepoOf, nestedRepos, readGitGraph } from "./git.ts";
import { TokenCounter } from "./tokens.ts";
import { startHookServer, summarizeHook } from "./hooks.ts";
import { HubClient } from "./hub-client.ts";
import { answersMessage, OPEN_QUESTION, openQuestionRequest, PermissionRequests, questionAnswers } from "./permissions.ts";
import {
  atBottom,
  bannerModel,
  bottomLines,
  cleanEnv,
  clearPromptKeys,
  dialogOpen,
  EFFORT_LEVELS,
  forkName,
  isAlive,
  isRename,
  launchableFolders,
  ManagedSessions,
  mcpQuestionOpen,
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
  renameCommand,
  resumeQuestionOpen,
  safeFileName,
  type Screen,
  sessionName,
  shellInputProblem,
  statusLine,
  surveyOpen,
  switchedForSession,
  switchQuestion,
  titleName,
  TRUST_PROMPT_RE,
  trustQuestion,
  typedInBox,
  Zellij,
  terminalName,
} from "./managed.ts";
import { findTranscript, listAgents, mapStatus, rcModeOf, readRegistry, type AgentRow } from "./sessions.ts";
import { SessionTerminals, Terminals } from "./terminal.ts";
import { emptyMeta, readTranscript, TranscriptTail, type TranscriptMeta } from "./transcript.ts";
import type { SessionWire } from "./plugin-ipc.ts";
import { PluginRunner } from "./plugins.ts";
import { log } from "./util.ts";

export const DAEMON_VERSION = "0.13.0";
const GITHUB_CACHE_MS = 5 * 60_000;
/** How long the list of repositories inside a folder (and their branches) is reused. */
const REPOS_CACHE_MS = 60_000;
const FOLDERS_REFRESH_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** A fork: how long Claude Code may take to show its prompt box once it runs, and then to write the copy's transcript. */
const FORK_READY_MS = 15_000;
const FORK_TRANSCRIPT_MS = 5000;
/** Removing a session: how long Claude Code may take to end after SIGTERM (Remote Control sessions take a moment). */
const REMOVE_WAIT_MS = 8000;
const MAX_INPUT = 20_000;
const INTERRUPT_SETTLE_MS = 1500;
/** Claude Code's question dialog (AskUserQuestion, 2.1.325), at the bottom of the screen: its last choice. */
const QUESTION_DIALOG_RE = /Chat about this/;
/** Said when this machine cannot make a terminal for a session (see terminalWorks). */
const NO_TERMINAL =
  "この working server では、セッションの端末（node-pty）を用意できないので、セッションを起動できません。gasho-daemon の doctor で確かめてください。";
/** Said when Claude Code asked about a folder's new MCP servers while starting, and was answered "not now". */
const MCP_DECLINED =
  "このフォルダーの .mcp.json にある MCP サーバーは、使わない設定にして起動しました（Claude Code の確認に「使わない」と答えました）。使うときは、端末で claude を起動して /mcp から有効にしてください。";
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
/** …for what gasho-daemon sends on its own, which waits while the prompt box holds text (someone may be typing). */
const AUTO_RETRY_MS = 30_000;
/** How long to watch for a /model picker that Claude Code may still open (see closeLatePicker). */
const LATE_PICKER_WAIT_MS = 10_000;
/** A session is used to read the model names only once it has run this long (Claude Code has finished starting). */
const PROBE_MIN_AGE_MS = 30_000;
/** An idle session's tokens are counted again after this long (a working one at every refresh). */
const TOKENS_IDLE_MS = 30_000;
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
  /** Sessions started from Gasho: the model in Claude Code's welcome banner, until the transcript records one. */
  bannerModel?: string;
  /** Sessions started from Gasho: the tokens they used, and when they were last counted. */
  tokens?: TokenCounter;
  tokensAt?: number;
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
  /** The terminals of the sessions Gasho started (built-in; zellij for those from gasho-daemon 0.10 and before). */
  private terminals: SessionTerminals;
  private managed: ManagedSessions;
  /** Permission requests held until they are answered (in Gasho, or elsewhere). */
  private permissions = new PermissionRequests(() => this.emitSessions());
  private canLaunch = false;
  private folders: string[] = [];
  private flushing = new Set<string>();
  /** Sessions whose /rename to the name from the first message was sent, until Claude Code records it (nameAfterTitle). */
  private titleSent = new Set<string>();
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
  /** The daemon parts of plugins (docs/plugins.md). */
  private plugins: PluginRunner;

  /** How long the prompt box may take to let go of a text after Enter (see typeInput). */
  private enterWaitMs: number;

  constructor(cfg: DaemonConfig, opts: { enterWaitMs?: number } = {}) {
    this.cfg = cfg;
    this.enterWaitMs = opts.enterWaitMs ?? ENTER_WAIT_MS;
    this.terminals = new SessionTerminals(new Terminals({ stateDir: cfg.stateDir, env: cleanEnv() }), new Zellij(cleanEnv()));
    this.managed = new ManagedSessions(path.join(cfg.stateDir, "managed.json"));
    this.plugins = new PluginRunner({
      cacheDir: cfg.pluginCacheDir,
      send: (m) => this.hub.send(m),
      machine: () => ({ id: cfg.machineId, name: os.hostname() }),
      session: (id) => this.pluginSession(id),
      folders: () => this.folders,
      dataDir: cfg.pluginDataDir,
      enabled: cfg.runPlugins,
      log: (s) => log(s),
    });
    this.hub = new HubClient({
      url: cfg.hubUrl,
      hello: () => ({ type: "hello", machineId: cfg.machineId, token: cfg.token, daemonVersion: DAEMON_VERSION }),
      onReady: () => {
        this.lastSent = "";
        this.emitSessions();
        this.emitCapabilities();
        // Also tells the Gasho server that this gasho-daemon runs plugins.
        this.plugins.status(true);
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
    this.canLaunch = await this.terminals.builtIn.available();
    if (!this.canLaunch) log("no pseudo-terminal on this machine (node-pty did not load); sessions cannot be started from Gasho");
    // The sessions started before this daemon: those whose Claude Code and terminal still run are kept.
    const live = await this.terminals.builtIn.live();
    let inZellij: Set<string> | undefined;
    await this.managed.load(async (m) => {
      if (!isAlive(m.pid)) return false;
      if (!m.zellij) return live.get(m.terminal)?.pid === m.pid;
      inZellij ??= (await this.terminals.zellij.available()) ? await this.terminals.zellij.liveSessions() : new Set();
      if (!inZellij.has(m.terminal)) return false;
      this.terminals.useZellij(m.terminal);
      return true;
    });
    const old = this.managed.all().filter((m) => m.zellij).length;
    if (old > 0) log(`${old} session(s) started by gasho-daemon 0.10 or before still run in zellij; they are used through zellij until they end`);
    // Not closed: a terminal that no record names may still be someone's work (`gasho-daemon attach` shows it).
    const kept = new Set(this.managed.all().map((m) => m.terminal));
    for (const [name, h] of live) {
      if (!kept.has(name)) log(`terminal ${name} (pid ${h.pid}, ${h.cwd}) is not one of the sessions Gasho keeps; it is left as it is`);
    }
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
      onPermissionRequest: (payload, reply) => {
        const id = this.permissions.add(payload, reply);
        return id ? () => this.permissions.dropped(id) : undefined;
      },
      onEvent: (payload) => {
        this.permissions.observe(payload);
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
        if (seen.has(id)) continue;
        this.tracked.delete(id);
        this.permissions.settleSession(id);
      }
      await this.forgetEndedSessions(seen);
      await this.readManagedScreens();
      await this.countTokens();
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

  /** Managed sessions whose Claude Code has exited: drop them and close their terminal. */
  private async forgetEndedSessions(seen: Set<string>): Promise<void> {
    let changed = false;
    for (const m of this.managed.all()) {
      if (seen.has(m.sessionId) || isAlive(m.pid)) continue;
      this.managed.remove(m.sessionId);
      for (const map of [this.settleUntil, this.latePicker, this.prompts, this.titleSent]) map.delete(m.sessionId);
      await this.terminals.kill(m.terminal);
      await fsp.rm(this.attachmentsOf(m.sessionId), { recursive: true, force: true });
      log(`session ${m.name} ended; closed its terminal ${m.terminal}`);
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
    this.permissions.status(info.sessionId, info.status);
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
    info.model = meta.model ?? t.bannerModel;
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

  /**
   * The session a plugin's call names, as this daemon tracks it: its folder, and the repositories found inside it. A
   * plugin never gets a folder the browser named, only these (see PluginRunner).
   */
  private async pluginSession(sessionId: string): Promise<SessionWire | undefined> {
    const t = this.tracked.get(sessionId);
    if (!t) return undefined;
    const name = this.managed.get(sessionId)?.name ?? t.info.name;
    const repos = (await this.reposOf(t.info.cwd)) ?? [];
    return {
      sessionId,
      cwd: t.info.cwd,
      ...(name ? { name } : {}),
      managed: Boolean(this.managed.get(sessionId)),
      ...(t.info.github ? { github: t.info.github } : {}),
      ...(t.info.gitBranch ? { gitBranch: t.info.gitBranch } : {}),
      repos: repos.map((r) => ({ path: r.path, ...(r.github ? { github: r.github } : {}), ...(r.branch ? { branch: r.branch } : {}) })),
    };
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
        // What gasho-daemon sends on its own (a name from the first message) is nobody's input waiting.
        const pending = this.managed.waiting(t.info.sessionId).filter((input) => !input.auto).length;
        // A session started from Gasho keeps the name it was given (also its Remote Control name).
        return {
          ...t.info,
          name: m?.name ?? t.info.name,
          managed: m ? true : undefined,
          pendingInputs: pending || undefined,
          permissionRequests: this.permissions.of(t.info.sessionId) ?? this.openQuestion(t),
        };
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
    this.plugins.foldersChanged();
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
      const screen = (await this.terminals.screen(m.terminal).catch(() => undefined))?.plain ?? "";
      const state = statusLine(screen);
      if (state) {
        t.info.effort = state.effort;
        t.info.ultracode = state.ultracode;
      }
      const ultracode = promptRuleUltracode(screen);
      if (ultracode !== undefined) t.info.ultracode = ultracode;
      // Before the first message, the transcript does not say which model the session uses; the banner does.
      if (!t.meta.model) {
        const banner = bannerModel(screen);
        if (banner) t.bannerModel = t.info.model = banner;
      }
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

  /** Sessions started from Gasho: the tokens they have used, read from their transcripts and their subagents'. */
  private async countTokens(): Promise<void> {
    const now = Date.now();
    for (const m of this.managed.all()) {
      const t = this.tracked.get(m.sessionId);
      if (!t?.transcript) continue;
      // A fork's transcript starts with a copy of the conversation it was forked from: not this session's tokens.
      t.tokens ??= new TokenCounter(t.transcript, { since: m.forkedAt });
      if (t.info.status !== "busy" && t.tokensAt !== undefined && now - t.tokensAt < TOKENS_IDLE_MS) continue;
      t.tokensAt = now;
      try {
        await t.tokens.update();
      } catch (e) {
        log(`could not count the tokens of ${m.name}`, e);
      }
      t.info.tokens = t.tokens.totals();
      t.info.tokenHours = t.tokens.hours(now);
    }
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
      await this.closePicker(m.terminal);
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
      if (typedInBox(await this.terminals.screen(m.terminal)) !== "") return;
      const result = await this.probeModels(m.terminal);
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
        const named = t.meta.customTitle;
        const entries = await t.tail.poll(t.meta);
        if (t.meta.customTitle !== named && (await this.followName(t))) changed = true;
        if (await this.nameAfterTitle(t)) changed = true;
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

  /**
   * A session started from Gasho takes the name Claude Code has just recorded for it (`custom-title`): the one asked
   * for with /rename, or another when a live session on this machine holds that name already, or one given in the
   * session's own terminal. Not while a /rename asked for from Gasho still waits: the newer name would be undone until
   * it is sent. A name from the first message still waiting gives way instead: it is not sent.
   * Only names recorded while the transcript is followed count, never older ones (a fork's copy may hold its source's).
   */
  private async followName(t: Tracked): Promise<boolean> {
    const id = t.info.sessionId;
    const recorded = t.meta.customTitle;
    if (!recorded || !this.managed.has(id)) return false;
    if (this.managed.waiting(id).some((input) => isRename(input.text) && !input.auto)) return false;
    const checked = sessionName(recorded);
    if ("error" in checked) return false;
    const dropped = this.managed.drop(id, (input) => Boolean(input.auto) && isRename(input.text));
    const named = this.managed.named(id);
    const renamed = this.managed.setName(id, checked.name);
    if (!dropped && !named && !renamed) return false;
    if (renamed) log(`${id} is now named "${checked.name}" (recorded by Claude Code)`);
    await this.managed.save().catch((e) => log("could not save the managed sessions", e));
    return true;
  }

  /**
   * A session started from Gasho without a name is named after its first message, with the title Claude Code gives the
   * conversation from it (`ai-title`, recorded once, soon after the first message): in Gasho at once, and in Claude
   * Code with /rename (also its Remote Control name, so the name in the official apps), sent like an input once the
   * session is idle, but never over text in the prompt box. Done once Claude Code records a name (followName), so only
   * once, and not when it was named otherwise first; a /rename lost with a restart of gasho-daemon is sent again.
   */
  private async nameAfterTitle(t: Tracked): Promise<boolean> {
    const id = t.info.sessionId;
    if (!this.managed.get(id)?.autoName || !t.meta.title) return false;
    if (t.meta.customTitle) {
      // Named in Claude Code already (seen when the transcript is read anew, as after a restart of gasho-daemon).
      if (this.managed.named(id)) await this.managed.save().catch((e) => log("could not save the managed sessions", e));
      return false;
    }
    // Sent, or waiting to be.
    if (this.titleSent.has(id) || this.managed.waiting(id).some((input) => input.auto)) return false;
    const name = titleName(t.meta.title);
    if (!name) return false;
    const renamed = this.managed.setName(id, name);
    this.managed.enqueue(id, { text: renameCommand(name), auto: true });
    if (renamed) {
      log(`${id} is named "${name}" after its first message`);
      await this.managed.save().catch((e) => log("could not save the managed sessions", e));
    }
    // Usually still busy with the first message: then a refresh once it is done sends the /rename.
    void this.flushInput(id).catch((e) => log(`could not send /rename to ${id} yet`, e));
    return renamed;
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
      case "plugins":
        this.plugins.update(m.plugins);
        return;
      case "plugin.code":
        this.plugins.onCode(m);
        return;
      case "plugin.request":
        return this.plugins.request(m);
      case "transcript.get":
        return this.sendTranscriptPage(m);
      case "git.graph.get":
        return this.sendGitGraph(m);
      case "dir.get":
        return this.sendDir(m);
      case "file.get":
        return this.sendFile(m);
      case "session.launch":
      case "session.input":
      case "session.interrupt":
      case "session.rename":
      case "session.fork":
      case "session.remove":
      case "permission.answer":
      case "folder.create":
      case "repo.clone":
      case "file.write": {
        let result: CommandResult;
        try {
          switch (m.type) {
            case "session.launch":
              result = await this.launch(m.cwd, m.name, m.trust === true);
              break;
            case "session.input":
              result = await this.input(m);
              break;
            case "session.interrupt":
              result = await this.interrupt(m.sessionId);
              break;
            case "session.rename":
              result = await this.rename(m.sessionId, m.name, m.requestId);
              break;
            case "session.fork":
              result = await this.fork(m.sessionId, m.name);
              break;
            case "session.remove":
              result = await this.remove(m.sessionId);
              break;
            case "permission.answer": {
              if (m.permissionId.startsWith(OPEN_QUESTION)) {
                result = await this.answerQuestion(m);
                break;
              }
              const error = this.permissions.answer(m.sessionId, m.permissionId, m.decision, { answers: m.answers, mode: m.mode, message: m.message });
              result = error ? { ok: false, error } : { ok: true };
              break;
            }
            case "folder.create":
              result = await this.createFolder(m.parent, m.name);
              break;
            case "repo.clone":
              result = await this.cloneRepo(m.parent, m.repo, m.name);
              break;
            case "file.write":
              result = await this.writeFile(m);
              break;
          }
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

  // ---- the files of a session's folder ----

  /** The entries of a folder inside a session's folder (see files.ts). Only the folder of a session this daemon tracks. */
  private async sendDir(m: Extract<HubToDaemon, { type: "dir.get" }>): Promise<void> {
    const reply = { type: "dir" as const, requestId: m.requestId, sessionId: m.sessionId, path: m.path };
    const root = this.tracked.get(m.sessionId)?.info.cwd;
    const dir = root ? await listDir(root, m.path).catch((e: unknown) => ({ error: String(e) })) : { error: "このセッションは見つかりません。" };
    this.hub.send("error" in dir ? { ...reply, error: dir.error } : { ...reply, dir });
  }

  /** A file inside a session's folder: its text, an image's data, or what kind of file it is (see files.ts). */
  private async sendFile(m: Extract<HubToDaemon, { type: "file.get" }>): Promise<void> {
    const reply = { type: "file" as const, requestId: m.requestId, sessionId: m.sessionId, path: m.path };
    const root = this.tracked.get(m.sessionId)?.info.cwd;
    const file = root ? await readFileAt(root, m.path).catch((e: unknown) => ({ error: String(e) })) : { error: "このセッションは見つかりません。" };
    this.hub.send("error" in file ? { ...reply, error: file.error } : { ...reply, file });
  }

  /** Writes a text file inside a session's folder, or makes one (see files.ts). */
  private async writeFile(m: Extract<HubToDaemon, { type: "file.write" }>): Promise<CommandResult> {
    const root = this.tracked.get(m.sessionId)?.info.cwd;
    if (!root) return { ok: false, error: "このセッションは見つかりません。" };
    const written = await writeFileAt(root, m.path, m.content, { baseHash: m.baseHash, create: m.create === true });
    if ("error" in written) return { ok: false, error: written.error, ...(written.conflict ? { conflict: true } : {}) };
    log(`${m.create ? "made" : "wrote"} ${path.join(root, m.path)} (${written.size} bytes)`);
    return { ok: true, written };
  }

  // ---- sessions started by Gasho ----

  /**
   * Starts `claude --remote-control` in `cwd` in a terminal of its own and waits for its session id. With `trust`,
   * Claude Code's question whether to trust the folder is answered with yes; without it, the launch stops there.
   */
  private async launch(cwd: string, name: string | undefined, trust = false): Promise<CommandResult> {
    if (!this.canLaunch) return { ok: false, error: NO_TERMINAL };
    const dir = path.resolve(cwd);
    const stat = await fsp.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return { ok: false, error: `フォルダーがありません：${dir}` };
    // Without a name, "<folder>-gasho" until the first message names it (see nameAfterTitle).
    const autoName = !name?.trim();
    const rcName = name?.trim() || `${path.basename(dir)}-gasho`;
    const started = await this.startClaude(dir, rcName, { trust });
    if ("error" in started) {
      const { error, needsTrust, trustWarnings } = started;
      return needsTrust ? { ok: false, error, needsTrust, trustWarnings } : { ok: false, error };
    }
    const { sessionId, terminal, pid } = started;
    this.managed.add({ sessionId, terminal, pid, cwd: dir, name: rcName, launchedAt: Date.now(), ...(autoName ? { autoName } : {}) });
    await this.managed.save();
    await this.refresh();
    // A folder trusted just now is one to offer from now on.
    void this.refreshFolders();
    return started.mcpDeclined ? { ok: true, sessionId, warning: MCP_DECLINED } : { ok: true, sessionId };
  }

  /** Makes a folder for a session to start in (see folders.ts). */
  private async createFolder(parent: string, name: string): Promise<CommandResult> {
    const made = await createFolder(parent, name);
    if ("error" in made) return { ok: false, error: made.error };
    log(`made the folder ${made.path}`);
    return { ok: true, path: made.path };
  }

  /** Clones a GitHub repository for a session to start in, with this machine's GitHub CLI (see folders.ts). */
  private async cloneRepo(parent: string, repo: string, name: string | undefined): Promise<CommandResult> {
    log(`cloning ${repo} into ${parent}`);
    const made = await cloneRepo(this.cfg.ghBin, parent, repo, name);
    if ("error" in made) {
      log(`could not clone ${repo}: ${made.error}`);
      return { ok: false, error: made.error };
    }
    log(`cloned ${repo} into ${made.path}`);
    return { ok: true, path: made.path };
  }

  /**
   * Starts `claude --remote-control <rcName> [claudeArgs…]` in `dir` in a new terminal, and waits until
   * `claude agents` lists it with a session id (one that `accept` takes). With `resuming`, Claude Code's question about
   * resuming an old, long session is answered with Esc (the full session, as it is; see resumeQuestionOpen), and
   * `resumeAsked` says so. Claude Code's question whether to trust the folder is answered with yes only when `trust`
   * is given; otherwise nothing is started, and `needsTrust` says why. Its question about the folder's new MCP servers
   * is answered with Esc: Gasho starts no MCP server that nobody has looked at (`mcpDeclined`; see mcpQuestionOpen).
   * On failure, the terminal is closed.
   */
  private async startClaude(
    dir: string,
    rcName: string,
    {
      claudeArgs = [],
      accept = () => true,
      resuming = false,
      trust = false,
    }: { claudeArgs?: string[]; accept?: (row: AgentRow) => boolean; resuming?: boolean; trust?: boolean } = {},
  ): Promise<
    | { sessionId: string; terminal: string; pid: number; resumeAsked: boolean; mcpDeclined: boolean }
    | { error: string; needsTrust?: true; trustWarnings?: string[] }
  > {
    const terminal = terminalName(rcName);
    let pid: number;
    try {
      pid = await this.terminals.start({
        name: terminal,
        cwd: dir,
        file: this.cfg.claudeBin,
        args: ["--remote-control", rcName, ...claudeArgs],
        env: cleanEnv(),
      });
    } catch (e) {
      log(`could not start a terminal for "${rcName}"`, e);
      return { error: "Claude Code を起動できませんでした（端末を用意できませんでした）。" };
    }
    log(`launching "${rcName}" in ${dir} (terminal ${terminal})${claudeArgs.length > 0 ? ` with ${claudeArgs.join(" ")}` : ""}`);

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let resumeAsked = false;
    let mcpDeclined = false;
    while (Date.now() < deadline) {
      await sleep(500);
      // The dialogs are drawn at the bottom, in place of the prompt box. A conversation being resumed can quote their
      // words above it, so only a dialog that has the keys counts.
      const screen = (await this.terminals.screen(terminal).catch(() => undefined))?.plain ?? "";
      const question = trustQuestion(screen);
      if (question || (dialogOpen(screen) && atBottom(screen, TRUST_PROMPT_RE))) {
        if (!trust) {
          await this.terminals.kill(terminal);
          return { error: "このフォルダーは、まだ Claude Code に信頼されていません。", needsTrust: true, trustWarnings: question?.warnings ?? [] };
        }
        if (!question || !(await this.answerTrust(terminal).then(() => true, () => false))) {
          await this.terminals.kill(terminal);
          return {
            error:
              "Claude Code の「このフォルダーを信頼するか」の確認に答えられませんでした。端末で一度 claude を起動して信頼してから、もう一度試してください。",
          };
        }
        log(`"${rcName}": trusted ${dir} in Claude Code, as asked from Gasho`);
        continue;
      }
      if (mcpQuestionOpen(screen)) {
        if (!(await this.answerMcpQuestion(terminal).then(() => true, () => false))) {
          await this.terminals.kill(terminal);
          return { error: "Claude Code が、このフォルダーの MCP サーバーを使うかを尋ねたまま、答えを受け付けませんでした。" };
        }
        mcpDeclined = true;
        log(`"${rcName}": started without the new MCP servers of ${dir}`);
        continue;
      }
      if (resuming && resumeQuestionOpen(screen)) {
        resumeAsked = true;
        if (!(await this.answerResumeQuestion(terminal).then(() => true, () => false))) {
          await this.terminals.kill(terminal);
          return { error: "Claude Code が会話を要約から始めるかを尋ねたまま、答えを受け付けませんでした。" };
        }
        continue;
      }
      const row = (await listAgents(this.cfg.claudeBin)).find((r) => r.pid === pid && r.sessionId);
      if (row?.sessionId && accept(row)) return { sessionId: row.sessionId, terminal, pid, resumeAsked, mcpDeclined };
      if (!isAlive(pid)) break;
    }
    const last = (await this.terminals.screen(terminal).catch(() => undefined))?.plain;
    if (last) log(`"${rcName}" did not start; the end of its screen:\n${bottomLines(last, 8).join("\n")}`);
    await this.terminals.kill(terminal);
    return { error: "Claude Code を起動できませんでした（時間内にセッションを確認できませんでした）。" };
  }

  /**
   * Answers Claude Code's question whether to trust the folder with "Yes, I trust this folder": the cursor is moved
   * there one key at a time, reading the screen after each, and Enter is pressed only once it is there, and only once.
   * Throws when the question does not take the answer.
   */
  private async answerTrust(session: string): Promise<void> {
    for (let step = 0; step < 6; step++) {
      const q = trustQuestion((await this.terminals.screen(session)).plain);
      if (!q) throw new Error("the trust question is not on the screen");
      if (q.onYes) {
        await this.terminals.keys(session, "Enter");
        if (await this.waitForScreen(session, (r) => trustQuestion(r.screen) === undefined, 5000)) return;
        throw new Error("the trust question did not close");
      }
      await this.terminals.keys(session, q.yesBelow ? "Down" : "Up");
      await this.waitForScreen(session, (r) => trustQuestion(r.screen)?.onYes === true, 1500);
    }
    throw new Error('the cursor did not reach "Yes, I trust this folder"');
  }

  /** Esc to the question about a folder's new MCP servers (see mcpQuestionOpen); throws if it stays open. */
  private async answerMcpQuestion(session: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.terminals.keys(session, "Esc");
      if (await this.waitForScreen(session, (r) => !mcpQuestionOpen(r.screen))) return;
    }
    throw new Error("the question about MCP servers did not close");
  }

  /** Esc to the question about resuming an old, long session (see resumeQuestionOpen); throws if it stays open. */
  private async answerResumeQuestion(session: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.terminals.keys(session, "Esc");
      if (await this.waitForScreen(session, (r) => !resumeQuestionOpen(r.screen))) return;
    }
    throw new Error("the question about resuming the session did not close");
  }

  /**
   * Forks a session started from Gasho: `claude --remote-control <name> --resume <id> --fork-session` in its folder, in
   * a new terminal. The copy starts with the conversation so far; the session itself goes on as it was. Claude
   * Code writes a fork's transcript only once something is recorded, so the copy is named with /rename right away:
   * that names it in Claude Code too (the Remote Control name is set already), and its conversation can be read at once.
   */
  private async fork(sessionId: string, name: string | undefined): Promise<CommandResult> {
    const source = this.managed.get(sessionId);
    if (!source) return { ok: false, error: "このセッションはフォークできません。フォークできるのは、Gasho が起動したセッションだけです。" };
    if (!this.canLaunch) return { ok: false, error: NO_TERMINAL };
    const checked = sessionName(name?.trim() ? name : forkName(source.name));
    if ("error" in checked) return { ok: false, error: checked.error };
    if (!(this.tracked.get(sessionId)?.transcript ?? (await findTranscript(this.cfg.claudeDir, sessionId)))) {
      return { ok: false, error: "このセッションには、まだ会話がありません。最初の発言のあとでフォークしてください。" };
    }
    const forkedAt = Date.now();
    const started = await this.startClaude(source.cwd, checked.name, {
      claudeArgs: ["--resume", sessionId, "--fork-session"],
      // The copy gets its own id; never take the session it was forked from for it.
      accept: (row) => row.sessionId !== sessionId,
      resuming: true,
    });
    if ("error" in started) {
      // Only the launcher asks whether to trust a folder; a fork does not.
      const error = started.needsTrust
        ? "このフォルダーは、もう Claude Code に信頼されていません。「新しいセッション」でこのフォルダーを選んで信頼してから、もう一度フォークしてください。"
        : started.error;
      return { ok: false, error };
    }
    const { sessionId: forkId, terminal, pid } = started;
    const warnings: string[] = started.mcpDeclined ? [MCP_DECLINED] : [];
    let resumeAsked = started.resumeAsked;
    try {
      // Claude Code shows the prompt box once it has loaded the conversation (the question about an old session may
      // come first). Nothing else types into the copy yet: Gasho takes it on only below.
      let ready = false;
      for (let waited = 0; waited < FORK_READY_MS && !ready; waited += 300) {
        await sleep(300);
        const s = await this.terminals.screen(terminal).catch(() => undefined);
        if (!s) continue;
        if (resumeQuestionOpen(s.plain)) {
          await this.answerResumeQuestion(terminal).catch((e) => log(`${checked.name}: could not answer the question about resuming`, e));
          resumeAsked = true;
          continue;
        }
        ready = typedInBox(s) !== undefined;
      }
      const rename = renameCommand(checked.name);
      const typed: TypeResult = ready ? await this.typeInput(terminal, rename).catch(() => "not-typed" as const) : "not-typed";
      if (typed === "sent") {
        for (let waited = 0; waited < FORK_TRANSCRIPT_MS; waited += 250) {
          if (await findTranscript(this.cfg.claudeDir, forkId)) break;
          await sleep(250);
        }
        // Seen by a refresh before its transcript was written, the copy would be streamed from its start: every copied
        // message would reach browsers as a new one. Read as a whole instead; nobody has typed into it yet.
        const t = this.tracked.get(forkId);
        if (t && !t.transcript) t.sawWithoutTranscript = false;
      }
      this.managed.add({ sessionId: forkId, terminal, pid, cwd: source.cwd, name: checked.name, launchedAt: Date.now(), forkOf: sessionId, forkedAt });
      if (typed !== "sent") {
        // Until Claude Code records something, the copy shows no conversation in Gasho.
        this.managed.enqueue(forkId, { text: rename, ...(typed === "unsure" ? { entered: true, enteredAt: Date.now() } : {}) });
        warnings.push("フォークした会話は、Claude Code が書き出すまで Gasho に出ません。書き出させるための /rename を待たせてあり、送れたら出ます。");
      }
      await this.managed.save();
    } catch (e) {
      // A copy that Gasho does not keep would run on unseen: it is closed instead.
      this.managed.remove(forkId);
      await this.terminals.kill(terminal);
      throw e;
    }
    log(`forked ${source.name} (${sessionId}) as "${checked.name}" (${forkId})`);
    if (resumeAsked) {
      warnings.push(
        "前の発言から時間がたっていて会話も長いため、Claude Code が要約から始めるかを尋ねました。フォークなので、会話はそのまま引き継いでいます。次の返答では、会話をすべて読み直します（時間とトークンが多くかかります）。",
      );
    }
    await this.refresh();
    return { ok: true, sessionId: forkId, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
  }

  /**
   * Renames a session started from Gasho: in Gasho at once, and in Claude Code with /rename, which also renames its
   * Remote Control session (the name in the official apps). /rename is typed like an input, so only while the session
   * is idle: it waits while the session works. A /rename still waiting is replaced, not sent too.
   */
  private async rename(sessionId: string, name: string, requestId: string): Promise<CommandResult> {
    if (!this.managed.has(sessionId)) {
      return { ok: false, error: "このセッションの名前は変えられません。変えられるのは、Gasho が起動したセッションだけです。" };
    }
    const checked = sessionName(name);
    if ("error" in checked) return { ok: false, error: checked.error };
    // Also a name from the first message still waiting: the one asked for now wins, and the first message names it no more.
    this.managed.drop(sessionId, (input) => isRename(input.text));
    const named = this.managed.named(sessionId);
    if (this.managed.setName(sessionId, checked.name) || named) await this.managed.save();
    // Other inputs waiting go first, and typing them can take long (a model switch): the answer does not wait for them.
    const ahead = this.managed.pending(sessionId) > 0;
    this.managed.enqueue(sessionId, { id: requestId, text: renameCommand(checked.name) });
    log(`renaming ${sessionId} to "${checked.name}"`);
    this.emitSessions();
    if (ahead) return { ok: true, queued: true };
    let warnings: string[] = [];
    try {
      const flushed = await this.flushInput(sessionId);
      // The queue may have held earlier inputs: what happened to those is not this request's to report.
      if (flushed?.id === requestId) warnings = flushed.warnings;
    } catch (e) {
      log(`could not send /rename to ${sessionId} yet`, e);
      warnings.push("Claude Code の画面を操作できませんでした。名前の変更は待たせてあり、あとで送ります。");
    }
    this.emitSessions();
    return { ok: true, queued: this.managed.pending(sessionId) > 0, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
  }

  /**
   * Removes a session started from Gasho. Claude Code is asked to end with SIGTERM, as on a shutdown: it ends its
   * Remote Control session, and its conversation is kept (`claude --resume` lists it). Then its terminal is
   * closed, which ends whatever still runs in it. Only a process that `claude agents` lists with this session's id is
   * signalled, so a PID used again by another process is never hit.
   */
  private async remove(sessionId: string): Promise<CommandResult> {
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは削除できません。削除できるのは、Gasho が起動したセッションだけです。" };
    // From here on nothing is typed into it, and Gasho no longer shows it.
    this.managed.remove(sessionId);
    for (const map of [this.settleUntil, this.latePicker, this.prompts, this.titleSent]) map.delete(sessionId);
    await this.managed.save();
    this.emitSessions();
    const row = (await listAgents(this.cfg.claudeBin).catch(() => [] as AgentRow[])).find((r) => r.pid === m.pid);
    const ours = row?.sessionId === sessionId;
    if (ours) {
      try {
        process.kill(m.pid, "SIGTERM");
      } catch {
        // ended already
      }
      for (let waited = 0; waited < REMOVE_WAIT_MS && isAlive(m.pid); waited += 250) await sleep(250);
    }
    await this.terminals.kill(m.terminal);
    if (ours && isAlive(m.pid)) {
      log(`${m.name} did not end; stopping it`);
      try {
        process.kill(m.pid, "SIGKILL");
      } catch {
        // ended meanwhile
      }
    }
    await fsp.rm(this.attachmentsOf(sessionId), { recursive: true, force: true });
    log(`removed session ${m.name} (${sessionId}); closed its terminal ${m.terminal}`);
    await this.refresh();
    return { ok: true };
  }

  private async input(m: Extract<HubToDaemon, { type: "session.input" }>): Promise<CommandResult> {
    const { sessionId, text, model, effort, ultracode, files } = m;
    if (!this.managed.has(sessionId)) {
      return { ok: false, error: "このセッションには Gasho から入力できません。入力できるのは、Gasho が起動したセッションだけです。" };
    }
    const body = text.trim();
    if (!body && !files?.length) return { ok: false, error: "入力が空です。" };
    if (body.length > MAX_INPUT) return { ok: false, error: `入力が長すぎます（${MAX_INPUT} 文字まで）。` };
    const refused = refusedCommand(body) ?? shellInputProblem(body, files?.length ?? 0);
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
      const screen = (await this.terminals.screen(m.terminal)).plain;
      // A /model picker (or its question) still open, e.g. from an Enter that Claude Code took late: close it first
      // (Esc changes nothing there). Any other dialog, such as a permission request, is the person's to answer.
      if (modelPickerOptions(screen).length > 0 || switchQuestion(screen)) await this.closePicker(m.terminal);
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
          if (item.auto) this.titleSent.add(sessionId);
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
          if (model || effort) await this.switchModel(m.terminal, model, effort, t, out);
          if (item.ultracode !== undefined && item.ultracode !== t?.info.ultracode) {
            await this.setUltracode(m.terminal, item.ultracode, out);
          }
        }
        typed = await this.typeInput(m.terminal, item.text, item.entered, item.auto);
      } catch (e) {
        this.managed.unshift(sessionId, item);
        if (!(e instanceof EnterNotTaken)) throw e;
        later(UNSURE_RETRY_MS, `${e.message}; trying the input again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`Claude Code がすぐに反応しなかったので、${UNSURE_RETRY_MS / 1000} 秒後にやり直します。`);
        this.emitSessions();
        return out;
      }
      // Kept on a retry: the item and its Enter stay as they were.
      const base = { ...(item.id ? { id: item.id } : {}), text: item.text, ...(item.auto ? { auto: true } : {}) };
      const entered = item.entered ? { entered: true, enteredAt: item.enteredAt ?? enteredAt, ...(item.seenBusy ? { seenBusy: true } : {}) } : {};
      if (typed === "not-typed") {
        // Model, effort and ultracode are switched already; only the text waits for the next try. A text whose Enter
        // was pressed before stays marked so: it must never be pasted again.
        this.managed.unshift(sessionId, { ...base, ...entered });
        later(item.auto ? AUTO_RETRY_MS : RETRY_MS, "could not type the input; trying again later");
        out.warnings.push("入力欄に入れられませんでした。少ししてから送り直します。");
      } else if (typed === "unsure") {
        // Enter was pressed, but the box still held the text: Claude Code may take it late. It is never typed again;
        // a later look drops it if it was taken, and presses Enter only if the box still holds it.
        this.managed.unshift(sessionId, { ...base, entered: true, enteredAt: item.enteredAt ?? enteredAt });
        later(UNSURE_RETRY_MS, `the input was not taken yet; looking again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`送ったことを画面で確かめられませんでした。${UNSURE_RETRY_MS / 1000} 秒後に入力欄を見て、まだ残っていれば送ります。`);
      } else {
        if (item.auto) this.titleSent.add(sessionId);
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
   * With `keepTyped`, a box that holds text is left as it is (someone may be typing in the terminal), and nothing is typed.
   * Returns "sent", "not-typed" (nothing was sent; try again later), or "unsure" (Enter may have been pressed, but the
   * box still holds the text).
   */
  private async typeInput(session: string, text: string, entered = false, keepTyped = false): Promise<TypeResult> {
    const look = () => this.terminals.screen(session).catch(() => undefined);
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
        await this.terminals.keys(session, "Enter");
      } catch (e) {
        // The key may have reached the pane before the call failed.
        log("pressing Enter failed", e);
        return "unsure";
      }
      // Taken: the box lets go of the text (or a picker, such as /model's, takes its place).
      return (await waitFor((s) => !promptHolds(s, text), this.enterWaitMs)) ? "sent" : "unsure";
    };
    const clear = (s: Screen) => this.terminals.keys(session, ...clearPromptKeys(promptBoxLines(s.plain)?.length ?? 1));
    // Right after a picker or a command, Claude Code is still redrawing; wait for the prompt box.
    let ready = await waitFor((s) => typedInBox(s) !== undefined, 3000);
    if (!ready) return "not-typed";
    if (entered) {
      // Taken after all if the box no longer holds the text. Otherwise press Enter, unless the survey has the keys.
      if (!promptHolds(ready, text)) return "sent";
      return surveyOpen(ready.plain) ? "not-typed" : enter();
    }
    if (surveyOpen(ready.plain)) {
      await this.terminals.keys(session, "0");
      // Decide on what the screen shows now: had the survey not taken the "0", it is in the box.
      ready = await waitFor((s) => !surveyOpen(s.plain) && typedInBox(s) !== undefined, 1500);
      if (!ready) return "not-typed";
    }
    if (typedInBox(ready)) {
      if (keepTyped) return "not-typed";
      await clear(ready);
      if (!(await waitFor((s) => typedInBox(s) === "", 1500))) return "not-typed";
    }
    await this.terminals.paste(session, text);
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
      const s = await this.terminals.screen(session).catch(() => undefined);
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
      await this.terminals.keys(session, "Esc");
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
      if (steps !== 0) await this.terminals.keys(session, ...Array<string>(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up"));
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
    await this.terminals.keys(session, "s");
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
      const s = await this.terminals.screen(session).catch(() => undefined);
      if (!s) continue;
      const question = switchQuestion(s.plain);
      if (question) {
        if (answered) continue; // answered already; the question is going away
        if (!question.aboutCache || !question.onYes) return giveUp("Claude Code が切り替えの確認を求めたので、切り替えませんでした。");
        await this.terminals.keys(session, "Enter");
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
        await this.terminals.keys(session, at(goal) > at(now) ? "Right" : "Left");
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
    await this.terminals.keys(m.terminal, "Esc");
    this.settleUntil.set(sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    this.scheduleRefresh(500);
    return { ok: true };
  }

  /**
   * Claude's question that gasho-daemon holds no hook for (see PermissionRequestInfo.answerAsMessage): shown from the
   * transcript while a session started from Gasho waits on it. A question with a hook held is shown from that instead.
   */
  private openQuestion(t: Tracked): PermissionRequestInfo[] | undefined {
    const q = t.meta.question;
    if (!q || t.info.status !== "waiting" || !this.managed.has(t.info.sessionId)) return undefined;
    const r = openQuestionRequest(q);
    return r ? [r] : undefined;
  }

  /**
   * Answers a question shown from the transcript (see openQuestion). Esc closes Claude Code's dialog, as in the
   * terminal: Claude is told the person declined it, and stops. The answers then go as the next message, typed once the
   * session is idle like an input from Gasho. "deny" only closes the dialog. Nothing is pressed unless the session
   * still waits and its screen shows the question.
   */
  private async answerQuestion(m: Extract<HubToDaemon, { type: "permission.answer" }>): Promise<CommandResult> {
    const s = this.managed.get(m.sessionId);
    const q = this.tracked.get(m.sessionId)?.meta.question;
    if (!s || !q || `${OPEN_QUESTION}${q.toolUseId}` !== m.permissionId) return { ok: false, error: "この質問には、すでに答えられています。" };
    let message: string | undefined;
    if (m.decision !== "deny") {
      const answers = questionAnswers(q.input, m.answers);
      if (typeof answers === "string") return { ok: false, error: answers };
      message = answersMessage(answers);
    }
    if ((await this.currentStatus(s.pid)) !== "waiting") return { ok: false, error: "この質問には、すでに答えられています。" };
    const screen = (await this.terminals.screen(s.terminal).catch(() => undefined))?.plain ?? "";
    if (!atBottom(screen, QUESTION_DIALOG_RE, 12)) {
      return { ok: false, error: "端末に質問の画面が見当たらないため、答えられませんでした。端末か公式アプリで答えてください。" };
    }
    await this.terminals.keys(s.terminal, "Esc");
    this.settleUntil.set(m.sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    if (message) this.managed.enqueue(m.sessionId, { id: m.requestId, text: message });
    this.scheduleRefresh(500);
    this.emitSessions();
    log(`${s.name}: closed Claude's question${message ? "; the answers go as the next message" : ""}`);
    return { ok: true, ...(message ? { queued: true } : {}) };
  }
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentInfo,
  AgentKind,
  AgentOperation,
  BackgroundTask,
  BackgroundTaskKind,
  CommandResult,
  EffortLevel,
  FolderRepo,
  GitHubRepo,
  HubToDaemon,
  InputFeature,
  MachineAgents,
  InputFile,
  MediaPart,
  ModelOption,
  PermissionRequestInfo,
  RegisteredRepo,
  SessionInfo,
  SessionModel,
  SessionRepo,
  SessionWorktree,
  SwitchField,
  TranscriptEntry,
} from "@gasho/protocol";
import { claudeRunner, detectClaude } from "./claude-status.ts";
import { codexRunner, detectCodex, startCodexServer } from "./codex.ts";
import { CodexSessions } from "./codex-sessions.ts";
import type { DaemonConfig } from "./config.ts";
import { type ControlReply, type ControlRequest, type ControlSession, controlSocketOf, startControlServer } from "./control.ts";
import { listDir, readFileAt, writeFileAt } from "./files.ts";
import { cloneRepo, createFolder } from "./folders.ts";
import { githubRepoOf, nestedRepos, readGitGraph, worktreeOf } from "./git.ts";
import { GitHubProxy } from "./github.ts";
import { mayHibernate, type PermissionMode, resumeArgs, resumeModel } from "./hibernate.ts";
import { TokenDays } from "./token-days.ts";
import { TokenCounter } from "./tokens.ts";
import { startHookServer, summarizeHook } from "./hooks.ts";
import { isInside, statusLineLaunch, statusLineOf, userStatusLine } from "./statusline.ts";
import { HubClient } from "./hub-client.ts";
import { type Install, type Layout, layoutOf } from "./install.ts";
import { type MediaFailed, readMediaPart } from "./media.ts";
import { readMemory } from "./memory.ts";
import {
  answersMessage,
  dialogCall,
  OPEN_DIALOG,
  OPEN_QUESTION,
  openPermissionRequest,
  openQuestionRequest,
  PermissionRequests,
  questionAnswers,
  shownCall,
} from "./permissions.ts";
import {
  atBottom,
  bannerModel,
  bottomLines,
  cleanEnv,
  clearPromptKeys,
  dialogOpen,
  type DialogText,
  permissionDialog,
  permissionDialogText,
  permissionModeShown,
  EFFORT_LEVELS,
  forkName,
  type Hibernated,
  isAlive,
  isRename,
  launchableFolders,
  ManagedSessions,
  mcpQuestionOpen,
  type ManagedSession,
  type QueuedInput,
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
  noticeKey,
  switchedForSession,
  switchQuestion,
  type TaskRow,
  taskRowActive,
  taskRowKind,
  taskRowShows,
  type TasksDialog,
  tasksDialog,
  tasksItemFocused,
  titleName,
  TRUST_PROMPT_RE,
  trustQuestion,
  typedInBox,
  waitingForBackground,
  agentRowFocused,
  Zellij,
  terminalName,
} from "./managed.ts";
import {
  type AgentRow,
  type ClaudeState,
  findTranscript,
  listAgents,
  mapStatus,
  mayRun,
  rcModeOf,
  readRegistry,
  type RegistryInfo,
  runningTasks,
  sessionStatus,
  waitingForOf,
} from "./sessions.ts";
import { type HostHello, SessionTerminals, Terminals } from "./terminal.ts";
import { foldersRepos, RegisteredRepos } from "./repos.ts";
import { changesProblem, removableWorktree, removeWorktree, worktreeChanges } from "./worktrees.ts";
import { listSkills } from "./skills.ts";
import { appendBatches, conversationFacts, emptyMeta, followTranscript, userPrompts, pastConversations, TranscriptTail, type TranscriptMeta } from "./transcript.ts";
import type { SessionWire } from "./plugin-ipc.ts";
import { HookRelay } from "./hook-relay.ts";
import { PluginRunner } from "./plugins.ts";
import { npmOf, Updater } from "./self-update.ts";
import { log, str } from "./util.ts";
import { CLAUDE_TMP_SWEEP_MS, prepareClaudeTmp, removeSessionTmp, sessionOfTmpFile, sweepClaudeTmp } from "./claude-tmp.ts";

export const DAEMON_VERSION = "0.36.0";
const GITHUB_CACHE_MS = 5 * 60_000;
/** How long the worktree a folder is in, or the repositories inside it, and their branches are reused. */
const REPOS_CACHE_MS = 60_000;
const FOLDERS_REFRESH_MS = 5 * 60_000;
/** How often the agents are looked for again: one may be installed, updated or logged in to at any time. */
const CODEX_REFRESH_MS = 5 * 60_000;
/** How often the repository, branch and worktree of Codex's sessions are read again. */
const CODEX_DETAILS_MS = 15_000;
/** How often the server's memory is read and told to the Gasho server. */
const MEMORY_REFRESH_MS = 15_000;
/** How often the registered repositories' worktrees are read again: one may be made or removed elsewhere (Orca, git). */
const REGISTERED_REFRESH_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** A fork: how long Claude Code may take to show its prompt box once it runs, and then to write the copy's transcript. */
const FORK_READY_MS = 15_000;
const FORK_TRANSCRIPT_MS = 5000;
/** Removing a session: how long Claude Code may take to end after SIGTERM (Remote Control sessions take a moment). */
const REMOVE_WAIT_MS = 8000;
/** How often the sessions are looked at for one to hibernate (see hibernateIdle). */
const HIBERNATE_CHECK_MS = 60_000;
/** Removing a session: how long a Claude Code that was stopped may take to be gone, before its temporary folder is removed. */
const CLAUDE_END_WAIT_MS = 2000;
const MAX_INPUT = 20_000;
const INTERRUPT_SETTLE_MS = 1500;
/**
 * At least this long between two stops (Esc) of a session: Claude Code takes a second Esc soon after one as a double
 * Esc, which opens its rewind dialog, and the session then waits on that. A stop asked again meanwhile is the same stop.
 */
const INTERRUPT_REPEAT_MS = 3000;
/** How many background tasks one stop goes through at most, and how many keys move the cursor of their list at most. */
const MAX_TASK_STOPS = 20;
const MAX_TASK_MOVES = 30;
const STOP_BUSY_TYPING = "いま端末に入力しているため、止められませんでした。少し待ってから、もう一度押してください。";
/** Claude Code's question dialog (AskUserQuestion, 2.1.325), at the bottom of the screen: its last choice. */
const QUESTION_DIALOG_RE = /Chat about this/;
/** Said when this machine cannot make a terminal for a session (see terminalWorks). */
/** Why a hibernated session is not brought back while its conversation is open elsewhere (see hibernatedRow). */
const OPEN_OUTSIDE = "この会話は Gasho の外の Claude Code で開かれています。そちらを終了してから、もう一度再開してください。";
/** Why a session that had come back is hibernated again (see backToHibernation). */
const ENDED_WITH_INPUTS = "再開したあと、発言を入力する前に Claude Code が終了しました。";
const NO_TERMINAL =
  "この working server では、セッションの端末（node-pty）を用意できないので、セッションを起動できません。gasho-daemon の doctor で確かめてください。";
/** Said when Claude Code asked about a folder's new MCP servers while starting, and was answered "not now". */
const MCP_DECLINED =
  "このフォルダーの .mcp.json にある MCP サーバーは、使わない設定にして起動しました（Claude Code の確認に「使わない」と答えました）。使うときは、端末で claude を起動して /mcp から有効にしてください。";
const CODEX_NO_FORK = "Codex のセッションは、Gasho からはフォークできません。";
const MODEL_NAMES: Record<SessionModel, string> = { default: "既定のモデル", opus: "Opus", fable: "Fable", sonnet: "Sonnet", haiku: "Haiku" };
const EFFORT_NAMES: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };
/** What this gasho-daemon can switch or carry with an input (MachineInfo.features). */
const INPUT_FEATURES: readonly InputFeature[] = ["model", "effort", "ultracode", "files"];
/** What a session of Claude Code can do (AgentInfo.operations); one of Codex only talks, for now. */
const CLAUDE_OPERATIONS: readonly AgentOperation[] = [...INPUT_FEATURES, "fork", "background", "skills", "shell"];
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
/** The tokens per day are told to the Gasho server and saved at most this often. */
const TOKEN_DAYS_EVERY_MS = 60_000;
/** How long the sessions wait to be sent after a status line report, for the reports that follow it. */
const EMIT_DELAY_MS = 500;
/** How long the state of the sessions is read after a change in Claude Code's files: they come several at a time. */
const STATUS_READ_DELAY_MS = 100;
/** After a look at the model names whose "/model" was not taken in time, how long to watch for the picker it opens. */
const LATE_PICKER_WATCH_MS = 5 * 60_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long the model names read from the /model picker are trusted before an idle session is asked again. */
const MODELS_MAX_AGE_MS = 24 * 3600_000;
/** At most one look at the /model picker just to read the model names, per this interval. */
const MODELS_PROBE_INTERVAL_MS = 10 * 60_000;
/** How long after starting the folders of versions no longer used are removed (see Updater.prune). */
const PRUNE_VERSIONS_MS = 2 * 60_000;
/**
 * How long a version on trial may take to start: past it, the start is taken to hang. A start may be slow without being
 * a failure, as each terminal that does not answer is waited for (Terminals.live).
 */
export const TRIAL_START_LIMIT_MS = 5 * 60_000;

/** How this gasho-daemon was installed and runs, for updates from Gasho (see self-update.ts). */
export interface UpdateSetup {
  install: Install;
  layout: Layout;
  /** Run as the service `service install` set up. */
  service: boolean;
}

interface Tracked {
  info: SessionInfo;
  transcript?: string;
  tail?: TranscriptTail;
  meta: TranscriptMeta;
  /** The transcript did not exist yet when the session was first seen (Claude Code writes it on the first message). */
  sawWithoutTranscript?: boolean;
  /** The first read of the transcript, while it runs: a page asked for meanwhile waits for it. */
  opening?: Promise<void>;
  /** Sessions started from Gasho: the model in Claude Code's welcome banner, until the transcript records one. */
  bannerModel?: string;
  /** Sessions started from Gasho: the tokens they used, and when they were last counted. */
  tokens?: TokenCounter;
  tokensAt?: number;
  /** Claude Code's own state of the session, as its registry has it (see RegistryInfo.status), else as its list does. */
  claude?: ClaudeState;
  /** Sessions started from Gasho: the permission dialog on the screen when it was last read (see openPermission). */
  dialog?: DialogText;
}

/** What happened to the switches asked for with an input (`id`: the request of the input that was handled). */
interface InputOutcome {
  id?: string;
  warnings: string[];
  unapplied: SwitchField[];
}

/** See Daemon.typeInput. */
type TypeResult = "sent" | "not-typed" | "unsure";

/** How a Claude Code that is starting is waited for (see startClaude). */
interface ClaudeStart {
  accept?: (row: AgentRow) => boolean;
  resuming?: boolean;
  trust?: boolean;
}

type ClaudeStarted =
  | { sessionId: string; terminal: string; pid: number; resumeAsked: boolean; mcpDeclined: boolean }
  | { error: string; needsTrust?: true; trustWarnings?: string[] };

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
  /** How long a Claude Code started outside Gasho may take to end after SIGTERM (see end). */
  private endWaitMs = REMOVE_WAIT_MS;
  /**
   * The PIDs of the Claude Codes Gasho is starting or has started in this run, and of one it is removing, until they
   * end and `claude agents` no longer lists them. While one starts or is being removed, it is not among Gasho's
   * sessions, and is still none started outside Gasho (see emitSessions, end).
   */
  private ownPids = new Set<number>();
  private lastSent = "";
  /**
   * Whether a refresh has ended since the start. Until then no sessions are sent: the list would be empty, and the
   * Gasho server would drop the sessions it kept from before the restart (open ones would show as gone).
   */
  private refreshed = false;
  /**
   * Set from when followNewIds gives a session its new id until the refresh has it in `tracked`. A list sent meanwhile
   * would have neither of its ids, and its page would say it is gone.
   */
  private followingNewIds = false;
  private refreshing = false;
  private refreshAgain = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private emitTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private github = new Map<string, { at: number; repo?: GitHubRepo }>();
  private repos = new Map<string, { at: number; repos?: SessionRepo[] }>();
  private worktrees = new Map<string, { at: number; worktree?: SessionWorktree }>();
  /** The terminals of the sessions Gasho started (built-in; zellij for those from gasho-daemon 0.10 and before). */
  private terminals: SessionTerminals;
  private managed: ManagedSessions;
  private tokenDays: TokenDays;
  private tokenDaysAt = 0;
  /** Permission requests held until they are answered (in Gasho, or elsewhere). */
  private permissions = new PermissionRequests(() => this.emitSessions());
  private canLaunch = false;
  /** Claude Code on this working server, as last looked for. */
  private claude: AgentInfo | undefined;
  /** Counts the looks for Claude Code: a look that a later one overtook is not sent. */
  private claudeRead = 0;
  /** Codex on this working server, as last looked for; undefined when it is not installed. */
  private codex: AgentInfo | undefined;
  /** Counts the looks for Codex: a look that a later one overtook is not sent. */
  private codexRead = 0;
  /** The sessions of Codex that Gasho started: they do not come through `tracked` and `managed`. */
  private codexSessions: CodexSessions;
  /** The conversations being opened again, and until when that may take (see openingClaudeTmp). */
  private readonly claudeTmpOpening = new Map<string, number>();
  private sweepingClaudeTmp = false;
  /** The running sessions and their conversations have been read: until then, nothing says which files they show. */
  private sessionsRead = false;
  private folders: string[] = [];
  private folderRepos: FolderRepo[] = [];
  /** Counts the reads of the folders' repositories: a read that a later one overtook is not sent. */
  private folderReposRead = 0;
  private registered: RegisteredRepos;
  private registeredRepos: RegisteredRepo[] = [];
  private reposSent = "";
  /** Counts the reads of the registered repositories: a read that a later one overtook is not sent. */
  private reposRead = 0;
  /**
   * The terminals that something types into now (an input, a look at the /model picker, stopping background work):
   * one at a time. By terminal, not by id: /clear gives the session a new id meanwhile (see followNewIds).
   */
  private flushing = new Set<string>();
  /** The hibernated sessions being brought back, and how that ends (see wake). */
  private waking = new Map<string, Promise<CommandResult>>();
  /** The sessions whose Claude Code is being ended to hibernate them (it may still be listed), and when that is done. */
  private hibernating = new Map<string, Promise<void>>();
  /** Terminals found still bringing a session back after a restart of gasho-daemon, to be taken over (see settleHibernated). */
  private interrupted = new Map<string, { terminal: string; pid: number }>();
  private sweepingIdle = false;
  /** Sessions whose /rename to the name from the first message was sent, until Claude Code records it (nameAfterTitle). */
  private titleSent = new Set<string>();
  /** Until when input must wait after an interrupt, so Claude Code has put the stopped prompt back first. */
  private settleUntil = new Map<string, number>();
  /** When each session was last asked to stop (see INTERRUPT_REPEAT_MS). */
  private lastStop = new Map<string, number>();
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
  /** Passes the hooks on to the Gasho server, a Stop with what the plugins say of it. */
  private hookRelay: HookRelay;
  /** Updates of gasho-daemon from Gasho. */
  private updater: Updater;
  /** gasho-daemon has begun to end (exit). */
  private exiting = false;

  /** How long the prompt box may take to let go of a text after Enter (see typeInput). */
  private enterWaitMs: number;

  /** `update`: how it was installed (without it, as from a clone: Gasho cannot update it). */
  constructor(cfg: DaemonConfig, opts: { enterWaitMs?: number; update?: UpdateSetup } = {}) {
    this.cfg = cfg;
    this.enterWaitMs = opts.enterWaitMs ?? ENTER_WAIT_MS;
    const setup = opts.update ?? { install: { kind: "repo", repo: "" }, layout: layoutOf(), service: false };
    this.updater = new Updater({
      ...setup,
      version: DAEMON_VERSION,
      npm: npmOf(process.env, process.execPath),
      node: process.execPath,
      env: process.env,
      waiting: () => this.inputsToType(),
      changed: () => this.emitCapabilities(),
      exit: (code) => void this.exit(code),
      log: (s) => log(s),
      trialMs: cfg.trialMs,
    });
    // On Linux, run as the service means in its cgroup, which systemd stops as a whole (terminal.ts).
    const inService = setup.service && process.platform === "linux";
    this.terminals = new SessionTerminals(
      new Terminals({ stateDir: cfg.stateDir, env: cleanEnv(), inService, log: (s) => log(s) }),
      new Zellij(cleanEnv()),
    );
    this.managed = new ManagedSessions(path.join(cfg.stateDir, "managed.json"));
    this.codexSessions = new CodexSessions({
      file: path.join(cfg.stateDir, "codex-threads.json"),
      version: DAEMON_VERSION,
      startServer: () => this.startCodexAppServer(),
      describe: (cwd) => this.folderDetails(cwd),
      changed: () => this.emitSessions(),
      event: (event) => this.hub.send({ type: "hook", event }),
      append: (sessionId, entries) => this.hub.send({ type: "transcript.append", sessionId, entries }),
      log: (...args) => log(...args),
    });
    this.registered = new RegisteredRepos(path.join(cfg.stateDir, "repos.json"));
    this.tokenDays = new TokenDays(path.join(cfg.stateDir, "token-days.json"));
    this.hookRelay = new HookRelay({
      send: (event) => this.hub.send({ type: "hook", event }),
      asks: () => this.plugins.hearsSessionStop(),
      ask: (sessionId) => this.plugins.sessionStop(sessionId),
      log,
    });
    this.plugins = new PluginRunner({
      cacheDir: cfg.pluginCacheDir,
      send: (m) => this.hub.send(m),
      machine: () => ({ id: cfg.machineId, name: os.hostname() }),
      session: (id) => this.pluginSession(id),
      folders: () => this.folders,
      dataDir: cfg.pluginDataDir,
      github: new GitHubProxy({ ghBin: cfg.ghBin }),
      enabled: cfg.runPlugins,
      log: (s) => log(s),
    });
    this.hub = new HubClient({
      url: cfg.hubUrl,
      hello: () => ({ type: "hello", machineId: cfg.machineId, token: cfg.token, daemonVersion: DAEMON_VERSION }),
      onReady: () => {
        this.lastSent = "";
        this.reposSent = "";
        this.emitSessions();
        this.emitCapabilities();
        this.emitRepos();
        this.emitAllTokenDays();
        void this.emitMemory();
        // Also tells the Gasho server that this gasho-daemon runs plugins.
        this.plugins.status(true);
        this.plugins.connected();
      },
      onMessage: (m) => void this.onHubMessage(m),
      onRejected: (reason) => {
        log(`the Gasho server rejected this machine (${reason}). Its registration was revoked or is unknown;`);
        log("register again: node src/cli.ts register --server <url> --code <code>");
        // Not this version's failure: the version before would be rejected all the same.
        this.updater.stoppedOnTrial();
        void this.exit(1);
      },
    });
  }

  /**
   * Ends gasho-daemon with `code` once the plugins' daemon parts have stopped (each runs its `stop`, killed after a
   * few seconds: PluginRunner.stopAll), so that what they started, as a command run from a panel, does not stay
   * behind. Only the first call counts: an update may end it while a signal does.
   */
  async exit(code: number): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    await this.plugins.stopAll().catch((e: unknown) => log("could not stop the plugins", e));
    await this.tokenDays.save();
    process.exit(code);
  }

  private async emitMemory(): Promise<void> {
    const memory = await readMemory();
    this.hub.send(memory ? { type: "memory", memory } : { type: "memory" });
  }

  /**
   * The sessions started before this daemon: those whose Claude Code and terminal still run are kept, and those
   * hibernated, which stay until they are used (unless a restart cut that short: see settleHibernated).
   */
  private async loadManaged(): Promise<void> {
    const live = await this.terminals.builtIn.live();
    let inZellij: Set<string> | undefined;
    let listing: Promise<AgentRow[] | undefined> | undefined;
    const listed = () => (listing ??= listAgents(this.cfg.claudeBin).catch(() => undefined));
    await this.tokenDays.load();
    await this.managed.load(async (m) => {
      // Also for a fork that ended meanwhile: it can be opened again. Under /clear, the id it was forked under is its first.
      if (m.forkedAt !== undefined) this.tokenDays.rememberFork(m.previousIds?.[0] ?? m.sessionId, m.forkedAt);
      // Nothing of it runs: it stays until it is used.
      if (m.hibernated) return true;
      if (m.wokenFrom && !(isAlive(m.pid) && live.get(m.terminal)?.pid === m.pid)) {
        // A terminal slow to answer is missing from `live`: its Claude Code still runs, and must not get a second one.
        const rows = await listed();
        if (isAlive(m.pid) && (rows === undefined || rows.some((r) => r.pid === m.pid))) return true;
        // It ended before the inputs kept for it were typed: they wait for it to come back once more.
        m.hibernated = m.wokenFrom;
        delete m.wokenFrom;
        return true;
      }
      if (!isAlive(m.pid)) return false;
      if (!m.zellij) return live.get(m.terminal)?.pid === m.pid;
      inZellij ??= (await this.terminals.zellij.available()) ? await this.terminals.zellij.liveSessions() : new Set();
      if (!inZellij.has(m.terminal)) return false;
      this.terminals.useZellij(m.terminal);
      return true;
    });
    for (const m of this.managed.all()) if (m.hibernated) await this.settleHibernated(m, m.hibernated, live, listed);
    await this.managed.save();
    const old = this.managed.all().filter((m) => m.zellij).length;
    if (old > 0) log(`${old} session(s) started by gasho-daemon 0.10 or before still run in zellij; they are used through zellij until they end`);
    // Not closed: a terminal that no record names may still be someone's work (`gasho-daemon attach` shows it).
    const kept = new Set(this.managed.all().flatMap((m) => (m.hibernated ? (m.hibernated.resumingIn ?? []) : m.terminal)));
    for (const [name, h] of live) {
      if (!kept.has(name)) log(`terminal ${name} (pid ${h.pid}, ${h.cwd}) is not one of the sessions Gasho keeps; it is left as it is`);
    }
    // One at a time: long conversations take memory to read.
    for (const m of this.managed.all()) if (m.hibernated) await this.trackHibernated(m);
  }

  async start(): Promise<void> {
    await this.updater.load();
    if (!this.updater.onTrial()) {
      setTimeout(() => void this.updater.prune().catch((e: unknown) => log("could not remove the versions no longer used", e)), PRUNE_VERSIONS_MS).unref();
      return this.serve();
    }
    await this.serveOnTrial();
  }

  private async serve(): Promise<void> {
    log(`machine ${this.cfg.machineId}, Gasho server ${this.cfg.hubUrl}`);
    if (!this.cfg.hookSecret) log("GASHO_HOOK_SECRET is not set; hook requests are accepted without a secret");
    this.canLaunch = await this.terminals.builtIn.available();
    if (!this.canLaunch) log("no pseudo-terminal on this machine (node-pty did not load); sessions cannot be started from Gasho");
    await this.loadManaged();
    await this.pruneAttachments();
    // The first clean-up follows the first refresh that succeeds.
    setInterval(() => {
      if (this.sessionsRead) void this.sweepClaudeTmp();
    }, CLAUDE_TMP_SWEEP_MS).unref();
    this.models = await fsp
      .readFile(this.modelsFile(), "utf8")
      .then((t) => JSON.parse(t) as { at: number; options: ModelOption[] })
      .catch(() => undefined);
    await this.refreshFolders();
    setInterval(() => void this.refreshFolders(), FOLDERS_REFRESH_MS).unref();
    await this.registered.load();
    await this.refreshRepos();
    setInterval(() => void this.refreshRepos(), REGISTERED_REFRESH_MS).unref();
    // Not waited for: the capabilities are sent again once it is known.
    void this.refreshClaude();
    void this.refreshCodex();
    setInterval(() => {
      void this.refreshClaude();
      void this.refreshCodex();
    }, CODEX_REFRESH_MS).unref();
    await this.codexSessions.load();
    setInterval(() => void this.codexSessions.refreshDetails(), CODEX_DETAILS_MS).unref();

    this.hub.connect();
    setInterval(() => void this.emitMemory(), MEMORY_REFRESH_MS).unref();
    startHookServer({
      host: "127.0.0.1",
      port: this.cfg.hookPort,
      secret: this.cfg.hookSecret,
      onPermissionRequest: (payload, reply) => {
        // A plugin's own Claude Code is no session of Gasho's: Gasho does not answer for it.
        if (this.fromPlugin(payload)) {
          reply(undefined);
          return undefined;
        }
        const id = this.permissions.add(payload, reply);
        return id ? () => this.permissions.dropped(id) : undefined;
      },
      onEvent: (payload) => {
        if (this.fromPlugin(payload)) return;
        this.permissions.observe(payload);
        const ev = summarizeHook(payload);
        if (!ev) return;
        this.hookRelay.pass(ev);
        // Hooks often mean the status changed; refresh soon instead of waiting for the next poll.
        this.scheduleStatuses();
        this.scheduleRefresh(250);
      },
      onStatusLine: (payload) => this.applyStatusLine(payload),
    });
    const control = controlSocketOf(this.cfg.stateDir);
    await startControlServer(control, (req) => this.onControl(req)).then(
      () => log(`gasho-daemon session … is answered on ${control}`),
      (e: unknown) => log("no control socket, so gasho-daemon session … cannot reach this daemon", e),
    );
    setInterval(() => void this.refresh(), this.cfg.pollIntervalMs);
    setInterval(() => void this.pollTails(), 1000);
    if (this.cfg.hibernateAfterMs !== undefined) setInterval(() => void this.hibernateIdle(), HIBERNATE_CHECK_MS).unref();
    try {
      fs.watch(path.join(this.cfg.claudeDir, "sessions"), () => {
        this.scheduleStatuses();
        this.scheduleRefresh(300);
      });
    } catch (e) {
      log("cannot watch the sessions directory; relying on polling", e);
    }
    void this.refresh();
    this.wakeInterrupted();
  }

  /** After a restart: goes on with the sessions that were coming back, and those with inputs not tried yet. */
  private wakeInterrupted(): void {
    for (const m of this.managed.all()) {
      if (!m.hibernated) continue;
      if (this.interrupted.has(m.sessionId) || (!m.hibernated.resumeError && this.managed.pending(m.sessionId) > 0)) void this.wake(m.sessionId);
    }
  }

  /**
   * This version on trial, just started by an update (self-update.ts): it is confirmed once it has been up for a while
   * after its start, and its hook server answers. Until then an exception, a failure to start or a start that does not
   * end in TRIAL_START_LIMIT_MS ends it with why, and its next start goes back to the version before; a stop (SIGTERM,
   * a restart of the machine) is not a failure (cli.ts), and the next start tries it again.
   */
  private async serveOnTrial(): Promise<void> {
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      this.updater.recordFailure(e instanceof Error ? e.message : String(e));
      console.error(new Date().toISOString(), "[gasho-daemon] stopped on trial:", e);
      void this.exit(1);
    };
    process.on("uncaughtException", fail);
    const ms = this.updater.trialMs();
    log(`on trial: confirmed ${Math.round(ms / 1000)} s after it has started, if all is well`);
    const limit = setTimeout(
      () => fail(new Error(`起動が${TRIAL_START_LIMIT_MS / 60_000}分のうちに終わりませんでした。`)),
      TRIAL_START_LIMIT_MS,
    );
    // Not left to the hook server's check at the end of the trial, which would go back without the real reason.
    await this.serve().catch(fail);
    clearTimeout(limit);
    if (failed) return;
    setTimeout(() => {
      void (async () => {
        const problem = await this.trialProblem();
        if (problem) throw new Error(problem);
        await this.updater.confirm();
        process.off("uncaughtException", fail);
      })().catch(fail);
    }, ms);
  }

  /** What keeps this version on trial from being confirmed: its hook server does not answer (any answer counts). */
  private async trialProblem(): Promise<string | undefined> {
    try {
      await fetch(`http://127.0.0.1:${this.cfg.hookPort}/`, { signal: AbortSignal.timeout(10_000) });
      return undefined;
    } catch (e) {
      return `hooks の待ち受け（127.0.0.1:${this.cfg.hookPort}）が答えませんでした：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Whether a hook comes from a Claude Code that a plugin's daemon part runs in its own folder (as the usage plugin
   * does, to read the plan's usage limits): no session of Gasho's.
   */
  private fromPlugin(payload: Record<string, unknown>): boolean {
    const cwd = str(payload.cwd);
    return cwd !== undefined && isInside(cwd, this.cfg.pluginDataDir);
  }

  /**
   * What the status line of a session Gasho started reported (statusline.ts): its context window, and the plan's usage
   * limits. A report that changes nothing keeps the time of the one before, which is that of the reply it came from.
   */
  private applyStatusLine(payload: Record<string, unknown>): void {
    const report = statusLineOf(payload);
    const t = report && this.tracked.get(report.sessionId);
    if (!report || !t) return;
    const { info } = t;
    const c = report.context;
    if (c && !(info.context && info.context.used === c.used && info.context.size === c.size && info.context.percent === c.percent)) {
      info.context = c;
      this.scheduleEmit();
    }
    const l = report.limits;
    if (l && JSON.stringify({ ...l, at: 0 }) !== JSON.stringify({ ...info.limits, at: 0 })) {
      info.limits = l;
      this.scheduleEmit();
    }
  }

  /** Sends the sessions soon, once for what comes in meanwhile (status line reports come in bursts). */
  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitSessions();
    }, EMIT_DELAY_MS);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  private scheduleStatuses(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      void this.readStatuses().catch((e: unknown) => log("could not read the states of the sessions", e));
    }, STATUS_READ_DELAY_MS);
  }

  /**
   * The state each session's Claude Code wrote last in its file, read again without the list: `claude agents` reads
   * the same files, but took 20 s and more on a busy machine, and a session showed as idle meanwhile (also to a stop).
   */
  private async readStatuses(): Promise<void> {
    const read = await Promise.all(
      [...this.tracked.values()].map(async (t) => ({ t, reg: t.info.pid === undefined ? undefined : await readRegistry(this.cfg.claudeDir, t.info.pid) })),
    );
    let changed = false;
    for (const { t, reg } of read) if (reg?.status && this.applyStatus(t, undefined, reg)) changed = true;
    if (!changed) return;
    this.emitSessions();
    this.flushWaitingInputs();
  }

  /** A session's state from its file, else from the list's `row` (see sessionStatus); returns whether it changed. */
  private applyStatus(t: Tracked, row: AgentRow | undefined, reg: RegistryInfo | undefined): boolean {
    const { info } = t;
    const before = info.status;
    info.status = sessionStatus(row, reg);
    info.waitingFor = waitingForOf(row, reg);
    this.permissions.status(info.sessionId, info.status);
    if (info.status === before) return false;
    // For the sessions started from Gasho (those it stops), when Claude Code wrote a state and when Gasho showed it.
    const m = this.managed.get(info.sessionId);
    if (m && before !== "unknown") {
      const written = reg?.statusAt ? `${Math.round((Date.now() - reg.statusAt) / 100) / 10} s ago` : "-";
      log(`${m.name}: ${before} → ${info.status} (Claude Code's file: ${reg?.status ?? "-"}, written ${written}; list: ${row ? mapStatus(row) : "-"})`);
    }
    return true;
  }

  /** Types the waiting inputs of the sessions started from Gasho, those that can take them now (see flushInput). */
  private flushWaitingInputs(): void {
    for (const m of this.managed.all()) {
      // A hibernated session's inputs wait until it is back (see wake).
      if (m.hibernated || this.managed.pending(m.sessionId) === 0) continue;
      // A failure leaves the input on the queue for the next try.
      void this.flushInput(m.sessionId).catch((e) => log(`could not send the waiting input to ${m.name}`, e));
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      const rows = await listAgents(this.cfg.claudeBin);
      await this.followNewIds(rows);
      const seen = new Set<string>();
      for (const row of rows) {
        // A Claude Code that a plugin runs in its own folder is no session (see fromPlugin).
        if (!row.sessionId || !row.cwd || isInside(row.cwd, this.cfg.pluginDataDir)) continue;
        seen.add(row.sessionId);
        if (await this.hibernatedRow(row)) continue;
        const t = this.tracked.get(row.sessionId) ?? this.newTracked(row);
        this.tracked.set(row.sessionId, t);
        await this.update(t, row);
      }
      for (const id of [...this.tracked.keys()]) {
        // A hibernated session's conversation can still be read.
        if (seen.has(id) || this.managed.get(id)?.hibernated) continue;
        await this.countLastTokens(id, this.tracked.get(id)?.tokens);
        this.tracked.delete(id);
        this.permissions.settleSession(id);
      }
      this.followingNewIds = false;
      // One that ended while `claude agents` was read is still in rows.
      for (const pid of this.ownPids) if (!isAlive(pid) && !rows.some((r) => r.pid === pid)) this.ownPids.delete(pid);
      await this.forgetEndedSessions(seen);
      await this.readManagedScreens();
      await this.countTokens();
      this.emitSessions();
      this.flushWaitingInputs();
      if (!this.sessionsRead) {
        this.sessionsRead = true;
        void this.sweepClaudeTmp();
      }
    } catch (e) {
      log("refresh failed", e);
    } finally {
      this.refreshing = false;
      if (this.followingNewIds) {
        this.followingNewIds = false;
        this.emitSessions();
      }
      // Also after a failed one: the sessions from before the restart would otherwise show on as if they still ran.
      if (!this.refreshed) {
        this.refreshed = true;
        this.emitSessions();
      }
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  /**
   * Sessions started from Gasho whose Claude Code `claude agents` lists under another id: /clear (or /resume) made it go
   * on in the same process with another conversation. The session stays Gasho's under the new id, with what is kept
   * for it. A process that started after the session was recorded is another Claude Code that got the same PID.
   */
  private async followNewIds(rows: AgentRow[]): Promise<void> {
    let changed = false;
    for (const m of this.managed.all()) {
      // A hibernated session's PID is that of a Claude Code that has ended: another process may have it by now.
      if (m.hibernated) continue;
      const row = rows.find((r) => r.pid === m.pid && r.sessionId);
      const to = row?.sessionId;
      if (!to || to === m.sessionId || this.managed.has(to)) continue;
      if (row.startedAt !== undefined && row.startedAt > m.launchedAt) continue;
      const from = m.sessionId;
      if (!this.tracked.has(from)) await this.readLeftBehind(m, from);
      this.managed.rekey(from, to);
      this.followingNewIds = true;
      const move = <V>(map: Map<string, V>) => {
        const v = map.get(from);
        if (v === undefined) return;
        map.delete(from);
        map.set(to, v);
      };
      move(this.settleUntil);
      move(this.lastStop);
      move(this.latePicker);
      move(this.prompts);
      if (this.titleSent.delete(from)) this.titleSent.add(to);
      log(`${m.name}: Claude Code went on with another conversation (${to}) in place of ${from}`);
      changed = true;
    }
    if (changed) await this.managed.save();
  }

  /**
   * The Claude Code of a session that had come back ended before the inputs kept for it were typed. They stay, and the
   * screen says so and can try again: starting it by itself could go on failing the same way.
   */
  private async backToHibernation(m: ManagedSession, h: Hibernated): Promise<void> {
    m.hibernated = { ...h, resumeError: ENDED_WITH_INPUTS };
    delete m.wokenFrom;
    this.managed.recheckTyped(m.sessionId);
    for (const map of [this.settleUntil, this.lastStop, this.latePicker]) map.delete(m.sessionId);
    await this.terminals.kill(m.terminal);
    await this.trackHibernated(m);
    log(`${m.name} (${m.sessionId}) ended before the inputs kept for it were typed; it is hibernated again`);
  }

  /** The attachment folders of a session started from Gasho: of its id, and of the ids it had before /clear. */
  private attachmentsOfSession(m: ManagedSession): string[] {
    return [m.sessionId, ...(m.previousIds ?? [])].map((id) => this.attachmentsOf(id));
  }

  /** Managed sessions whose Claude Code has exited: drop them and close their terminal. */
  private async forgetEndedSessions(seen: Set<string>): Promise<void> {
    let changed = false;
    for (const m of this.managed.all()) {
      if (m.hibernated || seen.has(m.sessionId) || isAlive(m.pid)) continue;
      if (m.wokenFrom && (this.flushing.has(m.terminal) || this.managed.hasKept(m.sessionId))) {
        // Once typing has stopped, what it was typing is back on the queue.
        if (this.flushing.has(m.terminal)) continue;
        await this.backToHibernation(m, m.wokenFrom);
        changed = true;
        continue;
      }
      this.managed.remove(m.sessionId);
      for (const map of [this.settleUntil, this.lastStop, this.latePicker, this.prompts, this.titleSent]) map.delete(m.sessionId);
      await this.terminals.kill(m.terminal);
      for (const dir of this.attachmentsOfSession(m)) await fsp.rm(dir, { recursive: true, force: true });
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
    const reg = row.pid ? await readRegistry(this.cfg.claudeDir, row.pid) : undefined;
    this.applyStatus(t, row, reg);
    t.claude = reg?.status ? { status: reg.status, ...(reg.statusAt ? { at: reg.statusAt } : {}) } : { status: mapStatus(row) };
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
        t.tail = new TranscriptTail(found);
      } else {
        // A long conversation takes seconds to read: answered meanwhile, a page would show it empty.
        t.opening = followTranscript(found).then(
          ({ tail, meta }) => {
            t.transcript = found;
            t.meta = meta;
            t.tail = tail;
          },
          (e: unknown) => log(`cannot read ${found}`, e),
        );
        await t.opening;
        delete t.opening;
      }
    }
    info.bridgeSessionId = reg?.bridgeSessionId ?? t.meta.bridgeSessionId;
    this.applyMeta(t);
    // What Claude Code's state, as just read, says has ended is forgotten for good (only with the time it was written:
    // work recorded since is not for that state to judge).
    const claude = t.claude;
    if (claude.at !== undefined) t.meta.background?.settle((x) => mayRun(x, claude, info.startedAt));
    this.applyTasks(t);
    info.github = await this.githubOf(info.cwd);
    info.repos = await this.reposOf(info.cwd);
    info.worktree = await this.worktreeAt(info.cwd);
  }

  /** The background work still running (see runningTasks); returns whether that changed. */
  private applyTasks(t: Tracked): boolean {
    const before = JSON.stringify(t.info.background ?? []);
    const running = runningTasks(t.meta.background?.list() ?? [], t.claude ?? {}, t.info.startedAt);
    t.info.background = running.length > 0 ? running : undefined;
    return JSON.stringify(running) !== before;
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
    this.remember(info.sessionId, meta);
  }

  /** Keeps what a running session goes on with after /clear, which its new transcript does not say. */
  private remember(sessionId: string, meta: TranscriptMeta): void {
    if (meta.effort) this.rememberEffort(sessionId, meta.effort);
    const m = this.managed.get(sessionId);
    const at = meta.scheduledAt;
    // From before this Claude Code started, its transcript can still say so: that work ended with the process then.
    if (!m || m.hibernated || at === undefined || at < m.launchedAt || at <= (m.scheduledAt ?? 0)) return;
    m.scheduledAt = at;
    void this.managed.save().catch((e: unknown) => log(`could not save the work scheduled in ${m.name}`, e));
  }

  /** gasho-daemon was not running when a session went on under a new id: what its earlier conversation says is read now. */
  private async readLeftBehind(m: ManagedSession, from: string): Promise<void> {
    const found = await findTranscript(this.cfg.claudeDir, from).catch(() => undefined);
    if (!found) return;
    await followTranscript(found).then(
      ({ meta }) => this.remember(from, meta),
      (e: unknown) => log(`${m.name}: cannot read ${found}`, e),
    );
  }

  /** Keeps a running session's effort level, which it goes on with after /clear without anything saying so. */
  private rememberEffort(sessionId: string, effort: NonNullable<ManagedSession["effort"]>): void {
    const m = this.managed.get(sessionId);
    if (!m || m.hibernated || m.effort === effort) return;
    m.effort = effort;
    void this.managed.save().catch((e: unknown) => log(`could not save the effort level of ${m.name}`, e));
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
    const codex = this.codexSessions.sessions().find((s) => s.sessionId === sessionId);
    if (codex) {
      const repos = (await this.reposOf(codex.cwd)) ?? [];
      return {
        sessionId,
        agent: "codex",
        cwd: codex.cwd,
        ...(codex.name ? { name: codex.name } : {}),
        managed: true,
        ...(codex.github ? { github: codex.github } : {}),
        ...(codex.gitBranch ? { gitBranch: codex.gitBranch } : {}),
        repos: repos.map((r) => ({ path: r.path, ...(r.github ? { github: r.github } : {}), ...(r.branch ? { branch: r.branch } : {}) })),
      };
    }
    const t = this.tracked.get(sessionId);
    if (!t) return undefined;
    const name = this.managed.get(sessionId)?.name ?? t.info.name;
    const repos = (await this.reposOf(t.info.cwd)) ?? [];
    return {
      sessionId,
      agent: "claude",
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

  private async worktreeAt(cwd: string): Promise<SessionWorktree | undefined> {
    const hit = this.worktrees.get(cwd);
    if (hit && Date.now() - hit.at < REPOS_CACHE_MS) return hit.worktree;
    const worktree = await worktreeOf(cwd);
    this.worktrees.set(cwd, { at: Date.now(), worktree });
    return worktree;
  }

  private isOwn(pid: number | undefined): boolean {
    return pid !== undefined && this.ownPids.has(pid);
  }

  private emitSessions(): void {
    if (!this.refreshed || this.followingNewIds) return;
    const claude = [...this.tracked.values()]
      // Not yet, or no longer, among Gasho's sessions: sent, it would show as one opened outside Gasho.
      .filter((t) => this.managed.has(t.info.sessionId) || !this.isOwn(t.info.pid))
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
          previousSessionIds: m?.previousIds,
          permissionRequests: this.permissions.of(t.info.sessionId) ?? this.openQuestion(t) ?? this.openPermission(t),
          ...(m?.hibernated ? this.hibernatedInfo(m, m.hibernated, t.info) : {}),
        };
      });
    const sessions = [...claude, ...this.codexSessions.sessions()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const json = JSON.stringify(sessions);
    if (json === this.lastSent || !this.hub.connected) return;
    this.lastSent = json;
    this.hub.send({ type: "sessions", sessions });
  }

  private async refreshFolders(): Promise<void> {
    const cwds = [...[...this.tracked.values()].map((t) => t.info.cwd), ...this.codexSessions.sessions().map((s) => s.cwd)];
    const folders = await launchableFolders(os.homedir(), cwds);
    // Not waited for (git runs in every folder), and read again also when the folders are the same: their repositories
    // gain and lose worktrees.
    void this.refreshFolderRepos(folders);
    if (JSON.stringify(folders) === JSON.stringify(this.folders)) return;
    this.folders = folders;
    this.emitCapabilities();
    this.plugins.foldersChanged();
  }

  private async refreshFolderRepos(folders: string[]): Promise<void> {
    const read = ++this.folderReposRead;
    const repos = await foldersRepos(folders);
    if (read !== this.folderReposRead || JSON.stringify(repos) === JSON.stringify(this.folderRepos)) return;
    this.folderRepos = repos;
    this.emitCapabilities();
  }

  private async refreshRepos(): Promise<void> {
    const read = ++this.reposRead;
    const repos = await this.registered.read();
    if (read !== this.reposRead) return;
    this.registeredRepos = repos;
    this.emitRepos();
  }

  private emitRepos(): void {
    const json = JSON.stringify(this.registeredRepos);
    if (json === this.reposSent || !this.hub.connected) return;
    this.reposSent = json;
    this.hub.send({ type: "repos", repos: this.registeredRepos });
  }

  private async registerRepo(dir: string): Promise<CommandResult> {
    const r = await this.registered.register(path.resolve(dir));
    if ("error" in r) return { ok: false, error: r.error };
    await this.refreshRepos();
    return { ok: true, path: r.path };
  }

  private async unregisterRepo(repo: string): Promise<CommandResult> {
    await this.registered.unregister(repo);
    await this.refreshRepos();
    return { ok: true };
  }

  /** Starts Codex's app-server if it does not run, outside gasho-daemon's service: a restart here must not stop its turns. */
  private async startCodexAppServer(): Promise<string> {
    const command = await this.terminals.builtIn.inOwnScope(`gasho-codex-app-server-${randomUUID().slice(0, 8)}`, [this.cfg.codexBin, "app-server", "daemon", "start"]);
    return startCodexServer(command, { ...cleanEnv(), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) });
  }

  /** The repository, branch and worktree of a folder, as a session in it shows them. */
  private async folderDetails(cwd: string): Promise<Partial<SessionInfo>> {
    const [github, repos, worktree] = await Promise.all([this.githubOf(cwd), this.reposOf(cwd), this.worktreeAt(cwd)]);
    return { github, repos, worktree, gitBranch: worktree?.branch };
  }

  /** Looks at Claude Code, and tells the Gasho server when what it found changed. */
  private async refreshClaude(): Promise<void> {
    const read = ++this.claudeRead;
    const claude = await detectClaude(claudeRunner(this.cfg.claudeBin));
    if (read !== this.claudeRead || JSON.stringify(claude) === JSON.stringify(this.claude)) return;
    this.claude = claude;
    log(`Claude Code ${claude.version ?? "(version unknown)"}: ${claude.status}`);
    this.emitCapabilities();
  }

  /** The agents found here, and what this gasho-daemon does with each. */
  private agentsFound(): MachineAgents {
    return {
      ...(this.claude ? { claude: { ...this.claude, canLaunch: true, operations: [...CLAUDE_OPERATIONS] } } : {}),
      ...(this.codex ? { codex: { ...this.codex, canLaunch: true, operations: [] } } : {}),
    };
  }

  /** Looks for Codex, and tells the Gasho server when what it found changed. */
  private async refreshCodex(): Promise<void> {
    const read = ++this.codexRead;
    const codex = await detectCodex(codexRunner(this.cfg.codexBin));
    if (read !== this.codexRead || JSON.stringify(codex) === JSON.stringify(this.codex)) return;
    this.codex = codex;
    log(codex ? `Codex ${codex.version ?? "(version unknown)"}: ${codex.status}` : "Codex is not installed");
    this.emitCapabilities();
  }

  private emitCapabilities(): void {
    if (!this.hub.connected) return;
    this.hub.send({
      type: "capabilities",
      canLaunch: this.canLaunch,
      folders: this.folders,
      folderRepos: this.folderRepos,
      models: this.models?.options,
      modelsAt: this.models?.at,
      features: [...INPUT_FEATURES],
      canResume: true,
      canEnd: true,
      canRemoveWorktree: true,
      canListSkills: true,
      agents: this.agentsFound(),
      update: this.updater.info(),
    });
  }

  /** Inputs still to be typed into sessions, the one being typed included: they are not kept over a restart. */
  private inputsToType(): number {
    let n = this.flushing.size;
    for (const m of this.managed.all()) {
      // A hibernated session's inputs are saved with it, unless it is coming back and they are about to be typed.
      if (m.hibernated && !this.waking.has(m.sessionId)) continue;
      n += this.managed.waiting(m.sessionId).filter((input) => !input.auto).length;
    }
    return n + this.codexSessions.waitingInputs();
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
      if (!t || m.hibernated || this.flushing.has(m.terminal)) continue;
      // What the screen shows now wins over the transcript: the line above the prompt box ("◐ medium · ultracode ·
      // /effort", shown for a while after a change) and the "ultracode" in the rule above the box (while it is on).
      const screen = (await this.terminals.screen(m.terminal).catch(() => undefined))?.plain ?? "";
      t.dialog = permissionDialogText(screen);
      const state = statusLine(screen);
      if (state) {
        t.info.effort = state.effort;
        t.info.ultracode = state.ultracode;
        this.rememberEffort(m.sessionId, state.effort);
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
          !m.hibernated &&
          Date.now() - m.launchedAt > PROBE_MIN_AGE_MS &&
          this.tracked.get(m.sessionId)?.info.status === "idle" &&
          this.managed.pending(m.sessionId) === 0 &&
          !this.flushing.has(m.terminal),
      );
    if (idle) await this.probeModelsIn(idle);
  }

  /** Sessions started from Gasho: the tokens they have used, read from their transcripts and their subagents'. */
  private async countTokens(): Promise<void> {
    const now = Date.now();
    for (const m of this.managed.all()) {
      const t = this.tracked.get(m.sessionId);
      if (!t?.transcript) continue;
      // A fork's transcript starts with a copy of the conversation it was forked from: not this session's tokens. A fork
      // opened again from the history is known as one only by what was remembered when it was made.
      t.tokens ??= new TokenCounter(t.transcript, { since: this.tokenDays.forkedAt(m.sessionId) ?? m.forkedAt });
      if (t.info.status !== "busy" && t.tokensAt !== undefined && now - t.tokensAt < TOKENS_IDLE_MS) continue;
      t.tokensAt = now;
      try {
        await t.tokens.update();
      } catch (e) {
        log(`could not count the tokens of ${m.name}`, e);
      }
      t.info.tokens = t.tokens.totals();
      t.info.tokenHours = t.tokens.hours(now);
      if (t.tokens.complete) this.tokenDays.record(m.sessionId, t.tokens.days(), now);
    }
    this.emitTokenDays(now);
  }

  /** What a session that has ended wrote since it was last counted: its days stay after it is gone. */
  private async countLastTokens(sessionId: string, tokens: TokenCounter | undefined): Promise<void> {
    if (!tokens) return;
    try {
      do await tokens.update();
      while (!tokens.complete);
      this.tokenDays.record(sessionId, tokens.days());
    } catch (e) {
      log(`could not count the last tokens of ${sessionId}`, e);
    }
  }

  /** The days whose totals changed, at most once a minute; they are saved at the same pace. */
  private emitTokenDays(now: number): void {
    if (now - this.tokenDaysAt < TOKEN_DAYS_EVERY_MS) return;
    this.tokenDaysAt = now;
    void this.tokenDays.save(now);
    if (!this.hub.connected) return;
    const days = this.tokenDays.takeChanged();
    if (days.length > 0) this.hub.send({ type: "token.days", days });
  }

  /** The whole year, once connected: also what changed while the Gasho server could not be told. */
  private emitAllTokenDays(): void {
    this.tokenDaysAt = Date.now();
    this.hub.send({ type: "token.days", days: this.tokenDays.all() });
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
    this.flushing.add(m.terminal);
    try {
      await this.closePicker(m.terminal);
    } catch (e) {
      log(`could not close the /model picker in ${m.name}`, e);
    } finally {
      this.flushing.delete(m.terminal);
    }
  }

  /**
   * Reads the model names in a session's /model picker (opened and closed again); nothing else types meanwhile. Not
   * while someone is typing in the session's terminal (their text would be erased). After a failure, the next try
   * waits as long as the names are trusted: a picker that could not be read once is likely to stay so.
   */
  private async probeModelsIn(m: ManagedSession): Promise<void> {
    if (this.flushing.has(m.terminal)) return;
    this.flushing.add(m.terminal);
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
      this.flushing.delete(m.terminal);
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
        let appended = false;
        for await (const entries of t.tail.read(t.meta)) {
          this.notePrompts(t.info.sessionId, entries);
          for (const batch of appendBatches(entries)) this.hub.send({ type: "transcript.append", sessionId: t.info.sessionId, entries: batch });
          appended = true;
        }
        if (t.meta.customTitle !== named && (await this.followName(t))) changed = true;
        if (await this.nameAfterTitle(t)) changed = true;
        // Background work can start or end without an entry to show (Claude Code queues its notice first).
        if (this.applyTasks(t)) changed = true;
        if (!appended) continue;
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
    const named = this.managed.get(id);
    if (!named?.autoName || named.hibernated || !t.meta.title) return false;
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

  /**
   * Whether the transcript has a kept input that typing had begun on, as the whole message, since typing began: the same
   * words said earlier are another message.
   */
  private async typedBeforeRestart(m: ManagedSession, item: QueuedInput): Promise<boolean> {
    const file = this.tracked.get(m.sessionId)?.transcript ?? (await findTranscript(this.cfg.claudeDir, m.sessionId));
    if (!file) return false;
    const same = (text: string) => text.replace(/<\/?bash-input>/g, "").replace(/^\s*!/, "").replace(/\s+/g, "");
    const since = item.typingAt ?? item.keptAt ?? 0;
    return (await userPrompts(file)).some((p) => !(p.at < since) && same(p.text) === same(item.text));
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
      case "media.get":
        return this.sendMedia(m);
      case "session.launch":
      case "session.input":
      case "session.interrupt":
      case "session.stopTask":
      case "session.rename":
      case "session.fork":
      case "session.remove":
      case "session.history":
      case "session.skills":
      case "session.resume":
      case "session.wake":
      case "session.end":
      case "permission.answer":
      case "folder.create":
      case "repo.clone":
      case "repo.register":
      case "repo.unregister":
      case "file.write":
      case "worktree.remove":
      case "daemon.update": {
        let result: CommandResult;
        try {
          switch (m.type) {
            case "session.launch":
              result = await this.launch(m.cwd, m.name, m.trust === true, m.agent);
              break;
            case "session.input":
              result = await this.input(m);
              break;
            case "session.interrupt":
              result = await this.interrupt(m.sessionId);
              break;
            case "session.stopTask":
              result = await this.stopTasks(m.sessionId, m.taskId);
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
            case "session.history":
              result = await this.history(m.cwd, m.subfolders === true);
              break;
            case "session.skills":
              result = await this.skills(m.sessionId);
              break;
            case "session.resume":
              result = await this.resume(m.sessionId);
              break;
            case "session.wake":
              result = this.wakeAsked(m.sessionId);
              break;
            case "session.end":
              result = await this.end(m.sessionIds);
              break;
            case "permission.answer": {
              if (this.codexSessions.has(m.sessionId)) {
                const error = this.codexSessions.answer(m.sessionId, m.permissionId, m.decision, m.answers);
                result = error ? { ok: false, error } : { ok: true };
                break;
              }
              if (m.permissionId.startsWith(OPEN_QUESTION)) {
                result = await this.answerQuestion(m);
                break;
              }
              if (m.permissionId.startsWith(OPEN_DIALOG)) {
                result = await this.answerDialog(m);
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
            case "repo.register":
              result = await this.registerRepo(m.path);
              break;
            case "repo.unregister":
              result = await this.unregisterRepo(m.path);
              break;
            case "file.write":
              result = await this.writeFile(m);
              break;
            case "worktree.remove":
              result = await this.removeWorktree(m);
              break;
            case "daemon.update":
              result = this.updater.start(m.version);
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

  /**
   * A request on the local control socket (control.ts, `gasho-daemon session …` and `gasho-daemon worktree …`): done as the same command from the
   * Gasho server is.
   */
  private async onControl(req: ControlRequest): Promise<ControlReply> {
    const requestId = `control-${randomUUID()}`;
    try {
      switch (req.op) {
        case "session.launch":
          log(`session.launch in ${req.cwd} from the control socket`);
          return await this.launch(req.cwd, req.name, req.trust === true, req.agent);
        case "session.input":
          return await this.input({ type: "session.input", requestId, sessionId: req.sessionId, text: req.text });
        case "session.rename":
          return await this.rename(req.sessionId, req.name, requestId);
        case "session.list":
          await this.refresh();
          return { ok: true, sessions: this.controlSessions() };
        case "session.remove":
          log(`session.remove of ${req.sessionId} from the control socket`);
          return await this.remove(req.sessionId);
        case "worktree.remove":
          log(`worktree.remove of ${req.path}${req.force ? " (forced)" : ""} from the control socket`);
          return await this.controlRemoveWorktree(req.path, req.force === true, requestId);
      }
    } catch (e) {
      log(`${req.op} from the control socket failed`, e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * worktree.remove from the control socket: as from Gasho's screen (no branch deleted, nothing counted as pushed but
   * what a remote has), and the answer also names the worktree's folder and branch, and the sessions that ended.
   */
  private async controlRemoveWorktree(dir: string, force: boolean, requestId: string): Promise<ControlReply> {
    const w = await removableWorktree(dir);
    if ("error" in w) return { ok: false, error: w.error };
    // Their names as they are before they end: once ended, they are gone from the lists.
    const names = new Map<string, string>();
    for (const m of this.managed.all()) names.set(m.sessionId, m.name);
    for (const t of this.tracked.values()) if (t.info.name) names.set(t.info.sessionId, t.info.name);
    for (const s of this.codexSessions.sessions()) if (s.name) names.set(s.sessionId, s.name);
    const r = await this.removeWorktree({ type: "worktree.remove", requestId, path: w.path, ...(force ? { force: true } : {}) });
    const endedSessions = (r.ended ?? []).map((sessionId) => ({ sessionId, ...(names.has(sessionId) ? { name: names.get(sessionId)! } : {}) }));
    return { ...r, path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(endedSessions.length > 0 ? { endedSessions } : {}) };
  }

  /** The sessions Gasho started, under the names `claude agents` (and so ListAgents) shows. */
  private controlSessions(): ControlSession[] {
    const codex = this.codexSessions.sessions().map(
      (s): ControlSession => ({
        sessionId: s.sessionId,
        name: s.name ?? path.basename(s.cwd),
        cwd: s.cwd,
        agent: "codex",
        status: s.status,
        ...(s.pendingInputs ? { pendingInputs: s.pendingInputs } : {}),
        ...(fs.existsSync(s.cwd) ? {} : { cwdMissing: true }),
      }),
    );
    const claude = this.managed.all().map((m) => {
      const info = this.tracked.get(m.sessionId)?.info;
      const name = info?.name || m.name;
      const pending = this.managed.waiting(m.sessionId).filter((input) => !input.auto).length;
      return {
        sessionId: m.sessionId,
        ...(m.previousIds?.length ? { previousSessionIds: [...m.previousIds] } : {}),
        name,
        ...(name !== m.name ? { gashoName: m.name } : {}),
        cwd: m.cwd,
        agent: "claude" as const,
        terminal: m.terminal,
        status: info?.status ?? "unknown",
        ...(pending > 0 ? { pendingInputs: pending } : {}),
        ...(fs.existsSync(m.cwd) ? {} : { cwdMissing: true }),
      };
    });
    return [...claude, ...codex];
  }

  private async sendTranscriptPage(m: Extract<HubToDaemon, { type: "transcript.get" }>): Promise<void> {
    const t = this.tracked.get(m.sessionId);
    const reply = { type: "transcript.page" as const, requestId: m.requestId, sessionId: m.sessionId };
    if (this.codexSessions.has(m.sessionId)) {
      this.hub.send({ ...reply, ...(await this.codexSessions.page(m.sessionId, m.before, m.limit)) });
      return;
    }
    if (!t) {
      this.hub.send({ ...reply, entries: [], start: 0, total: 0, error: "session not found" });
      return;
    }
    await t.opening;
    if (!t.tail) {
      // A new session has no transcript until its first message; that is an empty conversation, not an error.
      this.hub.send({ ...reply, entries: [], start: 0, total: 0 });
      return;
    }
    try {
      this.hub.send({ ...reply, ...(await t.tail.page(m.before, m.limit)) });
    } catch (e) {
      this.hub.send({ ...reply, entries: [], start: 0, total: 0, error: String(e) });
    }
  }

  /** The folder of a session this daemon knows, of either agent. */
  private folderOf(sessionId: string): string | undefined {
    return this.tracked.get(sessionId)?.info.cwd ?? this.codexSessions.cwdOf(sessionId);
  }

  /**
   * The folder of a session's repository: its own folder, or `repo` inside it. Only sessions this daemon tracks, and
   * only a repository it found inside the folder, never a path the browser made up.
   */
  private async repoDir(sessionId: string, repo: string | undefined): Promise<{ dir: string } | { error: string }> {
    const cwd = this.folderOf(sessionId);
    if (cwd === undefined) return { error: "このセッションは見つかりません。" };
    if (repo === undefined) return { dir: cwd };
    const found = (await this.reposOf(cwd))?.find((r) => r.path === repo);
    return found ? { dir: path.join(cwd, found.path) } : { error: "このリポジトリは見つかりません。" };
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
    const root = this.folderOf(m.sessionId);
    const dir = root ? await listDir(root, m.path).catch((e: unknown) => ({ error: String(e) })) : { error: "このセッションは見つかりません。" };
    this.hub.send("error" in dir ? { ...reply, error: dir.error } : { ...reply, dir });
  }

  /** A file inside a session's folder: its text, an image's data, or what kind of file it is (see files.ts). */
  private async sendFile(m: Extract<HubToDaemon, { type: "file.get" }>): Promise<void> {
    const reply = { type: "file" as const, requestId: m.requestId, sessionId: m.sessionId, path: m.path };
    const root = this.folderOf(m.sessionId);
    const file = root ? await readFileAt(root, m.path).catch((e: unknown) => ({ error: String(e) })) : { error: "このセッションは見つかりません。" };
    this.hub.send("error" in file ? { ...reply, error: file.error } : { ...reply, file });
  }

  /**
   * Part of an image or a video that Claude sent to the person in a session (see media.ts): only one that the session's
   * conversation sent, wherever it is (Claude sends screenshots from its scratchpad, outside the session's folder).
   */
  private async sendMedia(m: Extract<HubToDaemon, { type: "media.get" }>): Promise<void> {
    const reply = { type: "media" as const, requestId: m.requestId };
    const t = this.tracked.get(m.sessionId);
    let part: MediaPart | MediaFailed;
    if (!t) part = { error: "このセッションは見つかりません。", notFound: true };
    else if (typeof m.path !== "string" || !t.meta.sentFiles?.has(m.path)) part = { error: "この会話で Claude が送った画像や動画ではありません。" };
    else part = await readMediaPart(m.path, m.offset, m.length).catch((e: unknown) => ({ error: String(e) }));
    this.hub.send("error" in part ? { ...reply, ...part } : { ...reply, media: part });
  }

  /** Writes a text file inside a session's folder, or makes one (see files.ts). */
  private async writeFile(m: Extract<HubToDaemon, { type: "file.write" }>): Promise<CommandResult> {
    const root = this.folderOf(m.sessionId);
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
  private async launch(cwd: string, name: string | undefined, trust = false, agent: AgentKind = "claude"): Promise<CommandResult> {
    if (agent === "codex") return this.launchCodex(cwd, name);
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

  /** Starts a session of Codex in `cwd`: a new thread of its app-server. */
  private async launchCodex(cwd: string, name: string | undefined): Promise<CommandResult> {
    const dir = path.resolve(cwd);
    const stat = await fsp.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return { ok: false, error: `フォルダーがありません：${dir}` };
    const checked = name?.trim() ? sessionName(name) : undefined;
    if (checked && "error" in checked) return { ok: false, error: checked.error };
    // It may have been installed or logged in to since it was last looked for.
    if (this.codex?.status !== "available") await this.refreshCodex();
    if (!this.codex) return { ok: false, error: "この working server には Codex が入っていません。" };
    if (this.codex.status === "loginRequired") return { ok: false, error: "Codex にログインしていません。working server で codex login を実行してください。" };
    if (this.codex.status !== "available") return { ok: false, error: "Codex の状態を確かめられませんでした。working server で codex login status を実行して確かめてください。" };
    try {
      const sessionId = await this.codexSessions.launch(dir, checked?.name);
      log(`started Codex's thread ${sessionId} in ${dir}`);
      void this.refreshFolders();
      return { ok: true, sessionId };
    } catch (e) {
      log("could not start a session of Codex", e);
      void this.refreshCodex();
      return { ok: false, error: `Codex のセッションを起動できませんでした：${e instanceof Error ? e.message : String(e)}` };
    }
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
   * Starts `claude --remote-control=<rcName> [claudeArgs…]` in `dir` in a new terminal, and waits until
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
      terminal = terminalName(rcName),
    }: ClaudeStart & { claudeArgs?: string[]; terminal?: string } = {},
  ): Promise<ClaudeStarted> {
    // Until `claude agents` lists it, nothing says that the folder of a conversation being opened again is in use.
    const resumed = claudeArgs.indexOf("--resume");
    if (resumed >= 0) this.claudeTmpOpening.set(claudeArgs[resumed + 1]!, Date.now() + LAUNCH_TIMEOUT_MS);
    // Claude Code does not start with a folder it cannot use: it then uses its default one.
    const claudeTmp = await prepareClaudeTmp(this.cfg.claudeTmpDir).then(
      () => ({ CLAUDE_CODE_TMPDIR: this.cfg.claudeTmpDir }),
      (e: unknown) => {
        log(`cannot use ${this.cfg.claudeTmpDir} for Claude Code's temporary files; starting it with its default folder`, e);
        return {};
      },
    );
    // Its status line reports the context window and the plan's usage limits to gasho-daemon (statusline.ts).
    const statusLine = statusLineLaunch({
      port: this.cfg.hookPort,
      secret: this.cfg.hookSecret,
      user: await userStatusLine(dir, this.cfg.claudeDir).catch(() => undefined),
    });
    let pid: number;
    try {
      pid = await this.terminals.start({
        name: terminal,
        cwd: dir,
        file: this.cfg.claudeBin,
        // One argument: a name starting with "-" (say "-wip") given on its own would be read as Claude Code's options.
        args: [`--remote-control=${rcName}`, ...claudeArgs, ...statusLine.args],
        env: { ...cleanEnv(), ...claudeTmp, ...statusLine.env },
      });
    } catch (e) {
      log(`could not start a terminal for "${rcName}"`, e);
      return { error: "Claude Code を起動できませんでした（端末を用意できませんでした）。" };
    }
    this.ownPids.add(pid);
    log(`launching "${rcName}" in ${dir} (terminal ${terminal})${claudeArgs.length > 0 ? ` with ${claudeArgs.join(" ")}` : ""}`);
    return this.claudeListed(terminal, pid, dir, rcName, { accept, resuming, trust });
  }

  /** Answers what a Claude Code asks while it starts, until `claude agents` lists it (see startClaude). */
  private async claudeListed(
    terminal: string,
    pid: number,
    dir: string,
    rcName: string,
    { accept = () => true, resuming = false, trust = false }: ClaudeStart,
  ): Promise<ClaudeStarted> {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let resumeAsked = false;
    let mcpDeclined = false;
    // Claude Code's file has the session id as soon as its list does (the list reads the file). The list, read on the
    // side, took 20 s and more on a busy machine, and printed nothing when it was stopped then.
    let listed: AgentRow[] = [];
    let listing: Promise<void> | undefined;
    let listFailed = false;
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
      const reg = await readRegistry(this.cfg.claudeDir, pid);
      const row: AgentRow | undefined = reg?.sessionId ? { pid, sessionId: reg.sessionId } : listed.find((r) => r.pid === pid && r.sessionId);
      if (row?.sessionId && accept(row)) return { sessionId: row.sessionId, terminal, pid, resumeAsked, mcpDeclined };
      if (!isAlive(pid)) break;
      listing ??= listAgents(this.cfg.claudeBin)
        .then((rows) => void (listed = rows))
        .catch((e: unknown) => {
          if (!listFailed) log(`"${rcName}": could not read Claude Code's list of sessions, reading its file only`, e);
          listFailed = true;
        })
        .finally(() => (listing = undefined));
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
   * Forks a session started from Gasho: `claude --remote-control=<name> --resume <id> --fork-session` in its folder, in
   * a new terminal. The copy starts with the conversation so far; the session itself goes on as it was. Claude
   * Code writes a fork's transcript only once something is recorded, so the copy is named with /rename right away:
   * that names it in Claude Code too (the Remote Control name is set already), and its conversation can be read at once.
   */
  private async fork(sessionId: string, name: string | undefined): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) return { ok: false, error: CODEX_NO_FORK };
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
    this.tokenDays.rememberFork(forkId, forkedAt);
    await this.tokenDays.save();
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

  /** What can be typed after "/" in a session's Claude Code (see listSkills). Only sessions this daemon tracks. */
  private async skills(sessionId: string): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) return { ok: true, skills: [] };
    const t = this.tracked.get(sessionId);
    if (!t) return { ok: false, error: "このセッションは見つかりません。" };
    const skills = await listSkills({
      claudeDir: this.cfg.claudeDir,
      claudeJson: path.join(os.homedir(), ".claude.json"),
      cwd: t.info.cwd,
      worktree: t.info.worktree,
    });
    return { ok: true, skills };
  }

  /** The conversations of a folder that no Claude Code has open now (see pastConversations). */
  private async history(cwd: string, subfolders: boolean): Promise<CommandResult> {
    const history = await pastConversations(this.cfg.claudeDir, path.resolve(cwd), { subfolders, open: new Set(this.tracked.keys()) });
    return { ok: true, history };
  }

  /**
   * Opens a conversation that no Claude Code has open again, in its folder, as a session started from Gasho:
   * `claude --remote-control=<name> --resume <id>` in a new terminal. Its name is the conversation's (see
   * conversationFacts); without one, it is named after its next message, as a new session is.
   */
  private async resume(sessionId: string): Promise<CommandResult> {
    // Not by an id it had before /clear: that is another conversation, which is opened here.
    if (this.managed.get(sessionId)?.hibernated) return this.wakeAsked(sessionId);
    if (!this.canLaunch) return { ok: false, error: NO_TERMINAL };
    // Open in two processes, the conversation would be written by both.
    if (this.tracked.has(sessionId)) return { ok: false, error: "この会話は、いま別の Claude Code が開いています。" };
    const file = await findTranscript(this.cfg.claudeDir, sessionId);
    const facts = file ? await conversationFacts(file).catch(() => undefined) : undefined;
    if (!facts) return { ok: false, error: "この会話の記録が見つかりません。" };
    const stat = await fsp.stat(facts.cwd).catch(() => undefined);
    if (!stat?.isDirectory()) return { ok: false, error: `会話のフォルダーがありません：${facts.cwd}` };
    const titled = facts.title ? titleName(facts.title) : undefined;
    const name = titled ?? `${path.basename(facts.cwd)}-gasho`;
    const started = await this.startClaude(facts.cwd, name, { claudeArgs: ["--resume", sessionId], resuming: true });
    if ("error" in started) {
      // Only the launcher asks whether to trust a folder.
      const error = started.needsTrust
        ? "このフォルダーは、もう Claude Code に信頼されていません。「新しいセッション」でこのフォルダーを選んで信頼してから、もう一度開いてください。"
        : started.error;
      return { ok: false, error };
    }
    const { sessionId: id, terminal, pid } = started;
    this.managed.add({ sessionId: id, terminal, pid, cwd: facts.cwd, name, launchedAt: Date.now(), ...(titled ? {} : { autoName: true }) });
    await this.managed.save();
    log(`resumed ${sessionId} as "${name}" (${id})`);
    const warnings: string[] = started.mcpDeclined ? [MCP_DECLINED] : [];
    if (started.resumeAsked) {
      warnings.push(
        "前の発言から時間がたっていて会話も長いため、Claude Code が要約から始めるかを尋ねました。会話はそのまま引き継いでいます。次の返答では、会話をすべて読み直します（時間とトークンが多くかかります）。",
      );
    }
    await this.refresh();
    // Before the answer, also when that refresh only asked the one running to go again: a session /clear took away from
    // this conversation has it among its earlier ids no longer (see ManagedSessions.add), and a page still told it does
    // goes on to that session instead (see the web's movedSession).
    this.emitSessions();
    return { ok: true, sessionId: id, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
  }

  /**
   * Ends Claude Codes started outside Gasho (in Orca, a terminal) with SIGTERM, as on a shutdown: their conversations
   * are kept, and can then be opened again from Gasho (see history, resume). Their terminals are not Gasho's, and stay
   * open. As in remove, only a process that `claude agents` lists with the session's id is signalled. One that does
   * not end is left running rather than killed: it may be in the middle of writing its conversation.
   */
  private async end(sessionIds: string[]): Promise<CommandResult> {
    // A Claude Code that a plugin runs in its own folder is no session (see fromPlugin), and is never signalled.
    const rows = (await listAgents(this.cfg.claudeBin)).filter((r) => !r.cwd || !isInside(r.cwd, this.cfg.pluginDataDir));
    if (sessionIds.some((id) => this.managed.has(id) || rows.some((r) => r.sessionId === id && this.isOwn(r.pid)))) {
      return { ok: false, error: "Gasho が起動したセッションは、ここでは終了できません。終了するときは、セッションを削除してください。" };
    }
    const label = (id: string) => {
      const info = this.tracked.get(id)?.info;
      return info?.title || info?.name || id.slice(0, 8);
    };
    const ended: string[] = [];
    const signalled: { id: string; pid: number }[] = [];
    const noProcess: string[] = [];
    for (const id of sessionIds) {
      const row = rows.find((r) => r.sessionId === id);
      if (!row) ended.push(id);
      else if (!row.pid) noProcess.push(id);
      else signalled.push({ id, pid: row.pid });
    }
    for (const { pid } of signalled) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ended already
      }
    }
    for (let waited = 0; waited < this.endWaitMs && signalled.some((s) => isAlive(s.pid)); waited += 250) await sleep(250);
    const running = signalled.filter((s) => isAlive(s.pid)).map((s) => s.id);
    ended.push(...signalled.filter((s) => !running.includes(s.id)).map((s) => s.id));
    if (ended.length > 0) log(`ended Claude Code outside Gasho: ${ended.map(label).join(", ")}`);
    const problems = [
      running.length > 0 && `次の会話の Claude Code は終了しませんでした。元の端末で終了してください：${running.map(label).join("、")}`,
      noProcess.length > 0 && `次の会話はバックグラウンドで動いているため、終了できません：${noProcess.map(label).join("、")}`,
    ].filter((p): p is string => Boolean(p));
    await this.refresh();
    if (ended.length === 0) return { ok: false, error: problems.join(" ") || "終了する会話がありません。" };
    return { ok: true, ended, ...(problems.length > 0 ? { warning: problems.join(" ") } : {}) };
  }

  /**
   * Renames a session started from Gasho: in Gasho at once, and in Claude Code with /rename, which also renames its
   * Remote Control session (the name in the official apps). /rename is typed like an input, so only while the session
   * is idle: it waits while the session works. A /rename still waiting is replaced, not sent too.
   */
  private async rename(sessionId: string, name: string, requestId: string): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) {
      const named = sessionName(name);
      return "error" in named ? { ok: false, error: named.error } : this.codexSessions.rename(sessionId, named.name);
    }
    // By session.sessionId from here on: `sessionId` can be one the session had before /clear (see ManagedSessions.find),
    // and /clear can give it a new id while the name is saved (see followNewIds).
    const session = this.managed.find(sessionId);
    if (!session) {
      return { ok: false, error: "このセッションの名前は変えられません。変えられるのは、Gasho が起動したセッションだけです。" };
    }
    const checked = sessionName(name);
    if ("error" in checked) return { ok: false, error: checked.error };
    if (session.hibernated) {
      // Told to Claude Code once it runs again (see wake); renaming is no reason to bring it back.
      this.managed.named(session.sessionId);
      this.managed.setName(session.sessionId, checked.name);
      session.hibernated.renamed = true;
      await this.managed.save();
      log(`renaming hibernated ${session.sessionId} to "${checked.name}"`);
      this.emitSessions();
      return { ok: true, queued: false };
    }
    // Also a name from the first message still waiting: the one asked for now wins, and the first message names it no more.
    this.managed.drop(session.sessionId, (input) => isRename(input.text));
    const named = this.managed.named(session.sessionId);
    if (this.managed.setName(session.sessionId, checked.name) || named) await this.managed.save();
    // Other inputs waiting go first, and typing them can take long (a model switch): the answer does not wait for them.
    const ahead = this.managed.pending(session.sessionId) > 0;
    this.managed.enqueue(session.sessionId, { id: requestId, text: renameCommand(checked.name) });
    log(`renaming ${session.sessionId} to "${checked.name}"`);
    this.emitSessions();
    if (ahead) return { ok: true, queued: true };
    let warnings: string[] = [];
    try {
      const flushed = await this.flushInput(session.sessionId);
      // The queue may have held earlier inputs: what happened to those is not this request's to report.
      if (flushed?.id === requestId) warnings = flushed.warnings;
    } catch (e) {
      log(`could not send /rename to ${session.sessionId} yet`, e);
      warnings.push("Claude Code の画面を操作できませんでした。名前の変更は待たせてあり、あとで送ります。");
    }
    this.emitSessions();
    return { ok: true, queued: this.managed.pending(session.sessionId) > 0, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
  }

  /**
   * Removes a session started from Gasho. Claude Code is asked to end with SIGTERM, as on a shutdown: it ends its
   * Remote Control session, and its conversation is kept (`claude --resume` lists it). Then its terminal is
   * closed, which ends whatever still runs in it. Only a process that `claude agents` lists with this session's id is
   * signalled, so a PID used again by another process is never hit.
   */
  private async remove(sessionId: string): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) {
      log(`removing Codex's session ${sessionId}; its conversation stays with Codex`);
      return this.codexSessions.remove(sessionId);
    }
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは削除できません。削除できるのは、Gasho が起動したセッションだけです。" };
    // One going to sleep or coming back is removed as what it turns out to be.
    await this.hibernating.get(sessionId);
    await this.waking.get(sessionId);
    // Its Claude Code and terminal have ended already; its PID may be another process's by now.
    const asleep = m.hibernated !== undefined;
    const tokens = this.tracked.get(sessionId)?.tokens;
    // From here on nothing is typed into it, and Gasho no longer shows it.
    if (!asleep) this.ownPids.add(m.pid);
    this.managed.remove(sessionId);
    if (asleep) this.tracked.delete(sessionId);
    for (const map of [this.settleUntil, this.lastStop, this.latePicker, this.prompts, this.titleSent]) map.delete(sessionId);
    await this.managed.save();
    this.emitSessions();
    if (!asleep) await this.endClaude(m, sessionId);
    for (const dir of this.attachmentsOfSession(m)) await fsp.rm(dir, { recursive: true, force: true });
    await this.countLastTokens(sessionId, tokens);
    await this.tokenDays.save();
    log(`removed session ${m.name} (${sessionId}); closed its terminal ${m.terminal}`);
    // Not waited for: a large folder takes a while, and the session is removed whether or not this works.
    void this.removeClaudeTmp(sessionId, m.pid);
    await this.refresh();
    return { ok: true };
  }

  /**
   * Ends a session's Claude Code with SIGTERM, which keeps its conversation, and closes its terminal, which ends whatever
   * still runs in it. Only a process that `claude agents` lists with this session's id is signalled, so a PID used again
   * by another process is never hit. One that does not end in time is killed with its terminal.
   */
  private async endClaude(m: ManagedSession, sessionId: string): Promise<void> {
    const row = (await listAgents(this.cfg.claudeBin).catch(() => [] as AgentRow[])).find((r) => r.pid === m.pid);
    const ours = row?.sessionId === sessionId;
    if (!ours) this.ownPids.delete(m.pid);
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
  }

  // ---- hibernated sessions (hibernate.ts) ----

  /** What a hibernated session shows, over what was last known of it while it ran. */
  private hibernatedInfo(m: ManagedSession, h: Hibernated, info: SessionInfo): Partial<SessionInfo> {
    return {
      status: "idle",
      waitingFor: undefined,
      pid: undefined,
      rcMode: "none",
      model: h.model ?? info.model,
      effort: h.effort ?? info.effort,
      ultracode: h.ultracode ?? info.ultracode,
      hibernation: this.waking.has(m.sessionId) ? "resuming" : "hibernated",
      ...(h.resumeError ? { resumeError: h.resumeError } : {}),
    };
  }

  /**
   * After a restart of gasho-daemon: a session saved as hibernated may still have a Claude Code running, as the restart
   * can come while it is being ended or brought back. Two must never have the conversation open. A terminal that was
   * bringing it back is taken over (wakeInterrupted). One that was being ended gets the time an end takes: if it goes on
   * running, it was never stopped, and the session simply is not hibernated. A terminal slow to answer is missing from
   * `live`, so `claude agents` is asked too.
   */
  private async settleHibernated(
    m: ManagedSession,
    h: Hibernated,
    live: Map<string, HostHello>,
    listed: () => Promise<AgentRow[] | undefined>,
  ): Promise<void> {
    if (h.resumingIn) {
      const host = live.get(h.resumingIn);
      if (host && !host.exited && isAlive(host.pid)) {
        this.ownPids.add(host.pid);
        this.interrupted.set(m.sessionId, { terminal: h.resumingIn, pid: host.pid });
        return;
      }
      // Also one that was too slow to answer just now.
      await this.terminals.kill(h.resumingIn);
      delete h.resumingIn;
    }
    const host = live.get(m.terminal);
    if (host?.pid !== m.pid && !this.stillRuns(m, (await listed()) ?? [])) return;
    if (await this.endsInTime(m, host)) {
      await this.terminals.kill(m.terminal);
      return;
    }
    log(`${m.name} (${m.sessionId}) still runs in ${m.terminal}; it is not hibernated`);
    this.stayAwake(m, h);
  }

  /**
   * Whether the Claude Code a hibernated session last ran in still has its conversation open. Its PID alone does not
   * tell: after a long sleep another process, even another Claude Code, may have been given that number.
   */
  private stillRuns(m: ManagedSession, rows: AgentRow[]): boolean {
    return isAlive(m.pid) && rows.some((r) => r.pid === m.pid && r.sessionId === m.sessionId);
  }

  /** Gives a Claude Code that was being ended the time an end takes, and tells whether it has ended. */
  private async endsInTime(m: ManagedSession, host?: HostHello): Promise<boolean> {
    for (let waited = 0; waited < this.endWaitMs && !host?.exited && isAlive(m.pid); waited += 250) await sleep(250);
    return host?.exited !== undefined || !isAlive(m.pid);
  }

  /** The session turns out not to be hibernated: its Claude Code runs on, and a new name given meanwhile is sent to it. */
  private stayAwake(m: ManagedSession, h: Hibernated): void {
    delete m.hibernated;
    if (h.renamed) this.managed.unshift(m.sessionId, { text: renameCommand(m.name), auto: true });
  }

  /** Whether a Claude Code that is not Gasho's has this hibernated session's conversation open. */
  private async openOutside(m: ManagedSession): Promise<boolean> {
    const rows = await listAgents(this.cfg.claudeBin);
    return rows.some((r) => r.sessionId === m.sessionId && r.pid !== undefined && r.pid !== m.pid && !this.isOwn(r.pid) && isAlive(r.pid));
  }

  /** After a restart of gasho-daemon: a hibernated session is followed again, from its transcript. */
  private async trackHibernated(m: ManagedSession): Promise<void> {
    const t: Tracked = {
      meta: emptyMeta(),
      info: { sessionId: m.sessionId, cwd: m.cwd, name: m.name, status: "idle", rcMode: "none", prLinks: [] },
    };
    this.tracked.set(m.sessionId, t);
    const found = await findTranscript(this.cfg.claudeDir, m.sessionId);
    if (found) {
      await followTranscript(found).then(
        ({ tail, meta }) => {
          t.transcript = found;
          t.meta = meta;
          t.tail = tail;
        },
        (e: unknown) => log(`cannot read ${found}`, e),
      );
    }
    t.info.bridgeSessionId = t.meta.bridgeSessionId;
    this.applyMeta(t);
    t.info.github = await this.githubOf(m.cwd).catch(() => undefined);
    t.info.repos = await this.reposOf(m.cwd);
    t.info.worktree = await this.worktreeAt(m.cwd).catch(() => undefined);
  }

  /**
   * A line of `claude agents` with the id of a hibernated session. The Claude Code that was ended may still be listed
   * (the list can take seconds to read), and one coming back is Gasho's own. Any other has the conversation open outside
   * Gasho: two processes must not write one conversation, so Gasho lets go of the session, which goes on as one started
   * outside Gasho. While inputs wait for it, it stays, and the screen says why they cannot be sent. Returns whether the
   * line is to be passed over.
   */
  private async hibernatedRow(row: AgentRow): Promise<boolean> {
    const id = row.sessionId ?? "";
    const m = this.managed.get(id);
    if (!m?.hibernated) return false;
    if (this.hibernating.has(id) || row.pid === m.pid) return true;
    if (this.waking.has(id)) return false;
    // One that failed to come back, or has ended since the list was read.
    if (row.pid === undefined || this.isOwn(row.pid) || !isAlive(row.pid)) return true;
    if (this.managed.waiting(id).some((input) => !input.auto)) {
      if (m.hibernated.resumeError !== OPEN_OUTSIDE) {
        log(`hibernated session ${m.name} (${id}) was opened outside Gasho; the inputs waiting for it are kept`);
        m.hibernated.resumeError = OPEN_OUTSIDE;
        await this.managed.save();
      }
      return true;
    }
    log(`hibernated session ${m.name} (${id}) was opened outside Gasho; it is no longer one of Gasho's sessions`);
    this.managed.remove(id);
    await this.managed.save();
    return false;
  }

  /**
   * Whether a session started from Gasho has been left alone long enough, and can be stopped without losing anything:
   * the permission mode to bring it back in if so, and undefined if not.
   */
  private async readyToHibernate(m: ManagedSession, afterMs: number): Promise<PermissionMode | undefined> {
    const t = this.tracked.get(m.sessionId);
    if (!t || m.hibernated || this.waking.has(m.sessionId)) return undefined;
    const scheduledAt = Math.max(t.meta.scheduledAt ?? 0, m.scheduledAt ?? 0);
    // Read again after each wait: an input may come in meanwhile.
    const facts = () => ({
      zellij: m.zellij === true,
      resumable: this.canLaunch && t.transcript !== undefined,
      status: t.info.status,
      claudeStatus: t.claude?.status,
      background: t.info.background?.length ?? 0,
      pendingInputs: this.managed.pending(m.sessionId),
      permissionRequests: (this.permissions.of(m.sessionId) ?? this.openQuestion(t) ?? this.openPermission(t))?.length ?? 0,
      question: t.meta.question !== undefined,
      // settleUntil keeps its time until the next input: only a time still to come means anything.
      operating: this.flushing.has(m.terminal) || (this.settleUntil.get(m.sessionId) ?? 0) > Date.now() || this.latePicker.has(m.sessionId),
      scheduled: scheduledAt > 0 && scheduledAt >= (t.info.startedAt ?? 0),
      activity: [t.info.lastActivityAt, t.info.startedAt, m.launchedAt, t.claude?.at],
    });
    const now = Date.now();
    // The terminal is asked only about a session that all the rest allows.
    if (!mayHibernate({ ...facts(), typed: "", attached: false, permissionMode: "auto" }, now, afterMs)) return undefined;
    if (!(await fsp.stat(m.cwd).then((s) => s.isDirectory(), () => false))) return undefined;
    if ((await this.currentStatus(m.pid)) !== "idle") return undefined;
    const screen = await this.terminals.screen(m.terminal).catch(() => undefined);
    const hello = await this.terminals.builtIn.hello(m.terminal).catch(() => undefined);
    if (!screen || !hello) return undefined;
    const permissionMode = permissionModeShown(screen.plain);
    return mayHibernate({ ...facts(), typed: typedInBox(screen), attached: (hello.viewers ?? 0) > 0, permissionMode }, now, afterMs) ? permissionMode : undefined;
  }

  /** Hibernates the sessions that nobody uses, one at a time. */
  private async hibernateIdle(): Promise<void> {
    const afterMs = this.cfg.hibernateAfterMs;
    if (afterMs === undefined || this.sweepingIdle || this.exiting) return;
    this.sweepingIdle = true;
    try {
      for (const m of this.managed.all()) {
        const permissionMode = await this.readyToHibernate(m, afterMs);
        if (permissionMode) await this.hibernate(m, permissionMode);
      }
    } catch (e) {
      log("could not hibernate the sessions left alone", e);
    } finally {
      this.sweepingIdle = false;
    }
  }

  /**
   * Ends a session's Claude Code and terminal as a removal does, and keeps the session: what it goes on with is saved
   * first. Its temporary folder and attachments stay, for when it comes back. If that cannot be saved, it is not
   * hibernated: nothing would remember what it needs to come back, and its Claude Code has not been touched yet.
   */
  private hibernate(m: ManagedSession, permissionMode: PermissionMode): Promise<void> {
    const id = m.sessionId;
    const t = this.tracked.get(id);
    if (!t) return Promise.resolve();
    // From here on inputs wait for it to come back, and nothing is typed into it.
    const model = resumeModel(t.info.model, t.meta.namedModel, t.bannerModel);
    const effort = t.info.effort ?? m.effort;
    const h: Hibernated = {
      at: Date.now(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(t.info.ultracode ? { ultracode: true } : {}),
      permissionMode,
    };
    m.hibernated = h;
    const ended = (async () => {
      try {
        await this.managed.save();
      } catch (e) {
        log(`could not save that ${m.name} (${id}) is hibernated; it goes on running`, e);
        this.stayAwake(m, h);
        return;
      }
      this.emitSessions();
      await this.endClaude(m, id);
      for (const map of [this.settleUntil, this.lastStop, this.latePicker]) map.delete(id);
      t.info.pid = undefined;
      log(`hibernated ${m.name} (${id})`);
    })().finally(() => {
      this.hibernating.delete(id);
      this.emitSessions();
      // Inputs that came in meanwhile, if it went on running after all.
      if (!m.hibernated) this.flushWaitingInputs();
    });
    this.hibernating.set(id, ended);
    return ended;
  }

  /** `session.wake`: brings a hibernated session back; the screen follows how that goes with the session's state. */
  private wakeAsked(sessionId: string): CommandResult {
    // Also by an id it had before /clear (see ManagedSessions.find).
    const m = this.managed.find(sessionId);
    if (!m) return { ok: false, error: "このセッションは見つかりません。" };
    if (m.hibernated) void this.wake(m.sessionId);
    return { ok: true, sessionId: m.sessionId };
  }

  /** Brings a hibernated session back, once however often it is asked for. */
  private wake(sessionId: string): Promise<CommandResult> {
    const running = this.waking.get(sessionId);
    if (running) return running;
    const woken = this.startHibernated(sessionId)
      .catch(async (e: unknown): Promise<CommandResult> => {
        log(`could not bring ${sessionId} back`, e);
        return this.wakeFailed(sessionId, "Claude Code を再開できませんでした。");
      })
      .finally(() => {
        this.waking.delete(sessionId);
        this.emitSessions();
      });
    this.waking.set(sessionId, woken);
    this.emitSessions();
    return woken;
  }

  /**
   * The session stays hibernated and keeps the inputs sent to it; the screen says why, and can try again. The terminal
   * tried in is closed, so that the next try is the only Claude Code on the conversation.
   */
  private async wakeFailed(sessionId: string, error: string): Promise<CommandResult> {
    const h = this.managed.get(sessionId)?.hibernated;
    if (h) {
      if (h.resumingIn) await this.terminals.kill(h.resumingIn);
      delete h.resumingIn;
      h.resumeError = error;
      await this.managed.save().catch((e: unknown) => log(`could not save why ${sessionId} did not come back`, e));
    }
    log(`could not bring ${sessionId} back: ${error}`);
    return { ok: false, error };
  }

  /**
   * `claude --remote-control=<name> --resume <id>` with the model and effort level the session had, in a new terminal.
   * Once its prompt box is shown, ultracode is turned on again and the session is Gasho's to type into: the inputs sent
   * meanwhile follow. A terminal that a restart of gasho-daemon left bringing it back is gone on with instead.
   */
  private async startHibernated(sessionId: string): Promise<CommandResult> {
    const m = this.managed.get(sessionId);
    const h = m?.hibernated;
    if (!m || !h) return { ok: true, sessionId };
    delete h.resumeError;
    // An input can come in while its Claude Code is still ending: two must never have the conversation open.
    await this.hibernating.get(sessionId)?.catch(() => undefined);
    // Its hibernation was called off meanwhile (see hibernate): the Claude Code it has still runs.
    if (m.hibernated !== h) return { ok: true, sessionId };
    const start: ClaudeStart = { accept: (row) => row.sessionId === sessionId, resuming: true };
    const running = this.interrupted.get(sessionId);
    this.interrupted.delete(sessionId);
    let started: ClaudeStarted;
    if (running) {
      log(`going on with bringing ${m.name} (${sessionId}) back in ${running.terminal}`);
      started = await this.claudeListed(running.terminal, running.pid, m.cwd, m.name, start);
    } else {
      // A restart cut its end short, and it was not listed then: it goes on, and takes what waits for it.
      if (this.stillRuns(m, await listAgents(this.cfg.claudeBin)) && !(await this.endsInTime(m))) {
        log(`${m.name} (${sessionId}) still runs in ${m.terminal}; it is not hibernated`);
        this.stayAwake(m, h);
        await this.managed.save();
        await this.refresh();
        this.flushWaitingInputs();
        return { ok: true, sessionId };
      }
      if (!this.canLaunch) return this.wakeFailed(sessionId, NO_TERMINAL);
      const stat = await fsp.stat(m.cwd).catch(() => undefined);
      if (!stat?.isDirectory()) return this.wakeFailed(sessionId, `会話のフォルダーがありません：${m.cwd}`);
      if (await this.openOutside(m)) return this.wakeFailed(sessionId, OPEN_OUTSIDE);
      h.resumingIn = terminalName(m.name);
      await this.managed.save();
      started = await this.startClaude(m.cwd, m.name, { ...start, claudeArgs: resumeArgs(sessionId, h), terminal: h.resumingIn });
    }
    if ("error" in started) {
      return this.wakeFailed(
        sessionId,
        started.needsTrust
          ? "このフォルダーは、もう Claude Code に信頼されていません。「新しいセッション」でこのフォルダーを選んで信頼してから、もう一度再開してください。"
          : started.error,
      );
    }
    const { terminal, pid } = started;
    if (!(await this.promptShown(terminal))) {
      return this.wakeFailed(sessionId, "Claude Code を再開できませんでした（入力欄が時間内に出ませんでした）。");
    }
    if (h.ultracode) {
      const out: InputOutcome = { warnings: [], unapplied: [] };
      await this.setUltracode(terminal, true, out).catch((e: unknown) => log(`${m.name}: could not turn ultracode on again`, e));
      for (const warning of out.warnings) log(`${m.name}: ${warning}`);
    }
    m.terminal = terminal;
    m.pid = pid;
    m.launchedAt = Date.now();
    // What was scheduled ended with the Claude Code before this one.
    delete m.scheduledAt;
    delete m.hibernated;
    if (this.managed.keepWaiting(sessionId)) {
      m.wokenFrom = { ...h };
      delete m.wokenFrom.resumingIn;
      delete m.wokenFrom.resumeError;
    }
    if (h.renamed) this.managed.unshift(sessionId, { text: renameCommand(m.name), auto: true });
    await this.managed.save();
    log(`brought ${m.name} (${sessionId}) back`);
    await this.refresh();
    this.flushWaitingInputs();
    return { ok: true, sessionId };
  }

  /** Waits for Claude Code's prompt box, answering the question about resuming an old, long session on the way. */
  private async promptShown(terminal: string): Promise<boolean> {
    for (let waited = 0; waited < FORK_READY_MS; waited += 300) {
      await sleep(300);
      const s = await this.terminals.screen(terminal).catch(() => undefined);
      if (!s) continue;
      if (resumeQuestionOpen(s.plain)) {
        await this.answerResumeQuestion(terminal).catch((e) => log(`${terminal}: could not answer the question about resuming`, e));
        continue;
      }
      if (typedInBox(s) !== undefined) return true;
    }
    return false;
  }

  /**
   * Removes the temporary folder of a session just removed, once its Claude Code has ended. If it has not, or if the
   * folder is still needed (claudeTmpNeeded), it stays, and sweepClaudeTmp removes it when it is no longer used.
   */
  private async removeClaudeTmp(sessionId: string, pid: number): Promise<void> {
    for (let waited = 0; waited < CLAUDE_END_WAIT_MS && isAlive(pid); waited += 100) await sleep(100);
    if (isAlive(pid) || this.claudeTmpNeeded(sessionId)) {
      log(`the temporary folder of ${sessionId} is left for the regular clean-up`);
      return;
    }
    await removeSessionTmp(this.cfg.claudeTmpDir, sessionId).catch((e: unknown) => log(`could not remove the temporary folder of ${sessionId}`, e));
  }

  /**
   * Whether the temporary folder of `id` is needed by another session: one Gasho keeps that may write to it or was forked
   * from it, a conversation being opened again, or a running session whose conversation shows an image or video from it.
   */
  private claudeTmpNeeded(id: string): boolean {
    if (this.managed.needsTmpOf(id) || this.openingClaudeTmp(id)) return true;
    for (const [sessionId, t] of this.tracked) {
      if (sessionId === id) continue;
      for (const file of t.meta.sentFiles ?? []) if (sessionOfTmpFile(file) === id) return true;
    }
    return false;
  }

  /** Whether a Claude Code is being started on this conversation, and may not be listed yet. */
  private openingClaudeTmp(sessionId: string): boolean {
    const until = this.claudeTmpOpening.get(sessionId);
    if (until !== undefined && until <= Date.now()) this.claudeTmpOpening.delete(sessionId);
    return until !== undefined && until > Date.now();
  }

  /**
   * Removes the temporary folders left behind by sessions that no longer run (Claude Code crashed, or ended while
   * gasho-daemon was stopped). Without the list of what runs, nothing is removed.
   */
  private async sweepClaudeTmp(): Promise<void> {
    if (this.sweepingClaudeTmp) return;
    this.sweepingClaudeTmp = true;
    try {
      const running = new Set((await listAgents(this.cfg.claudeBin)).map((r) => r.sessionId));
      const keep = (id: string) => running.has(id) || this.tracked.has(id) || this.claudeTmpNeeded(id);
      const { removed, failed } = await sweepClaudeTmp(this.cfg.claudeTmpDir, { keep });
      if (removed.length > 0) log(`removed ${removed.length} temporary folder(s) of sessions that no longer run`);
      for (const { dir, error } of failed) log(`could not remove the temporary folder ${dir}`, error);
    } catch (e) {
      log("could not clean up the temporary folders of Claude Code", e);
    } finally {
      this.sweepingClaudeTmp = false;
    }
  }

  /**
   * Removes a worktree with the sessions in it (worktree.remove). Nothing is removed while the worktree has changes that
   * would be lost (unless `force`), nor when a session in it does not end. Those started outside Gasho are ended first
   * (that can fail); those started from Gasho are then removed as with remove. The changes are counted again after the
   * sessions have ended, as a session may have written files meanwhile.
   */
  private async removeWorktree(m: Extract<HubToDaemon, { type: "worktree.remove" }>): Promise<CommandResult> {
    const w = await removableWorktree(m.path);
    if ("error" in w) return { ok: false, error: w.error };
    if (m.branch !== undefined && m.branch !== w.branch) {
      return { ok: false, error: `ブランチ ${m.branch} は、この worktree が checkout しているブランチではありません。` };
    }
    const check = async (): Promise<CommandResult | undefined> => {
      if (m.force) return undefined;
      const changes = await worktreeChanges(w.path, m.pushed);
      const problem = changesProblem(changes);
      return problem ? { ok: false, error: problem, changes } : undefined;
    };
    const refused = await check();
    if (refused) return refused;
    const own = this.managed
      .all()
      .filter((s) => isInside(s.cwd, w.path))
      .map((s) => s.sessionId)
      .concat(this.codexSessions.sessions().filter((s) => isInside(s.cwd, w.path)).map((s) => s.sessionId));
    const outside = [...this.tracked.values()]
      .filter((t) => isInside(t.info.cwd, w.path) && !this.managed.has(t.info.sessionId))
      .map((t) => t.info.sessionId);
    const ended: string[] = [];
    if (outside.length > 0) {
      const r = await this.end(outside);
      ended.push(...(r.ended ?? []));
      if (!r.ok || r.warning) {
        return { ok: false, error: `${r.error ?? r.warning} worktree は削除していません。`, ...(ended.length > 0 ? { ended } : {}) };
      }
    }
    const removed = await Promise.all(own.map((id) => this.remove(id)));
    ended.push(...own.filter((_, i) => removed[i]!.ok));
    const failed = own.filter((_, i) => !removed[i]!.ok);
    if (failed.length > 0) {
      return { ok: false, error: `終了できないセッションがあるため、worktree は削除していません：${failed.join("、")}`, ...(ended.length > 0 ? { ended } : {}) };
    }
    const late = await check();
    if (late) return { ...late, ...(ended.length > 0 ? { ended } : {}) };
    let warning: string | undefined;
    try {
      ({ warning } = await removeWorktree(w, { force: m.force === true, deleteBranch: m.branch !== undefined }));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...(ended.length > 0 ? { ended } : {}) };
    }
    log(
      `removed worktree ${w.path}${m.branch !== undefined && !warning ? ` and branch ${m.branch}` : ""}${m.force ? " (forced)" : ""}` +
        (ended.length > 0 ? `; ended ${ended.length} session(s)` : ""),
    );
    if (warning) log(warning);
    this.repos.delete(w.path);
    await this.refreshRepos();
    void this.refreshFolders();
    return { ok: true, ended, ...(warning ? { warning } : {}) };
  }

  private async input(m: Extract<HubToDaemon, { type: "session.input" }>): Promise<CommandResult> {
    const { sessionId, text, model, effort, ultracode, files } = m;
    if (this.codexSessions.has(sessionId)) return this.inputToCodex(m);
    // By session.sessionId from here on: `sessionId` can be one the session had before /clear (see ManagedSessions.find),
    // and /clear can give it a new id while the files are written (see followNewIds).
    const session = this.managed.find(sessionId);
    if (!session) {
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
      const paths = await this.saveAttachments(session.sessionId, files);
      message = [body, paths.map((p) => `@${p}`).join("\n")].filter(Boolean).join("\n\n");
    }
    this.managed.enqueue(session.sessionId, {
      id: m.requestId,
      text: message,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
    });
    if (session.hibernated) {
      // Saved with the session, and typed once it is back; the screen shows that it is coming back.
      await this.managed.save();
      void this.wake(session.sessionId);
      this.emitSessions();
      return { ok: true, queued: true };
    }
    let outcome: InputOutcome | undefined;
    let failed: string | undefined;
    try {
      // The queue may have held earlier inputs: what happened to those is not this request's to report.
      const flushed = await this.flushInput(session.sessionId);
      if (flushed?.id === m.requestId) outcome = flushed;
    } catch (e) {
      // The input is back on the queue and is sent later: saying that it failed would invite sending it again.
      log(`could not send the input to ${session.sessionId} yet`, e);
      failed = "Claude Code の画面を操作できませんでした。入力は待たせてあり、あとで送ります。";
    }
    const queued = this.managed.pending(session.sessionId) > 0;
    this.emitSessions();
    const warning = [...(outcome?.warnings ?? []), failed].filter(Boolean).join(" ");
    const unapplied = [...new Set(outcome?.unapplied ?? [])];
    return { ok: true, queued, ...(warning ? { warning } : {}), ...(unapplied.length > 0 ? { unapplied } : {}) };
  }

  /** An input to a session of Codex: its text only, for now. What only Claude Code can switch stays as it is. */
  private async inputToCodex(m: Extract<HubToDaemon, { type: "session.input" }>): Promise<CommandResult> {
    if (m.files?.length) return { ok: false, error: "Codex のセッションには、ファイルを添付できません。" };
    const body = m.text.trim();
    if (!body) return { ok: false, error: "入力が空です。" };
    if (body.length > MAX_INPUT) return { ok: false, error: `入力が長すぎます（${MAX_INPUT} 文字まで）。` };
    const unapplied: SwitchField[] = [
      ...(m.model !== undefined ? (["model"] as const) : []),
      ...(m.effort !== undefined ? (["effort"] as const) : []),
      ...(m.ultracode !== undefined ? (["ultracode"] as const) : []),
    ];
    const r = await this.codexSessions.input(m.sessionId, body);
    return r.ok && unapplied.length > 0 ? { ...r, unapplied } : r;
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
    const kept = new Set(this.managed.all().flatMap((m) => [m.sessionId, ...(m.previousIds ?? [])]));
    for (const d of dirs) {
      if (SESSION_ID_RE.test(d) && !kept.has(d)) await fsp.rm(this.attachmentsOf(d), { recursive: true, force: true });
    }
  }

  /**
   * The session's status right now (not the last poll), so input is never typed into a busy session. Idle while only
   * shells and monitors run on in the background (see sessionStatus). From its file while its Claude Code runs (see
   * readStatuses), else from the list.
   */
  private async currentStatus(pid: number): Promise<string | undefined> {
    const reg = isAlive(pid) ? await readRegistry(this.cfg.claudeDir, pid) : undefined;
    if (reg?.status) return sessionStatus(undefined, reg);
    const row = (await listAgents(this.cfg.claudeBin)).find((r) => r.pid === pid);
    return row ? sessionStatus(row, await readRegistry(this.cfg.claudeDir, pid)) : undefined;
  }

  /**
   * Types the next waiting input if the session is idle and no dialog is open. One message per idle period. Returns
   * what happened to the switches asked for with it (undefined when nothing was tried). Throws when a /model picker
   * cannot be closed; the input is then back on the queue.
   */
  private async flushInput(sessionId: string): Promise<InputOutcome | undefined> {
    const m = this.managed.get(sessionId);
    if (!m || this.flushing.has(m.terminal)) return;
    this.flushing.add(m.terminal);
    try {
      // From here on by m.sessionId: /clear can give the session a new id while the input is typed (see followNewIds).
      if (m.hibernated || this.managed.pending(m.sessionId) === 0) return;
      const wait = (this.settleUntil.get(m.sessionId) ?? 0) - Date.now();
      if (wait > 0) {
        this.scheduleRefresh(wait + 100);
        return;
      }
      this.settleUntil.delete(m.sessionId);
      if ((await this.currentStatus(m.pid)) !== "idle") {
        // Busy after an Enter that came back "unsure": Claude Code took it.
        const head = this.managed.peek(m.sessionId);
        if (head?.entered) head.seenBusy = true;
        return;
      }
      const screen = (await this.terminals.screen(m.terminal)).plain;
      // A /model picker (or its question) still open, e.g. from an Enter that Claude Code took late: close it first
      // (Esc changes nothing there). Any other dialog, such as a permission request, is the person's to answer.
      if (modelPickerOptions(screen).length > 0 || switchQuestion(screen)) await this.closePicker(m.terminal);
      else if (dialogOpen(screen)) return;
      const item = this.managed.next(m.sessionId);
      if (item === undefined) return;
      const out: InputOutcome = { ...(item.id ? { id: item.id } : {}), warnings: [], unapplied: [] };
      const later = (ms: number, why: string) => {
        this.settleUntil.set(m.sessionId, Date.now() + ms);
        this.scheduleRefresh(ms + 100);
        log(`${m.name}: ${why}`);
      };
      const t = this.tracked.get(m.sessionId);
      if (item.recheck) {
        const typedBefore = await this.typedBeforeRestart(m, item).catch((e: unknown) => {
          this.managed.unshift(m.sessionId, item);
          throw e;
        });
        if (typedBefore) {
          log(`${m.name}: the input kept over the restart had been typed already`);
          this.emitSessions();
          return out;
        }
        // Not in the transcript: whatever an earlier try did to the prompt box, it is typed from the start.
        for (const done of ["recheck", "typingAt", "entered", "enteredAt", "seenBusy"] as const) delete item[done];
      }
      if (item.keptAt !== undefined && !item.entered) {
        // Saved first: after a restart, only an input marked so can have been typed.
        item.typingAt = Date.now();
        await this.managed.save().catch((e: unknown) => log(`could not save the inputs of ${m.name}`, e));
      }
      if (item.entered) {
        // Taken since the Enter: by its transcript when it is followed (the box can hold the text again after a stop),
        // or else by the session having been busy.
        if (t?.tail) await this.pollTails();
        if (t?.tail ? this.promptTaken(m.sessionId, item.text, item.enteredAt ?? 0) : item.seenBusy) {
          log(`${m.name}: the input whose Enter was late has been taken`);
          if (item.auto) this.titleSent.add(m.sessionId);
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
        if (item.keptAt !== undefined) item.recheck = true;
        this.managed.unshift(m.sessionId, item);
        if (!(e instanceof EnterNotTaken)) throw e;
        later(UNSURE_RETRY_MS, `${e.message}; trying the input again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`Claude Code がすぐに反応しなかったので、${UNSURE_RETRY_MS / 1000} 秒後にやり直します。`);
        this.emitSessions();
        return out;
      }
      // Kept on a retry: the item and its Enter stay as they were.
      const base = {
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        ...(item.auto ? { auto: true } : {}),
        ...(item.keptAt !== undefined ? { keptAt: item.keptAt } : {}),
        ...(item.typingAt !== undefined ? { typingAt: item.typingAt } : {}),
      };
      const entered = item.entered ? { entered: true, enteredAt: item.enteredAt ?? enteredAt, ...(item.seenBusy ? { seenBusy: true } : {}) } : {};
      if (typed === "not-typed") {
        // Model, effort and ultracode are switched already; only the text waits for the next try. A text whose Enter
        // was pressed before stays marked so: it must never be pasted again.
        this.managed.unshift(m.sessionId, { ...base, ...entered });
        later(item.auto ? AUTO_RETRY_MS : RETRY_MS, "could not type the input; trying again later");
        out.warnings.push("入力欄に入れられませんでした。少ししてから送り直します。");
      } else if (typed === "unsure") {
        // Enter was pressed, but the box still held the text: Claude Code may take it late. It is never typed again;
        // a later look drops it if it was taken, and presses Enter only if the box still holds it.
        this.managed.unshift(m.sessionId, { ...base, entered: true, enteredAt: item.enteredAt ?? enteredAt });
        later(UNSURE_RETRY_MS, `the input was not taken yet; looking again in ${UNSURE_RETRY_MS / 1000}s`);
        out.warnings.push(`送ったことを画面で確かめられませんでした。${UNSURE_RETRY_MS / 1000} 秒後に入力欄を見て、まだ残っていれば送ります。`);
      } else {
        if (item.auto) this.titleSent.add(m.sessionId);
        this.scheduleRefresh(500);
      }
      this.emitSessions();
      return out;
    } finally {
      this.flushing.delete(m.terminal);
      if (this.managed.typed(m.sessionId)) await this.managed.save().catch((e: unknown) => log(`could not save the inputs of ${m.name}`, e));
    }
  }

  /**
   * Types `text` into Claude Code's prompt box and presses Enter once, checking each step on the screen:
   * - nothing is typed unless the prompt box is shown and no picker or dialog has the keys; a notice above the box
   *   that has the keys is closed first (the feedback survey with "0", the offer to set up auto mode with Esc);
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
      // Taken after all if the box no longer holds the text. Otherwise press Enter, unless a notice above the box
      // (the survey, the offer to set up auto mode) has the keys.
      if (!promptHolds(ready, text)) return "sent";
      return noticeKey(ready.plain) ? "not-typed" : enter();
    }
    const key = noticeKey(ready.plain);
    if (key) {
      await this.terminals.keys(session, key);
      // Decide on what the screen shows now: had the notice not taken the key, a "0" is in the box.
      ready = await waitFor((s) => !noticeKey(s.plain) && typedInBox(s) !== undefined, 1500);
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

  /**
   * Stops Claude (session.interrupt): its turn with Esc, as in the terminal. Once the turn has ended, Claude Code still
   * reports the session as busy while subagents or workflows that Claude started run on in the background (Claude
   * goes on when they report); Esc would stop nothing then, so those are stopped instead (see stopTasks). Shells and
   * monitors are not: the session is idle while only they run, and they are stopped from the list of its background
   * work. One stop at a time (see INTERRUPT_REPEAT_MS).
   */
  private async interrupt(sessionId: string): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) return this.codexSessions.interrupt(sessionId);
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは Gasho から止められません。公式アプリで止めてください。" };
    if (m.hibernated) return { ok: false, error: "作業中ではありません。" };
    if (Date.now() - (this.lastStop.get(sessionId) ?? 0) < INTERRUPT_REPEAT_MS) return { ok: true };
    const status = await this.currentStatus(m.pid);
    if (status !== "busy") {
      log(`${m.name}: not stopped, for being ${status ?? "out of Claude Code's list"}`);
      const running = this.tracked.get(sessionId)?.info.background?.length;
      return {
        ok: false,
        error: running ? "Claude の作業は終わっています。バックグラウンドで動いているものは、その一覧の「止める」で止めてください。" : "作業中ではありません。",
      };
    }
    this.lastStop.set(sessionId, Date.now());
    const screen = await this.terminals.screen(m.terminal).catch(() => undefined);
    if (screen && waitingForBackground(screen.plain)) {
      log(`${m.name}: Claude waits for work in the background; stopping its subagents and workflows`);
      return this.stopTasks(sessionId, undefined, (kind) => kind === "agent" || kind === "workflow");
    }
    // An input whose Enter came back "unsure" has been taken if the session is busy: it must not be sent again when
    // Claude Code puts the stopped text back into the box.
    const head = this.managed.peek(sessionId);
    if (head?.entered) head.seenBusy = true;
    await this.terminals.keys(m.terminal, "Esc");
    this.lastStop.set(sessionId, Date.now());
    this.settleUntil.set(sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    this.scheduleRefresh(500);
    return { ok: true };
  }

  /**
   * Stops work running in the background (session.stopTask): the task `taskId` of the session's `background`, or else
   * all the work that `which` takes (all of it without). Done as by hand in Claude Code's list of background tasks
   * (see openTasks): the cursor is moved to the task's row, x stops it, and Esc closes the list. Claude Code then
   * tells Claude that the person stopped it. A key is pressed only when the screen shows what it is for; nothing else
   * is typed into the session meanwhile.
   */
  private async stopTasks(sessionId: string, taskId?: string, which?: (kind: BackgroundTaskKind) => boolean): Promise<CommandResult> {
    if (this.codexSessions.has(sessionId)) return { ok: false, error: "Codex のセッションには、バックグラウンドの作業の一覧がありません。" };
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは Gasho から起動したものではないため、止められません。" };
    if (m.hibernated) return { ok: false, error: "このタスクは、もう終わっています。" };
    const known = this.tracked.get(sessionId)?.info.background ?? [];
    const target = taskId === undefined ? undefined : known.find((x) => x.id === taskId);
    if (taskId !== undefined && !target) return { ok: false, error: "このタスクは、もう終わっています。" };
    if (this.flushing.has(m.terminal)) return { ok: false, error: STOP_BUSY_TYPING };
    this.flushing.add(m.terminal);
    try {
      const opened = await this.openTasks(m);
      if (typeof opened === "string") return { ok: false, error: opened };
      let stopped = 0;
      let error: string | undefined;
      for (let i = 0; i < MAX_TASK_STOPS && !error; i++) {
        const d = await this.readTasks(m.terminal);
        // The view of one task closes once it is stopped.
        if (!d) break;
        if (d.view === "details") {
          await this.terminals.keys(m.terminal, "Left");
          if (!(await this.waitTasks(m.terminal, (x) => x?.view === "list"))) error = "Claude Code のタスクの一覧を開けませんでした。";
          continue;
        }
        const active = d.rows.filter(taskRowActive);
        const wanted = (r: TaskRow) => {
          if (!which) return true;
          const kind = this.kindOfRow(r, known);
          return kind !== undefined && which(kind);
        };
        const row = target ? this.rowOfTask(active, target, known) : active.find(wanted);
        if (typeof row === "string") error = row;
        if (!row || typeof row === "string") break;
        if (!(await this.selectTaskRow(m.terminal, row, stopped > 0))) {
          error = "Claude Code のタスクの一覧で、止めるタスクを選べませんでした。";
          break;
        }
        await this.terminals.keys(m.terminal, "x");
        const left = (x: TasksDialog | undefined) => x?.view !== "list" || x.rows.filter(taskRowActive).length < active.length;
        if (!(await this.waitTasks(m.terminal, left))) {
          error = "タスクが止まったかどうか、確かめられませんでした。";
          break;
        }
        stopped++;
        if (target) break;
      }
      await this.closeTasks(m.terminal);
      log(`${m.name}: stopped ${stopped} background task(s)${error ? ` (${error})` : ""}`);
      if (error && stopped === 0) return { ok: false, error };
      if (error) return { ok: true, warning: `${stopped} 件は止めましたが、${error}` };
      if (stopped === 0) return { ok: true, warning: "止めるものは動いていませんでした。" };
      return { ok: true };
    } catch (e) {
      log(`${m.name}: could not stop background work`, e);
      return { ok: false, error: "端末を操作できなかったため、止められませんでした。" };
    } finally {
      this.flushing.delete(m.terminal);
      this.scheduleRefresh(500);
    }
  }

  /**
   * Opens Claude Code's list of background tasks in a session's terminal, from its prompt box: with /tasks once
   * Claude's turn has ended; while it runs (/tasks would only wait in Claude Code's queue), with ↓, which gives the keys
   * to the item for the background tasks under the prompt box, and Enter. Enter only once that item shows it has the
   * keys: on the prompt box, Enter could send Claude Code's suggestion for the next message. Returns the list (or the
   * view of its only task), or why it was not opened.
   */
  private async openTasks(m: ManagedSession): Promise<TasksDialog | string> {
    const status = await this.currentStatus(m.pid);
    if (status === "waiting") return "Claude Code が確認を待っているため、止められませんでした。確認に答えてから、もう一度押してください。";
    const screen = await this.terminals.screen(m.terminal);
    const open = tasksDialog(screen.plain);
    if (open) return open;
    const typed = typedInBox(screen);
    if (typed === undefined) return "端末にほかの画面が開いているため、止められませんでした。";
    if (typed !== "") return "端末の入力欄に書きかけの文があるため、止められませんでした。";
    if (status === "busy" && !waitingForBackground(screen.plain)) {
      await this.terminals.keys(m.terminal, "Down");
      const focused = await this.waitScreenOf(m.terminal, (s) => tasksItemFocused(s) || agentRowFocused(s.plain), 1500);
      if (!focused || !tasksItemFocused(focused)) {
        // ↓ went to the row of subagents under the footer (when only they run): ↑ gives the keys back to the box.
        if (focused) await this.terminals.keys(m.terminal, "Up");
        return "Claude の作業中は、これを止められませんでした。作業が終わってから、もう一度押してください。";
      }
      await this.terminals.keys(m.terminal, "Enter");
    } else if ((await this.typeInput(m.terminal, "/tasks", false, true)) === "not-typed") {
      return "端末に /tasks を入力できなかったため、止められませんでした。";
    }
    const list = await this.waitTasks(m.terminal, (d) => d !== undefined, 3000);
    return typeof list === "object" ? list : "Claude Code のタスクの一覧が開かなかったため、止められませんでした。";
  }

  /** The row of the list of background tasks that shows `task`, or why none can be told. */
  private rowOfTask(active: TaskRow[], task: BackgroundTask, known: BackgroundTask[]): TaskRow | string | undefined {
    let rows = active.filter((r) => taskRowShows(r, [task.command, task.title]));
    // A label that is not the task's own text: the only task of its kind on both sides is the same task.
    if (rows.length === 0) {
      const ofKind = active.filter((r) => taskRowKind(r) === task.kind);
      if (ofKind.length === 1 && known.filter((x) => x.kind === task.kind).length === 1) rows = ofKind;
    }
    if (rows.length === 0) return "Claude Code のタスクの一覧に、このタスクが見つかりませんでした。もう終わっているかもしれません。";
    if (rows.length > 1) return "Claude Code のタスクの一覧で、このタスクをほかと見分けられませんでした。端末で /tasks から止めてください。";
    return rows[0];
  }

  /** What kind of task a row is: by the list's heading, else by the task it shows. */
  private kindOfRow(row: TaskRow, known: BackgroundTask[]): BackgroundTaskKind | undefined {
    return taskRowKind(row) ?? known.find((x) => taskRowShows(row, [x.command, x.title]))?.kind;
  }

  /**
   * Moves the cursor of the list of background tasks to `row`, one key at a time, looking after each. `moved`: x has
   * stopped a task in this list already. The list then shows the cursor on the next row, but x goes to the stopped
   * task until the cursor moves (Claude Code 2.1.325), so a cursor already on the row is moved off it and back (the
   * last row is "Earlier in this session", never a task).
   */
  private async selectTaskRow(terminal: string, row: TaskRow, moved: boolean): Promise<boolean> {
    const same = (r: TaskRow) => r.label === row.label && r.group === row.group && r.state === row.state;
    let keyed = false;
    for (let i = 0; i < MAX_TASK_MOVES; i++) {
      const d = await this.readTasks(terminal);
      if (d?.view !== "list") return false;
      const to = d.rows.findIndex(same);
      if (to < 0) return false;
      if (d.rows[to]!.selected && (keyed || !moved)) return true;
      const at = d.rows.findIndex((r) => r.selected);
      // No row has the cursor: it is on "Earlier in this session", under the tasks.
      await this.terminals.keys(terminal, at === to ? "Down" : at < 0 || at > to ? "Up" : "Down");
      keyed = true;
      await sleep(150);
    }
    return false;
  }

  /** Closes the list of background tasks (or the view of one) with Esc, while it is open: Esc goes nowhere else. */
  private async closeTasks(terminal: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (!(await this.readTasks(terminal))) return;
      await this.terminals.keys(terminal, "Esc");
      if (await this.waitTasks(terminal, (d) => d === undefined, 1500)) return;
    }
    log(`could not close the list of background tasks in ${terminal}`);
  }

  private async readTasks(terminal: string): Promise<TasksDialog | undefined> {
    const s = await this.terminals.screen(terminal).catch(() => undefined);
    return s ? tasksDialog(s.plain) : undefined;
  }

  /** Waits until the list of background tasks (undefined: none open) is as `done` says; returns it, or false. */
  private async waitTasks(terminal: string, done: (d: TasksDialog | undefined) => boolean, ms = 2000): Promise<TasksDialog | true | false> {
    for (let waited = 0; waited < ms; waited += 150) {
      await sleep(150);
      const s = await this.terminals.screen(terminal).catch(() => undefined);
      if (!s) continue;
      const d = tasksDialog(s.plain);
      if (done(d)) return d ?? true;
    }
    return false;
  }

  /** Waits until the screen of a terminal satisfies `done` (polling every 150 ms, up to `ms`). */
  private async waitScreenOf(terminal: string, done: (s: Screen) => boolean, ms: number): Promise<Screen | undefined> {
    for (let waited = 0; waited < ms; waited += 150) {
      await sleep(150);
      const s = await this.terminals.screen(terminal).catch(() => undefined);
      if (s && done(s)) return s;
    }
    return undefined;
  }

  /**
   * Claude's question that gasho-daemon holds no hook for (see PermissionRequestInfo.answerAsMessage): shown from the
   * transcript while a session started from Gasho waits on it. A question with a hook held is shown from that instead.
   */
  private openQuestion(t: Tracked): PermissionRequestInfo[] | undefined {
    const q = t.meta.question;
    const m = this.managed.get(t.info.sessionId);
    if (!q || !m) return undefined;
    // A hibernated session still asks the question it was left with, until that is answered (see answerAsleep).
    if (m.hibernated ? m.hibernated.answeredQuestion === q.toolUseId : t.info.status !== "waiting") return undefined;
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
      message = answersMessage(answers, s.hibernated !== undefined);
    }
    if (s.hibernated) return this.answerAsleep(s, s.hibernated, q.toolUseId, m.requestId, message);
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

  /**
   * Answers the question a session was hibernated with. Its Claude Code has ended, and `claude --resume` does not bring
   * the dialog back: the answers go as the next message, kept with the session and typed once it is back, as an input
   * sent to it would be. "deny" only stops showing the question.
   */
  private async answerAsleep(s: ManagedSession, h: Hibernated, toolUseId: string, requestId: string, message: string | undefined): Promise<CommandResult> {
    h.answeredQuestion = toolUseId;
    if (message) this.managed.enqueue(s.sessionId, { id: requestId, text: message });
    await this.managed.save();
    if (message) void this.wake(s.sessionId);
    this.emitSessions();
    log(`${s.name}: answered the question it was hibernated with${message ? "; the answers go once it is back" : ""}`);
    return { ok: true, ...(message ? { queued: true } : {}) };
  }

  /**
   * A permission dialog that gasho-daemon holds no hook for (see openPermissionRequest): shown from the transcript
   * while a session started from Gasho waits on a permission prompt.
   */
  private openPermission(t: Tracked): PermissionRequestInfo[] | undefined {
    if (t.info.status !== "waiting" || t.info.waitingFor !== "permission prompt" || !this.managed.has(t.info.sessionId)) return undefined;
    const c = dialogCall(t.meta.openCalls, t.dialog);
    return c ? [openPermissionRequest(c)] : undefined;
  }

  /**
   * Answers a permission shown from the transcript (see openPermission) with the keys of Claude Code's dialog: "allow"
   * puts the cursor on "Yes" and presses Enter; "deny" presses Esc, as "No" in the terminal: Claude stops, and a
   * message given goes as the next message. Nothing is pressed unless the session still waits and its screen shows
   * the dialog, about the call on the card (see shownCall): with two calls without a result, the dialog may be about
   * the other.
   */
  private async answerDialog(m: Extract<HubToDaemon, { type: "permission.answer" }>): Promise<CommandResult> {
    const gone: CommandResult = { ok: false, error: "この確認には、すでに答えられています。" };
    const s = this.managed.get(m.sessionId);
    const t = this.tracked.get(m.sessionId);
    const shown = t && this.openPermission(t)?.[0];
    if (!s || !t || shown?.id !== m.permissionId) return gone;
    if (m.decision === "always") return { ok: false, error: "この確認では、今後も許可することはできません。" };
    if ((await this.currentStatus(s.pid)) !== "waiting") return gone;
    const read = async () => {
      const screen = (await this.terminals.screen(s.terminal).catch(() => undefined))?.plain ?? "";
      const text = permissionDialogText(screen);
      return { options: permissionDialog(screen), call: text && shownCall(t.meta.openCalls, text) };
    };
    let dialog = await read();
    const missing: CommandResult = { ok: false, error: "端末に確認の画面が見当たらないため、答えられませんでした。端末か公式アプリで答えてください。" };
    const other: CommandResult = {
      ok: false,
      error: "端末の確認が、このカードの呼び出しについてのものか確かめられないため、答えませんでした。端末か公式アプリで答えてください。",
    };
    if (!dialog.options) return missing;
    if (`${OPEN_DIALOG}${dialog.call?.toolUseId}` !== m.permissionId) return other;
    const message = m.decision === "deny" ? m.message?.trim() : undefined;
    if (m.decision === "deny") {
      await this.terminals.keys(s.terminal, "Esc");
    } else {
      for (let i = 0; dialog.options && !dialog.options[0]!.selected && i < dialog.options.length; i++) {
        await this.terminals.keys(s.terminal, "Up");
        await sleep(150);
        dialog = await read();
      }
      if (!dialog.options?.[0]?.selected) return missing;
      // The dialog may have changed while the cursor moved (answered in the terminal, and the next one opened).
      if (`${OPEN_DIALOG}${dialog.call?.toolUseId}` !== m.permissionId) return other;
      await this.terminals.keys(s.terminal, "Enter");
    }
    this.settleUntil.set(m.sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    if (message) this.managed.enqueue(m.sessionId, { id: m.requestId, text: message });
    this.scheduleRefresh(500);
    this.emitSessions();
    log(`${s.name}: answered Claude Code's permission dialog (${m.decision}) by its keys`);
    return { ok: true, ...(message ? { queued: true } : {}) };
  }
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandResult, GitHubRepo, HubToDaemon, InputFile, SessionInfo, SessionModel, SessionRepo } from "@gasho/protocol";
import type { DaemonConfig } from "./config.ts";
import { githubRepoOf, nestedRepos, readGitGraph } from "./git.ts";
import { startHookServer, summarizeHook } from "./hooks.ts";
import { HubClient } from "./hub-client.ts";
import {
  cleanEnv,
  isAlive,
  launchableFolders,
  launchArgs,
  ManagedSessions,
  PERMISSION_PROMPT_RE,
  SURVEY_RE,
  TRUST_PROMPT_RE,
  clearPromptKeys,
  modelPickerOptions,
  pickerMatches,
  promptBoxLines,
  promptHolds,
  safeFileName,
  Zellij,
  zellijSessionName,
  type PickerOption,
} from "./managed.ts";
import { findTranscript, listAgents, mapStatus, rcModeOf, readRegistry, type AgentRow } from "./sessions.ts";
import { emptyMeta, readTranscript, TranscriptTail, type TranscriptMeta } from "./transcript.ts";
import { log } from "./util.ts";

export const DAEMON_VERSION = "0.5.0";
const GITHUB_CACHE_MS = 5 * 60_000;
/** How long the list of repositories inside a folder (and their branches) is reused. */
const REPOS_CACHE_MS = 60_000;
const FOLDERS_REFRESH_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const MAX_INPUT = 20_000;
const INTERRUPT_SETTLE_MS = 1500;
const MODEL_NAMES: Record<SessionModel, string> = { default: "既定のモデル", opus: "Opus", fable: "Fable", sonnet: "Sonnet", haiku: "Haiku" };
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Tracked {
  info: SessionInfo;
  transcript?: string;
  tail?: TranscriptTail;
  meta: TranscriptMeta;
  /** The transcript did not exist yet when the session was first seen (Claude Code writes it on the first message). */
  sawWithoutTranscript?: boolean;
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

  constructor(cfg: DaemonConfig) {
    this.cfg = cfg;
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
      this.emitSessions();
      for (const m of this.managed.all()) if (this.managed.pending(m.sessionId) > 0) void this.flushInput(m.sessionId);
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
    if (this.hub.connected) this.hub.send({ type: "capabilities", canLaunch: this.canLaunch, folders: this.folders });
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
        this.hub.send({ type: "transcript.append", sessionId: t.info.sessionId, entries });
        this.applyMeta(t);
        changed = true;
      }
      if (changed) this.emitSessions();
    } finally {
      this.polling = false;
    }
  }

  private async onHubMessage(m: HubToDaemon): Promise<void> {
    switch (m.type) {
      case "transcript.get":
        return this.sendTranscriptPage(m);
      case "git.graph.get":
        return this.sendGitGraph(m);
      case "session.launch":
      case "session.input":
      case "session.interrupt": {
        let result: CommandResult;
        try {
          if (m.type === "session.launch") result = await this.launch(m.cwd, m.name);
          else if (m.type === "session.input") result = await this.input(m.sessionId, m.text, m.model, m.files);
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

  /** Branches and history of the repository the session works in. Only for sessions this daemon tracks. */
  private async sendGitGraph(m: Extract<HubToDaemon, { type: "git.graph.get" }>): Promise<void> {
    const reply = { type: "git.graph" as const, requestId: m.requestId, sessionId: m.sessionId, repo: m.repo };
    const t = this.tracked.get(m.sessionId);
    if (!t) {
      this.hub.send({ ...reply, error: "このセッションは見つかりません。" });
      return;
    }
    let dir = t.info.cwd;
    if (m.repo !== undefined) {
      // Only a repository this daemon found inside the session's folder; never a path the browser made up.
      const repo = (await this.reposOf(t.info.cwd))?.find((r) => r.path === m.repo);
      if (!repo) {
        this.hub.send({ ...reply, error: "このリポジトリは見つかりません。" });
        return;
      }
      dir = path.join(t.info.cwd, repo.path);
    }
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
      const screen = await this.zellij.screen(zellijSession).catch(() => "");
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

  private async input(sessionId: string, text: string, model?: SessionModel, files?: InputFile[]): Promise<CommandResult> {
    if (!this.managed.has(sessionId)) {
      return { ok: false, error: "このセッションには Gasho から入力できません。入力できるのは、Gasho が起動したセッションだけです。" };
    }
    const body = text.trim();
    if (!body && !files?.length) return { ok: false, error: "入力が空です。" };
    if (body.length > MAX_INPUT) return { ok: false, error: `入力が長すぎます（${MAX_INPUT} 文字まで）。` };
    let message = body;
    if (files?.length) {
      // Claude Code reads the files mentioned as @path when the message is sent.
      const paths = await this.saveAttachments(sessionId, files);
      message = [body, paths.map((p) => `@${p}`).join("\n")].filter(Boolean).join("\n\n");
    }
    this.managed.enqueue(sessionId, { text: message, ...(model ? { model } : {}) });
    const warning = await this.flushInput(sessionId);
    const queued = this.managed.pending(sessionId) > 0;
    this.emitSessions();
    return { ok: true, queued, ...(warning ? { warning } : {}) };
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
   * Types the next waiting input if the session is idle and no dialog is open. One message per idle period.
   * Returns a warning when the input was sent but its model could not be switched.
   */
  private async flushInput(sessionId: string): Promise<string | undefined> {
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
      if ((await this.currentStatus(m.pid)) !== "idle") return;
      const screen = await this.zellij.screen(m.zellijSession).catch(() => "");
      if (PERMISSION_PROMPT_RE.test(screen) || TRUST_PROMPT_RE.test(screen)) return;
      const item = this.managed.next(sessionId);
      if (item === undefined) return;
      let warning: string | undefined;
      try {
        if (item.model && !sameModel(this.tracked.get(sessionId)?.info.model, item.model)) {
          warning = await this.switchModel(m.zellijSession, item.model);
        }
        if (!(await this.typeInput(m.zellijSession, item.text))) {
          // The model (if any) is switched already; only the text waits for the next try.
          this.managed.unshift(sessionId, { text: item.text });
          log(`could not type into ${m.name}; trying again later`);
          this.emitSessions();
          return warning ?? "入力欄に入れられませんでした。少ししてから送り直します。";
        }
      } catch (e) {
        this.managed.unshift(sessionId, item);
        throw e;
      }
      this.emitSessions();
      this.scheduleRefresh(500);
      return warning;
    } finally {
      this.flushing.delete(sessionId);
    }
  }

  /**
   * Types `text` into Claude Code's prompt box and sends it, checking each step on the screen: a feedback survey is
   * dismissed ("0"), the box is emptied (Claude Code may have put a stopped prompt back), the text must be in the
   * box before Enter, and the box must be empty after it. Tries three times; false when the text could not be sent.
   * When the screen shows no prompt box at all, it pastes and presses Enter without checking.
   */
  private async typeInput(session: string, text: string): Promise<boolean> {
    const screen = () => this.zellij.screen(session).catch(() => "");
    const waitScreen = async (done: (s: string) => boolean, ms: number): Promise<boolean> => {
      for (let waited = 0; waited < ms; waited += 150) {
        await sleep(150);
        if (done(await screen())) return true;
      }
      return false;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let now = await screen();
      if (SURVEY_RE.test(now)) {
        await this.zellij.keys(session, "0");
        await sleep(300);
        now = await screen();
      }
      await this.zellij.keys(session, ...clearPromptKeys(promptBoxLines(now)?.length ?? 1));
      await this.zellij.paste(session, text);
      if (!(await waitScreen((s) => promptHolds(s, text) || !promptBoxLines(s), 1500))) continue;
      if (!promptBoxLines(await screen())) {
        await this.zellij.keys(session, "Enter");
        return true;
      }
      await this.zellij.keys(session, "Enter");
      if (await waitScreen((s) => !promptHolds(s, text), 2500)) return true;
    }
    return false;
  }

  /**
   * Switches the model for this session only through Claude Code's /model picker: its cursor is moved to the model
   * and "s" is pressed. Enter would also save the model as the default for every new session, so Enter is never
   * pressed while the picker is open. Returns a warning when the model stays as it was; throws when the picker
   * cannot be closed, so nothing is typed into it.
   */
  private async switchModel(session: string, model: SessionModel): Promise<string | undefined> {
    const read = async (): Promise<{ screen: string; options: PickerOption[] }> => {
      const screen = await this.zellij.screen(session).catch(() => "");
      return { screen, options: modelPickerOptions(screen) };
    };
    const waitFor = async (done: (r: { screen: string; options: PickerOption[] }) => boolean) => {
      for (let i = 0; i < 15; i++) {
        await sleep(200);
        const r = await read();
        if (done(r)) return r;
      }
      return undefined;
    };
    const close = async (warning: string): Promise<string> => {
      await this.zellij.keys(session, "Esc");
      if (!(await waitFor((r) => r.options.length === 0))) throw new Error("the /model picker did not close");
      return warning;
    };

    if (!(await this.typeInput(session, "/model"))) return "モデルの選択画面を開けませんでした。いまのモデルのまま送ります。";
    const opened = await waitFor((r) => r.options.length > 0);
    if (!opened) return close("モデルの選択画面を開けませんでした。いまのモデルのまま送りました。");
    const target = opened.options.findIndex((o) => pickerMatches(o.label, model));
    if (target < 0) return close(`${MODEL_NAMES[model]} はこのセッションでは選べません。いまのモデルのまま送りました。`);
    const steps = target - Math.max(0, opened.options.findIndex((o) => o.cursor));
    if (steps !== 0) await this.zellij.keys(session, ...Array<string>(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up"));
    const moved = await waitFor((r) => r.options[target]?.cursor === true);
    if (!moved) return close("モデルを選べませんでした。いまのモデルのまま送りました。");
    await this.zellij.keys(session, "s");
    // The confirmation may wrap in the narrow pane, so look for it with the line breaks taken out.
    const done = await waitFor((r) => r.options.length === 0 && /for this session only/.test(r.screen.replace(/\s+/g, " ")));
    if (!done) return close("モデルを切り替えられたか確かめられませんでした。");
    return undefined;
  }

  private async interrupt(sessionId: string): Promise<CommandResult> {
    const m = this.managed.get(sessionId);
    if (!m) return { ok: false, error: "このセッションは Gasho から止められません。公式アプリで止めてください。" };
    if ((await this.currentStatus(m.pid)) !== "busy") return { ok: false, error: "作業中ではありません。" };
    await this.zellij.keys(m.zellijSession, "Esc");
    this.settleUntil.set(sessionId, Date.now() + INTERRUPT_SETTLE_MS);
    this.scheduleRefresh(500);
    return { ok: true };
  }
}

/** Whether the model the session uses ("Opus 5.5") is the one asked for. "default" always switches. */
function sameModel(current: string | undefined, model: SessionModel): boolean {
  return model !== "default" && current !== undefined && current.toLowerCase().startsWith(model);
}

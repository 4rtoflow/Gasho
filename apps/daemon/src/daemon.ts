import fs from "node:fs";
import path from "node:path";
import type { GitHubRepo, HubToDaemon, SessionInfo } from "@gasho/protocol";
import type { DaemonConfig } from "./config.ts";
import { githubRepoOf } from "./git.ts";
import { startHookServer, summarizeHook } from "./hooks.ts";
import { HubClient } from "./hub-client.ts";
import { findTranscript, listAgents, mapStatus, rcModeOf, readRegistry, type AgentRow } from "./sessions.ts";
import { emptyMeta, readTranscript, TranscriptTail, type TranscriptMeta } from "./transcript.ts";
import { log } from "./util.ts";

export const DAEMON_VERSION = "0.1.0";
const GITHUB_CACHE_MS = 5 * 60_000;

interface Tracked {
  info: SessionInfo;
  transcript?: string;
  tail?: TranscriptTail;
  meta: TranscriptMeta;
}

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

  constructor(cfg: DaemonConfig) {
    this.cfg = cfg;
    this.hub = new HubClient({
      url: cfg.hubUrl,
      hello: () => ({ type: "hello", machineId: cfg.machineId, token: cfg.token, daemonVersion: DAEMON_VERSION }),
      onReady: () => {
        this.lastSent = "";
        this.emitSessions();
      },
      onMessage: (m) => void this.onHubMessage(m),
      onRejected: (reason) => {
        log(`the Gasho server rejected this machine (${reason}). Its registration was revoked or is unknown;`);
        log("register again: node src/cli.ts register --server <url> --code <code>");
        process.exit(1);
      },
    });
  }

  start(): void {
    log(`machine ${this.cfg.machineId}, Gasho server ${this.cfg.hubUrl}`);
    if (!this.cfg.hookSecret) log("GASHO_HOOK_SECRET is not set; hook requests are accepted without a secret");
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
      this.emitSessions();
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
      t.transcript = await findTranscript(this.cfg.claudeDir, info.sessionId);
      if (t.transcript) {
        try {
          const { meta, consumed } = await readTranscript(t.transcript);
          t.meta = meta;
          t.tail = new TranscriptTail(t.transcript, consumed);
        } catch (e) {
          log(`cannot read ${t.transcript}`, e);
        }
      }
    }
    info.bridgeSessionId = reg?.bridgeSessionId ?? t.meta.bridgeSessionId;
    this.applyMeta(t);
    info.github = await this.githubOf(info.cwd);
  }

  private applyMeta(t: Tracked): void {
    const { info, meta } = t;
    info.title = meta.title;
    info.gitBranch = meta.gitBranch;
    info.prLinks = meta.prLinks;
    info.costUSD = meta.costUSD;
    info.lastActivityAt = meta.lastActivityAt;
  }

  private async githubOf(cwd: string): Promise<GitHubRepo | undefined> {
    const hit = this.github.get(cwd);
    if (hit && Date.now() - hit.at < GITHUB_CACHE_MS) return hit.repo;
    const repo = await githubRepoOf(cwd);
    this.github.set(cwd, { at: Date.now(), repo });
    return repo;
  }

  private emitSessions(): void {
    const sessions = [...this.tracked.values()]
      .map((t) => t.info)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const json = JSON.stringify(sessions);
    if (json === this.lastSent || !this.hub.connected) return;
    this.lastSent = json;
    this.hub.send({ type: "sessions", sessions });
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
    if (m.type !== "transcript.get") return;
    const t = this.tracked.get(m.sessionId);
    const reply = { type: "transcript.page" as const, requestId: m.requestId, sessionId: m.sessionId };
    if (!t?.transcript) {
      this.hub.send({ ...reply, entries: [], start: 0, total: 0, error: "transcript not found" });
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
}

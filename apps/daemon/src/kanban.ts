// The kanban, after 4rtoflow/Dashboard: each worktree of the watched repositories, with its branch's pull request and
// the Claude Code sessions in it, goes in the column of whoever has to move next. The rules are tried in order and the
// first that matches wins: the sessions first (an answer is awaited even after a merge), then what only I can move (a
// conflict, a failed CI, changes asked for), then what moves by itself (CI running), then what waits for people (a
// draft, the review). It only reads: git and `gh` with the login of whoever runs gasho-daemon.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanReason,
  KanbanRepoOption,
  KanbanSession,
  SessionStatus,
} from "@gasho/protocol";
import { githubRepoOf } from "./git.ts";
import { ghError } from "./github.ts";
import { log } from "./util.ts";

const execFileP = promisify(execFile);

/** How often the watched repositories are read (`gh` twice per repository). */
export const KANBAN_INTERVAL_MS = 60_000;
/** A refresh asked for from Gasho is skipped when the last reading started less than this ago. */
const REFRESH_MIN_MS = 10_000;
/** Repositories read at the same time. */
const PARALLEL = 4;
const PR_LIMIT = 100;
const PR_FIELDS = "number,title,url,headRefName,headRefOid,isDraft,mergeable,reviews,statusCheckRollup,updatedAt";
const CLOSED_FIELDS = "number,headRefName,state,title,url";
const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
/** A number between separators (/ - _ #), so versions such as release/2.1 are not taken for an issue. */
const ISSUE_NUMBER = /(?:^|[/_#-])(\d+)(?=$|[/_-])/;

// ---- what `gh pr list --json` gives ----

export interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string;
}

export interface GhReview {
  author?: { login?: string } | null;
  state?: string;
  submittedAt?: string;
  commit?: { oid?: string } | null;
}

export interface GhPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid?: string;
  isDraft?: boolean;
  mergeable?: string;
  reviews?: GhReview[];
  statusCheckRollup?: GhCheck[];
  updatedAt?: string;
}

export interface GhClosedPr {
  number: number;
  headRefName: string;
  state: string;
  title: string;
  url: string;
}

/** A watched repository as last read. Paths are real paths, to match the sessions' folders. */
export interface RepoMaterial {
  /** OWNER/REPO */
  repo: string;
  me: string;
  primary: { path: string; branch?: string };
  /** Worktrees other than the primary checkout, by branch. */
  worktrees: Map<string, string>;
  /** My open pull requests. */
  prs: GhPr[];
  /** My latest closed pull request of each branch. */
  closed: Map<string, GhClosedPr>;
}

/** A Claude Code session on this machine, as the kanban reads it. */
export interface SessionLike {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  waitingFor?: string;
  managed?: boolean;
}

// ---- the rules ----

export function issueOf(branch: string | undefined): number | undefined {
  const m = ISSUE_NUMBER.exec(branch ?? "");
  return m?.[1] ? Number(m[1]) : undefined;
}

const login = (r: GhReview): string => r.author?.login ?? "";

function runId(url: string | undefined): number {
  const m = /\/actions\/runs\/(\d+)/.exec(url ?? "");
  return m?.[1] ? Number(m[1]) : 0;
}

/** The failed checks. Of the same check, only its latest run counts (a re-run that passed is not a failure). */
export function failedChecks(pr: GhPr): string[] {
  const latest = new Map<string, { run: number; result?: string | null }>();
  for (const c of pr.statusCheckRollup ?? []) {
    if (c.__typename === "StatusContext") {
      latest.set(`status/${c.context ?? ""}`, { run: 0, result: c.state });
      continue;
    }
    const key = `${c.workflowName ?? ""}/${c.name ?? ""}`;
    const run = runId(c.detailsUrl);
    const seen = latest.get(key);
    if (!seen || run >= seen.run) latest.set(key, { run, result: c.conclusion });
  }
  return [...latest].filter(([, v]) => v.result && FAILED.has(v.result)).map(([k]) => k);
}

export function runningChecks(pr: GhPr): string[] {
  const names: string[] = [];
  for (const c of pr.statusCheckRollup ?? []) {
    if (c.__typename === "StatusContext") {
      if (c.state === "PENDING" || c.state === "EXPECTED") names.push(c.context ?? "");
    } else if (c.status !== "COMPLETED") {
      names.push(`${c.workflowName ?? ""}/${c.name ?? ""}`);
    }
  }
  return names;
}

/** Each reviewer's (but mine) latest approval, request for changes or dismissal; reviews of comments only do not count. */
export function reviewers(pr: GhPr, me: string): Map<string, GhReview> {
  const last = new Map<string, GhReview>();
  const sorted = [...(pr.reviews ?? [])].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  for (const r of sorted) {
    if (login(r) !== me && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) last.set(login(r), r);
  }
  return last;
}

/** Who still asks for changes: on the current head, or before something was pushed after it. */
export function changeRequests(pr: GhPr, me: string): { onHead: string[]; pushed: string[] } {
  const onHead: string[] = [];
  const pushed: string[] = [];
  for (const [who, r] of [...reviewers(pr, me)].sort(([a], [b]) => a.localeCompare(b))) {
    if (r.state !== "CHANGES_REQUESTED") continue;
    const oid = r.commit?.oid;
    (oid === undefined || oid === pr.headRefOid ? onHead : pushed).push(who);
  }
  return { onHead, pushed };
}

/**
 * GitHub says UNKNOWN while it computes `mergeable` again; meanwhile the last value is kept, so a conflict does not
 * come and go. `memory` (pull request number → value) is kept per repository between readings.
 */
export function settle(prs: GhPr[], memory: Map<number, string>): GhPr[] {
  const out = prs.map((pr) => {
    let now = pr.mergeable || "UNKNOWN";
    if (now === "UNKNOWN") now = memory.get(pr.number) ?? "UNKNOWN";
    memory.set(pr.number, now);
    return { ...pr, mergeable: now };
  });
  const open = new Set(prs.map((p) => p.number));
  for (const n of [...memory.keys()]) if (!open.has(n)) memory.delete(n);
  return out;
}

interface Turn {
  column: KanbanColumn;
  reason: KanbanReason;
}

/** What the sessions in a worktree decide: a session awaiting an answer before one that works. */
export function agentTurn(sessions: readonly SessionLike[]): Turn | undefined {
  const waiting = sessions.find((s) => s.status === "waiting");
  if (waiting) return { column: "mine", reason: { kind: "agent_waiting", ...(waiting.waitingFor ? { waitingFor: waiting.waitingFor } : {}) } };
  if (sessions.some((s) => s.status === "busy")) return { column: "agent", reason: { kind: "agent_working" } };
  return undefined;
}

/** The column of a worktree: `pr` is its branch's open pull request, `closed` its latest closed one. */
export function judge(pr: GhPr | undefined, closed: GhClosedPr | undefined, me: string, sessions: readonly SessionLike[] = []): Turn {
  const byAgent = agentTurn(sessions);
  if (byAgent) return byAgent;
  if (!pr && closed) return { column: "done", reason: { kind: closed.state === "MERGED" ? "merged" : "closed", pr: closed.number } };
  if (!pr) return { column: "mine", reason: { kind: "no_pr" } };
  if (pr.mergeable === "CONFLICTING") return { column: "mine", reason: { kind: "conflict" } };
  const failed = failedChecks(pr);
  if (failed.length > 0) return { column: "mine", reason: { kind: "ci_failed", checks: failed.slice(0, 2) } };
  const { onHead, pushed } = changeRequests(pr, me);
  if (onHead.length > 0) return { column: "mine", reason: { kind: "changes_requested", who: onHead } };
  const running = runningChecks(pr);
  if (running.length > 0) return { column: "github", reason: { kind: "ci_running", checks: running.slice(0, 2) } };
  if (pr.isDraft) return { column: "mine", reason: { kind: "draft" } };
  if (pushed.length > 0) return { column: "review", reason: { kind: "rereview", who: pushed } };
  if ([...reviewers(pr, me).values()].some((r) => r.state === "APPROVED")) return { column: "mine", reason: { kind: "approved" } };
  return { column: "review", reason: { kind: "review_waiting" } };
}

/** Each session goes to the deepest of `paths` that holds its folder; sessions outside all of them are left out. */
export function assignSessions(sessions: readonly SessionLike[], paths: readonly string[]): Map<string, SessionLike[]> {
  const deepestFirst = [...new Set(paths)].sort((a, b) => b.length - a.length);
  const out = new Map<string, SessionLike[]>();
  for (const s of sessions) {
    const p = deepestFirst.find((d) => s.cwd === d || s.cwd.startsWith(`${d.replace(/\/+$/, "")}/`));
    if (p) out.set(p, [...(out.get(p) ?? []), s]);
  }
  return out;
}

const cardSession = (s: SessionLike): KanbanSession => ({ sessionId: s.sessionId, status: s.status, ...(s.managed ? { managed: true } : {}) });

/**
 * The cards of one repository: its worktrees, its primary checkout while it has an open pull request or a session
 * there works or awaits an answer (work on main is not missed), and my open pull requests without a worktree.
 */
export function cardsOf(m: RepoMaterial, byPath: Map<string, SessionLike[]>): KanbanCard[] {
  const open = new Map(m.prs.map((p) => [p.headRefName, p]));
  const trees: { branch?: string; path: string; primary: boolean }[] = [...m.worktrees].map(([branch, p]) => ({ branch, path: p, primary: false }));
  trees.push({ branch: m.primary.branch, path: m.primary.path, primary: true });
  const cards: KanbanCard[] = [];
  const card = (t: { branch?: string; path?: string; primary: boolean }, pr: GhPr | undefined, closed: GhClosedPr | undefined, sessions: SessionLike[]) => {
    const { column, reason } = judge(pr, closed, m.me, sessions);
    const shown = pr ?? closed;
    const issue = issueOf(t.branch);
    cards.push({
      id: `${m.repo}:${t.path ?? `pr-${pr?.number}`}`,
      repo: m.repo,
      label: t.path ? path.basename(t.path) : `PR #${pr?.number}`,
      ...(t.path ? { path: t.path } : {}),
      ...(t.branch ? { branch: t.branch } : {}),
      ...(t.primary ? { primary: true } : {}),
      title: shown?.title || t.branch || path.basename(t.path ?? ""),
      ...(issue !== undefined ? { issue } : {}),
      ...(pr
        ? { pr: { number: pr.number, url: pr.url, state: "open" as const, ...(pr.isDraft ? { draft: true } : {}) } }
        : closed
          ? { pr: { number: closed.number, url: closed.url, state: closed.state === "MERGED" ? ("merged" as const) : ("closed" as const) } }
          : {}),
      ...(pr?.updatedAt ? { updatedAt: pr.updatedAt } : {}),
      column,
      reason,
      sessions: sessions.map(cardSession),
    });
  };
  for (const t of trees) {
    const pr = t.branch === undefined ? undefined : open.get(t.branch);
    const sessions = byPath.get(t.path) ?? [];
    if (t.primary && !pr && !agentTurn(sessions)) continue;
    card(t, pr, pr || t.branch === undefined ? undefined : m.closed.get(t.branch), sessions);
  }
  const taken = new Set(trees.map((t) => t.branch));
  for (const pr of m.prs) if (!taken.has(pr.headRefName)) card({ branch: pr.headRefName, primary: false }, pr, undefined, []);
  return cards;
}

// ---- reading git and gh ----

/** `git worktree list --porcelain`: the primary checkout first, then the worktrees on a branch (detached ones are left out). */
export function parseWorktrees(porcelain: string): { primary?: { path: string; branch?: string; bare?: boolean }; worktrees: Map<string, string> } {
  let primary: { path: string; branch?: string; bare?: boolean } | undefined;
  const worktrees = new Map<string, string>();
  let current: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length);
      primary ??= { path: current };
    } else if (line === "bare" && primary && current === primary.path) {
      primary.bare = true;
    } else if (line.startsWith("branch refs/heads/") && current) {
      const branch = line.slice("branch refs/heads/".length);
      if (current === primary?.path) primary.branch = branch;
      else worktrees.set(branch, current);
    }
  }
  return { primary, worktrees };
}

function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  return execFileP("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env }).then((r) => r.stdout);
}

async function ghJson(gh: string, args: string[]): Promise<unknown> {
  const { stdout } = await execFileP(gh, args, {
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  });
  return JSON.parse(stdout) as unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** Links shown in browsers: pages on github.com only. */
const githubUrl = (v: unknown): v is string => typeof v === "string" && v.startsWith("https://github.com/");

export function parsePrs(data: unknown): GhPr[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (p): p is GhPr => isRecord(p) && typeof p.number === "number" && typeof p.title === "string" && typeof p.headRefName === "string" && githubUrl(p.url),
  );
}

export function parseClosed(data: unknown): Map<string, GhClosedPr> {
  const rows = (Array.isArray(data) ? data : []).filter(
    (p): p is GhClosedPr =>
      isRecord(p) && typeof p.number === "number" && typeof p.headRefName === "string" && typeof p.state === "string" && githubUrl(p.url),
  );
  // Of the same branch, the newest.
  return new Map(rows.sort((a, b) => a.number - b.number).map((r) => [r.headRefName, r]));
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The repositories in `folders` (the folders Claude Code trusts), one per repository however many of its worktrees
 * are trusted, by their primary checkout. Folders that are not in a repository and bare repositories are left out.
 * Only these can be watched: git runs in a repository's folder, so never in one a browser made up.
 */
export async function repoOptions(folders: readonly string[]): Promise<KanbanRepoOption[]> {
  const found = new Map<string, KanbanRepoOption>();
  for (const dir of folders) {
    const common = await git(dir, ["rev-parse", "--git-common-dir"]).then((s) => path.resolve(dir, s.trim()), () => undefined);
    if (!common || found.has(common)) continue;
    const primary = await git(dir, ["worktree", "list", "--porcelain"]).then((s) => parseWorktrees(s).primary, () => undefined);
    if (!primary || primary.bare) continue;
    const github = await githubRepoOf(primary.path);
    found.set(common, { path: primary.path, ...(github ? { github: `${github.owner}/${github.name}` } : {}) });
  }
  // Those on GitHub first: the others cannot be watched.
  return [...found.values()].sort((a, b) => Number(!a.github) - Number(!b.github) || (a.github ?? a.path).localeCompare(b.github ?? b.path));
}

class KanbanError extends Error {}

/** Reads one watched repository: its worktrees, and my open and closed pull requests. */
async function readRepo(gh: string, option: KanbanRepoOption, me: string, mergeable: Map<number, string>): Promise<RepoMaterial> {
  if (!option.github) throw new KanbanError("origin が GitHub の repo ではないので、見られません。");
  const porcelain = await git(option.path, ["worktree", "list", "--porcelain"]).catch((e: unknown) => {
    throw new KanbanError(`Git の情報を読めませんでした：${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
  });
  const { primary, worktrees } = parseWorktrees(porcelain);
  if (!primary) throw new KanbanError("worktree の一覧を読めませんでした。");
  const list = (state: string, fields: string) =>
    ghJson(gh, ["pr", "list", "--repo", option.github as string, "--author", "@me", "--state", state, "--limit", String(PR_LIMIT), "--json", fields]);
  const [open, closed] = await Promise.all([list("open", PR_FIELDS), list("closed", CLOSED_FIELDS)]).catch((e: unknown) => {
    throw new KanbanError(ghError(e));
  });
  return {
    repo: option.github,
    me,
    primary: { path: realPath(primary.path), ...(primary.branch ? { branch: primary.branch } : {}) },
    worktrees: new Map([...worktrees].map(([b, p]) => [b, realPath(p)])),
    prs: settle(parsePrs(open), mergeable),
    closed: parseClosed(closed),
  };
}

/**
 * The kanban of this machine: reads the watched repositories every KANBAN_INTERVAL_MS, keeps what it read (a
 * repository that fails keeps its last cards, with the error), and makes the board with the sessions of the moment.
 */
export class Kanban {
  private gh: string;
  private onChange: () => void;
  /** The primary checkouts asked for from Gasho, and the repositories that can be watched. */
  private wanted: string[] = [];
  private options: KanbanRepoOption[] = [];
  private material = new Map<string, RepoMaterial>();
  private errors = new Map<string, string>();
  private mergeable = new Map<string, Map<number, string>>();
  private me: string | undefined;
  private updatedAt: number | undefined;
  private checking = false;
  private again = false;
  private startedAt = 0;
  private realCwds = new Map<string, string>();

  constructor(gh: string, onChange: () => void) {
    this.gh = gh;
    this.onChange = onChange;
  }

  start(): void {
    setInterval(() => void this.read(), KANBAN_INTERVAL_MS).unref();
  }

  setOptions(options: KanbanRepoOption[]): void {
    this.options = options;
  }

  /** Watches `paths` (primary checkouts from the options) from now on; reads them at once when they changed. */
  watch(paths: string[]): void {
    const next = [...new Set(paths.filter((p) => typeof p === "string"))];
    if (JSON.stringify(next) === JSON.stringify(this.wanted)) return;
    this.wanted = next;
    for (const map of [this.material, this.errors, this.mergeable]) {
      for (const p of [...map.keys()]) if (!next.includes(p)) map.delete(p);
    }
    this.onChange();
    void this.read();
  }

  /** Reads now, unless a reading is going on or started just before. */
  refresh(): void {
    if (this.checking || Date.now() - this.startedAt < REFRESH_MIN_MS) return;
    void this.read();
  }

  private label(p: string): string {
    return this.options.find((o) => o.path === p)?.github ?? path.basename(p);
  }

  private async read(): Promise<void> {
    if (this.wanted.length === 0) return;
    if (this.checking) {
      // The repositories changed while reading: read again after it, for the ones just added.
      this.again = true;
      return;
    }
    this.checking = true;
    this.startedAt = Date.now();
    this.onChange();
    try {
      let me = this.me;
      let meError: string | undefined;
      if (!me) {
        me = await execFileP(this.gh, ["api", "user", "--jq", ".login"], { timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }).then(
          (r) => r.stdout.trim() || undefined,
          (e: unknown) => {
            meError = ghError(e);
            return undefined;
          },
        );
        this.me = me;
      }
      const queue = [...this.wanted];
      let read = false;
      const worker = async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          const option = this.options.find((o) => o.path === p);
          try {
            if (!option) throw new KanbanError("Claude Code が信頼しているフォルダーの repo ではないので、見られません。");
            if (!me) throw new KanbanError(meError ?? "GitHub のログイン名を読めませんでした。");
            const memory = this.mergeable.get(p) ?? new Map<number, string>();
            this.mergeable.set(p, memory);
            const material = await readRepo(this.gh, option, me, memory);
            if (!this.wanted.includes(p)) continue;
            this.material.set(p, material);
            this.errors.delete(p);
            read = true;
          } catch (e) {
            if (!this.wanted.includes(p)) continue;
            const text = e instanceof KanbanError ? e.message : `読み込めませんでした：${e instanceof Error ? e.message : String(e)}`;
            if (!(e instanceof KanbanError)) log(`kanban: could not read ${p}`, e);
            this.errors.set(p, text);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
      if (read) this.updatedAt = Date.now();
    } finally {
      this.checking = false;
      this.onChange();
      if (this.again) {
        this.again = false;
        void this.read();
      }
    }
  }

  private real(cwd: string): string {
    let r = this.realCwds.get(cwd);
    if (r === undefined) {
      r = realPath(cwd);
      this.realCwds.set(cwd, r);
    }
    return r;
  }

  /** The board with `sessions` as they are now (all Claude Code sessions of this machine). */
  board(sessions: readonly SessionLike[]): KanbanBoard {
    const live = sessions.filter((s) => s.status !== "unknown").map((s) => ({ ...s, cwd: this.real(s.cwd) }));
    const cards: KanbanCard[] = [];
    for (const p of this.wanted) {
      const m = this.material.get(p);
      if (!m) continue;
      cards.push(...cardsOf(m, assignSessions(live, [m.primary.path, ...m.worktrees.values()])));
    }
    return {
      cards,
      errors: this.wanted.flatMap((p) => {
        const error = this.errors.get(p);
        return error ? [{ repo: this.label(p), error }] : [];
      }),
      ...(this.updatedAt ? { updatedAt: this.updatedAt } : {}),
      ...(this.checking ? { checking: true } : {}),
    };
  }
}

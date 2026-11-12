// Open issues and pull requests of a GitHub repository, read with the GitHub CLI (`gh`) of the working server. It
// uses the login of whoever runs gasho-daemon, so Gasho never handles a GitHub token itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitHubCheck,
  GitHubComment,
  GitHubFile,
  GitHubItem,
  GitHubItemDetail,
  GitHubList,
  GitHubListKind,
  GitHubRepo,
  GitHubReview,
} from "@gasho/protocol";

const execFileP = promisify(execFile);

/** Items sent per list. */
export const GITHUB_LIST_LIMIT = 50;
const ISSUE_FIELDS = "number,title,url,author,createdAt,updatedAt,labels";
const PULL_FIELDS = `${ISSUE_FIELDS},isDraft,headRefName,baseRefName,reviewDecision`;
const REVIEW: Record<string, GitHubItem["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

interface GhItem {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  author?: { login?: unknown } | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  labels?: ({ name?: unknown; color?: unknown } | null)[] | null;
  isDraft?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  reviewDecision?: unknown;
}

/** The items of `gh issue list` / `gh pr list --json …` output; anything malformed is left out. */
export function parseGhItems(json: string, kind: GitHubListKind): GitHubItem[] {
  const data = JSON.parse(json) as unknown;
  if (!Array.isArray(data)) return [];
  const items: GitHubItem[] = [];
  for (const raw of data as (GhItem | null)[]) {
    if (typeof raw?.number !== "number" || typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    // Shown as links in browsers: only pages on github.com.
    if (!raw.url.startsWith("https://github.com/")) continue;
    const labels = (raw.labels ?? []).flatMap((l) =>
      typeof l?.name === "string" ? [{ name: l.name, ...(typeof l.color === "string" && /^[0-9a-f]{6}$/i.test(l.color) ? { color: l.color } : {}) }] : [],
    );
    const item: GitHubItem = {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      ...(typeof raw.author?.login === "string" ? { author: raw.author.login } : {}),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      labels,
    };
    if (kind === "pulls") {
      if (raw.isDraft === true) item.draft = true;
      if (typeof raw.headRefName === "string") item.head = raw.headRefName;
      if (typeof raw.baseRefName === "string") item.base = raw.baseRefName;
      const review = typeof raw.reviewDecision === "string" ? REVIEW[raw.reviewDecision] : undefined;
      if (review) item.review = review;
    }
    items.push(item);
  }
  return items;
}

/** Why a `gh` call failed, for the person looking at the list. */
export function ghError(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown; killed?: unknown };
  if (err.code === "ENOENT") {
    return "この working server に GitHub CLI（gh）がありません。gh を入れて、gh auth login でログインしてください。";
  }
  if (err.killed === true) return "GitHub からの応答が遅く、読み込めませんでした。";
  const text = [err.stderr, err.message].filter((t): t is string => typeof t === "string").join("\n");
  if (/gh auth login|not logged in|authentication/i.test(text)) {
    return "この working server の GitHub CLI（gh）がログインしていません。working server で gh auth login を実行してください。";
  }
  if (/Could not resolve to an? (issue|pull ?request)/i.test(text)) return "この番号の Issue や Pull request は見つかりません。";
  if (/Could not resolve to a Repository|HTTP 404|not found/i.test(text)) {
    return "GitHub でこのリポジトリを読めませんでした。gh でログインしているアカウントに権限がないか、リポジトリがありません。";
  }
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("Command failed"));
  return `GitHub から読み込めませんでした：${(first ?? "原因が分かりません").slice(0, 200)}`;
}

/** The open issues or pull requests of `repo`, newest first. */
export async function listGitHub(gh: string, repo: GitHubRepo, kind: GitHubListKind): Promise<GitHubList> {
  const { stdout } = await execFileP(
    gh,
    [
      kind === "issues" ? "issue" : "pr",
      "list",
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--state",
      "open",
      "--limit",
      String(GITHUB_LIST_LIMIT + 1),
      "--json",
      kind === "issues" ? ISSUE_FIELDS : PULL_FIELDS,
    ],
    { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
  );
  const items = parseGhItems(stdout, kind);
  return { repo, kind, items: items.slice(0, GITHUB_LIST_LIMIT), truncated: items.length > GITHUB_LIST_LIMIT };
}

// ---- one issue or pull request ----

const ISSUE_DETAIL_FIELDS = "number,title,url,state,stateReason,author,createdAt,updatedAt,closedAt,labels,assignees,body,comments";
const PULL_DETAIL_FIELDS =
  "number,title,url,state,author,createdAt,updatedAt,closedAt,mergedAt,labels,assignees,body,comments,reviews,isDraft," +
  "headRefName,baseRefName,reviewDecision,additions,deletions,changedFiles,files,commits,statusCheckRollup";
/** Text sent per body or comment, comments per item, and files per pull request. */
const TEXT_MAX = 60_000;
const COMMENTS_MAX = 200;
const FILES_MAX = 300;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const login = (v: unknown): string | undefined => str((v as { login?: unknown } | null | undefined)?.login);
/** Links shown in browsers: https only. */
const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return s?.startsWith("https://") ? s : undefined;
};
const clip = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}\n\n…（長いので、ここから先は GitHub で読んでください）` : s);

const REVIEW_STATE: Record<string, NonNullable<GitHubReview["state"]>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

/** A check run's or commit status's result, in a few words. */
export function checkState(c: { status?: unknown; conclusion?: unknown; state?: unknown }): GitHubCheck["state"] {
  const state = str(c.state)?.toUpperCase();
  if (state) {
    if (state === "SUCCESS") return "success";
    if (state === "FAILURE" || state === "ERROR") return "failure";
    return "pending";
  }
  if (str(c.status)?.toUpperCase() !== "COMPLETED") return "pending";
  switch (str(c.conclusion)?.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    default:
      return "failure";
  }
}

/** `gh issue view` / `gh pr view --json …` output as an item; undefined when it is not one. */
export function parseGhItemDetail(json: string, kind: GitHubListKind): GitHubItemDetail | undefined {
  const raw = JSON.parse(json) as Record<string, unknown> | null;
  const base = parseGhItems(JSON.stringify([raw]), kind)[0];
  if (!raw || !base) return undefined;
  const state = str(raw.state)?.toUpperCase();
  const reason = str(raw.stateReason)?.toUpperCase();
  const comments = (Array.isArray(raw.comments) ? raw.comments : []).flatMap((c): GitHubComment[] => {
    const createdAt = str(c?.createdAt);
    if (!createdAt) return [];
    const minimized = c?.isMinimized === true;
    return [
      {
        ...(login(c?.author) ? { author: login(c?.author) } : {}),
        createdAt,
        body: minimized ? "" : clip(str(c?.body) ?? ""),
        ...(httpsUrl(c?.url) ? { url: httpsUrl(c?.url) } : {}),
        ...(minimized ? { minimized: true } : {}),
      },
    ];
  });
  const item: GitHubItemDetail = {
    ...base,
    kind,
    state: state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open",
    ...(state === "CLOSED" && reason === "NOT_PLANNED" ? { stateReason: "not_planned" as const } : {}),
    ...(state === "CLOSED" && reason === "COMPLETED" ? { stateReason: "completed" as const } : {}),
    ...(str(raw.closedAt) ? { closedAt: str(raw.closedAt) } : {}),
    ...(str(raw.mergedAt) ? { mergedAt: str(raw.mergedAt) } : {}),
    assignees: (Array.isArray(raw.assignees) ? raw.assignees : []).flatMap((a) => (login(a) ? [login(a) as string] : [])),
    body: clip(str(raw.body) ?? ""),
    comments: comments.slice(-COMMENTS_MAX),
    ...(comments.length > COMMENTS_MAX ? { commentsLeftOut: comments.length - COMMENTS_MAX } : {}),
  };
  if (kind !== "pulls") return item;
  // Reviews that only hold comments on lines of the code have no text of their own; those are left out.
  item.reviews = (Array.isArray(raw.reviews) ? raw.reviews : []).flatMap((r): GitHubReview[] => {
    const submittedAt = str(r?.submittedAt);
    const state = REVIEW_STATE[str(r?.state)?.toUpperCase() ?? ""];
    const body = str(r?.body) ?? "";
    if (!submittedAt || !state || (state === "commented" && !body.trim())) return [];
    return [{ ...(login(r?.author) ? { author: login(r?.author) } : {}), submittedAt, state, body: clip(body) }];
  });
  const files = (Array.isArray(raw.files) ? raw.files : []).flatMap((f): GitHubFile[] =>
    str(f?.path) ? [{ path: str(f.path) as string, additions: num(f.additions) ?? 0, deletions: num(f.deletions) ?? 0 }] : [],
  );
  item.files = files.slice(0, FILES_MAX);
  for (const key of ["additions", "deletions", "changedFiles"] as const) {
    const n = num(raw[key]);
    if (n !== undefined) item[key] = n;
  }
  if (Array.isArray(raw.commits)) item.commits = raw.commits.length;
  item.checks = (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).flatMap((c): GitHubCheck[] => {
    const name = str(c?.name) ?? str(c?.context);
    if (!name) return [];
    const workflow = str(c?.workflowName);
    const url = httpsUrl(c?.detailsUrl) ?? httpsUrl(c?.targetUrl);
    return [{ name: workflow && workflow !== name ? `${workflow} / ${name}` : name, state: checkState(c ?? {}), ...(url ? { url } : {}) }];
  });
  return item;
}

/** One issue or pull request of `repo` with its text, comments and (pull requests) reviews, changes and checks. */
export async function viewGitHub(gh: string, repo: GitHubRepo, kind: GitHubListKind, number: number): Promise<GitHubItemDetail> {
  const { stdout } = await execFileP(
    gh,
    [
      kind === "issues" ? "issue" : "pr",
      "view",
      String(number),
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--json",
      kind === "issues" ? ISSUE_DETAIL_FIELDS : PULL_DETAIL_FIELDS,
    ],
    { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
  );
  const item = parseGhItemDetail(stdout, kind);
  if (!item) throw new Error(`gh returned no ${kind === "issues" ? "issue" : "pull request"} #${number}`);
  return item;
}

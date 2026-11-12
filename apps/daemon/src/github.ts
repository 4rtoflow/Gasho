// Open issues and pull requests of a GitHub repository, read with the GitHub CLI (`gh`) of the working server. It
// uses the login of whoever runs gasho-daemon, so Gasho never handles a GitHub token itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubItem, GitHubList, GitHubListKind, GitHubRepo } from "@gasho/protocol";

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

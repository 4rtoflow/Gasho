import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranch, GitCommit, GitGraph, GitHubRepo, GitRef } from "@gasho/protocol";

const execFileP = promisify(execFile);

/** Accepts https (optionally with credentials) and ssh remotes. Never returns the raw URL. */
export function parseGitHubUrl(url: string): GitHubRepo | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m || !m[1] || !m[2]) return undefined;
  return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

export async function githubRepoOf(cwd: string): Promise<GitHubRepo | undefined> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 5000 });
    return parseGitHubUrl(stdout);
  } catch {
    return undefined;
  }
}

// ---- branch graph ----

/** Commits sent per graph, newest first. */
export const GRAPH_LIMIT = 300;
const REF_FORMAT = "%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track,nobracket)";
const LOG_FORMAT = "%H%x00%P%x00%an%x00%at%x00%s";

/** Read-only git: no optional locks (git status would otherwise refresh the index), stable English output. */
async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, env });
  return stdout;
}

/** `%(upstream:track,nobracket)`: "ahead 2, behind 1", "ahead 2", "gone" or "". */
export function parseTrack(track: string): Pick<GitBranch, "ahead" | "behind" | "upstreamGone"> {
  if (track.trim() === "gone") return { upstreamGone: true };
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return { ...(ahead ? { ahead: Number(ahead) } : {}), ...(behind ? { behind: Number(behind) } : {}) };
}

/** Branches, and the branches and tags that point at each commit, from `git for-each-ref --format=REF_FORMAT`. */
export function parseRefs(out: string): { branches: GitBranch[]; tips: Map<string, GitRef[]> } {
  const branches: GitBranch[] = [];
  const tips = new Map<string, GitRef[]>();
  const tip = (hash: string, ref: GitRef) => tips.set(hash, [...(tips.get(hash) ?? []), ref]);
  for (const line of out.split("\n")) {
    const [refname = "", hash = "", peeled = "", upstream = "", track = ""] = line.split("\0");
    if (!hash) continue;
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      branches.push({ name, remote: false, hash, ...(upstream ? { upstream } : {}), ...parseTrack(track) });
      tip(hash, { name, kind: "local" });
    } else if (refname.startsWith("refs/remotes/")) {
      const name = refname.slice("refs/remotes/".length);
      if (name.endsWith("/HEAD")) continue; // origin/HEAD only names the default branch
      branches.push({ name, remote: true, hash });
      tip(hash, { name, kind: "remote" });
    } else if (refname.startsWith("refs/tags/")) {
      // An annotated tag points at a tag object; the commit is the peeled object.
      tip(peeled || hash, { name: refname.slice("refs/tags/".length), kind: "tag" });
    }
  }
  return { branches, tips };
}

/** Commits from `git log --format=LOG_FORMAT`. Subjects and names cannot contain newlines. */
export function parseLog(out: string, tips: Map<string, GitRef[]>): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of out.split("\n")) {
    const [hash = "", parents = "", author = "", at = "0", subject = ""] = line.split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(hash)) continue;
    commits.push({ hash, parents: parents ? parents.split(" ") : [], subject, author, at: Number(at) * 1000, refs: tips.get(hash) ?? [] });
  }
  return commits;
}

/** Counts from `git status --porcelain=v2`: staged and unstaged changes, untracked files. */
export function parseStatus(out: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("? ")) untracked++;
    else if (/^[12u] /.test(line)) {
      if (line[2] !== ".") staged++;
      if (line[3] !== ".") unstaged++;
    }
  }
  return { staged, unstaged, untracked };
}

/** The branches and the latest GRAPH_LIMIT commits of every branch, for the repository that contains `cwd`. */
export async function readGitGraph(cwd: string): Promise<GitGraph> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const [head, headHash, refs, changes] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((s) => s.trim() || undefined, () => undefined),
    git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then((s) => s.trim() || undefined, () => undefined),
    git(cwd, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"]),
    git(cwd, ["status", "--porcelain=v2"]).then(parseStatus, () => undefined),
  ]);
  const { branches, tips } = parseRefs(refs);
  let commits: GitCommit[] = [];
  if (headHash || branches.length > 0) {
    const revs = [...(headHash ? ["HEAD"] : []), "--branches", "--remotes"];
    const out = await git(cwd, ["log", "--topo-order", `--max-count=${GRAPH_LIMIT + 1}`, `--format=${LOG_FORMAT}`, ...revs]);
    commits = parseLog(out, tips);
  }
  return {
    root,
    ...(head ? { head } : {}),
    ...(headHash ? { headHash } : {}),
    branches,
    commits: commits.slice(0, GRAPH_LIMIT),
    truncated: commits.length > GRAPH_LIMIT,
    ...(changes ? { changes } : {}),
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubRepo } from "@gasho/protocol";

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

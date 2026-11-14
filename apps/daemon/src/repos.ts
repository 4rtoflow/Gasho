// The repositories registered with this gasho-daemon (repo.register), whose worktrees the sidebar lists also when they
// have no session. Kept in repos.json in its state folder, in the order they were registered.
import fs from "node:fs/promises";
import path from "node:path";
import type { RegisteredRepo } from "@gasho/protocol";
import { findRepos, githubRepoOf, listWorktrees, worktreeOf } from "./git.ts";

const UNREADABLE = "リポジトリを読めません。フォルダーが無くなったか、git のリポジトリではなくなっています。";
/** Repositories named in the message when a folder holds several. */
const NAMED = 5;

/** The repository `dir` is in, or else the one repository whose worktrees are directly inside it. */
async function repoOf(dir: string): Promise<{ repo: string } | { error: string }> {
  const worktree = await worktreeOf(dir);
  if (worktree) return { repo: worktree.repo };
  const inside = await Promise.all((await findRepos(dir, { maxDepth: 1 })).map((d) => worktreeOf(d)));
  const repos = [...new Set(inside.flatMap((w) => (w ? [w.repo] : [])))].sort();
  if (repos.length === 1) return { repo: repos[0]! };
  if (repos.length === 0) return { error: "このフォルダーは git のリポジトリの中になく、直下にもリポジトリがありません。" };
  const names = repos.slice(0, NAMED).map((r) => path.basename(r).replace(/\.git$/, ""));
  const more = repos.length > NAMED ? ` ほか ${repos.length - NAMED} 個` : "";
  return {
    error: `このフォルダーの直下には、別々のリポジトリが ${repos.length} 個あります（${names.join("、")}${more}）。登録するリポジトリのフォルダーを選んでください。`,
  };
}

export class RegisteredRepos {
  private file: string;
  private paths: string[] = [];
  private saving: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      this.paths = Array.isArray(saved) ? saved.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)) : [];
    } catch {
      this.paths = [];
    }
  }

  /**
   * Registers the repository that the folder `dir` is in: its own folder, also when `dir` is in another of its worktrees.
   * Outside a repository, `dir` may be the folder that a repository and its worktrees are kept side by side in.
   */
  async register(dir: string): Promise<{ path: string } | { error: string }> {
    const stat = await fs.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return { error: `フォルダーがありません：${dir}` };
    const found = await repoOf(dir);
    if ("error" in found) return found;
    if (!this.paths.includes(found.repo)) {
      this.paths.push(found.repo);
      await this.save();
    }
    return { path: found.repo };
  }

  async unregister(repo: string): Promise<void> {
    if (!this.paths.includes(repo)) return;
    this.paths = this.paths.filter((p) => p !== repo);
    await this.save();
  }

  /** The registered repositories with their worktrees, as git lists them now. */
  read(): Promise<RegisteredRepo[]> {
    return Promise.all(
      this.paths.map(async (p): Promise<RegisteredRepo> => {
        const [worktrees, github] = await Promise.all([listWorktrees(p).catch(() => undefined), githubRepoOf(p)]);
        if (!worktrees) return { path: p, worktrees: [], error: UNREADABLE };
        return { path: p, ...(github ? { github } : {}), worktrees };
      }),
    );
  }

  /** One write at a time, each of the list as it is when it runs, so that two changes close together are both kept. */
  private save(): Promise<void> {
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await fs.writeFile(this.file, `${JSON.stringify(this.paths, null, 2)}\n`, { mode: 0o600 });
      });
    return this.saving;
  }
}

// The repositories registered with this gasho-daemon (repo.register), whose worktrees the sidebar lists also when they
// have no session. Kept in repos.json in its state folder, in the order they were registered.
import fs from "node:fs/promises";
import path from "node:path";
import type { RegisteredRepo } from "@gasho/protocol";
import { githubRepoOf, listWorktrees, worktreeOf } from "./git.ts";

const UNREADABLE = "リポジトリを読めません。フォルダーが無くなったか、git のリポジトリではなくなっています。";

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

  /** Registers the repository that the folder `dir` is in: its own folder, also when `dir` is in another of its worktrees. */
  async register(dir: string): Promise<{ path: string } | { error: string }> {
    const stat = await fs.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return { error: `フォルダーがありません：${dir}` };
    const worktree = await worktreeOf(dir);
    if (!worktree) return { error: "このフォルダーは git のリポジトリの中にありません。" };
    if (!this.paths.includes(worktree.repo)) {
      this.paths.push(worktree.repo);
      await this.save();
    }
    return { path: worktree.repo };
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

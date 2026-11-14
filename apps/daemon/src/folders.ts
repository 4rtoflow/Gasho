// Folders made from the Gasho screen before a session starts in them: a new folder, or a GitHub repository cloned with
// the working server's GitHub CLI (`gh repo clone`, with gh's own login, so Gasho never handles a GitHub token). Both
// are made inside a folder the person picked, and nothing that is already there is touched.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** How long a clone may take before it is stopped. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;
/** After SIGTERM, how long gh and git get to end (git removes what it cloned so far) before they are killed. */
const KILL_GRACE_MS = 5000;
/** The longest name of a folder, in bytes, as file systems count them. */
const MAX_NAME_BYTES = 255;
const MAX_REPO = 300;
/** The end of a clone's error output that is kept for its message. */
const STDERR_KEPT = 16 * 1024;

/** A folder that was made (an absolute path), or why it was not. */
export type Made = { path: string } | { error: string };

/** Why `name` cannot be the name of a new folder, or undefined. A name, not a path: one folder at a time. */
export function folderNameProblem(name: string): string | undefined {
  if (!name) return "フォルダーの名前を入れてください。";
  if (name !== name.trim()) return "フォルダーの名前の前後に空白は使えません。";
  if (name === "." || name === "..") return "この名前は使えません。";
  if (name.includes("/")) return "フォルダーの名前に / は使えません。";
  if (/\p{Cc}/u.test(name)) return "フォルダーの名前に改行や制御文字は使えません。";
  // gh and git would read it as an option.
  if (name.startsWith("-")) return "「-」で始まる名前は使えません。";
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return "フォルダーの名前が長すぎます。";
  return undefined;
}

const SEGMENT = "[A-Za-z0-9_.-]+";
/** What `gh repo clone` is given: "name", "owner/name" or "host/owner/name", an https URL, or an SSH address. */
const REPO_FORMS = [
  new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,2}$`),
  new RegExp(`^https://[A-Za-z0-9.-]+(?::[0-9]+)?/${SEGMENT}/${SEGMENT}/?$`),
  new RegExp(`^(?:ssh://)?git@[A-Za-z0-9.-]+[:/]${SEGMENT}/${SEGMENT}$`),
];

/** Why `repo` cannot be cloned with `gh repo clone`, or undefined. */
export function repoProblem(repo: string): string | undefined {
  if (!repo.trim()) return "clone するリポジトリを入れてください。";
  if (repo.length > MAX_REPO) return "リポジトリの指定が長すぎます。";
  if (repo.startsWith("-") || !REPO_FORMS.some((re) => re.test(repo)) || repo.split(/[/:]/).some((p) => p === "." || p === "..")) {
    return "リポジトリは「owner/name」か、GitHub のリポジトリの URL で指定してください。";
  }
  return undefined;
}

/** The folder a clone of `repo` goes into unless another name is given: the repository's name, without ".git". */
export function repoFolderName(repo: string): string | undefined {
  const last = repo.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "");
  return name && !folderNameProblem(name) ? name : undefined;
}

/** `parent` as an absolute path, or why it cannot hold a new folder. */
async function parentFolder(parent: string): Promise<{ dir: string } | { error: string }> {
  if (!path.isAbsolute(parent)) return { error: "フォルダーを絶対パスで指定してください。" };
  const dir = path.resolve(parent);
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) return { error: `フォルダーがありません：${dir}` };
  return { dir };
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

/** Makes the folder `name` inside `parent`. A folder (or file) of that name that is already there is an error. */
export async function createFolder(parent: string, name: string): Promise<Made> {
  const problem = folderNameProblem(name);
  if (problem) return { error: problem };
  const where = await parentFolder(parent);
  if ("error" in where) return where;
  const dir = path.join(where.dir, name);
  try {
    await fs.mkdir(dir);
    return { path: dir };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { error: `同じ名前のフォルダーかファイルが、すでにあります：${dir}` };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { error: `このフォルダーの中には作れません（書き込めません）：${where.dir}` };
    return { error: `フォルダーを作れませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Clones going on, by the folder they make: a second clone into the same folder is refused while the first runs. */
const cloning = new Set<string>();

/**
 * Clones `repo` into the folder `name` inside `parent` (by default, the repository's name) with `gh repo clone`. The
 * folder must not be there yet. gh and git run without a terminal, so they fail rather than wait for a password or a
 * host key that nobody can type; a clone that takes longer than `timeoutMs` is stopped (git then removes what it had
 * cloned).
 */
export async function cloneRepo(
  gh: string,
  parent: string,
  repo: string,
  name?: string,
  { timeoutMs = CLONE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Made> {
  const repoWrong = repoProblem(repo);
  if (repoWrong) return { error: repoWrong };
  const folder = name ?? repoFolderName(repo);
  if (!folder) return { error: "clone 先のフォルダーの名前を入れてください。" };
  const problem = folderNameProblem(folder);
  if (problem) return { error: problem };
  if (!path.isAbsolute(parent)) return { error: "フォルダーを絶対パスで指定してください。" };
  const dir = path.join(path.resolve(parent), folder);
  // Taken before anything is awaited: a second clone asked for at the same moment (a double tap) finds it.
  if (cloning.has(dir)) return { error: `このフォルダーへの clone は、すでに進めています：${dir}` };
  cloning.add(dir);
  try {
    const where = await parentFolder(parent);
    if ("error" in where) return where;
    if (await exists(dir)) return { error: `同じ名前のフォルダーかファイルが、すでにあります：${dir}` };
    // The folder is given, so that the clone goes nowhere but `dir`.
    await runQuietly(gh, ["repo", "clone", repo, folder], where.dir, timeoutMs);
    return { path: dir };
  } catch (e) {
    return { error: cloneError(e, timeoutMs) };
  } finally {
    cloning.delete(dir);
  }
}

interface RunError extends Error {
  code?: unknown;
  stderr?: string;
  timedOut?: boolean;
}

/**
 * Runs `cmd` in `cwd` in a session of its own: without a controlling terminal, git and ssh cannot stop to ask for a
 * password or a host key, and its whole process group can be stopped at once. Rejects with its error output when it
 * fails or takes longer than `timeoutMs`.
 */
function runQuietly(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never", NO_COLOR: "1" },
    });
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr = (stderr + d).slice(-STDERR_KEPT);
    });
    // Never `process.kill(-0)`, which is this daemon's own group: a child that did not start has no pid.
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    const done = (e?: RunError) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (e) reject(e);
      else resolve();
    };
    child.on("error", (e: RunError) => done(Object.assign(e, { stderr })));
    child.on("close", (code, signal) => {
      if (code === 0 && !timedOut) return done();
      done(Object.assign(new Error(`${cmd} ended with ${code ?? signal}`) as RunError, { code: code ?? signal, stderr, timedOut }));
    });
  });
}

/** Why a clone failed, for the person who asked for it. */
export function cloneError(e: unknown, timeoutMs = CLONE_TIMEOUT_MS): string {
  const err = (e ?? {}) as RunError;
  if (err.code === "ENOENT") return "この working server に GitHub CLI（gh）がありません。gh を入れて、gh auth login でログインしてください。";
  if (err.timedOut === true) return `clone が ${Math.round(timeoutMs / 60_000)} 分で終わらなかったので、止めました。`;
  const text = typeof err.stderr === "string" ? err.stderr : "";
  if (/gh auth login|not logged in|GH_TOKEN/i.test(text)) {
    return "この working server の GitHub CLI（gh）がログインしていません。working server で gh auth login を実行してください。";
  }
  if (/Could not resolve to a Repository|HTTP 404|repository .*not found|Repository not found/i.test(text)) {
    return "GitHub にこのリポジトリが見つかりません。名前を確かめてください。非公開のリポジトリなら、gh でログインしているアカウントに読む権限が要ります。";
  }
  if (/already exists and is not an empty directory/i.test(text)) return "同じ名前のフォルダーが、すでにあります。";
  if (/Host key verification failed|Permission denied \(publickey/i.test(text)) {
    return "SSH で GitHub につなげませんでした。gh が SSH で clone する設定（git_protocol が ssh）のときは、working server に SSH の鍵と known_hosts の設定が要ります。gh config set git_protocol https で、HTTPS に切り替えることもできます。";
  }
  if (/Could not resolve host|unable to access|Connection timed out|Network is unreachable|Connection refused/i.test(text)) {
    return "GitHub につなげませんでした。working server のネットワークを確かめてください。";
  }
  const last = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Cloning into|remote:|Receiving objects|Resolving deltas|Updating files)/.test(l))
    .pop();
  return `clone できませんでした：${(last ?? (err.message || "原因が分かりません")).slice(0, 300)}`;
}

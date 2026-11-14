// The folders of the launcher: the names a new folder or a clone may have and the folder a clone goes into, as
// gasho-daemon decides them (apps/daemon/src/folders.ts), and the folders offered to start a session in.

const SEGMENT = "[A-Za-z0-9_.-]+";
/** What `gh repo clone` is given: "name", "owner/name" or "host/owner/name", an https URL, or an SSH address. */
const REPO_FORMS = [
  new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,2}$`),
  new RegExp(`^https://[A-Za-z0-9.-]+(?::[0-9]+)?/${SEGMENT}/${SEGMENT}/?$`),
  new RegExp(`^(?:ssh://)?git@[A-Za-z0-9.-]+[:/]${SEGMENT}/${SEGMENT}$`),
];

/** Why `name` cannot be the name of a new folder, or undefined. A name, not a path: one folder at a time. */
export function folderNameProblem(name: string): string | undefined {
  if (!name) return "フォルダーの名前を入れてください。";
  if (name !== name.trim()) return "フォルダーの名前の前後に空白は使えません。";
  if (name === "." || name === "..") return "この名前は使えません。";
  if (name.includes("/")) return "フォルダーの名前に / は使えません。";
  if (/\p{Cc}/u.test(name)) return "フォルダーの名前に改行や制御文字は使えません。";
  if (name.startsWith("-")) return "「-」で始まる名前は使えません。";
  if (new TextEncoder().encode(name).length > 255) return "フォルダーの名前が長すぎます。";
  return undefined;
}

/** Why `repo` cannot be cloned with `gh repo clone`, or undefined. */
export function repoProblem(repo: string): string | undefined {
  if (!repo.trim()) return "clone するリポジトリを入れてください。";
  if (repo.length > 300) return "リポジトリの指定が長すぎます。";
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

/** The folder `name` inside the folder `parent`. */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** The folder that holds `dir`, or undefined for "/" and the folders right under it. */
function parentOf(dir: string): string | undefined {
  const parts = dir.split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts.slice(0, -1).join("/")}` : undefined;
}

/**
 * The folders offered to start a session in: those Claude Code trusts, the folders that hold them (where a new folder
 * or a clone can go; Claude Code asks before a session starts in one), and those made from the launcher. A folder
 * only two levels down, such as a home folder ("/home/rg", "/Users/rg"), is not offered as a holder: Claude Code never
 * keeps a home folder trusted, so it would ask at every start.
 */
export function folderChoices(trusted: readonly string[], made: readonly string[] = [], withHolders = true): string[] {
  const holders = withHolders
    ? trusted.flatMap((dir) => {
        const parent = parentOf(dir);
        return parent && parent.split("/").filter(Boolean).length >= 3 ? [parent] : [];
      })
    : [];
  return [...new Set([...trusted, ...holders, ...made])].sort();
}

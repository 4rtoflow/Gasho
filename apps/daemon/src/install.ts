// How this gasho-daemon was installed: from a clone of the repository (TypeScript run as is), as the npm package from
// GitHub Packages run through npx (kept in npx's cache, which npm may clear), or as that package installed for good
// (npm install -g). The commands it suggests and the service that keeps it running depend on it.
import path from "node:path";

/** The package on GitHub Packages (npm.pkg.github.com); its scope is the repository's owner. */
export const PACKAGE_NAME = "@4rtoflow/gasho-daemon";

export type Install = { kind: "repo"; repo: string } | { kind: "npx" } | { kind: "package"; cli: string };

/** `cli`: the path of the running cli.ts (from a clone) or cli.js (from the package). */
export function installOf(cli: string): Install {
  const parts = cli.split(path.sep);
  if (parts.includes("_npx")) return { kind: "npx" };
  if (parts.includes("node_modules")) return { kind: "package", cli };
  return { kind: "repo", repo: path.resolve(path.dirname(cli), "../../..") };
}

/** The command to type for gasho-daemon, in messages ("… register", "… run"). */
export function commandOf(i: Install): string {
  switch (i.kind) {
    case "repo":
      return "node apps/daemon/src/cli.ts";
    case "npx":
      return `npx ${PACKAGE_NAME}`;
    case "package":
      return "gasho-daemon";
  }
}

/**
 * What the service runs (before "run") and in which folder. npx's cache is not a place to point at, so a service set
 * up from npx runs npx again for the same version, from its cache when it is there (--prefer-offline).
 */
export function serviceCommand(i: Install, node: string, version: string, home: string): { argv: string[]; cwd: string } {
  switch (i.kind) {
    case "repo":
      return { argv: [node, path.join(i.repo, "apps/daemon/src/cli.ts")], cwd: i.repo };
    case "npx":
      return { argv: [path.join(path.dirname(node), "npx"), "--yes", "--prefer-offline", `${PACKAGE_NAME}@${version}`], cwd: home };
    case "package":
      return { argv: [node, i.cli], cwd: home };
  }
}

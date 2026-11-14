// How this gasho-daemon was installed: from a clone of the repository (TypeScript run as is), as the npm package from
// GitHub Packages run through npx (kept in npx's cache, which npm may clear), as that package installed for good
// (npm install -g), or by `service install` in a folder of its own per version (see Layout), which Gasho can update.
// The commands it suggests and the service that keeps it running depend on it.
import os from "node:os";
import path from "node:path";

/** The package on GitHub Packages (npm.pkg.github.com); its scope is the repository's owner. */
export const PACKAGE_NAME = "@4rtoflow/gasho-daemon";

export type Install =
  | { kind: "repo"; repo: string }
  | { kind: "npx" }
  | { kind: "package"; cli: string }
  /** Installed by `service install` (or by an update) in `versions/<version>` of the layout. */
  | { kind: "managed"; version: string };

/**
 * Where `service install` and updates put gasho-daemon: each version in a folder of its own (an npm prefix:
 * versions/0.15.0/node_modules/@4rtoflow/gasho-daemon), and `current`, a link to the one the service runs. Switching
 * versions changes the link alone; the service's file stays as it is.
 */
export interface Layout {
  root: string;
  versions: string;
  /** The link to the version in use (versions/<version>). */
  current: string;
  /** The last update: { from, to, at } (see self-update.ts). */
  updateFile: string;
}

export function layoutOf(env: NodeJS.ProcessEnv = process.env): Layout {
  const root = env.GASHO_DAEMON_HOME || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "gasho", "daemon");
  return { root, versions: path.join(root, "versions"), current: path.join(root, "current"), updateFile: path.join(root, "update.json") };
}

/** A version as the package registry has it, and as a folder of `versions` is named: x.y.z. */
export const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** The folder of a version, and the cli.js of the package inside it. */
export function versionDir(layout: Layout, version: string): string {
  return path.join(layout.versions, version);
}

export function cliIn(dir: string): string {
  return path.join(dir, "node_modules", ...PACKAGE_NAME.split("/"), "lib", "cli.js");
}

/**
 * `cli`: the path of the running cli.ts (from a clone) or cli.js (from the package). Node.js runs a file through its
 * real path, so one started through `current` is seen in its own folder of `versions`. `versionsDirs`: the layout's
 * `versions` folder, as configured and as its real path (they differ when a folder above it is a link).
 */
export function installOf(cli: string, versionsDirs: string[] = []): Install {
  for (const dir of versionsDirs) {
    const rel = path.relative(dir, cli);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const version = rel.split(path.sep)[0] ?? "";
    if (VERSION_RE.test(version) && cliIn(path.join(dir, version)) === cli) return { kind: "managed", version };
  }
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
    case "managed":
      return `npx ${PACKAGE_NAME}`;
    case "package":
      return "gasho-daemon";
  }
}

/**
 * What the service runs (before "run") and in which folder. npx's cache is not a place to point at, so a service set
 * up from npx runs npx again for the same version, from its cache when it is there (--prefer-offline). One set up by
 * `service install` runs the version that `current` links to.
 */
export function serviceCommand(i: Install, node: string, version: string, home: string, layout: Layout): { argv: string[]; cwd: string } {
  switch (i.kind) {
    case "repo":
      return { argv: [node, path.join(i.repo, "apps/daemon/src/cli.ts")], cwd: i.repo };
    case "npx":
      return { argv: [path.join(path.dirname(node), "npx"), "--yes", "--prefer-offline", `${PACKAGE_NAME}@${version}`], cwd: home };
    case "package":
      return { argv: [node, i.cli], cwd: home };
    case "managed":
      return { argv: [node, cliIn(layout.current)], cwd: home };
  }
}

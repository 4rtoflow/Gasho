// Publishes gasho-daemon (@4rtoflow/gasho-daemon) and the plugin SDK (@4rtoflow/gasho-plugin-sdk) from main. The
// workflow .github/workflows/release.yml runs it every 15 minutes. A package is released when what goes into it changed
// since its last tag (daemon-v<version>, plugin-sdk-v<version>).
//
// Versions are x.y.z. x is fixed: 0 for gasho-daemon, and for the SDK the plugin API's major (1). y goes up for a new
// feature and z for a fix; z goes back to 0 when y goes up. A release is a feature when a pull request merged since the
// last tag has the label "enhancement", or when the plugin API's version (PLUGIN_API) changed. Pull requests do not
// touch versions: the release writes them into the source, commits that to main and tags the commit.
//
//   node scripts/release.ts plan      what to release, and the tags not published yet (also fine to run by hand)
//   node scripts/release.ts apply     writes the new versions into the source
//   node scripts/release.ts pack      builds the packages to release, to check them before anything is pushed
//   node scripts/release.ts commit    commits the versions, tags the commit and pushes both to main at once
//   node scripts/release.ts publish   builds each tag still to publish and publishes it to GitHub Packages
//
// The steps after plan read the plan from $PLAN, and publish the new tags from $TAGS. In GitHub Actions, plan and commit
// write their results to $GITHUB_OUTPUT.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sdkDependencies } from "../packages/plugin-sdk/scripts/tools.ts";

const root = path.resolve(import.meta.dirname, "..");

/** The label that makes a merged pull request a new feature (y goes up) instead of a fix (z goes up). */
export const FEATURE_LABEL = "enhancement";

export type Bump = "minor" | "patch";

interface Package {
  id: "daemon" | "sdk";
  /** The name in messages and in the commit. */
  title: string;
  /** The name on GitHub Packages. */
  name: string;
  tagPrefix: string;
  /** x of x.y.z. */
  major: number;
  /** What goes into the package: a change under these paths releases it. */
  sources: string[];
  /** The file that holds the plugin API's version (PLUGIN_API) the package serves. */
  apiFile: string;
  /** The files the version is written into. */
  versionFiles: string[];
  readVersion(): string;
  writeVersion(version: string): void;
  /** Builds the package into `out`. */
  packScript: string;
  out: string;
  /** Changes outside `sources` that go into the package between `tag` and HEAD, as paths. */
  otherChanges?(tag: string): string[];
}

const DAEMON_TS = "apps/daemon/src/daemon.ts";
const DAEMON_VERSION_RE = /^export const DAEMON_VERSION = "([^"]*)";$/m;
const SDK_JSON = "packages/plugin-sdk/package.json";
const LOCK = "package-lock.json";

export const PACKAGES: Package[] = [
  {
    id: "daemon",
    title: "gasho-daemon",
    name: "@4rtoflow/gasho-daemon",
    tagPrefix: "daemon-v",
    major: 0,
    // @gasho/protocol is left out: gasho-daemon uses only its types, which are gone in the JavaScript.
    sources: ["apps/daemon/src", "apps/daemon/scripts", "apps/daemon/package.json", "apps/daemon/tsconfig.json", "apps/daemon/tsconfig.build.json", "tsconfig.base.json"],
    apiFile: "apps/daemon/src/plugins.ts",
    versionFiles: [DAEMON_TS],
    readVersion: () => DAEMON_VERSION_RE.exec(read(DAEMON_TS))?.[1] ?? fail(`DAEMON_VERSION not found in ${DAEMON_TS}`),
    writeVersion(version) {
      const text = read(DAEMON_TS);
      if (!DAEMON_VERSION_RE.test(text)) fail(`DAEMON_VERSION not found in ${DAEMON_TS}`);
      write(DAEMON_TS, text.replace(DAEMON_VERSION_RE, `export const DAEMON_VERSION = "${version}";`));
    },
    packScript: "apps/daemon/scripts/pack.ts",
    out: "apps/daemon/dist/package",
  },
  {
    id: "sdk",
    title: "SDK",
    name: "@4rtoflow/gasho-plugin-sdk",
    tagPrefix: "plugin-sdk-v",
    // The SDK's major is the plugin API's major (docs/plugins.md); plan checks that they still agree.
    major: 1,
    // The protocol's types go into the SDK as lib/protocol.d.ts.
    sources: ["packages/plugin-sdk", "packages/protocol/src", "tsconfig.base.json"],
    apiFile: "packages/plugin-sdk/src/exports.js",
    versionFiles: [SDK_JSON, LOCK],
    readVersion: () => (JSON.parse(read(SDK_JSON)) as { version: string }).version,
    writeVersion(version) {
      const sdk = JSON.parse(read(SDK_JSON)) as { version: string };
      sdk.version = version;
      write(SDK_JSON, `${JSON.stringify(sdk, null, 2)}\n`);
      // npm ci refuses a lockfile whose workspace versions differ from the package.json files.
      const lock = JSON.parse(read(LOCK)) as { packages: Record<string, { version?: string }> };
      const entry = lock.packages["packages/plugin-sdk"] ?? fail(`packages/plugin-sdk not found in ${LOCK}`);
      entry.version = version;
      write(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
    },
    packScript: "packages/plugin-sdk/scripts/pack.ts",
    out: "packages/plugin-sdk/dist/package",
    // The SDK's package.json takes the build tools' versions from Gasho's screen.
    otherChanges(tag) {
      const file = "apps/web/package.json";
      const tools = (ref: string) => {
        try {
          return JSON.stringify(sdkDependencies(JSON.parse(show(ref, file))));
        } catch {
          return undefined;
        }
      };
      return tools(tag) === tools("HEAD") ? [] : [file];
    },
  },
];

// ---- Versions ----

export function parseVersion(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a version of the form x.y.z: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The version after `last`: y up and z back to 0 for a feature, z up for a fix. x stays `major`. */
export function nextVersion(last: string, bump: Bump, major: number): string {
  const [x, y, z] = parseVersion(last);
  if (x !== major) throw new Error(`the last version ${last} does not have the fixed x ${major}`);
  return bump === "minor" ? `${x}.${y + 1}.0` : `${x}.${y}.${z + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va[0] - vb[0] || va[1] - vb[1] || va[2] - vb[2];
}

/** The newest of the tags `<prefix><x.y.z>`; other tags with the prefix are ignored. */
export function latestTag(tags: string[], prefix: string): string | undefined {
  const versions = tags
    .filter((t) => t.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(t.slice(prefix.length)))
    .map((t) => t.slice(prefix.length));
  versions.sort(compareVersions);
  const last = versions.at(-1);
  return last === undefined ? undefined : prefix + last;
}

export function pluginApi(source: string): string | undefined {
  return /PLUGIN_API = "([^"]+)"/.exec(source)?.[1];
}

// ---- The plan ----

export interface Release {
  id: Package["id"];
  from: string;
  version: string;
  tag: string;
  bump: Bump;
  /** Why the version goes up as it does, for the log and the commit. */
  why: string;
  pulls: number[];
}

export interface Plan {
  /** The commit of main the plan was made on. */
  base: string;
  releases: Release[];
  /** Tags whose version is not on GitHub Packages yet (a publish that failed after the tag was pushed). */
  pending: string[];
}

interface Pull {
  number: number;
  labels: string[];
}

function makePlan(): Plan {
  const base = git("rev-parse", "HEAD");
  const tags = git("tag", "--list", "--merged", "HEAD").split("\n").filter(Boolean);
  const releases: Release[] = [];
  const pending: string[] = [];
  for (const pkg of PACKAGES) {
    const tag = latestTag(tags, pkg.tagPrefix) ?? fail(`no tag ${pkg.tagPrefix}<x.y.z> on main`);
    const from = tag.slice(pkg.tagPrefix.length);
    if (!publishedVersions(pkg.name).includes(from)) pending.push(tag);
    const source = pkg.readVersion();
    if (source !== from) console.log(`::warning::${pkg.title}: the source says ${source}, the last tag ${tag}; the tag wins`);

    const changed = [...git("diff", "--name-only", tag, "HEAD", "--", ...pkg.sources).split("\n").filter(Boolean), ...(pkg.otherChanges?.(tag) ?? [])];
    if (changed.length === 0) {
      console.log(`${pkg.title}: no change since ${tag}`);
      continue;
    }

    const apiThen = pluginApi(showIfThere(tag, pkg.apiFile));
    const apiNow = pluginApi(show("HEAD", pkg.apiFile)) ?? fail(`PLUGIN_API not found in ${pkg.apiFile}`);
    if (pkg.id === "sdk" && Number(apiNow.split(".")[0]) !== pkg.major) {
      fail(`the plugin API is now ${apiNow}; its major must be the SDK's (${pkg.major}): change the SDK's major in scripts/release.ts`);
    }
    const pulls = pullRequests(tag, [...new Set([...pkg.sources, ...changed])]);
    const features = pulls.filter((p) => p.labels.includes(FEATURE_LABEL)).map((p) => p.number);
    const reasons: string[] = [];
    if (apiThen !== apiNow) reasons.push(`PLUGIN_API ${apiThen ?? "-"} → ${apiNow}`);
    if (features.length) reasons.push(`${FEATURE_LABEL}: ${features.map((n) => `#${n}`).join(", ")}`);
    const bump: Bump = reasons.length ? "minor" : "patch";
    const version = nextVersion(from, bump, pkg.major);
    releases.push({
      id: pkg.id,
      from,
      version,
      tag: pkg.tagPrefix + version,
      bump,
      why: bump === "minor" ? `機能の追加。${reasons.join("、")}` : "修正",
      pulls: pulls.map((p) => p.number),
    });
    console.log(`${pkg.title}: ${from} → ${version} (${bump}; ${changed.length} files changed; pull requests ${pulls.map((p) => `#${p.number}`).join(", ") || "none"})`);
  }
  for (const tag of pending) console.log(`${tag}: tagged but not on GitHub Packages yet, publishing it`);
  return { base, releases, pending };
}

/** The merged pull requests of the commits after `tag` that touch `paths`. A commit pushed to main directly has none. */
function pullRequests(tag: string, paths: string[]): Pull[] {
  const shas = git("log", "--format=%H", `${tag}..HEAD`, "--", ...paths).split("\n").filter(Boolean);
  const pulls = new Map<number, Pull>();
  for (const sha of shas) {
    const args = ["api", `repos/{owner}/{repo}/commits/${sha}/pulls`, "--jq", "[.[] | select(.merged_at != null) | {number, labels: [.labels[].name]}]"];
    const gh = spawnSync("gh", args, { cwd: root, encoding: "utf8" });
    if (gh.status !== 0) {
      // A commit not pushed yet, when plan runs by hand on a local branch.
      if (/No commit found/.test(gh.stderr)) {
        console.log(`::warning::${sha.slice(0, 7)} is not on GitHub; it counts as a fix`);
        continue;
      }
      fail(`gh ${args.join(" ")} failed: ${gh.stderr || gh.error?.message}`);
    }
    for (const p of JSON.parse(gh.stdout) as Pull[]) pulls.set(p.number, p);
  }
  return [...pulls.values()].sort((a, b) => a.number - b.number);
}

function publishedVersions(name: string): string[] {
  const out = run("npm", ["view", name, "versions", "--json"]);
  const versions = JSON.parse(out) as string | string[];
  return Array.isArray(versions) ? versions : [versions];
}

// ---- The steps ----

function apply(plan: Plan): void {
  for (const r of plan.releases) {
    pkgOf(r.id).writeVersion(r.version);
    console.log(`${pkgOf(r.id).title}: wrote ${r.version}`);
  }
}

function pack(plan: Plan): void {
  for (const r of plan.releases) build(pkgOf(r.id), r.version);
}

function commit(plan: Plan): string[] {
  if (git("rev-parse", "HEAD") !== plan.base) fail("HEAD is not the commit the plan was made on");
  const files = plan.releases.flatMap((r) => pkgOf(r.id).versionFiles);
  const others = git("diff", "--name-only", "HEAD").split("\n").filter((f) => f && !files.includes(f));
  if (others.length) fail(`files other than the versions changed: ${others.join(", ")}`);

  const titles = plan.releases.map((r) => `${pkgOf(r.id).title} ${r.version}`);
  const lines = plan.releases.map((r) => {
    const pulls = r.pulls.length ? `：${r.pulls.map((n) => `#${n}`).join(" ")}` : "";
    return `${pkgOf(r.id).title} ${r.from} → ${r.version}（${r.why}）${pulls}`;
  });
  git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-m", `${titles.join(" と ")} を公開する`, "-m", lines.join("\n"), "--", ...files);
  const tags = plan.releases.map((r) => r.tag);
  for (const tag of tags) git("tag", tag);

  // At once, so that main never gets the versions without the tags, nor the tags without main.
  try {
    run("git", ["push", "--atomic", "origin", "HEAD:refs/heads/main", ...tags.map((t) => `refs/tags/${t}`)], "inherit");
  } catch (e) {
    const remote = git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0] ?? "";
    if (remote === plan.base) throw e;
    for (const tag of tags) git("tag", "-d", tag);
    console.log(`::notice::main moved on (${remote.slice(0, 7)}) while releasing; the next run releases it`);
    return [];
  }
  console.log(`pushed ${git("rev-parse", "--short", "HEAD")} to main with ${tags.join(", ")}`);
  return tags;
}

function publish(tags: string[]): void {
  for (const tag of tags) {
    const pkg = PACKAGES.find((p) => tag.startsWith(p.tagPrefix)) ?? fail(`no package has the tag ${tag}`);
    const version = tag.slice(pkg.tagPrefix.length);
    if (publishedVersions(pkg.name).includes(version)) {
      console.log(`${pkg.name}@${version} is already published`);
      continue;
    }
    if (git("rev-parse", "HEAD") !== git("rev-parse", `${tag}^{commit}`)) {
      git("checkout", "--quiet", "--detach", tag);
      run("npm", ["ci"], "inherit");
    }
    if (pkg.readVersion() !== version) fail(`${tag} does not match the version in its source, ${pkg.readVersion()}`);
    build(pkg, version);
    run("npm", ["publish", path.join(root, pkg.out)], "inherit");
  }
}

function build(pkg: Package, version: string): void {
  run(process.execPath, [path.join(root, pkg.packScript)], "inherit");
  const built = JSON.parse(read(path.join(pkg.out, "package.json"))) as { name: string; version: string };
  if (built.name !== pkg.name || built.version !== version) fail(`built ${built.name}@${built.version}, not ${pkg.name}@${version}`);
}

// ---- Helpers ----

function pkgOf(id: Package["id"]): Package {
  return PACKAGES.find((p) => p.id === id) ?? fail(`no package ${id}`);
}

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function write(file: string, text: string): void {
  fs.writeFileSync(path.join(root, file), text);
}

function show(ref: string, file: string): string {
  return git("show", `${ref}:${file}`);
}

/** The file at `ref`, or "" when it is not there (a tag from before the file existed). */
function showIfThere(ref: string, file: string): string {
  return git("ls-tree", "--name-only", ref, "--", file) ? show(ref, file) : "";
}

function git(...args: string[]): string {
  return run("git", args).trim();
}

function run(cmd: string, args: string[], stdio: "pipe" | "inherit" = "pipe"): string {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 }) ?? "";
}

function fail(message: string): never {
  throw new Error(message);
}

function output(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

function planFromEnv(): Plan {
  const text = process.env.PLAN;
  if (!text) fail("PLAN is not set: give it what plan wrote");
  return JSON.parse(text) as Plan;
}

if (import.meta.main) {
  const step = process.argv[2];
  if (step === "plan") {
    const plan = makePlan();
    console.log(JSON.stringify(plan, null, 2));
    output({
      plan: JSON.stringify(plan),
      release: String(plan.releases.length > 0),
      daemon: String(plan.releases.some((r) => r.id === "daemon")),
      todo: String(plan.releases.length > 0 || plan.pending.length > 0),
    });
  } else if (step === "apply") {
    apply(planFromEnv());
  } else if (step === "pack") {
    pack(planFromEnv());
  } else if (step === "commit") {
    output({ tags: JSON.stringify(commit(planFromEnv())) });
  } else if (step === "publish") {
    // The new tags first: they are HEAD, so they need no checkout.
    publish([...(JSON.parse(process.env.TAGS || "[]") as string[]), ...planFromEnv().pending]);
  } else {
    console.error("usage: node scripts/release.ts plan | apply | pack | commit | publish");
    process.exit(2);
  }
}

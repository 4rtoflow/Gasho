// Updating gasho-daemon from Gasho (daemon.update). Each version is installed in a folder of its own (Layout in
// install.ts) and the service runs the one `current` links to. An update installs the new version beside the running
// one, runs it once to see that it starts, waits for the inputs still to be typed into sessions (they are not kept over
// a restart), switches `current` and ends with UPDATE_EXIT_CODE; the service manager (systemd: Restart=on-failure,
// launchd: KeepAlive) starts the new version. Until the switch nothing changes, so a failed update leaves the running
// version as it was. The sessions' terminals are processes of their own and go on (each runs from the folder of the
// version that started it, which is kept while it runs).
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CommandResult, DaemonUpdateInfo, DaemonUpdateStep } from "@gasho/protocol";
import { cliIn, type Install, type Layout, PACKAGE_NAME, VERSION_RE, versionDir } from "./install.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "./setup.ts";

/** How gasho-daemon ends to be started again as another version (EX_TEMPFAIL: the service manager restarts it). */
export const UPDATE_EXIT_CODE = 75;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
/** How long an update waits for the inputs still to be typed, before it gives up. */
const WAIT_INPUTS_MS = 5 * 60_000;
const WAIT_POLL_MS = 1000;
/** After the switch: time for the last step to reach the Gasho server before the process ends. */
const EXIT_DELAY_MS = 500;

/** What runs on the working server to make gasho-daemon updatable from Gasho, or to update it by hand. */
export const INSTALL_COMMAND = `npx ${PACKAGE_NAME}@latest service install`;

/** The last update, kept beside the versions: the version to go back to. */
interface UpdateRecord {
  from: string;
  to: string;
  at: number;
}

function run(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...o, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // The end of what it said: npm prints its error last, then where its log is.
      const lines = `${stderr}\n${stdout}`.trim().split("\n").filter((l) => !/A complete log of this run/.test(l));
      const said = lines.slice(-5).join("\n");
      const why = (err as { killed?: boolean }).killed ? "時間がかかりすぎたので止めました" : said || err.message;
      reject(new Error(why));
    });
  });
}

/** npm: GASHO_NPM_BIN, or the npm beside the Node.js that runs gasho-daemon, or the one on PATH. */
export function npmOf(env: NodeJS.ProcessEnv, node: string): string {
  if (env.GASHO_NPM_BIN) return env.GASHO_NPM_BIN;
  const beside = path.join(path.dirname(node), "npm");
  return fs.existsSync(beside) ? beside : "npm";
}

/**
 * Installs `version` of gasho-daemon in its folder of `versions`, unless it is there. It is installed in a hidden
 * folder first and then moved into place, so that a folder of `versions` is always a whole install.
 */
export async function installVersion(layout: Layout, version: string, o: { npm: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const dir = versionDir(layout, version);
  if (fs.existsSync(cliIn(dir))) return dir;
  await fsp.mkdir(layout.versions, { recursive: true });
  const tmp = path.join(layout.versions, `.${version}-${process.pid}-${Date.now().toString(36)}`);
  try {
    await fsp.mkdir(tmp);
    await fsp.writeFile(path.join(tmp, "package.json"), `${JSON.stringify({ private: true, description: `gasho-daemon ${version}` }, null, 2)}\n`);
    // --prefer-online: a version published since npm last read the package's list of versions is found.
    await run(o.npm, ["install", "--prefer-online", "--no-audit", "--no-fund", "--omit=dev", `${PACKAGE_NAME}@${version}`], {
      cwd: tmp,
      env: o.env,
      timeout: INSTALL_TIMEOUT_MS,
    }).catch((e: unknown) => {
      throw new Error(`npm で ${PACKAGE_NAME}@${version} を入れられませんでした：${e instanceof Error ? e.message : String(e)}`);
    });
    if (!fs.existsSync(cliIn(tmp))) throw new Error(`npm で入れた ${PACKAGE_NAME}@${version} に lib/cli.js がありません。`);
    // A folder left without a whole install (by hand) is replaced.
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** Runs the installed version once (`version`, which loads all of it) and checks that it says it is `version`. */
export async function checkVersion(dir: string, version: string, o: { node: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const out = await run(o.node, [cliIn(dir), "version"], { cwd: dir, env: o.env, timeout: CHECK_TIMEOUT_MS }).catch((e: unknown) => {
    throw new Error(`入れた gasho-daemon ${version} が起動しませんでした：${e instanceof Error ? e.message : String(e)}`);
  });
  const said = out.trim().split("\n").pop()?.trim();
  if (said !== version) throw new Error(`入れた gasho-daemon が ${version} ではなく ${said || "不明な版"} でした。`);
}

/** Points `current` at `version`, at once: the link is made aside and renamed over the old one. */
export async function switchTo(layout: Layout, version: string): Promise<void> {
  await fsp.mkdir(layout.root, { recursive: true });
  const tmp = `${layout.current}.${process.pid}`;
  await fsp.rm(tmp, { force: true });
  await fsp.symlink(path.join(path.basename(layout.versions), version), tmp);
  await fsp.rename(tmp, layout.current);
}

/** The version `current` links to, if it links to one. */
export async function currentVersion(layout: Layout): Promise<string | undefined> {
  const target = await fsp.readlink(layout.current).catch(() => undefined);
  const version = target ? path.basename(target) : undefined;
  return version && VERSION_RE.test(version) ? version : undefined;
}

/** The versions installed in `versions`, oldest first. */
export async function installedVersions(layout: Layout): Promise<string[]> {
  const names = await fsp.readdir(layout.versions).catch(() => [] as string[]);
  return names.filter((n) => VERSION_RE.test(n) && fs.existsSync(cliIn(versionDir(layout, n)))).sort(compareVersions);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Notes that `current` went from one version to another: the new one can go back to the old one. */
export async function recordUpdate(layout: Layout, from: string, to: string): Promise<void> {
  const record: UpdateRecord = { from, to, at: Date.now() };
  await fsp.writeFile(layout.updateFile, `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord(layout: Layout): Promise<UpdateRecord | undefined> {
  try {
    const r = JSON.parse(await fsp.readFile(layout.updateFile, "utf8")) as Partial<UpdateRecord>;
    return typeof r.from === "string" && typeof r.to === "string" && typeof r.at === "number" ? (r as UpdateRecord) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The versions that running processes use: a session's terminal runs from the folder of the version that started it,
 * and gasho-daemon itself from its own. Undefined when the processes cannot be listed (then nothing is removed).
 */
export async function versionsInUse(layout: Layout, list: () => Promise<string> = listProcesses): Promise<Set<string> | undefined> {
  const text = await list().catch(() => undefined);
  if (text === undefined) return undefined;
  const used = new Set<string>();
  let real = layout.versions;
  try {
    real = fs.realpathSync.native(layout.versions);
  } catch {
    // not there: nothing installed
  }
  for (const dir of new Set([layout.versions, real])) {
    const prefix = `${dir}${path.sep}`;
    for (const line of text.split("\n")) {
      let at = line.indexOf(prefix);
      while (at >= 0) {
        const version = line.slice(at + prefix.length).split(path.sep)[0] ?? "";
        if (VERSION_RE.test(version)) used.add(version);
        at = line.indexOf(prefix, at + prefix.length);
      }
    }
  }
  return used;
}

function listProcesses(): Promise<string> {
  return run("ps", ["-A", "-o", "args="], { cwd: "/", env: process.env, timeout: 10_000 });
}

/**
 * Whether gasho-daemon runs as the service `service install` set up, which starts it again when it ends: on Linux, in
 * the systemd user service's cgroup; on macOS, started by launchd (its parent) as the agent.
 */
export async function runAsService(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (platform === "linux") {
    const cgroup = await fsp.readFile("/proc/self/cgroup", "utf8").catch(() => "");
    return cgroup.split("\n").some((l) => l.endsWith(`/${SYSTEMD_UNIT}`));
  }
  if (platform === "darwin") return env.XPC_SERVICE_NAME === LAUNCHD_LABEL && process.ppid === 1;
  return false;
}

export interface UpdaterOptions {
  install: Install;
  layout: Layout;
  /** The running version (DAEMON_VERSION). */
  version: string;
  /** Run as the service set up by `service install` (runAsService). */
  service: boolean;
  npm: string;
  node: string;
  env: NodeJS.ProcessEnv;
  /** How many inputs are still to be typed into sessions. */
  waiting: () => number;
  /** The update's state changed (sent to the Gasho server with the capabilities). */
  changed: () => void;
  /** Ends the process, for the service to start the new version. */
  exit: (code: number) => void;
  log: (s: string) => void;
  waitMs?: number;
  pollMs?: number;
}

const STEP_LOG: Record<DaemonUpdateStep, string> = {
  install: "installing",
  check: "checking",
  wait: "waiting for the inputs still to be typed",
  restart: "switched; ending so that the service starts it",
};

/** The update of this gasho-daemon from Gasho: whether it can be, and the one under way. */
export class Updater {
  private o: UpdaterOptions;
  private progress: DaemonUpdateInfo["progress"];
  private failed: DaemonUpdateInfo["failed"];
  private installed: string[] = [];
  private previous: string | undefined;

  constructor(o: UpdaterOptions) {
    this.o = o;
  }

  /** Reads the versions installed beside this one and the one it replaced. */
  async load(): Promise<void> {
    if (this.o.install.kind !== "managed") return;
    this.installed = await installedVersions(this.o.layout);
    const record = await readRecord(this.o.layout);
    this.previous = record?.to === this.o.version && this.installed.includes(record.from) ? record.from : undefined;
  }

  info(): DaemonUpdateInfo {
    const { install, service } = this.o;
    if (install.kind === "repo") {
      return {
        canUpdate: false,
        reason: "リポジトリの clone から動かしているので、Gasho からは更新できません。git pull してから、gasho-daemon を動かし直してください。",
      };
    }
    if (install.kind !== "managed") {
      return {
        canUpdate: false,
        reason: "Gasho から更新できるようにするには、working server でこのコマンドを一度実行してください。常駐の設定が、Gasho から更新できる形に変わります。",
        command: INSTALL_COMMAND,
      };
    }
    if (!service) {
      return {
        canUpdate: false,
        reason: "常駐させずに動かしているので、Gasho からは更新できません。working server でこのコマンドを実行すると、常駐させて Gasho から更新できるようになります。",
        command: INSTALL_COMMAND,
      };
    }
    const installed = this.installed.filter((v) => v !== this.o.version);
    return {
      canUpdate: true,
      installed: installed.length > 0 ? installed : undefined,
      previous: this.previous,
      progress: this.progress,
      failed: this.failed,
    };
  }

  /** Begins an update to `version`; the result says whether it has begun. */
  start(version: string): CommandResult {
    const info = this.info();
    if (!info.canUpdate) return { ok: false, error: info.reason ?? "Gasho からは更新できません。" };
    if (typeof version !== "string" || !VERSION_RE.test(version)) return { ok: false, error: "版の指定が正しくありません。" };
    if (version === this.o.version) return { ok: false, error: `すでに ${version} で動いています。` };
    if (this.progress) return { ok: false, error: `${this.progress.version} に更新している途中です。` };
    this.failed = undefined;
    void this.run(version);
    return { ok: true };
  }

  private step(version: string, step: DaemonUpdateStep): void {
    this.progress = { version, step, at: Date.now() };
    this.o.log(`update to ${version}: ${STEP_LOG[step]}`);
    this.o.changed();
  }

  private async run(version: string): Promise<void> {
    const { layout, npm, node, env } = this.o;
    try {
      this.step(version, "install");
      const dir = await installVersion(layout, version, { npm, env });
      this.step(version, "check");
      await checkVersion(dir, version, { node, env });
      await this.load();
      await this.waitForInputs(version);
      await switchTo(layout, version);
      await recordUpdate(layout, this.o.version, version);
      this.step(version, "restart");
      setTimeout(() => this.o.exit(UPDATE_EXIT_CODE), EXIT_DELAY_MS);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.o.log(`update to ${version} failed: ${error}`);
      this.progress = undefined;
      this.failed = { version, error, at: Date.now() };
      this.o.changed();
    }
  }

  /** Waits until no input is left to type (they would be lost with the restart); gives up after a while. */
  private async waitForInputs(version: string): Promise<void> {
    const until = Date.now() + (this.o.waitMs ?? WAIT_INPUTS_MS);
    let n = this.o.waiting();
    if (n === 0) return;
    this.step(version, "wait");
    while (n > 0) {
      if (Date.now() >= until) {
        throw new Error(`送るのを待っている入力が ${n} 件残っているので、更新をやめました。入力が送られてから、もう一度更新してください。`);
      }
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? WAIT_POLL_MS));
      n = this.o.waiting();
    }
  }

  /**
   * Removes the folders of the versions no longer needed: all but the running one, the one to go back to, and those a
   * running process uses; and what an update left half-done. Returns the versions removed.
   */
  async prune(list?: () => Promise<string>): Promise<string[]> {
    if (this.o.install.kind !== "managed" || this.progress) return [];
    const used = await versionsInUse(this.o.layout, list);
    if (!used) return [];
    const keep = new Set([this.o.version, ...(this.previous ? [this.previous] : []), ...used]);
    const current = await currentVersion(this.o.layout);
    if (current) keep.add(current);
    const removed: string[] = [];
    for (const name of await fsp.readdir(this.o.layout.versions).catch(() => [] as string[])) {
      // Left by an update that did not finish (none is under way now).
      const leftover = name.startsWith(".");
      if (!leftover && (!VERSION_RE.test(name) || keep.has(name))) continue;
      await fsp.rm(path.join(this.o.layout.versions, name), { recursive: true, force: true });
      if (!leftover) removed.push(name);
    }
    if (removed.length > 0) {
      this.o.log(`removed the versions no longer used: ${removed.join(", ")}`);
      await this.load();
      this.o.changed();
    }
    return removed;
  }
}

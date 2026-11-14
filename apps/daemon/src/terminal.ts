// The terminals of the sessions that gasho-daemon starts. Each session gets a small process of its own
// (terminal-host.ts) that runs Claude Code in a pseudo-terminal (node-pty) and keeps its screen in a headless xterm.js
// (the terminal of VS Code). The daemon reads the screen and types keys and text into it over a Unix socket. The
// terminal is a process apart from the daemon, so it outlives restarts of the daemon; where systemd runs for the user,
// it also gets a systemd scope of its own (scopeArgs), outside the daemon's service, which systemd stops as a whole.
// This replaces zellij, which gasho-daemon 0.10 and before needed; the sessions they started keep running in zellij
// until they end (SessionTerminals).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Terminal } from "@xterm/headless";
import { NO_EXPANSION, readScreen, scopeArgs, type Screen, type Zellij } from "./managed.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The size of a terminal while nobody is attached: that of zellij's background sessions, which the parsers know. */
export const TERMINAL_COLS = 50;
export const TERMINAL_ROWS = 50;
/** The version of the socket protocol, in HostHello. */
export const HOST_PROTOCOL = 1;
/** Between two keys: Claude Code tells a lone Esc from the start of a longer key by the time that follows it. */
export const KEY_GAP_MS = 25;
/** How long a new terminal may take to answer. */
const HOST_START_MS = 10_000;
/** How long a request may take (the keys of one request take KEY_GAP_MS each on top). */
const REQUEST_MS = 15_000;

/** The terminal host's script, next to this file (.ts when run from the repository, .js in the npm package). */
const HOST_FILE = fileURLToPath(new URL(`./terminal-host${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/** What a terminal host runs (written to <dir>/<name>.json; the host reads it when it starts). */
export interface HostConfig {
  name: string;
  /** The socket the host answers on. */
  socket: string;
  /** The program (Claude Code), its arguments, its folder and its whole environment. */
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** What a terminal host says about itself. */
export interface HostHello {
  version: number;
  name: string;
  /** The program's PID (Claude Code's), and the host's own. */
  pid: number;
  hostPid: number;
  cwd: string;
  startedAt: number;
  /** Set once the program has exited; the host keeps its last screen for a while. */
  exited?: { code: number; signal?: number };
}

/** What starts a session's terminal. */
export interface TerminalStart {
  name: string;
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** Terminal modes that change what a key sends (xterm.js's `modes`). */
export interface KeyModes {
  applicationCursorKeysMode: boolean;
}

const NAMED_KEYS: Record<string, string> = { Enter: "\r", Esc: "\x1b", Backspace: "\x7f", Tab: "\t", Space: " " };
const ARROWS: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D" };

/**
 * The bytes a key sends, by the names gasho-daemon uses (zellij's): "Enter", "Esc", "Backspace", "Tab", "Space", the
 * arrows ("Up", "Down", "Right", "Left"), "Ctrl <letter>", or one character. Throws for any other name. The arrows
 * follow the program's cursor key mode, as a terminal's do.
 */
export function keyBytes(key: string, modes: KeyModes): string {
  const named = NAMED_KEYS[key];
  if (named !== undefined) return named;
  const arrow = ARROWS[key];
  if (arrow) return `\x1b${modes.applicationCursorKeysMode ? "O" : "["}${arrow}`;
  const ctrl = /^Ctrl ([a-z])$/i.exec(key)?.[1];
  if (ctrl) return String.fromCharCode(ctrl.toLowerCase().charCodeAt(0) - 96);
  if (Array.from(key).length === 1 && !/\p{Cc}/u.test(key)) return key;
  throw new Error(`unknown key: ${JSON.stringify(key)}`);
}

/**
 * The bytes that paste `text`: inside the bracketed-paste markers when the program asked for them, as a terminal
 * pastes, so that Claude Code takes line breaks as part of the text instead of Enter. Escape characters are left out:
 * one in the text could end the paste early and turn the rest of it into keys.
 */
export function pasteBytes(text: string, bracketed: boolean): string {
  const clean = text.replace(/\x1b/g, "");
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}

/**
 * The screen of a terminal as text with only dim (SGR 2/22) and reverse video (SGR 7/27) marked, the way zellij's
 * `dump-screen --ansi` gave it, for readScreen. A wide character is one character, as on the screen.
 */
export function dumpScreen(term: Terminal): string {
  const b = term.buffer.active;
  const cell = b.getNullCell();
  const lines: string[] = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    let s = "";
    let dim = false;
    let inverse = false;
    for (let x = 0; line && x < term.cols; x++) {
      line.getCell(x, cell);
      // The right half of a wide character.
      if (cell.getWidth() === 0) continue;
      const d = cell.isDim() !== 0;
      const i = cell.isInverse() !== 0;
      if (d !== dim) s += d ? "\x1b[2m" : "\x1b[22m";
      if (i !== inverse) s += i ? "\x1b[7m" : "\x1b[27m";
      dim = d;
      inverse = i;
      s += cell.getChars() || " ";
    }
    if (dim || inverse) s += "\x1b[0m";
    lines.push(s);
  }
  return lines.join("\n");
}

/** Where the terminals keep their sockets, settings and logs: beside the daemon's registration. */
export function terminalsDir(stateDir: string): string {
  return path.join(stateDir, "terminals");
}

/** A request to a terminal host, answered with one line of JSON. */
function request(socket: string, req: object, timeoutMs = REQUEST_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    let buf = "";
    let done = false;
    const finish = (err: Error | undefined, res?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      if (err) reject(err);
      else resolve(res ?? {});
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`no answer from ${socket}`), { code: "ETIMEDOUT" })), timeoutMs);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
    c.on("data", (chunk: string) => {
      buf += chunk;
      const end = buf.indexOf("\n");
      if (end < 0) return;
      let res: Record<string, unknown>;
      try {
        res = JSON.parse(buf.slice(0, end)) as Record<string, unknown>;
      } catch {
        finish(new Error(`a bad answer from ${socket}`));
        return;
      }
      if (res.ok === true) finish(undefined, res);
      else finish(new Error(typeof res.error === "string" ? res.error : `${socket} refused the request`));
    });
    c.on("error", (e) => finish(e));
    c.on("close", () => finish(new Error(`${socket} closed the connection`)));
  });
}

/**
 * Whether a pseudo-terminal can be made on this machine: node-pty's prebuilt module (Linux and macOS, x64 and arm64)
 * loads, and a shell started in it exits.
 */
export async function terminalWorks(): Promise<boolean> {
  try {
    const pty = await import("@lydell/node-pty");
    return await new Promise<boolean>((resolve) => {
      const p = pty.spawn("/bin/sh", ["-c", "exit 0"], { cols: 20, rows: 5 });
      const timer = setTimeout(() => {
        p.kill();
        resolve(false);
      }, 5000);
      p.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve(exitCode === 0);
      });
    });
  } catch {
    return false;
  }
}

/** The terminals of this machine (see the top of this file), by name. Every call names the terminal. */
export class Terminals {
  readonly dir: string;
  private env: Record<string, string>;
  /** What systemd-run needs to start user scopes here, or undefined when it cannot (checked once; see scopeFlags). */
  private scopes: Promise<readonly string[] | undefined> | undefined;
  private works: Promise<boolean> | undefined;

  /** `env` is what the hosts run with; `scopes: false` never puts them in a systemd scope (for tests). */
  constructor(o: { stateDir: string; env: Record<string, string>; scopes?: boolean }) {
    this.dir = terminalsDir(o.stateDir);
    this.env = o.env;
    if (o.scopes === false) this.scopes = Promise.resolve(undefined);
  }

  socketOf(name: string): string {
    return path.join(this.dir, `${name}.sock`);
  }

  /** Whether terminals can be made on this machine (see terminalWorks). */
  available(): Promise<boolean> {
    this.works ??= terminalWorks();
    return this.works;
  }

  /**
   * Starts `file args…` in `cwd` in a new terminal named `name`, in a systemd scope of its own where the user's systemd
   * runs. Resolves with the program's PID once the terminal answers; throws (with the end of its log) if it does not.
   */
  async start(o: TerminalStart): Promise<number> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const socket = this.socketOf(o.name);
    // Unix sockets take a path of about 100 bytes at most (104 on macOS).
    if (Buffer.byteLength(socket) > 100) throw new Error(`the path of the terminal's socket is too long: ${socket}`);
    const config: HostConfig = { ...o, socket, cols: TERMINAL_COLS, rows: TERMINAL_ROWS };
    const configFile = path.join(this.dir, `${o.name}.json`);
    await fs.writeFile(configFile, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const logFile = path.join(this.dir, `${o.name}.log`);
    const out = await fs.open(logFile, "a", 0o600);
    const host = [process.execPath, HOST_FILE, configFile];
    const extra = await this.scopeFlags();
    const command = extra ? ["systemd-run", ...scopeArgs(o.name, extra), ...host] : host;
    let failed: string | undefined;
    try {
      const child = spawn(command[0] ?? "", command.slice(1), { detached: true, stdio: ["ignore", out.fd, out.fd], env: this.env });
      child.on("error", (e) => (failed ??= e.message));
      child.on("exit", (code, signal) => (failed ??= `it exited (${signal ?? `code ${code}`})`));
      child.unref();
    } finally {
      await out.close();
    }
    for (const deadline = Date.now() + HOST_START_MS; Date.now() < deadline; ) {
      const hello = await this.hello(o.name).catch(() => undefined);
      if (hello) return hello.pid;
      if (failed) break;
      await sleep(50);
    }
    // The end of its log tells why (read before closing it: a host that closes removes its log).
    const tail = (await fs.readFile(logFile, "utf8").catch(() => "")).trim().split("\n").slice(-5).join("\n");
    await this.kill(o.name);
    for (const f of [socket, configFile, logFile]) await fs.rm(f, { force: true });
    throw new Error(`the terminal ${o.name} did not start${failed ? ` (${failed})` : ""}${tail ? `:\n${tail}` : ""}`);
  }

  async hello(name: string): Promise<HostHello> {
    return (await request(this.socketOf(name), { op: "hello" }, 5000)) as unknown as HostHello;
  }

  /**
   * The terminals that answer, with what each says about itself. A socket that nobody listens on any more (its host
   * died) is removed; one whose host is only slow to answer is kept.
   */
  async live(): Promise<Map<string, HostHello>> {
    const out = new Map<string, HostHello>();
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".sock"))) {
      const name = file.slice(0, -".sock".length);
      try {
        out.set(name, await this.hello(name));
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (code === "ECONNREFUSED" || code === "ENOENT") {
          for (const ext of [".sock", ".json"]) await fs.rm(path.join(this.dir, `${name}${ext}`), { force: true });
        }
      }
    }
    return out;
  }

  /** The terminal's screen, with what is drawn dim told apart (see Screen). */
  async screen(name: string): Promise<Screen> {
    const res = await request(this.socketOf(name), { op: "screen" });
    return readScreen(typeof res.ansi === "string" ? res.ansi : "");
  }

  async keys(name: string, ...keys: string[]): Promise<void> {
    await request(this.socketOf(name), { op: "keys", keys }, REQUEST_MS + keys.length * KEY_GAP_MS);
  }

  async paste(name: string, text: string): Promise<void> {
    await request(this.socketOf(name), { op: "paste", text });
  }

  /** Closes the terminal: its program gets SIGHUP (then SIGKILL), and the host ends. Nothing happens if it is gone. */
  async kill(name: string): Promise<void> {
    await request(this.socketOf(name), { op: "kill" }, 5000).catch(() => undefined);
  }

  /**
   * How systemd-run starts a user scope here that runs its command as it is given, "$" included (see NO_EXPANSION):
   * each way is tried on a node that prints "$$", with --expand-environment=no first, then without it (systemd older
   * than 254). Undefined when neither prints it unchanged, or when there is no user manager (macOS): terminals then
   * start without a scope of their own.
   */
  private scopeFlags(): Promise<readonly string[] | undefined> {
    this.scopes ??= (async () => {
      for (const extra of [NO_EXPANSION, []]) {
        const command = ["--user", "--scope", "--quiet", "--collect", ...extra, "--", process.execPath, "-p", "'$$'"];
        const printed = await execFileP("systemd-run", command, { env: this.env, timeout: 15_000 }).then(
          (r) => r.stdout.trim(),
          () => undefined,
        );
        if (printed === "$$") return extra;
      }
      return undefined;
    })();
    return this.scopes;
  }
}

/**
 * The terminals of the sessions Gasho started: the built-in ones, and zellij for the sessions that gasho-daemon 0.10
 * and before started, until they end (useZellij marks them when the daemon starts).
 */
export class SessionTerminals {
  readonly builtIn: Terminals;
  readonly zellij: Zellij;
  private inZellij = new Set<string>();

  constructor(builtIn: Terminals, zellij: Zellij) {
    this.builtIn = builtIn;
    this.zellij = zellij;
  }

  useZellij(name: string): void {
    this.inZellij.add(name);
  }

  private of(name: string): Terminals | Zellij {
    return this.inZellij.has(name) ? this.zellij : this.builtIn;
  }

  /** Starts a new session's terminal (always a built-in one); resolves with the program's PID. */
  start(o: TerminalStart): Promise<number> {
    return this.builtIn.start(o);
  }

  screen(name: string): Promise<Screen> {
    return this.of(name).screen(name);
  }

  keys(name: string, ...keys: string[]): Promise<void> {
    return this.of(name).keys(name, ...keys);
  }

  paste(name: string, text: string): Promise<void> {
    return this.of(name).paste(name, text);
  }

  async kill(name: string): Promise<void> {
    await this.of(name).kill(name);
    this.inZellij.delete(name);
  }
}

/** The terminals that answer, oldest first (`gasho-daemon attach` without a name). */
export async function listTerminals(stateDir: string): Promise<HostHello[]> {
  const t = new Terminals({ stateDir, env: {}, scopes: false });
  return [...(await t.live()).values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** What the terminal is reset to when `attach` leaves it: the modes Claude Code may have turned on, cursor shown. */
const LEAVE = "\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4m";
/** Ctrl+], which leaves `attach` (as in telnet). */
const DETACH = "\x1d";

/**
 * Shows a session's terminal in this one and passes its keys on (`gasho-daemon attach <name>`), until Ctrl+] or the
 * end of the session. Meanwhile the session's terminal takes the size of this one; then it goes back to its own.
 */
export async function attach(stateDir: string, name: string): Promise<void> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("attach needs a terminal");
  const c = net.connect(path.join(terminalsDir(stateDir), `${name}.sock`));
  await new Promise<void>((resolve, reject) => {
    c.once("connect", resolve);
    c.once("error", reject);
  });
  const send = (m: object) => c.write(`${JSON.stringify(m)}\n`);
  let ended = "";
  const onResize = () => send({ resize: [stdout.columns, stdout.rows] });
  const onInput = (d: string) => {
    const at = d.indexOf(DETACH);
    if (at < 0) {
      send({ in: d });
      return;
    }
    if (at > 0) send({ in: d.slice(0, at) });
    c.end();
  };
  c.setEncoding("utf8");
  let buf = "";
  c.on("data", (chunk: string) => {
    buf += chunk;
    for (let end = buf.indexOf("\n"); end >= 0; end = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, end)) as { ok?: boolean; error?: string; out?: string; exit?: { code: number; signal?: number } };
      buf = buf.slice(end + 1);
      if (m.out !== undefined) stdout.write(m.out);
      if (m.ok === false) ended = m.error ?? "refused";
      if (m.exit) ended = `the session ended (${m.exit.signal ? `signal ${m.exit.signal}` : `code ${m.exit.code}`})`;
    }
  });
  c.on("error", (e) => (ended ||= e.message));
  send({ op: "attach", cols: stdout.columns, rows: stdout.rows });
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", onInput);
  stdin.resume();
  stdout.on("resize", onResize);
  await new Promise((resolve) => c.once("close", resolve));
  stdout.off("resize", onResize);
  stdin.off("data", onInput);
  stdin.setRawMode(false);
  stdin.pause();
  stdout.write(`${LEAVE}\r\n[gasho] ${ended || `left ${name}`}\r\n`);
}

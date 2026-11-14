// The terminal of one session that gasho-daemon started (see terminal.ts): runs the program in a pseudo-terminal,
// keeps its screen in a headless xterm.js, and answers on a Unix socket, one line of JSON per request:
//   {"op":"hello"}                     → what HostHello says
//   {"op":"screen"}                    → {"ansi": the screen, as dumpScreen writes it}
//   {"op":"keys","keys":["Down",…]}    → the keys, one by one (see keyBytes)
//   {"op":"paste","text":"…"}          → the text, pasted (see pasteBytes)
//   {"op":"kill"}                      → the program gets SIGHUP (SIGKILL after 3 s), and the host ends
//   {"op":"attach","cols":…,"rows":…}  → the connection shows the terminal: {"out":…} lines from here, {"in":…} and
//                                        {"resize":[cols,rows]} lines from there (gasho-daemon attach)
// Every answer has "ok" (and "error" when it is false). The host ends a minute after the program exits, or when it is
// told to. Run by gasho-daemon only: `node terminal-host.js <config.json>`.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "@lydell/node-pty";
import serialize from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import { dumpScreen, HOST_PROTOCOL, KEY_GAP_MS, keyBytes, pasteBytes, type HostConfig, type HostHello } from "./terminal.ts";

/** How long the last screen of a program that exited stays readable (the daemon logs the end of a failed launch). */
const EXITED_KEEP_MS = 60_000;
/** How long the program has to end after SIGHUP before it is killed. */
const HANGUP_WAIT_MS = 3000;
/** Lines before the screen that `attach` shows too. */
const ATTACH_SCROLLBACK = 1000;

const configFile = process.argv[2] ?? "";
if (!configFile) {
  console.error("usage: terminal-host <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")) as HostConfig;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), `[terminal ${cfg.name}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const term = new xterm.Terminal({ cols: cfg.cols, rows: cfg.rows, scrollback: 5000, allowProposedApi: true });
const serializer = new serialize.SerializeAddon();
term.loadAddon(serializer);
const startedAt = Date.now();
let exited: HostHello["exited"];
let closing = false;

interface Viewer {
  size: [number, number];
  send(m: object): void;
  /** The last message, then the connection closes. */
  end(m: object): void;
}
const viewers = new Set<Viewer>();
const line = (m: object) => `${JSON.stringify(m)}\n`;

const pty = spawn(cfg.file, cfg.args, { name: "xterm-256color", cols: cfg.cols, rows: cfg.rows, cwd: cfg.cwd, env: cfg.env });
log(`started ${cfg.file} ${cfg.args.join(" ")} (pid ${pty.pid}) in ${cfg.cwd}`);
pty.onData((d) => {
  term.write(d);
  for (const v of viewers) v.send({ out: d });
});
// The terminal's answers to the program's questions (device attributes, cursor position, …).
term.onData((d) => {
  if (!exited) pty.write(d);
});
pty.onExit(({ exitCode, signal }) => {
  exited = { code: exitCode, ...(signal ? { signal } : {}) };
  log(`the program exited (${signal ? `signal ${signal}` : `code ${exitCode}`})`);
  // Its last output reaches the viewers first.
  void flushed().then(() => {
    for (const v of viewers) v.end({ exit: exited });
  });
  setTimeout(() => shutdown("the program exited a while ago"), EXITED_KEEP_MS);
});

/** Waits until the terminal has read everything the program wrote so far. */
const flushed = () => new Promise<void>((r) => term.write("", r));

const hello = (): HostHello => ({
  version: HOST_PROTOCOL,
  name: cfg.name,
  pid: pty.pid,
  hostPid: process.pid,
  cwd: cfg.cwd,
  startedAt,
  ...(exited ? { exited } : {}),
});

/** The size of the newest viewer, or the terminal's own when nobody is attached. */
function resizeToViewers(): void {
  const [cols, rows] = [...viewers].at(-1)?.size ?? [cfg.cols, cfg.rows];
  if (cols === term.cols && rows === term.rows) return;
  term.resize(cols, rows);
  if (!exited) pty.resize(cols, rows);
}

const size = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 10 && v <= 1000 ? v : fallback);

function attachViewer(c: net.Socket, m: Record<string, unknown>): Viewer {
  const v: Viewer = {
    size: [size(m.cols, cfg.cols), size(m.rows, cfg.rows)],
    send: (x) => c.write(line(x)),
    end: (x) => c.end(line(x)),
  };
  viewers.add(v);
  c.on("close", () => {
    viewers.delete(v);
    resizeToViewers();
  });
  resizeToViewers();
  v.send({ ok: true });
  // What is on the screen now, with the lines above it and the modes the program set; the program redraws its part on
  // the resize too.
  v.send({ out: `\x1b[H\x1b[2J${serializer.serialize({ scrollback: ATTACH_SCROLLBACK })}` });
  if (exited) v.end({ exit: exited });
  return v;
}

function viewerInput(v: Viewer, m: Record<string, unknown>): void {
  if (typeof m.in === "string" && !exited) pty.write(m.in);
  if (Array.isArray(m.resize)) {
    v.size = [size(m.resize[0], cfg.cols), size(m.resize[1], cfg.rows)];
    resizeToViewers();
  }
}

async function handle(c: net.Socket, m: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  switch (m.op) {
    case "hello":
      return { ok: true, ...hello() };
    case "screen":
      await flushed();
      return { ok: true, ansi: dumpScreen(term) };
    case "keys": {
      if (exited) throw new Error("the program has exited");
      const keys = Array.isArray(m.keys) ? m.keys.map(String) : [];
      // Every name is checked before the first key is pressed: no half of a request is typed.
      for (const k of keys) keyBytes(k, term.modes);
      for (const k of keys) {
        pty.write(keyBytes(k, term.modes));
        await sleep(KEY_GAP_MS);
      }
      return { ok: true };
    }
    case "paste":
      if (exited) throw new Error("the program has exited");
      pty.write(pasteBytes(String(m.text ?? ""), term.modes.bracketedPasteMode));
      return { ok: true };
    case "kill":
      c.end(line({ ok: true }));
      shutdown("asked to");
      return undefined;
    default:
      throw new Error(`unknown request: ${String(m.op)}`);
  }
}

function serve(c: net.Socket): void {
  c.setEncoding("utf8");
  c.on("error", () => undefined);
  let buf = "";
  let viewer: Viewer | undefined;
  // One request at a time per connection, in order.
  let queue = Promise.resolve();
  c.on("data", (chunk: string) => {
    buf += chunk;
    for (let end = buf.indexOf("\n"); end >= 0; end = buf.indexOf("\n")) {
      const text = buf.slice(0, end);
      buf = buf.slice(end + 1);
      if (!text.trim()) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(text) as Record<string, unknown>;
      } catch {
        c.write(line({ ok: false, error: "not JSON" }));
        continue;
      }
      if (viewer) {
        viewerInput(viewer, m);
        continue;
      }
      if (m.op === "attach") {
        viewer = attachViewer(c, m);
        continue;
      }
      queue = queue.then(async () => {
        try {
          const res = await handle(c, m);
          if (res && !c.destroyed) c.write(line(res));
        } catch (e) {
          if (!c.destroyed) c.write(line({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      });
    }
  });
}

/** Ends the program (SIGHUP, then SIGKILL) and the host, and removes the socket, the settings and the log. */
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  log(`closing: ${reason}`);
  for (const v of viewers) v.end({ exit: exited ?? { code: -1 } });
  server.close();
  // The log is kept only when the host dies without closing (its end tells why).
  for (const f of [cfg.socket, configFile, path.join(path.dirname(configFile), `${cfg.name}.log`)]) fs.rmSync(f, { force: true });
  // A moment for the last answers to leave.
  const exit = () => setTimeout(() => process.exit(0), 100);
  if (exited) {
    exit();
    return;
  }
  pty.onExit(exit);
  try {
    pty.kill("SIGHUP");
  } catch {
    // gone already
  }
  setTimeout(() => {
    try {
      process.kill(pty.pid, "SIGKILL");
    } catch {
      // gone already
    }
    process.exit(0);
  }, HANGUP_WAIT_MS);
}

// A socket left behind by a host that died: the name is new to this terminal, so nobody else answers on it.
fs.rmSync(cfg.socket, { force: true });
const server = net.createServer(serve);
server.on("error", (e) => {
  log("cannot listen:", e);
  shutdown("cannot listen");
});
server.listen(cfg.socket, () => {
  fs.chmodSync(cfg.socket, 0o600);
  log(`listening on ${cfg.socket}`);
});

// The host has no terminal of its own (gasho-daemon starts it in a session of its own); SIGTERM ends the session too.
process.on("SIGHUP", () => undefined);
process.on("SIGTERM", () => shutdown("SIGTERM"));

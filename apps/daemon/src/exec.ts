// Running a command for a plugin's daemon part: its ctx.exec (plugin-host.ts), and gh for ctx.github, which
// gasho-daemon runs itself (github.ts). No shell and no terminal; gh and git fail rather than wait for input.
import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
/** After SIGTERM, a command gets this long before SIGKILL. */
const EXEC_KILL_MS = 5000;

/** Runs a command without a shell or a terminal, in a process group of its own (stopped as a whole). */
export function exec(command: string, args: string[], opts: ExecOptions = {}, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (typeof command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      reject(new Error("exec: give the command and its arguments as strings"));
      return;
    }
    const max = opts.maxBuffer ?? EXEC_MAX_BUFFER;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let killed = false;
    let tooMuch = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (killed || child.pid === undefined || child.exitCode !== null) return;
      killed = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // gone
        }
      }, EXEC_KILL_MS);
      killTimer.unref();
    };
    const timer = setTimeout(stop, opts.timeoutMs ?? EXEC_TIMEOUT_MS);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (into: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > max) {
        tooMuch = true;
        stop();
        return;
      }
      into.push(b);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error(`${command}: ${e.message}`), { code: e.code, killed: false, stdout: "", stderr: "" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && !killed) {
        resolve({ stdout, stderr });
        return;
      }
      const why = tooMuch ? "output too large" : killed ? "stopped (took too long or was aborted)" : `exit code ${code}`;
      reject(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")} (${why})\n${stderr}`), { code: code ?? undefined, killed, stdout, stderr }));
    });
  });
}

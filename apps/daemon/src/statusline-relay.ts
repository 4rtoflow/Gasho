// The status line command of the sessions Gasho starts (see statusline.ts). Claude Code runs it at every update of
// the status line, with what it reports as JSON on stdin. It sends the session's id, its context window and the plan's
// usage limits to gasho-daemon, and runs the status line command the user set up (if any) with the same JSON, printing
// what that prints. It uses only Node.js's own modules, so that it starts fast, and never fails the status line:
// gasho-daemon being away only means that nothing is sent.
import { spawn } from "node:child_process";

/** How long the update may take to reach gasho-daemon. */
const SEND_MS = 2000;
/** The variables meant for this relay alone, not for the user's command. */
const OWN = ["GASHO_STATUSLINE_URL", "GASHO_STATUSLINE_SECRET", "GASHO_STATUSLINE_COMMAND"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function send(input: string): Promise<void> {
  const url = process.env.GASHO_STATUSLINE_URL;
  if (!url) return;
  let body: string;
  try {
    const p = JSON.parse(input) as Record<string, unknown>;
    body = JSON.stringify({ session_id: p.session_id, context_window: p.context_window, rate_limits: p.rate_limits });
  } catch {
    return;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = process.env.GASHO_STATUSLINE_SECRET;
  if (secret) headers["x-gasho-secret"] = secret;
  try {
    await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(SEND_MS) });
  } catch {
    // gasho-daemon is not running, or is restarting.
  }
}

/** Runs the user's status line command as Claude Code would (bash, else sh), passing its output and exit code on. */
function runUserCommand(command: string, input: string, shell = "bash"): Promise<void> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of OWN) delete env[k];
    let failed = false;
    const child = spawn(shell, ["-c", command], { stdio: ["pipe", "inherit", "inherit"], env });
    child.on("error", (e: NodeJS.ErrnoException) => {
      failed = true;
      if (e.code === "ENOENT" && shell === "bash") void runUserCommand(command, input, "/bin/sh").then(resolve);
      else resolve();
    });
    child.on("close", (code) => {
      if (failed) return;
      process.exitCode = code ?? 1;
      resolve();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const input = await readStdin();
const user = process.env.GASHO_STATUSLINE_COMMAND;
await Promise.all([send(input), user ? runUserCommand(user, input) : undefined]);

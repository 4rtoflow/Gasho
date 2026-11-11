// Receives Claude Code hooks (type: "http") on 127.0.0.1 and produces the settings snippet that registers them.
import fs from "node:fs/promises";
import http from "node:http";
import type { HookEvent } from "@gasho/protocol";
import { clip, inputSummary, log, str } from "./util.ts";

/**
 * Events Gasho registers. SessionStart is left out because the docs say it does not support http hooks;
 * new sessions are found through `claude agents --json`. PermissionRequest comes with the approval feature.
 */
export const HOOK_EVENTS = [
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
] as const;

export const SECRET_HEADER = "x-gasho-secret";
export const SECRET_ENV = "GASHO_HOOK_SECRET";

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

/**
 * The `hooks` object to merge into ~/.claude/settings.json.
 * The secret is written as a literal header value. Interpolating it from an environment variable would only
 * work once every Claude Code process (including running `claude rc` servers) was restarted with that variable.
 */
export function hooksConfig(port: number, secret?: string): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: "http", url: hookUrl(port), timeout: 5 };
  if (secret) handler.headers = { [SECRET_HEADER]: secret };
  return Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [handler] }]]));
}

/** Reduces a hook payload to what the dashboard needs. Tool inputs and outputs are not forwarded in full. */
export function summarizeHook(p: Record<string, unknown>, now = Date.now()): HookEvent | null {
  const event = str(p.hook_event_name);
  const sessionId = str(p.session_id);
  if (!event || !sessionId) return null;
  const ev: HookEvent = { sessionId, event, at: now };
  const cwd = str(p.cwd);
  if (cwd) ev.cwd = cwd;
  const toolName = str(p.tool_name);
  if (toolName) ev.toolName = toolName;
  switch (event) {
    case "UserPromptSubmit":
      ev.summary = clip(str(p.prompt) ?? "", 300);
      break;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionRequest":
      ev.summary = inputSummary(p.tool_input, 200);
      break;
    case "Notification":
      ev.notificationType = str(p.notification_type);
      ev.summary = clip(str(p.message) ?? "", 300);
      break;
    case "Stop":
    case "SubagentStop":
      ev.summary = clip(str(p.last_assistant_message) ?? "", 300);
      break;
    case "StopFailure":
      ev.summary = clip(str(p.error) ?? str(p.message) ?? "", 300);
      break;
    case "SessionEnd":
      ev.summary = str(p.reason);
      break;
  }
  return ev;
}

export interface HookServerOptions {
  host: string;
  port: number;
  secret: string | undefined;
  onEvent: (payload: Record<string, unknown>) => void;
}

/** Answers every request at once with an empty 200, so a hook never delays Claude Code. */
export function startHookServer(opts: HookServerOptions): http.Server {
  let lastRejectLog = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hooks") {
      res.writeHead(404).end();
      return;
    }
    if (opts.secret && req.headers[SECRET_HEADER] !== opts.secret) {
      if (Date.now() - lastRejectLog > 60_000) {
        lastRejectLog = Date.now();
        log(`rejected a hook without a valid ${SECRET_HEADER} header (run "hooks install" again with the same ${SECRET_ENV})`);
      }
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      res.writeHead(200, { "content-length": "0" }).end();
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (payload && typeof payload === "object") opts.onEvent(payload as Record<string, unknown>);
      } catch (e) {
        log("ignored a hook body that is not JSON", e);
      }
    });
  });
  server.listen(opts.port, opts.host, () => log(`hooks: listening on ${hookUrl(opts.port)}`));
  return server;
}

/**
 * Merges Gasho's hooks into a Claude Code settings file, replacing earlier Gasho entries (same URL).
 * Writes a backup next to the file first.
 */
export async function installHooks(settingsFile: string, port: number, secret?: string): Promise<string> {
  let settings: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await fs.readFile(settingsFile, "utf8");
    settings = JSON.parse(original) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const url = hookUrl(port);
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown>;
  const ours = hooksConfig(port, secret);
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as Array<Record<string, unknown>>) : [];
    const kept = groups.filter(
      (g) => !(Array.isArray(g.hooks) && (g.hooks as Array<Record<string, unknown>>).some((h) => h.url === url)),
    );
    hooks[event] = [...kept, ...(ours[event] as unknown[])];
  }
  settings.hooks = hooks;
  let backup = "";
  if (original !== undefined) {
    backup = `${settingsFile}.gasho-backup-${Date.now()}`;
    await fs.writeFile(backup, original);
  }
  await fs.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return backup;
}

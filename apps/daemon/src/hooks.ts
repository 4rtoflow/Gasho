// Receives Claude Code hooks (type: "http") on 127.0.0.1 and produces the settings snippet that registers them.
import fs from "node:fs/promises";
import http from "node:http";
import type { HookEvent } from "@gasho/protocol";
import type { HookReply } from "./permissions.ts";
import { clip, inputSummary, log, str } from "./util.ts";

/**
 * Events Gasho registers. SessionStart is left out because the docs say it does not support http hooks;
 * new sessions are found through `claude agents --json`. PermissionRequest is held until it is answered (see
 * permissions.ts), with a timeout of its own.
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
  "PermissionRequest",
] as const;

/**
 * How long Claude Code waits for an answer from Gasho to a permission request (seconds). Its dialog is shown meanwhile
 * and can be answered there; past this, the hook gives no decision and only the dialog is left.
 */
export const PERMISSION_TIMEOUT_S = 3600;

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
  return Object.fromEntries(
    HOOK_EVENTS.map((e) => [e, [{ hooks: [e === "PermissionRequest" ? { ...handler, timeout: PERMISSION_TIMEOUT_S } : handler] }]]),
  );
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
  /**
   * A PermissionRequest: its response waits for `reply` (a decision, or none). Returns what to do when the connection
   * closes before that (Claude Code gave up). Without it, PermissionRequest is answered at once like other hooks.
   */
  onPermissionRequest?: (payload: Record<string, unknown>, reply: HookReply) => (() => void) | undefined;
  /** What the status line relay of a session Gasho started sent (POST /statusline; see statusline.ts). */
  onStatusLine?: (payload: Record<string, unknown>) => void;
}

/**
 * Answers every request at once with an empty 200, so a hook never delays Claude Code; a PermissionRequest is passed
 * to `onPermissionRequest` (and to `onEvent`) and answered when it says. The status line relay posts to /statusline,
 * with the same secret.
 */
export function startHookServer(opts: HookServerOptions): http.Server {
  let lastRejectLog = 0;
  const server = http.createServer((req, res) => {
    const statusLine = req.url === "/statusline";
    if (req.method !== "POST" || (req.url !== "/hooks" && !statusLine)) {
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
      let payload: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch (e) {
        log("ignored a hook body that is not JSON", e);
      }
      const reply: HookReply = (body) => {
        if (res.writableEnded || res.destroyed) return;
        const text = body ? JSON.stringify(body) : "";
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
      };
      if (statusLine) {
        reply(undefined);
        if (payload) opts.onStatusLine?.(payload);
        return;
      }
      if (payload && payload.hook_event_name === "PermissionRequest" && opts.onPermissionRequest) {
        const dropped = opts.onPermissionRequest(payload, reply);
        res.on("close", () => {
          if (!res.writableEnded) dropped?.();
        });
      } else {
        reply(undefined);
      }
      if (payload) opts.onEvent(payload);
    });
  });
  server.listen(opts.port, opts.host, () => log(`hooks: listening on ${hookUrl(opts.port)}`));
  return server;
}

/** The events a Claude Code settings file (its text) sends to Gasho's hook URL. */
export function installedHookEvents(settingsText: string, port: number): string[] {
  try {
    const hooks = (JSON.parse(settingsText) as { hooks?: Record<string, unknown> }).hooks ?? {};
    const url = hookUrl(port);
    return Object.entries(hooks)
      .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: { url?: unknown }) => h?.url === url)))
      .map(([event]) => event);
  } catch {
    return [];
  }
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

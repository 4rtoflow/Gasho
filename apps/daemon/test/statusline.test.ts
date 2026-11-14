import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startHookServer } from "../src/hooks.ts";
import { isInside, RELAY_FILE, shellQuote, statusLineLaunch, statusLineOf, userStatusLine } from "../src/statusline.ts";

/** What Claude Code 2.1.325 passed to the status line after a first reply (a Claude.ai plan without a 5-hour limit). */
const AFTER_REPLY = {
  session_id: "00ac671e-4a2a-4519-a349-923e94127b77",
  cwd: "/home/u/repo",
  model: { id: "claude-haiku-5-5", display_name: "Haiku 5.5" },
  context_window: {
    total_input_tokens: 45615,
    total_output_tokens: 50,
    context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 17761, cache_read_input_tokens: 27852 },
    used_percentage: 5,
    remaining_percentage: 95,
  },
  rate_limits: { seven_day: { used_percentage: 35, resets_at: 1794988800 } },
  cost: { total_cost_usd: 0.004 },
};

test("statusLineOf reads the context window once the session has replied, and the plan's limits", () => {
  assert.deepEqual(statusLineOf(AFTER_REPLY, 1000), {
    sessionId: "00ac671e-4a2a-4519-a349-923e94127b77",
    context: { used: 45615, size: 1000000, percent: 5, at: 1000 },
    limits: { sevenDay: { percent: 35, resetsAt: 1794988800000 }, at: 1000 },
  });
  // Before the first reply Claude Code knows only the window's size, and no limits.
  const start = { session_id: "s1", context_window: { total_input_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null } };
  assert.deepEqual(statusLineOf(start, 1), { sessionId: "s1" });
  const both = statusLineOf({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 12, resets_at: 1794990000 }, seven_day: { used_percentage: 40, resets_at: 1794988800 } } }, 1);
  assert.deepEqual(both?.limits, { fiveHour: { percent: 12, resetsAt: 1794990000000 }, sevenDay: { percent: 40, resetsAt: 1794988800000 }, at: 1 });
});

test("statusLineOf leaves out what does not look right", () => {
  assert.equal(statusLineOf(null), undefined);
  assert.equal(statusLineOf({ context_window: AFTER_REPLY.context_window }), undefined);
  assert.equal(statusLineOf({ session_id: "x".repeat(201) }), undefined);
  const odd = statusLineOf({
    session_id: "s1",
    context_window: { ...AFTER_REPLY.context_window, used_percentage: 140 },
    rate_limits: { seven_day: { used_percentage: "35", resets_at: 1794988800 }, five_hour: { used_percentage: 3 } },
  });
  assert.deepEqual(odd, { sessionId: "s1" });
});

test("userStatusLine takes the folder's local settings, then its shared ones, then the user's", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-statusline-"));
  try {
    const cwd = path.join(root, "repo");
    const claudeDir = path.join(root, "claude");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });
    assert.equal(await userStatusLine(cwd, claudeDir), undefined);
    await fs.writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "~/bin/line", padding: 1, refreshInterval: 5 } }));
    assert.deepEqual(await userStatusLine(cwd, claudeDir), { type: "command", command: "~/bin/line", padding: 1, refreshInterval: 5 });
    await fs.writeFile(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "project-line" } }));
    assert.deepEqual(await userStatusLine(cwd, claudeDir), { type: "command", command: "project-line" });
    // A local file that is not JSON is passed over, as one without a status line.
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), "{ not json");
    assert.deepEqual(await userStatusLine(cwd, claudeDir), { type: "command", command: "project-line" });
    await fs.writeFile(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "local-line", hideVimModeIndicator: true } }));
    assert.deepEqual(await userStatusLine(cwd, claudeDir), { type: "command", command: "local-line", hideVimModeIndicator: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("statusLineLaunch makes the relay the status line, keeping the user's padding, interval and command", () => {
  const user = { type: "command" as const, command: "~/bin/line --short", padding: 2, refreshInterval: 10 };
  const { args, env } = statusLineLaunch({ port: 7741, secret: "s3cret", user, node: "/opt/node 24/bin/node", relay: "/lib/statusline-relay.js" });
  assert.equal(args[0], "--settings");
  assert.deepEqual(JSON.parse(args[1] ?? ""), {
    statusLine: { type: "command", command: "'/opt/node 24/bin/node' '/lib/statusline-relay.js'", padding: 2, refreshInterval: 10 },
  });
  assert.deepEqual(env, {
    GASHO_STATUSLINE_URL: "http://127.0.0.1:7741/statusline",
    GASHO_STATUSLINE_SECRET: "s3cret",
    GASHO_STATUSLINE_COMMAND: "~/bin/line --short",
  });
  // Without a status line of the user's, and without a secret.
  const bare = statusLineLaunch({ port: 7741, secret: undefined, user: undefined, node: "node", relay: "/r.js" });
  assert.deepEqual(JSON.parse(bare.args[1] ?? ""), { statusLine: { type: "command", command: "'node' '/r.js'" } });
  assert.deepEqual(bare.env, { GASHO_STATUSLINE_URL: "http://127.0.0.1:7741/statusline" });
});

test("shellQuote keeps quotes and dollar signs as they are", async () => {
  const word = `it's $HOME`;
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
    execFile("bash", ["-c", `printf %s ${shellQuote(word)}`], (e, stdout) => (e ? reject(e) : resolve({ stdout }))),
  );
  assert.equal(stdout, word);
});

test("isInside tells a plugin's own folder from the rest", () => {
  const root = "/home/u/.local/share/gasho/plugin-data";
  assert.ok(isInside(root, root));
  assert.ok(isInside(`${root}/usage`, root));
  assert.ok(isInside(`${root}/usage/`, `${root}/`));
  assert.ok(!isInside("/home/u/.local/share/gasho", root));
  assert.ok(!isInside("/home/u/.local/share/gasho/plugin-data-old", root));
  assert.ok(!isInside("/home/u/repo", root));
  assert.ok(isInside(`${root}/..data`, root));
});

/** Runs the relay as Claude Code would: the JSON on stdin, the environment statusLineLaunch gives. */
function runRelay(env: Record<string, string>, input: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [RELAY_FILE], { env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...env }, timeout: 15_000 }, (e, stdout) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout }),
    );
    child.stdin?.end(input);
  });
}

test("the relay sends the context window and the limits, and prints the user's status line", async () => {
  const got: { headers: http.IncomingHttpHeaders; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const { env } = statusLineLaunch({
      port,
      secret: "s3cret",
      // Reads the JSON as a status line command does; must not see the relay's own variables.
      user: { type: "command", command: `printf '%s|%s' "$(cat | head -c 13)" "\${GASHO_STATUSLINE_SECRET:-none}"; exit 3` },
    });
    const r = await runRelay(env, JSON.stringify(AFTER_REPLY));
    assert.equal(r.stdout, `{"session_id"|none`);
    assert.equal(r.code, 3);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.headers["x-gasho-secret"], "s3cret");
    assert.deepEqual(got[0]?.body, { session_id: AFTER_REPLY.session_id, context_window: AFTER_REPLY.context_window, rate_limits: AFTER_REPLY.rate_limits });

    // No status line of the user's: nothing is printed, and the update is still sent.
    const bare = await runRelay(statusLineLaunch({ port, secret: undefined, user: undefined }).env, JSON.stringify(AFTER_REPLY));
    assert.deepEqual(bare, { code: 0, stdout: "" });
    assert.equal(got.length, 2);
  } finally {
    server.close();
  }
});

test("the relay prints the user's status line when gasho-daemon is away, and takes input that is not JSON", async () => {
  // A port nothing listens on.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const { env } = statusLineLaunch({ port, secret: undefined, user: { type: "command", command: "printf away" } });
  assert.deepEqual(await runRelay(env, JSON.stringify(AFTER_REPLY)), { code: 0, stdout: "away" });
  assert.deepEqual(await runRelay(env, "not json"), { code: 0, stdout: "away" });
});

test("the hook server passes what the relay sends to onStatusLine, with the same secret", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const server = startHookServer({ host: "127.0.0.1", port: 0, secret: "s3cret", onEvent: (p) => events.push(p), onStatusLine: (p) => lines.push(p) });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/statusline`;
    const body = JSON.stringify({ session_id: "s1", context_window: AFTER_REPLY.context_window });
    assert.equal((await fetch(url, { method: "POST", body, headers: { "x-gasho-secret": "nope" } })).status, 401);
    const ok = await fetch(url, { method: "POST", body, headers: { "x-gasho-secret": "s3cret" } });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.session_id, "s1");
    // A status line update is not a hook.
    assert.equal(events.length, 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST", body })).status, 404);
  } finally {
    server.close();
  }
});

/** A daemon whose `claude agents` (a script) lists `rows`, with the plugins' folders in `pluginDataDir`. */
async function daemonWith(rows: (pluginDataDir: string) => unknown[]) {
  const { Daemon } = await import("../src/daemon.ts");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-statusline-daemon-"));
  const pluginDataDir = path.join(dir, "plugin-data");
  const agents = path.join(dir, "agents.json");
  await fs.writeFile(agents, JSON.stringify(rows(pluginDataDir)));
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, `#!/bin/sh\ncat '${agents}'\n`, { mode: 0o755 });
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir: path.join(dir, "claude-dir"),
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    pluginCacheDir: path.join(dir, "plugin-cache"),
    pluginDataDir,
    runPlugins: false,
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  return { d, pluginDataDir, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("a Claude Code that a plugin runs in its own folder is no session, and its hooks are passed over", async () => {
  const { d, pluginDataDir, done } = await daemonWith((data) => [
    { pid: 1, sessionId: "s1", cwd: "/home/u/repo", status: "idle" },
    { pid: 2, sessionId: "s2", cwd: path.join(data, "usage"), status: "idle" },
  ]);
  try {
    for (const k of ["update", "forgetEndedSessions", "readManagedScreens", "countTokens", "emitSessions"]) d[k] = async () => undefined;
    await d.refresh();
    assert.deepEqual([...d.tracked.keys()], ["s1"]);
    assert.equal(d.fromPlugin({ hook_event_name: "SessionEnd", session_id: "s2", cwd: path.join(pluginDataDir, "usage") }), true);
    assert.equal(d.fromPlugin({ hook_event_name: "Stop", session_id: "s1", cwd: "/home/u/repo" }), false);
    assert.equal(d.fromPlugin({ hook_event_name: "Stop", session_id: "s1" }), false);
  } finally {
    await done();
  }
});

test("a status line report that changes nothing keeps the time of the reply it came from", async () => {
  const { d, done } = await daemonWith(() => []);
  try {
    let emits = 0;
    d.scheduleEmit = () => emits++;
    d.tracked.set(AFTER_REPLY.session_id, { meta: {}, info: { sessionId: AFTER_REPLY.session_id, cwd: "/home/u/repo", status: "idle", rcMode: "interactive", prLinks: [] } });
    const info = d.tracked.get(AFTER_REPLY.session_id).info;
    d.applyStatusLine(AFTER_REPLY);
    assert.equal(info.context?.used, 45615);
    assert.equal(info.limits?.sevenDay?.percent, 35);
    assert.equal(emits, 2);
    const at = info.context.at;
    await new Promise((r) => setTimeout(r, 5));
    d.applyStatusLine(AFTER_REPLY);
    assert.equal(info.context.at, at);
    assert.equal(emits, 2);
    // The next reply changes both.
    d.applyStatusLine({
      ...AFTER_REPLY,
      context_window: { ...AFTER_REPLY.context_window, total_input_tokens: 60000, used_percentage: 6 },
      rate_limits: { seven_day: { used_percentage: 36, resets_at: 1794988800 } },
    });
    assert.equal(info.context.used, 60000);
    assert.equal(info.limits.sevenDay.percent, 36);
    assert.equal(emits, 4);
    // A report of a session gasho-daemon does not follow changes nothing.
    d.applyStatusLine({ ...AFTER_REPLY, session_id: "other" });
    assert.equal(emits, 4);
  } finally {
    await done();
  }
});

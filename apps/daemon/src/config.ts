import os from "node:os";
import path from "node:path";

export interface DaemonConfig {
  hubUrl: string;
  machine: string;
  token: string;
  hookPort: number;
  hookSecret: string | undefined;
  claudeDir: string;
  claudeBin: string;
  pollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const token = env.GASHO_TOKEN;
  if (!token) throw new Error("GASHO_TOKEN is not set (the token shared with gasho-hub)");
  return {
    hubUrl: env.GASHO_HUB_URL ?? "ws://127.0.0.1:7740/ws/daemon",
    machine: env.GASHO_MACHINE ?? os.hostname(),
    token,
    hookPort: Number(env.GASHO_HOOK_PORT ?? 7741),
    hookSecret: env.GASHO_HOOK_SECRET || undefined,
    claudeDir: env.GASHO_CLAUDE_DIR ?? path.join(os.homedir(), ".claude"),
    claudeBin: env.GASHO_CLAUDE_BIN ?? "claude",
    pollIntervalMs: Number(env.GASHO_POLL_MS ?? 3000),
  };
}

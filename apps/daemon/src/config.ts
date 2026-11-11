import os from "node:os";
import path from "node:path";
import { daemonUrl, type Credentials } from "./credentials.ts";

export interface DaemonConfig {
  hubUrl: string;
  machineId: string;
  token: string;
  hookPort: number;
  hookSecret: string | undefined;
  claudeDir: string;
  claudeBin: string;
  pollIntervalMs: number;
}

export function loadConfig(creds: Credentials, env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    hubUrl: env.GASHO_HUB_URL ?? daemonUrl(creds.server),
    machineId: creds.machineId,
    token: creds.token,
    hookPort: Number(env.GASHO_HOOK_PORT ?? 7741),
    hookSecret: env.GASHO_HOOK_SECRET || undefined,
    claudeDir: env.GASHO_CLAUDE_DIR ?? path.join(os.homedir(), ".claude"),
    claudeBin: env.GASHO_CLAUDE_BIN ?? "claude",
    pollIntervalMs: Number(env.GASHO_POLL_MS ?? 3000),
  };
}

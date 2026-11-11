import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface HubConfig {
  host: string;
  port: number;
  token: string;
  dbFile: string;
  webDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const token = env.GASHO_TOKEN;
  if (!token) throw new Error("GASHO_TOKEN is not set (the token gasho-daemon uses to connect)");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    // Only reachable from this machine by default; publish it with Tailscale Serve, never directly.
    host: env.GASHO_HUB_HOST ?? "127.0.0.1",
    port: Number(env.GASHO_HUB_PORT ?? 7740),
    token,
    dbFile: env.GASHO_DB ?? path.join(os.homedir(), ".local", "share", "gasho", "hub.db"),
    webDist: env.GASHO_WEB_DIST ?? path.resolve(here, "../../web/dist"),
  };
}

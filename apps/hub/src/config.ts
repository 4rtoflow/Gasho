import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNets } from "./netallow.ts";

export interface HubConfig {
  host: string;
  port: number;
  allowNets: string[];
  dbFile: string;
  webDist: string;
}

export function dbFileOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.GASHO_DB ?? path.join(os.homedir(), ".local", "share", "gasho", "hub.db");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    // Listens on the LAN by default; GASHO_ALLOW_NETS decides which source addresses are served.
    host: env.GASHO_HUB_HOST ?? "0.0.0.0",
    port: Number(env.GASHO_HUB_PORT ?? 7740),
    allowNets: parseNets(env.GASHO_ALLOW_NETS),
    dbFile: dbFileOf(env),
    webDist: env.GASHO_WEB_DIST ?? path.resolve(here, "../../web/dist"),
  };
}

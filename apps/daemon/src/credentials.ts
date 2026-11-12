// The working server's registration with the Gasho server, stored in ~/.config/gasho/daemon.json (mode 0600).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PairRequest, PairResponse } from "@gasho/protocol";

export interface Credentials {
  /** Base URL of the Gasho server, e.g. http://192.168.1.10:7740 */
  server: string;
  machineId: string;
  token: string;
  name: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GASHO_DAEMON_CONFIG ?? path.join(os.homedir(), ".config", "gasho", "daemon.json");
}

export async function loadCredentials(file: string): Promise<Credentials> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`${file} not found. Register this machine first: node src/cli.ts register --server <url> --code <code>`);
  }
  const c = JSON.parse(raw) as Partial<Credentials>;
  if (!c.server || !c.machineId || !c.token) throw new Error(`${file} is incomplete; register this machine again`);
  return { server: c.server, machineId: c.machineId, token: c.token, name: c.name ?? "" };
}

export async function saveCredentials(file: string, c: Credentials): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** http(s)://host:port -> ws(s)://host:port/ws/daemon */
export function daemonUrl(server: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/daemon";
  u.search = "";
  return u.toString();
}

/** Exchanges a registration code for this machine's id and token. */
export async function register(server: string, code: string, name: string): Promise<Credentials> {
  const base = new URL(server);
  const body: PairRequest = { code, kind: "machine", name };
  const res = await fetch(new URL("/api/pair", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<PairResponse> & { error?: string };
  if (!res.ok || !data.deviceId || !data.token) {
    throw new Error(`registration failed (${res.status}): ${data.error ?? res.statusText}`);
  }
  return { server: base.origin, machineId: data.deviceId, token: data.token, name: data.name ?? name };
}

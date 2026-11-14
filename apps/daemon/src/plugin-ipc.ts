// What gasho-daemon (plugins.ts) and the process of a plugin's daemon part (plugin-host.ts) say to each other over
// Node.js's IPC channel (docs/plugins.md). Types only.
import type { GitHubRepo } from "@gasho/protocol";

/** The session a call is about, as gasho-daemon tracks it. */
export interface SessionWire {
  sessionId: string;
  cwd: string;
  name?: string;
  managed: boolean;
  github?: GitHubRepo;
  gitBranch?: string;
  /** Repositories gasho-daemon found inside the folder (when it is not itself in one). */
  repos: { path: string; github?: GitHubRepo; branch?: string }[];
}

export interface MachineWire {
  id: string;
  name: string;
}

/** What a daemon part may read of its working server (plugin API 1.1). */
export interface LocalWire {
  /** The folders Gasho offers to start sessions in (MachineInfo.folders). */
  folders: string[];
  /** A folder of the plugin's own on this working server, kept across versions (made before the process starts). */
  dataDir: string;
}

/** gasho-daemon -> the plugin's process. */
export type ToHost =
  | { t: "init"; plugin: string; machine: MachineWire; settings: Record<string, unknown>; local: LocalWire }
  | { t: "call"; id: number; method: string; params: unknown; session?: SessionWire; settings: Record<string, unknown> }
  | { t: "abort"; id: number }
  | { t: "settings"; settings: Record<string, unknown> }
  | { t: "folders"; folders: string[] }
  | { t: "stop" };

/** The plugin's process -> gasho-daemon. `user`: the message is for the person (a PluginError). */
export type FromHost =
  | { t: "ready" }
  | { t: "failed"; error: string }
  | { t: "result"; id: number; ok: true; data?: unknown }
  | { t: "result"; id: number; ok: false; error: string; user: boolean };

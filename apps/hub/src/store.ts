// Persists what the Gasho server must remember across restarts: registered devices, pairing codes,
// the last known sessions of each machine, recent hook events and notifications. Uses node:sqlite.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeviceInfo,
  DeviceKind,
  GashoNotification,
  MachineHookEvent,
  MachineInfo,
  PairingCode,
  PluginMachines,
  SessionInfo,
} from "@gasho/protocol";
import { hashSecret, newPairingCode, newToken, normalizeCode, PAIRING_CODE_TTL_MS, sameHash } from "./auth.ts";

const SCHEMA_VERSION = 3;
const EVENT_TTL_MS = 7 * 24 * 3600_000;
const NOTIFICATION_TTL_MS = 30 * 24 * 3600_000;

type Row = Record<string, unknown>;

export interface DeviceRecord extends DeviceInfo {
  revokedAt?: number;
}

function toDevice(r: Row): DeviceRecord {
  return {
    id: String(r.id),
    kind: String(r.kind) as DeviceKind,
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at == null ? undefined : Number(r.last_seen_at),
    revokedAt: r.revoked_at == null ? undefined : Number(r.revoked_at),
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version >= SCHEMA_VERSION) return;
    if (version < 2) this.migrateTo2();
    // Version 3 adds the plugins: whether each is enabled, where its daemon part runs, and its settings.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        machines TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_settings (
        plugin TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );
      PRAGMA user_version = 3;
    `);
  }

  private migrateTo2(): void {
    // Version 1 keyed machines (and the events and notifications that point at them) by host name.
    // Nothing from it can be mapped to registered machines, so it is dropped.
    this.db.exec(`
      DROP TABLE IF EXISTS machines;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS notifications;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_by TEXT
      );
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        daemon_version TEXT,
        sessions TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX events_at ON events(at);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX notifications_at ON notifications(at);
      PRAGMA user_version = 2;
    `);
  }

  // ---- devices ----

  createDevice(kind: DeviceKind, name: string, now = Date.now()): { device: DeviceRecord; token: string } {
    const id = randomUUID();
    const token = newToken();
    this.db
      .prepare("INSERT INTO devices (id, kind, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, kind, name, hashSecret(token), now);
    return { device: { id, kind, name, createdAt: now }, token };
  }

  /** The device if the token matches and it was not revoked. */
  verifyDevice(id: string, token: string, kind?: DeviceKind): DeviceRecord | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    if (!r || r.revoked_at != null) return undefined;
    if (kind && r.kind !== kind) return undefined;
    if (!sameHash(String(r.token_hash), hashSecret(token))) return undefined;
    return toDevice(r);
  }

  getDevice(id: string): DeviceRecord | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  touchDevice(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  listDevices(): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all() as Row[]).map(
      toDevice,
    );
  }

  revokedSince(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const stmt = this.db.prepare("SELECT revoked_at FROM devices WHERE id = ?");
    return ids.filter((id) => {
      const r = stmt.get(id) as Row | undefined;
      return !r || r.revoked_at != null;
    });
  }

  revokeDevice(id: string, now = Date.now()): boolean {
    const res = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    if (Number(res.changes) === 0) return false;
    this.db.prepare("DELETE FROM machines WHERE id = ?").run(id);
    return true;
  }

  renameDevice(id: string, name: string): boolean {
    const res = this.db.prepare("UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL").run(name, id);
    return Number(res.changes) > 0;
  }

  // ---- pairing codes ----

  createPairingCode(createdBy: string, now = Date.now(), ttlMs = PAIRING_CODE_TTL_MS): PairingCode {
    const code = newPairingCode();
    const expiresAt = now + ttlMs;
    this.db
      .prepare("INSERT INTO pairing_codes (code_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?)")
      .run(hashSecret(code), now, expiresAt, createdBy);
    return { code, expiresAt };
  }

  /** Marks the code used; true only for the first use of an unexpired code. */
  consumePairingCode(input: string, now = Date.now()): boolean {
    const res = this.db
      .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hashSecret(normalizeCode(input)), now);
    return Number(res.changes) === 1;
  }

  // ---- machines ----

  saveMachine(m: MachineInfo): void {
    this.db
      .prepare(
        `INSERT INTO machines (id, last_seen, daemon_version, sessions) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
           daemon_version = excluded.daemon_version, sessions = excluded.sessions`,
      )
      .run(m.id, m.lastSeen, m.daemonVersion ?? null, JSON.stringify(m.sessions));
  }

  /** Registered machines as last seen; all of them start disconnected. */
  loadMachines(): MachineInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, m.last_seen, m.daemon_version, m.sessions
         FROM devices d LEFT JOIN machines m ON m.id = d.id
         WHERE d.kind = 'machine' AND d.revoked_at IS NULL ORDER BY d.name`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      connected: false,
      lastSeen: r.last_seen == null ? 0 : Number(r.last_seen),
      daemonVersion: r.daemon_version == null ? undefined : String(r.daemon_version),
      sessions: r.sessions == null ? [] : (JSON.parse(String(r.sessions)) as SessionInfo[]),
    }));
  }

  // ---- plugins ----

  /** Whether a plugin is enabled and where its daemon part runs; undefined for one never changed (enabled, everywhere). */
  pluginState(id: string): { enabled: boolean; machines: PluginMachines } | undefined {
    const r = this.db.prepare("SELECT enabled, machines FROM plugins WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    let machines: PluginMachines = "all";
    try {
      const m = JSON.parse(String(r.machines)) as unknown;
      if (Array.isArray(m) && m.every((x) => typeof x === "string")) machines = m;
    } catch {
      // "all"
    }
    return { enabled: Number(r.enabled) === 1, machines };
  }

  setPluginState(id: string, state: { enabled: boolean; machines: PluginMachines }): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled, machines) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, machines = excluded.machines`,
      )
      .run(id, state.enabled ? 1 : 0, JSON.stringify(state.machines));
  }

  /** The settings of a plugin that the Gasho server keeps (scope "server"), as saved. */
  pluginSettings(id: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key, value FROM plugin_settings WHERE plugin = ?").all(id) as Row[]) {
      try {
        out[String(r.key)] = JSON.parse(String(r.value)) as unknown;
      } catch {
        // left out: the default applies
      }
    }
    return out;
  }

  setPluginSetting(id: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO plugin_settings (plugin, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value`,
      )
      .run(id, key, JSON.stringify(value));
  }

  /** Forgets a removed plugin: its state and its settings. */
  forgetPlugin(id: string): void {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM plugin_settings WHERE plugin = ?").run(id);
  }

  // ---- events and notifications ----

  addEvent(e: MachineHookEvent): void {
    this.db.prepare("INSERT INTO events (at, data) VALUES (?, ?)").run(e.at, JSON.stringify(e));
  }

  recentEvents(limit = 200): MachineHookEvent[] {
    const rows = this.db.prepare("SELECT data FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as MachineHookEvent).reverse();
  }

  addNotification(n: GashoNotification): void {
    this.db
      .prepare("INSERT OR REPLACE INTO notifications (id, at, read, data) VALUES (?, ?, ?, ?)")
      .run(n.id, n.at, n.read ? 1 : 0, JSON.stringify(n));
  }

  recentNotifications(limit = 100): GashoNotification[] {
    const rows = this.db
      .prepare("SELECT data, read FROM notifications ORDER BY at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => ({ ...(JSON.parse(String(r.data)) as GashoNotification), read: Number(r.read) === 1 }));
  }

  markRead(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(now - EVENT_TTL_MS);
    this.db.prepare("DELETE FROM notifications WHERE at < ?").run(now - NOTIFICATION_TTL_MS);
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(now - 24 * 3600_000);
  }

  close(): void {
    this.db.close();
  }
}

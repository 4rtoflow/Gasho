// Persists what the hub must remember across restarts: the last known sessions of each machine,
// recent hook events and notifications. Uses node:sqlite (built into Node.js 24).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GashoNotification, MachineHookEvent, MachineInfo, SessionInfo } from "@gasho/protocol";

const EVENT_TTL_MS = 7 * 24 * 3600_000;
const NOTIFICATION_TTL_MS = 30 * 24 * 3600_000;

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS machines (
        name TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        daemon_version TEXT,
        sessions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_at ON notifications(at);
    `);
  }

  saveMachine(m: MachineInfo): void {
    this.db
      .prepare(
        `INSERT INTO machines (name, last_seen, daemon_version, sessions) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen,
           daemon_version = excluded.daemon_version, sessions = excluded.sessions`,
      )
      .run(m.name, m.lastSeen, m.daemonVersion ?? null, JSON.stringify(m.sessions));
  }

  /** Machines as last seen; all of them start disconnected. */
  loadMachines(): MachineInfo[] {
    return (this.db.prepare("SELECT * FROM machines ORDER BY name").all() as Row[]).map((r) => ({
      name: String(r.name),
      connected: false,
      lastSeen: Number(r.last_seen),
      daemonVersion: r.daemon_version == null ? undefined : String(r.daemon_version),
      sessions: JSON.parse(String(r.sessions)) as SessionInfo[],
    }));
  }

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
  }

  close(): void {
    this.db.close();
  }
}

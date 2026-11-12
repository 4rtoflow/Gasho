// The tokens a session has used, from Claude Code's transcripts: the session's own and its subagents' (kept beside it
// in <project>/<sessionId>/subagents/, workflows included). Every reply records its usage; a reply written as several
// records (one per content block) repeats the same usage, so each reply (its message id) counts once.
import fs from "node:fs/promises";
import path from "node:path";
import type { TokenUsage } from "@gasho/protocol";

const HOUR = 3600_000;
/** Hours of use kept per session: the home screen compares the last 24 hours with the 24 before. */
export const TOKEN_HOURS = 48;
/** Bytes read from one file per update; the rest is read the next time. */
const READ_MAX = 32 * 1024 * 1024;

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function add(to: TokenUsage, u: TokenUsage, sign = 1): void {
  to.input += sign * u.input;
  to.output += sign * u.output;
  to.cacheWrite += sign * u.cacheWrite;
  to.cacheRead += sign * u.cacheRead;
}

/** The usage a transcript line records (a reply of Claude), or undefined. */
export function usageOfLine(line: string): { id: string; at: number; usage: TokenUsage } | undefined {
  // Most lines record no usage; skip them before parsing.
  if (!line.includes('"usage"')) return undefined;
  let r: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } };
  try {
    r = JSON.parse(line) as typeof r;
  } catch {
    return undefined;
  }
  const u = r?.message?.usage;
  const id = r?.message?.id;
  if (r?.type !== "assistant" || !u || typeof id !== "string") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : Number.NaN;
  return {
    id,
    at: Number.isFinite(at) ? at : 0,
    usage: {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      cacheRead: n(u.cache_read_input_tokens),
    },
  };
}

/** The .jsonl files under `dir` (any depth); none when it does not exist. */
async function transcriptsIn(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir, { recursive: true });
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Counts the tokens of one session; `update` reads what was written since the last call. */
export class TokenCounter {
  private transcript: string;
  private replies = new Map<string, { hour: number; usage: TokenUsage }>();
  private total = emptyUsage();
  private byHour = new Map<number, TokenUsage>();
  private files = new Map<string, { offset: number; rest: Buffer }>();

  constructor(transcript: string) {
    this.transcript = transcript;
  }

  /** Reads the session's transcript and its subagents' from where the last call stopped; whether anything changed. */
  async update(): Promise<boolean> {
    const subagents = path.join(path.dirname(this.transcript), path.basename(this.transcript, ".jsonl"), "subagents");
    let changed = false;
    for (const file of [this.transcript, ...(await transcriptsIn(subagents))]) {
      if (await this.read(file)) changed = true;
    }
    return changed;
  }

  private async read(file: string): Promise<boolean> {
    const known = this.files.get(file) ?? { offset: 0, rest: Buffer.alloc(0) };
    this.files.set(file, known);
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(file, "r");
    } catch {
      return false;
    }
    try {
      const { size } = await fh.stat();
      if (size < known.offset) {
        // Rewritten: what was counted from it stays counted (replies are counted by id), and it is read again.
        known.offset = 0;
        known.rest = Buffer.alloc(0);
      }
      if (size === known.offset) return false;
      const chunk = Buffer.alloc(Math.min(size - known.offset, READ_MAX));
      await fh.read(chunk, 0, chunk.length, known.offset);
      known.offset += chunk.length;
      // Only whole lines: the rest (with a character split between reads) waits for the next read.
      const data = Buffer.concat([known.rest, chunk]);
      const lastNl = data.lastIndexOf(10);
      known.rest = Buffer.from(data.subarray(lastNl + 1));
      let changed = false;
      for (const line of data.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
        const reply = usageOfLine(line);
        if (reply && this.count(reply)) changed = true;
      }
      return changed;
    } finally {
      await fh.close();
    }
  }

  /** Counts a reply, replacing what an earlier record of the same reply counted. */
  private count({ id, at, usage }: { id: string; at: number; usage: TokenUsage }): boolean {
    const hour = Math.floor(at / HOUR) * HOUR;
    const before = this.replies.get(id);
    if (before) {
      const u = before.usage;
      if (before.hour === hour && u.input === usage.input && u.output === usage.output && u.cacheWrite === usage.cacheWrite && u.cacheRead === usage.cacheRead) {
        return false;
      }
      add(this.total, u, -1);
      const h = this.byHour.get(before.hour);
      if (h) add(h, u, -1);
    }
    this.replies.set(id, { hour, usage });
    add(this.total, usage);
    const h = this.byHour.get(hour) ?? emptyUsage();
    add(h, usage);
    this.byHour.set(hour, h);
    return true;
  }

  totals(): TokenUsage {
    return { ...this.total };
  }

  /** The use per hour over the last TOKEN_HOURS hours, oldest first; hours without use are left out. */
  hours(now: number): [number, TokenUsage][] {
    const since = Math.floor(now / HOUR) * HOUR - (TOKEN_HOURS - 1) * HOUR;
    return [...this.byHour]
      .filter(([hour, u]) => hour >= since && u.input + u.output + u.cacheWrite + u.cacheRead > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([hour, u]) => [hour, { ...u }]);
  }
}

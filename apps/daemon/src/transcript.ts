// Reads Claude Code transcripts (~/.claude/projects/<dir>/<sessionId>.jsonl).
// The format is internal to Claude Code, so unknown records are ignored rather than rejected.
import fs from "node:fs/promises";
import type { PrLink, TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { clip, inputSummary, str } from "./util.ts";

const MAX_TEXT = 4000;
const MAX_TOOL = 2000;
const INTERRUPT_RE = /^\[Request interrupted by user/;

/** Session facts collected from transcript records. */
export interface TranscriptMeta {
  title?: string;
  gitBranch?: string;
  prLinks: PrLink[];
  costUSD?: number;
  bridgeSessionId?: string;
  lastActivityAt?: number;
}

export function emptyMeta(): TranscriptMeta {
  return { prLinks: [] };
}

/** Transcripts record `cse_…`; the registry and the claude.ai URL use `session_…` with the same suffix. */
export function toUrlSessionId(id: string): string {
  return id.startsWith("cse_") ? `session_${id.slice(4)}` : id;
}

function contentToString(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (b && typeof b === "object") {
          const o = b as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (o.type === "image") return "[image]";
        }
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return c == null ? "" : JSON.stringify(c);
}

/** Converts one transcript record into a renderable entry (or null) and updates `meta`. */
export function parseRecord(rec: Record<string, unknown>, meta: TranscriptMeta): TranscriptEntry | null {
  switch (rec.type) {
    case "ai-title":
      if (typeof rec.aiTitle === "string") meta.title = rec.aiTitle;
      return null;
    case "pr-link": {
      const { prNumber, prUrl, prRepository } = rec;
      if (
        typeof prNumber === "number" &&
        typeof prUrl === "string" &&
        typeof prRepository === "string" &&
        !meta.prLinks.some((p) => p.url === prUrl)
      ) {
        meta.prLinks.push({ number: prNumber, url: prUrl, repository: prRepository });
      }
      return null;
    }
    case "cost-state":
      if (typeof rec.totalCostUSD === "number") meta.costUSD = rec.totalCostUSD;
      return null;
    case "bridge-session":
      if (typeof rec.bridgeSessionId === "string") meta.bridgeSessionId = toUrlSessionId(rec.bridgeSessionId);
      return null;
    case "user":
    case "assistant":
    case "system":
      break;
    default:
      return null;
  }
  const role = rec.type as TranscriptEntry["role"];
  if (rec.isMeta === true) return null;

  const branch = str(rec.gitBranch);
  if (branch) meta.gitBranch = branch;
  const ts = str(rec.timestamp);
  if (ts) {
    const t = Date.parse(ts);
    if (!Number.isNaN(t) && t > (meta.lastActivityAt ?? 0)) meta.lastActivityAt = t;
  }
  const uuid = str(rec.uuid) ?? "";
  const isSidechain = rec.isSidechain === true;

  if (role === "system") {
    const text = str(rec.content);
    return text ? { uuid, ts, role, blocks: [{ type: "text", text: clip(text, MAX_TEXT) }], isSidechain } : null;
  }

  const content = (rec.message as { content?: unknown } | undefined)?.content;
  const blocks: TranscriptBlock[] = [];
  let interrupted = false;
  const pushText = (t: string): void => {
    if (!t) return;
    if (INTERRUPT_RE.test(t)) interrupted = true;
    blocks.push({ type: "text", text: clip(t, MAX_TEXT) });
  };
  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      if (b.type === "text") {
        pushText(str(b.text) ?? "");
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: str(b.id),
          name: str(b.name) ?? "tool",
          input: clip(JSON.stringify(b.input ?? {}), MAX_TOOL),
          summary: inputSummary(b.input, 300),
        });
      } else if (b.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          toolUseId: str(b.tool_use_id),
          content: clip(contentToString(b.content), MAX_TOOL),
          isError: b.is_error === true,
        });
      } else if (b.type === "image") {
        blocks.push({ type: "image" });
      }
      // thinking and other block types are not shown.
    }
  }
  if (blocks.length === 0) return null;
  const entry: TranscriptEntry = { uuid, ts, role, blocks, isSidechain };
  if (interrupted) entry.interrupted = true;
  return entry;
}

function parseLines(buf: Buffer, meta: TranscriptMeta, out: TranscriptEntry[]): void {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl < 0) break;
    const line = buf.subarray(start, nl).toString("utf8");
    start = nl + 1;
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec === "object") {
      const entry = parseRecord(rec as Record<string, unknown>, meta);
      if (entry) out.push(entry);
    }
  }
}

/** Reads every complete line. `consumed` is the byte offset just after the last newline. */
export async function readTranscript(
  file: string,
): Promise<{ entries: TranscriptEntry[]; meta: TranscriptMeta; consumed: number }> {
  const buf = await fs.readFile(file);
  const consumed = buf.lastIndexOf(10) + 1;
  const meta = emptyMeta();
  const entries: TranscriptEntry[] = [];
  parseLines(buf.subarray(0, consumed), meta, entries);
  return { entries, meta, consumed };
}

/** Follows a transcript from a byte offset and returns entries appended since the last poll. */
export class TranscriptTail {
  readonly file: string;
  private offset: number;
  private rest: Buffer = Buffer.alloc(0);

  constructor(file: string, offset: number) {
    this.file = file;
    this.offset = offset;
  }

  async poll(meta: TranscriptMeta): Promise<TranscriptEntry[]> {
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(this.file, "r");
    } catch {
      return [];
    }
    try {
      const { size } = await fh.stat();
      if (size < this.offset) {
        // The file was rewritten; start over.
        this.offset = 0;
        this.rest = Buffer.alloc(0);
      }
      if (size === this.offset) return [];
      const chunk = Buffer.alloc(size - this.offset);
      await fh.read(chunk, 0, chunk.length, this.offset);
      this.offset = size;
      const data = Buffer.concat([this.rest, chunk]);
      const lastNl = data.lastIndexOf(10);
      this.rest = Buffer.from(data.subarray(lastNl + 1));
      const out: TranscriptEntry[] = [];
      parseLines(data.subarray(0, lastNl + 1), meta, out);
      return out;
    } finally {
      await fh.close();
    }
  }
}

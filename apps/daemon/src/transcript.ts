// Reads Claude Code transcripts (~/.claude/projects/<dir>/<sessionId>.jsonl).
// The format is internal to Claude Code, so unknown records are ignored rather than rejected.
import fs from "node:fs/promises";
import type { PrLink, TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { clip, inputSummary, str } from "./util.ts";

const MAX_TEXT = 4000;
const MAX_TOOL = 2000;
const INTERRUPT_RE = /^\[Request interrupted by user/;
/** A slash command typed into Claude Code, recorded as a user message. */
const COMMAND_RE = /^\s*<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
/** What a slash command printed, recorded as a user message. */
const COMMAND_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;
/** Text pasted into Claude Code (as Gasho sends it) is recorded inside this tag. */
const PASTED_RE = /<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/g;
const MODEL_SET_RE = /Set model to `?([^`\n]+?)`?(?: and saved| for this session|$)/;

/** "claude-opus-5-5" → "Opus 5.5". Other names are returned as they are. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m?.[1] || !m[2]) return id;
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/**
 * A slash command (such as /model) or what it printed, as a short note; undefined for other text. Claude Code
 * records these as user messages or as system records. A model switch also updates the session's model.
 */
function commandNote(content: string, meta: TranscriptMeta): string | undefined {
  const command = COMMAND_RE.exec(content);
  if (command?.[1]) return `${command[1].trim()} ${COMMAND_ARGS_RE.exec(content)?.[1]?.trim() ?? ""}`.trim();
  const output = COMMAND_OUTPUT_RE.exec(content);
  if (!output) return undefined;
  const text = (output[2] ?? "").trim();
  const model = MODEL_SET_RE.exec(text)?.[1];
  if (model) meta.model = model.trim();
  return text;
}

/** Removes Claude Code's wrapper around pasted text, keeping the text. */
export function unwrapPasted(text: string): string {
  return text.replace(PASTED_RE, "$1").replace(/^\n+|\n+$/g, "");
}

/** Session facts collected from transcript records. */
export interface TranscriptMeta {
  title?: string;
  gitBranch?: string;
  prLinks: PrLink[];
  costUSD?: number;
  bridgeSessionId?: string;
  lastActivityAt?: number;
  /** "Opus 5.5": the model of the latest reply or model switch. */
  model?: string;
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
    case "attachment": {
      // Claude Code tells the model which model it is at the start of a turn.
      const a = rec.attachment as { type?: unknown; identity?: { marketingName?: unknown; modelId?: unknown } } | undefined;
      if (a?.type === "model" && rec.isSidechain !== true) {
        const name = str(a.identity?.marketingName) ?? (typeof a.identity?.modelId === "string" ? modelLabel(a.identity.modelId) : undefined);
        if (name) meta.model = name;
      }
      return null;
    }
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
    const raw = str(rec.content);
    const text = raw === undefined ? undefined : (commandNote(raw, meta) ?? raw);
    return text ? { uuid, ts, role, blocks: [{ type: "text", text: clip(text, MAX_TEXT) }], isSidechain } : null;
  }

  const message = rec.message as { content?: unknown; model?: unknown } | undefined;
  const content = message?.content;
  if (role === "assistant" && !isSidechain && typeof message?.model === "string" && !message.model.startsWith("<")) {
    meta.model = modelLabel(message.model);
  }
  if (role === "user" && typeof content === "string") {
    // Slash commands (such as /model) and their output are shown as notes, not as something the user said.
    const note = commandNote(content, meta);
    if (note !== undefined) {
      return note ? { uuid, ts, role: "system", blocks: [{ type: "text", text: clip(note, MAX_TEXT) }], isSidechain } : null;
    }
  }
  const blocks: TranscriptBlock[] = [];
  let interrupted = false;
  const pushText = (raw: string): void => {
    const t = role === "user" ? unwrapPasted(raw) : raw;
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

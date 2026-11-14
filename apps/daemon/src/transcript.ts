// Reads Claude Code transcripts (~/.claude/projects/<dir>/<sessionId>.jsonl).
// The format is internal to Claude Code, so unknown records are ignored rather than rejected.
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BackgroundTask,
  BackgroundTaskKind,
  EffortLevel,
  PastConversation,
  PrLink,
  TranscriptBlock,
  TranscriptEntry,
} from "@gasho/protocol";
import { clip, inputSummary, str } from "./util.ts";

/**
 * What Claude and the person wrote is sent whole: an answer with diagrams and tables runs to 9,000 characters, and a
 * message sent from Gasho to 20,000. The limit only stops a runaway text: the screen loads 80 entries at a time, and
 * 80 texts this long still fit in the WebSocket's 16 MB.
 */
const MAX_TEXT = 40000;
const MAX_TOOL = 2000;
/** A compaction's summary is long (10,000 to 25,000 characters) and is read only when its fold is opened. */
const MAX_SUMMARY = 40000;
const INTERRUPT_RE = /^\[Request interrupted by user/;
/** A slash command typed into Claude Code, recorded as a user message. */
const COMMAND_RE = /^\s*<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
/** What a slash command printed, recorded as a user message. */
const COMMAND_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;
/** Text pasted into Claude Code (as Gasho sends it) is recorded inside this tag. */
const PASTED_RE = /<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/g;
const MODEL_SET_RE = /Set model to `?([^`\n]+?)`?(?: and saved| for this session|$)/;
/** "Set effort level to high", "… with `medium` effort", "Effort stays high." */
const EFFORT_SET_RE = /(?:Set effort level to|Effort stays|with) `?(low|medium|high|xhigh|max)`?/i;
const ULTRACODE_RE = /^Ultracode (on|off)\b/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

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
  if (model && /for this session only/.test(text)) meta.sessionSwitches = (meta.sessionSwitches ?? 0) + 1;
  const effort = EFFORT_SET_RE.exec(text)?.[1]?.toLowerCase();
  if (effort) meta.effort = effort as EffortLevel;
  const ultracode = ULTRACODE_RE.exec(text)?.[1]?.toLowerCase();
  if (ultracode) meta.ultracode = ultracode === "on";
  return text;
}

/** Removes Claude Code's wrapper around pasted text, keeping the text. */
export function unwrapPasted(text: string): string {
  return text.replace(PASTED_RE, "$1").replace(/^\n+|\n+$/g, "");
}

/** The line before the summary of a compaction, and the start of the lines for the model after it. */
const SUMMARY_HEAD = "\nSummary:\n";
const SUMMARY_TAIL = "\n\nIf you need specific details from before compaction";

/**
 * The summary Claude Code wrote at a compaction, without the lines around it that are meant for the model: before it,
 * "This session is being continued from a previous conversation …"; after it, where the full transcript is and how to
 * go on. Text of another shape is kept whole. The summary may quote these lines, so the last of the lines after it
 * counts, and the line before it only near the start. A <summary> tag the model left around it is dropped too.
 */
export function compactSummaryText(raw: string): string {
  const head = raw.indexOf(SUMMARY_HEAD);
  const body = head >= 0 && head < 2000 ? raw.slice(head + SUMMARY_HEAD.length) : raw;
  const tail = body.lastIndexOf(SUMMARY_TAIL);
  return (tail >= 0 ? body.slice(0, tail) : body)
    .trim()
    .replace(/^<summary>\s*/, "")
    .replace(/\s*<\/summary>$/, "");
}

/** Session facts collected from transcript records. */
export interface TranscriptMeta {
  title?: string;
  /** The name given with /rename or --name (`custom-title`; the last one counts). */
  customTitle?: string;
  gitBranch?: string;
  prLinks: PrLink[];
  costUSD?: number;
  bridgeSessionId?: string;
  lastActivityAt?: number;
  /** "Opus 5.5": the model of the latest reply or model switch. */
  model?: string;
  /** The effort level of the latest reply or effort change, and ultracode after /effort ultracode on|off. */
  effort?: EffortLevel;
  ultracode?: boolean;
  /** How many times the transcript says the model was switched for this session only. */
  sessionSwitches?: number;
  /**
   * Claude's latest question (AskUserQuestion) while the transcript has no answer to it: the call's id, its input as
   * Claude wrote it (not clipped), and when. Cleared by the call's result or by a new message from the person.
   */
  question?: { toolUseId: string; input: Record<string, unknown>; at?: number };
  /** Work Claude started in the background (see BackgroundTasks). */
  background?: BackgroundTasks;
}

export function emptyMeta(): TranscriptMeta {
  return { prLinks: [], background: new BackgroundTasks() };
}

function tasksOf(meta: TranscriptMeta): BackgroundTasks {
  return (meta.background ??= new BackgroundTasks());
}

/** The text of a message record, without its tools' results. */
function messageText(rec: Record<string, unknown>): string {
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

/** The tools whose calls can start work that runs in the background, and what that work is. */
const BACKGROUND_TOOLS: Record<string, BackgroundTaskKind> = {
  Bash: "shell",
  PowerShell: "shell",
  Monitor: "monitor",
  Agent: "agent",
  Task: "agent",
  Workflow: "workflow",
};
/** Tools that stop background work by its id: TaskStop, and KillShell and KillBash before it. */
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
/** The results that name the work they started, for a record whose result Claude Code did not keep apart. */
const STARTED_RES: Partial<Record<BackgroundTaskKind, RegExp>> = {
  shell: /^Command (?:running in background with ID: |was manually backgrounded by user with ID: |was moved to the background \(ID: )([\w-]+)/,
  monitor: /^Monitor started \(task ([\w-]+)/,
  agent: /^Async agent launched[\s\S]*?\bagentId: ([\w-]+)/,
  workflow: /^Workflow launched in background\. Task ID: ([\w-]+)/,
};
/** Claude Code's notice about background work; it says how the work ended once it has (a monitor's events do not). */
const TASK_NOTICE_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;
const TASK_ENDED_RE = /<status>\s*(?:completed|failed|killed|stopped)\s*<\/status>/;
/** The ids of ended work that are remembered: a notice can be recorded before the result that started the work. */
const MAX_ENDED = 1000;
const MAX_TASK_TITLE = 200;
const MAX_TASK_COMMAND = 1000;

/** The first line of a text, clipped; undefined when it has none. */
function firstLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.trim().split("\n", 1)[0]?.trim();
  return line ? clip(line, max) : undefined;
}

/**
 * Work that Claude started in the background, followed through the transcript: the tool call that can start some
 * (Bash or PowerShell with `run_in_background`, or moved there later; Monitor; Agent; Workflow), its result that names
 * the work it started, and Claude Code's notice when that work has ended (or the result of a TaskStop for it). Work
 * whose end is not recorded may still run; whether it does is Claude Code's to say (see the Daemon).
 */
export class BackgroundTasks {
  private started = new Map<string, BackgroundTask>();
  private calls = new Map<string, { name: string; input: Record<string, unknown>; at?: number }>();
  private ended = new Set<string>();

  /** What was started and has no end recorded, in the order it started. */
  list(): BackgroundTask[] {
    return [...this.started.values()];
  }

  /** A call of Claude's tools (main conversation only). */
  call(id: string | undefined, name: string, input: unknown, at: number | undefined): void {
    if (!id || !(name in BACKGROUND_TOOLS || STOP_TOOLS.has(name))) return;
    const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    this.calls.set(id, { name, input: args, ...(at === undefined ? {} : { at }) });
  }

  /**
   * The result of a call: `meta` is what Claude Code kept about it (the record's `toolUseResult`, when the record holds
   * only this result), `text` what Claude read.
   */
  result(toolUseId: string | undefined, meta: unknown, text: string, isError: boolean, at: number | undefined): void {
    const call = toolUseId ? this.calls.get(toolUseId) : undefined;
    if (!call || !toolUseId) return;
    this.calls.delete(toolUseId);
    if (isError) return;
    const r = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
    if (STOP_TOOLS.has(call.name)) {
      const id = str(call.input.task_id) ?? str(call.input.shell_id) ?? str(r.task_id);
      if (id) this.end(id);
      return;
    }
    const kind = BACKGROUND_TOOLS[call.name];
    if (!kind) return;
    let id: string | undefined;
    if (kind === "shell") id = str(r.backgroundTaskId);
    else if (kind === "agent") id = r.status === "async_launched" ? str(r.agentId) : undefined;
    else id = str(r.taskId);
    if (!id && Object.keys(r).length === 0) {
      id = STARTED_RES[kind]?.exec(text.trim())?.[1];
    }
    if (!id || this.ended.has(id)) return;
    const input = call.input;
    const command = kind === "shell" || kind === "monitor" ? firstCommand(input) : undefined;
    const title =
      firstLine(input.description, MAX_TASK_TITLE) ??
      (kind === "workflow" ? workflowName(input) : undefined) ??
      firstLine(command, MAX_TASK_TITLE) ??
      firstLine(input.subagent_type, MAX_TASK_TITLE) ??
      call.name;
    const startedAt = call.at ?? at;
    this.started.set(id, { id, kind, title, ...(command ? { command } : {}), ...(startedAt === undefined ? {} : { startedAt }) });
  }

  /** Takes as ended the work that `running` says no longer runs (see mayRun in sessions.ts). */
  settle(running: (task: BackgroundTask) => boolean): void {
    for (const t of [...this.started.values()]) if (!running(t)) this.end(t.id);
  }

  /** A text that may hold Claude Code's notices about background work (a queued or delivered message). */
  notices(text: string): void {
    if (!text.includes("<task-notification>")) return;
    for (const [notice] of text.matchAll(TASK_NOTICE_RE)) {
      const id = TASK_ID_RE.exec(notice)?.[1];
      if (id && TASK_ENDED_RE.test(notice)) this.end(id);
    }
  }

  private end(id: string): void {
    this.started.delete(id);
    this.ended.add(id);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.values().next().value as string);
  }
}

/** The command a shell or a monitor runs (a monitor can watch a WebSocket instead). */
function firstCommand(input: Record<string, unknown>): string | undefined {
  if (typeof input.command === "string" && input.command.trim()) return clip(input.command.trim(), MAX_TASK_COMMAND);
  const ws = input.ws && typeof input.ws === "object" ? str((input.ws as Record<string, unknown>).url) : undefined;
  return ws ? clip(ws, MAX_TASK_COMMAND) : undefined;
}

/** A workflow's name: the saved workflow it runs, or the name in its script's `meta`. */
function workflowName(input: Record<string, unknown>): string | undefined {
  const named = firstLine(input.name, MAX_TASK_TITLE);
  if (named) return named;
  const script = typeof input.script === "string" ? input.script : "";
  return firstLine(/\bname\s*:\s*["'`]([^"'`\n]+)["'`]/.exec(script)?.[1], MAX_TASK_TITLE);
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
    case "custom-title":
      if (typeof rec.customTitle === "string" && rec.customTitle.trim()) meta.customTitle = rec.customTitle.trim();
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
      const a = rec.attachment as { type?: unknown; identity?: { marketingName?: unknown; modelId?: unknown }; prompt?: unknown } | undefined;
      if (a?.type === "model" && rec.isSidechain !== true) {
        const name = str(a.identity?.marketingName) ?? (typeof a.identity?.modelId === "string" ? modelLabel(a.identity.modelId) : undefined);
        if (name) meta.model = name;
      }
      // A notice queued for Claude, such as one that background work has ended.
      if (typeof a?.prompt === "string" && rec.isSidechain !== true) tasksOf(meta).notices(a.prompt);
      return null;
    }
    case "queue-operation":
      // What Claude Code queued for Claude: Claude Code's notices about background work are recorded here first.
      if (typeof rec.content === "string") tasksOf(meta).notices(rec.content);
      return null;
    case "user":
    case "assistant":
    case "system":
      break;
    default:
      return null;
  }
  // Claude Code's notices come as messages to Claude (not in a tool's result, which could quote one). The subagents'
  // own work is not followed.
  if (rec.type === "user" && rec.isSidechain !== true) tasksOf(meta).notices(messageText(rec));
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
    if (rec.subtype === "compact_boundary") {
      const text = str(rec.content) || "Conversation compacted";
      return { uuid, ts, role, blocks: [{ type: "text", text }], isSidechain, compaction: "mark" };
    }
    const raw = str(rec.content);
    const text = raw === undefined ? undefined : (commandNote(raw, meta) ?? raw);
    return text ? { uuid, ts, role, blocks: [{ type: "text", text: clip(text, MAX_TEXT) }], isSidechain } : null;
  }

  const message = rec.message as { content?: unknown; model?: unknown } | undefined;
  const content = message?.content;
  if (role === "assistant" && !isSidechain && typeof message?.model === "string" && !message.model.startsWith("<")) {
    meta.model = modelLabel(message.model);
    // Each reply records the effort level it was made with.
    if (typeof rec.effort === "string" && EFFORTS.has(rec.effort)) meta.effort = rec.effort as EffortLevel;
  }
  if (rec.isCompactSummary === true) {
    // The summary a compaction left, recorded as a user message: a system entry that goes with the compaction's mark.
    const summary = compactSummaryText(contentToString(content));
    if (!summary) return null;
    return { uuid, ts, role: "system", blocks: [{ type: "text", text: clip(summary, MAX_SUMMARY) }], isSidechain, compaction: "summary" };
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
  const parsedAt = ts ? Date.parse(ts) : Number.NaN;
  const at = Number.isNaN(parsedAt) ? undefined : parsedAt;
  // What Claude Code kept about a tool's result goes with the record: it says which one only when it holds one result.
  const results = Array.isArray(content) ? content.filter((b) => (b as { type?: unknown } | null)?.type === "tool_result").length : 0;
  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      if (b.type === "text") {
        pushText(str(b.text) ?? "");
      } else if (b.type === "tool_use") {
        const id = str(b.id);
        if (role === "assistant" && !isSidechain && b.name === "AskUserQuestion" && id && b.input && typeof b.input === "object") {
          meta.question = { toolUseId: id, input: b.input as Record<string, unknown>, ...(at === undefined ? {} : { at }) };
        }
        if (role === "assistant" && !isSidechain) tasksOf(meta).call(id, str(b.name) ?? "", b.input, at);
        blocks.push({
          type: "tool_use",
          id,
          name: str(b.name) ?? "tool",
          input: clip(JSON.stringify(b.input ?? {}), MAX_TOOL),
          summary: inputSummary(b.input, 300),
        });
      } else if (b.type === "tool_result") {
        if (meta.question && str(b.tool_use_id) === meta.question.toolUseId) delete meta.question;
        if (role === "user" && !isSidechain) {
          const kept = results === 1 ? rec.toolUseResult : undefined;
          tasksOf(meta).result(str(b.tool_use_id), kept, contentToString(b.content), b.is_error === true, at);
        }
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
  // The person wrote something (or stopped Claude) since the question: it is no longer waiting for an answer.
  if (role === "user" && !isSidechain && blocks.some((b) => b.type === "text")) delete meta.question;
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

/** Claude Code's directory for a folder's transcripts (~/.claude/projects/<this>): what is not a letter or a digit becomes "-". */
export function projectDirName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

/** How much of a transcript is read for its folder and first message, and for its latest name and title. */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
/** How many transcripts one listing reads at most: those of other folders under the same directory name count too. */
const MAX_READ = 200;

async function readRange(file: string, start: number, length: number): Promise<Buffer> {
  const h = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await h.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

function records(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    try {
      const rec = JSON.parse(line) as unknown;
      if (rec && typeof rec === "object") out.push(rec as Record<string, unknown>);
    } catch {
      // A line cut at the edge of what was read, or not JSON.
    }
  }
  return out;
}

/** The text of a message the person typed: not a tool's result, nor what Claude Code adds on its own. */
function typedText(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true) return undefined;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
        : "";
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain || undefined;
}

function clipChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/**
 * A transcript's folder (the `cwd` its records give) and its title: the name given with /rename, else the title Claude
 * Code gave it, else the start of its first message. Undefined for a transcript with no message in what is read.
 */
export async function conversationFacts(file: string): Promise<{ cwd: string; title?: string } | undefined> {
  const size = (await fs.stat(file)).size;
  const head = records((await readRange(file, 0, Math.min(size, HEAD_BYTES))).toString("utf8"));
  const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
  const tail = size > tailStart ? records((await readRange(file, tailStart, size - tailStart)).toString("utf8")) : [];
  const all = [...head, ...tail];
  const cwd = all.map((r) => r.cwd).find((c): c is string => typeof c === "string" && c.startsWith("/"));
  if (!cwd || !all.some((r) => r.type === "user" || r.type === "assistant")) return undefined;
  let custom: string | undefined;
  let ai: string | undefined;
  for (const r of all) {
    if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) custom = r.customTitle.trim();
    if (r.type === "ai-title" && typeof r.aiTitle === "string" && r.aiTitle.trim()) ai = r.aiTitle.trim();
  }
  const first = all.map(typedText).find(Boolean);
  const title = custom ?? ai ?? (first ? clipChars(first, 80) : undefined);
  return { cwd, ...(title ? { title } : {}) };
}

/**
 * The conversations Claude Code keeps for `folder` (with `subfolders`, also for the folders inside it), except the
 * `open` ones, the latest first, at most `limit`. A transcript's folder is the one its records give: the directory's
 * name only narrows the search, as "/a/b-c" and "/a/b/c" have the same one.
 */
export async function pastConversations(
  claudeDir: string,
  folder: string,
  { subfolders = false, open = new Set<string>(), limit = 30 }: { subfolders?: boolean; open?: ReadonlySet<string>; limit?: number } = {},
): Promise<PastConversation[]> {
  const projects = path.join(claudeDir, "projects");
  const dirName = projectDirName(folder);
  let dirs: import("node:fs").Dirent[];
  try {
    dirs = await fs.readdir(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { sessionId: string; file: string; mtime: number }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !(d.name === dirName || (subfolders && d.name.startsWith(`${dirName}-`)))) continue;
    const names = await fs.readdir(path.join(projects, d.name)).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      if (open.has(sessionId)) continue;
      const file = path.join(projects, d.name, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat?.isFile()) files.push({ sessionId, file, mtime: stat.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const inside = (cwd: string) => cwd === folder || (subfolders && cwd.startsWith(folder.endsWith("/") ? folder : `${folder}/`));
  const out: PastConversation[] = [];
  for (const f of files.slice(0, MAX_READ)) {
    if (out.length >= limit) break;
    const facts = await conversationFacts(f.file).catch(() => undefined);
    if (!facts || !inside(facts.cwd)) continue;
    out.push({ sessionId: f.sessionId, cwd: facts.cwd, lastActivityAt: Math.round(f.mtime), ...(facts.title ? { title: facts.title } : {}) });
  }
  return out;
}

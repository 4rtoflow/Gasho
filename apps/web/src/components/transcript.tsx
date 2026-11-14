// Conversation view. Reads older pages by itself as the reader scrolls up, keeping what is on screen in place, and
// follows new entries only while the reader is at the bottom. The footer (the chat box) floats over the bottom of the
// conversation: it stays at the bottom of the screen, and the conversation scrolls behind it, blurred.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowDown, ChevronRight, FoldVertical, Image as ImageIcon, LoaderCircle, Paperclip, Wrench } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { MarkdownText } from "@/components/markdown";
import { chatTextStyle, useChatTextSize } from "@/lib/chat-text";
import { clockTime } from "@/lib/format";
import type { PendingMessage } from "@/lib/pending";
import { isShellInput } from "@/lib/shell";
import type { TranscriptState } from "@/lib/store";
import { transcriptItems, type ToolUse, type TranscriptItem } from "@/lib/transcript-items";
import { cn } from "@/lib/utils";

export function toolSummary(input: string): string {
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt;
    if (typeof pick === "string") return pick;
  } catch {
    // inputs longer than the daemon's limit are cut and no longer parse
  }
  return input;
}

function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** The blur behind the chat box starts 2.5rem above it and is at full strength 1rem into it. */
const BLUR_MASK = "linear-gradient(to bottom, transparent, black 3.5rem)";

type ToolResult = Extract<TranscriptBlock, { type: "tool_result" }>;

interface ToolResultsOf {
  of: (id: string | undefined) => ToolResult | undefined;
  called: (id: string | undefined) => boolean;
}

/**
 * The results of the tool calls in the loaded part of the conversation, by the id of the call. A result is shown
 * inside its call's fold; one whose call is not loaded (an older page) is shown on its own.
 */
const ToolResults = createContext<ToolResultsOf>({
  of: () => undefined,
  called: () => false,
});

function toolResultsOf(entries: readonly TranscriptEntry[]): ToolResultsOf {
  const calls = new Set<string>();
  const results = new Map<string, ToolResult>();
  for (const e of entries) {
    for (const b of e.blocks) {
      if (b.type === "tool_use" && b.id) calls.add(b.id);
      else if (b.type === "tool_result" && b.toolUseId) results.set(b.toolUseId, b);
    }
  }
  return {
    of: (id) => (id ? results.get(id) : undefined),
    called: (id) => Boolean(id && calls.has(id)),
  };
}

const FOLD_BOX = "rounded-lg border border-border/60 bg-surface/60 text-xs";
const FOLD_SUMMARY =
  "flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden";

/**
 * A fold of the conversation (a tool call), closed by default. Its parts are labelled, each scrolls on its own.
 * A nested fold is a row of a group of folds (see ToolsFold), indented under the group's icon.
 */
function Fold({
  summary,
  parts,
  nested = false,
}: {
  summary: ReactNode;
  parts: { label: string; text: string; tone?: "error" }[];
  nested?: boolean;
}) {
  return (
    <details className={cn("group", nested ? "border-t border-border/60" : FOLD_BOX)}>
      <summary className={cn(FOLD_SUMMARY, nested && "pl-8")}>
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      {parts.map((p) => (
        <div key={p.label} className={cn("border-t border-border/60", nested && "ml-8")}>
          <div className={cn("px-3 pt-2 text-[length:calc(10.5px*var(--chat-scale,1))] text-muted-foreground", p.tone === "error" && "text-red-400")}>{p.label}</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pt-1 pb-2 font-mono text-[length:calc(11px*var(--chat-scale,1))] leading-relaxed text-foreground/80">
            {p.text}
          </pre>
        </div>
      ))}
    </details>
  );
}

/** What a result says about itself in a fold: "結果（1,234 文字）" or "エラー（…）". */
function resultLabel(r: ToolResult): string {
  return `${r.isError ? "エラー" : "結果"}（${r.content.length.toLocaleString()} 文字）`;
}

/** A tool call and, once it has come, its result, in one fold. In a group, the group's icon stands for its own. */
function ToolFold({ block, nested = false }: { block: ToolUse; nested?: boolean }) {
  const result = useContext(ToolResults).of(block.id);
  return (
    <Fold
      nested={nested}
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {!nested && <Wrench className={cn("size-3.5 shrink-0", result?.isError && "text-red-400")} />}
          <span className="shrink-0 font-mono font-medium text-foreground/90">{block.name}</span>
          <span className="truncate font-mono">{block.summary ?? toolSummary(block.input)}</span>
          {result?.isError && <span className="ml-auto shrink-0 text-red-400">エラー</span>}
        </span>
      }
      parts={[
        { label: "入力", text: pretty(block.input) },
        result
          ? { label: resultLabel(result), text: result.content || "（出力なし）", ...(result.isError ? { tone: "error" as const } : {}) }
          : { label: "結果", text: "（まだありません）" },
      ]}
    />
  );
}

/**
 * Tool calls that came in a row, in one fold: how many, the latest call (the one running, while the agent works)
 * and how many failed. Opened, it lists the calls, each in a fold of its own. The group is named so that its open
 * state does not reach the folds inside it, which use the plain group.
 */
function ToolsFold({ calls }: { calls: ToolUse[] }) {
  const results = useContext(ToolResults);
  const errors = calls.filter((c) => results.of(c.id)?.isError).length;
  const latest = calls.at(-1);
  return (
    <details className={cn("group/tools", FOLD_BOX)}>
      <summary className={FOLD_SUMMARY}>
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/tools:rotate-90" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Wrench className={cn("size-3.5 shrink-0", errors > 0 && "text-red-400")} />
          <span className="shrink-0 tabular-nums">ツール {calls.length} 回</span>
          {latest && (
            <span className="flex min-w-0 items-center gap-2 group-open/tools:hidden">
              <span className="shrink-0 font-mono font-medium text-foreground/90">{latest.name}</span>
              <span className="truncate font-mono">{latest.summary ?? toolSummary(latest.input)}</span>
            </span>
          )}
          {errors > 0 && <span className="ml-auto shrink-0 text-red-400">エラー {errors} 回</span>}
        </span>
      </summary>
      {calls.map((c, i) => (
        <ToolFold key={c.id ?? i} block={c} nested />
      ))}
    </details>
  );
}

/** A file sent from Gasho: the daemon saved it and mentioned it on a line of its own as @path. */
const ATTACHMENT_LINE = /^@(\S*\/gasho\/attachments\/[^/\s]+\/(\S+))$/;

/** What the user typed, as typed, with the files sent from Gasho shown as chips. */
function UserText({ text }: { text: string }) {
  const parts: ({ kind: "text"; text: string } | { kind: "file"; name: string; path: string })[] = [];
  for (const line of text.split("\n")) {
    const m = ATTACHMENT_LINE.exec(line.trim());
    const last = parts.at(-1);
    if (m?.[1] && m[2]) parts.push({ kind: "file", path: m[1], name: m[2].replace(/^\d{8}T\d{6}-\d+-/, "") });
    else if (last?.kind === "text") last.text += `\n${line}`;
    else parts.push({ kind: "text", text: line });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "file" ? (
          <FileChip key={i} name={p.name} title={p.path} />
        ) : p.text.trim() ? (
          <p key={i} className="whitespace-pre-wrap break-words leading-relaxed">
            {p.text.replace(/^\n+|\n+$/g, "")}
          </p>
        ) : null,
      )}
    </>
  );
}

function FileChip({ name, title }: { name: string; title?: string }) {
  return (
    <span title={title} className="mr-1.5 mb-1 inline-flex max-w-full items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1 text-xs">
      <Paperclip className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Claude's text is Markdown; what the user typed is shown as typed. */
function BlockView({ block, markdown = false }: { block: TranscriptBlock; markdown?: boolean }) {
  switch (block.type) {
    case "text":
      return markdown ? <MarkdownText text={block.text} /> : <UserText text={block.text} />;
    case "tool_use":
      return <ToolFold block={block} />;
    case "tool_result":
      // Shown inside its call's fold; on its own only while the call is not loaded.
      return <OrphanResult block={block} />;
    case "image":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5" />
          画像
        </span>
      );
  }
}

/** A result whose call is not in the loaded part of the conversation, in the same kind of fold as a call. */
function OrphanResult({ block }: { block: ToolResult }) {
  const results = useContext(ToolResults);
  if (results.called(block.toolUseId)) return null;
  return (
    <Fold
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Wrench className={cn("size-3.5 shrink-0", block.isError && "text-red-400")} />
          <span className={cn("truncate", block.isError && "text-red-400")}>{resultLabel(block)}</span>
        </span>
      }
      parts={[{ label: resultLabel(block), text: block.content || "（出力なし）", ...(block.isError ? { tone: "error" as const } : {}) }]}
    />
  );
}

/** An entry of the conversation. Entries that would show nothing are left out beforehand (see transcriptItems). */
function EntryView({ entry }: { entry: TranscriptEntry }) {
  const time = clockTime(entry.ts);
  if (entry.interrupted) {
    return (
      <div className="flex items-center gap-2 text-xs text-amber-400">
        <AlertTriangle className="size-3.5" />
        割り込まれました {time && <span className="text-muted-foreground">{time}</span>}
      </div>
    );
  }
  if (entry.role === "system") {
    return <div className="text-xs italic text-muted-foreground">{entry.blocks.map((b, i) => <BlockView key={i} block={b} />)}</div>;
  }
  const onlyResults = entry.blocks.every((b) => b.type === "tool_result");
  if (entry.role === "user" && !onlyResults) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2.5 text-sm">
          {entry.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
          {time && <div className="text-right text-[length:calc(10px*var(--chat-scale,1))] text-muted-foreground">{time}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("space-y-2 text-sm", onlyResults && "pl-5")}>
      {entry.isSidechain && <SidechainLabel />}
      {entry.blocks.map((b, i) => (
        <BlockView key={i} block={b} markdown={entry.role === "assistant"} />
      ))}
    </div>
  );
}

function SidechainLabel() {
  return <div className="text-[length:calc(10px*var(--chat-scale,1))] uppercase tracking-wide text-muted-foreground">サブエージェント</div>;
}

/**
 * A message sent from here that the conversation does not show yet (see lib/pending), in the place and look of the
 * user's own entries, with how far it has got instead of the time.
 */
function PendingView({ message: p }: { message: PendingMessage }) {
  // A shell command is recorded only once it has ended: typed into the session, it is running.
  const shell = isShellInput(p.text);
  if (shell) {
    return (
      <ShellCard
        command={p.text.slice(1)}
        footer={p.state === "queued" ? "送信待ち（作業が終わったら実行します）" : p.state === "sent" ? "実行中…" : "送信中…"}
      />
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2.5 text-sm">
        {p.text && <p className="whitespace-pre-wrap break-words leading-relaxed">{p.text}</p>}
        {p.files.map((name, i) => (
          <FileChip key={i} name={name} />
        ))}
        <div className="text-right text-[length:calc(10px*var(--chat-scale,1))] text-muted-foreground">
          {p.state === "queued" ? "送信待ち（作業が終わったら送ります）" : "送信中…"}
        </div>
      </div>
    </div>
  );
}

/**
 * A command run in Claude Code's shell mode ("!"), on the user's side like what they typed, and what it printed under
 * it, as in a terminal. A command that fails prints into its stderr part, shown in red.
 */
function ShellCard({ command, output, footer }: { command?: string; output?: { stdout: string; stderr: string }; footer?: ReactNode }) {
  const stdout = output?.stdout.replace(/\n+$/, "") ?? "";
  const stderr = output?.stderr.replace(/\n+$/, "") ?? "";
  return (
    <div className="flex justify-end">
      <div className="w-full max-w-[85%] overflow-hidden rounded-2xl rounded-br-md bg-primary/10 text-sm">
        {command !== undefined && (
          <div className="flex items-start gap-2 px-3.5 py-2.5 font-mono text-[length:calc(13px*var(--chat-scale,1))] leading-relaxed">
            <span className="select-none font-semibold text-amber-400" aria-label="シェルのコマンド">
              !
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{command}</span>
          </div>
        )}
        {output && (
          <pre
            className={cn(
              "max-h-80 overflow-auto bg-black/25 px-3.5 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
              command !== undefined && "border-t border-white/[0.06]",
            )}
          >
            {stdout}
            {stdout && stderr ? "\n" : ""}
            {stderr && <span className="text-red-300">{stderr}</span>}
            {!stdout && !stderr && <span className="text-muted-foreground">（出力なし）</span>}
          </pre>
        )}
        {footer && <div className="px-3.5 pt-1 pb-2 text-right text-[length:calc(10px*var(--chat-scale,1))] text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}

/** A shell-mode command from the conversation, with the time it was run. */
function ShellView({ item }: { item: Extract<TranscriptItem, { kind: "shell" }> }) {
  return <ShellCard command={item.command} output={item.output} footer={clockTime(item.ts) || undefined} />;
}

/**
 * Where Claude Code summarized the conversation to free its context, as a line across the conversation: from here on,
 * Claude knows what came before only from the summary. The summary is folded under the line (Claude Code, too, shows
 * it only when asked); while it is not loaded, the line is all there is.
 */
function CompactionView({ item }: { item: Extract<TranscriptItem, { kind: "compaction" }> }) {
  const time = clockTime(item.ts);
  const line = (foldable: boolean) => (
    <>
      <span className="h-px flex-1 bg-border/60" />
      <span className="flex shrink-0 items-center gap-1.5">
        <FoldVertical className="size-3.5" />
        会話を要約しました
        {time && <span className="tabular-nums">{time}</span>}
        {foldable && <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </>
  );
  if (!item.summary) return <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">{line(false)}</div>;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {line(true)}
      </summary>
      <div className={cn(FOLD_BOX, "mt-2 max-h-96 overflow-auto px-3.5 py-2.5 text-foreground/80")}>
        <MarkdownText text={item.summary} />
      </div>
    </details>
  );
}

/** The rows of the conversation, each marked as one for keepAnchor (`data-row`). */
function Rows({ items }: { items: TranscriptItem[] }) {
  return (
    <>
      {items.map((item) =>
        item.kind === "entry" ? (
          <div key={item.key} data-row="">
            <EntryView entry={item.entry} />
          </div>
        ) : item.kind === "shell" ? (
          <div key={item.key} data-row="">
            <ShellView item={item} />
          </div>
        ) : item.kind === "compaction" ? (
          <div key={item.key} data-row="">
            <CompactionView item={item} />
          </div>
        ) : (
          <div key={item.key} data-row="" className="space-y-2 text-sm">
            {item.isSidechain && <SidechainLabel />}
            <ToolsFold calls={item.calls} />
          </div>
        ),
      )}
    </>
  );
}

/** A short conversation drawn as the session screen draws one, with its text at `textSize` px: the settings screen's sample. */
export function TranscriptSample({ entries, textSize }: { entries: readonly TranscriptEntry[]; textSize: number }) {
  const toolResults = useMemo(() => toolResultsOf(entries), [entries]);
  const items = useMemo(() => transcriptItems(entries, 0, toolResults.called), [entries, toolResults]);
  return (
    <div className="chat-text flex flex-col gap-4" style={chatTextStyle(textSize)}>
      <ToolResults.Provider value={toolResults}>
        <Rows items={items} />
      </ToolResults.Provider>
    </div>
  );
}

/** Older entries are asked for while the reader is within this many screen heights of the top of what is loaded. */
const PREFETCH_SCREENS = 2;
/** A touch scroll is over once the conversation has not moved for this long: the finger is up and the fling has ended. */
const SCROLL_IDLE_MS = 150;
const NO_ENTRIES: TranscriptEntry[] = [];

/** A row of the conversation and where it was, from the top of the conversation (not of the screen). */
interface Anchor {
  node: HTMLElement;
  top: number;
}

/**
 * The conversation. Older entries are asked for by themselves as the reader scrolls up, before the top of what is
 * loaded comes into view, and the rows on screen stay where they are when the older ones are put above them. While a
 * touch scroll goes on, a page that arrives waits for it to stop. `pending`: messages sent from here that the
 * conversation does not show yet; they come after its entries. `end`: what comes after them (the plugins' parts at the
 * end of the conversation, P13); it takes no room while it shows nothing. `onLoadOlder` asks for the page before what
 * is loaded.
 */
export function Transcript({
  state,
  pending,
  onLoadOlder,
  footer,
  end,
}: {
  state: TranscriptState | undefined;
  pending?: PendingMessage[];
  onLoadOlder: () => void;
  footer?: ReactNode;
  end?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowsBox = useRef<HTMLDivElement>(null);
  const footerBox = useRef<HTMLDivElement>(null);
  const endBox = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [following, setFollowing] = useState(true);
  const prev = useRef<{ first?: string; count: number; topRow: boolean }>({ count: 0, topRow: false });
  const atBottom = useRef(true);
  // The rows at the top of the screen, refreshed as the reader scrolls; see keepAnchor.
  const anchors = useRef<Anchor[]>([]);
  const anchorFrame = useRef(0);
  // How the reader scrolls: with a finger (`touch`; then the scroll goes on as a fling after the finger is up) or not,
  // whether a finger is down, and when the conversation last moved.
  const scrolling = useRef({ touch: false, touching: false, at: 0 });
  // A page asked for during a touch scroll is put on screen once the scroll has stopped: moving the scroll position
  // under a finger or during a fling stops it, or is undone by it (iOS). Until then, the entries before the one that
  // was first (`holdFrom`) stay off screen.
  const [holdFrom, setHoldFrom] = useState<string>();

  const all = state?.entries ?? NO_ENTRIES;
  const holdAt = holdFrom ? all.findIndex((e) => e.uuid === holdFrom) : -1;
  const held = holdAt > 0 ? holdAt : 0;
  const entries = useMemo(() => (held > 0 ? all.slice(held) : all), [all, held]);
  const start = (state?.start ?? 0) + held;
  const loading = state?.loading === true;
  const loadingNow = useRef(loading);
  loadingNow.current = loading;
  // Reading went wrong while entries are on screen: an older page, or the conversation read again.
  const failed = Boolean(state?.error) && all.length > 0;
  // The row above the entries, while there are older ones: where they are being read, or why they were not.
  const topRow = start > 0 || failed;

  const toolResults = useMemo(() => toolResultsOf(entries), [entries]);
  const items = useMemo(() => transcriptItems(entries, start, toolResults.called), [entries, start, toolResults]);
  const [textSize] = useChatTextSize();

  const touchScrolling = (): boolean => {
    const s = scrolling.current;
    return s.touch && (s.touching || Date.now() - s.at < SCROLL_IDLE_MS);
  };

  /**
   * Remembers the first rows that reach the screen and where they are. Several are kept: the rows at the top of what
   * was loaded can change when older entries come (tool calls joining an older group, a result joining its call).
   */
  const recordAnchor = (): void => {
    const el = scroller.current;
    const box = rowsBox.current;
    if (!el || !box) return;
    const rows = box.querySelectorAll<HTMLElement>(":scope > [data-row]");
    const viewTop = el.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows.item(mid).getBoundingClientRect().bottom <= viewTop) lo = mid + 1;
      else hi = mid;
    }
    const base = viewTop - el.scrollTop;
    const kept: Anchor[] = [];
    for (let i = lo; i < Math.min(rows.length, lo + 6); i++) {
      const node = rows.item(i);
      kept.push({ node, top: node.getBoundingClientRect().top - base });
    }
    anchors.current = kept;
  };

  /** Moves the conversation so that the first remembered row that is still there is back where it was on screen. */
  const keepAnchor = (el: HTMLElement): void => {
    const a = anchors.current.find((x) => x.node.isConnected);
    if (!a) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    el.scrollTop += a.node.getBoundingClientRect().top - base - a.top;
  };

  /** Asks for older entries once the reader is near the top of what is loaded, one page at a time. */
  const loadOlderIfNear = (): void => {
    const el = scroller.current;
    if (!el || !state || state.start === 0 || state.loading || state.error || holdFrom !== undefined) return;
    if (el.scrollTop > el.clientHeight * PREFETCH_SCREENS) return;
    const first = all[0]?.uuid;
    if (first && touchScrolling()) setHoldFrom(first);
    onLoadOlder();
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const p = prev.current;
    const first = entries[0]?.uuid;
    const changedAbove = first !== p.first || topRow !== p.topRow;
    if (p.count === 0 && entries.length > 0) {
      el.scrollTop = el.scrollHeight; // first load
    } else if (atBottom.current) {
      if (changedAbove || entries.length !== p.count) el.scrollTop = el.scrollHeight; // stay at the newest entry
    } else if (changedAbove) {
      keepAnchor(el); // older entries were put above what is on screen
    }
    prev.current = { first, count: entries.length, topRow };
    if (!atBottom.current) recordAnchor();
  }, [entries, topRow]);

  // Keep reading older pages while the loaded part does not reach far enough above the screen (a short page, a fast
  // scroll), and once a held page is on screen.
  useEffect(() => {
    loadOlderIfNear();
  }, [state?.start, loading, state?.error, holdFrom, entries]);

  // A held page goes on screen once it has come and the touch scroll has stopped.
  useEffect(() => {
    if (holdFrom === undefined) return;
    const timer = setInterval(() => {
      if (!loadingNow.current && !touchScrolling()) setHoldFrom(undefined);
    }, 100);
    return () => clearInterval(timer);
  }, [holdFrom]);

  useEffect(() => () => cancelAnimationFrame(anchorFrame.current), []);

  // A message just sent from here: show it, wherever the conversation was scrolled to.
  const pendingCount = pending?.length ?? 0;
  const prevPending = useRef(pendingCount);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pendingCount > prevPending.current) el.scrollTop = el.scrollHeight;
    prevPending.current = pendingCount;
  }, [pendingCount]);

  // The chat box grows with its text and status line, and what comes at the end of the conversation comes and goes.
  // While at the bottom, keep the newest entry, and what comes after it, above the chat box.
  const hasFooter = footer !== undefined;
  const hasEnd = end !== undefined;
  useEffect(() => {
    const el = scroller.current;
    const boxes = [footerBox.current, endBox.current].filter((box) => box !== null);
    if (!el || boxes.length === 0) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    for (const box of boxes) observer.observe(box);
    return () => observer.disconnect();
  }, [hasFooter, hasEnd]);

  return (
    <div
      ref={scroller}
      className="h-full overflow-y-auto"
      // The rows on screen are kept in place here (keepAnchor); the browser's own anchoring would move them twice.
      style={{ overflowAnchor: "none" }}
      onScroll={(e) => {
        const el = e.currentTarget;
        scrolling.current.at = Date.now();
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        setFollowing(atBottom.current);
        if (!atBottom.current && !anchorFrame.current) {
          anchorFrame.current = requestAnimationFrame(() => {
            anchorFrame.current = 0;
            recordAnchor();
          });
        }
        loadOlderIfNear();
      }}
      onTouchStart={() => {
        scrolling.current.touch = true;
        scrolling.current.touching = true;
      }}
      onTouchEnd={() => {
        scrolling.current.touching = false;
        scrolling.current.at = Date.now();
      }}
      onTouchCancel={() => {
        scrolling.current.touching = false;
        scrolling.current.at = Date.now();
      }}
      onWheel={() => {
        scrolling.current.touch = false;
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") scrolling.current.touch = false;
      }}
    >
      <div className="flex min-h-full flex-col">
        <div
          ref={rowsBox}
          className="chat-text mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pt-4 pb-12 md:px-6"
          style={chatTextStyle(textSize)}
        >
          {topRow && (
            // Always the same height, so that what is on screen does not move when it changes.
            <div className="flex h-6 shrink-0 items-center justify-center gap-2 text-xs text-muted-foreground">
              {failed ? (
                <>
                  <span className="min-w-0 truncate text-red-400">会話を読み込めませんでした：{state?.error}</span>
                  {start > 0 && (
                    <button
                      type="button"
                      onClick={onLoadOlder}
                      className="shrink-0 rounded-full border border-border px-2.5 py-0.5 hover:text-foreground"
                    >
                      もう一度
                    </button>
                  )}
                </>
              ) : loading || held > 0 ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  前の会話を読み込んでいます…
                </>
              ) : null}
            </div>
          )}
          {state?.error && all.length === 0 && <p className="text-center text-sm text-red-400">会話を読み込めませんでした：{state.error}</p>}
          {!state || (state.loading && entries.length === 0) ? (
            <p className="text-center text-sm text-muted-foreground">読み込み中…</p>
          ) : entries.length === 0 && !state.error ? (
            pendingCount === 0 && <p className="text-center text-sm text-muted-foreground">まだ会話がありません</p>
          ) : (
            <ToolResults.Provider value={toolResults}>
              <Rows items={items} />
            </ToolResults.Provider>
          )}
          {pending?.map((p) => (
            <PendingView key={p.id} message={p} />
          ))}
          {hasEnd && (
            <div ref={endBox} className="flex flex-col gap-4 empty:hidden">
              {end}
            </div>
          )}
        </div>
        {hasFooter && (
          <div
            ref={footerBox}
            className="sticky bottom-0 z-10 px-4 md:px-6"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            {/* The conversation behind the chat box: blurred and darkened, fading in from above. The bottom
                padding of the list keeps the newest entry clear of it when scrolled to the end. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-b from-transparent to-background/85 backdrop-blur-md"
              style={{ maskImage: BLUR_MASK, WebkitMaskImage: BLUR_MASK }}
            />
            <div className="relative mx-auto max-w-3xl">
              <AnimatePresence>
                {!following && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-full mb-3 flex justify-center">
                    <motion.button
                      type="button"
                      aria-label="最新の発言へ"
                      title="最新の発言へ"
                      onClick={() => {
                        const el = scroller.current;
                        el?.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
                      }}
                      initial={{ opacity: 0, scale: 0.8, y: 6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.8, y: 6 }}
                      transition={{ duration: 0.16 }}
                      className="pointer-events-auto grid size-10 place-items-center rounded-full bg-neutral-800/70 text-neutral-100 shadow-lg ring-1 ring-white/15 backdrop-blur-xl hover:bg-neutral-700/80"
                    >
                      <ArrowDown className="size-5" />
                    </motion.button>
                  </div>
                )}
              </AnimatePresence>
              {footer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

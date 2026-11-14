// Conversation view. Keeps the scroll position when older pages are prepended and follows new entries
// only while the reader is at the bottom. The footer (the chat box) floats over the bottom of the
// conversation: it stays at the bottom of the screen, and the conversation scrolls behind it, blurred.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ArrowDown, ChevronRight, Image as ImageIcon, Paperclip, Wrench } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { MarkdownText } from "@/components/markdown";
import { clockTime } from "@/lib/format";
import type { PendingMessage } from "@/lib/pending";
import type { TranscriptState } from "@/lib/store";
import { transcriptItems, type ToolUse } from "@/lib/transcript-items";
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

/**
 * The results of the tool calls in the loaded part of the conversation, by the id of the call. A result is shown
 * inside its call's fold; one whose call is not loaded (an older page) is shown on its own.
 */
const ToolResults = createContext<{ of: (id: string | undefined) => ToolResult | undefined; called: (id: string | undefined) => boolean }>({
  of: () => undefined,
  called: () => false,
});

const FOLD_BOX = "rounded-lg border border-border/60 bg-surface/60 text-xs";
const FOLD_SUMMARY =
  "flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden";

/**
 * A fold of the conversation (a tool call), closed by default. Its parts are labelled, each scrolls on its own.
 * A nested fold is a row of a group of folds (see CommandsFold), indented under the group's icon.
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
          <div className={cn("px-3 pt-2 text-[10.5px] text-muted-foreground", p.tone === "error" && "text-red-400")}>{p.label}</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pt-1 pb-2 font-mono text-[11px] leading-relaxed text-foreground/80">
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

/** A tool call and, once it has come, its result, in one fold. In a group, the group shows the tool's name. */
function ToolFold({ block, nested = false }: { block: ToolUse; nested?: boolean }) {
  const result = useContext(ToolResults).of(block.id);
  return (
    <Fold
      nested={nested}
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {!nested && (
            <>
              <Wrench className={cn("size-3.5 shrink-0", result?.isError && "text-red-400")} />
              <span className="shrink-0 font-mono font-medium text-foreground/90">{block.name}</span>
            </>
          )}
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
 * Bash calls that came in a row, in one fold: how many, the latest command (the one running, while the agent works)
 * and how many failed. Opened, it lists the calls, each in a fold of its own. The group is named so that its open
 * state does not reach the folds inside it, which use the plain group.
 */
function CommandsFold({ calls }: { calls: ToolUse[] }) {
  const results = useContext(ToolResults);
  const errors = calls.filter((c) => results.of(c.id)?.isError).length;
  const latest = calls.at(-1);
  return (
    <details className={cn("group/commands", FOLD_BOX)}>
      <summary className={FOLD_SUMMARY}>
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/commands:rotate-90" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Wrench className={cn("size-3.5 shrink-0", errors > 0 && "text-red-400")} />
          <span className="shrink-0 font-mono font-medium text-foreground/90">{latest?.name}</span>
          <span className="shrink-0 tabular-nums">{calls.length} 回</span>
          {latest && (
            <span className="truncate font-mono group-open/commands:hidden">{latest.summary ?? toolSummary(latest.input)}</span>
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
          {time && <div className="text-right text-[10px] text-muted-foreground">{time}</div>}
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
  return <div className="text-[10px] uppercase tracking-wide text-muted-foreground">サブエージェント</div>;
}

/**
 * A message sent from here that the conversation does not show yet (see lib/pending), in the place and look of the
 * user's own entries, with how far it has got instead of the time.
 */
function PendingView({ message: p }: { message: PendingMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2.5 text-sm">
        {p.text && <p className="whitespace-pre-wrap break-words leading-relaxed">{p.text}</p>}
        {p.files.map((name, i) => (
          <FileChip key={i} name={name} />
        ))}
        <div className="text-right text-[10px] text-muted-foreground">
          {p.state === "queued" ? "送信待ち（作業が終わったら送ります）" : "送信中…"}
        </div>
      </div>
    </div>
  );
}

/**
 * `pending`: messages sent from here that the conversation does not show yet; they come after its entries. `end`: what
 * comes after them (the plugins' parts at the end of the conversation, P13); it takes no room while it shows nothing.
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
  const footerBox = useRef<HTMLDivElement>(null);
  const endBox = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [following, setFollowing] = useState(true);
  const prev = useRef<{ first?: string; count: number; height: number }>({ count: 0, height: 0 });
  const atBottom = useRef(true);
  const entries = state?.entries ?? [];
  const toolResults = useMemo(() => {
    const calls = new Set<string>();
    const results = new Map<string, ToolResult>();
    for (const e of entries) {
      for (const b of e.blocks) {
        if (b.type === "tool_use" && b.id) calls.add(b.id);
        else if (b.type === "tool_result" && b.toolUseId) results.set(b.toolUseId, b);
      }
    }
    return {
      of: (id: string | undefined) => (id ? results.get(id) : undefined),
      called: (id: string | undefined) => Boolean(id && calls.has(id)),
    };
  }, [entries]);
  const start = state?.start ?? 0;
  const items = useMemo(() => transcriptItems(entries, start, toolResults.called), [entries, start, toolResults]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = entries[0]?.uuid;
    const p = prev.current;
    if (p.count === 0 && entries.length > 0) {
      el.scrollTop = el.scrollHeight; // first load
    } else if (first !== p.first && entries.length > p.count) {
      el.scrollTop += el.scrollHeight - p.height; // older page prepended
    } else if (entries.length > p.count && atBottom.current) {
      el.scrollTop = el.scrollHeight; // live append
    }
    prev.current = { first, count: entries.length, height: el.scrollHeight };
  }, [entries]);

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
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        setFollowing(atBottom.current);
      }}
    >
      <div className="flex min-h-full flex-col">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pt-4 pb-12 md:px-6">
          {state && state.start > 0 && (
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={state.loading}
              className="self-center rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {state.loading ? "読み込み中…" : `前の会話を読み込む（残り ${state.start} 件）`}
            </button>
          )}
          {state?.error && <p className="text-center text-sm text-red-400">会話を読み込めませんでした：{state.error}</p>}
          {!state || (state.loading && entries.length === 0) ? (
            <p className="text-center text-sm text-muted-foreground">読み込み中…</p>
          ) : entries.length === 0 && !state.error ? (
            pendingCount === 0 && <p className="text-center text-sm text-muted-foreground">まだ会話がありません</p>
          ) : (
            <ToolResults.Provider value={toolResults}>
              {items.map((item) =>
                item.kind === "entry" ? (
                  <EntryView key={item.key} entry={item.entry} />
                ) : (
                  <div key={item.key} className="space-y-2 text-sm">
                    {item.isSidechain && <SidechainLabel />}
                    <CommandsFold calls={item.calls} />
                  </div>
                ),
              )}
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

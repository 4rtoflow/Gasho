// Read-only conversation view. Keeps the scroll position when older pages are prepended
// and follows new entries only while the reader is at the bottom.
import { AlertTriangle, ChevronRight, Image as ImageIcon, Wrench } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { clockTime } from "@/lib/format";
import type { TranscriptState } from "@/lib/store";
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

function Fold({ summary, children, tone }: { summary: React.ReactNode; children: React.ReactNode; tone?: "error" }) {
  return (
    <details className="group rounded-lg border border-border/60 bg-surface/60 text-xs">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden",
          tone === "error" && "text-red-400 hover:text-red-300",
        )}
      >
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
        {children}
      </pre>
    </details>
  );
}

function BlockView({ block }: { block: TranscriptBlock }) {
  switch (block.type) {
    case "text":
      return <p className="whitespace-pre-wrap break-words leading-relaxed">{block.text}</p>;
    case "tool_use":
      return (
        <Fold
          summary={
            <span className="flex min-w-0 items-center gap-2">
              <Wrench className="size-3.5 shrink-0" />
              <span className="shrink-0 font-mono font-medium text-foreground/90">{block.name}</span>
              <span className="truncate font-mono">{block.summary ?? toolSummary(block.input)}</span>
            </span>
          }
        >
          {pretty(block.input)}
        </Fold>
      );
    case "tool_result":
      return (
        <Fold
          tone={block.isError ? "error" : undefined}
          summary={
            <span>
              {block.isError ? "エラー" : "結果"}（{block.content.length.toLocaleString()} 文字）
            </span>
          }
        >
          {block.content || "（出力なし）"}
        </Fold>
      );
    case "image":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5" />
          画像
        </span>
      );
  }
}

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
      {entry.isSidechain && <div className="text-[10px] uppercase tracking-wide text-muted-foreground">サブエージェント</div>}
      {entry.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

export function Transcript({ state, onLoadOlder }: { state: TranscriptState | undefined; onLoadOlder: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const prev = useRef<{ first?: string; count: number; height: number }>({ count: 0, height: 0 });
  const atBottom = useRef(true);
  const entries = state?.entries ?? [];

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

  return (
    <div
      ref={scroller}
      className="h-full overflow-y-auto px-4 py-4 md:px-6"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
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
          <p className="text-center text-sm text-muted-foreground">まだ会話がありません</p>
        ) : (
          entries.map((e, i) => <EntryView key={e.uuid || `i${state.start + i}`} entry={e} />)
        )}
      </div>
    </div>
  );
}

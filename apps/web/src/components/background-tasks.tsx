// Work that Claude Code runs in the background for a session (SessionInfo.background): shells, monitors, subagents
// and workflows that Claude started, which run on after its turn has ended. Shown above the chat box, each with a
// button that stops it the way Claude Code's own list of background tasks does (session.stopTask); Claude is then told
// that the person stopped it.
import { Bot, LoaderCircle, Radio, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { BackgroundTask, BackgroundTaskKind, MachineInfo, SessionInfo } from "@gasho/protocol";
import { elapsedTime } from "@/lib/format";
import { sendCommand } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const KIND: Record<BackgroundTaskKind, { label: string; icon: LucideIcon }> = {
  shell: { label: "シェル", icon: SquareTerminal },
  monitor: { label: "監視", icon: Radio },
  agent: { label: "サブエージェント", icon: Bot },
  workflow: { label: "ワークフロー", icon: Workflow },
};

/** A little longer than the Gasho server waits for the working server (each task is stopped in turn, on the screen). */
const STOP_WAIT_MS = 70_000;
const BUTTON = "shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-50";

export function BackgroundTasks({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  const tasks = session.background ?? [];
  const now = useNow(10_000);
  // Which stop is on its way: a task's id, or "all".
  const [stopping, setStopping] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  if (tasks.length === 0) return null;

  const stop = async (task?: BackgroundTask) => {
    setStopping(task?.id ?? "all");
    setMessage(undefined);
    try {
      const r = await sendCommand(
        machine.id,
        { type: "session.stopTask", sessionId: session.sessionId, ...(task ? { taskId: task.id } : {}) },
        STOP_WAIT_MS,
      );
      if (!r.ok) setMessage({ text: r.error ?? "止められませんでした。", error: true });
      else if (r.warning) setMessage({ text: r.warning, error: false });
    } finally {
      setStopping(undefined);
    }
  };
  const disabled = !machine.connected || stopping !== undefined;

  return (
    <section
      aria-label="バックグラウンドで実行中"
      className="mb-2 rounded-xl border border-sky-500/30 bg-neutral-900/90 text-sm shadow-lg backdrop-blur-xl"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-sky-400 motion-reduce:animate-none" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-sky-300">バックグラウンドで実行中（{tasks.length}）</span>
        {tasks.length > 1 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void stop()}
            title="バックグラウンドで動いているものを、すべて止めます"
            className={cn(BUTTON, "text-red-400 hover:bg-red-500/10")}
          >
            {stopping === "all" ? "止めています…" : "すべて止める"}
          </button>
        )}
      </div>
      <ul className="max-h-40 overflow-y-auto px-1 pb-1.5">
        {tasks.map((t) => {
          const { label, icon: Icon } = KIND[t.kind] ?? KIND.shell;
          const detail = [label, t.startedAt ? `${elapsedTime(t.startedAt, now)}前から` : undefined, t.command && t.command !== t.title ? t.command : undefined]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={label} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground" title={t.title}>
                  {t.title}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={t.command ?? detail}>
                  {detail}
                </div>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void stop(t)}
                title="Claude Code のタスクの一覧で止めます。止めたことは Claude に伝わります"
                className={cn(BUTTON, "bg-white/[0.08] text-foreground hover:bg-red-500/15 hover:text-red-300")}
              >
                {stopping === t.id ? "止めています…" : "止める"}
              </button>
            </li>
          );
        })}
      </ul>
      {message && <p className={cn("px-3 pb-2 text-xs", message.error ? "text-red-400" : "text-amber-400")}>{message.text}</p>}
    </section>
  );
}

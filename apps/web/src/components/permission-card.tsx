// The permission requests a session is waiting on (Claude Code's PermissionRequest hook), answered from here. Claude
// Code shows its own dialog meanwhile; a request answered there leaves this list on its own.
// Claude's questions (AskUserQuestion) and a plan to approve (ExitPlanMode) have cards of their own: Claude Code takes
// them only with the answers, or the plan, so that "allow" alone would leave its dialog open.
import { ChevronRight, ClipboardList, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { AskedQuestion, MachineInfo, PermissionRequestInfo, QuestionAnswer, SessionCommand, SessionInfo } from "@gasho/protocol";
import { MarkdownText } from "@/components/markdown";
import { sendCommand } from "@/lib/store";
import { cn } from "@/lib/utils";

export function PermissionRequests({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  const requests = session.permissionRequests ?? [];
  if (requests.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {requests.map((r) =>
        r.questions ? (
          <QuestionCard key={r.id} machine={machine} sessionId={session.sessionId} request={r} questions={r.questions} />
        ) : r.plan !== undefined ? (
          <PlanCard key={r.id} machine={machine} sessionId={session.sessionId} request={r} plan={r.plan} />
        ) : (
          <PermissionCard key={r.id} machine={machine} sessionId={session.sessionId} request={r} />
        ),
      )}
    </div>
  );
}

const CARD = "rounded-xl border bg-neutral-900/90 text-sm shadow-lg backdrop-blur-xl";
const BUTTON = "rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const PRIMARY = cn(BUTTON, "bg-primary text-primary-foreground hover:bg-primary/90");
const SECONDARY = cn(BUTTON, "bg-white/[0.08] text-foreground hover:bg-white/[0.14]");
const QUIET = cn(BUTTON, "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground");
const FIELD =
  "w-full resize-y rounded-lg border border-border bg-black/30 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-border-hover focus:outline-none disabled:opacity-50";

type Answer = Omit<Extract<SessionCommand, { type: "permission.answer" }>, "type" | "sessionId" | "permissionId">;

/**
 * Sends an answer to a request. `sending`: which of the card's answers is on its way (its button says so). `sent`: one
 * was taken, and the card waits to leave (a question answered as a message leaves once its dialog has closed); it can
 * be answered again if it is still there after a while.
 */
function useAnswer(machine: MachineInfo, sessionId: string, permissionId: string) {
  const [sending, setSending] = useState<string>();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 15_000);
    return () => clearTimeout(t);
  }, [sent]);
  const send = async (which: string, answer: Answer) => {
    setSending(which);
    setError(undefined);
    try {
      const res = await sendCommand(machine.id, { type: "permission.answer", sessionId, permissionId, ...answer });
      // Once answered, the request leaves the session's list and this card with it.
      if (res.ok) setSent(true);
      else setError(res.error ?? "答えられませんでした。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(undefined);
    }
  };
  return { sending, sent, error, send, disabled: !machine.connected || sending !== undefined || sent };
}

interface CardProps {
  machine: MachineInfo;
  sessionId: string;
  request: PermissionRequestInfo;
}

function PermissionCard({ machine, sessionId, request: r }: CardProps) {
  const { sending, error, send, disabled } = useAnswer(machine, sessionId, r.id);
  // A question or a plan from a gasho-daemon that cannot pass the answer on: "allow" would spend the request.
  const unanswerable = r.toolName === "AskUserQuestion" || r.toolName === "ExitPlanMode";

  return (
    <div className={cn(CARD, "border-amber-500/40")}>
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-amber-300">{r.toolName === "AskUserQuestion" ? "Claude からの質問" : r.toolName === "ExitPlanMode" ? "計画の承認" : "権限の確認"}</div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono font-medium text-foreground">{r.toolName}</span>
            {r.summary && <span className="truncate font-mono text-xs text-muted-foreground">{r.summary}</span>}
          </div>
        </div>
      </div>
      <details className="group px-3 pt-1">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          入力
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {r.input}
        </pre>
      </details>
      {unanswerable && (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          この working server の gasho-daemon は古いため、Gasho からは答えられません。端末か公式アプリで答えてください。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {!unanswerable && (
          <button type="button" disabled={disabled} onClick={() => void send("allow", { decision: "allow" })} className={PRIMARY}>
            {sending === "allow" ? "送信中…" : "許可"}
          </button>
        )}
        {!unanswerable && r.always && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send("always", { decision: "always" })}
            title={`今後は確認せずに許可します：${r.always}`}
            className={cn(SECONDARY, "max-w-full truncate")}
          >
            {sending === "always" ? "送信中…" : `今後も許可（${r.always}）`}
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => void send("deny", { decision: "deny" })}
          title="Claude は作業を止めて、次の指示を待ちます"
          className={cn(BUTTON, "text-red-400 hover:bg-red-500/10")}
        >
          {sending === "deny" ? "送信中…" : r.toolName === "AskUserQuestion" ? "答えずに止める" : "拒否"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

/** What is chosen for one question: options (their indexes), and whether the answer written below them is. */
interface Choice {
  picked: number[];
  other: boolean;
  text: string;
}

/** The answer to send for a question; undefined while it has none. */
function answerOf(c: Choice): QuestionAnswer | undefined {
  const text = c.other ? c.text.trim() : "";
  if (c.picked.length === 0 && !text) return undefined;
  return { picked: c.picked, ...(text ? { text } : {}) };
}

/** Claude's questions, each with its options and room to answer in one's own words, as in the terminal. */
function QuestionCard({ machine, sessionId, request: r, questions }: CardProps & { questions: AskedQuestion[] }) {
  const { sending, sent, error, send, disabled } = useAnswer(machine, sessionId, r.id);
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => ({ picked: [], other: false, text: "" })));
  const answers = questions.map((_, i) => answerOf(choices[i] ?? { picked: [], other: false, text: "" }));
  const complete = answers.every((a) => a !== undefined);
  const update = (i: number, change: (c: Choice) => Choice) => setChoices((cs) => cs.map((c, j) => (j === i ? change(c) : c)));

  return (
    <div className={cn(CARD, "border-sky-500/40")}>
      <div className="flex items-center gap-2 px-3 pt-2.5 text-xs text-sky-300">
        <MessageCircleQuestion className="size-4 shrink-0 text-sky-400" />
        Claude からの質問
      </div>
      {r.answerAsMessage && (
        <p className="px-3 pt-1 text-xs text-muted-foreground">
          この質問には、Gasho から直接は答えられません。答えると、端末の質問を閉じてから、答えを次の発言として Claude に送ります。
        </p>
      )}
      <div className="max-h-[45vh] space-y-4 overflow-y-auto overscroll-contain px-3 pt-2">
        {questions.map((q, i) => (
          <QuestionField
            key={i}
            question={q}
            choice={choices[i] ?? { picked: [], other: false, text: "" }}
            onChange={(change) => update(i, change)}
            disabled={disabled}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2.5">
        <button
          type="button"
          disabled={disabled || !complete}
          title={complete ? undefined : "すべての質問に答えてください"}
          onClick={() => void send("answer", { decision: "allow", answers: answers.filter((a) => a !== undefined) })}
          className={PRIMARY}
        >
          {sending === "answer" ? "送信中…" : "回答する"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void send("stop", { decision: "deny" })}
          title="質問に答えずに、Claude の作業を止めます。Claude は次の指示を待ちます"
          className={QUIET}
        >
          {sending === "stop" ? "送信中…" : "答えずに止める"}
        </button>
        {sent && <span className="text-xs text-muted-foreground">送りました</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}

function QuestionField({
  question: q,
  choice,
  onChange,
  disabled,
}: {
  question: AskedQuestion;
  choice: Choice;
  onChange: (change: (c: Choice) => Choice) => void;
  disabled: boolean;
}) {
  const name = useId();
  const multi = q.multiSelect === true;
  const type = multi ? "checkbox" : "radio";
  // One option, or the answer written, for a question that takes one; any of them for one that takes several.
  const pick = (k: number) =>
    onChange((c) =>
      multi
        ? { ...c, picked: c.picked.includes(k) ? c.picked.filter((x) => x !== k) : [...c.picked, k].sort((a, b) => a - b) }
        : { ...c, picked: [k], other: false },
    );
  const chooseOther = (on: boolean) => onChange((c) => ({ ...c, other: on, picked: on && !multi ? [] : c.picked }));
  const single = !multi && choice.picked.length === 1 ? choice.picked[0] : undefined;
  const preview = single === undefined ? undefined : q.options[single]?.preview;

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="w-full">
        {q.header && <span className="mb-1 inline-block rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-300">{q.header}</span>}
        <span className="block whitespace-pre-wrap break-words font-medium text-foreground">{q.question}</span>
        {multi && <span className="mt-0.5 block text-[11px] text-muted-foreground">いくつでも選べます</span>}
      </legend>
      <div className="mt-2 space-y-1.5">
        {q.options.map((o, k) => {
          const on = choice.picked.includes(k);
          return (
            <label
              key={k}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2",
                on ? "border-sky-400/60 bg-sky-500/10" : "border-border hover:border-border-hover",
              )}
            >
              <input type={type} name={name} checked={on} onChange={() => pick(k)} className="mt-0.5 size-4 shrink-0 accent-sky-400" />
              <span className="min-w-0">
                <span className="block break-words text-foreground">{o.label}</span>
                {o.description && <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs text-muted-foreground">{o.description}</span>}
              </span>
            </label>
          );
        })}
        <div className={cn("flex items-start gap-2.5 rounded-lg border px-2.5 py-1.5", choice.other ? "border-sky-400/60 bg-sky-500/10" : "border-border")}>
          <input
            type={type}
            name={name}
            checked={choice.other}
            aria-label="その他（自分の言葉で答える）"
            onChange={(e) => chooseOther(multi ? e.currentTarget.checked : true)}
            className="mt-2 size-4 shrink-0 accent-sky-400"
          />
          {/* One line, growing with what is written (where the browser can); writing in it chooses it. */}
          <textarea
            rows={1}
            value={choice.text}
            aria-label={`${q.header ?? q.question}：自分の言葉で答える`}
            placeholder="その他（自分の言葉で答える）"
            onChange={(e) => {
              const text = e.currentTarget.value;
              onChange((c) => ({ ...c, text, ...(text.trim() ? { other: true, picked: multi ? c.picked : [] } : {}) }));
            }}
            className={cn(FIELD, "max-h-40 min-h-8 resize-none [field-sizing:content]")}
          />
        </div>
      </div>
      {preview && (
        <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-black/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">{preview}</pre>
      )}
    </fieldset>
  );
}

/** A plan to approve, with the ways on that the terminal offers. */
function PlanCard({ machine, sessionId, request: r, plan }: CardProps & { plan: string }) {
  const { sending, error, send, disabled } = useAnswer(machine, sessionId, r.id);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className={cn(CARD, "border-violet-500/40")}>
      <div className="flex items-center gap-2 px-3 pt-2.5 text-xs text-violet-300">
        <ClipboardList className="size-4 shrink-0 text-violet-400" />
        計画の承認
      </div>
      <p className="px-3 pt-1 text-xs text-muted-foreground">Claude が計画を立てました。この計画で進めますか？</p>
      <div className="mx-3 mt-2 max-h-[40vh] overflow-y-auto overscroll-contain rounded-lg border border-border bg-black/20 px-3 py-2">
        <MarkdownText text={plan} />
      </div>
      {revising ? (
        <div className="px-3 pt-2.5 pb-2.5">
          <textarea
            rows={3}
            autoFocus
            value={feedback}
            disabled={disabled}
            aria-label="計画の直してほしいところ"
            placeholder="直してほしいところを書いてください。Claude は計画を立て直します"
            onChange={(e) => setFeedback(e.currentTarget.value)}
            className={FIELD}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled || !feedback.trim()}
              onClick={() => void send("revise", { decision: "deny", message: feedback.trim() })}
              className={PRIMARY}
            >
              {sending === "revise" ? "送信中…" : "送る"}
            </button>
            <button type="button" disabled={disabled} onClick={() => setRevising(false)} className={QUIET}>
              戻る
            </button>
            {error && <span className="text-xs text-red-400">{error}</span>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-2.5">
          <button type="button" disabled={disabled} onClick={() => void send("auto", { decision: "allow", mode: "auto" })} className={PRIMARY}>
            {sending === "auto" ? "送信中…" : "はい、auto モードで進める"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send("default", { decision: "allow", mode: "default" })}
            title="ファイルの編集のたびに、権限の確認を出します"
            className={SECONDARY}
          >
            {sending === "default" ? "送信中…" : "はい、編集はその都度承認する"}
          </button>
          <button type="button" disabled={disabled} onClick={() => setRevising(true)} className={SECONDARY}>
            直してほしいところを伝える
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send("stop", { decision: "deny" })}
            title="計画を承認せずに、Claude の作業を止めます。Claude は次の指示を待ちます"
            className={QUIET}
          >
            {sending === "stop" ? "送信中…" : "止める"}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      )}
    </div>
  );
}

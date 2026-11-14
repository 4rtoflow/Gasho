// Settings of this browser: the size of the conversation's text on the session screen, with a sample of a
// conversation to see it by.
import { RotateCcw, Type } from "lucide-react";
import type { TranscriptEntry } from "@gasho/protocol";
import { TranscriptSample } from "@/components/transcript";
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, CHAT_TEXT_MIN, useChatTextSize } from "@/lib/chat-text";
import { PluginSettingsSections } from "@/plugins/parts";

const STEP =
  "grid size-9 shrink-0 place-items-center rounded-lg border border-border hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border";

/** A request, the tools Claude used for it (in one fold, as in a session), and its answer. */
const SAMPLE: TranscriptEntry[] = [
  {
    uuid: "sample-request",
    ts: "2026-11-14T00:41:00.000Z",
    role: "user",
    blocks: [{ type: "text", text: "ログインのボタンが押せないことがある。原因を調べて直して" }],
  },
  {
    uuid: "sample-tools",
    role: "assistant",
    blocks: [
      { type: "tool_use", id: "sample-read", name: "Read", input: JSON.stringify({ file_path: "src/LoginForm.tsx" }) },
      {
        type: "tool_use",
        id: "sample-edit",
        name: "Edit",
        input: JSON.stringify({ file_path: "src/LoginForm.tsx", old_string: "EMAIL.test(email)", new_string: "EMAIL.test(email.trim())" }),
      },
    ],
  },
  {
    uuid: "sample-results",
    role: "user",
    blocks: [
      { type: "tool_result", toolUseId: "sample-read", content: "export function LoginForm() { … }", isError: false },
      { type: "tool_result", toolUseId: "sample-edit", content: "The file src/LoginForm.tsx has been updated successfully.", isError: false },
    ],
  },
  {
    uuid: "sample-answer",
    role: "assistant",
    blocks: [
      {
        type: "text",
        text: [
          "原因は、ボタンを押せなくする条件でした。メールアドレスの前後に**空白**が入っていると、形式が正しくないと判定されていました。",
          "",
          "```ts",
          "const valid = EMAIL.test(email.trim());",
          "```",
          "",
          "- 前後の空白を除いてから判定するように直しました",
          "- `LoginForm` のテストを1件足しました",
        ].join("\n"),
      },
    ],
  },
];

export function SettingsView() {
  const [size, setSize] = useChatTextSize();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">設定</h1>
        <p className="text-sm text-muted-foreground">このブラウザで使う設定です。スマホと PC で別々に決められます。</p>
      </div>

      <section aria-labelledby="chat-text-size" className="space-y-4 rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h2 id="chat-text-size" className="flex items-center gap-2 text-sm font-medium">
              <Type className="size-4" />
              会話の文字の大きさ
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">セッション画面の会話の文字です。入力欄の文字は変わりません。</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="tabular-nums">
              {size}px{size === CHAT_TEXT_DEFAULT && <span className="text-muted-foreground">（標準）</span>}
            </span>
            {size !== CHAT_TEXT_DEFAULT && (
              <button
                type="button"
                onClick={() => setSize(CHAT_TEXT_DEFAULT)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover"
              >
                <RotateCcw className="size-3.5" />
                標準に戻す
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" aria-label="小さくする" title="小さくする" disabled={size <= CHAT_TEXT_MIN} onClick={() => setSize(size - 1)} className={STEP}>
            <span aria-hidden className="text-xs font-medium">
              A
            </span>
          </button>
          <input
            type="range"
            min={CHAT_TEXT_MIN}
            max={CHAT_TEXT_MAX}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.currentTarget.value))}
            aria-labelledby="chat-text-size"
            aria-valuetext={`${size}px`}
            className="h-6 min-w-0 flex-1 cursor-pointer accent-foreground"
          />
          <button type="button" aria-label="大きくする" title="大きくする" disabled={size >= CHAT_TEXT_MAX} onClick={() => setSize(size + 1)} className={STEP}>
            <span aria-hidden className="text-lg font-medium">
              A
            </span>
          </button>
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-background p-4">
          <p className="text-xs text-muted-foreground">見本</p>
          <TranscriptSample entries={SAMPLE} textSize={size} />
        </div>
      </section>

      {/* The settings of the enabled plugins (docs/plugins.md, P5). */}
      <PluginSettingsSections />
    </div>
  );
}

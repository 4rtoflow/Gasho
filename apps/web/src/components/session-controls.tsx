// Effort and ultracode for a session started from Gasho, next to the model picker of the chat box (PromptInput's
// `actions`). What is picked here is switched (for this session only) when the next message is sent.
import { Check, ChevronDown, Gauge, Workflow } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useRef, useState } from "react";
import type { EffortLevel } from "@gasho/protocol";
import { cn } from "@/lib/utils";

/** Claude Code's effort levels, lowest first, with its own names. */
export const EFFORTS: { id: EffortLevel; name: string; description: string }[] = [
  { id: "low", name: "Low", description: "速さを優先する" },
  { id: "medium", name: "Medium", description: "標準" },
  { id: "high", name: "High", description: "じっくり考える" },
  { id: "xhigh", name: "xHigh", description: "さらにじっくり考える" },
  { id: "max", name: "Max", description: "いちばんじっくり考える" },
];

// The same look as the model picker button of EasyUI's PromptInput (a little narrower on a phone).
const BUTTON =
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2 text-[13px] sm:px-2.5 font-medium text-neutral-500 transition-[color,background-color] duration-150 [-webkit-tap-highlight-color:transparent] outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40 sm:h-9 [@media(hover:hover)]:hover:bg-white/[0.07] [@media(hover:hover)]:hover:text-neutral-100";

/** A dot on a control whose choice differs from what the session uses now: it is switched when sending. */
function PendingDot() {
  return <span aria-hidden className="absolute top-1.5 right-1 size-1.5 rounded-full bg-amber-400" />;
}

/** The effort level, picked from a menu of radio items (one of five). */
export function EffortPicker({
  value,
  current,
  onChange,
  disabled,
}: {
  value: EffortLevel | undefined;
  current: EffortLevel | undefined;
  onChange: (effort: EffortLevel) => void;
  disabled?: boolean;
}) {
  const selected = EFFORTS.find((e) => e.id === value);
  const pending = value !== undefined && value !== current;
  const titleId = useId();
  const [open, setOpen] = useState(false);
  // A touch opens the menu on a tap, not when the finger lands: swiping the toolbar sideways must only scroll it.
  const touch = useRef(false);
  return (
    // Not modal: a modal menu would lock the page's scrolling under the floating chat box.
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          onPointerDown={(e) => {
            touch.current = e.pointerType !== "mouse";
            // Keeps Radix from opening the menu now.
            if (touch.current) e.preventDefault();
          }}
          onClick={() => {
            if (touch.current) setOpen((o) => !o);
            touch.current = false;
          }}
          aria-label={`Effort：${selected?.name ?? "不明"}${pending ? "（送るときに切り替えます）" : ""}`}
          title={pending ? "送るときに切り替えます" : "Effort"}
          className={cn(BUTTON, "data-[state=open]:bg-white/[0.07] data-[state=open]:text-neutral-100")}
        >
          <Gauge className="size-4 shrink-0" />
          <span>{selected?.name ?? "Effort"}</span>
          {/* On a phone the toolbar is short of room; the button still opens the menu. */}
          <ChevronDown className="hidden size-3.5 shrink-0 sm:block" />
          {pending && <PendingDot />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Named by its title (Radix would name it after the button).
          aria-labelledby={titleId}
          className="z-[100] w-60 rounded-2xl bg-popover p-1.5 text-sm shadow-xl ring-1 ring-white/[0.1]"
        >
          <DropdownMenu.Label id={titleId} className="px-2.5 pt-1 pb-1.5 text-xs text-neutral-500">
            Effort
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as EffortLevel)}>
            {EFFORTS.map((e) => (
              <DropdownMenu.RadioItem
                key={e.id}
                value={e.id}
                className="flex w-full cursor-default items-center gap-2 rounded-xl px-2.5 py-2 text-left outline-none select-none data-[highlighted]:bg-white/[0.06]"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-neutral-100">{e.name}</span>
                    {e.id === current && (
                      <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10.5px] text-neutral-400">いま</span>
                    )}
                  </span>
                  <span className="block text-[12px] text-neutral-500">{e.description}</span>
                </span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 shrink-0 text-neutral-100" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function UltracodeToggle({
  value,
  current,
  onChange,
  disabled,
}: {
  value: boolean;
  current: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const pending = value !== current;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="Ultracode"
      aria-pressed={value}
      title={`${value ? "Ultracode：オン" : "Ultracode：オフ"}${pending ? "（送るときに切り替えます）" : ""}。オンにすると、どの作業も複数のエージェントで進めます（このセッションだけ）`}
      onClick={() => onChange(!value)}
      className={cn(BUTTON, value && "bg-violet-500/15 text-violet-200 [@media(hover:hover)]:hover:bg-violet-500/20 [@media(hover:hover)]:hover:text-violet-100")}
    >
      <Workflow className="size-4 shrink-0" />
      <span className="hidden sm:inline">Ultracode</span>
      {pending && <PendingDot />}
    </button>
  );
}

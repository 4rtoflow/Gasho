// The look of Gasho's dialogs (Radix Dialog and AlertDialog): a dimmed backdrop and a centred panel that scrolls when
// it is taller than the screen (a phone with its keyboard open), with the buttons below.
import { cn } from "@/lib/utils";

export const DIALOG_OVERLAY =
  "fixed inset-0 z-[90] bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0";
export const DIALOG_PANEL =
  "fixed top-1/2 left-1/2 z-[91] max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

const BUTTON =
  "inline-flex h-9 items-center justify-center rounded-lg px-3.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";
export const BUTTON_SECONDARY = cn(BUTTON, "border border-border text-foreground hover:bg-surface-raised");
export const BUTTON_PRIMARY = cn(BUTTON, "bg-primary text-primary-foreground hover:opacity-90");
export const BUTTON_DANGER = cn(BUTTON, "bg-red-600 text-white hover:bg-red-500");

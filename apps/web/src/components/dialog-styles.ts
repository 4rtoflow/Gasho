// The look of Gasho's dialogs (Radix Dialog and AlertDialog): a dimmed backdrop and a centred panel that scrolls when
// it is taller than the screen (a phone with its keyboard open), with the buttons below. Also the look of its menus
// (Radix ContextMenu and DropdownMenu).
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

export const MENU =
  "z-[100] min-w-52 max-w-[min(18rem,calc(100vw-24px))] rounded-xl border border-border bg-surface p-1.5 text-sm shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";
export const MENU_ITEM =
  "flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 outline-none select-none data-[highlighted]:bg-surface-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:size-4 [&>svg]:shrink-0";

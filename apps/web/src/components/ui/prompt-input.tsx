"use client";
// From easyui.site (PromptInput). Changed for Gasho: user-visible strings are in Japanese, the line under the box
// can be laid out like EasyUI's preview (`showCount`: keyboard hint on the left, character count on the right), and
// what is typed can be kept outside the component (`draft`), so it is still there when the box is shown again. With
// `shell`, a text that starts with "!" is shown as a shell command (Claude Code's shell mode).

import {
  forwardRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { emptyShellInput, isShellInput } from "@/lib/shell";

/* -------------------------------------------------------------------------- */
/*  PromptInput — the chat composer. Pairs with <AIResponse /> to finish the   */
/*  loop: type → send → stream → stop.                                         */
/*                                                                             */
/*  • Auto-growing textarea that glides open and glides shut after sending     */
/*  • Send button morphs into a Stop button while the reply streams            */
/*  • Attachments: button, drag & drop, paste · chips with previews + limits   */
/*  • Model picker (accessible listbox, flips up/down, typeahead)              */
/*  • Enter / ⇧Enter / ⌘↵ / Esc-to-stop · ↑ recalls your last prompts          */
/*  • IME-safe, iOS-zoom-safe, safe-area aware, light + dark                   */
/*                                                                             */
/*  One file · deps: react 19, framer-motion, tailwindcss.                     */
/* -------------------------------------------------------------------------- */

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

export interface PromptModel {
  id: string;
  name: string;
  description?: string;
  /** Small pill, e.g. "Fast" or "Reasoning" */
  badge?: string;
}

export interface PromptAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  /** Object URL for image previews (revoked for you) */
  previewUrl?: string;
}

export interface PromptSubmit {
  text: string;
  files: File[];
  model: PromptModel | null;
}

export interface PromptInputHandle {
  focus: () => void;
  clear: () => void;
  setValue: (value: string) => void;
  attach: (files: File[] | FileList) => void;
}

/** What is in the box (its text and files), and the texts sent from it, newest first (↑ recalls them). */
export interface PromptDraft {
  text: string;
  attachments: PromptAttachment[];
  history: string[];
}

/** Holds a PromptDraft outside the box (see `draft`). */
export interface PromptDraftStore {
  get: () => PromptDraft;
  set: (next: PromptDraft) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPromptDraft(): PromptDraftStore {
  let value: PromptDraft = { text: "", attachments: [], history: [] };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export interface PromptInputProps {
  /**
   * Called when the user sends. Throw / reject to put their message back in the box.
   */
  onSend: (payload: PromptSubmit) => void | Promise<void>;
  /** true while the assistant is replying → the send button becomes Stop */
  streaming?: boolean;
  onStop?: () => void;

  models?: PromptModel[];
  /** Controlled model id */
  model?: string;
  defaultModel?: string;
  onModelChange?: (id: string) => void;

  placeholder?: string;
  maxLength?: number;
  /** Tallest the textarea grows before it scrolls (px, default 224) */
  maxHeight?: number;

  allowAttachments?: boolean;
  maxFiles?: number;
  maxFileSizeMB?: number;
  /** Same format as <input accept>, e.g. "image/*,.pdf" */
  accept?: string;

  disabled?: boolean;
  autoFocus?: boolean;
  /**
   * true: Enter sends, Shift+Enter adds a line · false: Enter adds a line.
   * ⌘/Ctrl+Enter always sends. Default: true on desktop, false on touch devices
   */
  enterToSend?: boolean;
  /** Extra buttons next to the model picker */
  actions?: ReactNode;
  /** Footer line under the box. `false` hides it */
  hint?: ReactNode | false;
  /** Pad the bottom for the iPhone home indicator (use when the composer is pinned to the screen bottom) */
  safeArea?: boolean;
  /**
   * Always show the character count under the box, on the right, with the keyboard hint on the left (as in
   * EasyUI's preview). Without it the count appears next to the send button only near the limit.
   */
  showCount?: boolean;
  /**
   * Where the box keeps its text, files and sent texts (see createPromptDraft). One that outlives the component finds
   * them again when the box is shown anew (after another screen); its files keep their previews meanwhile. A text put
   * back after a failed send also goes there, even when the box has gone. Without one, the box keeps its own.
   */
  draft?: PromptDraftStore;
  /**
   * Claude Code's shell mode: a text that starts with "!" is a shell command, run where the session runs. The box shows
   * it as one (a "シェル" mark, a fixed-width font, an amber frame), the send button runs it, and it cannot carry files.
   */
  shell?: boolean;
  className?: string;
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

const DEFAULT_MODELS: PromptModel[] = [
  { id: "fast", name: "Fast", description: "Quick answers for everyday questions", badge: "Fast" },
  { id: "balanced", name: "Balanced", description: "Great quality at a good speed" },
  { id: "reasoning", name: "Reasoning", description: "Thinks longer for hard problems", badge: "Deep" },
];

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function matchesAccept(file: { name: string; type: string }, accept?: string) {
  if (!accept) return true;
  const rules = accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return rules.some((r) => (r.startsWith(".") ? name.endsWith(r) : r.endsWith("/*") ? type.startsWith(r.slice(0, -1)) : type === r));
}

type Kind = "image" | "pdf" | "code" | "data" | "archive" | "file";
function kindOf(f: { name: string; type: string }): Kind {
  const n = f.name.toLowerCase();
  if (f.type.startsWith("image/")) return "image";
  if (f.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (/\.(zip|tar|gz|rar|7z)$/.test(n)) return "archive";
  if (/\.(csv|xlsx?|json|tsv)$/.test(n)) return "data";
  if (/\.(tsx?|jsx?|py|rb|go|rs|java|c|cpp|cs|php|sh|html|css|md|txt|yml|yaml|sql)$/.test(n) || f.type.startsWith("text/")) return "code";
  return "file";
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/* ---------------------------------- Icons ---------------------------------- */

function Ico({ d, className = "h-[18px] w-[18px]", sw = 1.8 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const P = {
  clip: "m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9",
  up: "M12 19V5M5.5 11.5 12 5l6.5 6.5",
  chevron: "m6 9 6 6 6-6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5",
  code: "m9 8-4 4 4 4M15 8l4 4-4 4",
  table: "M4 5h16v14H4zM4 10h16M10 5v14",
  archive: "M4 7h16v13H4zM3 4h18v3H3zM10 11h4",
  pdf: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M8.5 15h1.8a1.2 1.2 0 0 0 0-2.4H8.5V17",
};
const KIND_ICON: Record<Kind, string> = { image: P.file, pdf: P.pdf, code: P.code, data: P.table, archive: P.archive, file: P.file };

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/70 dark:focus-visible:ring-white/40";
const softBtn =
  "text-neutral-500 transition-[color,background-color,transform] duration-150 active:scale-[0.94] [-webkit-tap-highlight-color:transparent] [@media(hover:hover)]:hover:bg-black/[0.05] [@media(hover:hover)]:hover:text-neutral-900 dark:[@media(hover:hover)]:hover:bg-white/[0.07] dark:[@media(hover:hover)]:hover:text-neutral-100";

/* ========================================================================== */
/*  Model picker                                                              */
/* ========================================================================== */

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: PromptModel[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const reduce = useReducedMotion();
  const uid = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ s: "", t: undefined as ReturnType<typeof setTimeout> | undefined });
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(true);
  const [pos, setPos] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>({
    left: 0,
    width: 320,
    maxHeight: 360,
    top: 0,
  });
  const selected = Math.max(0, models.findIndex((m) => m.id === value));
  const [active, setActive] = useState(selected);
  const current = models[selected];

  // Keep the portal-rendered list inside the viewport: cap its width, nudge it
  // horizontally when the button is near an edge, and flip/scroll on short screens.
  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(320, vw - margin * 2);
    const left = Math.min(Math.max(margin, r.left), Math.max(margin, vw - width - margin));
    const below = vh - r.bottom - margin * 2;
    const above = r.top - margin * 2;
    const up = !(below >= 300 || below > above);
    setDropUp(up);
    setPos(
      up
        ? { left, width, maxHeight: Math.max(120, Math.min(360, above)), bottom: vh - r.top + margin }
        : { left, width, maxHeight: Math.max(120, Math.min(360, below)), top: r.bottom + margin },
    );
  }, []);

  const show = () => {
    place();
    setActive(selected);
    setOpen(true);
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  };
  const choose = (i: number) => {
    onChange(models[i].id);
    hide();
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onReflow = () => place();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, place]);
  useEffect(() => () => clearTimeout(typed.current.t), []);

  const onListKey = (e: KeyboardEvent) => {
    const n = models.length;
    if (e.key === "ArrowDown") setActive((a) => (a + 1) % n);
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + n) % n);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") hide();
    else if (e.key === "Tab") hide(false);
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // typeahead
      clearTimeout(typed.current.t);
      typed.current.s += e.key.toLowerCase();
      typed.current.t = setTimeout(() => (typed.current.s = ""), 600);
      const hit = models.findIndex((m) => m.name.toLowerCase().startsWith(typed.current.s));
      if (hit >= 0) setActive(hit);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${uid}-list`}
        aria-label={`モデル：${current?.name}（選び直す）`}
        onClick={() => (open ? hide(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
        className={`inline-flex h-10 items-center gap-1.5 rounded-xl pl-3 pr-2 text-[13px] font-medium sm:h-9 ${softBtn} ${focusRing} disabled:pointer-events-none disabled:opacity-40`}
      >
        <span className="max-w-[7rem] truncate sm:max-w-[9.5rem]">{current?.name}</span>
        <Ico d={P.chevron} className={cx("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} sw={2} />
      </button>

      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={listRef}
                id={`${uid}-list`}
                role="listbox"
                tabIndex={-1}
                aria-label="モデル"
                aria-activedescendant={`${uid}-${active}`}
                onKeyDown={onListKey}
                initial={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : dropUp ? 6 : -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: reduce ? 1 : 0.97, transition: { duration: 0.12 } }}
                transition={{ duration: 0.16, ease: EASE_OUT }}
                style={{
                  position: "fixed",
                  left: pos.left,
                  top: pos.top,
                  bottom: pos.bottom,
                  width: pos.width,
                  maxHeight: pos.maxHeight,
                  transformOrigin: dropUp ? "bottom left" : "top left",
                }}
                className="z-[100] overflow-y-auto overscroll-contain rounded-2xl bg-white p-1.5 shadow-xl outline-none ring-1 ring-black/[0.08] dark:bg-[#161617] dark:ring-white/[0.1]"
              >
            {models.map((m, i) => {
              const on = i === selected;
              return (
                <div
                  key={m.id}
                  id={`${uid}-${i}`}
                  role="option"
                  aria-selected={on}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cx(
                    "flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-100",
                    i === active && "bg-black/[0.05] dark:bg-white/[0.07]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-neutral-900 dark:text-neutral-100">{m.name}</span>
                      {m.badge && (
                        <span className="rounded-full bg-black/[0.06] px-1.5 py-px text-[10.5px] font-medium text-neutral-500 dark:bg-white/[0.08]">
                          {m.badge}
                        </span>
                      )}
                    </span>
                    {m.description && <span className="mt-0.5 block text-[12px] leading-snug text-neutral-500">{m.description}</span>}
                  </span>
                  {on && <Ico d={P.check} className="h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-100" sw={2.2} />}
                </div>
              );
            })}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

/* ========================================================================== */
/*  PromptInput                                                               */
/* ========================================================================== */

const TEXT = "text-[16px] leading-6 sm:text-[15px]"; // 16px on phones stops iOS zooming into the field
/** Fades the right end of the toolbar while more tools are scrolled out of view there. */
const TOOLS_FADE = "linear-gradient(to right, black calc(100% - 1.5rem), transparent)";
const PAD_X = "px-3";
const PAD_Y = "py-2";

export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(function PromptInput(
  {
    onSend,
    streaming = false,
    onStop,
    models = DEFAULT_MODELS,
    model,
    defaultModel,
    onModelChange,
    placeholder = "メッセージを入力…",
    maxLength = 8000,
    maxHeight = 224,
    allowAttachments = true,
    maxFiles = 5,
    maxFileSizeMB = 10,
    accept,
    disabled = false,
    autoFocus = false,
    enterToSend,
    actions,
    hint,
    safeArea = false,
    showCount = false,
    draft,
    shell = false,
    className = "",
  },
  ref,
) {
  const reduce = useReducedMotion();
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const errTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The text, files and sent texts live in a store (the caller's `draft`, or the box's own), so that a change made
  // after the box has gone (a text put back after a failed send) still reaches it.
  const [ownDraft] = useState(createPromptDraft);
  const store = draft ?? ownDraft;
  const { text, attachments } = useSyncExternalStore(store.subscribe, store.get, store.get);
  const change = useCallback(
    (patch: (d: PromptDraft) => Partial<PromptDraft>) => {
      const cur = store.get();
      const next = { ...cur, ...patch(cur) };
      if (next.text !== cur.text || next.attachments !== cur.attachments || next.history !== cur.history) store.set(next);
    },
    [store],
  );
  const setText = useCallback(
    (v: string | ((prev: string) => string)) => change((d) => ({ text: typeof v === "function" ? v(d.text) : v })),
    [change],
  );
  const setAttachments = useCallback(
    (v: PromptAttachment[] | ((prev: PromptAttachment[]) => PromptAttachment[])) =>
      change((d) => ({ attachments: typeof v === "function" ? v(d.attachments) : v })),
    [change],
  );
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [modelId, setModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const activeModelId = model ?? modelId;
  const currentModel = models.find((m) => m.id === activeModelId) ?? models[0] ?? null;
  // What is sent is trimmed: " !ls" is a shell command too.
  const shellMode = shell && isShellInput(text.trimStart());

  // Whether tools are hidden past the right end of the toolbar (it scrolls sideways on a phone).
  const toolsRef = useRef<HTMLDivElement>(null);
  const [toolsMore, setToolsMore] = useState(false);
  useEffect(() => {
    const el = toolsRef.current;
    if (!el) return;
    const update = () => setToolsMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
    update();
    const resized = new ResizeObserver(update);
    resized.observe(el);
    const changed = new MutationObserver(update);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      resized.disconnect();
      changed.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  const [finePointer, setFinePointer] = useState(true);
  const [modKey, setModKey] = useState<string | null>(null);
  useEffect(() => {
    setFinePointer(window.matchMedia("(pointer: fine)").matches);
    setModKey(/Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl");
  }, []);
  const enter = enterToSend ?? finePointer;

  /* ------------------------- auto-growing textarea ------------------------- */
  // A hidden mirror measures the wrapped text, and a motion value glides the real
  // textarea to that height (so it opens *and* closes smoothly).
  const h = useMotionValue(40);
  const [atMax, setAtMax] = useState(false);
  const first = useRef(true);
  const measure = useCallback(() => {
    const m = mirrorRef.current;
    if (!m) return;
    const want = clamp(m.offsetHeight, 0, maxHeight);
    setAtMax(m.offsetHeight > maxHeight);
    if (first.current) {
      h.set(want);
      first.current = false;
    } else {
      animate(h, want, reduce ? { duration: 0 } : { type: "spring", duration: 0.34, bounce: 0 });
    }
  }, [h, maxHeight, reduce]);
  useLayoutEffect(measure, [text, measure]);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastW) {
        lastW = el.clientWidth;
        measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /* ------------------------------ attachments ------------------------------ */
  const flashError = useCallback((msg: string) => {
    setError(msg);
    clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(null), 5000);
  }, []);

  const addFiles = useCallback(
    (incoming: File[] | FileList) => {
      if (!allowAttachments || disabled) return;
      const list = Array.from(incoming);
      if (!list.length) return;
      const problems: string[] = [];
      setAttachments((prev) => {
        const next = [...prev];
        for (const f of list) {
          if (!matchesAccept(f, accept)) problems.push(`${f.name}: this file type isn't supported`);
          else if (f.size > maxFileSizeMB * 1024 * 1024) problems.push(`${f.name} is over ${maxFileSizeMB} MB`);
          else if (next.some((a) => a.name === f.name && a.size === f.size && a.file.lastModified === f.lastModified)) continue;
          else if (next.length >= maxFiles) problems.push(`You can attach up to ${maxFiles} files`);
          else {
            next.push({
              id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              file: f,
              name: f.name,
              size: f.size,
              type: f.type,
              previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
            });
          }
        }
        return next;
      });
      if (problems.length) {
        const uniq = Array.from(new Set(problems));
        flashError(uniq[0] + (uniq.length > 1 ? ` (+${uniq.length - 1} more)` : ""));
      }
    },
    [accept, allowAttachments, disabled, flashError, maxFileSizeMB, maxFiles, setAttachments],
  );

  const removeAttachment = (id: string) =>
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });

  const live = useRef(attachments);
  live.current = attachments;
  // Files kept in the caller's draft outlive the box, and keep their previews.
  const ownsDraft = useRef(!draft);
  ownsDraft.current = !draft;
  useEffect(
    () => () => {
      if (ownsDraft.current) live.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      clearTimeout(errTimer.current);
    },
    [],
  );

  /* --------------------------- history (↑ / ↓) ---------------------------- */
  // The sent texts themselves are in the draft (PromptDraft.history).
  const histIdx = useRef(-1);
  const unsent = useRef("");

  /* -------------------------------- sending -------------------------------- */
  // A shell command needs something after its "!".
  const canSend =
    !disabled && (shellMode ? !emptyShellInput(text.trim()) : text.trim().length > 0 || attachments.length > 0) && text.length <= maxLength;

  const submit = useCallback(async () => {
    if (streaming || !canSend) return;
    if (shellMode && attachments.length > 0) {
      flashError("シェルのコマンドには、ファイルを添付できません。添付を外してください。");
      return;
    }
    const payload: PromptSubmit = { text: text.trim(), files: attachments.map((a) => a.file), model: currentModel };
    const snapshot = { text, attachments };
    histIdx.current = -1;
    change((d) => ({
      text: "",
      attachments: [],
      ...(payload.text ? { history: [payload.text, ...d.history.filter((t) => t !== payload.text)].slice(0, 30) } : {}),
    }));
    setError(null);
    try {
      await onSend(payload);
      snapshot.attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    } catch {
      // put everything back so nothing the user typed is lost
      setText((t) => t || snapshot.text);
      setAttachments((a) => (a.length ? a : snapshot.attachments));
      flashError("送れませんでした。入力は欄に戻しました。");
    }
  }, [attachments, canSend, change, currentModel, flashError, onSend, setAttachments, setText, shellMode, streaming, text]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textRef.current?.focus(),
      clear: () => {
        setText("");
        setAttachments([]);
      },
      setValue: (v: string) => setText(v),
      attach: (files) => addFiles(files),
    }),
    [addFiles, setAttachments, setText],
  );
  useEffect(() => {
    if (autoFocus) textRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME composition
    if (e.key === "Escape" && streaming) {
      e.preventDefault();
      onStop?.();
      return;
    }
    if (e.key === "Enter") {
      const mod = e.metaKey || e.ctrlKey;
      if (mod || (enter && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        void submit();
        return;
      }
    }
    const el = e.currentTarget;
    const history = store.get().history;
    if (e.key === "ArrowUp" && history.length && el.selectionStart === 0 && el.selectionEnd === 0 && !e.shiftKey) {
      if (histIdx.current === -1) unsent.current = text;
      const next = Math.min(histIdx.current + 1, history.length - 1);
      if (next !== histIdx.current || text !== history[next]) {
        e.preventDefault();
        histIdx.current = next;
        setText(history[next]);
        requestAnimationFrame(() => el.setSelectionRange(0, 0));
      }
    } else if (e.key === "ArrowDown" && histIdx.current >= 0 && el.selectionStart === el.value.length && !e.shiftKey) {
      e.preventDefault();
      const next = histIdx.current - 1;
      histIdx.current = next;
      setText(next < 0 ? unsent.current : history[next]);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  /* ----------------------------- drag and drop ----------------------------- */
  const dragProps = allowAttachments
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => {
          if (hasFiles(e)) e.preventDefault();
        },
        onDragLeave: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addFiles(e.dataTransfer.files);
        },
      }
    : {};

  /* --------------------------------- render -------------------------------- */
  const nearLimit = text.length > maxLength * 0.85;
  const over = text.length > maxLength;
  const sendWord = shellMode ? "でシェルのコマンドを実行" : "で送信";
  const hintNode =
    hint === false ? null : hint !== undefined ? hint : modKey === null ? null : enter ? (
      <>
        <Kbd>↵</Kbd> {sendWord}
        <span className="ml-2" />
        <Kbd>⇧</Kbd>
        <Kbd>↵</Kbd> で改行
      </>
    ) : (
      <>
        <Kbd>{modKey}</Kbd> <Kbd>↵</Kbd> {sendWord}
      </>
    );

  const sendLabel = streaming ? "停止" : shellMode ? "実行" : "送信";
  const sendReady = streaming || canSend;

  return (
    <div className={cx("relative w-full", className)} style={safeArea ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}>
      {/* soft glow while the assistant is replying */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-1 rounded-[28px] blur-xl"
        style={{ background: "conic-gradient(from 180deg at 50% 50%, #6d7cff55, #34d1bf55, #ffb44c44, #ff6b8b44, #6d7cff55)" }}
        initial={false}
        animate={{ opacity: streaming && !reduce ? [0.35, 0.7, 0.35] : 0 }}
        transition={streaming && !reduce ? { repeat: Infinity, duration: 2.4, ease: "easeInOut" } : { duration: 0.3 }}
      />

      <div
        ref={cardRef}
        {...dragProps}
        className={cx(
          "relative rounded-[24px] bg-white p-2 ring-1 transition-[box-shadow] duration-200 dark:bg-[#0f0f10]",
          shellMode
            ? "ring-amber-500/50 focus-within:ring-amber-500/70 dark:ring-amber-400/40 dark:focus-within:ring-amber-400/60"
            : "ring-black/[0.08] focus-within:ring-black/25 dark:ring-white/[0.09] dark:focus-within:ring-white/25",
          disabled && "opacity-60",
        )}
        style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 18px 40px -24px rgba(0,0,0,0.25)" }}
      >
        {/* attachment chips */}
        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.ul
              key="chips"
              aria-label="添付ファイル"
              className="flex flex-wrap gap-2 overflow-hidden px-1 pb-1"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.35, bounce: 0 }}
            >
              <AnimatePresence initial={false}>
                {attachments.map((a) => {
                  const kind = kindOf(a);
                  return (
                    <motion.li
                      key={a.id}
                      layout={!reduce}
                      initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.14 } }}
                      transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
                      className="group flex h-12 max-w-full items-center gap-2.5 rounded-xl bg-black/[0.04] py-1.5 pl-1.5 pr-1 ring-1 ring-black/[0.05] dark:bg-white/[0.05] dark:ring-white/[0.06]"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white text-neutral-500 dark:bg-white/[0.07]">
                        {a.previewUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                        ) : (
                          <Ico d={KIND_ICON[kind]} className="h-[18px] w-[18px]" />
                        )}
                      </span>
                      <span className="min-w-0 pr-1 leading-tight">
                        <span className="block max-w-[10.5rem] truncate text-[12.5px] font-medium text-neutral-800 dark:text-neutral-200 sm:max-w-[13rem]">{a.name}</span>
                        <span className="block text-[11.5px] text-neutral-500">{formatBytes(a.size)}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => removeAttachment(a.id)}
                        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg sm:h-8 sm:w-8 ${softBtn} ${focusRing}`}
                      >
                        <Ico d={P.x} className="h-3.5 w-3.5" sw={2} />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </motion.ul>
          )}
        </AnimatePresence>

        {/* textarea (with its hidden measuring twin) */}
        <div className="relative overflow-hidden">
          <div
            ref={mirrorRef}
            aria-hidden
            className={cx("pointer-events-none invisible absolute inset-x-0 top-0 whitespace-pre-wrap break-words", PAD_X, PAD_Y, TEXT, shellMode && "font-mono")}
            style={{ overflowWrap: "anywhere" }}
          >
            {text + "\u200b"}
          </div>
          <motion.textarea
            ref={textRef}
            value={text}
            rows={1}
            disabled={disabled}
            maxLength={maxLength + 400}
            placeholder={placeholder}
            aria-label={shellMode ? "シェルのコマンド" : "メッセージ"}
            aria-describedby={`${uid}-hint`}
            enterKeyHint={enter ? "send" : "enter"}
            onChange={(e) => {
              histIdx.current = -1;
              setText(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            style={{ height: h, overflowY: atMax ? "auto" : "hidden" }}
            className={cx(
              "block w-full resize-none bg-transparent text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500",
              PAD_X,
              PAD_Y,
              TEXT,
              shellMode && "font-mono",
            )}
          />
        </div>

        {/* toolbar */}
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* Scrolls sideways when the tools do not fit (a phone): nothing is squeezed or pushed under the send button.
              The right edge fades while more tools are hidden there. */}
          <div
            ref={toolsRef}
            className="scrollbar-none -my-0.5 flex min-w-0 items-center gap-0.5 overflow-x-auto py-0.5"
            style={toolsMore ? { maskImage: TOOLS_FADE, WebkitMaskImage: TOOLS_FADE } : undefined}
          >
            {shellMode && (
              <span
                title="「!」で始まる入力は、Claude Code のシェルモードで、そのままシェルのコマンドとして実行します"
                className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 text-[12.5px] font-medium text-amber-700 dark:text-amber-300"
              >
                <span className="font-mono font-semibold">!</span>
                シェル
              </span>
            )}
            {allowAttachments && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={accept}
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  disabled={disabled || shellMode || attachments.length >= maxFiles}
                  aria-label="ファイルを添付"
                  title={shellMode ? "シェルのコマンドには添付できません" : "ファイルを添付"}
                  onClick={() => fileInput.current?.click()}
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl sm:h-9 sm:w-9 ${softBtn} ${focusRing} disabled:pointer-events-none disabled:opacity-40`}
                >
                  <Ico d={P.clip} />
                </button>
              </>
            )}
            {models.length > 0 && (
              <ModelPicker
                models={models}
                value={activeModelId}
                disabled={disabled}
                onChange={(id) => {
                  setModelId(id);
                  onModelChange?.(id);
                }}
              />
            )}
            {actions}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {nearLimit && !showCount && (
              <span className={cx("text-[11.5px] tabular-nums", over ? "text-rose-500" : "text-neutral-500")} aria-live="polite">
                {text.length}/{maxLength}
              </span>
            )}

            {/* send ⇄ stop */}
            <div className="relative h-10 w-10 shrink-0">
              <motion.svg
                viewBox="0 0 46 46"
                aria-hidden
                className="pointer-events-none absolute -inset-[3px] h-[46px] w-[46px] text-neutral-400"
                initial={false}
                animate={{ opacity: streaming ? 1 : 0, scale: streaming ? 1 : 0.85 }}
                transition={{ duration: 0.2 }}
              >
                <motion.circle
                  cx="23"
                  cy="23"
                  r="21"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray="34 98"
                  style={{ transformOrigin: "center", transformBox: "fill-box" }}
                  animate={streaming && !reduce ? { rotate: 360 } : { rotate: 0 }}
                  transition={streaming && !reduce ? { repeat: Infinity, duration: 1.1, ease: "linear" } : { duration: 0 }}
                />
              </motion.svg>

              <motion.button
                type="button"
                aria-label={sendLabel}
                title={streaming ? "停止（Esc）" : sendLabel}
                disabled={!sendReady}
                onClick={() => (streaming ? onStop?.() : void submit())}
                initial={false}
                animate={{ borderRadius: streaming ? 14 : 20 }}
                whileTap={reduce ? undefined : { scale: 0.92 }}
                transition={{ type: "spring", duration: 0.35, bounce: 0.25 }}
                className={cx(
                  "relative grid h-10 w-10 place-items-center overflow-hidden transition-colors duration-200 [-webkit-tap-highlight-color:transparent]",
                  sendReady
                    ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                    : "bg-black/[0.06] text-neutral-400 dark:bg-white/[0.08] dark:text-neutral-500",
                  focusRing,
                  "disabled:cursor-not-allowed",
                )}
              >
                <motion.span
                  className="absolute"
                  initial={false}
                  animate={{ opacity: streaming ? 0 : 1, scale: streaming ? 0.4 : 1, y: streaming ? 8 : 0 }}
                  transition={{ type: "spring", duration: 0.35, bounce: 0.2 }}
                >
                  <Ico d={P.up} className="h-[18px] w-[18px]" sw={2.2} />
                </motion.span>
                <motion.span
                  className="absolute h-3 w-3 rounded-[3px] bg-current"
                  initial={false}
                  animate={{ opacity: streaming ? 1 : 0, scale: streaming ? 1 : 0.3 }}
                  transition={{ type: "spring", duration: 0.35, bounce: 0.3 }}
                />
              </motion.button>
            </div>
          </div>
        </div>

        {/* drop zone overlay */}
        <AnimatePresence>
          {dragging && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[24px] bg-white/85 ring-2 ring-dashed ring-neutral-400 backdrop-blur-sm dark:bg-black/75 dark:ring-white/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <span className="flex items-center gap-2 text-[13.5px] font-medium text-neutral-700 dark:text-neutral-200">
                <Ico d={P.clip} /> ドロップして添付
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <p id={`${uid}-hint`} className="sr-only">
        {enter ? "Enter で送信、Shift＋Enter で改行。" : "Ctrl（⌘）＋Enter で送信。"}Esc で返答を止めます。
      </p>
      {showCount ? (
        // EasyUI's preview: the hint (or an error) on the left, the character count on the right.
        <div className="flex min-h-[1.5rem] items-center justify-between gap-3 px-3 pt-2 text-[12px] text-neutral-500">
          <p role="alert" aria-live="polite" className={cx("min-w-0 truncate text-rose-500", !error && "sr-only")}>
            {error}
          </p>
          {!error && hintNode && <p className="hidden min-w-0 items-center gap-1 sm:flex [@media(pointer:coarse)]:hidden">{hintNode}</p>}
          <span className={cx("ml-auto shrink-0 tabular-nums", over && "text-rose-500")}>
            {text.length}/{maxLength}
          </span>
        </div>
      ) : (
        <div className="flex min-h-[1.5rem] items-center justify-between gap-3 px-3 pt-2 text-[12px] text-neutral-500">
          <p role="alert" aria-live="polite" className={cx("min-w-0 truncate", error && "text-rose-500")}>
            {error}
          </p>
          {!error && hintNode && <p className="hidden shrink-0 items-center gap-1 sm:flex [@media(pointer:coarse)]:hidden">{hintNode}</p>}
        </div>
      )}
    </div>
  );
});

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-black/[0.06] px-1 font-sans text-[10.5px] font-medium text-neutral-600 dark:bg-white/[0.08] dark:text-neutral-300">
      {children}
    </kbd>
  );
}

export default PromptInput;

/* ========================================================================== */
/*  Demo — a tiny chat that streams a reply. Swap the fake streamer for your   */
/*  API, and render the reply with <AIResponse /> to get the full experience.  */
/* ========================================================================== */

interface DemoMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  files?: string[];
}

const REPLY =
  "Sure — here's a quick take. A good composer should feel instant: the box grows as you type, sending is one keystroke, and the moment the assistant starts replying the send button turns into a stop button so you're always in control.\n\nTry attaching a file, switching models, or pressing Escape while this is streaming.";

export function PromptInputDemo() {
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => () => clearInterval(timer.current), []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  const stop = useCallback(() => {
    clearInterval(timer.current);
    setStreaming(false);
  }, []);

  const send = useCallback(({ text, files, model }: PromptSubmit) => {
    const id = nextId.current++;
    const replyId = nextId.current++;
    setMessages((m) => [
      ...m,
      { id, role: "user", text, files: files.map((f) => f.name) },
      { id: replyId, role: "assistant", text: "" },
    ]);
    setStreaming(true);
    const full = `[${model?.name ?? "Model"}] ${REPLY}`;
    let i = 0;
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      i = Math.min(full.length, i + 3);
      setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, text: full.slice(0, i) } : x)));
      if (i >= full.length) {
        clearInterval(timer.current);
        setStreaming(false);
      }
    }, 22);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-neutral-100 text-neutral-800 antialiased dark:bg-black dark:text-neutral-200">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-6 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-6">
          {messages.length === 0 && (
            <p className="py-24 text-center text-[14px] text-neutral-500">Say something to start. Your message streams back a reply.</p>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
                {!!m.files?.length && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {m.files.map((f) => (
                      <span key={f} className="rounded-lg bg-black/[0.06] px-2 py-1 text-[12px] text-neutral-600 dark:bg-white/[0.08] dark:text-neutral-300">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                {m.text && (
                  <p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-neutral-900 px-3.5 py-2 text-[14.5px] leading-relaxed text-white dark:bg-white dark:text-neutral-900">
                    {m.text}
                  </p>
                )}
              </div>
            ) : (
              <p key={m.id} className="max-w-[92%] whitespace-pre-wrap break-words text-[14.5px] leading-[1.7]">
                {m.text || <span className="text-neutral-400">Thinking…</span>}
              </p>
            ),
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="px-3 pb-3 pt-1 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <PromptInput onSend={send} streaming={streaming} onStop={stop} safeArea autoFocus />
        </div>
      </div>
    </div>
  );
}

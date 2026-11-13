// How this browser shows each column of the kanban: its width, detailed or one-line cards, and the order of the cards.
// Kept in localStorage; a private window or blocked storage starts from the defaults and keeps changes for the page view.
import { useSyncExternalStore } from "react";
import type { KanbanColumn } from "@gasho/protocol";
import { COLUMN_DEFAULTS, COLUMN_WIDTH, KANBAN_SORTS, type KanbanSort } from "@/lib/kanban";

const KEY = "gasho.kanban";

export interface KanbanPrefs {
  widths: Partial<Record<KanbanColumn, number>>;
  compact: Partial<Record<KanbanColumn, boolean>>;
  sort: Partial<Record<KanbanColumn, KanbanSort>>;
}

const COLUMNS = new Set<string>(Object.keys(COLUMN_DEFAULTS));
export const clampWidth = (w: number): number => Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, w)));

/** What was stored, without anything an older or broken value left in it. */
function parse(raw: string | null): KanbanPrefs {
  const out: KanbanPrefs = { widths: {}, compact: {}, sort: {} };
  let v: Partial<Record<keyof KanbanPrefs, Record<string, unknown>>>;
  try {
    v = JSON.parse(raw ?? "{}") as typeof v;
  } catch {
    return out;
  }
  if (typeof v !== "object" || v === null) return out;
  for (const [col, w] of Object.entries(v.widths ?? {})) if (COLUMNS.has(col) && typeof w === "number") out.widths[col as KanbanColumn] = clampWidth(w);
  for (const [col, c] of Object.entries(v.compact ?? {})) if (COLUMNS.has(col) && typeof c === "boolean") out.compact[col as KanbanColumn] = c;
  for (const [col, s] of Object.entries(v.sort ?? {})) {
    const { key, desc } = (s ?? {}) as { key?: unknown; desc?: unknown };
    if (COLUMNS.has(col) && typeof key === "string" && Object.hasOwn(KANBAN_SORTS, key) && typeof desc === "boolean") {
      out.sort[col as KanbanColumn] = { key: key as KanbanSort["key"], desc };
    }
  }
  return out;
}

function read(): KanbanPrefs {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return parse(null);
  }
}

let prefs = read();
const listeners = new Set<() => void>();

function update(next: KanbanPrefs): void {
  prefs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

export function useKanbanPrefs(): KanbanPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

export const columnWidth = (p: KanbanPrefs, id: KanbanColumn): number => p.widths[id] ?? COLUMN_DEFAULTS[id].width;
export const columnCompact = (p: KanbanPrefs, id: KanbanColumn): boolean => p.compact[id] ?? COLUMN_DEFAULTS[id].compact;

/** `width` undefined goes back to the default width. */
export function setColumnWidth(id: KanbanColumn, width: number | undefined): void {
  const widths = { ...prefs.widths };
  if (width === undefined) delete widths[id];
  else widths[id] = clampWidth(width);
  update({ ...prefs, widths });
}

export function setColumnCompact(id: KanbanColumn, compact: boolean): void {
  update({ ...prefs, compact: { ...prefs.compact, [id]: compact } });
}

/** `sort` undefined goes back to the default order. */
export function setColumnSort(id: KanbanColumn, sort: KanbanSort | undefined): void {
  const next = { ...prefs.sort };
  if (sort) next[id] = sort;
  else delete next[id];
  update({ ...prefs, sort: next });
}

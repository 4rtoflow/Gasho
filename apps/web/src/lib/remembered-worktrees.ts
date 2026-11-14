// The worktrees this browser keeps in the sidebar once their sessions are gone, in localStorage, until each is taken
// off. A private window or blocked storage keeps them for this page view only.
import { useSyncExternalStore } from "react";
import { worktreeKey, type RememberedWorktree } from "./sessions.ts";

const KEY = "gasho.worktrees";
/** Kept at most: the oldest go first. */
const MAX = 100;
const listeners = new Set<() => void>();
let list: RememberedWorktree[] | undefined;

function valid(x: unknown): x is RememberedWorktree {
  const r = x as Partial<RememberedWorktree> | null;
  return (
    typeof r?.machine === "string" &&
    typeof r.path === "string" &&
    typeof r.label === "string" &&
    typeof r.subfolders === "boolean" &&
    (r.repo === undefined || typeof r.repo === "string")
  );
}

function read(): RememberedWorktree[] {
  if (list) return list;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    list = Array.isArray(saved) ? saved.filter(valid) : [];
  } catch {
    list = [];
  }
  return list;
}

function write(next: RememberedWorktree[]): void {
  list = next.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

const keyOf = (r: RememberedWorktree) => worktreeKey(r.machine, r.path);

/** Keeps these worktrees: new ones first; ones already kept are updated (a branch switched, say) where they are. */
export function rememberWorktrees(items: RememberedWorktree[]): void {
  const current = read();
  const updated = new Map(current.map((r) => [keyOf(r), r]));
  const added: RememberedWorktree[] = [];
  let changed = false;
  for (const r of items) {
    const old = updated.get(keyOf(r));
    if (!old) {
      if (!added.some((a) => keyOf(a) === keyOf(r))) added.push(r);
      changed = true;
    } else if (JSON.stringify(old) !== JSON.stringify(r)) {
      updated.set(keyOf(r), r);
      changed = true;
    }
  }
  if (changed) write([...added, ...current.map((r) => updated.get(keyOf(r)) ?? r)]);
}

/** Takes a worktree off the sidebar (it shows again while it has sessions). */
export function forgetWorktree(machine: string, path: string): void {
  write(read().filter((r) => !(r.machine === machine && r.path === path)));
}

export function useRememberedWorktrees(): RememberedWorktree[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}

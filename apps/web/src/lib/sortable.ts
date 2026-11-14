// Putting the items of a list or a grid in another order: dragging them with a mouse, a finger or a pen, or moving
// them with the keyboard. While dragging, the item follows the pointer and the others make room for it (they slide
// with framer-motion's layout animation); near the top or bottom of the list or page, it scrolls; Esc puts everything
// back. The new order is reported once, when the item is dropped, and the item then settles into its place. The home
// screen's tiles and the sidebar's sessions use it.
import {
  animate,
  motionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type MotionValue,
  type Transition,
} from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The list with the item at `from` moved to `to`. */
export function arrayMove<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Where the dragged item of a vertical list goes: to the place whose middle is nearest its own middle. `rects` are
 * the places of the items in their current order, the dragged item's included.
 */
export function listIndex(rects: readonly Rect[], middle: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  rects.forEach((r, i) => {
    const d = Math.abs(r.top + r.height / 2 - middle);
    if (d < distance) {
      best = i;
      distance = d;
    }
  });
  return best;
}

/**
 * Where the dragged tile of a grid goes, by the tile the pointer is over: before that tile when the pointer is on its
 * first half (the left half, or the upper half of a tile as wide as the grid), after it otherwise; back to its own
 * place over its own tile. Undefined over a gap or an empty cell. `rects` are the places of the tiles when the drag
 * began, the dragged tile's (at `from`) included.
 *
 * The places when the drag began, not the places now: tiles of different sizes move by different amounts when the
 * order changes, and a tile judged by the places now can keep swapping between two orders while the pointer is still.
 * Judged by fixed places, the order shown depends on where the pointer is and nothing else.
 */
export function gridIndex(rects: readonly Rect[], from: number, p: Point, gridWidth: number): number | undefined {
  const over = rects.findIndex((r) => p.x >= r.left && p.x < r.left + r.width && p.y >= r.top && p.y < r.top + r.height);
  const r = rects[over];
  if (!r) return undefined;
  if (over === from) return from;
  const after = r.width >= gridWidth - 1 ? p.y >= r.top + r.height / 2 : p.x >= r.left + r.width / 2;
  // The tile's place once the dragged tile is taken out.
  const at = over > from ? over - 1 : over;
  return after ? at + 1 : at;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** The smallest rectangle around all of `rects`. */
function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  return {
    left,
    top,
    width: Math.max(...rects.map((r) => r.left + r.width)) - left,
    height: Math.max(...rects.map((r) => r.top + r.height)) - top,
  };
}

/** A press becomes a drag once the pointer has moved this far (px); a shorter move is still a click or a tap. */
const DRAG_THRESHOLD = 4;
/** The order changes at most this often while dragging (ms): a pointer shaking on a border does not flicker. */
const MOVE_INTERVAL = 60;
/** Within this distance of the top or bottom of the scrolling list or page (px), it scrolls, faster nearer the edge. */
const SCROLL_EDGE = 56;
/** How far it scrolls in a frame at the edge (px). */
const SCROLL_SPEED = 18;
/** While dragging: the grabbing hand everywhere, and no text selected. */
const DRAGGING_CSS = "*{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}";

/** How the others make room, and how a dropped item settles into its place. */
export const SORT_SPRING: Transition = { type: "spring", stiffness: 520, damping: 44, mass: 0.8 };
const INSTANT: Transition = { duration: 0 };

export interface SortableOptions {
  /** The items, in the order they are shown when nothing is being dragged. */
  ids: readonly string[];
  /** `list`: a vertical list (the item moves up and down only). `grid`: tiles of any sizes in a CSS grid. */
  mode: "list" | "grid";
  /**
   * The new order, after a drop or a move with the keyboard. It should change `ids` at once (React state or a
   * store), or the items show their old order for a moment.
   */
  onCommit: (ids: string[]) => void;
  /** The item's name, read out after it moved. */
  label: (id: string) => string;
}

export interface SortableItem {
  /** The item's element: the one that moves (put `item.style` on it) and whose place counts. */
  ref: (el: HTMLElement | null) => void;
  /** The others slide to their new places; the dragged item follows the pointer instead. */
  layout: "position" | false;
  transition: Transition;
  /** The dragged item also needs `position: relative`, for its z-index. */
  style: { x: MotionValue<number>; y: MotionValue<number>; zIndex?: number };
}

export interface Sortable {
  /** The order to show the items in: while dragging, the order the drag has made so far. */
  order: string[];
  /** The item being dragged, or settling into its place after the drop. */
  active: string | null;
  /** Whether an item is being dragged now. */
  dragging: boolean;
  item: (id: string) => SortableItem;
  /** Call from the onPointerDown of what an item is dragged by. Only the main button and the first finger drag. */
  start: (id: string, e: ReactPointerEvent) => void;
  /** Moves an item to another place (for the keyboard); the place is kept within the list. */
  moveTo: (id: string, index: number) => void;
  /** What the last move was, for an aria-live region. */
  announcement: string;
}

interface Setters {
  preview: (ids: string[] | null) => void;
  active: (id: string | null) => void;
  dragging: (dragging: boolean) => void;
  announce: (text: string) => void;
}

interface Drag {
  id: string;
  pointerId: number;
  /** Where the pointer went down, and where it is now (viewport coordinates). */
  start: Point;
  point: Point;
  /** Where the pointer holds the item, from its top left corner. */
  grab: Point;
  started: boolean;
  /** The order before the drag, which Esc puts back. */
  before: string[];
  scroller: HTMLElement | null;
  /** When the order last changed (performance.now()). */
  moved: number;
  frame: number;
  /** Where the item's top left corner was last shown, for settling from there after the drop. */
  shown: Point;
  /** A grid's tiles: the grid, and where the tiles were (in the order `before`) when the drag began, from its corner. */
  grid: { el: HTMLElement; places: Rect[] } | null;
}

/** Where an element is laid out, in viewport coordinates, without its transform (the drag, or a layout animation). */
function layoutRect(el: HTMLElement): Rect {
  const parent = el.offsetParent;
  if (!(parent instanceof HTMLElement)) return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  const base = parent.getBoundingClientRect();
  return {
    left: base.left + parent.clientLeft + el.offsetLeft - parent.scrollLeft,
    top: base.top + parent.clientTop + el.offsetTop - parent.scrollTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

/** The element the item scrolls in: the page's main area, or the sidebar's list. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** The click that ends a drag (the mouse button goes up over the dragged item) is not a click on the item. */
function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/** The drag itself, outside React: it follows the pointer every frame and tells React only when the order changes. */
class Sorter {
  /** The items' order as drawn now (set after each render). */
  order: string[] = [];
  mode: SortableOptions["mode"] = "list";
  commit: (ids: string[]) => void = () => {};
  label: (id: string) => string = (id) => id;
  reduce = false;
  private readonly set: Setters;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, (el: HTMLElement | null) => void>();
  private readonly motions = new Map<string, { x: MotionValue<number>; y: MotionValue<number> }>();
  private drag: Drag | null = null;
  /** The item being dragged or settling. */
  private active: string | null = null;
  /** A dropped item, to settle into its place once the final order is drawn. */
  private settling: { id: string; shown: Point } | null = null;
  /** An item moved with the keyboard, to scroll into view once drawn. */
  private reveal: string | null = null;
  private animations: AnimationPlaybackControls[] = [];
  /** Counts the settlings: one that was cut short by another drag does not end it. */
  private settlings = 0;
  private css: HTMLStyleElement | null = null;

  constructor(set: Setters) {
    this.set = set;
  }

  ref(id: string): (el: HTMLElement | null) => void {
    let r = this.refs.get(id);
    if (!r) {
      r = (el) => {
        if (el) this.elements.set(id, el);
        else this.elements.delete(id);
      };
      this.refs.set(id, r);
    }
    return r;
  }

  motion(id: string): { x: MotionValue<number>; y: MotionValue<number> } {
    let m = this.motions.get(id);
    if (!m) {
      m = { x: motionValue(0), y: motionValue(0) };
      this.motions.set(id, m);
    }
    return m;
  }

  /** After each render: the order on screen, and what waits for it (settling a dropped item, showing a moved one). */
  drawn(order: string[]): void {
    this.order = order;
    const s = this.settling;
    if (s) {
      this.settling = null;
      this.settle(s.id, s.shown);
    }
    const id = this.reveal;
    if (id) {
      this.reveal = null;
      const el = this.elements.get(id);
      if (el) this.scrollIntoView(el);
    }
  }

  start = (id: string, e: ReactPointerEvent): void => {
    if (this.drag || e.button !== 0 || !e.isPrimary) return;
    const el = this.elements.get(id);
    if (!el || !this.order.includes(id)) return;
    const r = el.getBoundingClientRect();
    const point = { x: e.clientX, y: e.clientY };
    this.drag = {
      id,
      pointerId: e.pointerId,
      start: point,
      point,
      grab: { x: point.x - r.left, y: point.y - r.top },
      started: false,
      before: [...this.order],
      scroller: scrollParent(el),
      moved: 0,
      frame: 0,
      shown: { x: r.left, y: r.top },
      grid: null,
    };
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("blur", this.onBlur);
  };

  moveTo = (id: string, index: number): void => {
    if (this.drag?.started) return;
    const from = this.order.indexOf(id);
    const to = Math.max(0, Math.min(this.order.length - 1, index));
    if (from < 0 || from === to) return;
    const next = arrayMove(this.order, from, to);
    this.reveal = id;
    this.commit(next);
    this.announce(id, next);
  };

  dispose(): void {
    const d = this.drag;
    this.drag = null;
    if (d) cancelAnimationFrame(d.frame);
    this.removeListeners();
    for (const a of this.animations) a.stop();
  }

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.point = { x: e.clientX, y: e.clientY };
    if (!d.started && Math.hypot(d.point.x - d.start.x, d.point.y - d.start.y) >= DRAG_THRESHOLD) this.begin(d);
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.drag?.pointerId) this.finish(true);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.drag?.started) return;
    // Esc puts the order back, and does nothing else meanwhile (it would close the sidebar's drawer or a panel).
    e.preventDefault();
    e.stopPropagation();
    this.finish(false);
  };

  private onBlur = (): void => this.finish(true);

  private begin(d: Drag): void {
    d.started = true;
    // An item still settling from the last drop goes straight to its place.
    this.settlings++;
    for (const a of this.animations) a.stop();
    this.animations = [];
    if (this.active && this.active !== d.id) {
      const m = this.motion(this.active);
      m.x.jump(0);
      m.y.jump(0);
    }
    this.active = d.id;
    if (this.mode === "grid") {
      // offsetLeft and offsetTop leave out the transforms: the places, not where a tile is sliding through.
      const els = d.before.map((id) => this.elements.get(id));
      const grid = els[0]?.offsetParent;
      if (grid instanceof HTMLElement && els.every((el) => el?.offsetParent === grid)) {
        d.grid = {
          el: grid,
          places: els.map((el) => ({ left: el!.offsetLeft, top: el!.offsetTop, width: el!.offsetWidth, height: el!.offsetHeight })),
        };
      }
    }
    this.set.active(d.id);
    this.set.dragging(true);
    this.set.preview(d.before);
    this.css = document.createElement("style");
    this.css.textContent = DRAGGING_CSS;
    document.head.append(this.css);
    window.getSelection()?.removeAllRanges();
    d.frame = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    const d = this.drag;
    if (!d?.started) return;
    d.frame = requestAnimationFrame(this.tick);
    const from = this.order.indexOf(d.id);
    // The item went away while being dragged (its session was removed).
    if (from < 0 || !this.elements.has(d.id)) return this.finish(false);
    this.autoScroll(d);
    const rects: Rect[] = [];
    for (const id of this.order) {
      const el = this.elements.get(id);
      if (!el) return;
      rects.push(layoutRect(el));
    }
    const box = rects[from]!;
    // The item follows the pointer within the area the items take up. Past it, the item would make the list or page
    // longer (or wider), and scrolling at its edge would go on into empty space.
    const area = union(rects);
    const left = clamp(d.point.x - d.grab.x, area.left, area.left + area.width - box.width);
    const top = clamp(d.point.y - d.grab.y, area.top, area.top + area.height - box.height);
    const x = this.mode === "list" ? 0 : left - box.left;
    const m = this.motion(d.id);
    m.x.set(x);
    m.y.set(top - box.top);
    d.shown = { x: box.left + x, y: top };
    this.reorder(d, from, rects, top + box.height / 2);
  };

  private autoScroll(d: Drag): void {
    const s = d.scroller;
    if (!s) return;
    const r = s.getBoundingClientRect();
    const edge = Math.min(SCROLL_EDGE, r.height / 4);
    const speed = (depth: number) => Math.ceil(Math.min(1, depth / edge) * SCROLL_SPEED);
    const above = r.top + edge - d.point.y;
    const below = d.point.y - (r.bottom - edge);
    if (above > 0) s.scrollTop -= speed(above);
    else if (below > 0) s.scrollTop += speed(below);
  }

  /** `rects`: the items' places now, in the order shown; `middle`: the dragged item's middle as shown (a list's). */
  private reorder(d: Drag, from: number, rects: Rect[], middle: number): void {
    const now = performance.now();
    if (now - d.moved < MOVE_INTERVAL) return;
    let next: string[];
    if (this.mode === "grid") {
      // By where the tiles were when the drag began (see gridIndex), from the grid's corner as it is now (scrolled).
      if (!d.grid) return;
      const { el: grid, places } = d.grid;
      const box = grid.getBoundingClientRect();
      const p = { x: d.point.x - box.left - grid.clientLeft + grid.scrollLeft, y: d.point.y - box.top - grid.clientTop + grid.scrollTop };
      const start = d.before.indexOf(d.id);
      const to = gridIndex(places, start, p, grid.clientWidth);
      if (to === undefined) return;
      next = arrayMove(d.before, start, to);
    } else next = arrayMove(this.order, from, listIndex(rects, middle));
    if (same(next, this.order)) return;
    d.moved = now;
    this.set.preview(next);
  }

  private finish(keep: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(d.frame);
    this.removeListeners();
    if (!d.started) return;
    swallowClick();
    // What is on screen now is what the drop keeps.
    const next = keep ? this.order : d.before;
    const changed = next.some((id, i) => id !== d.before[i]);
    this.settling = { id: d.id, shown: d.shown };
    this.set.dragging(false);
    this.set.preview(null);
    if (changed) {
      this.commit(next);
      this.announce(d.id, next);
    }
  }

  /** Slides a dropped item from where it was shown into its place. */
  private settle(id: string, shown: Point): void {
    const el = this.elements.get(id);
    const m = this.motion(id);
    if (el) {
      const box = layoutRect(el);
      m.x.set(this.mode === "list" ? 0 : shown.x - box.left);
      m.y.set(shown.y - box.top);
    }
    const t = this.reduce ? INSTANT : SORT_SPRING;
    const settling = ++this.settlings;
    const animations = [animate(m.x, 0, t), animate(m.y, 0, t)];
    this.animations = animations;
    void Promise.all(animations).then(() => {
      if (settling !== this.settlings) return;
      this.active = null;
      this.set.active(null);
    });
  }

  /** Scrolls the list or page just enough to show an item's top (it may be taller than the screen). */
  private scrollIntoView(el: HTMLElement): void {
    const s = scrollParent(el);
    if (!s) return;
    const box = layoutRect(el);
    const view = s.getBoundingClientRect();
    const margin = 8;
    if (box.top < view.top + margin) s.scrollTop -= view.top + margin - box.top;
    else if (box.top + box.height > view.bottom - margin) {
      s.scrollTop += Math.min(box.top + box.height - (view.bottom - margin), box.top - (view.top + margin));
    }
  }

  private announce(id: string, order: string[]): void {
    this.set.announce(`「${this.label(id)}」を ${order.indexOf(id) + 1} 番目に移動しました（全 ${order.length} 件）`);
  }

  private removeListeners(): void {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("blur", this.onBlur);
    this.css?.remove();
    this.css = null;
  }
}

export function useSortable({ ids, mode, onCommit, label }: SortableOptions): Sortable {
  const reduce = useReducedMotion() ?? false;
  const [preview, setPreview] = useState<string[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [sorter] = useState(
    () => new Sorter({ preview: setPreview, active: setActive, dragging: setDragging, announce: setAnnouncement }),
  );

  const order = useMemo(() => {
    if (!preview) return [...ids];
    // An item that came while dragging (a session started meanwhile) goes first; one that went is left out.
    const shown = new Set(ids);
    const placed = new Set(preview);
    return [...ids.filter((id) => !placed.has(id)), ...preview.filter((id) => shown.has(id))];
  }, [ids, preview]);

  useLayoutEffect(() => {
    sorter.mode = mode;
    sorter.commit = onCommit;
    sorter.label = label;
    sorter.reduce = reduce;
    sorter.drawn(order);
  });
  useEffect(() => () => sorter.dispose(), [sorter]);

  const transition = reduce ? INSTANT : SORT_SPRING;
  return {
    order,
    active,
    dragging,
    announcement,
    item: (id) => ({
      ref: sorter.ref(id),
      layout: id === active ? false : "position",
      transition,
      style: id === active ? { ...sorter.motion(id), zIndex: 30 } : sorter.motion(id),
    }),
    start: sorter.start,
    moveTo: sorter.moveTo,
  };
}

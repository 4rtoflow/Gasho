// The edge of a pane on a computer, dragged to change the pane's width: the right edge of the sidebar, the left edge of a
// session's side panel. A double-click goes back to the default width; ←/→ move the edge when it is focused.
import * as React from "react";
import { cn } from "@/lib/utils";

export function ResizeHandle({
  edge,
  label,
  width,
  min,
  max,
  clamp,
  onDrag,
  onChange,
  onReset,
}: {
  /** The pane's edge it is on; moving it away from the pane makes the pane wider. */
  edge: "left" | "right";
  label: string;
  width: number;
  min: number;
  max: number;
  /** The widths it can be moved to. */
  clamp: (width: number) => number;
  /** The width while dragged, and null when let go (after `onChange`). */
  onDrag: (width: number | null) => void;
  /** A width to save: when let go after moving, or moved with ←/→. */
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const drag = React.useRef<{ x: number; from: number; to: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const outward = edge === "right" ? 1 : -1;

  const end = (save: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (save && d.to !== d.from) onChange(d.to);
    onDrag(null);
  };
  // The pane can go while dragged (the sidebar folded with ⌘B, the panel closed with Esc) before the pointer is let go.
  React.useEffect(() => () => end(false), []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="ドラッグで幅を変える（ダブルクリックで元の幅）"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, from: width, to: width };
        setDragging(true);
        // Kept while the pointer is off the edge, over the rest of the page.
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        onDrag(width);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.to = clamp(d.from + outward * (e.clientX - d.x));
        onDrag(d.to);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const move = e.key === "ArrowLeft" ? -8 : e.key === "ArrowRight" ? 8 : 0;
        if (!move) return;
        e.preventDefault();
        // At the end of the range nothing is saved, so a wider width saved on a wider window stays.
        const next = clamp(width + outward * move);
        if (next !== width) onChange(next);
      }}
      className={cn(
        "group absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none outline-none",
        edge === "right" ? "right-0" : "left-0"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 w-0.5 transition-colors group-hover:bg-neutral-300 group-focus-visible:bg-neutral-400 dark:group-hover:bg-neutral-700 dark:group-focus-visible:bg-neutral-600",
          edge === "right" ? "right-0" : "left-0",
          dragging && "bg-neutral-400 dark:bg-neutral-600"
        )}
      />
    </div>
  );
}

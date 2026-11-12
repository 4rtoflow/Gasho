// EasyUI's Stat Card (easyui.site/components/stat-card): a KPI tile with a count-up number, a delta pill and a
// scrubbable sparkline. Taken with its helpers from chart-primitives and dashboard-chart-utils, and changed for
// Gasho: the delta pill shows only when there is a period to compare with, the sparkline only when there is a trend
// (a count with no history is a plain number tile), an optional icon goes before the label, and the texts are
// Japanese. Hand-written SVG; measures its own width.
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";

/** The accent of a single series on the dark surface (validated: >= 3:1 against #0b0b0c). */
export const CHART_BLUE = "#3987e5";
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const defaultFormat = (n: number) => numberFormat.format(n);
const pctText = (x: number) => `${Math.abs(x) >= 10 ? Math.round(x) : x.toFixed(1)}%`;

/** The surface of every tile on the home screen (the same as the Stat Card's). */
export const TILE =
  "min-w-0 rounded-2xl bg-white text-neutral-700 ring-1 ring-black/[0.07] dark:bg-[#0b0b0c] dark:text-neutral-300 dark:ring-white/[0.07]";
export const TILE_SHADOW = "0 1px 2px rgba(0,0,0,0.04), 0 18px 36px -28px rgba(0,0,0,0.2)";
const focus = "outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/70 dark:focus-visible:ring-white/40";

/** Container width via ResizeObserver. */
function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth) || initial);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width] as const;
}

/** Clears a tap selection when the user taps outside (touch). */
function useDismissOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [ref, open, close]);
}

/** Smooth monotone cubic through points (never overshoots the data). */
function monotonePath(p: [number, number][]): string {
  const n = p.length;
  const first = p[0];
  if (!first) return "";
  if (n === 1) return `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  const at = (i: number) => p[i] as [number, number];
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = at(i + 1)[0] - at(i)[0];
    m[i] = (at(i + 1)[1] - at(i)[1]) / (dx[i] || 1e-9);
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = m[0] ?? 0;
  t[n - 1] = m[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] ?? 0) * (m[i] ?? 0) <= 0 ? 0 : ((m[i - 1] ?? 0) + (m[i] ?? 0)) / 2;
  for (let i = 0; i < n - 1; i++) {
    const mi = m[i] ?? 0;
    if (mi === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = (t[i] ?? 0) / mi;
      const b = (t[i + 1] ?? 0) / mi;
      const s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * mi;
        t[i + 1] = k * b * mi;
      }
    }
  }
  let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (dx[i] ?? 0) / 3;
    const [x0, y0] = at(i);
    const [x1, y1] = at(i + 1);
    d += `C${(x0 + h).toFixed(2)} ${(y0 + (t[i] ?? 0) * h).toFixed(2)} ${(x1 - h).toFixed(2)} ${(y1 - (t[i + 1] ?? 0) * h).toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
}

export interface StatCardProps {
  label: string;
  /** The headline number (usually the latest total of `trend`). */
  value: number;
  /** Points for the sparkline, oldest first. Fewer than two: no sparkline. */
  trend?: number[];
  /** Names of the trend points, shown while scrubbing ("14時台"). */
  trendLabels?: string[];
  /** The previous period's value: the delta pill is computed from it. Without it (or `delta`), no pill. */
  previous?: number;
  /** …or the delta in percent. */
  delta?: number;
  /** What the delta compares with ("前の24時間と比べて"), shown on hover and read out. */
  deltaLabel?: string;
  /** Which direction is good news; "neither" when the change is not good or bad (the pill stays gray). */
  goodWhen?: "up" | "down" | "neither";
  /** The text under the number. */
  period?: string;
  format?: (n: number) => string;
  color?: string;
  /** Before the label: an icon that says what the number is (never color alone). */
  icon?: ReactNode;
  /** Colors the number, for a count that asks for attention (sessions waiting for an answer). */
  valueClassName?: string;
  /** Without a trend: a thin meter at the bottom, `value` out of `total` (the share of sessions in a state). */
  meter?: { total: number; color: string };
  animated?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  trend = [],
  trendLabels,
  previous,
  delta,
  deltaLabel,
  goodWhen = "up",
  period,
  format = defaultFormat,
  color = CHART_BLUE,
  icon,
  valueClassName,
  meter,
  animated = true,
  className = "",
}: StatCardProps) {
  const reduce = useReducedMotion();
  const anim = animated && !reduce;
  const uid = useId().replace(/:/g, "");
  const [boxRef, width] = useElementWidth<HTMLDivElement>(220);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  useDismissOutside(cardRef, active !== null, useCallback(() => setActive(null), []));

  const n = trend.length;
  const spark = n > 1;
  const H = 52;
  const padT = 8;
  const padB = 6;
  const min = n ? Math.min(...trend) : 0;
  const span = (n ? Math.max(...trend) : 1) - min || 1;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const pts = trend.map((v, i) => [i * stepX, padT + (1 - (v - min) / span) * (H - padT - padB)] as [number, number]);
  const line = monotonePath(pts);
  const last = pts[n - 1];
  const area = spark && last && pts[0] ? `${line}L${last[0].toFixed(2)} ${H}L${pts[0][0].toFixed(2)} ${H}Z` : "";

  const pct = delta ?? (previous !== undefined && previous !== 0 ? ((value - previous) / Math.abs(previous)) * 100 : undefined);
  const rounded = pct === undefined ? undefined : Math.round(pct * 10) / 10;
  const good = !rounded || goodWhen === "neither" ? null : goodWhen === "up" ? rounded > 0 : rounded < 0;

  // The number counts up on mount and follows the scrubber afterwards.
  const fmt = useRef(format);
  fmt.current = format;
  const shown = useMotionValue(anim ? 0 : value);
  const text = useTransform(shown, (v) => fmt.current(v));
  const mounted = useRef(false);
  const target = active === null ? value : (trend[active] ?? value);
  useEffect(() => {
    const intro = !mounted.current;
    mounted.current = true;
    const c = animate(shown, target, { duration: reduce ? 0 : intro ? 1.1 : 0.22, ease: EASE_OUT });
    return () => c.stop();
  }, [target, shown, reduce]);

  // The scrubber's cursor.
  const curX = useSpring(0, { stiffness: 600, damping: 44, mass: 0.5 });
  const curY = useSpring(0, { stiffness: 600, damping: 44, mass: 0.5 });
  const seen = useRef(false);
  const point = active === null ? undefined : pts[active];
  useEffect(() => {
    if (!point) {
      seen.current = false;
      return;
    }
    if (!seen.current) {
      curX.jump(point[0]);
      curY.jump(point[1]);
      seen.current = true;
    } else {
      curX.set(point[0]);
      curY.set(point[1]);
    }
  }, [point, curX, curY]);

  const move = (e: PointerEvent) => {
    if (!spark || !svgRef.current) return;
    const box = svgRef.current.getBoundingClientRect();
    setActive(clamp(Math.round((e.clientX - box.left) / stepX), 0, n - 1));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!spark) return;
    if (e.key === "ArrowRight") setActive((a) => clamp((a ?? n - 2) + 1, 0, n - 1));
    else if (e.key === "ArrowLeft") setActive((a) => clamp((a ?? n) - 1, 0, n - 1));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const sub = active === null ? period : (trendLabels?.[active] ?? `${active + 1} 番目`);
  const change =
    rounded === undefined
      ? ""
      : `、${deltaLabel ? `${deltaLabel} ` : ""}${rounded > 0 ? "増加" : rounded < 0 ? "減少" : "変化なし"} ${pctText(Math.abs(rounded))}`;

  return (
    <div
      ref={cardRef}
      tabIndex={spark ? 0 : undefined}
      role="group"
      aria-label={`${label}：${format(value)}${change}`}
      onPointerMove={move}
      onPointerDown={move}
      onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      className={cx(TILE, "group relative flex select-none flex-col overflow-hidden pt-4 transition-[box-shadow] duration-200", focus, !spark && "pb-4", className)}
      style={{ boxShadow: TILE_SHADOW }}
    >
      {/* On a narrow tile the delta pill goes under the label instead of cutting it short. */}
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 px-4">
        <p className="flex items-center gap-1.5 text-[12.5px] text-neutral-500">
          {icon}
          <span>{label}</span>
        </p>
        {rounded !== undefined && (
          <span
            title={deltaLabel}
            className={cx(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium tabular-nums",
              good === null && "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.06]",
              good === true && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              good === false && "bg-rose-500/10 text-rose-600 dark:text-rose-400",
            )}
          >
            {rounded !== 0 && (
              <svg viewBox="0 0 10 10" className={cx("h-2 w-2", rounded < 0 && "rotate-180")} fill="currentColor" aria-hidden>
                <path d="M5 1.5 9 7.5H1Z" />
              </svg>
            )}
            {pctText(Math.abs(rounded))}
          </span>
        )}
      </div>

      {/* A standalone number keeps proportional figures. */}
      <p className={cx("mt-1.5 px-4 text-[28px] leading-none font-semibold tracking-[-0.035em] text-neutral-900 dark:text-neutral-50 sm:text-[30px]", valueClassName)}>
        <motion.span>{text}</motion.span>
      </p>
      {sub && <p className="mt-1.5 truncate px-4 text-[12px] text-neutral-500">{sub}</p>}

      {!spark && meter && (
        // The track is a light step of the fill's own color; the share it shows is in the label and the number.
        <div className="mt-auto px-4 pt-3" aria-hidden>
          <div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: `${meter.color}29` }}>
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${meter.total > 0 ? (value / meter.total) * 100 : 0}%`, backgroundColor: meter.color }}
            />
          </div>
        </div>
      )}

      {spark && last && (
        <div ref={boxRef} className="mt-auto pt-3" style={{ height: H + 12 }}>
          <svg
            ref={svgRef}
            width={width}
            height={H}
            role="img"
            aria-label={`${label} の推移：${format(trend[0] ?? 0)} から ${format(trend[n - 1] ?? 0)}`}
            className="block overflow-visible"
          >
            <defs>
              <linearGradient id={`${uid}-g`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity="0.22" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <motion.path d={area} fill={`url(#${uid}-g)`} initial={anim ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.5 }} />
            <motion.path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={anim ? { pathLength: 0 } : false}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.1, ease: EASE_OUT, delay: 0.15 }}
            />
            {/* the latest point */}
            <g style={{ opacity: active === null ? 1 : 0, transition: "opacity .15s" }}>
              <circle cx={last[0]} cy={last[1]} r={4} fill={color} className="stroke-white dark:stroke-[#0b0b0c]" strokeWidth={2} />
            </g>
            {/* the scrubber */}
            <motion.g initial={false} animate={{ opacity: active === null ? 0 : 1 }} transition={{ duration: 0.12 }}>
              <motion.line y1={0} y2={H} x1={curX} x2={curX} className="stroke-black/15 dark:stroke-white/20" />
              <motion.circle cx={curX} cy={curY} r={4.5} fill={color} className="stroke-white dark:stroke-[#0b0b0c]" strokeWidth={2} />
            </motion.g>
          </svg>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {active !== null ? `${trendLabels?.[active] ?? `${active + 1} 番目`}：${format(trend[active] ?? 0)}` : ""}
      </p>
    </div>
  );
}

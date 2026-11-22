"use client";

/*
 * Shared chart pieces for the Blinkit screens (design.md §10).
 * Quiet axes, no dots on every point, focus + context colouring, and a
 * donut with the values listed beside it.
 */

import type { DotProps, TooltipProps } from "recharts";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { ValueTooltip } from "@/components/blinkit/chart-tooltips";
import { dayLabel, monthName } from "@/components/blinkit/format";
import { ChartReveal, useChartAnimProps } from "@/components/motion/ChartAnimation";
import { categoryColor } from "@/lib/blinkit-category-colors";
import { CHART, CHART_ANIM, CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";
import { compact, inr } from "@/lib/format";

/** Categorical series in design order. Kept under the old name for callers. */
export const PIE_COLORS = CHART_SERIES;

/** Focus series (accent) and the quiet context fill (surface-2). */
export const FOCUS = CHART.accent;
export const CONTEXT = CHART.surface2;

/** Pick the focus colour for one bar and context for the rest. */
export function focusFill(index: number, focusIndex = 0): string {
  return index === focusIndex ? FOCUS : CONTEXT;
}

/** Slice gaps and hover rings match the card behind the chart. */
export const PIE_SLICE_STROKE: string = CHART.tooltip.background;
export const PIE_SLICE_STROKE_WIDTH = 2;

export const PIE_CHART_HEIGHT = 240;
export const PIE_CHART_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 };

/** Horizontal bar charts: tight margins, labels on the left. */
export const hBarChartMargin = (yAxisWidth = 0) => ({
  top: 4,
  right: 12,
  left: Math.max(0, yAxisWidth > 0 ? 0 : 4),
  bottom: 4,
});

export const AXIS_TICK = {
  fill: CHART.faint,
  fontSize: 12,
  fontWeight: 500,
} as const;

/** Category labels on horizontal bars: readable ink-2, not faint. */
export const CATEGORY_AXIS_TICK = {
  fill: CHART.ink2,
  fontSize: 13,
  fontWeight: 500,
} as const;

/** Minimal axes (§10): no axis line, no tick marks. Spread onto XAxis / YAxis. */
export const AXIS_QUIET = { axisLine: false, tickLine: false } as const;

/** Kept for old call sites: chart cards are plain Cards now. */
export const CHART_CARD_CLASS = "";

export const CHART_CLICK_CLASS =
  "[&_.recharts-bar-rectangle]:cursor-pointer [&_.recharts-pie-sector]:cursor-pointer [&_.recharts-dot]:cursor-pointer";

/** No marker on every point; lines read cleaner without them (§10). */
export function makeSquareDot(_color: string, _size = 5): false {
  return false;
}

/** Small round marker on hover with a white ring. */
export function makeSquareActiveDot(color: string, size = 8) {
  return function ActiveDot(props: DotProps) {
    const { cx, cy } = props;
    if (cx == null || cy == null) return <g />;
    return <circle cx={cx} cy={cy} r={size / 2} fill={color} stroke={PIE_SLICE_STROKE} strokeWidth={2} />;
  };
}

/** @deprecated Use makeSquareDot */
export function lineDot(color: string, size = 5) {
  return makeSquareDot(color, size);
}

/** @deprecated Use makeSquareActiveDot */
export function lineActiveDot(color: string) {
  return makeSquareActiveDot(color, 8);
}

/** Generic value tooltip (name kept for old call sites; it is light now). */
export function DarkTooltip({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
}: TooltipProps<number, string> & {
  formatter?: (value: number, name: string) => string;
  labelFormatter?: (label: string) => string;
}) {
  return (
    <ValueTooltip
      active={active}
      payload={payload}
      label={label}
      labelFormatter={labelFormatter}
      valueFormatter={(v) => formatter ? formatter(v, "") : inr(v)}
      nameLabel={payload?.[0]?.name != null ? String(payload[0].name) : undefined}
    />
  );
}

/** 'YYYY-MM-DD' → '15 Nov'; 'YYYY-MM' → 'Nov' (or 'Nov 2025' outside this year). */
export function formatPeriodLabel(period: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return dayLabel(period);
  if (/^\d{4}-\d{2}$/.test(period)) {
    const y = Number(period.slice(0, 4));
    return monthName(period, { short: y === new Date().getFullYear() });
  }
  return period;
}

export function dailyTickInterval(pointCount: number): number | "preserveStartEnd" {
  if (pointCount <= 14) return 0;
  if (pointCount <= 31) return 1;
  if (pointCount <= 60) return 3;
  if (pointCount <= 120) return 6;
  return "preserveStartEnd";
}

/** Compute Y-axis width from longest category label */
export function labelAxisWidth(labels: string[], min = 110, max = 220): number {
  if (!labels.length) return min;
  const longest = Math.max(...labels.map(l => l.length));
  return Math.min(max, Math.max(min, longest * 6.8 + 16));
}

export const barChartMargin = (leftPad = 0) => ({
  top: 12,
  right: 12,
  left: leftPad,
  bottom: 4,
});

/**
 * Parts of a whole (§10): a donut with the list beside it. More than seven
 * parts are folded into a grey "Other" slice that can't be drilled into.
 */
export function BlinkitPieChart({
  data,
  nameKey,
  valueKey,
  valueFormatter = inr,
  height = PIE_CHART_HEIGHT,
  onSliceClick,
  chartIndex = 0,
}: {
  data: ReadonlyArray<object>;
  nameKey: string;
  valueKey: string;
  valueFormatter?: (v: number) => string;
  height?: number;
  onSliceClick?: (name: string, entry: Record<string, unknown>) => void;
  chartIndex?: number;
  /** Ignored: the list sits beside the donut on wide cards and below it on narrow ones. */
  layout?: "split" | "stacked";
}) {
  const anim = useChartAnimProps(0);
  if (!data.length) return null;

  const sorted = (data as Record<string, unknown>[])
    .map(r => ({ ...r, __v: Number(r[valueKey]) || 0 }))
    .sort((a, b) => b.__v - a.__v);
  let display: Record<string, unknown>[] = sorted;
  if (sorted.length > 7) {
    const rest = sorted.slice(6).reduce((s, r) => s + r.__v, 0);
    display = [...sorted.slice(0, 6), { [nameKey]: "Other", [valueKey]: rest, __v: rest, __other: true }];
  }

  const total = display.reduce((s, r) => s + (Number(r.__v) || 0), 0);
  const colorFor = (name: string, i: number) => (name === "Other" ? CHART_OTHER : categoryColor(name, i));
  const clickable = (r: Record<string, unknown>) => !!onSliceClick && !r.__other;

  return (
    <ChartReveal index={chartIndex}>
      <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="mx-auto w-full" style={{ height, maxWidth: height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={PIE_CHART_MARGIN}>
              <Pie
                data={display}
                dataKey={valueKey}
                nameKey={nameKey}
                cx="50%"
                cy="50%"
                innerRadius="64%"
                outerRadius="100%"
                paddingAngle={0}
                stroke={PIE_SLICE_STROKE}
                strokeWidth={PIE_SLICE_STROKE_WIDTH}
                isAnimationActive={anim.isAnimationActive}
                animationDuration={CHART_ANIM.pieDuration}
                animationBegin={CHART_ANIM.begin}
                animationEasing="ease-out"
                onClick={onSliceClick ? (_e, index) => {
                  const entry = display[index];
                  const name = String(entry?.[nameKey] ?? "");
                  if (name && clickable(entry)) onSliceClick(name, entry);
                } : undefined}
              >
                {display.map((row, i) => (
                  <Cell key={i} fill={colorFor(String(row[nameKey]), i)} />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ValueTooltip
                    valueFormatter={valueFormatter}
                    labelFormatter={(l) => String(l)}
                    total={total}
                  />
                }
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="min-w-0 space-y-0.5">
          {display.map((row, i) => {
            const name = String(row[nameKey]);
            const val = Number(row.__v) || 0;
            const share = total > 0 ? Math.round((val / total) * 100) : 0;
            const inner = (
              <>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorFor(name, i) }} />
                <span className="min-w-0 flex-1 truncate text-[15px] text-ink-2">{name}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-muted">{share}%</span>
                <span className="w-[88px] shrink-0 text-right text-[15px] font-semibold tabular-nums text-ink">
                  {valueFormatter(val)}
                </span>
              </>
            );
            return (
              <li key={name}>
                {clickable(row) ? (
                  <button
                    type="button"
                    onClick={() => onSliceClick?.(name, row)}
                    className="flex w-full items-center gap-3 rounded-s px-2 py-2 text-left transition-colors hover:bg-surface"
                  >
                    {inner}
                  </button>
                ) : (
                  <div className="flex w-full items-center gap-3 px-2 py-2">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </ChartReveal>
  );
}

export { compact, inr, CHART };

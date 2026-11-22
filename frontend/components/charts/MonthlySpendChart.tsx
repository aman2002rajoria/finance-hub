"use client";

import { useEffect, useState } from "react";
import {
  Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { useChartAnimProps } from "@/components/motion/ChartAnimation";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { MonthlyRow } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthName(period: string): string {
  const m = Number(period.slice(5, 7));
  return MONTHS[m - 1] ?? period;
}

function monthYear(period: string): string {
  return `${monthName(period)} ${period.slice(0, 4)}`;
}

/**
 * Real spend by month (design.md §10, focus + context): the focus month is
 * the accent, every other month is --surface-2. No gridlines, no y-axis.
 * With six months or fewer each bar is labelled directly: month, then value.
 */
export default function MonthlySpendChart({
  rows,
  focusPeriod,
  onSelect,
  height = 260,
  average,
}: {
  rows: MonthlyRow[];
  focusPeriod: string | null;
  onSelect?: (period: string) => void;
  height?: number;
  /** Draws a quiet dashed line at this value (no label: the value lives elsewhere). */
  average?: number;
}) {
  const anim = useChartAnimProps();
  const reduced = usePrefersReducedMotion();
  // On a phone six values don't fit side by side: only the focus bar keeps its value.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    setNarrow(mq.matches);
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const few = rows.length <= 6;
  const data = rows.map(r => ({
    period: r.period,
    spend: Math.max(0, r.spend),
    raw: r.spend,
  }));

  const renderTick = (props: { x: number; y: number; payload: { value: string; index: number } }) => {
    const { x, y, payload } = props;
    const period = payload.value;
    const row = data.find(d => d.period === period);
    const isFocus = period === focusPeriod;
    const showYear = !few && (period.endsWith("-01") || payload.index === 0);
    const label = showYear ? `${monthName(period)} ${period.slice(2, 4)}` : monthName(period);
    const fill = isFocus ? CHART.ink2 : CHART.faint;
    const weight = isFocus ? 600 : 500;
    // Six bars or fewer: the month on one line and its value under it, so
    // neighbouring labels never run together.
    if (few && row) {
      return (
        <g>
          <text x={x} y={y + 14} textAnchor="middle" style={{ fill, fontWeight: weight, fontSize: 14 }}>
            {monthName(period)}
          </text>
          {(!narrow || isFocus) && (
            <text x={x} y={y + 32} textAnchor="middle" style={{ fill, fontWeight: weight, fontSize: 13 }} className="tabular-nums">
              {inr(row.raw)}
            </text>
          )}
        </g>
      );
    }
    return (
      <text x={x} y={y + 14} textAnchor="middle" style={{ fill, fontWeight: weight, fontSize: 12 }}>
        {label}
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        margin={{ top: 4, right: 4, left: 4, bottom: few ? 12 : 4 }}
        barCategoryGap={few ? "12%" : "18%"}
        onClick={state => {
          const p = (state as { activeLabel?: string } | null)?.activeLabel;
          if (p && onSelect) onSelect(p);
        }}
      >
        <XAxis
          dataKey="period"
          tickLine={false}
          axisLine={false}
          interval={few ? 0 : "preserveStartEnd"}
          minTickGap={8}
          tick={renderTick}
          height={few ? 44 : 28}
        />
        <YAxis hide domain={[0, "auto"]} />
        <Tooltip
          cursor={{ fill: CHART.surface, radius: 12 } as object}
          contentStyle={CHART.tooltip}
          itemStyle={{ color: CHART.ink2, fontSize: 14 }}
          labelStyle={{ color: CHART.ink, fontWeight: 600, fontSize: 14, marginBottom: 2 }}
          labelFormatter={(p: string) => monthYear(String(p))}
          formatter={(_v: number, _n: string, item: { payload?: { raw: number } }) => [
            inr(item?.payload?.raw ?? 0),
            "Real spend",
          ]}
        />
        <Bar
          dataKey="spend"
          name="Real spend"
          radius={few ? [16, 16, 16, 16] : [8, 8, 8, 8]}
          className={onSelect ? "cursor-pointer" : undefined}
          isAnimationActive={!reduced && anim.isAnimationActive}
          animationBegin={CHART_ANIM.begin}
          animationDuration={CHART_ANIM.barDuration}
          animationEasing="ease-out"
        >
          {data.map(d => (
            <Cell
              key={d.period}
              fill={d.period === focusPeriod ? CHART.accent : CHART.surface2}
            />
          ))}
        </Bar>
        {average != null && average > 0 && (
          <ReferenceLine y={average} stroke={CHART.faint} strokeDasharray="4 4" ifOverflow="extendDomain" />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

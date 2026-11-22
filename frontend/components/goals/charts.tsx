"use client";

/*
 * Charts for the goals screen. Each answers one question:
 *  - GoalMap:     which goals are at risk, and when? (date × odds × size)
 *  - MiniFan:     the range of outcomes for one goal, at card size
 *  - FanChart:    the same, full size, with the target and the date
 *  - FreeUpStrip: when linked money can come out, on the fan's time axis
 *  - GlidePath:   how much should be in equity each year until the date
 */

import { useEffect, useMemo, useState } from "react";
import {
  Area, Bar, BarChart, Cell, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import { Lock, LockOpen, TriangleAlert } from "lucide-react";
import clsx from "clsx";

import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { KIND_EMOJI, addMonths, goalEmoji, type Band } from "@/lib/wealth";

import type { OddsRow } from "./model";
import { ODDS_WORD, SAFE_ODDS, oddsLabel, oddsTone, type FreeUp, type GlideStep, type OddsTone } from "./odds";
import { useChartMotion } from "./parts";
import { axisRupees, monYear, rupees, short } from "./words";

/** Under 640px: fewer ticks, smaller bubbles. */
function useNarrow() {
  const [n, setN] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    setN(mq.matches);
    const on = (e: MediaQueryListEvent) => setN(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return n;
}

const AXIS_TICK = { fill: CHART.faint, fontSize: 12, fontWeight: 500 };

export function toneColor(t: OddsTone): string {
  return t === "success" ? CHART.success : t === "neutral" ? CHART.muted : t === "warning" ? CHART.warning : CHART.danger;
}

/* ------------------------------------------------------------ the map */

interface MapPoint { id: string; m: number; odds: number; r: number; emoji: string; name: string; target: number; date: string; tone: OddsTone }

/** Every goal on one chart: dates across (square-root time, so near goals get room), odds up, size = amount. */
export function GoalMap({ rows, asOf, onOpen }: { rows: OddsRow[]; asOf: string; onOpen: (id: string) => void }) {
  const animate = useChartMotion();
  const narrow = useNarrow();
  const points: MapPoint[] = rows.map((r) => ({
    id: r.goal.id,
    m: Math.max(0.5, r.status.months),
    odds: Math.max(0, Math.min(100, r.odds.pct)),
    r: Math.round((narrow ? 11 : 16) + (narrow ? 3 : 6) * Math.log10(Math.max(1, r.status.target / 1e5) + 1)),
    emoji: goalEmoji(r.goal),
    name: r.goal.name,
    target: r.status.target,
    date: r.goal.targetDate,
    tone: oddsTone(r.odds.pct),
  }));
  const maxM = Math.max(24, ...points.map((p) => p.m)) * 1.04;
  const y0 = Number(asOf.slice(0, 4));
  const firstJan = 12 - (Number(asOf.slice(5, 7)) - 1);
  // Januaries, spaced out further as time goes on (the axis is square-root).
  const ticks = (narrow ? [1, 3, 10, 25] : [1, 2, 3, 5, 10, 15, 20, 30, 40])
    .map((y) => firstJan + (y - 1) * 12)
    .filter((m) => m <= maxM);
  const yearAt = (m: number) => y0 + 1 + Math.round((m - firstJan) / 12);

  return (
    <div className="h-[260px] md:h-[300px] lg:h-[350px]">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 24, right: 28, left: 0, bottom: 4 }}>
          <ReferenceArea y1={SAFE_ODDS} y2={112} fill={CHART.accent50} fillOpacity={1} strokeOpacity={0}
            label={{ value: "80%+ likely", position: "insideBottomRight", fill: CHART.accent700, fontSize: 12, fontWeight: 600 }} />
          <ReferenceLine y={50} stroke={CHART.line} strokeDasharray="3 4" />
          <XAxis
            dataKey="m" type="number" scale="sqrt" domain={[0, maxM]} ticks={ticks} interval={0}
            tickLine={false} axisLine={{ stroke: CHART.line }} tick={AXIS_TICK}
            tickFormatter={(m: number) => String(yearAt(m))}
          />
          <YAxis
            dataKey="odds" type="number" domain={[-12, 112]} ticks={[0, 50, 100]} width={44}
            tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload as MapPoint | undefined;
              if (!p) return null;
              return (
                <div style={CHART.tooltip}>
                  <p style={{ fontWeight: 700, color: CHART.ink }}>{p.emoji} {p.name}</p>
                  <p style={{ color: CHART.ink2 }}>{rupees(p.target)} by {monYear(p.date)}</p>
                  <p style={{ color: toneColor(p.tone), fontWeight: 700 }}>{oddsLabel(p.odds)} likely · {ODDS_WORD[p.tone]}</p>
                </div>
              );
            }}
          />
          <Scatter
            data={points}
            isAnimationActive={animate}
            animationBegin={CHART_ANIM.begin}
            animationDuration={CHART_ANIM.duration}
            onClick={(d: { payload?: MapPoint }) => d?.payload && onOpen(d.payload.id)}
            shape={(props: { cx?: number; cy?: number; payload?: MapPoint }) => {
              const { cx = 0, cy = 0, payload: p } = props;
              if (!p) return <g />;
              const c = toneColor(p.tone);
              return (
                <g style={{ cursor: "pointer" }}>
                  <circle cx={cx} cy={cy} r={p.r} fill={c} fillOpacity={0.16} stroke={c} strokeWidth={2} />
                  <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="central" style={{ fontSize: Math.round(p.r * 1.05) }}>{p.emoji}</text>
                  {/* Amount beside the bubble; above it when it sits on the floor, so it clears the axis. */}
                  <text x={cx} y={p.odds < 25 ? cy - p.r - 6 : cy + p.r + 14} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: CHART.muted }}>{short(p.target)}</text>
                </g>
              );
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------ fans */

const fanData = (bands: Band[]) => bands.map((b) => ({ m: b.month, range: [b.p10, b.p90] as [number, number], p50: b.p50 }));

export function MiniFan({ bands, target, color, height = 64 }: { bands: Band[]; target: number; color: string; height?: number }) {
  const animate = useChartMotion();
  const data = useMemo(() => fanData(bands), [bands]);
  // Zoomed to the action, so short, steady goals still show their climb.
  const top = Math.max(target, ...bands.map((b) => b.p90)) * 1.06;
  const bottom = Math.min(...bands.map((b) => b.p10)) * 0.94;
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 2 }}>
          <XAxis dataKey="m" type="number" domain={["dataMin", "dataMax"]} hide />
          <YAxis domain={[bottom, top]} hide />
          <Area dataKey="range" type="monotone" stroke="none" fill={color} fillOpacity={0.2}
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
          <Line dataKey="p50" type="monotone" stroke={color} strokeWidth={2} dot={false}
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />
          <ReferenceLine y={target} stroke={CHART.ink2} strokeDasharray="4 3" strokeWidth={1.25} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The fan's plot area, so other rows can line up with it. */
export const FAN_MARGIN = { top: 16, right: 16, left: 0, bottom: 0 };
export const FAN_YAXIS = 52;

export function FanChart({
  bands, target, months, asOf, color, height = 240,
}: {
  bands: Band[]; target: number; months: number; asOf: string; color: string; height?: number;
}) {
  const animate = useChartMotion();
  const data = useMemo(() => fanData(bands), [bands]);
  const N = Math.max(1, Math.round(months));
  const last = bands.at(-1);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={FAN_MARGIN}>
          <XAxis
            dataKey="m" type="number" domain={[0, N]} ticks={timeTicks(N, asOf)} interval={0}
            tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={(m: number) => tickLabel(m, N, asOf)}
          />
          <YAxis width={FAN_YAXIS} tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={axisRupees}
            domain={[0, (max: number) => Math.max(max, target) * 1.05]} />
          <Tooltip
            cursor={{ stroke: CHART.line, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              const d = active && (payload?.[0]?.payload as { range: [number, number]; p50: number } | undefined);
              if (!d) return null;
              return (
                <div style={CHART.tooltip}>
                  <p style={{ fontWeight: 700, color: CHART.ink, marginBottom: 4 }}>{monYear(addMonths(asOf, Number(label)))}</p>
                  <p style={{ color: CHART.ink2 }}>Good markets <b style={{ color: CHART.ink }}>{rupees(d.range[1])}</b></p>
                  <p style={{ color: CHART.ink2 }}>Likely <b style={{ color: CHART.ink }}>{rupees(d.p50)}</b></p>
                  <p style={{ color: CHART.ink2 }}>Bad markets <b style={{ color: CHART.ink }}>{rupees(d.range[0])}</b></p>
                </div>
              );
            }}
          />
          <ReferenceLine y={target} stroke={CHART.ink2} strokeDasharray="5 4" strokeWidth={1.5}
            label={{ value: `🎯 ${short(target)}`, position: "insideTopLeft", fill: CHART.ink2, fontSize: 12, fontWeight: 700 }} />
          <ReferenceLine x={N} stroke={CHART.line} strokeWidth={1.5} />
          <Area dataKey="range" type="monotone" stroke="none" fill={color} fillOpacity={0.18}
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
          <Line dataKey="p50" type="monotone" stroke={color} strokeWidth={3} dot={false}
            activeDot={{ r: 4, fill: color, stroke: CHART.card, strokeWidth: 2 }}
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />
          {last && <ReferenceDot x={N} y={last.p50} r={5} fill={color} stroke={CHART.card} strokeWidth={2} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function timeTicks(N: number, asOf: string): number[] {
  if (N <= 18) {
    const every = N <= 6 ? 1 : N <= 12 ? 3 : 6;
    const out: number[] = [];
    for (let m = 0; m <= N; m += every) out.push(m);
    return out;
  }
  const startMonth = Number(asOf.slice(5, 7)) - 1;
  const years = N / 12;
  const every = years > 20 ? 5 : years > 10 ? 2 : 1;
  const out: number[] = [];
  for (let i = 12 - startMonth; i <= N; i += 12 * every) out.push(i);
  return out.length ? out : [0, N];
}
function tickLabel(m: number, N: number, asOf: string): string {
  const iso = addMonths(asOf, m);
  return N <= 18 ? monYear(iso).slice(0, 3) : iso.slice(0, 4);
}

/* ------------------------------------------------- when money frees up */

/**
 * One row per linked holding on the fan's time axis: locked (hatched) until
 * it frees up, then open. The goal's date is the line at the right.
 */
export function FreeUpStrip({ items, months, asOf }: { items: FreeUp[]; months: number; asOf: string }) {
  const N = Math.max(1, Math.round(months));
  if (!items.length) return null;
  const pos = (iso: string | null) => {
    if (!iso) return 0;
    const m = (new Date(iso).getTime() - new Date(asOf).getTime()) / (30.44 * 864e5);
    return Math.max(0, Math.min(1, m / N));
  };
  return (
    <ul className="mt-1 space-y-1.5" style={{ paddingLeft: FAN_YAXIS, paddingRight: FAN_MARGIN.right }}>
      {items.map((f) => {
        const p = pos(f.from);
        const beyond = !!f.from && p >= 1;
        const Icon = f.late || f.risky ? TriangleAlert : f.kind === "lock" ? Lock : LockOpen;
        const tip = `${f.holding.name}: ${f.from ? `${f.kind === "lock" ? "locked" : "costs to break"} until ${monYear(f.from)}` : "free any day"}${f.risky ? ". Equity this close to the date can dip" : ""}`;
        return (
          <li key={f.holding.id} className="relative" title={tip}>
            <div className="relative h-7 overflow-hidden rounded-pill bg-surface">
              {p > 0 && (
                <div
                  className={clsx("absolute inset-y-0 left-0 rounded-pill", f.kind === "lock" ? "fh-hatch" : "bg-surface-2")}
                  style={{ width: `${p * 100}%` }}
                />
              )}
              <div
                className={clsx("absolute inset-y-0 right-0 rounded-pill", f.late ? "bg-warning-tint" : "bg-success-tint")}
                style={{ left: `${p * 100}%`, display: beyond ? "none" : undefined }}
              />
              <span className="absolute inset-y-0 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 truncate text-[12px] font-semibold text-ink">
                <span aria-hidden>{KIND_EMOJI[f.holding.kind]}</span>
                <span className="truncate">{f.holding.name}</span>
                <span className="text-muted">{short(f.holding.current)}</span>
              </span>
            </div>
            <span className={clsx(
              "mt-0.5 flex items-center gap-1 text-[12px] font-semibold tabular-nums",
              f.late || f.risky ? "text-warning-text" : "text-muted",
            )}>
              <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              {f.from ? `${f.kind === "lock" ? "Locked" : "Penalty"} till ${monYear(f.from)}` : "Free any day"}
              {f.risky && " · equity, 2y out"}
            </span>
          </li>
        );
      })}
      <style>{`.fh-hatch { background: repeating-linear-gradient(135deg, var(--surface-2) 0 6px, transparent 6px 11px); }`}</style>
    </ul>
  );
}

/* --------------------------------------------------------- glide path */

export function GlidePath({ steps, now }: { steps: GlideStep[]; now: number | null }) {
  const animate = useChartMotion();
  return (
    <div className="h-[150px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={steps} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} interval="preserveStartEnd" minTickGap={8} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={36} tickLine={false} axisLine={false} tick={AXIS_TICK} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip
            cursor={{ fill: CHART.surface }}
            contentStyle={CHART.tooltip}
            labelStyle={{ color: CHART.ink, fontWeight: 600 }}
            itemStyle={{ color: CHART.ink2 }}
            formatter={(v: number) => [`${v}% equity, ${100 - v}% debt`, "Suggested"]}
          />
          <Bar dataKey="equity" radius={[6, 6, 6, 6]} isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.barDuration}>
            {steps.map((s, i) => <Cell key={i} fill={i === 0 ? CHART.accent : CHART.surface2} />)}
          </Bar>
          {now != null && (
            <ReferenceLine y={Math.round(now)} stroke={CHART.ink} strokeDasharray="4 3" strokeWidth={1.5}
              label={{ value: `Yours now ${Math.round(now)}%`, position: "insideTopRight", fill: CHART.ink, fontSize: 12, fontWeight: 700 }} />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

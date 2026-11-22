"use client";

/*
 * One goal's story on one chart:
 *  - the money it really had, week by week (a stepped line with the dips);
 *  - the plan (no setbacks, or expected returns) as a faint dashed line;
 *  - pins where life happened (🏥 −₹30k, 🏖️ skipped, 🎉 +₹25k, 📉 −10%);
 *  - from today, the range of outcomes to the date, and the 🎯 target;
 *  - the date first planned and the date now, when it slipped.
 *
 * The time axis gives the past at least ~40% of the width, so a long goal
 * (a home in 2033) still shows what happened this year.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Area, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { addMonths, type Band } from "@/lib/wealth";

import type { GoalStory, Pin, Pt } from "./story";
import { useChartMotion } from "./parts";
import { dayMonYear, monYear, rupees, short } from "./words";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const T = (iso: string) => Date.parse(iso);

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

/** Past gets 42 to 62% of the width; the future the rest. */
function makeX(start: string, asOf: string, end: string) {
  const a = T(start), n = T(asOf), e = T(end);
  const natural = (n - a) / Math.max(1, e - a);
  const P = Math.min(0.62, Math.max(0.42, natural));
  const x = (iso: string) => {
    const v = T(iso);
    return v <= n ? ((v - a) / Math.max(1, n - a)) * P : P + ((v - n) / Math.max(1, e - n)) * (1 - P);
  };
  return { x, P };
}

interface Row {
  x: number;
  date: string;
  future: boolean;
  actual?: number;
  plan?: number;
  range?: [number, number];
  p50?: number;
  alt?: number;
}

function ticksFor(start: string, asOf: string, end: string, x: (iso: string) => number, narrow: boolean) {
  const out: { x: number; label: string }[] = [];
  const push = (iso: string, label: string) => out.push({ x: x(iso), label });
  const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
  // Past: every quarter.
  for (let d = firstOfMonth(addMonths(start, 1)); d < asOf; d = addMonths(d, 1)) {
    const m = Number(d.slice(5, 7)) - 1;
    if (m % 3 === 0) push(d, m === 0 ? `Jan ${d.slice(2, 4)}` : MON[m]);
  }
  // Future: quarters for under two years, then Januaries (every other for long goals).
  const years = (T(end) - T(asOf)) / (365 * 864e5);
  for (let d = firstOfMonth(addMonths(asOf, 1)); d <= end; d = addMonths(d, 1)) {
    const m = Number(d.slice(5, 7)) - 1;
    const y = Number(d.slice(0, 4));
    if (years <= 2 ? m % 3 === 0 : m === 0 && (years <= 5 || y % 2 === 0)) {
      push(d, years <= 2 ? (m === 0 ? `Jan ${d.slice(2, 4)}` : MON[m]) : String(y));
    }
  }
  const gap = narrow ? 0.13 : 0.07;
  const kept: typeof out = [];
  for (const t of out) if (!kept.length || t.x - kept[kept.length - 1].x >= gap) kept.push(t);
  return kept;
}

/** ₹50k, ₹1.5L, ₹20L: one decimal only when it matters. */
function yLabel(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1).replace(/\.0$/, "")}L`;
  if (n >= 1e3) return `₹${Math.round(n / 1e3)}k`;
  return `₹${Math.round(n)}`;
}

function niceLogTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = 3; p <= 9; p++) for (const k of [1, 2, 5]) {
    const v = k * 10 ** p;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out;
}

export interface StoryChartProps {
  story: GoalStory;
  bands: Band[];
  target: number;
  targetDate: string;
  plannedDate?: string;
  asOf: string;
  color: string;
  height?: number;
  showHit?: boolean;
}

export default function StoryChart({
  story, bands, target, targetDate, plannedDate, asOf, color, height = 260, showHit = false,
}: StoryChartProps) {
  const animate = useChartMotion();
  const narrow = useNarrow();

  const model = useMemo(() => {
    const endBase = [targetDate, plannedDate].filter(Boolean).sort().at(-1)!;
    // A little room after the date, so its label and the end of the fan breathe.
    const span = T(endBase) - T(story.start);
    const end = new Date(T(endBase) + span * 0.03).toISOString().slice(0, 10);
    const { x, P } = makeX(story.start, asOf, end);

    const rows = new Map<string, Row>();
    const at = (date: string): Row => {
      let r = rows.get(date);
      if (!r) { r = { x: x(date), date, future: date > asOf }; rows.set(date, r); }
      return r;
    };
    for (const p of story.past) at(p.date).actual = p.value;
    for (const p of story.planPast) at(p.date).plan = p.value;
    // The plan line stops where it reaches the target: that's the plan's date.
    for (const p of story.planFwd) {
      if (p.date > endBase) break;
      at(p.date).plan = p.value;
      if (p.value >= target) break;
    }
    for (const b of bands) {
      const r = at(b.month === 0 ? asOf : addMonths(asOf, b.month));
      r.range = [b.p10, b.p90];
      r.p50 = b.p50;
    }
    if (showHit && story.hit) for (const p of story.hit.path) if (p.date <= endBase) at(p.date).alt = p.value;
    const data = Array.from(rows.values()).sort((a, b) => a.x - b.x);

    const vals = data.flatMap((r) => [r.actual, r.plan, r.range?.[0], r.range?.[1], r.alt]).filter((v): v is number => v != null && v > 0);
    const lo = Math.min(...vals, target);
    const hi = Math.max(...vals, target);
    // Log scale only when today's money is a sliver of the target (a home
    // fund), so this year's dips still show; otherwise plain rupees.
    const now = story.past[story.past.length - 1]?.value ?? lo;
    const log = target / Math.max(1, now) > 6;
    let domain: [number, number] = log ? [lo * 0.72, hi * 1.25] : [0, hi * 1.1];
    let yTicks: number[];
    if (log) yTicks = niceLogTicks(domain[0], domain[1]);
    else {
      const stepY = [1e3, 2e3, 2.5e3, 5e3, 1e4, 2e4, 2.5e4, 5e4, 1e5, 2e5, 2.5e5, 5e5, 1e6, 2e6, 2.5e6, 5e6, 1e7].find((k) => domain[1] / k <= 5) ?? 1e7;
      const top = Math.ceil(domain[1] / stepY) * stepY;
      domain = [0, top];
      yTicks = Array.from({ length: Math.round(top / stepY) + 1 }, (_, i) => i * stepY);
    }

    // Pins: setbacks hang below the path, boosts sit above; close ones stack.
    const pins = story.pins.slice().sort((a, b) => a.date.localeCompare(b.date));
    const levels: number[] = [];
    const lastX: Record<"up" | "down", { x: number; level: number } | null> = { up: null, down: null };
    for (const p of pins) {
      const side = p.kind === "boost" ? "up" : "down";
      const px = x(p.date);
      const prev = lastX[side];
      const level = prev && px - prev.x < (narrow ? 0.2 : 0.1) ? prev.level + 1 : 0;
      levels.push(level);
      lastX[side] = { x: px, level };
    }

    const ticks = ticksFor(story.start, asOf, end, x, narrow);
    return { data, x, P, domain, log, yTicks, pins, levels, ticks, end };
  }, [story, bands, target, targetDate, plannedDate, asOf, showHit, narrow]);

  const { data, x, P, domain, log, yTicks, pins, levels, ticks } = model;
  // Monthly steps read as real contributions over a year or three; over
  // longer spans they turn into fuzz, so the range is drawn smooth there.
  const fanType = (bands.at(-1)?.month ?? 0) > 36 ? "monotone" : "stepAfter";
  const tickLabel = new Map(ticks.map((t) => [t.x, t.label]));
  const etaPlanX = story.etaPlan && story.etaPlan <= targetDate && story.etaPlan > asOf ? x(story.etaPlan) : null;
  const etaX = story.etaActual && story.etaActual <= model.end && story.etaActual > asOf ? x(story.etaActual) : null;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 22, right: narrow ? 8 : 14, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="x" type="number" domain={[0, 1]} ticks={ticks.map((t) => t.x)} interval={0}
            tickLine={false} axisLine={{ stroke: CHART.line }}
            tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }}
            tickFormatter={(v: number) => tickLabel.get(v) ?? ""}
          />
          <YAxis
            type="number" scale={log ? "log" : "auto"} domain={domain} ticks={yTicks} allowDataOverflow
            width={narrow ? 44 : 52} tickLine={false} axisLine={false}
            tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }} tickFormatter={yLabel}
          />
          <Tooltip
            cursor={{ stroke: CHART.line, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const r = active && (payload?.[0]?.payload as Row | undefined);
              if (!r) return null;
              return <Tip row={r} pins={story.pins} hitLabel={story.hit ? `${story.hit.emoji} ${story.hit.label}` : ""} />;
            }}
          />

          {/* Today, the date planned, the date now */}
          <ReferenceLine x={P} stroke={CHART.line} strokeWidth={1.5}
            label={{ value: "Today", position: "top", fill: CHART.muted, fontSize: 11, fontWeight: 700 }} />
          {plannedDate && plannedDate !== targetDate && (
            <ReferenceLine x={x(plannedDate)} stroke={CHART.faint} strokeDasharray="2 4" strokeWidth={1.5}
              label={{ value: `planned ${MON[Number(plannedDate.slice(5, 7)) - 1]}`, position: "insideBottomRight", fill: CHART.faint, fontSize: 11, fontWeight: 700, offset: 6 }} />
          )}
          <ReferenceLine x={x(targetDate)} stroke={CHART.ink2} strokeWidth={1.25}
            label={{ value: `${MON[Number(targetDate.slice(5, 7)) - 1]} ${targetDate.slice(2, 4)}`, position: "insideTopRight", offset: 4, fill: CHART.ink2, fontSize: 11, fontWeight: 700 }} />
          <ReferenceLine y={target} stroke={CHART.ink2} strokeDasharray="5 4" strokeWidth={1.25}
            label={{ value: `🎯 ${short(target)}`, position: "insideTopLeft", fill: CHART.ink2, fontSize: 12, fontWeight: 700 }} />

          {/* The future: range, likely, and the what-if */}
          <Area dataKey="range" type={fanType} stroke="none" fill={color} fillOpacity={0.16} connectNulls
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
          <Line dataKey="p50" type={fanType} stroke={color} strokeOpacity={0.75} strokeWidth={1.75} dot={false} activeDot={false} connectNulls
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />
          {/* The plan */}
          <Line dataKey="plan" type="stepAfter" stroke={CHART.faint} strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} connectNulls
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />
          {showHit && (
            <Line dataKey="alt" type="stepAfter" stroke={CHART.warning} strokeWidth={2} strokeDasharray="2 3" dot={false} activeDot={false} connectNulls
              isAnimationActive={false} />
          )}
          {/* What really happened */}
          <Line dataKey="actual" type="stepAfter" stroke={color} strokeWidth={2.75} dot={false} connectNulls
            activeDot={{ r: 4, fill: color, stroke: CHART.card, strokeWidth: 2 }}
            isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />

          {/* Where the plan and the actual path reach the target */}
          {etaPlanX != null && (
            <ReferenceDot x={etaPlanX} y={target} r={4.5} fill={CHART.card} stroke={CHART.faint} strokeWidth={2} />
          )}
          {etaX != null && (
            <ReferenceDot x={etaX} y={target} r={4.5} fill={color} stroke={CHART.card} strokeWidth={2} />
          )}

          {pins.map((p, i) => (
            <ReferenceDot
              key={`${p.date}-${i}`}
              x={x(p.date)}
              y={p.value}
              r={4}
              ifOverflow="visible"
              shape={(props: { cx?: number; cy?: number }) => <PinMark cx={props.cx ?? 0} cy={props.cy ?? 0} pin={p} level={levels[i]} color={color} edge={x(p.date) < 0.06} />}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function PinMark({ cx, cy, pin, level, color, edge }: { cx: number; cy: number; pin: Pin; level: number; color: string; edge: boolean }) {
  const up = pin.kind === "boost";
  const text = `${pin.emoji} ${pin.text}`;
  // Emoji counts as ~1.6 characters wide.
  const w = Math.round(pin.text.length * 6.6 + 30);
  // Close pins sit side by side (stacking down would hit the axis).
  const dy = (up ? -1 : 1) * 22;
  const shift = level * (w + 6);
  const y = cy + dy;
  // At the very start of the axis, hang the label to the right so it isn't cut off.
  const lx = (edge ? cx + w / 2 - 8 : cx) + shift;
  const tone = pin.kind === "boost" ? CHART.success : pin.kind === "pause" ? CHART.faint : CHART.danger;
  return (
    <g aria-label={`${pin.label} ${pin.text}`}>
      <line x1={cx} y1={cy} x2={lx} y2={y + (up ? 9 : -9)} stroke={tone} strokeWidth={1.25} />
      <rect x={lx - w / 2} y={y - 10} width={w} height={20} rx={10} fill={CHART.card} stroke={tone} strokeWidth={1.25} />
      <text x={lx} y={y + 1} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 11, fontWeight: 700, fill: CHART.ink }}>{text}</text>
      <circle cx={cx} cy={cy} r={4} fill={CHART.card} stroke={color} strokeWidth={2} />
    </g>
  );
}

function Tip({ row, pins, hitLabel }: { row: Row; pins: Pin[]; hitLabel: string }) {
  const near = pins.filter((p) => Math.abs(T(p.date) - T(row.date)) <= 4 * 864e5);
  const line = (label: string, v?: number, strong = false) => v == null ? null : (
    <p style={{ color: CHART.ink2 }}>{label} <b style={{ color: strong ? CHART.ink : CHART.ink2 }}>{rupees(v)}</b></p>
  );
  return (
    <div style={CHART.tooltip}>
      <p style={{ fontWeight: 700, color: CHART.ink, marginBottom: 4 }}>{row.future ? monYear(row.date) : dayMonYear(row.date)}</p>
      {near.map((p) => (
        <p key={p.date + p.label} style={{ color: CHART.ink, fontWeight: 600 }}>{p.emoji} {p.label} {p.kind !== "pause" && p.amount !== 0 ? `${p.amount > 0 ? "+" : "−"}${rupees(Math.abs(p.amount))}` : ""}</p>
      ))}
      {line("Saved", row.actual, true)}
      {row.future && row.p50 != null && line("Likely", row.p50, true)}
      {row.future && row.range && (
        <p style={{ color: CHART.muted, fontSize: 13 }}>{short(row.range[0])} to {short(row.range[1])} in bad to good markets</p>
      )}
      {line("Plan", row.plan)}
      {row.alt != null && <p style={{ color: CHART.ink2 }}>{hitLabel} <b>{rupees(row.alt)}</b></p>}
    </div>
  );
}

export type { Pt };

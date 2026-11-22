"use client";

/*
 * Net worth over the last year (as far back as statements go), one point a
 * week so the salary sawtooth doesn't hide the trend. The y-axis hugs the
 * data, so real growth shows. Emoji pins mark the big moments: 🎉 bonus,
 * 📱 a gadget, ✈️ a trip, 📉 a market dip.
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Area, ComposedChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardTitle, Skeleton } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { DayPoint, Marker, WealthView } from "@/lib/wealth";

import { dayMon, mon, niceTicks, shortInr } from "@/components/wealth/chartKit";
import { dayMonth, humanInr } from "../fmt";
import { weeklyClose } from "./smooth";

type Pt = DayPoint & { marks: Marker[] };

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Pt }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="min-w-[190px] rounded-s bg-card px-3.5 py-2.5 shadow-float">
      <p className="text-[12px] font-semibold text-muted">Week to {dayMon(p.date)}</p>
      <p className="mt-0.5 text-[15px] font-extrabold tabular-nums text-ink">{inr(p.netWorth)}</p>
      <p className="mt-1 flex justify-between gap-3 text-[12px] text-ink-2"><span>Bank</span><span className="tabular-nums">{shortInr(p.cash)}</span></p>
      {p.investments > 0 && <p className="flex justify-between gap-3 text-[12px] text-ink-2"><span>Investments</span><span className="tabular-nums">{shortInr(p.investments)}</span></p>}
      {p.marks.map((m) => (
        <p key={m.date + m.label} className="mt-1 text-[12px] font-semibold text-ink-2">{m.emoji} {m.label} <span className="font-medium text-muted">{shortInr(m.amount, true)}, {dayMon(m.date)}</span></p>
      ))}
    </div>
  );
}

export default function NetWorthTrendCard({ w, daily, className }: { w: WealthView; daily: DayPoint[]; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const pts: Pt[] = useMemo(() => {
    const weeks = weeklyClose(daily.slice(-366)).map((p) => ({ ...p, marks: [] as Marker[] }));
    if (!weeks.length) return weeks;
    const floor = Math.max(15000, w.usual.income * 0.15);
    const first = weeks[0].date, end = weeks[weeks.length - 1].date;
    // The biggest moments only, so pins explain the line instead of covering it.
    const big = w.markers
      .filter((m) => m.date >= first && m.date <= end && m.emoji !== "•" && Math.abs(m.amount) >= floor)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 6);
    for (const m of big) {
      const target = weeks.find((p) => p.date >= m.date) ?? weeks[weeks.length - 1];
      target.marks.push(m);
    }
    return weeks;
  }, [daily, w.markers, w.usual.income]);

  if (w.isLoading && !pts.length) {
    return <Card className={className}><Skeleton className="h-5 w-48" /><Skeleton className="mt-5 h-[200px] w-full" /></Card>;
  }
  if (pts.length < 3) {
    return (
      <Card className={className}>
        <CardTitle>Net worth</CardTitle>
        <p className="mt-3 text-sm font-medium text-muted">A few weeks of statements will draw the trend here.</p>
      </Card>
    );
  }

  const first = pts[0], last = pts[pts.length - 1];
  const change = last.netWorth - first.netWorth;
  const vals = pts.map((p) => p.netWorth);
  const lo0 = Math.min(...vals), hi0 = Math.max(...vals);
  const span = Math.max(1, hi0 - lo0);
  const ticks = niceTicks(lo0 - span * 0.08, hi0 + span * 0.08, 3);
  const domain: [number, number] = [Math.min(ticks[0] ?? lo0, lo0 - span * 0.08), Math.max(ticks[ticks.length - 1] ?? hi0, hi0 + span * 0.22)];
  const monthTicks = pts.filter((p, i) => i > 0 && p.date.slice(0, 7) !== pts[i - 1].date.slice(0, 7)).map((p) => p.date);
  const pins = pts.filter((p) => p.marks.length);

  return (
    <Card className={`flex h-full flex-col ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h3 font-black text-ink">
            Net worth {change >= 0 ? "up" : "down"} {humanInr(Math.abs(change))}
          </h2>
          <p className="mt-1 text-sm font-medium text-muted">since {dayMonth(first.date)} · weekly</p>
        </div>
        <Link href="/wealth" className="-my-2 inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-pill px-2 text-sm font-semibold text-accent-700 hover:underline">
          Wealth <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Link>
      </div>
      <div className="relative mt-4 min-h-[220px] flex-1" role="img"
        aria-label={`Net worth went from ${inr(first.netWorth)} on ${dayMon(first.date)} to ${inr(last.netWorth)}. ${pins.flatMap((p) => p.marks).map((m) => `${m.label} ${dayMon(m.date)}`).join(", ")}`}>
        <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={pts} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="nwt-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART.accent} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={CHART.accent} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" ticks={monthTicks} interval={0} tickLine={false} axisLine={false}
                tick={{ fill: CHART.faint, fontSize: 11, fontWeight: 500 }} tickFormatter={(d: string) => mon(d)} />
              <YAxis orientation="right" width={48} domain={domain} ticks={ticks} tickLine={false} axisLine={false} allowDataOverflow
                tick={{ fill: CHART.faint, fontSize: 11, fontWeight: 500 }} tickFormatter={(v: number) => shortInr(v)} />
              <Tooltip content={<Tip />} cursor={{ stroke: CHART.line, strokeWidth: 1 }} />
              <Area dataKey="netWorth" type="monotone" stroke={CHART.accent} strokeWidth={2.25} fill="url(#nwt-fill)"
                activeDot={{ r: 4, fill: CHART.accent, stroke: CHART.card, strokeWidth: 2 }}
                isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
              {pins.map((p) => (
                <ReferenceDot key={p.date} x={p.date} y={p.netWorth} r={0} ifOverflow="visible"
                  shape={(props: { cx?: number; cy?: number }) => (
                    <g pointerEvents="none">
                      <line x1={props.cx} x2={props.cx} y1={(props.cy ?? 0) - 4} y2={(props.cy ?? 0) - 16} stroke={CHART.faint} strokeWidth={1} />
                      <circle cx={props.cx} cy={props.cy} r={3} fill={CHART.card} stroke={CHART.ink2} strokeWidth={1.5} />
                      <text x={props.cx} y={(props.cy ?? 0) - 20} textAnchor="middle" fontSize={15}>{p.marks.map((m) => m.emoji).join("")}</text>
                    </g>
                  )} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}

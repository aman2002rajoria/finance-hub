"use client";

/*
 * Income vs living spend, month by month (last 6). Under each month, the
 * share saved or invested, so a good month and a bad month read at a glance
 * without a second axis. The partial month is hatched; a month with a big
 * one-off wears its emoji above the bars.
 */

import { useMemo } from "react";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useMonthly, useMonthlyByCategory } from "@/lib/api";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { Marker } from "@/lib/wealth";

import { shortInr } from "@/components/wealth/chartKit";
import { BarsSkeleton, StatefulCard } from "../cardStates";
import { humanInr } from "../fmt";
import { oneOffs } from "./homeData";
import { monthShort } from "./parts";

interface Row {
  period: string;
  income: number;
  spent: number;
  invested: number;
  rate: number | null;
  partial: boolean;
  marks: Marker[];
}

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const saved = r.income - r.spent - r.invested;
  const line = (k: string, v: string, cls = "text-ink-2") => (
    <p className={`flex justify-between gap-4 text-[13px] ${cls}`}><span>{k}</span><span className="tabular-nums">{v}</span></p>
  );
  return (
    <div className="min-w-[200px] rounded-s bg-card px-3.5 py-2.5 shadow-float">
      <p className="mb-1 text-[13px] font-extrabold text-ink">{monthShort(r.period)} {r.period.slice(0, 4)}{r.partial ? ", so far" : ""}</p>
      {line("Came in", inr(r.income))}
      {line("Spent", inr(r.spent))}
      {line("Invested", inr(r.invested))}
      {line("Saved in bank", `${saved < 0 ? "−" : ""}${inr(Math.abs(saved))}`)}
      {r.rate != null && line("Saved or invested", `${r.rate}%`, "mt-1 border-t border-line pt-1 font-extrabold text-ink")}
      {r.marks.map((m) => (
        <p key={m.date + m.label} className="mt-1 text-[12px] font-medium text-muted">{m.emoji} {m.label} {humanInr(Math.abs(m.amount))}</p>
      ))}
    </div>
  );
}

export default function IncomeSpendCard({
  markers, usualIncome, partialPeriod, selected, className,
}: {
  markers: Marker[];
  usualIncome: number;
  partialPeriod: string | null;
  selected: string | null;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const mon = useMonthly();
  const byCat = useMonthlyByCategory(50);

  const rows: Row[] = useMemo(() => {
    if (!Array.isArray(mon.data) || !Array.isArray(byCat.data)) return [];
    const inv = new Map<string, number>();
    for (const r of byCat.data as { period: string; category: string; amount: number }[]) {
      if (r.category === "Investments") inv.set(r.period, (inv.get(r.period) ?? 0) + r.amount);
    }
    return mon.data.slice(-6).map((m) => {
      const invested = inv.get(m.period) ?? 0;
      const spent = Math.max(0, m.spend - invested);
      const o = oneOffs(markers, [m.period], usualIncome);
      return {
        period: m.period,
        income: m.income,
        spent,
        invested,
        rate: m.income > 0 ? Math.round(((m.income - spent) / m.income) * 100) : null,
        partial: m.period === partialPeriod,
        marks: [...o.income, ...o.spend],
      };
    });
  }, [mon.data, byCat.data, markers, usualIncome, partialPeriod]);

  const loading = (!mon.data && !mon.error) || (!byCat.data && !byCat.error);
  const error = (mon.error && !mon.data) || (byCat.error && !byCat.data) ? (mon.error ?? byCat.error) : null;
  const byPeriod = new Map(rows.map((r) => [r.period, r]));

  const Tick = ({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) => {
    const r = payload ? byPeriod.get(payload.value) : undefined;
    if (!r || x == null || y == null) return null;
    const sel = r.period === selected;
    return (
      <g transform={`translate(${x},${y})`}>
        <text y={12} textAnchor="middle" fontSize={12} fontWeight={sel ? 800 : 600} fill={sel ? CHART.ink : CHART.muted}>
          {monthShort(r.period)}{r.partial ? "*" : ""}
        </text>
        {r.rate != null && (
          <text y={29} textAnchor="middle" fontSize={12} fontWeight={800} fill={r.rate >= 0 ? CHART.accent700 : CHART.dangerText}>{r.rate}%</text>
        )}
      </g>
    );
  };

  const Emoji = (p: { x?: number | string; y?: number | string; width?: number | string; index?: number }) => {
    const r = rows[p.index ?? -1];
    if (!r?.marks.length) return null;
    const x = Number(p.x) + Number(p.width ?? 0);
    return (
      <text x={x} y={Number(p.y) - 8} textAnchor="middle" fontSize={15}>
        {r.marks.map((m) => m.emoji).join("")}
      </text>
    );
  };

  return (
    <StatefulCard
      className={className}
      title="Came in vs spent"
      action={
        <div className="hidden flex-wrap gap-x-3 text-[12px] font-medium text-muted sm:flex" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-faint" />Came in</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-ink-2" />Spent</span>
          <span className="inline-flex items-center gap-1.5 font-semibold text-accent-700">% saved or invested</span>
        </div>
      }
      loading={loading}
      error={error}
      onRetry={() => { mon.mutate(); byCat.mutate(); }}
      empty={!loading && rows.length === 0}
      emptyTitle="No months yet"
      what="income and spending by month"
      skeleton={<BarsSkeleton bars={6} height={260} />}
    >
      <div className="h-[268px] w-full" role="img"
        aria-label={rows.map((r) => `${monthShort(r.period)}: came in ${inr(r.income)}, spent ${inr(r.spent)}${r.rate != null ? `, ${r.rate}% saved or invested` : ""}`).join("; ")}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 26, right: 0, left: 0, bottom: 0 }} barGap={2} barCategoryGap="24%">
            <defs>
              <pattern id="is-hatch-in" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={CHART.faint} fillOpacity={0.35} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={CHART.faint} strokeWidth={3} />
              </pattern>
              <pattern id="is-hatch-sp" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={CHART.ink2} fillOpacity={0.3} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={CHART.ink2} strokeWidth={3} />
              </pattern>
            </defs>
            <XAxis dataKey="period" tickLine={false} axisLine={false} interval={0} height={40} tick={<Tick />} />
            <YAxis width={44} tickLine={false} axisLine={false} tickCount={4} tick={{ fill: CHART.faint, fontSize: 11, fontWeight: 500 }} tickFormatter={(v: number) => shortInr(v)} />
            <Tooltip content={<Tip />} cursor={{ fill: CHART.surface }} />
            <Bar dataKey="income" name="Came in" radius={[4, 4, 0, 0]} maxBarSize={34}
              isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.barDuration}>
              {rows.map((r) => <Cell key={r.period} fill={r.partial ? "url(#is-hatch-in)" : CHART.faint} />)}
              <LabelList dataKey="income" content={Emoji} />
            </Bar>
            <Bar dataKey="spent" name="Spent" radius={[4, 4, 0, 0]} maxBarSize={34}
              isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.barDuration}>
              {rows.map((r) => <Cell key={r.period} fill={r.partial ? "url(#is-hatch-sp)" : CHART.ink2} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {partialPeriod && rows.some((r) => r.partial) && (
        <p className="mt-2 text-[12px] font-medium text-muted">* {monthShort(partialPeriod)} so far</p>
      )}
    </StatefulCard>
  );
}


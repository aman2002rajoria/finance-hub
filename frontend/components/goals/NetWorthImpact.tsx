"use client";

/*
 * Net worth to retirement, with the goals paid for, against skipping them.
 * The retirement goal only counts the funds linked to it; the chart splits
 * net worth into that pot and everything else, so the two numbers agree
 * and the difference is visible.
 */

import { useMemo } from "react";
import {
  Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { Card, CardTitle } from "@/components/ui";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { fiNumber, goalEmoji, projectNetWorth, type WealthView } from "@/lib/wealth";

import type { OddsRow } from "./model";
import { useChartMotion } from "./parts";
import { axisRupees, rupees, short } from "./words";

export function useNetWorthPath(view: WealthView) {
  const { state, cash, asOf, liabilities } = view;
  return useMemo(
    () => projectNetWorth({ cash, holdings: state.holdings, liabilities, goals: state.goals, profile: state.profile, asOf }),
    [cash, state.holdings, liabilities, state.goals, state.profile, asOf],
  );
}

export default function NetWorthImpact({
  view, retirement, retireColor,
}: {
  view: WealthView;
  retirement?: OddsRow;
  retireColor?: string;
}) {
  const animate = useChartMotion();
  const profile = view.state.profile;
  const path = useNetWorthPath(view);

  const data = useMemo(() => {
    const bands = retirement?.odds.sim.bands ?? [];
    const potAt = (m: number) => {
      if (!bands.length) return 0;
      let best = bands[0];
      for (const b of bands) if (Math.abs(b.month - m) < Math.abs(best.month - m)) best = b;
      return best.p50;
    };
    return path.map((p) => {
      const pot = Math.max(0, Math.min(p.netWorth, potAt((p.age - profile.age) * 12)));
      return { ...p, pot, other: Math.max(0, p.netWorth - pot) };
    });
  }, [path, retirement, profile.age]);

  const end = data.at(-1);
  if (!end) return null;
  const need = retirement?.status.target ?? (view.monthlyExpenses > 0 ? fiNumber(view.monthlyExpenses, profile) : null);
  const potColor = retireColor ?? CHART.accent700;

  return (
    <Card>
      <CardTitle subtitle={`Everything you own, at expected returns, SIPs up ${profile.sipStepUpPct}% a year`}>
        Net worth at {profile.retireAge} · {short(end.netWorth)}
      </CardTitle>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium text-muted" aria-hidden>
        {retirement && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: potColor }} />{goalEmoji(retirement.goal)} Linked to retirement</span>}
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-accent-500" />{retirement ? "Everything else" : "Net worth"}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-faint" />Skip goals</span>
        {need && <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dotted border-ink-2" />Need</span>}
      </div>

      <div className="mt-3 h-[240px] md:h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false}
              tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }} ticks={ageTicks(profile.age, profile.retireAge)} />
            <YAxis width={56} tickLine={false} axisLine={false} tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }} tickFormatter={axisRupees} />
            <Tooltip
              cursor={{ stroke: CHART.line, strokeWidth: 1 }}
              contentStyle={CHART.tooltip}
              itemStyle={{ color: CHART.ink2, fontSize: 14 }}
              labelStyle={{ color: CHART.ink, fontWeight: 600, fontSize: 14, marginBottom: 2 }}
              labelFormatter={(a: number) => `Age ${a}`}
              formatter={(v: number, name: string) => [rupees(v), NAMES[name] ?? name]}
            />
            {need && (
              <ReferenceLine y={need} stroke={CHART.ink2} strokeDasharray="2 4" strokeWidth={1.5}
                label={{ value: `Need ${axisRupees(need)}`, position: "insideTopLeft", fill: CHART.muted, fontSize: 12, fontWeight: 600 }} />
            )}
            <Line dataKey="withoutGoals" type="monotone" stroke={CHART.faint} strokeWidth={2} strokeDasharray="5 5" dot={false} activeDot={false}
              isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration} />
            {retirement && (
              <Area dataKey="pot" stackId="nw" type="monotone" stroke={potColor} strokeWidth={2} fill={potColor} fillOpacity={0.35} dot={false}
                isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
            )}
            <Area dataKey={retirement ? "other" : "netWorth"} stackId="nw" type="monotone" stroke={CHART.accent} strokeWidth={3} fill={CHART.accent} fillOpacity={0.12} dot={false}
              activeDot={{ r: 4, fill: CHART.accent, stroke: CHART.card, strokeWidth: 2 }}
              isAnimationActive={animate} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <span className="sr-only">
        Net worth from age {profile.age} to {profile.retireAge}: about {rupees(end.netWorth)} with goals paid for, {rupees(end.withoutGoals)} without them.
        {retirement ? ` Of that, about ${rupees(end.pot)} is the money linked to retirement.` : ""}
      </span>
    </Card>
  );
}

const NAMES: Record<string, string> = {
  pot: "Linked to retirement",
  other: "Everything else",
  netWorth: "Net worth",
  withoutGoals: "If you skipped goals",
};

function ageTicks(from: number, to: number): number[] {
  const step = to - from > 20 ? 5 : to - from > 10 ? 2 : 1;
  const out = [from];
  for (let a = Math.ceil((from + 1) / step) * step; a < to; a += step) if (a - from >= step / 2) out.push(a);
  out.push(to);
  return out.filter((a, i, arr) => i === arr.length - 1 || to - a >= step / 2);
}

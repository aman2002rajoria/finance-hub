"use client";

/*
 * Investments, at a glance: what the portfolio is worth, the gain in ₹ and
 * %, the yearly return (XIRR), what went in during the chosen months, and a
 * small "worth vs put in" line. The detail lives on Wealth.
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, YAxis } from "recharts";

import { Card, Skeleton } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { DayPoint, WealthView } from "@/lib/wealth";

import { dayMon, shortInr } from "@/components/wealth/chartKit";
import { humanInr } from "../fmt";
import { weeklyClose } from "./smooth";

function Tip({ active, payload }: { active?: boolean; payload?: { payload: DayPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const g = p.investments - p.invested;
  return (
    <div className="min-w-[170px] rounded-s bg-card px-3 py-2 shadow-float">
      <p className="mb-1 text-[12px] font-semibold text-muted">Week to {dayMon(p.date)}</p>
      <p className="flex justify-between gap-3 text-[13px] text-ink-2"><span>Worth</span><span className="tabular-nums">{inr(p.investments)}</span></p>
      <p className="flex justify-between gap-3 text-[13px] text-ink-2"><span>Put in</span><span className="tabular-nums">{inr(p.invested)}</span></p>
      <p className={`flex justify-between gap-3 text-[13px] font-extrabold ${g >= 0 ? "text-success-text" : "text-danger-text"}`}>
        <span>Gain</span><span className="tabular-nums">{shortInr(g, true)}</span>
      </p>
    </div>
  );
}

export default function InvestmentsCard({ w, periods, scopeLabel }: { w: WealthView; periods: string[]; scopeLabel: string }) {
  const reduced = usePrefersReducedMotion();
  const t = w.totals;
  const pts = useMemo(() => weeklyClose(w.daily.slice(-365)), [w.daily]);
  const putIn = useMemo(() => {
    let bank = 0, epf = 0;
    for (const h of w.state.holdings) {
      for (const f of h.flows ?? []) {
        if (!periods.includes(f.date.slice(0, 7)) || f.amount <= 0) continue;
        if (h.kind === "epf") epf += f.amount; else bank += f.amount;
      }
    }
    return { bank, epf, total: bank + epf };
  }, [w.state.holdings, periods]);

  const head = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-h3 font-black text-ink">📈 Investments</h2>
      <Link href="/wealth" className="-my-2 inline-flex min-h-[44px] items-center gap-1 rounded-pill px-2 text-sm font-semibold text-accent-700 hover:underline">
        Wealth <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
      </Link>
    </div>
  );

  if (w.isLoading && !w.hasHoldings) {
    return (
      <Card className="h-full">
        {head}
        <Skeleton className="mt-4 h-9 w-40" />
        <Skeleton className="mt-3 h-4 w-56" />
        <Skeleton className="mt-5 h-[120px] w-full" />
      </Card>
    );
  }
  if (!w.hasHoldings) {
    return (
      <Card className="h-full">
        {head}
        <p className="mt-4 text-[22px] font-black text-ink">No investments added yet</p>
        <p className="mt-1 text-sm font-medium text-muted">Statements can't see funds, deposits or EPF.</p>
        <Link href="/wealth" className="btn ghost sm mt-5 self-start">Add investments</Link>
      </Card>
    );
  }

  const up = t.gain >= 0;
  return (
    <Card className="flex h-full flex-col">
      {head}
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <span className="text-[32px] font-black leading-none tracking-[-0.01em] tabular-nums text-ink md:text-[36px]">{humanInr(t.investments)}</span>
        <span className={`pb-0.5 text-[15px] font-extrabold tabular-nums ${up ? "text-success-text" : "text-danger-text"}`} title={`${inr(t.gain)} on ${inr(t.invested)} put in`}>
          {up ? "+" : "−"}{humanInr(Math.abs(t.gain))} ({up ? "+" : "−"}{Math.abs(t.gainPct).toFixed(1)}%)
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[13px] font-semibold tabular-nums">
        {w.xirrPct != null && (
          <span className="rounded-pill bg-accent-50 px-2.5 py-1 text-accent-700" title="XIRR: the yearly return, counting when each rupee went in">
            {w.xirrPct.toFixed(1)}% a year
          </span>
        )}
        {putIn.total > 0 && (
          <span
            className="rounded-pill bg-surface px-2.5 py-1 text-ink-2"
            title={`From the bank ${inr(putIn.bank)}${putIn.epf ? `, EPF from salary ${inr(putIn.epf)}` : ""}`}
          >
            +{humanInr(putIn.total)} added {scopeLabel}{putIn.epf ? ", incl. EPF" : ""}
          </span>
        )}
      </div>
      {pts.length > 2 && (
        <div className="relative mt-4 min-h-[120px] flex-1">
          <div className="absolute inset-0">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={pts} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                <YAxis hide domain={[(min: number) => min * 0.97, (max: number) => max * 1.01]} />
                <Tooltip content={<Tip />} cursor={{ stroke: CHART.line, strokeWidth: 1 }} />
                <Area
                  dataKey="investments" type="monotone" stroke={CHART.accent} strokeWidth={2} fill={CHART.accent} fillOpacity={0.12}
                  activeDot={{ r: 4, fill: CHART.accent, stroke: CHART.card, strokeWidth: 2 }}
                  isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.areaDuration}
                />
                <Line
                  dataKey="invested" type="stepAfter" stroke={CHART.ink2} strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false}
                  isAnimationActive={!reduced} animationBegin={CHART_ANIM.begin} animationDuration={CHART_ANIM.lineDuration}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-accent-500" />Worth</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-ink-2" />Put in</span>
      </div>
    </Card>
  );
}

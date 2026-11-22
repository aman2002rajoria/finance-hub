"use client";

/*
 * Investments, in one card: worth against money put in (axis from ₹0, so the
 * gain reads at its real size), the yearly return of each holding against a
 * plain FD (7%) and the Nifty (12%), and one passive-income figure.
 */

import clsx from "clsx";
import { Plus } from "lucide-react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardTitle } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import { KIND_EMOJI, KIND_LABEL, holdingXirr, type DayPoint, type Holding, type WealthView } from "@/lib/wealth";

import { dayMon, mon, niceTicks, shortInr } from "./chartKit";
import { shortName, signedPct } from "./words";

const FD_RATE = 7;
const NIFTY_RATE = 12;

/** Beating an FD means clearly above it, not 7.1% against 7%. */
const beats = (x: number) => x >= FD_RATE + 0.5;

function Tip({ active, payload }: { active?: boolean; payload?: { payload: DayPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const gain = p.investments - p.invested;
  return (
    <div className="min-w-[190px] rounded-s bg-card px-3.5 py-2.5 shadow-float">
      <p className="mb-1 text-[13px] font-semibold text-muted">{dayMon(p.date)}</p>
      <p className="flex justify-between gap-3 text-[13px] text-ink-2"><span>Worth</span><span className="tabular-nums">{inr(p.investments)}</span></p>
      <p className="flex justify-between gap-3 text-[13px] text-ink-2"><span>Put in</span><span className="tabular-nums">{inr(p.invested)}</span></p>
      <p className={`mt-1 flex justify-between gap-3 border-t border-line pt-1 text-[13px] font-extrabold ${gain >= 0 ? "text-success-text" : "text-danger-text"}`}>
        <span>Gain</span><span className="tabular-nums">{gain >= 0 ? "+" : "−"}{inr(Math.abs(gain))}</span>
      </p>
    </div>
  );
}

function Figure({ label, value, tone, title }: { label: string; value: string; tone?: "good" | "bad"; title?: string }) {
  return (
    <div className="flex flex-col-reverse" title={title}>
      <dt className="mt-1 text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={clsx("text-[20px] font-black leading-none tabular-nums md:text-[22px]", tone === "good" ? "text-success-text" : tone === "bad" ? "text-danger-text" : "text-ink")}>
        {value}
      </dd>
    </div>
  );
}

export default function InvestmentsCard({
  daily, holdings, xirrPct, passive, onLogIncome,
}: {
  daily: DayPoint[];
  holdings: Holding[];
  xirrPct: number | null;
  passive: WealthView["passive"];
  onLogIncome: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const worth = holdings.reduce((s, h) => s + h.current, 0);
  const put = holdings.reduce((s, h) => s + h.invested, 0);
  const gain = worth - put;
  const gainPct = put > 0 ? (gain / put) * 100 : 0;

  // Weekly closes: the chart is about the gap, not daily wiggles.
  const pts = daily.filter((_, i) => (daily.length - 1 - i) % 7 === 0);
  const ticks = pts.filter((p, i) => i > 0 && Number(p.date.slice(8, 10)) <= 7).map((p) => p.date);
  const hi = Math.max(...pts.map((p) => Math.max(p.investments, p.invested)), 1);
  const yTicks = niceTicks(0, hi * 1.05, 4).filter((t) => t > 0);
  const yTop = Math.max(hi * 1.05, yTicks.at(-1) ?? 0);

  const rows = holdings
    .map((h) => ({ h, x: holdingXirr(h) }))
    .filter((r): r is { h: Holding; x: number } => r.x != null)
    .sort((a, b) => b.x - a.x);
  // An FD can't beat an FD: leave it out of the count.
  const judged = rows.filter((r) => r.h.kind !== "fd");
  const beat = judged.filter((r) => beats(r.x)).length;
  const max = Math.max(16, ...rows.map((r) => r.x)) * 1.05;
  const at = (v: number) => `${(Math.max(0, v) / max) * 100}%`;
  const passiveTip = [
    passive.byKind.interest > 0 && `Interest ${inr(passive.byKind.interest)}`,
    passive.byKind.dividend > 0 && `Dividends ${inr(passive.byKind.dividend)}`,
  ].filter(Boolean).join(" · ");

  return (
    <Card>
      <CardTitle
        action={
          <button
            type="button"
            onClick={onLogIncome}
            className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-sm font-semibold text-accent-700 hover:bg-surface"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />Log income
          </button>
        }
      >
        {gain >= 0 ? `${shortInr(gain)} ahead of what you put in` : `${shortInr(-gain)} below what you put in`}
      </CardTitle>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        <Figure label="Worth" value={shortInr(worth)} />
        <Figure label="Put in" value={shortInr(put)} />
        <Figure label="Gain" value={signedPct(gainPct)} tone={gain >= 0 ? "good" : "bad"} />
        {xirrPct != null && <Figure label="A year (XIRR)" value={`${xirrPct.toFixed(1)}%`} title="Yearly return, counting when each rupee went in" />}
        <Figure label="Paid to you, 12 mo" value={passive.total > 0 ? `💸 ${shortInr(passive.total)}` : "₹0"} title={passiveTip || "Interest, coupons and dividends. Booked gains aren't counted."} />
      </dl>

      <div className="mt-5 grid gap-x-8 gap-y-6 min-[900px]:grid-cols-12">
        <div className="min-w-0 min-[900px]:col-span-7">
          <p className="text-[13px] font-semibold text-ink-2">Worth vs put in</p>
          {pts.length > 1 ? (
            <div className="mt-2 h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={pts} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="date" ticks={ticks} interval={0} tickLine={false} axisLine={false}
                    tick={{ fill: CHART.faint, fontSize: 11, fontWeight: 500 }} tickFormatter={(d: string) => mon(d)}
                  />
                  <YAxis
                    orientation="right" width={46} domain={[0, yTop]} ticks={yTicks} tickLine={false} axisLine={false}
                    tick={{ fill: CHART.faint, fontSize: 11, fontWeight: 500 }} tickFormatter={(v: number) => shortInr(v)}
                  />
                  <Tooltip content={<Tip />} cursor={{ stroke: CHART.line, strokeWidth: 1 }} />
                  <Area
                    dataKey="investments" type="monotone" stroke={CHART.accent} strokeWidth={2} fill={CHART.accent} fillOpacity={0.14}
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
          ) : (
            <p className="mt-3 text-sm text-muted">A month of history draws this.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium text-muted" aria-hidden>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-accent-500" />Worth</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-ink-2" />Put in</span>
          </div>
        </div>

        <div className="min-w-0 min-[900px]:col-span-5">
          <p className="text-[13px] font-semibold text-ink-2">
            {judged.length ? `${beat} of ${judged.length} beat a plain FD` : "Yearly return by holding"}
          </p>
          {rows.length ? (
            <div className="relative mt-7">
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[calc(38%+8px)] right-[52px] sm:left-[calc(34%+8px)]">
                {[
                  { v: FD_RATE, label: `FD ${FD_RATE}%` },
                  { v: NIFTY_RATE, label: `Nifty ${NIFTY_RATE}%` },
                ].map((r) => (
                  <div key={r.v} className="absolute -top-5 bottom-0" style={{ left: at(r.v) }}>
                    <span className={clsx("absolute whitespace-nowrap text-[11px] font-semibold text-muted", r.v === FD_RATE ? "-translate-x-full pr-1" : "pl-1")}>{r.label}</span>
                    <span className="absolute bottom-0 top-4 w-0 border-l border-dashed border-faint" />
                  </div>
                ))}
              </div>
              <ul className="space-y-1.5 pt-2">
                {rows.map(({ h, x }, i) => {
                  const win = h.kind !== "fd" && beats(x);
                  return (
                    <li key={h.id} className="flex items-center gap-2" title={`${h.name}: ${x.toFixed(1)}% a year on ${inr(h.invested)} put in`}>
                      <span className="flex w-[38%] min-w-0 items-center gap-1.5 sm:w-[34%]">
                        <span aria-hidden className="text-[14px]">{KIND_EMOJI[h.kind]}</span>
                        <span className="truncate text-[13px] font-semibold text-ink-2">{shortName(h.name)}</span>
                        <span className="sr-only">({KIND_LABEL[h.kind]})</span>
                      </span>
                      <span className="relative h-5 min-w-0 flex-1">
                        <span
                          className={clsx("absolute inset-y-0 left-0 rounded-l-[2px] rounded-r-[6px]", win ? "bg-accent-500" : "bg-surface-2", !reduced && "iv-grow")}
                          style={{ width: at(x), animationDelay: `${200 + i * 50}ms` }}
                        />
                      </span>
                      <span className={clsx("w-[44px] shrink-0 text-right text-[13px] font-extrabold tabular-nums", win ? "text-ink" : "text-muted")}>
                        {x.toFixed(1)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">Holdings older than six months show here.</p>
          )}
        </div>
      </div>
      <style>{`
        .iv-grow { transform-origin: left; animation: iv-grow .9s var(--spring) both; }
        @keyframes iv-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </Card>
  );
}

"use client";

/*
 * Building blocks shared by the three Overview variants (A, B, C).
 * Every card handles loading / empty / error itself (design.md §15) and
 * guards against missing fields so a half-loaded payload can't crash it.
 */

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useMemo } from "react";
import {
  Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import { useChartAnimProps } from "@/components/motion/ChartAnimation";
import { Card, Chip, EmptyState, ErrorCard, Skeleton } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useHeadline, useTopCounterparties } from "@/lib/api";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { DateRange, FinancialSnapshot } from "@/lib/types";

import { BarsSkeleton, RowsSkeleton, StatefulCard, errorMessage } from "../cardStates";
import { categoryLabel, humanInr, isUncategorised, plural } from "../fmt";
import type { BigExpense, MonthChange, MonthInsight, RecurringResp } from "./insightsApi";

// ---------------------------------------------------------------------------
// Words and dates
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-11" -> "November" */
export function monthLong(period?: string | null): string {
  const m = Number(period?.slice(5, 7));
  return MONTHS_LONG[m - 1] ?? "";
}

/** "2026-11" -> "Nov" */
export function monthShort(period?: string | null): string {
  const m = Number(period?.slice(5, 7));
  return MONTHS[m - 1] ?? "";
}

/** "2026-11" -> { date_from: "2026-11-01", date_to: "2026-11-30" } */
export function monthRange(period: string): DateRange {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return { date_from: `${period}-01`, date_to: `${period}-${String(last).padStart(2, "0")}` };
}

/** "2026-11-20" -> "20 Nov" */
export function shortDay(iso?: string | null): string {
  if (!iso) return "";
  const d = Number(iso.slice(8, 10));
  return `${d} ${monthShort(iso.slice(0, 7))}`;
}

/** Category name for sentences. */
export function catName(c: string): string {
  return isUncategorised(c) ? "Untagged spend" : categoryLabel(c);
}

const CITY = /\s+(bangalore|bengaluru|gurgaon|gurugram|mumbai|delhi|new delhi|noida|pune|hyderabad|chennai|kolkata)$/i;

/**
 * Statement merchant strings, made readable: "ZERODHA BROKING LTD" -> "Zerodha Broking",
 * "Makemytrip India Gurgaon In" -> "Makemytrip".
 */
export function prettyName(raw?: string | null): string {
  if (!raw) return "Unknown";
  let s = raw.trim();
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
  }
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\s+in$/i, "")
      .replace(CITY, "")
      .replace(/\s+(ltd|limited|pvt|private|india)\.?$/i, "")
      .trim();
  }
  return s || raw;
}

/** Money with a sign for differences: "+₹3,861" / "−₹2,222". */
export function signedInr(n: number): string {
  if (Math.abs(n) < 0.5) return "₹0";
  return `${n > 0 ? "+" : "−"}${inr(Math.abs(n))}`;
}

/** The answer in one plain sentence, with rounded human figures. */
export function headlineSentence(s?: FinancialSnapshot | null): string {
  const pe = s?.personal_economics;
  if (!pe) return "Where your money went";
  const months = s?.monthly_averages?.months ?? 0;
  const perMonth = months > 1;
  const spend = perMonth ? s!.monthly_averages.avg_spend : pe.net_personal_spend;
  const spent = `You spent ${humanInr(spend)}${perMonth ? " a month" : ""}`;
  if (pe.true_income <= 0) return `${spent}, with no income recorded in this range`;
  if (pe.savings < 0) {
    const over = perMonth ? -s!.monthly_averages.avg_saving : -pe.savings;
    return `${spent}, ${humanInr(over)} more than came in`;
  }
  return `${spent} and kept ${Math.round(pe.savings_rate_pct ?? 0)}% of what came in`;
}

/** "1–20 Nov" for a month in progress, "November" for a full one. */
export function monthSpan(m?: MonthInsight | null): string {
  if (!m?.period) return "";
  if (m.is_partial && m.days_elapsed) return `1–${m.days_elapsed} ${monthShort(m.period)}`;
  return monthLong(m.period);
}

/** The same days of the month before: "1–20 Oct" or "October". */
export function prevSpan(m?: MonthInsight | null): string {
  if (!m?.prev_period) return "";
  if (m.is_partial && m.days_elapsed) return `1–${m.days_elapsed} ${monthShort(m.prev_period)}`;
  return monthLong(m.prev_period);
}

/** "₹122 more than 1–20 Oct" with a calm "about the same" band of ±3%. */
export function paceWords(m?: MonthInsight | null): { diff: number; sentence: string; tone: "same" | "more" | "less" } | null {
  if (!m?.period || m.prev_same_point == null || m.total == null) return null;
  const diff = m.total - m.prev_same_point;
  const base = Math.max(1, Math.abs(m.prev_same_point));
  const by = m.is_partial ? `by ${m.days_elapsed ?? ""} ${monthShort(m.prev_period)}` : `in ${monthLong(m.prev_period)}`;
  if (Math.abs(diff) / base < 0.03) {
    return { diff, tone: "same", sentence: `About the same as ${by}, just ${inr(Math.abs(diff))} ${diff >= 0 ? "more" : "less"}.` };
  }
  return diff > 0
    ? { diff, tone: "more", sentence: `${inr(diff)} more than ${by}.` }
    : { diff, tone: "less", sentence: `${inr(-diff)} less than ${by}.` };
}

/** Lower-cases the first letter, for a sentence that follows a colon. */
export function lc(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** One plain sentence for one category's change. */
export function changeSentence(c: MonthChange): string {
  const up = c.delta > 0;
  const head = `${catName(c.category)} is ${up ? "up" : "down"} ${inr(Math.abs(c.delta))}`;
  const who = c.top_counterparty ? prettyName(c.top_counterparty) : null;
  const share = c.top_counterparty_share ?? 0;
  const md = Math.abs(c.top_counterparty_delta ?? 0);
  if (!who || md < 100) return `${head}.`;
  if (share >= 0.5 && share <= 1.05) return `${head}, mostly ${who}.`;
  if (share > 1.05) return `${head}. ${who} alone is ${up ? "up" : "down"} ${inr(md)}.`;
  return `${head}, spread across places. ${who} ${up ? "added" : "dropped"} the most, ${inr(md)}.`;
}

// ---------------------------------------------------------------------------
// Whole-page gate: no statements at all, or the server is down.
// ---------------------------------------------------------------------------

export function useHasStatements() {
  const all = useHeadline({});
  return {
    loading: !all.data && !all.error,
    error: all.error && !all.data ? all.error : null,
    empty: !!all.data && (all.data.total_txns ?? 0) === 0,
    retry: () => all.mutate(),
  };
}

export function NoStatements({ title = "Where your money went" }: { title?: string }) {
  return (
    <div className="space-y-8">
      <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">{title}</h1>
      <Card>
        <EmptyState
          illustration="stack of statements"
          title="No statements yet"
          hint="Upload PDF statements from your banks and cards. Finance Hub matches card bills and self-transfers, so what you see is what you really spent."
          action={<Link href="/upload" className="btn primary">Upload statements</Link>}
        />
      </Card>
    </div>
  );
}

export function PageError({ error, onRetry, title = "Where your money went" }: { error: unknown; onRetry: () => void; title?: string }) {
  return (
    <div className="space-y-8">
      <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">{title}</h1>
      <ErrorCard title="Your overview didn't load" message={errorMessage(error, "your overview")} onRetry={onRetry} />
    </div>
  );
}

/** KPI row skeleton in the final shape. */
export function KpiRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={clsx("grid grid-cols-2 gap-4", count === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3")} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={clsx("rounded-m bg-card p-5 shadow-flat", i === 0 && count === 3 && "col-span-2 lg:col-span-1")}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-8 w-32" />
          <Skeleton className="mt-3 h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

/** Section heading that is a question, with a one-line answer under it (variant C). */
export function QuestionHeading({ q, answer }: { q: string; answer?: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[26px] font-black leading-[1.15] tracking-[-0.005em] text-ink md:text-h2">{q}</h2>
      {answer ? (
        <p className="mt-2 max-w-[68ch] text-base text-ink-2 md:text-body-l">{answer}</p>
      ) : (
        <Skeleton className="mt-3 h-5 w-full max-w-[420px]" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What changed: plain sentences, category by category.
// ---------------------------------------------------------------------------

export function WhatChangedCard({
  q,
  title,
  showLead = true,
  showBiggest = false,
  className,
}: {
  q: { data?: MonthInsight; error?: unknown; isLoading: boolean; mutate: () => unknown };
  title?: string;
  /** The overall "₹X more than by 20 Oct" line. Off when a KPI already says it. */
  showLead?: boolean;
  /** Adds the month's biggest single expenses under the sentences. */
  showBiggest?: boolean;
  className?: string;
}) {
  const m = q.data;
  const lead = showLead ? paceWords(m) : null;
  const rows = useMemo(() => {
    const all = m?.changes ?? [];
    const floor = Math.max(300, (m?.prev_same_point ?? 0) * 0.01);
    return all.filter(c => Math.abs(c.delta) >= floor).slice(0, 4);
  }, [m]);
  const cardTitle = title ?? (m?.period ? `What changed in ${monthLong(m.period)}` : "What changed this month");
  const subtitle = m?.prev_period
    ? `${monthSpan(m)} against ${prevSpan(m)}, real spend by category`
    : undefined;

  return (
    <StatefulCard
      title={cardTitle}
      subtitle={subtitle}
      className={className}
      loading={q.isLoading && !m}
      error={q.error}
      onRetry={() => q.mutate()}
      what="what changed this month"
      empty={!!m && (!m.has_data || !m.prev_period)}
      emptyTitle={m?.has_data ? "Nothing to compare with yet" : "No spending yet"}
      emptyHint={m?.has_data
        ? `There's no statement for the month before ${monthLong(m?.period)}, so there's nothing to compare it with.`
        : "Once a statement is in, the month's changes show up here."}
      emptyIllustration="receipt"
      skeleton={<RowsSkeleton rows={4} />}
    >
      <div className={clsx(lead && "grid gap-6 md:grid-cols-12 md:gap-8")}>
        {lead && (
          <p className="text-[24px] font-black leading-[1.2] tracking-[-0.005em] text-ink md:col-span-5 md:text-[28px]">
            {monthLong(m?.period)} so far: {lc(lead.sentence)}
          </p>
        )}
        <div className={clsx(lead && "md:col-span-7")}>
          {rows.length === 0 ? (
            <p className="text-base text-ink-2">
              No category moved by more than {inr(300)}. Your spending pattern is steady.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map(c => {
                const up = c.delta > 0;
                const Icon = up ? ArrowUpRight : ArrowDownRight;
                return (
                  <li key={c.category} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span
                      aria-hidden
                      className={clsx(
                        "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full",
                        up ? "bg-surface text-ink-2" : "bg-accent-50 text-accent-700",
                      )}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <p className="min-w-0 flex-1 text-base text-ink-2">{changeSentence(c)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {showBiggest && <BiggestList items={m?.biggest} />}
    </StatefulCard>
  );
}

// ---------------------------------------------------------------------------
// Pace: running total this month against the month before.
// ---------------------------------------------------------------------------

export function PaceChart({ m, height = 240, compact = false }: { m: MonthInsight; height?: number; compact?: boolean }) {
  const anim = useChartAnimProps();
  const reduced = usePrefersReducedMotion();
  const active = !reduced && anim.isAnimationActive;
  const data = m.cumulative ?? [];
  const last = data.length;
  const ticks = compact ? [1, last] : [1, 8, 15, 22, last].filter((d, i, a) => d <= last && a.indexOf(d) === i);
  const thisLabel = monthShort(m.period);
  const prevLabel = monthShort(m.prev_period);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium text-muted" aria-hidden>
        <span className="inline-flex items-center gap-2">
          <span className="h-[3px] w-5 rounded-full bg-accent-500" />{monthLong(m.period)}
        </span>
        {m.prev_period && (
          <span className="inline-flex items-center gap-2">
            <span className="h-0 w-5 border-t-2 border-dashed border-faint" />{monthLong(m.prev_period)}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
          <XAxis
            dataKey="day"
            type="number"
            domain={[1, Math.max(2, last)]}
            ticks={ticks}
            interval={0}
            padding={{ left: 14, right: 14 }}
            tickLine={false}
            axisLine={false}
            tick={{ fill: CHART.faint, fontSize: 12, fontWeight: 500 }}
            tickFormatter={(d: number) => `${d} ${thisLabel}`}
          />
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            cursor={{ stroke: CHART.line, strokeWidth: 1 }}
            contentStyle={CHART.tooltip}
            itemStyle={{ color: CHART.ink2, fontSize: 14 }}
            labelStyle={{ color: CHART.ink, fontWeight: 600, fontSize: 14, marginBottom: 2 }}
            labelFormatter={(d: number) => `By day ${d}`}
            formatter={(v: number, name: string) => [inr(v), name === "this_month" ? monthLong(m.period) : monthLong(m.prev_period)]}
          />
          {m.prev_period && (
            <Line
              dataKey="last_month"
              name="last_month"
              type="monotone"
              stroke={CHART.faint}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              activeDot={false}
              connectNulls
              isAnimationActive={active}
              animationBegin={CHART_ANIM.begin}
              animationDuration={CHART_ANIM.lineDuration}
            />
          )}
          <Area
            dataKey="this_month"
            name="this_month"
            type="monotone"
            stroke={CHART.accent}
            strokeWidth={3}
            fill={CHART.accent}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, fill: CHART.accent, stroke: CHART.card, strokeWidth: 2 }}
            isAnimationActive={active}
            animationBegin={CHART_ANIM.begin}
            animationDuration={CHART_ANIM.areaDuration}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <span className="sr-only">
        Running total of real spend in {thisLabel}{m.prev_period ? ` against ${prevLabel}` : ""}, day by day.
      </span>
    </div>
  );
}

export function PaceCard({
  q,
  title,
  subtitle,
  height = 240,
  compact = false,
  showSentence = false,
  className,
}: {
  q: { data?: MonthInsight; error?: unknown; isLoading: boolean; mutate: () => unknown };
  title: string;
  subtitle?: string;
  height?: number;
  compact?: boolean;
  /** Puts the pace sentence above the chart (when no KPI says it). */
  showSentence?: boolean;
  className?: string;
}) {
  const m = q.data;
  const pace = paceWords(m);
  return (
    <StatefulCard
      title={title}
      subtitle={subtitle}
      className={className}
      loading={q.isLoading && !m}
      error={q.error}
      onRetry={() => q.mutate()}
      what="this month's pace"
      empty={!!m && (!m.has_data || !(m.cumulative ?? []).length)}
      emptyTitle="No spending this month yet"
      emptyHint="As statement lines come in, the running total for the month shows up here."
      emptyIllustration="coin jar with a leaf"
      skeleton={<Skeleton className="w-full" style={{ height: height + 28 }} />}
    >
      {showSentence && pace && m && (
        <p className="mb-4 text-base text-ink-2">
          <span className="font-extrabold text-ink">{inr(m.total ?? 0)}</span> by {shortDay(m.as_of)}, {lc(pace.sentence)}
        </p>
      )}
      {m && <PaceChart m={m} height={height} compact={compact} />}
    </StatefulCard>
  );
}

// ---------------------------------------------------------------------------
// Calendar heatmap of daily spend, with the biggest single expenses under it.
// ---------------------------------------------------------------------------

const LEVELS = ["bg-surface", "bg-accent-100", "bg-accent-200", "bg-accent-500", "bg-accent-600"] as const;

function levelFor(v: number, cuts: number[]): number {
  if (v <= 0) return 0;
  if (v <= cuts[0]) return 1;
  if (v <= cuts[1]) return 2;
  if (v <= cuts[2]) return 3;
  return 4;
}

export function SpendCalendarCard({
  q,
  showBiggest = true,
  className,
}: {
  q: { data?: MonthInsight; error?: unknown; isLoading: boolean; mutate: () => unknown };
  showBiggest?: boolean;
  className?: string;
}) {
  const m = q.data;
  const { cells, cuts } = useMemo(() => {
    if (!m?.period) return { cells: [] as ({ day: number; amount: number; future: boolean } | null)[], cuts: [0, 0, 0] };
    const y = Number(m.period.slice(0, 4));
    const mo = Number(m.period.slice(5, 7));
    const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7; // Monday first
    const byDay = new Map((m.daily ?? []).map(d => [d.day, d.amount]));
    const out: ({ day: number; amount: number; future: boolean } | null)[] = Array.from({ length: lead }, () => null);
    const n = m.days_in_month ?? new Date(y, mo, 0).getDate();
    for (let d = 1; d <= n; d++) {
      out.push({ day: d, amount: byDay.get(d) ?? 0, future: d > (m.days_elapsed ?? n) });
    }
    const pos = (m.daily ?? []).map(d => d.amount).filter(v => v > 0).sort((a, b) => a - b);
    const qv = (p: number) => pos.length ? pos[Math.min(pos.length - 1, Math.floor(p * pos.length))] : 0;
    return { cells: out, cuts: [qv(0.4), qv(0.7), qv(0.9)] };
  }, [m]);

  const mon = monthShort(m?.period);

  return (
    <StatefulCard
      title="Day by day"
      subtitle="Darker days cost more."
      className={className}
      loading={q.isLoading && !m}
      error={q.error}
      onRetry={() => q.mutate()}
      what="your daily spend"
      empty={!!m && !m.has_data}
      emptyTitle="No days to show yet"
      emptyHint="Each day with spending gets a square here."
      emptyIllustration="receipt"
      skeleton={
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: 35 }).map((_, i) => <Skeleton key={i} className="aspect-square w-full !rounded-s" />)}
        </div>
      }
    >
      <div className="grid grid-cols-7 gap-1.5 text-center text-[12px] font-semibold text-faint" aria-hidden>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <ol className="mt-1.5 grid grid-cols-7 gap-1.5" aria-label={`Spend each day in ${monthLong(m?.period)}`}>
        {cells.map((c, i) => {
          if (!c) return <li key={`b${i}`} aria-hidden />;
          const lvl = c.future ? -1 : levelFor(c.amount, cuts);
          const label = c.future ? `${c.day} ${mon}: no statement yet` : `${c.day} ${mon}: ${c.amount > 0 ? inr(c.amount) : "no spending"}`;
          return (
            <li
              key={c.day}
              title={label}
              aria-label={label}
              className={clsx(
                "grid aspect-square place-items-center rounded-s text-[12px] font-semibold tabular-nums",
                lvl === -1 && "shadow-[inset_0_0_0_1px_var(--line)] text-faint",
                lvl >= 0 && LEVELS[lvl],
                lvl >= 3 ? "text-white" : lvl >= 0 ? "text-muted" : "",
              )}
            >
              {c.day}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[12px] font-medium text-muted" aria-hidden>
        Less
        {LEVELS.map(l => <span key={l} className={clsx("h-3 w-3 rounded-[4px]", l)} />)}
        More
      </div>

      {showBiggest && <BiggestList items={m?.biggest} />}
    </StatefulCard>
  );
}

/** The month's biggest single expenses, under a hairline. */
export function BiggestList({ items }: { items?: BigExpense[] | null }) {
  const rows = (items ?? []).slice(0, 3);
  if (!rows.length) return null;
  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="text-sm font-semibold text-muted">Biggest single expenses</p>
      <ul className="mt-2 space-y-2">
        {rows.map(b => (
          <li key={b.id} className="flex items-baseline gap-3">
            <span className="w-14 shrink-0 text-sm font-medium tabular-nums text-muted">{shortDay(b.date)}</span>
            <span className="min-w-0 flex-1 truncate text-base text-ink-2" title={b.description}>{prettyName(b.name)}</span>
            <span className="shrink-0 text-base font-extrabold tabular-nums text-ink">{inr(b.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recurring payments.
// ---------------------------------------------------------------------------

export function RecurringCard({
  q,
  title = "Fixed every month",
  showLead = true,
  className,
}: {
  q: { data?: RecurringResp; error?: unknown; isLoading: boolean; mutate: () => unknown };
  title?: string;
  showLead?: boolean;
  className?: string;
}) {
  const r = q.data;
  const items = r?.items ?? [];
  const shown = items.slice(0, 8);
  const asOf = r?.as_of ?? "";

  return (
    <StatefulCard
      title={title}
      subtitle={r ? `Same payee, about the same amount, about the same day, over the last ${r.months ?? 6} months` : undefined}
      className={className}
      loading={q.isLoading && !r}
      error={q.error}
      onRetry={() => q.mutate()}
      what="your repeating payments"
      empty={!!r && items.length === 0}
      emptyTitle="Nothing repeats yet"
      emptyHint="With three or more months of statements, rent, bills and subscriptions show up here with their next date."
      emptyIllustration="receipt"
      skeleton={<RowsSkeleton rows={5} />}
    >
      {showLead && r && (
        <p className="mb-4 text-base text-ink-2">
          <span className="font-extrabold text-ink">{inr(r.monthly_total ?? 0)} a month</span> goes out on its own,
          across {plural(items.length, "payment")}.
        </p>
      )}
      <ul className="grid gap-x-8 md:grid-cols-2">
        {shown.map(it => {
          const due = it.next_date <= asOf;
          return (
            <li key={`${it.name}-${it.usual_day}`} className="flex items-center gap-3 border-b border-line py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-extrabold text-ink">{prettyName(it.name)}</p>
                <p className="truncate text-sm font-medium text-muted">
                  {catName(it.category)} · {it.months_seen} of {r?.months ?? 6} months
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-extrabold tabular-nums text-ink">{inr(it.typical_amount)}</p>
                {due ? (
                  <Chip size="sm" tone="neutral" title="Expected by now, but not in your statements yet">
                    Due {shortDay(it.next_date)}
                  </Chip>
                ) : (
                  <p className="text-sm font-medium text-muted">next {shortDay(it.next_date)}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="mt-3 text-sm font-medium text-muted">And {plural(items.length - shown.length, "smaller one")}.</p>
      )}
    </StatefulCard>
  );
}

// ---------------------------------------------------------------------------
// Top merchants as horizontal bars.
// ---------------------------------------------------------------------------

export function TopMerchantsCard({ dr, className }: { dr: DateRange; className?: string }) {
  const { data, error, isLoading, mutate } = useTopCounterparties(6, dr);
  const rows = (data ?? []).filter(r => (r?.amount ?? 0) > 0);
  const max = rows.reduce((mx, r) => Math.max(mx, r.amount), 0);
  const reduced = usePrefersReducedMotion();

  return (
    <StatefulCard
      title="Who got the most"
      subtitle="Real spend by payee, card bills and transfers left out"
      className={className}
      loading={isLoading && !data}
      error={error}
      onRetry={() => mutate()}
      what="your top payees"
      empty={!!data && rows.length === 0}
      emptyTitle="No payees yet"
      emptyHint="Once a statement covers these dates, the people and shops you pay most show up here."
      emptyIllustration="receipt"
      skeleton={<BarsSkeleton bars={6} height={220} />}
    >
      <ul className="space-y-4" aria-label="Top payees by real spend">
        {rows.map((r, i) => (
          <li key={r.counterparty}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-base text-ink-2" title={r.counterparty}>{prettyName(r.counterparty)}</span>
              <span className="shrink-0 text-base font-semibold tabular-nums text-ink">{inr(r.amount)}</span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-[10px] bg-surface-2">
              <div
                className={clsx("h-full rounded-[10px]", i === 0 ? "bg-accent-500" : "bg-accent-200", !reduced && "ov-bar-grow")}
                style={{ width: `${max > 0 ? Math.max(2, (r.amount / max) * 100) : 0}%`, animationDelay: `${200 + i * 60}ms` }}
              />
            </div>
            <span className="sr-only">{plural(r.txn_count ?? 0, "payment")}</span>
          </li>
        ))}
      </ul>
      <style>{`
        .ov-bar-grow { transform-origin: left; animation: ov-bar 1s var(--spring) both; }
        @keyframes ov-bar { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </StatefulCard>
  );
}

// ---------------------------------------------------------------------------
// Small chrome
// ---------------------------------------------------------------------------

export function UploadButton() {
  return <Link href="/upload" className="btn primary sm">Upload statements</Link>;
}

export function ChartBlockSkeleton({ height = 320, className }: { height?: number; className?: string }) {
  return (
    <div className={clsx("rounded-l bg-card p-6 shadow-flat", className)} aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-5 w-full" style={{ height: height - 80 }} />
    </div>
  );
}

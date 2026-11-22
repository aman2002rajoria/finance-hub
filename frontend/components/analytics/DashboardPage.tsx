"use client";

/*
 * Home (route "/"): one calm picture of the month.
 *   month picker            Aug · Sep · Oct · Nov so far · 6 months
 *   headline                "₹85k came in · 44% saved or invested"
 *   four tiles              Spent · Saved in bank · Invested · Net worth
 *   investments + net worth the wealth side, above the fold
 *   money flow              income -> invested, saved in bank, spending
 *   came in vs spent        last 6 months, % saved or invested under each
 *   next goals              same odds and words as the Goals page
 * Spending detail (calendar, pace, payees, recurring) lives on Spending.
 */

import { useEffect, useMemo, useState } from "react";

import { MotionReveal } from "@/components/motion/MotionReveal";
import { Segmented, Skeleton } from "@/components/ui";
import { useWealth } from "@/lib/wealth";

import ExpenseDrilldownDialog from "./ExpenseDrilldownDialog";
import { Headline, HomeTiles } from "./overview/HomeTiles";
import GoalsNextCard from "./overview/GoalsNextCard";
import IncomeSpendCard from "./overview/IncomeSpendCard";
import InvestmentsCard from "./overview/InvestmentsCard";
import MoneyFlowCard from "./overview/MoneyFlowCard";
import NetWorthTrendCard from "./overview/NetWorthTrendCard";
import {
  type Baseline, type Scope, oneOffs, scopePeriods, scopeRange, useLikeForLike, useScopeFigures,
} from "./overview/homeData";
import { useMonthInsight } from "./overview/insightsApi";
import { useSpendingPeriod } from "@/components/ledger/spending/period";
import { NoStatements, PageError, monthLong, monthShort, shortDay, useHasStatements } from "./overview/parts";
import { closeOf, openOf } from "./overview/smooth";

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export default function DashboardPage() {
  const gate = useHasStatements();
  const latestQ = useMonthInsight(null);
  const w = useWealth();
  const [pick, setPick] = useState<string | null>(null);
  // Shared with Spending through the global date range, so both tabs show the same period.
  const sp = useSpendingPeriod();
  const [drill, setDrill] = useState<string | null>(null);

  // ?m=2026-10 or ?m=6m deep-links a period; picking one updates the URL.
  useEffect(() => {
    try {
      const m = new URLSearchParams(window.location.search).get("m");
      if (m && /^(\d{4}-\d{2}|6m)$/.test(m)) { setPick(m); sp.pick(m); }
    } catch { /* no URL access */ }
  }, []);
  const choose = (v: string) => {
    setPick(v);
    sp.pick(v);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("m", v);
      window.history.replaceState(null, "", u.toString());
    } catch { /* ignore */ }
  };

  const L = latestQ.data;
  const latest = L?.period ?? null;
  const partial = L?.is_partial && latest ? latest : null;
  const periods = useMemo(() => L?.periods ?? [], [L]);
  const complete = useMemo(() => periods.filter((p) => p !== partial), [periods, partial]);
  const want = pick ?? (sp.ready ? sp.key : null);
  const choice = want && (want === "6m" || periods.includes(want)) ? want : latest;
  const asOf = L?.as_of ?? null;

  const scope: Scope | null = useMemo(
    () => (!choice ? null : choice === "6m" ? { kind: "6m" } : { kind: "month", period: choice }),
    [choice],
  );
  const dr = useMemo(() => (scope && latest ? scopeRange(scope, latest, asOf) : null), [scope, latest, asOf]);
  const inScope = useMemo(
    () => (scope && latest ? scopePeriods(scope, latest).filter((p) => periods.includes(p)) : []),
    [scope, latest, periods],
  );
  const figs = useScopeFigures(dr);

  const isPartial = scope?.kind === "month" && scope.period === partial;
  const day = isPartial ? L?.days_elapsed ?? null : null;
  const lfl = useLikeForLike(isPartial ? partial : null, day, complete);

  const base: Baseline | null = scope?.kind === "6m"
    ? null
    : isPartial
      ? lfl.data ?? null
      : w.usual.months > 0
        ? { income: w.usual.income, spent: w.usual.spend, invested: w.usual.invest, saved: w.usual.surplus, months: w.usual.months, day: 0 }
        : null;
  const vs = isPartial && day ? `usual by the ${ordinal(day)}` : "a usual month";

  // Without holdings, nothing moves after the last statement: stop the line there.
  const daily = useMemo(
    () => (w.hasHoldings || !w.cashAsOf ? w.daily : w.daily.filter((d) => d.date <= w.cashAsOf!)),
    [w.daily, w.hasHoldings, w.cashAsOf],
  );

  const offs = useMemo(() => oneOffs(w.markers, inScope, w.usual.income), [w.markers, inScope, w.usual.income]);

  // Net worth for the scope: close of its last month, change over the scope,
  // and (for a complete month) the median change of a complete month.
  const nw = useMemo(() => {
    if (!w.daily.length || !inScope.length) return null;
    const close = closeOf(w.daily, inScope[inScope.length - 1]);
    const open = openOf(w.daily, inScope[0]);
    if (!close || !open) return null;
    const changes = complete
      .slice(1)
      .map((p) => {
        const c = closeOf(w.daily, p), o = openOf(w.daily, p);
        return c && o ? c.netWorth - o.netWorth : null;
      })
      .filter((v): v is number => v != null);
    return {
      value: close.netWorth,
      change: close.netWorth - open.netWorth,
      usual: scope?.kind === "month" && !isPartial ? median(changes) : null,
    };
  }, [w.daily, inScope, complete, scope, isPartial]);

  if (gate.error || (latestQ.error && !L)) {
    return <PageError title="Home" error={gate.error ?? latestQ.error} onRetry={() => { gate.retry(); latestQ.mutate(); }} />;
  }
  if (gate.empty || (L && !L.has_data)) return <NoStatements title="Home" />;

  const options = [
    ...periods.slice(-4).map((p) => ({ value: p, label: p === partial ? `${monthShort(p)} so far` : monthShort(p) })),
    ...(periods.length > 1 ? [{ value: "6m", label: "6 months" }] : []),
  ];
  const months = scope?.kind === "6m" ? inScope.length : 1;
  const scopeLabel = scope?.kind === "6m" ? `in ${months} months` : isPartial ? "this month" : `in ${monthShort(choice)}`;
  const scopeWords = scope?.kind === "6m"
    ? `${monthShort(inScope[0])} to ${monthShort(inScope[inScope.length - 1])}`
    : isPartial ? `${monthLong(choice)}, to ${shortDay(asOf)}` : `${monthLong(choice)} ${choice?.slice(0, 4) ?? ""}`;

  return (
    <div className="space-y-6 md:space-y-8">
      <header className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {options.length && choice ? (
            <Segmented<string> ariaLabel="Period" size="sm" value={choice} onChange={choose} options={options} />
          ) : (
            <Skeleton className="h-9 w-72 !rounded-pill" />
          )}
          {asOf && <span className="text-[13px] font-medium text-muted">Statements to {shortDay(asOf)}</span>}
        </div>
        <Headline fig={figs.fig} partial={isPartial} months={months} incomeOneOffs={offs.income} />
      </header>

      <HomeTiles
        fig={figs.fig}
        base={base}
        vs={vs}
        perMonth={scope?.kind === "6m" ? months : null}
        spendOneOffs={offs.spend}
        netWorth={nw?.value ?? (w.isLoading ? null : w.totals.netWorth)}
        nwChange={nw?.change ?? null}
        nwUsual={nw?.usual ?? null}
        nwLabel={scope?.kind === "6m" ? `in ${months} months` : isPartial ? "so far this month" : `in ${monthShort(choice)}`}
        daily={daily}
        partial={isPartial}
      />

      <div className="dashboard-grid">
        <MotionReveal index={0} className="min-[900px]:col-span-5">
          <InvestmentsCard w={w} periods={inScope} scopeLabel={scopeLabel} />
        </MotionReveal>
        <MotionReveal index={1} className="min-[900px]:col-span-7">
          <NetWorthTrendCard w={w} daily={daily} />
        </MotionReveal>
      </div>

      <MotionReveal>
        <MoneyFlowCard
          fig={figs.fig}
          loading={figs.loading}
          error={figs.error}
          onRetry={figs.retry}
          onDrill={setDrill}
          scopeWords={scopeWords}
        />
      </MotionReveal>

      <div className="dashboard-grid">
        <MotionReveal index={0} className="min-[900px]:col-span-7">
          <IncomeSpendCard
            markers={w.markers}
            usualIncome={w.usual.income}
            partialPeriod={partial}
            selected={scope?.kind === "month" ? scope.period : null}
          />
        </MotionReveal>
        <MotionReveal index={1} className="min-[900px]:col-span-5">
          <GoalsNextCard w={w} />
        </MotionReveal>
      </div>

      <ExpenseDrilldownDialog
        open={drill !== null}
        onClose={() => setDrill(null)}
        category={drill}
        dr={dr ?? undefined}
        rangeLabel={scopeWords}
      />
    </div>
  );
}

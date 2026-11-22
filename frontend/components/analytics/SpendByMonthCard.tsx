"use client";

import { useEffect, useMemo, useState } from "react";

import MonthlySpendChart from "@/components/charts/MonthlySpendChart";
import { useMonthly } from "@/lib/api";
import { inr } from "@/lib/format";

import { BarsSkeleton, StatefulCard } from "./cardStates";
import { useDateRange } from "./DateRangeProvider";
import { monthYear } from "./fmt";

/** "Real spend by month": focus month in accent, the rest as context. */
export default function SpendByMonthCard({ height = 236 }: { height?: number }) {
  const { dr } = useDateRange();
  const { data, error, isLoading, mutate } = useMonthly(dr);
  const rows = useMemo(() => data ?? [], [data]);
  const latest = rows.length ? rows[rows.length - 1].period : null;
  const [focus, setFocus] = useState<string | null>(null);

  // Snap back to the latest month whenever the range changes.
  useEffect(() => { setFocus(null); }, [dr.date_from, dr.date_to]);

  const focusPeriod = focus && rows.some(r => r.period === focus) ? focus : latest;
  const focusRow = rows.find(r => r.period === focusPeriod);
  const avg = rows.length ? rows.reduce((s, r) => s + r.spend, 0) / rows.length : 0;

  // With six bars or fewer every bar carries its own label, so the subtitle
  // only names the focus month when the bars are too many to label.
  const subtitle = focusRow && rows.length > 6 ? (
    <span className="font-semibold text-ink">{monthYear(focusRow.period)}: {inr(focusRow.spend)}</span>
  ) : undefined;

  return (
    <StatefulCard
      title="Real spend by month"
      subtitle={subtitle}
      loading={isLoading && !data}
      error={error}
      onRetry={() => mutate()}
      what="your monthly spend"
      empty={!!data && rows.length === 0}
      emptyTitle="No months to show yet"
      emptyHint="Each month you have a statement for gets a bar here."
      emptyIllustration="stack of statements"
      skeleton={<BarsSkeleton bars={6} height={height} />}
    >
      <MonthlySpendChart
        rows={rows}
        focusPeriod={focusPeriod}
        onSelect={rows.length > 1 ? setFocus : undefined}
        height={height}
        average={rows.length > 1 ? avg : undefined}
      />
      {rows.length > 1 && (
        <p className="mt-3 text-sm font-medium text-muted">
          The dashed line is your monthly average. Pick a bar to focus on that month.
        </p>
      )}
    </StatefulCard>
  );
}

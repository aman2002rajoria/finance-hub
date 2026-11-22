"use client";

import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import CategoryDonut, { type DonutSlice } from "@/components/charts/CategoryPieChart";
import { Chip, Skeleton } from "@/components/ui";
import { useCategories } from "@/lib/api";
import { CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";
import { inr } from "@/lib/format";
import type { DateRange } from "@/lib/types";

import { RowsSkeleton, StatefulCard } from "./cardStates";
import { useDateRange } from "./DateRangeProvider";
import { categoryLabel, isUncategorised } from "./fmt";

const MAX_SLICES = 7;

interface Slice extends DonutSlice {
  /** Category name to drill into; null for the rolled-up "Other". */
  drill: string | null;
  uncertain: boolean;
}

/** "Where it went": donut of real spend by category with the value list beside it. */
export default function WhereItWentCard({
  onDrill,
  dr: drProp,
  subtitle = "Real spend by category. Pick one to see what is inside.",
  title = "Where it went",
}: {
  onDrill: (category: string) => void;
  /** Overrides the page date range (the focused-month view passes one month). */
  dr?: DateRange;
  subtitle?: string;
  title?: string;
}) {
  const ctx = useDateRange();
  const dr = drProp ?? ctx.dr;
  const { data, error, isLoading, mutate } = useCategories(dr);
  const [hover, setHover] = useState<string | null>(null);

  const slices = useMemo<Slice[]>(() => {
    if (!data) return [];
    const positive = data.filter(r => r.amount > 0).sort((a, b) => b.amount - a.amount);
    const named = positive.filter(r => !isUncategorised(r.category));
    const uncat = positive.filter(r => isUncategorised(r.category));
    const top = named.slice(0, MAX_SLICES);
    const rest = named.slice(MAX_SLICES);
    const out: Slice[] = top.map((r, i) => ({
      key: r.category,
      label: r.category,
      value: r.amount,
      color: CHART_SERIES[i % CHART_SERIES.length],
      drill: r.category,
      uncertain: false,
    }));
    const restAmt = rest.reduce((s, r) => s + r.amount, 0);
    if (restAmt > 0) {
      out.push({
        key: "__other__",
        label: `Other (${rest.length})`,
        value: restAmt,
        color: CHART_OTHER,
        drill: null,
        uncertain: false,
      });
    }
    for (const u of uncat) {
      out.push({
        key: u.category,
        label: categoryLabel(u.category),
        value: u.amount,
        color: CHART_OTHER,
        drill: u.category,
        uncertain: true,
      });
    }
    return out;
  }, [data]);

  const total = slices.reduce((s, d) => s + d.value, 0);

  return (
    <StatefulCard
      title={title}
      subtitle={subtitle}
      loading={isLoading && !data}
      error={error}
      onRetry={() => mutate()}
      what="your categories"
      empty={!!data && slices.length === 0}
      emptyTitle="No spending in this range"
      emptyHint="Once a statement covers these dates, your categories show up here."
      emptyIllustration="receipt"
      emptyAction={<Link href="/upload" className="btn ghost sm">Upload statements</Link>}
      skeleton={
        <div className="flex flex-col items-center gap-6 xl:flex-row xl:items-start">
          <Skeleton className="h-[184px] w-[184px] shrink-0 !rounded-full" />
          <div className="w-full"><RowsSkeleton rows={6} withDot /></div>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-6 xl:flex-row xl:items-start">
        <CategoryDonut slices={slices} size={184} activeKey={hover} onHover={setHover} />
        <ul className="w-full min-w-0 space-y-0.5" aria-label="Real spend by category">
          {slices.map(s => {
            const share = total > 0 ? Math.round((s.value / total) * 100) : 0;
            const content = (
              <>
                <span aria-hidden className="h-3 w-3 shrink-0 rounded-[4px]" style={{ background: s.color }} />
                {s.uncertain ? (
                  <span className="min-w-0 flex-1 text-left">
                    <Chip tone="warning" size="sm" title={`${s.label}: spend with no category yet`}>Needs a tag</Chip>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-left text-base text-ink-2">{s.label}</span>
                )}
                <span className="shrink-0 text-right text-base font-semibold tabular-nums text-ink" title={`${share}% of real spend`}>
                  {inr(s.value)}
                </span>
                <ChevronRight
                  aria-hidden
                  strokeWidth={1.75}
                  className={clsx("h-4 w-4 shrink-0 text-faint", !s.drill && "invisible")}
                />
              </>
            );
            const rowClass = clsx(
              "flex w-full items-center gap-3 rounded-s px-2 py-1.5 transition-colors",
              hover === s.key && "bg-surface",
            );
            return (
              <li key={s.key} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
                {s.drill ? (
                  <button
                    type="button"
                    className={clsx(rowClass, "hover:bg-surface")}
                    onClick={() => onDrill(s.drill!)}
                    aria-label={`${s.label}: ${inr(s.value)}. Open the breakdown`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={rowClass}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </StatefulCard>
  );
}

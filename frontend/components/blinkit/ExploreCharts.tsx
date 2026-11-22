"use client";

/*
 * Groceries > Explore: the narrower questions, each card titled with its
 * answer. Where-it-goes lives on the Overview, so it isn't repeated here.
 *   - How each category moved (lines, many months)
 *   - Which day you order most (7 columns, busiest in accent)
 *   - What you reorder most, and the stores that pack your orders
 */

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { AXIS_QUIET, AXIS_TICK, barChartMargin, compact, formatPeriodLabel, makeSquareActiveDot } from "@/components/blinkit/blinkit-charts";
import { buildPreviousMonthMap, CategoryTrendMonthTooltip } from "@/components/blinkit/chart-tooltips";
import { buildDrilldownHref, type BlinkitDrillSelection } from "@/components/blinkit/drilldown";
import { plural } from "@/components/blinkit/format";
import InteractiveCategoryLegend from "@/components/blinkit/InteractiveCategoryLegend";
import { ColumnBars, countWord, money, ProductTile, RankList, shortProduct, shortStore, useRechartsAnim } from "@/components/blinkit/pieces";
import { Card, CardSkeleton, CardTitle, EmptyState } from "@/components/ui";
import { useInteractiveLegend } from "@/hooks/useInteractiveLegend";
import {
  useBlinkitBehavior, useBlinkitCategoryTrend, useBlinkitProductRankings, useBlinkitStoreAnalytics,
} from "@/lib/api";
import { categoryColor, sortCategoriesStable } from "@/lib/blinkit-category-colors";
import { CHART, CHART_HEIGHT } from "@/lib/chart-theme";

const DAY_NAMES: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

function argMax<T>(rows: readonly T[], pick: (r: T) => number): number {
  let best = -Infinity;
  let idx = 0;
  rows.forEach((r, i) => { const v = pick(r); if (v > best) { best = v; idx = i; } });
  return idx;
}

export default function ExploreCharts() {
  const router = useRouter();
  const { dr } = useDateRange();
  const openDrill = useCallback((sel: BlinkitDrillSelection) => router.push(buildDrilldownHref(sel)), [router]);
  const { props: anim, reduced } = useRechartsAnim();

  const { data: categoryTrend } = useBlinkitCategoryTrend(dr);
  const { data: stores } = useBlinkitStoreAnalytics(dr);
  const { data: byQuantity } = useBlinkitProductRankings(dr, "quantity");
  const { data: behavior } = useBlinkitBehavior(dr);

  const storeRows = (stores ?? []).slice(0, 6);
  const weekdays = behavior?.orders_per_weekday ?? [];
  const weekdayFocus = argMax(weekdays, w => w.count ?? 0);
  const weekdayTotal = weekdays.reduce((s, w) => s + (w.count ?? 0), 0);
  const busiest = weekdays[weekdayFocus];

  const trendCategories = useMemo(
    () => sortCategoriesStable([...new Set((categoryTrend ?? []).map(r => r.category))]),
    [categoryTrend],
  );
  const trendLegend = useInteractiveLegend(trendCategories);
  const trendByPeriod = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>();
    for (const row of categoryTrend ?? []) {
      if (!map.has(row.period)) map.set(row.period, { period: row.period, label: formatPeriodLabel(row.period) });
      map.get(row.period)![row.category] = row.spend;
    }
    const cats = [...new Set((categoryTrend ?? []).map(r => r.category))];
    // A month with no orders in a category is ₹0, not a gap in the line.
    for (const row of map.values()) for (const c of cats) if (row[c] == null) row[c] = 0;
    return [...map.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }, [categoryTrend]);
  const trendPrevious = useMemo(() => buildPreviousMonthMap(trendByPeriod, trendCategories), [trendByPeriod, trendCategories]);

  if (!categoryTrend && !stores && !byQuantity && !behavior) {
    return (
      <div className="grid gap-4 lg:grid-cols-12">
        <CardSkeleton height={380} className="lg:col-span-8" />
        <CardSkeleton height={380} className="lg:col-span-4" />
      </div>
    );
  }

  const noData = <EmptyState compact title="Nothing to show for this range" hint="Pick a wider date range above." />;
  const orderCount = weekdayTotal;
  const reorders = [...(byQuantity ?? [])]
    .sort((a, b) => (b.times_purchased ?? 0) - (a.times_purchased ?? 0))
    .slice(0, 6);
  const storeCount = (stores ?? []).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <Card className="h-full">
            <CardTitle className="mb-5" subtitle="Monthly spend in each category. Click a name to hide it.">
              How each category moved
            </CardTitle>
            {trendByPeriod.length ? (
              <>
                <ResponsiveContainer width="100%" height={CHART_HEIGHT.md}>
                  <LineChart
                    key={reduced ? "still" : "moving"}
                    data={trendByPeriod}
                    margin={barChartMargin()}
                    onClick={(e) => {
                      const key = e?.activePayload?.[0]?.dataKey;
                      if (key) openDrill({ dimension: "category", value: String(key), source: "How each category moved" });
                    }}
                  >
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={AXIS_TICK} tickMargin={8} {...AXIS_QUIET} />
                    <YAxis tickFormatter={compact} tick={AXIS_TICK} width={44} {...AXIS_QUIET} />
                    <Tooltip
                      shared
                      cursor={{ stroke: CHART.line }}
                      content={
                        <CategoryTrendMonthTooltip
                          labelFormatter={(l) => String(l)}
                          previousByCategory={trendPrevious}
                          categoryKeys={trendCategories.filter(c => trendLegend.isVisible(c))}
                        />
                      }
                    />
                    {trendCategories.map((c, i) => (
                      <Line
                        key={c}
                        type="monotone"
                        dataKey={c}
                        name={c}
                        stroke={categoryColor(c, i)}
                        strokeWidth={2.5}
                        strokeOpacity={trendLegend.seriesOpacity(c)}
                        dot={false}
                        activeDot={makeSquareActiveDot(categoryColor(c, i))}
                        hide={!trendLegend.isVisible(c)}
                        {...anim}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
                <InteractiveCategoryLegend
                  categories={trendCategories}
                  hidden={trendLegend.hidden}
                  isolated={trendLegend.isolated}
                  highlighted={trendLegend.highlighted}
                  onToggle={trendLegend.toggleCategory}
                  onIsolate={trendLegend.isolateCategory}
                  onHighlight={trendLegend.setHighlighted}
                />
              </>
            ) : noData}
          </Card>
        </div>

        <div className="lg:col-span-4">
          <Card className="flex h-full flex-col">
            <CardTitle subtitle={busiest && weekdayTotal ? `${busiest.count} of your ${plural(weekdayTotal, "order")} landed on a ${DAY_NAMES[busiest.weekday] ?? busiest.weekday}.` : undefined}>
              {busiest && weekdayTotal ? `${DAY_NAMES[busiest.weekday] ?? busiest.weekday} is your busiest day` : "Which days you order"}
            </CardTitle>
            {weekdays.length && weekdayTotal ? (
              <ColumnBars
                className="mt-auto pt-6"
                height={200}
                focusIndex={weekdayFocus}
                bars={weekdays.map(w => ({
                  key: w.weekday,
                  label: String(w.weekday ?? "").slice(0, 1),
                  value: w.count ?? 0,
                  caption: String(w.count ?? 0),
                  ariaLabel: `${DAY_NAMES[w.weekday] ?? w.weekday}: ${plural(w.count ?? 0, "order")}. See them`,
                }))}
                onPick={(b) => openDrill({ dimension: "weekday", value: b.key, source: "Which days you order" })}
              />
            ) : noData}
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle subtitle={orderCount ? `How many of your ${plural(orderCount, "order")} each one was in` : undefined}>
            What you reorder most
          </CardTitle>
          {reorders.length ? (
            <ul className="mt-3">
              {reorders.map(p => (
                <li key={p.product_name}>
                  <button
                    type="button"
                    onClick={() => router.push(`/blinkit/products?name=${encodeURIComponent(p.product_name)}`)}
                    className="-mx-3 flex w-[calc(100%+24px)] items-center gap-4 rounded-s px-3 py-2.5 text-left transition-colors hover:bg-surface"
                  >
                    <ProductTile name={p.product_name} category={p.category} size={36} />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink" title={p.product_name}>{shortProduct(p.product_name)}</span>
                    <span className="shrink-0 text-[15px] tabular-nums text-ink-2">
                      <span className="font-semibold text-ink">{p.times_purchased ?? 0}</span>
                      {orderCount ? <span className="text-muted"> of {orderCount}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : noData}
        </Card>

        <Card>
          <CardTitle subtitle="Blinkit's local stores that packed and sent each order">
            {storeCount === 1 ? "One store packs every order" : storeCount ? `${countWord(storeCount).replace(/^./, c => c.toUpperCase())} stores pack your orders` : "Stores"}
          </CardTitle>
          {storeRows.length ? (
            <RankList
              className="mt-4"
              rows={storeRows.map(s => ({
                key: s.store_name,
                label: shortStore(s.store_name) || s.store_name,
                value: s.total_spend ?? 0,
                sub: plural(s.order_count ?? 0, "order"),
              }))}
              format={(v) => money(Math.round(v))}
              onPick={(r) => openDrill({ dimension: "store", value: r.key, source: "Stores" })}
            />
          ) : noData}
        </Card>
      </div>
    </div>
  );
}

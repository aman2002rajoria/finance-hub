"use client";

import { useMemo, useState } from "react";
import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import InteractiveCategoryLegend from "@/components/blinkit/InteractiveCategoryLegend";
import { CategoryCompositionTooltip, TrendPeriodTooltip } from "@/components/blinkit/chart-tooltips";
import {
  AXIS_QUIET, AXIS_TICK, barChartMargin, CHART, compact, CONTEXT, FOCUS, makeSquareActiveDot, PIE_SLICE_STROKE,
} from "@/components/blinkit/blinkit-charts";
import { ChartReveal, useChartAnimProps } from "@/components/motion/ChartAnimation";
import { Segmented } from "@/components/ui";
import { useInteractiveLegend } from "@/hooks/useInteractiveLegend";
import { categoryColor, stackCategoryOrder } from "@/lib/blinkit-category-colors";
import { CHART_ANIM, CHART_HEIGHT, CHART_SERIES } from "@/lib/chart-theme";
import { buildPreviousPeriodMap, buildPreviousMonthMap } from "@/lib/chart-analytics";

const SPEND_COLOR = FOCUS;
const DISCOUNT_COLOR = CHART_SERIES[0];
const DELIVERY_COLOR = CHART_SERIES[2];

type ViewMode = "overall" | "overlay" | "stacked";

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "overall", label: "Total" },
  { value: "stacked", label: "By category" },
];

const LEGEND: Record<"overlay", { label: string; color: string }[]> = {
  overlay: [
    { label: "Spend", color: SPEND_COLOR },
    { label: "Discounts", color: DISCOUNT_COLOR },
    { label: "Delivery fees", color: DELIVERY_COLOR },
  ],
};

export default function SpendingOverTimeChart({
  spendData,
  categoryData,
  categories,
  onPeriodClick,
}: {
  spendData: Array<{
    period: string;
    label: string;
    spend: number;
    discount?: number;
    delivery?: number;
    order_count?: number;
    avg_order_value?: number;
  }>;
  categoryData: Array<Record<string, unknown> & { period: string; label: string; total?: number }>;
  categories: string[];
  onPeriodClick?: (period: string, dataKey?: string) => void;
}) {
  const [view, setView] = useState<ViewMode>("overall");
  const legend = useInteractiveLegend(categories);
  const anim = useChartAnimProps();

  const stackOrder = useMemo(
    () => stackCategoryOrder(categories, categoryData),
    [categories, categoryData],
  );

  const visibleStack = useMemo(
    () => stackOrder.filter(c => legend.isVisible(c)),
    [stackOrder, legend],
  );

  const spendPrevious = useMemo(
    () => buildPreviousPeriodMap(spendData, "spend"),
    [spendData],
  );

  const ordersPrevious = useMemo(
    () => buildPreviousPeriodMap(
      spendData.map(r => ({ period: r.period, order_count: r.order_count ?? 0 })),
      "order_count",
    ),
    [spendData],
  );

  const categoryPrevious = useMemo(
    () => buildPreviousMonthMap(
      categoryData as Array<Record<string, string | number>>,
      categories,
    ),
    [categoryData, categories],
  );

  const chartKey = `${view}-${spendData.map(d => d.period).join(",")}-${legend.visibleCategories.join("|")}`;

  const data = view === "stacked" ? categoryData : spendData;
  if (!data.length) return null;

  const lastIndex = spendData.length - 1;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          size="sm"
          ariaLabel="Chart view"
          options={VIEWS}
          value={view}
          onChange={setView}
        />
        {view === "overlay" && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium text-ink-2">
            {LEGEND.overlay.map(l => (
              <li key={l.label} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ChartReveal>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT.lg}>
          <ComposedChart
            key={chartKey}
            data={data}
            margin={barChartMargin()}
            onClick={(e) => {
              const row = e?.activePayload?.[0]?.payload as { period?: string } | undefined;
              const dataKey = String(e?.activePayload?.[0]?.dataKey ?? "");
              if (row?.period) onPeriodClick?.(String(row.period), dataKey);
            }}
          >
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickMargin={10} {...AXIS_QUIET} />
            <YAxis tickFormatter={compact} tick={AXIS_TICK} width={48} {...AXIS_QUIET} />

            {view === "overall" && (
              <>
                <Tooltip
                  cursor={{ fill: CHART.surface }}
                  content={
                    <TrendPeriodTooltip
                      valueKey="spend"
                      valueLabel="Spend"
                      previousByPeriod={spendPrevious}
                      previousOrdersByPeriod={ordersPrevious}
                    />
                  }
                />
                <Bar
                  dataKey="spend"
                  name="Spend"
                  radius={[10, 10, 10, 10]}
                  maxBarSize={56}
                  {...anim}
                  animationDuration={CHART_ANIM.barDuration}
                >
                  {spendData.map((row, i) => (
                    <Cell key={row.period} fill={i === lastIndex ? SPEND_COLOR : CONTEXT} />
                  ))}
                </Bar>
              </>
            )}

            {view === "overlay" && (
              <>
                <Tooltip
                  shared
                  content={
                    <TrendPeriodTooltip
                      valueKey="spend"
                      valueLabel="Spend"
                      previousByPeriod={spendPrevious}
                      multiSeries
                    />
                  }
                />
                <Line
                  type="monotone"
                  dataKey="spend"
                  name="Spend"
                  stroke={SPEND_COLOR}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={makeSquareActiveDot(SPEND_COLOR)}
                  {...anim}
                  animationDuration={CHART_ANIM.lineDuration}
                />
                <Line
                  type="monotone"
                  dataKey="discount"
                  name="Discounts"
                  stroke={DISCOUNT_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={makeSquareActiveDot(DISCOUNT_COLOR)}
                  {...anim}
                  animationBegin={anim.animationBegin + 80}
                  animationDuration={CHART_ANIM.lineDuration}
                />
                <Line
                  type="monotone"
                  dataKey="delivery"
                  name="Delivery fees"
                  stroke={DELIVERY_COLOR}
                  strokeWidth={2}
                  dot={false}
                  activeDot={makeSquareActiveDot(DELIVERY_COLOR)}
                  {...anim}
                  animationBegin={anim.animationBegin + 160}
                  animationDuration={CHART_ANIM.lineDuration}
                />
              </>
            )}

            {view === "stacked" && (
              <>
                <Tooltip
                  shared
                  content={
                    <CategoryCompositionTooltip
                      labelFormatter={(l) => String(l)}
                      excludeKeys={new Set(["discount", "delivery", "total"])}
                      previousByCategory={categoryPrevious}
                    />
                  }
                />
                {visibleStack.map((cat, i) => (
                  <Area
                    key={cat}
                    type="monotone"
                    dataKey={cat}
                    name={cat}
                    stackId="spend"
                    fill={categoryColor(cat, i)}
                    stroke={PIE_SLICE_STROKE}
                    fillOpacity={0.9 * legend.seriesOpacity(cat)}
                    strokeWidth={1}
                    isAnimationActive={anim.isAnimationActive}
                    animationDuration={CHART_ANIM.areaDuration}
                    animationBegin={anim.animationBegin + i * CHART_ANIM.staggerMs}
                    animationEasing="ease-out"
                    style={{ cursor: "pointer" }}
                  />
                ))}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartReveal>

      {view === "stacked" && (
        <InteractiveCategoryLegend
          categories={categories}
          hidden={legend.hidden}
          isolated={legend.isolated}
          highlighted={legend.highlighted}
          onToggle={legend.toggleCategory}
          onIsolate={legend.isolateCategory}
          onHighlight={legend.setHighlighted}
        />
      )}
    </div>
  );
}

export { SPEND_COLOR };

"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { useChartAnimProps } from "@/components/motion/ChartAnimation";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { CHART, CHART_ANIM } from "@/lib/chart-theme";
import { inr } from "@/lib/format";

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Parts of a whole (design.md §10): a donut with no labels on the ring.
 * The value list beside it (rendered by the caller) is the text alternative.
 */
export default function CategoryDonut({
  slices,
  size = 200,
  activeKey,
  onHover,
}: {
  slices: DonutSlice[];
  size?: number;
  activeKey?: string | null;
  onHover?: (key: string | null) => void;
}) {
  const anim = useChartAnimProps();
  const reduced = usePrefersReducedMotion();
  const total = slices.reduce((s, d) => s + d.value, 0);
  const outer = size / 2;
  const inner = outer * 0.64;

  return (
    <div style={{ width: size, height: size }} className="shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={inner}
            outerRadius={outer}
            startAngle={90}
            endAngle={-270}
            stroke={CHART.card}
            strokeWidth={1.5}
            isAnimationActive={!reduced && anim.isAnimationActive}
            animationBegin={CHART_ANIM.begin}
            animationDuration={CHART_ANIM.pieDuration}
            animationEasing="ease-out"
            onMouseEnter={(_, i) => onHover?.(slices[i]?.key ?? null)}
            onMouseLeave={() => onHover?.(null)}
          >
            {slices.map(s => (
              <Cell
                key={s.key}
                fill={s.color}
                fillOpacity={activeKey && activeKey !== s.key ? 0.35 : 1}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={CHART.tooltip}
            itemStyle={{ color: CHART.ink2, fontSize: 14 }}
            formatter={(v: number, n: string) => {
              const share = total > 0 ? ` · ${Math.round((v / total) * 100)}%` : "";
              return [`${inr(v)}${share}`, n];
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

"use client";

/*
 * Chart tooltips (design.md §7 popover): white, 16px radius, floating
 * shadow, 12/14 padding, sentence-case labels, tabular numbers.
 * Spending going up is not "bad", so changes are shown in neutral ink.
 */

import type { TooltipProps } from "recharts";

import { categoryColor } from "@/lib/blinkit-category-colors";
import { formatGrowth } from "@/lib/chart-analytics";
import { CHART } from "@/lib/chart-theme";
import { inr } from "@/lib/format";

function TooltipShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="min-w-[200px] max-w-[300px] text-sm"
      style={{
        background: CHART.tooltip.background,
        borderRadius: CHART.tooltip.borderRadius,
        boxShadow: CHART.tooltip.boxShadow,
        padding: CHART.tooltip.padding,
        color: CHART.tooltip.color,
      }}
    >
      {title && <p className="mb-2 text-sm font-extrabold text-ink">{title}</p>}
      {children}
    </div>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function MetricRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 leading-snug">
      <span className="text-muted">{label}</span>
      <span className={`shrink-0 tabular-nums ${strong ? "font-extrabold text-ink" : "font-semibold text-ink-2"}`}>{value}</span>
    </div>
  );
}

type PayloadEntry = {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
  payload?: Record<string, unknown>;
};

function sortedEntries(payload: PayloadEntry[] | undefined, excludeKeys?: Set<string>) {
  return [...(payload ?? [])]
    .filter(e => {
      const key = String(e.dataKey ?? e.name ?? "");
      if (excludeKeys?.has(key)) return false;
      return typeof e.value === "number" && e.value > 0;
    })
    .sort((a, b) => Number(b.value) - Number(a.value));
}

type CategoryEntry = { name: string; value: number; color: string; prev?: number };

function CategoryList({ entries, total }: { entries: CategoryEntry[]; total: number }) {
  return (
    <ul className="space-y-1">
      {entries.map(({ name, value, color, prev }) => {
        const share = total > 0 ? Math.round((value / total) * 100) : 0;
        const growth = formatGrowth(value, prev);
        return (
          <li key={name} className="flex items-center gap-2 leading-snug">
            <ColorDot color={color} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{name}</span>
            {growth && <span className="shrink-0 text-[13px] tabular-nums text-muted">{growth}</span>}
            <span className="shrink-0 text-[13px] tabular-nums text-muted">{share}%</span>
            <span className="w-[72px] shrink-0 text-right font-semibold tabular-nums text-ink">{inr(value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Stacked area / bar: every category at the hovered period. */
export function CategoryCompositionTooltip({
  active,
  payload,
  label,
  labelFormatter,
  excludeKeys,
  previousByCategory,
}: TooltipProps<number, string> & {
  labelFormatter?: (label: string, payload?: PayloadEntry[]) => string;
  excludeKeys?: Set<string>;
  previousByCategory?: Record<string, Record<string, number>>;
}) {
  if (!active || !payload?.length) return null;

  const entries = sortedEntries(payload as PayloadEntry[], excludeKeys);
  const total = entries.reduce((s, e) => s + Number(e.value), 0);
  const title = labelFormatter && label != null
    ? labelFormatter(String(label), payload as PayloadEntry[])
    : String(label ?? "");
  const period = String((payload[0] as PayloadEntry)?.payload?.period ?? "");

  const listEntries: CategoryEntry[] = entries.map(entry => {
    const name = String(entry.name ?? entry.dataKey ?? "");
    return {
      name,
      value: Number(entry.value),
      color: entry.color ?? categoryColor(name),
      prev: previousByCategory?.[period]?.[name],
    };
  });

  return (
    <TooltipShell title={title}>
      {total > 0 && <div className="mb-2"><MetricRow label="Total" value={inr(total)} strong /></div>}
      <CategoryList entries={listEntries} total={total} />
    </TooltipShell>
  );
}

/** Monthly category trend: every visible category at the hovered month. */
export function CategoryTrendMonthTooltip({
  active,
  payload,
  label,
  labelFormatter,
  previousByCategory,
  categoryKeys,
}: TooltipProps<number, string> & {
  labelFormatter?: (label: string) => string;
  previousByCategory?: Record<string, Record<string, number>>;
  categoryKeys?: string[];
}) {
  if (!active || !payload?.length) return null;

  const row = (payload[0] as PayloadEntry)?.payload as Record<string, number | string> | undefined;
  const period = String(row?.period ?? "");
  const title = labelFormatter && label != null ? labelFormatter(String(label)) : String(label ?? "");

  const keys = categoryKeys ?? payload.map(p => String(p.dataKey ?? p.name ?? "")).filter(Boolean);
  const listEntries: CategoryEntry[] = [];
  for (const key of keys) {
    const fromPayload = payload.find(p => String(p.dataKey ?? p.name) === key);
    const value = Number(fromPayload?.value ?? row?.[key] ?? 0);
    if (value <= 0) continue;
    listEntries.push({
      name: key,
      value,
      color: fromPayload?.color ?? categoryColor(key),
      prev: previousByCategory?.[period]?.[key],
    });
  }
  listEntries.sort((a, b) => b.value - a.value);
  const total = listEntries.reduce((s, e) => s + e.value, 0);

  return (
    <TooltipShell title={title}>
      {total > 0 && <div className="mb-2"><MetricRow label="Total" value={inr(total)} strong /></div>}
      <CategoryList entries={listEntries} total={total} />
    </TooltipShell>
  );
}

/** Single-series time trend with the previous period for comparison. */
export function TrendPeriodTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueKey = "spend",
  valueLabel = "Spend",
  previousByPeriod,
  previousOrdersByPeriod,
  multiSeries = false,
  ordersKey = "order_count",
}: TooltipProps<number, string> & {
  labelFormatter?: (label: string) => string;
  valueKey?: string;
  valueLabel?: string;
  previousByPeriod?: Record<string, number | undefined>;
  previousOrdersByPeriod?: Record<string, number | undefined>;
  multiSeries?: boolean;
  ordersKey?: string;
}) {
  if (!active || !payload?.length) return null;

  const title = labelFormatter && label != null ? labelFormatter(String(label)) : String(label ?? "");
  const row = (payload[0] as PayloadEntry)?.payload ?? {};
  const period = String(row.period ?? "");

  if (multiSeries) {
    const entries = sortedEntries(payload as PayloadEntry[]);
    return (
      <TooltipShell title={title}>
        <ul className="space-y-1">
          {entries.map(entry => {
            const name = String(entry.name ?? entry.dataKey ?? "");
            return (
              <li key={name} className="flex items-center gap-2">
                <ColorDot color={entry.color ?? CHART.faint} />
                <span className="flex-1 text-ink-2">{name}</span>
                <span className="font-semibold tabular-nums text-ink">{inr(Number(entry.value))}</span>
              </li>
            );
          })}
        </ul>
      </TooltipShell>
    );
  }

  const value = Number(row[valueKey] ?? payload[0]?.value ?? 0);
  const orderCount = Number(row[ordersKey] ?? row.order_count ?? 0);
  const aov = Number(row.avg_order_value ?? (orderCount > 0 ? value / orderCount : 0));
  const previous = previousByPeriod?.[period];
  const previousOrders = previousOrdersByPeriod?.[period];
  const diff = previous != null ? value - previous : null;
  const growth = formatGrowth(value, previous);

  return (
    <TooltipShell title={title}>
      <div className="space-y-1">
        <MetricRow label={valueLabel} value={inr(value)} strong />
        {orderCount > 0 && <MetricRow label="Orders" value={orderCount.toLocaleString("en-IN")} />}
        {aov > 0 && <MetricRow label="Average order" value={inr(aov)} />}
        {previous != null && (
          <>
            <div className="my-1.5 h-px bg-line" />
            <MetricRow label="Period before" value={inr(previous)} />
            {diff != null && (
              <MetricRow
                label="Change"
                value={`${diff >= 0 ? "+" : "−"}${inr(Math.abs(diff))}${growth ? ` (${growth})` : ""}`}
              />
            )}
            {previousOrders != null && previousOrders > 0 && orderCount > 0 && (
              <MetricRow label="Orders before" value={String(previousOrders)} />
            )}
          </>
        )}
      </div>
    </TooltipShell>
  );
}

/** Ranking bar charts: stores, sellers, brands, categories. */
export function EntityRankingTooltip({
  active,
  payload,
  nameKey,
  totalSpend,
  rank,
  metrics,
}: {
  active?: boolean;
  payload?: unknown[];
  nameKey: string;
  nameLabel?: string;
  totalSpend: number;
  rank?: number;
  metrics: Array<{ label: string; key: string; format?: (v: unknown) => string }>;
}) {
  if (!active || !payload?.length) return null;

  const first = payload[0] as PayloadEntry & { payload?: Record<string, unknown> };
  const row = first?.payload ?? {};
  const name = String(row[nameKey] ?? first?.name ?? "");
  const spend = Number(row.total_spend ?? first?.value ?? 0);
  const share = totalSpend > 0 ? Math.round((spend / totalSpend) * 100) : 0;

  const extraMetrics = metrics
    .map(m => {
      const raw = row[m.key];
      if ((raw == null || raw === "") && !m.format) return null;
      const formatted = m.format ? m.format(raw) : String(raw);
      if (!formatted) return null;
      return { label: m.label, value: formatted };
    })
    .filter(Boolean) as Array<{ label: string; value: string }>;

  return (
    <TooltipShell title={name}>
      <div className="space-y-1">
        <MetricRow label="Spend" value={inr(spend)} strong />
        <MetricRow label="Share of total" value={`${share}%`} />
        {rank != null && rank > 0 && <MetricRow label="Rank" value={`${rank}`} />}
        {extraMetrics.map(m => <MetricRow key={m.label} label={m.label} value={m.value} />)}
      </div>
    </TooltipShell>
  );
}

/** Stacked bar segment with its month's context. */
export function StackedSegmentTooltip({
  active,
  payload,
  label,
  labelFormatter,
  previousByCategory,
}: TooltipProps<number, string> & {
  labelFormatter?: (label: string) => string;
  previousByCategory?: Record<string, Record<string, number>>;
}) {
  if (!active || !payload?.length) return null;

  const entry = payload[0] as PayloadEntry;
  const name = String(entry.name ?? entry.dataKey ?? "");
  const value = Number(entry.value);
  const row = entry.payload as Record<string, number> | undefined;
  const total = row?.total ?? 0;
  const period = String(row?.period ?? "");
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  const title = labelFormatter && label != null ? labelFormatter(String(label)) : String(label ?? "");
  const prev = previousByCategory?.[period]?.[name];
  const growth = formatGrowth(value, prev);

  return (
    <TooltipShell title={title}>
      <div className="mb-1.5 flex items-center gap-2">
        <ColorDot color={entry.color ?? categoryColor(name)} />
        <span className="font-semibold text-ink">{name}</span>
      </div>
      <div className="space-y-1">
        <MetricRow label="Spend" value={inr(value)} strong />
        <MetricRow label="Share of month" value={`${share}%`} />
        {total > 0 && <MetricRow label="Month total" value={inr(total)} />}
        {prev != null && <MetricRow label="Month before" value={inr(prev)} />}
        {growth && <MetricRow label="Change" value={growth} />}
      </div>
    </TooltipShell>
  );
}

/** Standard value tooltip with an optional share of the total. */
export function ValueTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter = inr,
  total,
  nameLabel,
  extraRows,
}: TooltipProps<number, string> & {
  labelFormatter?: (label: string) => string;
  valueFormatter?: (v: number) => string;
  total?: number;
  nameLabel?: string;
  extraRows?: Array<{ label: string; value: string }>;
}) {
  if (!active || !payload?.length) return null;

  const entry = payload[0];
  const value = Number(entry.value);
  const name = nameLabel ?? String(entry.name ?? entry.dataKey ?? "");
  const title = labelFormatter && label != null ? labelFormatter(String(label)) : String(label ?? "");
  const share = total && total > 0 ? Math.round((value / total) * 100) : null;

  return (
    <TooltipShell title={title || name}>
      <div className="space-y-1">
        <MetricRow label={title && name && title !== name ? name : "Value"} value={valueFormatter(value)} strong />
        {share != null && <MetricRow label="Share of total" value={`${share}%`} />}
        {(extraRows ?? []).map(r => <MetricRow key={r.label} label={r.label} value={r.value} />)}
      </div>
    </TooltipShell>
  );
}

/** @deprecated Prefer the specific tooltips above. */
export function DarkTooltip({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
}: TooltipProps<number, string> & {
  formatter?: (value: number, name: string) => string;
  labelFormatter?: (label: string) => string;
}) {
  return (
    <ValueTooltip
      active={active}
      payload={payload}
      label={label}
      labelFormatter={labelFormatter}
      valueFormatter={(v) => formatter ? formatter(v, "") : inr(v)}
      nameLabel={payload?.[0]?.name != null ? String(payload[0].name) : undefined}
    />
  );
}

export { buildPreviousMonthMap } from "@/lib/chart-analytics";

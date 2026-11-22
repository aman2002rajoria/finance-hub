/** Helpers for period-over-period analytics in chart tooltips. */

export function buildPreviousPeriodMap(
  rows: ReadonlyArray<Record<string, unknown>>,
  valueKey: string,
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (let i = 0; i < rows.length; i++) {
    const period = String(rows[i].period ?? "");
    out[period] = i > 0 ? Number(rows[i - 1][valueKey]) || 0 : undefined;
  }
  return out;
}

export function buildPreviousMonthMap(
  rows: ReadonlyArray<Record<string, number | string>>,
  categoryKeys: string[],
): Record<string, Record<string, number>> {
  const byPeriod = rows.map(r => ({
    period: String(r.period),
    values: Object.fromEntries(categoryKeys.map(k => [k, Number(r[k]) || 0])),
  }));
  const out: Record<string, Record<string, number>> = {};
  for (let i = 0; i < byPeriod.length; i++) {
    out[byPeriod[i].period] = i > 0 ? byPeriod[i - 1].values : {};
  }
  return out;
}

export function growthPct(current: number, previous?: number): number | null {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatGrowth(current: number, previous?: number): string | null {
  const g = growthPct(current, previous);
  if (g == null) return null;
  const sign = g >= 0 ? "+" : "";
  return `${sign}${g.toFixed(1)}%`;
}

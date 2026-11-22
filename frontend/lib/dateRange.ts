import type { DateRange } from "./types";

export const PRESET_MONTHS = [1, 3, 6, 12] as const;
export type PresetMonths = (typeof PRESET_MONTHS)[number];

export const DATE_RANGE_STORAGE_KEY = "finance-hub-date-range";

export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const lastNMonths = (n: number): DateRange => {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - n);
  return { date_from: iso(from), date_to: iso(to) };
};

export const defaultDateRange = (): DateRange => ({});

export function describeRange(dr: DateRange, preset: PresetMonths | null): string {
  if (preset !== null) {
    return preset === 1 ? "the last month" : `the last ${preset} months`;
  }
  if (!dr.date_from && !dr.date_to) return "all time";
  // "15 Nov 2026" (design.md §4)
  const fmt = (isoDate: string) => {
    const [y, m, d] = isoDate.split("-").map(Number);
    if (!y || !m) return isoDate;
    const month = new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short" });
    return d ? `${d} ${month} ${y}` : `${month} ${y}`;
  };
  if (dr.date_from && dr.date_to) return `${fmt(dr.date_from)} to ${fmt(dr.date_to)}`;
  if (dr.date_from) return `${fmt(dr.date_from)} to today`;
  if (dr.date_to) return `up to ${fmt(dr.date_to)}`;
  return "all time";
}

export function detectActivePreset(dr: DateRange): PresetMonths | null {
  if (!dr.date_from || !dr.date_to) return null;
  const to = new Date(dr.date_to);
  const today = new Date();
  if (iso(to) !== iso(today)) return null;
  const from = new Date(dr.date_from);
  const diff = Math.round(
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()),
  );
  return (PRESET_MONTHS as readonly number[]).includes(diff) ? (diff as PresetMonths) : null;
}

export function loadStoredDateRange(): DateRange {
  if (typeof window === "undefined") return defaultDateRange();
  try {
    const raw = localStorage.getItem(DATE_RANGE_STORAGE_KEY);
    if (!raw) return defaultDateRange();
    const parsed = JSON.parse(raw) as DateRange;
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* fall through */ }
  return defaultDateRange();
}

/**
 * Fixed palette: each Blinkit primary category keeps the same colour
 * everywhere. Colours follow the design data palette in order (design.md
 * §3.4), and grey is reserved for Other / Uncategorised.
 */

import { CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";

export const BLINKIT_CATEGORY_COLORS: Record<string, string> = {
  "Grocery": CHART_SERIES[0],
  "Snacks & Beverages": CHART_SERIES[1],
  "Household Essentials": CHART_SERIES[2],
  "Personal & Healthcare": CHART_SERIES[3],
  "Home & Lifestyle": CHART_SERIES[4],
  "Others": CHART_OTHER,
};

export const BLINKIT_CATEGORY_ORDER = Object.keys(BLINKIT_CATEGORY_COLORS);

/** Series slots not taken by the fixed categories, used for unknown names. */
const FALLBACK = [CHART_SERIES[5], CHART_SERIES[6], ...CHART_SERIES.slice(0, 5)];

function isOther(name: string): boolean {
  const n = name.trim().toLowerCase();
  return !n || n === "other" || n === "others" || n.startsWith("uncategor") || n === "unknown";
}

export function categoryColor(name: string, indexFallback = 0): string {
  const fixed = BLINKIT_CATEGORY_COLORS[name];
  if (fixed) return fixed;
  if (isOther(name ?? "")) return CHART_OTHER;
  return FALLBACK[indexFallback % FALLBACK.length];
}

/** Largest spend at bottom of stack (drawn first). */
export function stackCategoryOrder(
  categories: string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const totals: Record<string, number> = {};
  for (const cat of categories) totals[cat] = 0;
  for (const row of rows) {
    for (const cat of categories) {
      totals[cat] += Number(row[cat]) || 0;
    }
  }
  return [...categories].sort((a, b) => totals[b] - totals[a]);
}

export function sortCategoriesStable(categories: string[]): string[] {
  return [...categories].sort((a, b) => {
    const ia = BLINKIT_CATEGORY_ORDER.indexOf(a);
    const ib = BLINKIT_CATEGORY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

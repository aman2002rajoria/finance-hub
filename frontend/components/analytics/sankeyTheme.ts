/*
 * Money-flow Sankey palette (design.md §3.4, light theme).
 *
 * Nodes are white cards with a hairline ring and a short strip in their data
 * colour; links are light tints of the source's colour. No glows or shadows.
 */

import { CHART, CHART_OTHER, CHART_SERIES } from "@/lib/chart-theme";

export interface NodeTheme {
  /** Card fill */
  fill: string;
  /** Card ring */
  stroke: string;
  /** Strip / link colour from the data palette */
  color: string;
  /** Label text */
  text: string;
  /** Amount text */
  amount: string;
  /** Secondary text (share of flow) */
  muted: string;
}

const [VIOLET, GREEN, ORANGE, PINK, CYAN, AMBER, BLUE] = CHART_SERIES;

/** Data colour per node type. Opening and closing balances are neutral. */
const TYPE_COLOR: Record<string, string> = {
  opening: CHART_OTHER,
  closing: CHART_OTHER,
  income: GREEN,
  refund: CYAN,
  available: BLUE,
  expense: ORANGE,
  savings: VIOLET,
  drawdown: PINK,
  bridge: AMBER,
};

export const SANKEY_COLORS = {
  /** Month columns in the timeline view */
  column: CHART.surface,
  columnLabel: CHART.ink,
  columnSub: CHART.faint,
  link: {
    fillOpacity: 0.16,
    strokeOpacity: 0.3,
    carry: VIOLET,
    faded: 0.08,
  },
};

function themeFor(color: string): NodeTheme {
  return {
    fill: "#FFFFFF",
    stroke: CHART.line,
    color,
    text: CHART.muted,
    amount: CHART.ink,
    muted: CHART.faint,
  };
}

export function nodeTheme(nodeType?: string, layer?: number): NodeTheme {
  const t = nodeType ?? "generic";
  if (t in TYPE_COLOR) return themeFor(TYPE_COLOR[t]);
  if (t.includes("expense")) return themeFor(ORANGE);
  if (layer === 0) return themeFor(GREEN);
  if (layer === 3) return themeFor(VIOLET);
  if (layer === 4) return themeFor(CHART_OTHER);
  return themeFor(BLUE);
}

/** Expense categories take the categorical series in order; Other/Uncategorised are grey. */
export function expenseColor(label: string, index: number): string {
  const n = label.toLowerCase();
  if (n === "other" || n === "others" || n.startsWith("uncategor")) return CHART_OTHER;
  return CHART_SERIES[index % CHART_SERIES.length];
}

export function linkColors(linkType?: string, sourceType?: string): {
  color: string;
  dashed: boolean;
} {
  if (linkType === "carry") return { color: SANKEY_COLORS.link.carry, dashed: true };
  if (linkType === "tree") return { color: ORANGE, dashed: false };
  const t = sourceType ?? "";
  if (t in TYPE_COLOR) return { color: TYPE_COLOR[t] === CHART_OTHER ? GREEN : TYPE_COLOR[t], dashed: false };
  if (t.includes("expense")) return { color: ORANGE, dashed: false };
  return { color: BLUE, dashed: false };
}

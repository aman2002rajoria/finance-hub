/** Shared motion tokens (design.md §14): one spring for movement, one soft ease for fades. */

export const MOTION = {
  /** Quick UI: hovers, toggles */
  fast: 0.18,
  /** Buttons, nav items */
  ui: 0.22,
  /** Card / section entrances */
  card: 0.6,
  /** Chart container reveals */
  chart: 0.6,
  /** KPI number count-up */
  ticker: 0.8,
  /** Stagger between siblings */
  stagger: 0.06,
} as const;

export const EASE = {
  /** Default — polished deceleration */
  out: [0.22, 1, 0.36, 1] as const,
  /** Smooth in-out for layout */
  inOut: [0.4, 0, 0.2, 1] as const,
};

export const REVEAL = {
  card: {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0 },
  },
  chart: {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0 },
  },
  table: {
    hidden: { opacity: 0, y: 10 },
    visible: { opacity: 1, y: 0 },
  },
  fade: {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
  },
} as const;

export type RevealVariant = keyof typeof REVEAL;

/** Extract a numeric value from formatted KPI strings (₹, %, commas). */
export function parseMetricNumber(value: string | number): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—" || trimmed === "-") return null;
  const cleaned = trimmed.replace(/[₹,%\s]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function metricFormatHints(value: string | number): {
  prefix: string;
  suffix: string;
  decimals: number;
} {
  if (typeof value === "number") {
    return { prefix: "", suffix: "", decimals: Number.isInteger(value) ? 0 : 2 };
  }
  const s = String(value);
  const prefix = s.includes("₹") ? "₹" : "";
  const suffix = s.includes("%") ? "%" : "";
  const num = parseMetricNumber(s);
  const decimals = num != null && Number.isInteger(num) ? 0 : 2;
  return { prefix, suffix, decimals };
}

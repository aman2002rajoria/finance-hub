/**
 * Shared Recharts palette (design.md §3.4, §3.5, §10), light + dark.
 *
 * SVG presentation attributes can't read CSS variables, so `CHART` resolves
 * against the current theme each time a key is read. AppShell remounts the
 * page when the theme changes, so charts pick up the new values.
 */
import { resolvedTheme } from "./theme";

const LIGHT = {
  ink: "#1D1D1F",
  ink2: "#48484F",
  muted: "#76767E",
  faint: "#A1A1A8",
  line: "#ECECEF",
  surface: "#F6F6F8",
  surface2: "#EEEEF2",
  card: "#FFFFFF",
  accent: "#00B86B",
  accent600: "#009A59",
  accent700: "#007545",
  accent100: "#C9F5E0",
  accent50: "#E8FBF2",
  success: "#18C964",
  warning: "#FFB020",
  danger: "#F0443A",
  dangerText: "#B3261E",
  // Legacy keys used across chart components, remapped.
  midnight: "#1D1D1F",
  cornflower: "#00B86B",
  electric: "#00B86B",
  dusk: "#76767E",
  smoke: "#A1A1A8",
  silver: "#EEEEF2",
  mist: "#F6F6F8",
  hyacinth: "#7C5CFF",
  abyss: "#1D1D1F",
  spend: "#00B86B",
  income: "#7C5CFF",
  credit: "#18C964",
  debit: "#F0443A",
  grid: "#ECECEF",
  tooltip: {
    background: "#FFFFFF",
    border: "none",
    borderRadius: 16,
    color: "#1D1D1F",
    fontSize: 14,
    padding: "12px 14px",
    boxShadow: "0 0 0 1px #ECECEF, 0 20px 40px -20px rgba(0,0,0,.18)",
  },
};

type ChartPalette = typeof LIGHT;

const DARK: ChartPalette = {
  ...LIGHT,
  ink: "#F3F3F5",
  ink2: "#C2C2CA",
  muted: "#8D8D97",
  faint: "#6A6A73",
  line: "#26262D",
  surface: "#1D1D23",
  surface2: "#2A2A32",
  card: "#16161B",
  accent700: "#8FE9C0",
  accent100: "#133A29",
  accent50: "#0F2A1E",
  dangerText: "#FF7A72",
  midnight: "#F3F3F5",
  dusk: "#8D8D97",
  smoke: "#6A6A73",
  silver: "#2A2A32",
  mist: "#1D1D23",
  abyss: "#F3F3F5",
  grid: "#26262D",
  tooltip: {
    ...LIGHT.tooltip,
    background: "#16161B",
    color: "#F3F3F5",
    boxShadow: "0 0 0 1px #26262D, 0 20px 40px -20px rgba(0,0,0,.6)",
  },
};

export const CHART: ChartPalette = new Proxy(LIGHT, {
  get(_t, key: string) {
    const p = resolvedTheme() === "dark" ? DARK : LIGHT;
    return p[key as keyof ChartPalette];
  },
});

/** Consistent chart heights */
export const CHART_HEIGHT = {
  sm: 240,
  md: 280,
  lg: 320,
} as const;

export const CHART_MARGIN = { top: 12, right: 12, left: 0, bottom: 4 } as const;

/** Bars, progress and donuts grow over ~1s after a short delay (§14). */
export const CHART_ANIM = {
  duration: 1000,
  easing: "ease-out" as const,
  staggerMs: 60,
  lineDuration: 1000,
  areaDuration: 1000,
  barDuration: 1000,
  pieDuration: 1000,
  begin: 200,
} as const;

/**
 * Categorical series in design order (§3.4); same in both themes.
 * "Other" / "Uncategorised" must always use CHART_OTHER.
 */
export const CHART_SERIES = [
  "#7C5CFF",
  "#00B86B",
  "#FF5A1F",
  "#E54B8C",
  "#00A3BF",
  "#FFB020",
  "#2F6BFF",
] as const;

export const CHART_OTHER = "#A1A1A8";

/** Pick a series colour, reserving grey for Other / Uncategorised. */
export function seriesColor(name: string | null | undefined, index: number): string {
  const n = (name || "").toLowerCase();
  if (!n || n === "other" || n === "others" || n.startsWith("uncategor")) return CHART_OTHER;
  return CHART_SERIES[index % CHART_SERIES.length];
}

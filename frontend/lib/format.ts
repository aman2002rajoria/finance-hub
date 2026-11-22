// Number / date / currency formatters tuned for INR.

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const INR_2 = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export const inr  = (n: number | null | undefined): string =>
  n == null || isNaN(n) ? "–" : INR.format(n);

export const inr2 = (n: number | null | undefined): string =>
  n == null || isNaN(n) ? "–" : INR_2.format(n);

export function shortDate(iso: string): string {
  // Avoid the locale's full date string — we want consistent compact form.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // design.md §4: "15 Nov", with the year only when it isn't this year ("15 Nov 2025").
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export function monthLabel(period: string): string {
  // 'YYYY-MM' -> 'Nov 2026' (design.md §4)
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

export function pct(n: number): string {
  return `${(n).toFixed(1)}%`;
}

export function compact(n: number): string {
  // ₹1.2L / ₹95K — handy for tight chart axes
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

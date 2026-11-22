/*
 * Overview-specific formatters (design.md §4): dates read "15 Nov",
 * "15 Nov 2026", "Nov 2026". Money goes through lib/format `inr`, which uses
 * en-IN lakh grouping.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3] ?? 1) };
}

/** "2026-11-15" -> "15 Nov" (adds the year when it isn't this year). */
export function dayMonth(iso: string | null | undefined, alwaysYear = false): string {
  if (!iso) return "";
  const p = parseIso(iso);
  if (!p) return iso;
  const thisYear = new Date().getFullYear();
  const base = `${p.d} ${MONTHS[p.m - 1]}`;
  return alwaysYear || p.y !== thisYear ? `${base} ${p.y}` : base;
}

/** "2026-11" -> "Nov 2026" */
export function monthYear(period: string | null | undefined): string {
  if (!period) return "";
  const p = parseIso(period);
  if (!p) return period;
  return `${MONTHS[p.m - 1]} ${p.y}`;
}

/** "2026-11" -> "Nov" */
export function monthShortName(period: string): string {
  const p = parseIso(period);
  return p ? MONTHS[p.m - 1] : period;
}

/** Backend says "Uncategorized"; the UI says "Uncategorised". */
export function categoryLabel(name: string): string {
  return /^uncategori[sz]ed/i.test(name) ? name.replace(/^uncategori[sz]ed/i, "Uncategorised") : name;
}

export function isUncategorised(name: string | null | undefined): boolean {
  return !name || /^uncategori[sz]ed/i.test(name);
}

/** "1 payment" / "3 payments" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** Rounded, human money for sentences and headings: ₹950, ₹61.8k, ₹12.4L, ₹1.2Cr. */
export function humanInr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const trim = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}k`;
  return `${sign}₹${Math.round(abs)}`;
}

/** Money for sentences: "₹15.4 lakh", "₹1.2 crore", "₹31k", "₹640". */
export function lakhWords(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const one = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e7) return `${sign}₹${one(abs / 1e7)} crore`;
  if (abs >= 1e5) return `${sign}₹${one(abs / 1e5)} lakh`;
  if (abs >= 1e3) return `${sign}₹${Math.round(abs / 1e3)}k`;
  return `${sign}₹${Math.round(abs)}`;
}

/*
 * Words for the goals screen: rupees the way people say them ("₹2.7 lakh"),
 * month names, and spans of time ("a year and 4 months").
 */

import { inr } from "@/lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const one = (v: number) => v.toFixed(1).replace(/\.0$/, "");
const two = (v: number) => v.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");

/** ₹2.7 lakh, ₹8.3 crore, ₹23,500. For sentences. Small amounts round to ₹100. */
export function rupees(n: number, opts: { exact?: boolean } = {}): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${abs >= 1e8 ? one(abs / 1e7) : two(abs / 1e7)} crore`;
  if (abs >= 1e5) return `${sign}₹${abs >= 1e6 ? one(abs / 1e5) : two(abs / 1e5)} lakh`;
  if (opts.exact || abs < 1000) return `${sign}${inr(Math.round(abs))}`;
  return `${sign}${inr(Math.round(abs / 100) * 100)}`;
}

/** Monthly amounts in sentences: always to the nearest ₹100, never "lakh" below ₹10 lakh. */
export function perMonth(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return rupees(n);
  return inr(Math.max(0, Math.ceil(abs / 100) * 100));
}

/** Parts for a NumberTicker that counts up to `rupees(n)`. */
export function rupeesTicker(n: number): { value: number; prefix: string; suffix: string; decimals: number } {
  const abs = Math.abs(n);
  const prefix = n < 0 ? "−₹" : "₹";
  if (abs >= 1e7) return { value: Math.round((abs / 1e7) * 100) / 100, prefix, suffix: " crore", decimals: abs >= 1e8 ? 1 : 2 };
  if (abs >= 1e5) return { value: Math.round((abs / 1e5) * 100) / 100, prefix, suffix: " lakh", decimals: 2 };
  return { value: Math.round(abs / 100) * 100, prefix, suffix: "", decimals: 0 };
}

/** Axis ticks: ₹20L, ₹8.3Cr. */
export function axisRupees(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${one(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `₹${Math.round(abs / 1e5)}L`;
  if (abs >= 1e3) return `₹${Math.round(abs / 1e3)}k`;
  return `₹${Math.round(abs)}`;
}

/** "2027-12-20" -> "Dec 2027" */
export const monYear = (iso?: string | null) =>
  iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${iso.slice(0, 4)}` : "";

/** "2027-03-10" -> "10 Mar 2027" */
export const dayMonYear = (iso?: string | null) =>
  iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""} ${iso.slice(0, 4)}` : "";

/** 1 -> "a month", 5 -> "5 months", 14 -> "a year and 2 months", 40 -> "3 years and 4 months", 62 -> "about 5 years". */
export function span(months: number): string {
  const m = Math.max(0, Math.round(months));
  if (m <= 1) return "a month";
  if (m < 12) return `${m} months`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  const yw = y === 1 ? "a year" : `${y} years`;
  if (r === 0) return yw;
  if (y >= 5) return `about ${Math.round(m / 12)} years`;
  return `${yw} and ${r === 1 ? "a month" : `${r} months`}`;
}

/** Short form for meta lines: "4 months", "2 yrs 5 mo", "28 yrs". */
export function spanShort(months: number): string {
  const m = Math.max(0, Math.round(months));
  if (m < 12) return `${m} ${m === 1 ? "month" : "months"}`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (y >= 5 || r === 0) return `${Math.round(m / 12)} ${Math.round(m / 12) === 1 ? "year" : "years"}`;
  return `${y} ${y === 1 ? "yr" : "yrs"} ${r} mo`;
}

export function plural(n: number, oneWord: string, many = `${oneWord}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? oneWord : many}`;
}

/** Spelled-out small counts for headline sentences. */
export function count(n: number): string {
  const w = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return n >= 0 && n <= 10 ? w[n] : n.toLocaleString("en-IN");
}

export function pctText(n: number): string {
  return `${n.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Compact money for charts and chips: ₹700, ₹4.9k, ₹24k, ₹2.7L, ₹8.3Cr. */
export function short(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${one(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${one(abs / 1e5)}L`;
  if (abs >= 1e4) return `${sign}₹${Math.round(abs / 1e3)}k`;
  if (abs >= 1e3) return `${sign}₹${one(Math.round(abs / 100) / 10)}k`;
  return `${sign}₹${Math.round(abs / 100) * 100}`;
}

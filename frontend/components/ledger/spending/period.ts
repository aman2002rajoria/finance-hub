"use client";

/*
 * The Spending page's period: one month, or the last six.
 *
 * It lives in the shared date range (DateRangeProvider), so picking a month
 * here also moves Home, and the other way round. The convention:
 *   one month    { date_from: "YYYY-MM-01", date_to: last day of that month }
 *   six months   { date_from: first day of the 6th latest statement month,
 *                  date_to: last day of the latest one }
 * Any other range (all time, a custom range) shows the latest month here
 * until a month is picked.
 */

import { useMemo } from "react";

import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { useMonthInsight } from "@/components/analytics/overview/insightsApi";
import type { DateRange } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const RANGE_KEY = "6m";

export const monthShort = (p?: string | null) => MONTHS[Number(p?.slice(5, 7)) - 1] ?? "";
export const monthLong = (p?: string | null) => MONTHS_LONG[Number(p?.slice(5, 7)) - 1] ?? "";

export function monthRange(period: string): DateRange {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return { date_from: `${period}-01`, date_to: `${period}-${String(last).padStart(2, "0")}` };
}

/** "2026-11-20" → "20 Nov" */
export function shortDay(iso?: string | null): string {
  if (!iso) return "";
  return `${Number(iso.slice(8, 10))} ${monthShort(iso.slice(0, 7))}`;
}

export interface SpendingPeriod {
  ready: boolean;
  /** "2026-10" or "6m". */
  key: string | null;
  /** Statement months on file, oldest first. */
  periods: string[];
  /** The latest statement month, and whether it's still running. */
  latest: string | null;
  latestPartial: boolean;
  asOf: string | null;
  /** The month on screen, or null in six-month mode. */
  month: string | null;
  isRange: boolean;
  dr: DateRange;
  /** Words for headings and the drilldown: "October 2026", "1–20 Nov", "Jun to Nov". */
  label: string;
  /** Short words for the ledger line: "Oct", "1–20 Nov", "Jun–Nov". */
  short: string;
  /** The picker. */
  options: { value: string; label: string }[];
  pick: (key: string) => void;
  /** Months that are complete, for "a usual month". */
  completeMonths: string[];
  /** How many months the period covers, counting a running month by its days so far. */
  monthsSpan: number;
}

export function useSpendingPeriod(): SpendingPeriod {
  const { dr, setDr } = useDateRange();
  const latestQ = useMonthInsight(null);
  const L = latestQ.data;

  return useMemo(() => {
    const periods = L?.periods ?? [];
    const latest = L?.period ?? periods[periods.length - 1] ?? null;
    const latestPartial = !!L?.is_partial;
    const asOf = L?.as_of ?? null;
    const six = periods.slice(-6);
    const rangeDr: DateRange = six.length && latest
      ? { date_from: `${six[0]}-01`, date_to: monthRange(latest).date_to }
      : {};

    let key: string | null = null;
    if (dr.date_from && dr.date_to) {
      const p = dr.date_from.slice(0, 7);
      if (dr.date_from.endsWith("-01") && dr.date_to.slice(0, 7) === p && periods.includes(p)) key = p;
      else if (dr.date_from === rangeDr.date_from) key = RANGE_KEY;
    }
    if (!key) key = latest;

    const isRange = key === RANGE_KEY;
    const month = isRange ? null : key;
    const view: DateRange = isRange ? rangeDr : month ? monthRange(month) : {};
    const year = month?.slice(0, 4) ?? "";
    const partialNow = !!month && month === latest && latestPartial;
    const elapsed = L?.days_elapsed ?? 0;

    const label = isRange
      ? `${monthShort(six[0])} to ${monthShort(latest)}${latestPartial ? " so far" : ""}`
      : partialNow
        ? `1–${elapsed} ${monthShort(month)}`
        : `${monthLong(month)} ${year}`;
    const short = isRange
      ? `${monthShort(six[0])}–${monthShort(latest)}`
      : partialNow
        ? `1–${elapsed} ${monthShort(month)}`
        : `${monthLong(month)}`;

    const recent = periods.slice(-4);
    const options = [
      ...recent.map(p => ({
        value: p,
        label: p === latest && latestPartial ? `${monthShort(p)} so far` : monthShort(p),
      })),
      ...(periods.length > 4 ? [{ value: RANGE_KEY, label: `${six.length} months` }] : []),
    ];

    const pick = (k: string) => {
      if (k === RANGE_KEY) setDr(rangeDr);
      else setDr(monthRange(k));
    };

    const completeMonths = latestPartial ? periods.slice(0, -1) : periods;

    const frac = latestPartial && L?.days_in_month ? (L.days_elapsed ?? 0) / L.days_in_month : 1;
    const monthsSpan = isRange ? Math.max(1, six.length - 1 + frac) : 1;

    return {
      ready: !!L, key, monthsSpan, periods, latest, latestPartial, asOf, month, isRange,
      dr: view, label, short, options, pick, completeMonths,
    };
  }, [L, dr, setDr]);
}

/** Median of a list; 0 when empty. */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** "₹950", "₹61.8k", "₹1.2L" for chart labels (house rule: k / L / Cr). */
export function kInr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const trim = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}k`;
  return `${sign}₹${Math.round(abs)}`;
}

export const INVEST = "Investments";
export const isInvest = (c?: string | null) => c === INVEST;

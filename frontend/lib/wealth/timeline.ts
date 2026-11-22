// Daily net worth, market moves and the events that explain the dips.
// Pure functions; no React, no storage.

import type { Holding, LifeEvent } from "./types";

/* ------------------------------------------------------------ dates */

const DAY = 864e5;
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const dayIndex = (start: string, iso: string) =>
  Math.round((Date.parse(iso) - Date.parse(start)) / DAY);

export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(isoDay(t));
  return out;
}

/* -------------------------------------------------- seeded randomness */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform source (Box–Muller). */
export function normal(r: () => number) {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------- holding, day by day */

/** Value of one holding on each day of `days`. Uses its stored daily series,
 *  else steps between flows and grows toward `current` (manual entries). */
export function holdingDaily(h: Holding, days: string[]): number[] {
  if (h.daily?.values.length) {
    const { start, values } = h.daily;
    return days.map((d) => {
      const i = dayIndex(start, d);
      if (i < 0) return d >= h.startDate ? values[0] : 0;
      return values[Math.min(i, values.length - 1)];
    });
  }
  // Manual holding: invested from startDate, easing linearly to current by asOf.
  const t0 = Date.parse(h.startDate), t1 = Date.parse(h.asOf);
  return days.map((d) => {
    const t = Date.parse(d);
    if (t < t0) return 0;
    if (t >= t1 || t1 <= t0) return h.current;
    return h.invested + (h.current - h.invested) * ((t - t0) / (t1 - t0));
  });
}

export interface DayPoint {
  date: string;
  cash: number;
  investments: number;
  invested: number;     // money put in so far (for the "is it working" gap)
  netWorth: number;
}

/**
 * Net worth every day: bank balance from statements (forward-filled) plus
 * each holding's value, minus what's owed today.
 */
export function dailyNetWorth(
  cashSeries: { date: string; net_worth: number }[],
  holdings: Holding[],
  liabilities: number,
  to?: string,
): DayPoint[] {
  if (!cashSeries.length) return [];
  const from = cashSeries[0].date;
  const end = to && to > cashSeries[cashSeries.length - 1].date ? to : cashSeries[cashSeries.length - 1].date;
  const days = dayRange(from, end);
  const cashMap = new Map(cashSeries.map((p) => [p.date, p.net_worth]));
  const perHolding = holdings.map((h) => holdingDaily(h, days));
  const investedPer = holdings.map((h) => {
    const flows = (h.flows?.length ? h.flows : [{ date: h.startDate, amount: h.invested }])
      .slice().sort((a, b) => a.date.localeCompare(b.date));
    let k = 0, acc = 0;
    return days.map((d) => {
      while (k < flows.length && flows[k].date <= d) acc += flows[k++].amount;
      return acc;
    });
  });
  let cash = cashSeries[0].net_worth;
  return days.map((d, i) => {
    if (cashMap.has(d)) cash = cashMap.get(d)!;
    let inv = 0, put = 0;
    for (let j = 0; j < holdings.length; j++) { inv += perHolding[j][i]; put += investedPer[j][i]; }
    return { date: d, cash, investments: inv, invested: put, netWorth: cash + inv - liabilities };
  });
}

/* --------------------------------------------------------- the marks */

export interface Marker {
  date: string;
  label: string;
  emoji: string;
  amount: number;       // signed
  kind: "spend" | "market" | "income" | "event";
}

interface TxnLike {
  date: string;
  amount: number;
  type: string;                 // "debit" | "credit"
  category?: string | null;
  subcategory?: string | null;
  merchant_name?: string | null;
  description?: string | null;
  is_internal_transfer?: boolean;
  is_credit_card_payment?: boolean;
}

const ROUTINE = new Set(["Rent", "Mutual Funds", "Family"]);
const SPEND_LABEL: Record<string, [string, string]> = {
  "Other Travel": ["Trip", "✈️"],
  "Travel to Home": ["Trip home", "🏡"],
  Flights: ["Trip", "✈️"],
  Hotels: ["Trip", "🏨"],
  Phone: ["New phone", "📱"],
  Laptop: ["New laptop", "💻"],
  Tablet: ["New tablet", "📱"],
  Clothing: ["Shopping", "🛍️"],
  Furniture: ["Furniture", "🛋️"],
  Medical: ["Medical bill", "🏥"],
  Health: ["Medical bill", "🏥"],
};
const CAT_LABEL: Record<string, [string, string]> = {
  Travel: ["Trip", "✈️"],
  Electronics: ["Gadget", "📱"],
  Shopping: ["Shopping", "🛍️"],
  Health: ["Medical bill", "🏥"],
  Gifts: ["Gifts", "🎁"],
};

/**
 * Big one-off spends, grouped: debits of `min`+ that aren't rent, SIPs or
 * transfers, clustered by category within `windowDays`.
 */
const BRANDS: [RegExp, Record<string, string>][] = [
  [/\bapple\b|imagine store|unicorn/i, { Phone: "New iPhone", Tablet: "New iPad", Laptop: "New MacBook" }],
  [/samsung/i, { Phone: "New Samsung phone", Tablet: "New Galaxy tab" }],
];
function brandLabel(sub: string, text: string): string | null {
  for (const [re, map] of BRANDS) if (re.test(text) && map[sub]) return map[sub];
  return null;
}

/**
 * Unusual money in: bonuses, and any one-off credit far above normal that
 * isn't salary, interest or a transfer between your own accounts.
 */
export function detectIncomeEvents(txns: TxnLike[], usualIncome: number): Marker[] {
  const floor = Math.max(20000, usualIncome * 0.4);
  return txns
    .filter((t) => t.type === "credit" && !t.is_internal_transfer && !t.is_credit_card_payment)
    .filter((t) => {
      if (t.amount < floor) return false;
      const text = `${t.description ?? ""} ${t.subcategory ?? ""}`;
      return /bonus/i.test(text) || (t.subcategory !== "Salary" && t.subcategory !== "Interest Income");
    })
    .map((t) => {
      const text = `${t.description ?? ""}`;
      const label = /retention/i.test(text) ? "Retention bonus"
        : /bonus/i.test(text) || t.subcategory === "Bonus" ? "Bonus"
        : /refund/i.test(text) ? "Refund"
        : "Extra income";
      return { date: t.date, label, emoji: label.includes("onus") ? "🎉" : "💰", amount: Math.round(t.amount), kind: "income" as const };
    });
}

export function detectSpendEvents(txns: TxnLike[], min = 5000, windowDays = 7): Marker[] {
  const big = txns
    .filter((t) => t.type === "debit" && !t.is_internal_transfer && !t.is_credit_card_payment)
    .filter((t) => t.amount >= min / 3)
    .filter((t) => t.category && t.category !== "Investments" && !ROUTINE.has(t.subcategory ?? ""))
    .sort((a, b) => a.date.localeCompare(b.date));
  const clusters: { cat: string; sub: string; text: string; start: string; end: string; total: number; top: number }[] = [];
  for (const t of big) {
    const cat = t.category!;
    const c = clusters.find((x) => x.cat === cat && dayIndex(x.start, t.date) <= windowDays);
    if (c) {
      c.end = t.date; c.total += t.amount;
      if (t.amount > c.top) { c.top = t.amount; c.sub = t.subcategory ?? c.sub; c.text = `${t.description ?? ""} ${t.merchant_name ?? ""}`; }
    } else clusters.push({ cat, sub: t.subcategory ?? "", text: `${t.description ?? ""} ${t.merchant_name ?? ""}`, start: t.date, end: t.date, total: t.amount, top: t.amount });
  }
  return clusters
    .filter((c) => c.total >= min)
    .map((c) => {
      const [base, emoji] = SPEND_LABEL[c.sub] ?? CAT_LABEL[c.cat] ?? [c.cat, "•"];
      const label = brandLabel(c.sub, c.text) ?? base;
      return { date: c.start, label, emoji, amount: -Math.round(c.total), kind: "spend" as const };
    });
}

/** Equity drawdowns of `minPct`+ from a running peak, marked at the trough. */
export function detectMarketDips(series: { date: string; v: number; value?: number }[], minPct = 4): Marker[] {
  const out: Marker[] = [];
  let peak = series[0]?.v ?? 0, peakDate = series[0]?.date ?? "";
  let trough = peak, troughDate = peakDate;
  let peakVal = series[0]?.value ?? 0, troughVal = peakVal;
  const flush = () => {
    const dd = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
    if (dd >= minPct) out.push({
      date: troughDate, label: `Markets down ${Math.round(dd)}%`, emoji: "📉",
      amount: -Math.round(Math.max(0, peakVal - troughVal)), kind: "market",
    });
  };
  for (const p of series) {
    if (p.v >= peak) {
      flush();
      peak = trough = p.v; peakDate = troughDate = p.date;
      peakVal = troughVal = p.value ?? 0;
    } else if (p.v < trough) { trough = p.v; troughDate = p.date; troughVal = p.value ?? 0; }
  }
  flush();
  void peakDate;
  return out;
}

/**
 * Marks for the net worth chart: your own labelled events win; otherwise
 * auto-detected big spends and market dips. Labelled events within
 * `snapDays` of an auto one replace it (so "Goa trip" beats "Trip").
 */
export function mergeMarkers(user: LifeEvent[], auto: Marker[], snapDays = 4): Marker[] {
  const own: Marker[] = user.map((e) => ({
    date: e.date, label: e.label, emoji: e.emoji ?? "📍", amount: e.amount ?? 0, kind: "event",
  }));
  const rest = auto.filter((a) => !own.some((o) => Math.abs(dayIndex(o.date, a.date)) <= snapDays && a.kind !== "market"));
  return [...own, ...rest].sort((a, b) => a.date.localeCompare(b.date));
}

/** Salary-to-salary view: balance just after each salary vs just before the next. */
export function monthlySawtooth(points: DayPoint[]) {
  const byMonth = new Map<string, DayPoint[]>();
  for (const p of points) {
    const m = p.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(p);
  }
  return Array.from(byMonth.entries()).map(([month, ps]) => {
    const cash = ps.map((p) => p.cash);
    return {
      month,
      high: Math.max(...cash),
      low: Math.min(...cash),
      end: ps[ps.length - 1].netWorth,
      start: ps[0].netWorth,
      change: ps[ps.length - 1].netWorth - ps[0].netWorth,
    };
  });
}

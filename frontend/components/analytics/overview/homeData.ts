"use client";

/*
 * Home's numbers for one scope (a month, or the last 6 months), built from
 * the statements API with the shared definitions (SPEC_v3):
 *   spent    = living spend, every category except Investments
 *   invested = the Investments category (bank SIPs)
 *   saved    = income - spent - invested ("Saved in bank")
 * A partial month is compared like for like: the same days of each earlier
 * complete month, medianed, so one month's bonus or iPad can't skew it.
 */

import { useMemo } from "react";
import useSWR from "swr";

import { useCategories, useFinancialSnapshot } from "@/lib/api";
import { apiPrefix, effectiveMode } from "@/lib/dataMode";
import type { CategoryRow, DateRange, FinancialSnapshot } from "@/lib/types";
import type { Marker } from "@/lib/wealth";

import { monthRange } from "./parts";

export type Scope = { kind: "month"; period: string } | { kind: "6m" };

export interface Figures {
  income: number;
  sources: { salary: number; bonus: number; interest: number; other: number };
  spent: number;
  invested: number;
  saved: number;
  /** Living categories, largest first (no Investments). */
  cats: CategoryRow[];
  excluded: { cardBills: number; transfers: number };
}

export function figuresOf(snap?: FinancialSnapshot | null, cats?: CategoryRow[] | null): Figures | null {
  const pe = snap?.personal_economics;
  if (!pe || !cats) return null;
  const sources = { salary: 0, bonus: 0, interest: 0, other: 0 };
  for (const s of pe.income_by_source ?? []) {
    if (/bonus/i.test(s.subcategory)) sources.bonus += s.amount;
    else if (/salary/i.test(s.subcategory)) sources.salary += s.amount;
    else if (/interest/i.test(s.subcategory)) sources.interest += s.amount;
    else sources.other += s.amount;
  }
  const income = pe.true_income ?? 0;
  const listed = sources.salary + sources.bonus + sources.interest + sources.other;
  if (income > listed + 1) sources.other += income - listed;
  const rows = cats.filter((r) => r.amount > 0);
  const invested = rows.filter((r) => r.category === "Investments").reduce((s, r) => s + r.amount, 0);
  const living = rows.filter((r) => r.category !== "Investments").sort((a, b) => b.amount - a.amount);
  const spent = living.reduce((s, r) => s + r.amount, 0);
  return {
    income,
    sources,
    spent,
    invested,
    saved: income - spent - invested,
    cats: living,
    excluded: {
      cardBills: snap?.excluded?.credit_card_payments ?? 0,
      transfers: snap?.excluded?.internal_transfers ?? 0,
    },
  };
}

/** Share of income not spent on living: saved in bank + invested. */
export const keptPct = (f: Pick<Figures, "income" | "spent">) =>
  f.income > 0 ? Math.round(((f.income - f.spent) / f.income) * 100) : null;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const prevPeriod = (p: string, back: number) => {
  const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 - back, 1));
  return d.toISOString().slice(0, 7);
};

export function scopeRange(scope: Scope, latest: string, asOf?: string | null): DateRange {
  if (scope.kind === "month") return monthRange(scope.period);
  return { date_from: `${prevPeriod(latest, 5)}-01`, date_to: asOf ?? monthRange(latest).date_to };
}

export function scopePeriods(scope: Scope, latest: string): string[] {
  if (scope.kind === "month") return [scope.period];
  return [5, 4, 3, 2, 1, 0].map((b) => prevPeriod(latest, b));
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiPrefix() + path);
  if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
  return (await r.json()) as T;
}

/** Figures for one scope. */
export function useScopeFigures(dr: DateRange | null) {
  const snap = useFinancialSnapshot(dr ?? undefined);
  const cats = useCategories(dr ?? undefined);
  const fig = useMemo(() => figuresOf(snap.data, cats.data), [snap.data, cats.data]);
  return {
    fig,
    loading: !fig && !snap.error && !cats.error,
    error: (snap.error && !snap.data) || (cats.error && !cats.data) ? (snap.error ?? cats.error) : null,
    retry: () => { snap.mutate(); cats.mutate(); },
  };
}

export interface Baseline { income: number; spent: number; invested: number; saved: number; months: number; day: number }

/**
 * "Usual by day N": for each earlier complete month, the figures for days
 * 1..N, then the median of each. Used only while the month is partial.
 */
export function useLikeForLike(period: string | null, day: number | null, complete: string[]) {
  const months = complete.filter((p) => period && p < period).slice(-5);
  const key = period && day && months.length ? ["home-lfl", effectiveMode(), period, day, ...months] : null;
  const q = useSWR<Baseline>(key, async () => {
    const rows = await Promise.all(months.map(async (p) => {
      const last = Number(monthRange(p).date_to!.slice(8, 10));
      const to = `${p}-${String(Math.min(day!, last)).padStart(2, "0")}`;
      const qs = `?date_from=${p}-01&date_to=${to}`;
      const [s, c] = await Promise.all([
        getJson<FinancialSnapshot>(`/analytics/snapshot${qs}`),
        getJson<CategoryRow[]>(`/analytics/categories${qs}`),
      ]);
      return figuresOf(s, c);
    }));
    const ok = rows.filter(Boolean) as Figures[];
    return {
      income: median(ok.map((f) => f.income)),
      spent: median(ok.map((f) => f.spent)),
      invested: median(ok.map((f) => f.invested)),
      saved: median(ok.map((f) => f.saved)),
      months: ok.length,
      day: day!,
    };
  });
  return q;
}

/* --------------------------------------------------------- one-offs */

/** Big one-offs inside the given months, from wealth markers. */
export function oneOffs(markers: Marker[], periods: string[], usualIncome: number) {
  const floor = Math.max(25000, usualIncome * 0.3);
  const inside = markers.filter((m) => periods.includes(m.date.slice(0, 7)));
  return {
    income: inside.filter((m) => m.kind === "income" && m.amount >= floor),
    spend: inside.filter((m) => m.kind === "spend" && -m.amount >= floor),
  };
}

/** "New iPad" -> "iPad", "Retention bonus" -> "bonus". */
export function oneOffName(m: Marker): string {
  if (/bonus/i.test(m.label)) return "bonus";
  return m.label.replace(/^New\s+/i, "");
}

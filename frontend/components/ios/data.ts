"use client";

/*
 * One data view for every iOS screen, built from the same test data the web
 * app uses (useWealth + the statements API), so numbers agree across phones.
 * Read-only: nothing here writes to the store or the backend.
 */

import { useMemo } from "react";
import useSWR from "swr";

import { apiPrefix, effectiveMode } from "@/lib/dataMode";
import {
  CATEGORY_EMOJI, CLASS_OF, KIND_EMOJI, goalEmoji, holdingXirr, monthsBetween, useWealth,
  type Goal, type GoalStatus, type Holding, type Marker,
} from "@/lib/wealth";
import { goalOdds, oddsLabel, oddsTone, ODDS_WORD, type OddsTone } from "@/components/goals/odds";

/** The month the Home and Spending phones show: the bonus + iPad month. */
export const SHOW_MONTH = "2026-10";

interface MonthRow { period: string; spend: number; income: number; net: number }
interface CatRow { period: string; category: string; amount: number }
interface TxnRow {
  date: string; amount: number; type: string; category?: string | null; subcategory?: string | null;
  merchant_name?: string | null; description?: string | null; is_internal_transfer?: boolean; is_credit_card_payment?: boolean;
}
interface Recurring { name: string; category: string; typical_amount: number; months_seen: number; next_date: string; is_emi: boolean }
interface Upload { id: number; filename: string; bank: string; txn_count: number; pages_parsed: number; uploaded_at: string }

const fetcher = (path: string) => fetch(apiPrefix() + path).then((r) => {
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
});

const title = (s: string) => s.toLowerCase().replace(/(^|\s|\.)\S/g, (c) => c.toUpperCase())
  .replace(/\bLtd\b/, "").replace(/\bEmi\b/, "EMI").trim();

export interface GoalView {
  goal: Goal;
  status: GoalStatus;
  emoji: string;
  pct: number;          // odds 0..100
  oddsText: string;
  tone: OddsTone;
  word: string;
  extra: number;        // more a month for 80%
}

export function useIosData() {
  const w = useWealth();
  const mode = effectiveMode();
  // Same SWR keys as lib/wealth/store, so these share its cache.
  const mon = useSWR<MonthRow[]>(`wealth:${mode}:/analytics/monthly`, () => fetcher("/analytics/monthly"));
  const mbc = useSWR<CatRow[]>(`wealth:${mode}:/analytics/monthly-by-category`, () => fetcher("/analytics/monthly-by-category?top_n=50"));
  const txns = useSWR<{ transactions: TxnRow[] }>(`wealth:${mode}:/transactions`, () => fetcher("/transactions?limit=5000"));
  const rec = useSWR<{ items: Recurring[]; monthly_total: number }>(`ios:${mode}:recurring`, () => fetcher("/insights/recurring"));
  const ups = useSWR<Upload[]>(`ios:${mode}:uploads`, () => fetcher("/upload/history"));

  const goals = useMemo<GoalView[]>(() => w.goals.map(({ goal, status }) => {
    const o = goalOdds(goal, status, w.state.profile.sipStepUpPct);
    const tone = oddsTone(o.pct);
    return { goal, status, emoji: goalEmoji(goal), pct: o.pct, oddsText: oddsLabel(o.pct), tone, word: ODDS_WORD[tone], extra: o.extra };
  }), [w.goals, w.state.profile.sipStepUpPct]);

  const view = useMemo(() => {
    const months = Array.isArray(mon.data) ? mon.data : [];
    const cats = Array.isArray(mbc.data) ? mbc.data : [];
    const rows = Array.isArray(txns.data?.transactions) ? txns.data!.transactions : [];
    const investOf = (p: string) => cats.filter((c) => c.period === p && c.category === "Investments").reduce((s, c) => s + c.amount, 0);

    const monthly = months.map((m) => {
      const invest = investOf(m.period);
      const living = m.spend - invest;
      return { period: m.period, income: m.income, living, invest, saved: m.income - living - invest, rate: m.income > 0 ? ((m.income - living) / m.income) * 100 : 0 };
    });
    const cur = monthly.find((m) => m.period === SHOW_MONTH) ?? null;
    const oneOffs = w.markers.filter((k) => k.date.startsWith(SHOW_MONTH) && (k.kind === "income" || k.kind === "spend") && Math.abs(k.amount) >= 50000);

    // Where it went: living categories for the month, vs a usual month (median).
    const catNames = Array.from(new Set(cats.map((c) => c.category))).filter((c) => c !== "Investments");
    const periods = months.map((m) => m.period).filter((p) => p !== "2026-11");
    const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); const i = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2) : 0; };
    const where = catNames.map((c) => {
      const amt = cats.filter((r) => r.period === SHOW_MONTH && r.category === c).reduce((s, r) => s + r.amount, 0);
      const usual = med(periods.map((p) => cats.filter((r) => r.period === p && r.category === c).reduce((s, r) => s + r.amount, 0)));
      const name = c === "Uncategorized" ? "Untagged" : c;
      return { category: name, emoji: CATEGORY_EMOJI[c] ?? "🏷️", amount: amt, usual };
    }).filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);

    // Top merchants in the month (living spend only).
    const byMerchant = new Map<string, { name: string; category: string; amount: number; count: number }>();
    for (const t of rows) {
      if (!t.date.startsWith(SHOW_MONTH) || t.type !== "debit" || t.is_internal_transfer || t.is_credit_card_payment) continue;
      if (t.category === "Investments") continue;
      const name = (t.merchant_name || t.description || "Other").trim();
      const k = name.toLowerCase();
      const m = byMerchant.get(k) ?? { name, category: t.category ?? "Other", amount: 0, count: 0 };
      m.amount += t.amount; m.count += 1;
      byMerchant.set(k, m);
    }
    const merchants = Array.from(byMerchant.values()).sort((a, b) => b.amount - a.amount);

    const recurring = (rec.data?.items ?? []).filter((r) => r.category !== "Investments").map((r) => ({
      ...r, label: r.name.startsWith("EMI: ") ? `${r.name.slice(5)} EMI` : title(r.name), emoji: CATEGORY_EMOJI[r.category] ?? "🔁",
    }));

    const holdings = w.state.holdings.map((h: Holding) => ({
      h, emoji: KIND_EMOJI[h.kind], xirr: holdingXirr(h), gain: h.current - h.invested,
      gainPct: h.invested > 0 ? ((h.current - h.invested) / h.invested) * 100 : 0,
      locked: !!(h.lockInUntil && h.lockInUntil > w.asOf) || h.kind === "epf" || (!!h.maturityDate && h.maturityDate > w.asOf),
      lockText: h.kind === "epf" ? "Age 55" : h.lockInUntil && h.lockInUntil > w.asOf ? monthYear(h.lockInUntil)
        : h.maturityDate && h.maturityDate > w.asOf ? monthYear(h.maturityDate) : null,
      cls: CLASS_OF[h.kind],
    })).sort((a, b) => b.h.current - a.h.current);

    return { monthly, cur, oneOffs, where, merchants, recurring, recurringTotal: rec.data?.monthly_total ?? 0, holdings, uploads: ups.data ?? [] };
  }, [mon.data, mbc.data, txns.data, rec.data, ups.data, w.markers, w.state.holdings, w.asOf]);

  const ready = !w.isLoading && !!mon.data && !!mbc.data && !!txns.data && !!rec.data && w.daily.length > 0;
  return { w, goals, ...view, ready };
}

export type IosData = ReturnType<typeof useIosData>;
export type { Marker };

/* ------------------------------------------------------------ format */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (p: string) => MON[Number(p.slice(5, 7)) - 1];
export const monthYear = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
export const dayMonth = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
export const monthsLeft = (from: string, to: string) => monthsBetween(from, to);

/** ₹31,459 */
export const rupees = (n: number) => `₹${Math.round(Math.abs(n)).toLocaleString("en-IN")}`;
/** ₹3.1L, ₹99.9k, ₹7.6Cr, ₹850 */
export function short(n: number, dp = 1, keep = false): string {
  const a = Math.abs(n);
  const f = (x: number) => { const s = x.toFixed(dp); return keep ? s : s.replace(/\.0+$/, ""); };
  if (a >= 1e7) return `₹${f(a / 1e7)}Cr`;
  if (a >= 1e5) return `₹${f(a / 1e5)}L`;
  if (a >= 1e3) return `₹${f(a / 1e3)}k`;
  return `₹${Math.round(a)}`;
}
export const signed = (n: number, dp = 1) => `${n < 0 ? "−" : "+"}${short(n, dp)}`;

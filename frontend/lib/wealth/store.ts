"use client";

// Wealth store: localStorage, one copy per data mode, so test data never
// mixes with your own entries. Frontend only until the backend exists.

import { useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";

import { apiPrefix, effectiveMode } from "@/lib/dataMode";
import type { Goal, Holding, IncomeEvent, LifeEvent, Liability, Profile, WealthState } from "./types";
import { dailyNetWorth, detectIncomeEvents, detectMarketDips, detectSpendEvents, holdingDaily, mergeMarkers, monthlySawtooth } from "./timeline";
import { CLASS_OF } from "./engine";
import { demoWealth, emptyWealth, SEED_AS_OF } from "./seed";
import {
  allocation, emergency, equityMix, goalStatus, healthChecks, monthKey, passiveIncome,
  portfolioXirr, totals, todayISO,
} from "./engine";

const EVENT = "fh-wealth-change";
// Bump the version when the demo seed changes, so test data reseeds.
const key = () => `fh-wealth-v5-${effectiveMode()}`;
const OLD_KEYS = ["fh-wealth-v4-", "fh-wealth-v3-", "fh-wealth-v2-", "fh-wealth-v1-"];

let cache: { k: string; raw: string | null; state: WealthState } | null = null;

function read(): WealthState {
  if (typeof window === "undefined") return emptyWealth();
  const k = key();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(k);
    // Own data saved before v2: carry it over (test data just reseeds).
    if (raw == null && effectiveMode() === "own") {
      for (const k of OLD_KEYS) { raw = window.localStorage.getItem(k + "own"); if (raw != null) break; }
    }
  } catch { /* blocked */ }
  if (cache && cache.k === k && cache.raw === raw) return cache.state;
  let state: WealthState;
  try {
    state = raw ? (JSON.parse(raw) as WealthState) : effectiveMode() === "test" ? demoWealth() : emptyWealth();
    state = { ...emptyWealth(), ...state, events: state.events ?? [], version: 2 };
  } catch {
    state = effectiveMode() === "test" ? demoWealth() : emptyWealth();
  }
  cache = { k, raw, state };
  return state;
}

function write(next: WealthState) {
  try { window.localStorage.setItem(key(), JSON.stringify(next)); } catch { /* blocked */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

const SERVER_STATE = emptyWealth();
export function useWealthState(): WealthState {
  return useSyncExternalStore(subscribe, read, () => SERVER_STATE);
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const update = (f: (s: WealthState) => WealthState) => write(f(structuredClone(read())));

/* ------------------------------------------------------------ actions */

export const wealth = {
  saveHolding(h: Omit<Holding, "id"> & { id?: string }) {
    update((s) => {
      const id = h.id ?? uid("h");
      const i = s.holdings.findIndex((x) => x.id === id);
      const row = { ...h, id } as Holding;
      if (i >= 0) s.holdings[i] = row; else s.holdings.push(row);
      return s;
    });
  },
  removeHolding(id: string) {
    update((s) => ({ ...s, holdings: s.holdings.filter((h) => h.id !== id) }));
  },
  saveLiability(l: Omit<Liability, "id"> & { id?: string }) {
    update((s) => {
      const id = l.id ?? uid("l");
      const i = s.liabilities.findIndex((x) => x.id === id);
      const row = { ...l, id } as Liability;
      if (i >= 0) s.liabilities[i] = row; else s.liabilities.push(row);
      return s;
    });
  },
  removeLiability(id: string) {
    update((s) => ({ ...s, liabilities: s.liabilities.filter((l) => l.id !== id) }));
  },
  addIncome(e: Omit<IncomeEvent, "id">) {
    update((s) => ({ ...s, income: [...s.income, { ...e, id: uid("i") }] }));
  },
  removeIncome(id: string) {
    update((s) => ({ ...s, income: s.income.filter((e) => e.id !== id) }));
  },
  saveGoal(g: Omit<Goal, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
    update((s) => {
      const id = g.id ?? uid("g");
      const i = s.goals.findIndex((x) => x.id === id);
      const row = { ...g, id, createdAt: g.createdAt ?? todayISO() } as Goal;
      if (i >= 0) s.goals[i] = row; else s.goals.push(row);
      return s;
    });
  },
  removeGoal(id: string) {
    update((s) => ({
      ...s,
      goals: s.goals.filter((g) => g.id !== id),
      holdings: s.holdings.map((h) => (h.goalId === id ? { ...h, goalId: undefined } : h)),
    }));
  },
  linkHolding(holdingId: string, goalId: string | undefined) {
    update((s) => ({ ...s, holdings: s.holdings.map((h) => (h.id === holdingId ? { ...h, goalId } : h)) }));
  },
  saveEvent(e: Omit<LifeEvent, "id"> & { id?: string }) {
    update((s) => {
      const id = e.id ?? uid("e");
      const i = s.events.findIndex((x) => x.id === id);
      const row = { ...e, id } as LifeEvent;
      if (i >= 0) s.events[i] = row; else s.events.push(row);
      return s;
    });
  },
  removeEvent(id: string) {
    update((s) => ({ ...s, events: s.events.filter((e) => e.id !== id) }));
  },
  setProfile(p: Partial<Profile>) {
    update((s) => ({ ...s, profile: { ...s.profile, ...p } }));
  },
  /** Test data only: put the demo wealth back. */
  resetDemo() {
    if (effectiveMode() !== "test") return;
    write(demoWealth());
  },
};

/* ------------------------------------------------ statement-side inputs */

interface NetWorthPoint { date: string; net_worth: number }
interface TxnRow {
  date: string; amount: number; type: string; category?: string | null; subcategory?: string | null;
  merchant_name?: string | null; description?: string | null; account_name?: string | null;
  is_internal_transfer?: boolean; is_credit_card_payment?: boolean;
}
interface MonthRow { period: string; spend: number; income: number; net: number }
interface CardRow { cc_account_name: string; billing_month: string; difference: number; paid_known: boolean }

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const CARD_NAME: Record<string, string> = { SBI_CC: "SBI Card", SLICE_CC: "Slice Card" };
interface Snapshot {
  personal_economics?: { savings_rate_pct?: number; income_by_source?: { subcategory: string; amount: number }[] };
  monthly_averages?: { avg_income?: number; avg_spend?: number; avg_saving_rate_pct?: number };
}

const fetcher = (path: string) => fetch(apiPrefix() + path).then((r) => {
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
});

/**
 * Everything the wealth / goals / overview screens need, in one place:
 * stored holdings and goals, plus cash, income and spending from statements.
 */
export function useWealth() {
  const state = useWealthState();
  const mode = effectiveMode();
  const bal = useSWR<NetWorthPoint[]>(`wealth:${mode}:/analytics/net-worth`, () => fetcher("/analytics/net-worth"));
  const snap = useSWR<Snapshot>(`wealth:${mode}:/analytics/snapshot`, () => fetcher("/analytics/snapshot"));
  const txns = useSWR<{ transactions: TxnRow[] }>(`wealth:${mode}:/transactions`, () => fetcher("/transactions?limit=5000"));
  const mon = useSWR<MonthRow[]>(`wealth:${mode}:/analytics/monthly`, () => fetcher("/analytics/monthly"));
  const mbc = useSWR<{ period: string; category: string; amount: number }[]>(
    `wealth:${mode}:/analytics/monthly-by-category`, () => fetcher("/analytics/monthly-by-category?top_n=50"));
  const cards = useSWR<CardRow[]>(`wealth:${mode}:/analytics/cc-reconciliation`, () => fetcher("/analytics/cc-reconciliation"));

  const view = useMemo(() => {
    const series = Array.isArray(bal.data) ? bal.data : [];
    const cash = series.length ? series[series.length - 1].net_worth : 0;
    const cashAsOf = series.length ? series[series.length - 1].date : null;
    const asOf = mode === "test" ? SEED_AS_OF : todayISO();

    const avg = snap.data?.monthly_averages;
    const txnRows = Array.isArray(txns.data?.transactions) ? txns.data!.transactions : [];

    // Card bills still unpaid come from the statements (spend not yet paid
    // from the bank). Manual card entries are ignored when statements have cards.
    const cardRows = Array.isArray(cards.data) ? cards.data : [];
    const dues = new Map<string, number>();
    for (const r of cardRows) if (!r.paid_known && r.difference > 0) dues.set(r.cc_account_name, (dues.get(r.cc_account_name) ?? 0) + r.difference);
    const cardLiabilities: Liability[] = Array.from(dues.entries()).map(([name, amt]) => ({
      id: `card-${name}`, name: `${CARD_NAME[name] ?? name} bill`, kind: "credit_card", outstanding: Math.round(amt), rate: 0,
    }));
    const liabilities: Liability[] = [
      ...cardLiabilities,
      ...state.liabilities.filter((l) => !(cardLiabilities.length && l.kind === "credit_card")),
    ];
    const t = totals(cash, state.holdings, liabilities);

    // A "usual month": medians of complete months, so a bonus or a big
    // one-off purchase doesn't distort income, spending or the surplus.
    const monthRows = Array.isArray(mon.data) ? mon.data : [];
    const partial = cashAsOf && Number(cashAsOf.slice(8, 10)) < 25 ? cashAsOf.slice(0, 7) : null;
    const complete = monthRows.filter((m) => m.period !== partial);
    // Investments as the statements see them (the "Investments" category),
    // so living spend is right even when no holdings are entered.
    const investBy = new Map<string, number>();
    for (const r of Array.isArray(mbc.data) ? mbc.data : []) {
      if (r.category === "Investments") investBy.set(r.period, (investBy.get(r.period) ?? 0) + r.amount);
    }
    const usualIncome = median(complete.map((m) => m.income)) ?? avg?.avg_income ?? 0;
    const usualLiving = median(complete.map((m) => m.spend - (investBy.get(m.period) ?? 0)));
    const usualInvest = median(complete.map((m) => investBy.get(m.period) ?? 0));
    const income = state.profile.monthlyIncome ?? usualIncome;
    // Statement "spend" includes SIPs; living costs shouldn't.
    const monthlyExpenses = Math.max(0, usualLiving ?? (avg?.avg_spend ?? 0) - t.sipFromBank);
    const bankInvest = usualInvest ?? t.sipFromBank;
    // Share of income not spent on living (saved in the bank + invested).
    const savingsRatePct = income > 0 ? ((income - monthlyExpenses) / income) * 100 : null;
    // EPF is deducted before salary reaches the bank, so compare bank SIPs to take-home.
    const investRatePct = income > 0 ? (bankInvest / income) * 100 : null;
    // Surplus = the median month's actual leftover (income − spend, where
    // statement spend already includes investing). Medians of the parts don't
    // add up to the median of the whole, so take it directly.
    const medNet = median(complete.map((m) => m.net));
    const surplus = state.profile.monthlyIncome != null || medNet == null
      ? income - monthlyExpenses - bankInvest
      : medNet;
    const usual = { income, spend: monthlyExpenses, invest: bankInvest, surplus, months: complete.length };

    const em = emergency(cash, state.holdings, monthlyExpenses, state.profile.emergencyMonthsTarget);
    const mix = equityMix(state.holdings, state.profile);
    const alloc = allocation(cash, state.holdings);
    // Interest from the statements + what they can't see (coupons, dividends).
    const stmtInterest: IncomeEvent[] = txnRows
      .filter((r) => r.type === "credit" && r.subcategory === "Interest Income")
      .map((r, i) => ({ id: `si-${i}`, date: r.date, kind: "interest", amount: r.amount, source: r.account_name ?? "Bank" }));
    const passive = passiveIncome([...stmtInterest, ...state.income.filter((e) => e.kind !== "realised_gain")], 12, asOf);
    const xirrPct = portfolioXirr(state.holdings);
    // One emergency-fund definition everywhere: the goal's target and money
    // are the same numbers the Wealth card shows.
    const goals = state.goals
      .map((g) => (g.kind === "emergency"
        ? { ...g, targetToday: Math.round(em.target), inflation: 0, saved: Math.round(em.fromBank) }
        : g))
      .map((g) => ({ goal: g, status: goalStatus(g, state.holdings, asOf, state.profile.sipStepUpPct) }))
      .sort((a, b) => a.goal.targetDate.localeCompare(b.goal.targetDate));
    const checks = healthChecks({
      emergencyMonths: em.months,
      emergencyTarget: state.profile.emergencyMonthsTarget,
      savingsRatePct,
      investRatePct,
      equityPct: mix.equityPct,
      targetEquityPct: mix.targetPct,
      liabilities,
      profile: state.profile,
      annualIncome: income * 12,
    });

    // Net worth history: month-end bank cash + month-end holding values - debts today.
    const cashByMonth = new Map<string, number>();
    for (const p of series) cashByMonth.set(monthKey(p.date), p.net_worth);
    const months = Array.from(new Set([
      ...cashByMonth.keys(),
      ...state.holdings.flatMap((h) => (h.valueHistory ?? []).map((v) => v.month)),
    ]))
      .sort()
      // Before the first statement there's no bank balance to show, and
      // counting it as ₹0 makes net worth look like it jumped. Start there.
      .filter((m) => !series.length || m >= monthKey(series[0].date))
      .slice(-12);
    let lastCash = 0;
    const history = months.map((m) => {
      if (cashByMonth.has(m)) lastCash = cashByMonth.get(m)!;
      let inv = 0;
      for (const h of state.holdings) {
        const hv = h.valueHistory?.find((v) => v.month === m);
        if (hv) inv += hv.value;
        else if (!h.valueHistory?.length && monthKey(h.startDate) <= m) inv += h.current;
      }
      return { month: m, cash: lastCash, investments: inv, netWorth: lastCash + inv - t.liabilities };
    });

    // Every day: bank (from statements) + holdings - debts. Not a straight line.
    const daily = dailyNetWorth(series, state.holdings, t.liabilities, asOf);
    const days = daily.map((d) => d.date);
    const equityHoldings = state.holdings.filter((h) => CLASS_OF[h.kind] === "equity");
    const eqSeries = days.length
      ? (() => {
          const per = equityHoldings.map((h) => holdingDaily(h, days));
          // Money put into equity so far, day by day (not all holdings: an FD
          // or EPF credit would otherwise look like a market move).
          const put = equityHoldings.map((h) => {
            const flows = (h.flows?.length ? h.flows : [{ date: h.startDate, amount: h.invested }])
              .slice().sort((a, b) => a.date.localeCompare(b.date));
            let k = 0, acc = 0;
            return days.map((d) => {
              while (k < flows.length && flows[k].date <= d) acc += flows[k++].amount;
              return acc;
            });
          });
          // Time-weighted index: each day's change with that day's new money
          // taken out, so SIPs and sales don't look like market moves.
          let idx = 1, prevV = 0, prevP = 0;
          const raw = days.map((d, i) => {
            let v = 0, p = 0;
            for (let j = 0; j < per.length; j++) { v += per[j][i]; p += put[j][i]; }
            if (i > 0 && prevV > 0) idx *= (v - (p - prevP)) / prevV;
            prevV = v; prevP = p;
            return { date: d, v: idx, eq: v };
          });
          // Express the index in today's rupees, so a dip's amount reads as
          // "what today's holdings would have lost".
          const last = raw[raw.length - 1];
          const scale = last && last.v > 0 ? last.eq / last.v : 0;
          return raw.map((r) => ({ date: r.date, v: r.v, value: r.v * scale }));
        })()
      : [];
    const autoMarks = [
      ...detectSpendEvents(txnRows, Math.max(5000, income * 0.1)),
      ...detectIncomeEvents(txnRows, income),
      ...detectMarketDips(eqSeries, 3),
    ];
    const markers = mergeMarkers(state.events ?? [], autoMarks);
    const monthSwings = monthlySawtooth(daily);

    return {
      state, mode, asOf, cash, cashAsOf, totals: t, income, monthlyExpenses, usual, liabilities,
      savingsRatePct, investRatePct, emergency: em, mix, allocation: alloc, passive,
      xirrPct, goals, checks, history, daily, markers, monthSwings,
      hasHoldings: state.holdings.length > 0,
      hasGoals: state.goals.length > 0,
    };
  }, [state, bal.data, snap.data, txns.data, mon.data, mbc.data, cards.data, mode]);

  return {
    ...view,
    isLoading: bal.isLoading || snap.isLoading,
    error: bal.error || snap.error,
    retry: () => { bal.mutate(); snap.mutate(); },
  };
}

export type WealthView = ReturnType<typeof useWealth>;

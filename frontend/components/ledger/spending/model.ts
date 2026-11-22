"use client";

/*
 * One pass over six months of statement rows, shaped for Spending's habit
 * cards (kind of spend, pace, merchants, when, how you pay, small payments).
 *
 * The rows follow the server's living-spend definition exactly, so every
 * month here adds up to /analytics/monthly minus Investments:
 *   debits, minus card bills, transfers and Investments,
 *   minus purchases converted to EMI (their principal),
 *   plus each EMI instalment in its month,
 *   minus refunds.
 */

import { useMemo } from "react";

import { useRecurring, type RecurringResp } from "@/components/analytics/overview/insightsApi";
import { cleanName } from "@/components/ledger/merchant";
import { useEMIPlans, useTransactions } from "@/lib/api";
import type { EMIPlan, Transaction } from "@/lib/types";
import { useWealth } from "@/lib/wealth";

import { isInvest, median, monthRange, type SpendingPeriod } from "./period";

export type Kind = "fixed" | "everyday" | "lifestyle" | "oneoff";
export type Pay = "upi" | "card" | "bank" | "other";

export const KINDS: { key: Kind; label: string; emoji: string; hint: string }[] = [
  { key: "fixed", label: "Fixed", emoji: "🏠", hint: "Rent, bills, subscriptions, EMIs and other payments that repeat at the same amount" },
  { key: "everyday", label: "Everyday", emoji: "🛒", hint: "Food, groceries, commute, health and untagged small payments" },
  { key: "lifestyle", label: "Lifestyle", emoji: "🛍️", hint: "Shopping, travel, eating out, entertainment, gifts" },
  { key: "oneoff", label: "One-offs", emoji: "💥", hint: "Single payments far above a usual spend" },
];

export const PAYS: { key: Pay; label: string }[] = [
  { key: "upi", label: "UPI" },
  { key: "card", label: "Credit card" },
  { key: "bank", label: "Bank transfer" },
  { key: "other", label: "Debit card, cash" },
];

export interface SpendRow {
  id: string;
  date: string;
  period: string;
  /** Negative for a refund. */
  amount: number;
  kind: Kind;
  pay: Pay;
  category: string;
  sub: string;
  /** Grouping key for a merchant, e.g. "swiggy". */
  key: string;
  name: string;
  emi: boolean;
}

export interface SpendModel {
  rows: SpendRow[];
  /** The six statement months, oldest first. */
  months: string[];
  /** Complete months among them (for "a usual month"). */
  complete: string[];
  totals: Map<string, number>;
  byKind: Map<string, Record<Kind, number>>;
  /** period → cumulative living spend by day (index 0 = day 1). */
  cumulative: Map<string, number[]>;
  oneOffMin: number;
  plans: EMIPlan[];
  recurring: RecurringResp | undefined;
  /** First date each merchant key shows up in the window. */
  firstSeen: Map<string, string>;
  asOf: string | null;
}

const EVERYDAY_SUBS = new Set(["Groceries", "Online Ordering", "Daily Commute", "Fuel", "Health", "Medical", "Pharmacy"]);
const FIXED_SUBS = new Set(["Rent", "Subscriptions", "Electricity", "Broadband", "Mobile", "Water", "Gas", "Insurance"]);
const isUntagged = (c?: string | null) => !c || /^uncategori[sz]ed/i.test(c);

/** "Swiggy Limited" and "Swiggy" are one merchant. */
const ALIAS: Record<string, string> = { "avenue supermarts": "DMart", "swiggy instamart": "Instamart" };

export function merchantKey(t: { merchant_name?: string | null; description?: string }): { key: string; name: string } {
  const m = cleanName(t.merchant_name);
  // Stubs like "Online" or "POS" say nothing; the statement text does.
  const stub = !m || m.length <= 3 || /^(online|payment|pos|upi)$/i.test(m);
  let name = (stub ? cleanName(t.description) : m) || m || "Unknown";
  name = ALIAS[name.toLowerCase()] ?? name;
  return { key: name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() || name.toLowerCase(), name };
}

function payOf(t: Transaction): Pay {
  if (t.account_type === "credit_card") return "card";
  const m = (t.txn_mode ?? "").toUpperCase();
  if (m.includes("UPI")) return "upi";
  if (/NEFT|IMPS|RTGS|NACH|PAYMENT|ACH/.test(m)) return "bank";
  return "other";
}

const pad = (n: number) => String(n).padStart(2, "0");
function addMonths(period: string, k: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)) - 1 + k;
  return `${y + Math.floor(m / 12)}-${pad((m % 12 + 12) % 12 + 1)}`;
}

export function daysIn(period: string): number {
  return Number(monthRange(period).date_to?.slice(8, 10) ?? 30);
}

export function buildModel(
  txns: Transaction[],
  months: string[],
  complete: string[],
  plans: EMIPlan[],
  recurring: RecurringResp | undefined,
  usualSpend: number,
  asOf: string | null,
): SpendModel {
  const oneOffMin = Math.max(10000, usualSpend * 0.15);
  const inWindow = new Set(months);

  // Payees that repeat at a steady amount (rent, a monthly family transfer).
  const fixedPayees = new Set<string>();
  for (const it of recurring?.items ?? []) {
    if (isInvest(it.category) || isUntagged(it.category) || it.category === "Food") continue;
    if (it.typical_amount > 0 && Math.abs(it.last_amount - it.typical_amount) / it.typical_amount <= 0.1) {
      fixedPayees.add(merchantKey({ merchant_name: it.name.replace(/^EMI:\s*/, "") }).key);
    }
  }

  const rows: SpendRow[] = [];
  const refunds: Transaction[] = [];
  const firstSeen = new Map<string, string>();

  for (const t of txns) {
    if (t.is_internal_transfer || t.is_credit_card_payment || isInvest(t.category)) continue;
    const period = t.date.slice(0, 7);
    if (!inWindow.has(period)) continue;
    if (t.type === "credit") {
      if (t.is_refund) refunds.push(t);
      continue;
    }
    const { key, name } = merchantKey(t);
    if (!firstSeen.has(key) || t.date < firstSeen.get(key)!) firstSeen.set(key, t.date);
    if (t.is_emi) continue; // the instalments stand in for the purchase
    const cat = t.category ?? "";
    const sub = t.subcategory ?? "";
    let kind: Kind;
    if (cat === "Bills & Utilities" || FIXED_SUBS.has(sub) || fixedPayees.has(key)) kind = "fixed";
    else if (t.amount >= oneOffMin) kind = "oneoff";
    else if (isUntagged(cat) || (cat === "Food" && sub !== "Dine-out") || EVERYDAY_SUBS.has(sub)) kind = "everyday";
    else kind = "lifestyle";
    rows.push({
      id: t.id, date: t.date, period, amount: t.amount, kind, pay: payOf(t),
      category: isUntagged(cat) ? "Uncategorized" : cat, sub, key, name, emi: false,
    });
  }

  // EMI instalments, one per month from the month of purchase.
  for (const pl of plans) {
    const start = pl.start_date.slice(0, 7);
    const day = Number(pl.start_date.slice(8, 10));
    const orig = txns.find(t => t.id === pl.original_transaction_id);
    const { key, name } = orig ? merchantKey(orig) : { key: "emi", name: "EMI" };
    for (let k = 0; k < pl.tenure_months; k++) {
      const period = addMonths(start, k);
      if (!inWindow.has(period)) continue;
      const date = `${period}-${pad(Math.min(day, daysIn(period)))}`;
      if (asOf && date.slice(0, 7) > asOf.slice(0, 7)) continue;
      rows.push({
        id: `emi-${pl.id}-${k}`, date: asOf && date > asOf ? asOf : date, period, amount: pl.monthly_amount,
        kind: "fixed", pay: orig?.account_type === "credit_card" ? "card" : "bank",
        category: orig?.category ?? "EMI", sub: orig?.subcategory ?? "", key, name, emi: true,
      });
    }
  }

  // Refunds come off the kind that merchant is usually paid from.
  for (const t of refunds) {
    const { key, name } = merchantKey(t);
    const seen = rows.filter(r => r.key === key);
    const tally = new Map<Kind, number>();
    seen.forEach(r => {
      const k: Kind = r.kind === "oneoff" ? "lifestyle" : r.kind;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    });
    const kind = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "lifestyle";
    rows.push({
      id: t.id, date: t.date, period: t.date.slice(0, 7), amount: -t.amount, kind, pay: payOf(t),
      category: seen[0]?.category ?? "Refunds", sub: seen[0]?.sub ?? "", key, name, emi: false,
    });
  }

  const totals = new Map<string, number>();
  const byKind = new Map<string, Record<Kind, number>>();
  const daily = new Map<string, number[]>();
  for (const p of months) {
    totals.set(p, 0);
    byKind.set(p, { fixed: 0, everyday: 0, lifestyle: 0, oneoff: 0 });
    daily.set(p, Array(daysIn(p)).fill(0));
  }
  for (const r of rows) {
    totals.set(r.period, (totals.get(r.period) ?? 0) + r.amount);
    byKind.get(r.period)![r.kind] += r.amount;
    const d = Number(r.date.slice(8, 10)) - 1;
    const arr = daily.get(r.period)!;
    arr[Math.min(d, arr.length - 1)] += r.amount;
  }
  const cumulative = new Map<string, number[]>();
  daily.forEach((arr, p) => {
    let s = 0;
    cumulative.set(p, arr.map(v => (s += v)));
  });

  return { rows, months, complete, totals, byKind, cumulative, oneOffMin, plans, recurring, firstSeen, asOf };
}

/** The six-month model, shared by the habit cards. */
export function useSpendModel(p: SpendingPeriod) {
  const months = p.periods.slice(-6);
  const from = months[0] ? `${months[0]}-01` : undefined;
  const to = p.latest ? monthRange(p.latest).date_to : undefined;
  const tx = useTransactions(p.ready && from && to ? { date_from: from, date_to: to, limit: 5000 } : null);
  const rec = useRecurring(6);
  const emi = useEMIPlans();
  const w = useWealth();
  const usualSpend = w.usual?.spend ?? 0;
  const complete = useMemo(() => months.filter(m => p.completeMonths.includes(m)), [months.join(), p.completeMonths]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => {
    if (!tx.data || !rec.data || (!emi.data && !emi.error)) return null;
    return buildModel(tx.data.transactions, months, complete, emi.data ?? [], rec.data, usualSpend, p.asOf);
  }, [tx.data, rec.data, emi.data, emi.error, months.join(), complete, usualSpend, p.asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    model,
    loading: !p.ready || (!model && !tx.error && !rec.error),
    error: tx.error ?? rec.error,
    retry: () => { tx.mutate(); rec.mutate(); emi.mutate(); },
  };
}

export type SpendModelQ = ReturnType<typeof useSpendModel>;

/** Months the period covers: the picked month, or all six. */
export function selectedMonths(p: SpendingPeriod, m: SpendModel): string[] {
  return p.isRange ? m.months : p.month ? [p.month] : [];
}

/** Median of a kind across complete months: "a usual month" of it. */
export function usualKind(m: SpendModel, k: Kind): number {
  return median(m.complete.map(p => m.byKind.get(p)?.[k] ?? 0));
}

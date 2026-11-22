"use client";

/*
 * Hooks for the read-only Overview insights in backend/api/routes_insights_v2.py.
 * They follow the data mode (own data vs test data) the same way lib/api.ts
 * does, by reading apiPrefix() at call time.
 */

import useSWR from "swr";

import { apiPrefix } from "@/lib/dataMode";

export interface MonthDay { date: string; day: number; amount: number }
export interface MonthCumulative { day: number; this_month: number | null; last_month: number | null }
export interface MonthChange {
  category: string;
  current: number;
  previous: number;
  delta: number;
  top_counterparty: string | null;
  top_counterparty_delta: number | null;
  top_counterparty_share: number | null;
}
export interface BigExpense {
  id: string;
  date: string;
  name: string;
  description: string;
  category: string;
  account_name: string;
  amount: number;
}
export interface MonthInsight {
  has_data: boolean;
  period: string | null;
  prev_period?: string | null;
  periods: string[];
  as_of?: string;
  is_partial?: boolean;
  days_in_month?: number;
  days_elapsed?: number;
  total?: number;
  prev_total?: number | null;
  prev_same_point?: number | null;
  txn_count?: number;
  spend_days?: number;
  daily?: MonthDay[];
  cumulative?: MonthCumulative[];
  changes?: MonthChange[];
  biggest?: BigExpense[];
}

export interface RecurringItem {
  name: string;
  category: string;
  typical_amount: number;
  months_seen: number;
  last_date: string;
  last_amount: number;
  usual_day: number;
  next_date: string;
  is_emi: boolean;
}
export interface RecurringResp {
  as_of: string | null;
  months: number;
  window_start?: string;
  monthly_total: number;
  items: RecurringItem[];
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(apiPrefix() + path);
  if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
  return (await r.json()) as T;
}

export function useMonthInsight(period?: string | null) {
  const key = `/insights/month${period ? `?period=${encodeURIComponent(period)}` : ""}`;
  return useSWR<MonthInsight>(key, get);
}

export function useRecurring(months = 6) {
  return useSWR<RecurringResp>(`/insights/recurring?months=${months}`, get);
}

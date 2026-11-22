"use client";

/*
 * Spending's four story cards: where it went (category bars), what changed
 * against last month, the biggest one-offs, and what repeats. Every number
 * is living spend: the Investments category (bank SIPs) is never in it.
 * Each card handles its own loading, empty and error state.
 */

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react";
import type React from "react";
import { useMemo } from "react";

import { useMonthInsight, useRecurring } from "@/components/analytics/overview/insightsApi";
import { cleanName } from "@/components/ledger/merchant";
import { Card, CardTitle, Chip, EmptyState, ErrorCard, Skeleton } from "@/components/ui";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useCategories, useMonthlyByCategory, useTransactions } from "@/lib/api";
import { inr } from "@/lib/format";
import { CATEGORY_EMOJI, useWealth } from "@/lib/wealth";

import { merchantKey } from "./model";
import {
  isInvest, kInr, median, monthLong, monthShort, shortDay, type SpendingPeriod,
} from "./period";

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

const isUntagged = (c?: string | null) => !c || /^uncategori[sz]ed/i.test(c);
export const catLabel = (c: string) => (isUntagged(c) ? "Untagged" : c);
export const catEmoji = (c: string) => (isUntagged(c) ? "🏷️" : CATEGORY_EMOJI[c] ?? "•");

const SUB_EMOJI: Record<string, string> = {
  Phone: "📱", Tablet: "📱", Laptop: "💻", Flights: "✈️", "Other Travel": "✈️", Hotels: "🏨",
  "Travel to Home": "🏡", Clothing: "🛍️", Furniture: "🛋️", Medical: "🏥", Groceries: "🛒", Rent: "🏠",
};

/** A readable payee; falls back to the statement text when the merchant is a stub like "Online". */
function oneOffName(merchant: string | null, description: string): string {
  const m = cleanName(merchant);
  if (m && m.length > 3 && !/^(online|payment|pos|upi)$/i.test(m)) return m;
  return cleanName(description) || description;
}

/** Everyday spends that are big but not one-offs. */
const ROUTINE = new Set([
  "Rent", "Groceries", "Online Ordering", "Daily Commute", "Subscriptions", "Electricity", "Broadband",
  "Mobile", "Water", "Gas", "Fuel",
]);

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  return /fetch|network|Failed to/i.test(raw) || /^5\d\d/.test(raw)
    ? "The Finance Hub server didn't answer. Check it's running, then try again."
    : "Try again, and if it keeps failing, reload the page.";
}

export function StoryCard({
  title, subtitle, action, className, loading, error, onRetry, empty, emptyTitle, emptyHint, skeleton, children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  skeleton?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (error && !loading) {
    return <ErrorCard className={clsx("h-full", className)} title={`${title} didn't load`} message={errText(error)} onRetry={onRetry} />;
  }
  return (
    <Card className={clsx("h-full", className)}>
      <CardTitle subtitle={subtitle} action={loading ? undefined : action}>{title}</CardTitle>
      <div className="mt-5">
        {loading ? (
          <div aria-busy="true" aria-label={`Loading ${title.toLowerCase()}`}>{skeleton ?? <Rows n={4} />}</div>
        ) : empty ? (
          <EmptyState illustration="receipt" title={emptyTitle ?? "Nothing here yet"} hint={emptyHint} />
        ) : children}
      </div>
    </Card>
  );
}

export function Rows({ n }: { n: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 !rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function Delta({ d, floor = 300 }: { d: number; floor?: number }) {
  if (Math.abs(d) < floor) return <span className="text-sm font-medium text-muted">≈ usual</span>;
  const up = d > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={clsx("inline-flex items-center gap-0.5 text-sm font-semibold tabular-nums", up ? "text-ink-2" : "text-accent-700")}>
      <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
      {kInr(Math.abs(d))}
      <span className="sr-only">{up ? "more" : "less"}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Where it went: living spend by category, against a usual month.
// ---------------------------------------------------------------------------

export function CategoryBarsCard({
  p, onDrill, className,
}: { p: SpendingPeriod; onDrill: (category: string) => void; className?: string }) {
  const cats = useCategories(p.ready ? p.dr : undefined);
  const byMonth = useMonthlyByCategory(40);
  const w = useWealth();
  const reduced = usePrefersReducedMotion();
  const partial = !!p.month && p.month === p.latest && p.latestPartial;
  const nMonths = p.monthsSpan;

  const usualBy = useMemo(() => {
    const out = new Map<string, number>();
    const cells = byMonth.data ?? [];
    const months = p.completeMonths;
    if (!months.length) return out;
    const names = new Set(cells.map(c => c.category));
    for (const name of Array.from(names)) {
      const vals = months.map(m => cells.find(c => c.period === m && c.category === name)?.amount ?? 0);
      out.set(name, median(vals));
    }
    return out;
  }, [byMonth.data, p.completeMonths]);

  const rows = useMemo(() => {
    const list = (cats.data ?? []).filter(r => !isInvest(r.category) && r.amount > 0);
    return list.sort((a, b) => b.amount - a.amount);
  }, [cats.data]);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.amount / nMonths, usualBy.get(r.category) ?? 0), 0);
  const usualSpend = w.usual?.spend ?? 0;

  // One-off moments inside this period, e.g. "incl. 📱 ₹99.9k New iPad".
  const oneOffs = useMemo(() => {
    const from = p.dr.date_from ?? "";
    const to = p.dr.date_to ?? "";
    return (w.markers ?? [])
      .filter(m => m.kind === "spend" && m.date >= from && m.date <= to && Math.abs(m.amount) >= Math.max(20000, usualSpend * 0.3))
      .slice(0, 2);
  }, [w.markers, p.dr, usualSpend]);

  const perMonth = total / nMonths;
  const vsUsual = usualSpend > 0 && !partial ? perMonth - usualSpend : null;

  return (
    <StoryCard
      title="Where it went"
      subtitle={p.isRange ? "A month, on average, against a usual month" : partial ? "So far, against a usual whole month" : "Against a usual month"}
      className={className}
      loading={!p.ready || (cats.isLoading && !cats.data)}
      error={cats.error}
      onRetry={() => cats.mutate()}
      empty={!!cats.data && rows.length === 0}
      emptyTitle="No spending in this period"
      emptyHint="Pick another month, or upload the statement that covers it."
      skeleton={<Rows n={6} />}
    >
      <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-2">
        <p className="text-[34px] font-black leading-none tracking-[-0.01em] text-ink tabular-nums md:text-[40px]">
          {inr(Math.round(p.isRange ? perMonth : total))}
          {p.isRange && <span className="ml-1 text-base font-semibold text-muted">a month</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2 pb-1">
          {vsUsual != null && (
            <span className="text-sm font-medium text-muted" title={`A usual month is ${inr(Math.round(usualSpend))}`}>
              {Math.abs(vsUsual) < usualSpend * 0.03
                ? "about a usual month"
                : `${kInr(Math.abs(vsUsual))} ${vsUsual > 0 ? "above" : "below"} usual`}
            </span>
          )}
          {partial && usualSpend > 0 && (
            <span className="text-sm font-medium text-muted">usual month {kInr(usualSpend)}</span>
          )}
          {oneOffs.map(m => (
            <Chip key={`${m.date}-${m.label}`} size="sm" tone="neutral" title={`${m.label}, ${shortDay(m.date)}`}>
              incl. {m.emoji} {kInr(Math.abs(m.amount))} {m.label.replace(/^New /, "")}
            </Chip>
          ))}
        </div>
      </div>

      <ul className="space-y-1" aria-label="Spend by category">
        {rows.map((r, i) => {
          const usual = usualBy.get(r.category) ?? 0;
          const value = r.amount / nMonths;
          const share = total > 0 ? Math.round((r.amount / total) * 100) : 0;
          return (
            <li key={r.category}>
              <button
                type="button"
                onClick={() => onDrill(r.category)}
                className="group -mx-2 block w-[calc(100%+16px)] rounded-m px-2 py-2 text-left transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
                aria-label={`${catLabel(r.category)}: ${inr(r.amount)}, ${share}% of spend. Open details`}
              >
                <div className="flex items-center gap-3">
                  <span aria-hidden className="w-6 shrink-0 text-center text-[18px] leading-none">{catEmoji(r.category)}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{catLabel(r.category)}</span>
                  <span className="shrink-0 text-[15px] font-extrabold tabular-nums text-ink">{kInr(value)}</span>
                  <span className="w-[72px] shrink-0 text-right">
                    {partial || usual <= 0
                      ? <span className="text-sm font-medium tabular-nums text-muted">{usual > 0 ? `of ${kInr(usual)}` : "new"}</span>
                      : <Delta d={value - usual} floor={Math.max(300, usual * 0.1)} />}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-faint transition-colors group-hover:text-muted" strokeWidth={1.75} aria-hidden />
                </div>
                <div className="relative ml-9 mr-[100px] mt-1.5 h-2.5 rounded-[10px] bg-surface-2">
                  <div
                    className={clsx("h-full rounded-[10px]", i === 0 ? "bg-accent-500" : "bg-accent-200", !reduced && "sp-bar-grow")}
                    style={{ width: `${max > 0 ? Math.max(1.5, (value / max) * 100) : 0}%`, animationDelay: `${120 + i * 50}ms` }}
                  />
                  {usual > 0 && (
                    <span
                      aria-hidden
                      title={`Usual month ${inr(Math.round(usual))}`}
                      className="absolute -top-1 h-[18px] w-[2px] rounded-full bg-ink-2"
                      style={{ left: `calc(${Math.min(100, (usual / max) * 100)}% - 1px)` }}
                    />
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 flex items-center gap-2 text-[13px] font-medium text-muted" aria-hidden>
        <span className="inline-block h-3 w-[2px] rounded-full bg-ink-2" /> usual month
      </p>
      <style>{`
        .sp-bar-grow { transform-origin: left; animation: sp-bar .9s var(--spring) both; }
        @keyframes sp-bar { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// What changed against last month: one compact row per category.
// ---------------------------------------------------------------------------

export function ChangesCard({ p, className }: { p: SpendingPeriod; className?: string }) {
  const month = p.isRange ? p.latest : p.month;
  const q = useMonthInsight(month);
  const m = q.data;
  const rows = useMemo(() => {
    const all = (m?.changes ?? []).filter(c => !isInvest(c.category));
    return all.filter(c => Math.abs(c.delta) >= 300).slice(0, 6);
  }, [m]);
  const partial = !!m?.is_partial && !!m.days_elapsed;
  const span = (period?: string | null) => (partial ? `1–${m!.days_elapsed} ${monthShort(period)}` : monthShort(period));
  const steady = (m?.changes ?? []).filter(c => !isInvest(c.category) && Math.abs(c.delta) < 300).length;

  return (
    <StoryCard
      title={p.isRange ? `What changed in ${monthLong(month)}` : "What changed"}
      subtitle={m?.prev_period ? `${span(m.period)} against ${span(m.prev_period)}` : undefined}
      className={className}
      loading={!p.ready || (q.isLoading && !m)}
      error={q.error}
      onRetry={() => q.mutate()}
      empty={!!m && (!m.has_data || !m.prev_period)}
      emptyTitle="Nothing to compare with yet"
      emptyHint="With the month before on file, the categories that moved show up here."
    >
      {rows.length === 0 ? (
        <p className="text-base text-ink-2">Every category within {inr(300)} of last month.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map(c => {
            const up = c.delta > 0;
            const Icon = up ? ArrowUpRight : ArrowDownRight;
            const who = c.top_counterparty ? cleanName(c.top_counterparty) : "";
            return (
              <li
                key={c.category}
                className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                title={`${catLabel(c.category)}: ${inr(c.previous)} → ${inr(c.current)}${who ? `. Mostly ${who}` : ""}`}
              >
                <span aria-hidden className="w-6 shrink-0 text-center text-[18px] leading-none">{catEmoji(c.category)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">{catLabel(c.category)}</span>
                  {who && <span className="block truncate text-[13px] font-medium text-muted">{who}</span>}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-muted">{kInr(c.current)}</span>
                <span
                  className={clsx(
                    "inline-flex w-[92px] shrink-0 items-center justify-end gap-0.5 text-[15px] font-extrabold tabular-nums",
                    up ? "text-ink" : "text-accent-700",
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                  {kInr(Math.abs(c.delta))}
                  <span className="sr-only">{up ? "more" : "less"}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && steady > 0 && (
        <p className="mt-4 text-[13px] font-medium text-muted">{steady} more within {inr(300)}</p>
      )}
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// Biggest one-offs: the largest single spends that don't repeat.
// ---------------------------------------------------------------------------

export function OneOffsCard({
  p, onOpen, className,
}: { p: SpendingPeriod; onOpen: (id: string) => void; className?: string }) {
  const tx = useTransactions(p.ready ? {
    date_from: p.dr.date_from, date_to: p.dr.date_to, type: "debit",
    is_internal: false, is_cc_payment: false, sort_by: "amount", sort_dir: "desc", limit: 40,
  } : null);
  const rec = useRecurring(6);

  const rows = useMemo(() => {
    const repeat = new Set((rec.data?.items ?? []).map(i => i.name.toLowerCase().trim()));
    return (tx.data?.transactions ?? [])
      .filter(t => !isInvest(t.category))
      .filter(t => !repeat.has((t.merchant_name ?? "").toLowerCase().trim()))
      .filter(t => !ROUTINE.has(t.subcategory ?? ""))
      .filter(t => t.amount >= 1000)
      .slice(0, 5);
  }, [tx.data, rec.data]);

  return (
    <StoryCard
      title="Biggest one-offs"
      className={className}
      loading={!p.ready || (tx.isLoading && !tx.data) || (rec.isLoading && !rec.data)}
      error={tx.error}
      onRetry={() => tx.mutate()}
      empty={!!tx.data && rows.length === 0}
      emptyTitle="No one-offs"
      emptyHint="Nothing above ₹1,000 outside your usual payments."
    >
      <ul className="-mx-2">
        {rows.map(t => {
          const emoji = SUB_EMOJI[t.subcategory ?? ""] ?? (t.category ? catEmoji(t.category) : "💸");
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                className="flex w-full items-center gap-3 rounded-m px-2 py-2.5 text-left transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
              >
                <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-[20px]">{emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink" title={t.description}>
                    {oneOffName(t.merchant_name, t.description)}
                  </span>
                  <span className="block truncate text-[13px] font-medium text-muted">
                    {shortDay(t.date)} · {t.subcategory || catLabel(t.category ?? "")}{t.is_emi ? " · on EMI" : ""}
                  </span>
                </span>
                <span className="shrink-0 text-[15px] font-extrabold tabular-nums text-ink">{inr(t.amount)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </StoryCard>
  );
}

// ---------------------------------------------------------------------------
// What repeats: payee, usual amount, next date.
// ---------------------------------------------------------------------------

export function RecurringListCard({
  className, wide = false, firstSeen, newSince,
}: {
  className?: string;
  wide?: boolean;
  /** Merchant key → first date seen; with `newSince`, marks payees that started recently. */
  firstSeen?: Map<string, string>;
  newSince?: string;
}) {
  const q = useRecurring(6);
  const r = q.data;
  const items = useMemo(() => (r?.items ?? []).filter(i => !isInvest(i.category)), [r]);
  const monthly = items.reduce((s, i) => s + i.typical_amount, 0);
  const shown = items.slice(0, wide ? 8 : 6);
  const asOf = r?.as_of ?? "";

  return (
    <StoryCard
      title="What repeats"
      action={items.length > 0 ? (
        <span className="text-right text-sm font-semibold tabular-nums text-muted">
          <span className="text-ink">{kInr(monthly)} a month</span> · {kInr(monthly * 12)} a year
        </span>
      ) : undefined}
      className={className}
      loading={q.isLoading && !r}
      error={q.error}
      onRetry={() => q.mutate()}
      empty={!!r && items.length === 0}
      emptyTitle="Nothing repeats yet"
      emptyHint="With three months of statements, rent, bills and subscriptions show up here."
    >
      <ul className={clsx(wide ? "grid gap-x-10 md:grid-cols-2" : "divide-y divide-line")}>
        {shown.map(it => {
          const due = asOf && it.next_date <= asOf;
          const first = firstSeen?.get(merchantKey({ merchant_name: it.name.replace(/^EMI:\s*/, "") }).key);
          const isNew = !!newSince && !!first && first >= newSince;
          return (
            <li
              key={`${it.name}-${it.usual_day}`}
              className={clsx("flex items-center gap-3 py-2.5", wide ? "border-b border-line" : "first:pt-0 last:pb-0")}
              title={`${catLabel(it.category)}, seen ${it.months_seen} of ${r?.months ?? 6} months · ${inr(Math.round(it.typical_amount * 12))} a year${first ? `, since ${shortDay(first)}` : ""}`}
            >
              <span aria-hidden className="w-6 shrink-0 text-center text-[18px] leading-none">{catEmoji(it.category)}</span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
                {cleanName(it.name.replace(/^EMI:\s*/, "")) || it.name}
                {it.is_emi && <span className="ml-1.5 text-[13px] font-medium text-muted">EMI</span>}
                {isNew && <Chip size="sm" tone="accent" className="ml-1.5 align-[1px]">new</Chip>}
              </span>
              <span className="shrink-0 text-[15px] font-extrabold tabular-nums text-ink">{inr(Math.round(it.typical_amount))}</span>
              <span className="w-[64px] shrink-0 text-right text-[13px] font-medium tabular-nums text-muted">
                {due ? <span className="text-warning-text">due</span> : shortDay(it.next_date)}
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="mt-3 text-[13px] font-medium text-muted">+{items.length - shown.length} smaller</p>
      )}
    </StoryCard>
  );
}

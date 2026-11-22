"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo } from "react";

import { ErrorCard, InsightCard, Skeleton } from "@/components/ui";
import { useAccounts, useTransactions } from "@/lib/api";
import { inr } from "@/lib/format";
import type { DateRange, Transaction, TransactionFilters } from "@/lib/types";

import { errorMessage } from "./cardStates";
import { dayMonth, plural } from "./fmt";

type Kind = "card_bill" | "self_transfer" | "emi";

const REASON: Record<Kind, string> = {
  card_bill: "Card bill, already counted as purchases",
  self_transfer: "Moved between your own accounts",
  emi: "Lump sum, counted as monthly instalments",
};

const PAGE = 500;

function filters(dr: DateRange, extra: TransactionFilters): TransactionFilters {
  return {
    ...extra,
    date_from: dr.date_from,
    date_to: dr.date_to,
    sort_by: "date",
    sort_dir: "desc",
    limit: PAGE,
  };
}

function kindOf(t: Transaction): Kind {
  if (t.is_credit_card_payment) return "card_bill";
  if (t.is_emi) return "emi";
  return "self_transfer";
}

/**
 * The signature moment (design.md §19): what was left out of real spend and
 * why. Fed by GET /transactions with is_cc_payment / is_internal / is_emi and
 * category="Internal Transfer" (the same exclusions the analytics service
 * applies), plus refunds from the snapshot.
 */
export default function LeftOutCard({ dr, refunds }: { dr: DateRange; refunds: number }) {
  const cc = useTransactions(filters(dr, { is_cc_payment: true }));
  const internal = useTransactions(filters(dr, { is_internal: true }));
  const taggedInternal = useTransactions(filters(dr, { category: "Internal Transfer" }));
  const emi = useTransactions(filters(dr, { is_emi: true }));
  const queries = [cc, internal, taggedInternal, emi];
  const { data: accounts } = useAccounts();
  const accountName = (n: string) => accounts?.find(a => a.name === n)?.display_name ?? n;

  const loading = queries.some(q => q.isLoading && !q.data);
  const error = queries.find(q => q.error)?.error;
  const truncated = queries.some(q => (q.data?.total ?? 0) > PAGE);

  const { groups, recent } = useMemo(() => {
    const byId = new Map<string, Transaction>();
    for (const q of queries) for (const t of q.data?.transactions ?? []) byId.set(t.id, t);
    // The money that left an account is what would have been double counted,
    // so totals use the debit legs; the matching credit legs are left out too.
    const debits = [...byId.values()].filter(t => t.type === "debit");
    const g: Record<Kind, { count: number; amount: number }> = {
      card_bill: { count: 0, amount: 0 },
      self_transfer: { count: 0, amount: 0 },
      emi: { count: 0, amount: 0 },
    };
    for (const t of debits) {
      const k = kindOf(t);
      g[k].count += 1;
      g[k].amount += t.amount;
    }
    const sorted = debits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amount - a.amount));
    return { groups: g, recent: sorted.slice(0, 3) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cc.data, internal.data, taggedInternal.data, emi.data]);

  const title = "Never counting the same rupee twice";

  if (error && !loading) {
    return (
      <ErrorCard
        title="The left-out list didn't load"
        message={errorMessage(error, "what was left out of real spend")}
        onRetry={() => queries.forEach(q => q.mutate())}
      />
    );
  }

  if (loading) {
    return (
      <InsightCard title={title}>
        <div aria-busy="true" aria-label="Loading what was left out">
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="rounded-m bg-card p-4">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-3 h-7 w-24" />
              </div>
            ))}
          </div>
          <div className="mt-6 space-y-4">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-5 w-full" />)}
          </div>
        </div>
      </InsightCard>
    );
  }

  const totalLeftOut = groups.card_bill.amount + groups.self_transfer.amount + groups.emi.amount;

  if (totalLeftOut === 0 && refunds <= 0) {
    return (
      <InsightCard title={title}>
        <p className="max-w-[68ch] text-base text-ink-2">
          Nothing in this range needed leaving out. No card bill payments, self-transfers or EMI lump
          sums were found, so every rupee here is counted once.
        </p>
      </InsightCard>
    );
  }

  const allTiles: ({ kind: Kind | "refund"; label: string; amount: number; sub: string } | null)[] = [
    {
      kind: "card_bill",
      label: "Card bill payments",
      amount: groups.card_bill.amount,
      sub: `${plural(groups.card_bill.count, "payment")}, the purchases already count`,
    },
    {
      kind: "self_transfer",
      label: "Self-transfers",
      amount: groups.self_transfer.amount,
      sub: `${plural(groups.self_transfer.count, "move")} between your accounts`,
    },
    groups.emi.count > 0
      ? {
          kind: "emi",
          label: "EMI lump sums",
          amount: groups.emi.amount,
          sub: `${plural(groups.emi.count, "purchase")}, spread into instalments`,
        }
      : null,
    refunds > 0
      ? {
          kind: "refund",
          label: "Refunds",
          amount: refunds,
          sub: "taken off spend, not counted as income",
        }
      : null,
  ];
  // At most three tiles; card bills and self-transfers always show.
  const tiles = allTiles.filter((t): t is NonNullable<typeof t> => t !== null).slice(0, 3);

  return (
    <InsightCard
      title={title}
      action={
        <Link href="/transactions" className="text-link text-[15px]">
          See them in transactions →
        </Link>
      }
    >
      <p className="max-w-[68ch] text-base text-ink-2">
        {totalLeftOut > 0 ? (
          <>
            {inr(totalLeftOut)} moved between your own accounts and cards in this range. None of it is
            in real spend, because the spending behind it is already counted.
          </>
        ) : (
          <>No money moved between your own accounts in this range. Refunds are taken off what you spent.</>
        )}
      </p>

      <div className={clsx("mt-5 grid gap-4", tiles.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {tiles.map(t => (
          <div key={t.kind} className="rounded-m bg-card p-4">
            <p className="text-sm font-semibold text-muted">{t.label}</p>
            <p className="mt-2 text-[24px] font-black leading-none tracking-[-0.01em] tabular-nums text-ink">
              {inr(t.amount)}
            </p>
            <p className="mt-2 text-sm font-medium text-muted">{t.sub}</p>
          </div>
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <p className="mt-6 text-sm font-semibold text-muted">Most recent</p>
          <ul className="mt-1 divide-y divide-accent-100">
            {recent.map(t => {
              const k = kindOf(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent-500" />
                  <span className="min-w-0 flex-1 truncate text-base text-ink" title={t.description}>
                    <span className="tabular-nums">{dayMonth(t.date)}</span>
                    <span className="text-muted"> · </span>
                    {t.merchant_name || t.description}
                    <span className="text-muted"> · {accountName(t.account_name)}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-3 pl-6 sm:pl-0">
                    <span className="text-base font-extrabold tabular-nums text-ink">{inr(t.amount)}</span>
                    <span className="rounded-pill bg-card px-3 py-1 text-sm font-medium text-ink-2">
                      {REASON[k]}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {truncated && (
        <p className="mt-3 text-sm font-medium text-muted">
          Totals use the first {PAGE.toLocaleString("en-IN")} of each kind. Pick a shorter range for exact figures.
        </p>
      )}
    </InsightCard>
  );
}

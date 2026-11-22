"use client";

// Spending: where did it go this period, what changed, what was one-off,
// what repeats, then the ledger. The period is the shared date range, so
// Home and Spending always show the same month.

import clsx from "clsx";
import { ArrowRight, CreditCard, Repeat, Search, SlidersHorizontal, SplitSquareHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import ExpenseDrilldownDialog from "@/components/analytics/ExpenseDrilldownDialog";
import { BulkTagView } from "@/components/categorize/BulkTagView";
import EMIDialog from "@/components/EMIDialog";
import { TransactionDetailDrawer } from "@/components/TransactionDetailDrawer";
import { plural } from "@/components/ledger/format";
import { FieldLabel, useJkFocus } from "@/components/ledger/primitives";
import { CategoryBarsCard, ChangesCard, OneOffsCard, RecurringListCard } from "@/components/ledger/spending/cards";
import {
  HowYouPayCard, KindMixCard, MerchantsCard, PaceCard, SmallPaysCard, WhenCard,
} from "@/components/ledger/spending/insights";
import { useSpendModel } from "@/components/ledger/spending/model";
import { useSpendingPeriod } from "@/components/ledger/spending/period";
import { TxnList, TxnListSkeleton } from "@/components/ledger/TxnList";
import {
  Button, Card, EmptyState, ErrorCard, FilterPill, Input, Segmented, Select, Skeleton,
} from "@/components/ui";
import { useAccounts, useProgress, useTaxonomy, useTransactions } from "@/lib/api";
import type {
  AccountType, Transaction, TransactionFilters, TransactionSortKey, TxnType,
} from "@/lib/types";

const PAGE_SIZE = 100;

type View = "all" | "untagged";
type Hidden = "none" | "cc" | "tr";

/** Ledger filters the user sets; dates come from the period. */
type LedgerFilters = Omit<TransactionFilters, "date_from" | "date_to" | "is_internal" | "is_cc_payment">;

const DEFAULT_FILTERS: LedgerFilters = {
  limit: PAGE_SIZE,
  offset: 0,
  sort_by: "date",
  sort_dir: "desc",
};

const SORT_OPTIONS: { value: TransactionSortKey; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "amount", label: "Amount" },
  { value: "description", label: "Description" },
  { value: "account", label: "Account" },
  { value: "category", label: "Category" },
];

export default function SpendingPage() {
  const p = useSpendingPeriod();
  const model = useSpendModel(p);
  const [view, setView] = useState<View>("all");
  const [hidden, setHidden] = useState<Hidden>("none");
  const [filters, setFilters] = useState<LedgerFilters>(DEFAULT_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  const [emiTxn, setEmiTxn] = useState<Transaction | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);
  useJkFocus(tableRef, "[data-ledger-row]", !detailId && !emiTxn && view === "all");

  const sortBy = filters.sort_by ?? "date";
  const sortDir = filters.sort_dir ?? "desc";
  const period = p.ready ? p.dr : null;

  // The ledger query: the period, minus card bills and transfers unless asked.
  const query: TransactionFilters | null = period ? {
    ...filters,
    ...period,
    is_internal: hidden === "tr",
    is_cc_payment: hidden === "cc",
  } : null;
  const { data, error, mutate, isLoading } = useTransactions(query);

  // Counts for the period line and the hidden chip (limit 1: totals only).
  const countBase = period ? { ...period, limit: 1 } : null;
  const spends = useTransactions(countBase && { ...countBase, type: "debit", is_internal: false, is_cc_payment: false });
  const ins = useTransactions(countBase && { ...countBase, type: "credit", is_internal: false, is_cc_payment: false });
  const ccQ = useTransactions(countBase && { ...countBase, is_cc_payment: true });
  const trQ = useTransactions(countBase && { ...countBase, is_internal: true, is_cc_payment: false });
  const { data: progress } = useProgress();

  const { data: accts } = useAccounts();
  const { data: taxonomy } = useTaxonomy();

  useEffect(() => {
    const id = setTimeout(() => {
      setFilters(prev => ((prev.search || "") === searchText.trim()
        ? prev
        : { ...prev, search: searchText.trim() || undefined, offset: 0 }));
    }, 250);
    return () => clearTimeout(id);
  }, [searchText]);

  // Deep link: /transactions?view=untagged opens the bulk-tag view.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("view") === "untagged") setView("untagged");
    } catch { /* no URL access: stay on All */ }
  }, []);

  // A new period starts the ledger from the top.
  useEffect(() => { setFilters(f => (f.offset ? { ...f, offset: 0 } : f)); }, [p.key]);

  const categoryOptions = useMemo(() => {
    if (!taxonomy) return [];
    const names = new Set<string>();
    [...taxonomy.expense, ...taxonomy.income].forEach(n => { if (!n.archived) names.add(n.name); });
    return Array.from(names).sort();
  }, [taxonomy]);

  const subcategoryOptions = useMemo(() => {
    if (!taxonomy || !filters.category || filters.category === "Uncategorized") return [];
    const node = [...taxonomy.expense, ...taxonomy.income].find(r => r.name === filters.category);
    return node?.children.filter(c => !c.archived).map(c => c.name).sort() ?? [];
  }, [taxonomy, filters.category]);

  function setFilter<K extends keyof LedgerFilters>(k: K, v: LedgerFilters[K]) {
    setFilters(prev => ({ ...prev, [k]: v, offset: 0 }));
  }

  const moreCount = [
    filters.is_emi, filters.account_name, filters.account_type, filters.category, filters.subcategory, filters.type,
  ].filter(Boolean).length;
  const anyFilter = moreCount > 0 || !!filters.search || hidden !== "none";

  function clearFilters() {
    setSearchText("");
    setHidden("none");
    setFilters(DEFAULT_FILTERS);
  }

  const untagged = progress?.uncategorized_transactions ?? 0;
  const offset = filters.offset || 0;
  const rows = data?.transactions ?? [];
  const nCc = ccQ.data?.total ?? 0;
  const nTr = trQ.data?.total ?? 0;
  const nSpend = spends.data?.total;
  const nIn = ins.data?.total;

  function openUntagged() {
    setView("untagged");
    requestAnimationFrame(() => ledgerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className="space-y-8 md:space-y-10">
      {/* Title and the period: the same months as Home. */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">Spending</h1>
        {p.options.length > 1 && p.key ? (
          <Segmented<string>
            className="self-start md:self-auto max-sm:[&>button]:px-3 max-sm:[&>button]:text-[13px]"
            ariaLabel="Period"
            value={p.key}
            onChange={p.pick}
            options={p.options}
          />
        ) : !p.ready ? <Skeleton className="h-11 w-80 !rounded-pill" /> : null}
      </header>

      {/* Where it went, and how the month is pacing. */}
      <div className="dashboard-grid">
        <CategoryBarsCard p={p} onDrill={setDrill} className="min-[900px]:col-span-7" />
        <div className="flex flex-col gap-4 min-[900px]:col-span-5">
          {!p.isRange && <PaceCard p={p} q={model} className="!h-auto" />}
          <OneOffsCard p={p} onOpen={setDetailId} className="!h-auto flex-1" />
        </div>
      </div>

      {/* What's changing. */}
      <div className="dashboard-grid">
        <KindMixCard p={p} q={model} className="min-[900px]:col-span-7" />
        <ChangesCard p={p} className="min-[900px]:col-span-5" />
      </div>

      {/* Habits: where, specifically; when; how; the small stuff. */}
      <div className="dashboard-grid">
        <MerchantsCard p={p} q={model} className="min-[900px]:col-span-7" />
        <div className="flex flex-col gap-4 min-[900px]:col-span-5">
          <HowYouPayCard p={p} q={model} className="!h-auto" />
          <SmallPaysCard p={p} q={model} className="!h-auto flex-1" />
        </div>
      </div>
      <div className="dashboard-grid">
        <WhenCard p={p} q={model} className="min-[900px]:col-span-5" />
        <RecurringListCard
          className="min-[900px]:col-span-7"
          firstSeen={model.model?.firstSeen}
          newSince={model.model && model.model.months.length >= 4 ? `${model.model.months[model.model.months.length - 3]}-01` : undefined}
        />
      </div>

      {/* The ledger */}
      <section ref={ledgerRef} aria-labelledby="ledger-h" className="scroll-mt-24 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 id="ledger-h" className="text-h3 font-black text-ink">
              {view === "untagged" ? "Untagged" : "Transactions"}
            </h2>
            <p className="mt-1 text-sm font-medium tabular-nums text-muted">
              {view === "untagged"
                ? `${plural(untagged, "transaction")} across all statements`
                : nSpend == null
                  ? " "
                  : `${p.short} · ${plural(nSpend, "spend")}${nIn ? `, ${nIn} money in` : ""}`}
            </p>
          </div>
          <Segmented<View>
            ariaLabel="Which transactions"
            value={view}
            onChange={v => setView(v)}
            options={[
              { value: "all", label: "All" },
              {
                value: "untagged",
                label: <span>Untagged <span className="tabular-nums text-muted">({untagged.toLocaleString("en-IN")})</span></span>,
              },
            ]}
          />
        </div>

        {view === "untagged" ? (
          <BulkTagView />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 basis-full sm:basis-0 sm:flex-1">
                <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
                <Input
                  type="search"
                  aria-label="Search transactions"
                  className="pl-12"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder="Search a merchant or VPA"
                />
              </div>
              <Button variant="ghost" size="sm" aria-expanded={moreOpen} onClick={() => setMoreOpen(o => !o)}>
                <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
                {moreCount ? `Filters · ${moreCount}` : "Filters"}
              </Button>
              {(nCc > 0 || nTr > 0) && (
                <HiddenChip cc={nCc} tr={nTr} value={hidden} onChange={h => { setHidden(h); setFilters(f => ({ ...f, offset: 0 })); }} />
              )}
              {anyFilter && (
                <button type="button" className="text-link text-sm" onClick={clearFilters}>Clear</button>
              )}
            </div>

            {moreOpen && (
              <Card className="rise-in">
                <div className="mb-5 flex flex-wrap items-center gap-2">
                  <FilterPill
                    label="EMIs only"
                    icon={<SplitSquareHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />}
                    active={filters.is_emi === true}
                    onClick={() => setFilter("is_emi", filters.is_emi ? undefined : true)}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <FieldLabel htmlFor="f-account">Account</FieldLabel>
                    <Select id="f-account" value={filters.account_name || ""} onChange={e => setFilter("account_name", e.target.value || undefined)}>
                      <option value="">All accounts</option>
                      {accts?.map(a => <option key={a.id} value={a.name}>{a.display_name}</option>)}
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="f-acct-type">Account type</FieldLabel>
                    <Select
                      id="f-acct-type"
                      value={filters.account_type || ""}
                      onChange={e => setFilter("account_type", (e.target.value || undefined) as AccountType | undefined)}
                    >
                      <option value="">Savings and cards</option>
                      <option value="savings">Savings</option>
                      <option value="credit_card">Credit card</option>
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="f-type">Money in or out</FieldLabel>
                    <Select
                      id="f-type"
                      value={filters.type || ""}
                      onChange={e => setFilter("type", (e.target.value || undefined) as TxnType | undefined)}
                    >
                      <option value="">Both</option>
                      <option value="debit">Money out</option>
                      <option value="credit">Money in</option>
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="f-cat">Category</FieldLabel>
                    <Select
                      id="f-cat"
                      value={filters.category || ""}
                      onChange={e => {
                        const v = e.target.value || undefined;
                        setFilters(prev => ({ ...prev, category: v, subcategory: undefined, offset: 0 }));
                      }}
                    >
                      <option value="">All categories</option>
                      <option value="Uncategorized">No category</option>
                      {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="f-sub">Subcategory</FieldLabel>
                    <Select
                      id="f-sub"
                      value={filters.subcategory || ""}
                      disabled={!filters.category || filters.category === "Uncategorized"}
                      onChange={e => setFilter("subcategory", e.target.value || undefined)}
                    >
                      <option value="">All subcategories</option>
                      {subcategoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                  <div>
                    <FieldLabel htmlFor="f-sort">Sort by</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Select
                        id="f-sort"
                        className="min-w-0 flex-1"
                        value={sortBy}
                        onChange={e => setFilter("sort_by", e.target.value as TransactionSortKey)}
                      >
                        {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                      <Segmented
                        size="sm"
                        ariaLabel="Sort order"
                        value={sortDir}
                        onChange={v => setFilter("sort_dir", v)}
                        options={[
                          { value: "desc" as const, label: sortBy === "date" ? "Newest" : sortBy === "amount" ? "Largest" : "Z–A" },
                          { value: "asc" as const, label: sortBy === "date" ? "Oldest" : sortBy === "amount" ? "Smallest" : "A–Z" },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              </Card>
            )}

            <Card padded={false} className="overflow-hidden">
              {error && !data ? (
                <div className="p-5">
                  <ErrorCard
                    message="Your transactions didn't load. Check that the backend is running, then try again."
                    onRetry={() => mutate()}
                  />
                </div>
              ) : (isLoading && !data) || !query ? (
                <TxnListSkeleton rows={10} />
              ) : rows.length === 0 ? (
                anyFilter ? (
                  <EmptyState
                    illustration="receipt"
                    title="Nothing matches these filters"
                    hint={`Nothing in ${p.short} matches. Try a shorter search, fewer filters, or another month.`}
                    action={<Button variant="ghost" onClick={clearFilters}>Clear filters</Button>}
                  />
                ) : (
                  <EmptyState
                    illustration="stack of statements"
                    title={`No transactions in ${p.short}`}
                    hint="Pick another month, or upload the statement that covers this one."
                    action={<Link href="/upload" className="btn primary">Upload statements <ArrowRight className="h-4 w-4" strokeWidth={1.75} /></Link>}
                  />
                )
              ) : (
                <div ref={tableRef} className={clsx(isLoading && "opacity-60 transition-opacity")}>
                  <TxnList
                    label="Transactions"
                    rows={rows}
                    groupByDate={sortBy === "date"}
                    selectedId={detailId}
                    onOpen={t => setDetailId(t.id)}
                  />
                </div>
              )}

              {data && rows.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                  <p className="text-sm font-medium tabular-nums text-muted">
                    {data.total > PAGE_SIZE
                      ? `${(offset + 1).toLocaleString("en-IN")}–${(offset + rows.length).toLocaleString("en-IN")} of ${data.total.toLocaleString("en-IN")}`
                      : `All ${data.total.toLocaleString("en-IN")}`}
                    {` in ${p.short}`}
                  </p>
                  {data.total > PAGE_SIZE && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={offset === 0}
                        onClick={() => setFilters(f => ({ ...f, offset: Math.max(0, (f.offset || 0) - PAGE_SIZE) }))}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={offset + rows.length >= data.total}
                        onClick={() => setFilters(f => ({ ...f, offset: (f.offset || 0) + PAGE_SIZE }))}
                      >
                        Next
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
            {untagged > 0 && rows.some(t => !t.category && !t.is_internal_transfer && !t.is_credit_card_payment) && (
              <p className="text-sm text-muted">
                Some rows need a tag.{" "}
                <button type="button" className="text-link" onClick={openUntagged}>Tag them in bulk</button>
              </p>
            )}
          </>
        )}
      </section>

      <ExpenseDrilldownDialog
        open={drill !== null}
        onClose={() => setDrill(null)}
        category={drill}
        dr={p.dr}
        rangeLabel={p.label}
      />

      <EMIDialog txn={emiTxn} open={!!emiTxn} onClose={() => setEmiTxn(null)} />

      <TransactionDetailDrawer
        txnId={detailId}
        onClose={() => setDetailId(null)}
        onConvertEmi={t => setEmiTxn(t)}
      />
    </div>
  );
}

/** "🔁 hidden: 2 card bills · 6 transfers", each half a toggle that shows just those rows. */
function HiddenChip({ cc, tr, value, onChange }: { cc: number; tr: number; value: Hidden; onChange: (h: Hidden) => void }) {
  const part = (k: Exclude<Hidden, "none">, n: number, one: string, Icon: typeof CreditCard) => {
    if (n <= 0) return null;
    const on = value === k;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onChange(on ? "none" : k)}
        title={k === "cc" ? "Card bills: the purchases are already counted" : "Money moving between your own accounts"}
        className={clsx(
          "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 tabular-nums transition-colors",
          on ? "bg-ink text-card" : "hover:bg-surface-2 hover:text-ink",
        )}
      >
        {on ? <X className="h-3.5 w-3.5" strokeWidth={2} /> : <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />}
        {plural(n, one)}
      </button>
    );
  };
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-pill bg-surface py-1 pl-3 pr-1 text-[13px] font-medium text-ink-2">
      <span aria-hidden>🔁</span>
      <span className="mr-0.5 text-muted">hidden:</span>
      {part("cc", cc, "card bill", CreditCard)}
      {cc > 0 && tr > 0 && <span aria-hidden className="text-faint">·</span>}
      {part("tr", tr, "transfer", Repeat)}
    </div>
  );
}

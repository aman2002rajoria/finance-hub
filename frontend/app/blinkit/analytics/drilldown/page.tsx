"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import GlobalDateFilter from "@/components/analytics/GlobalDateFilter";
import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { inr } from "@/components/blinkit/blinkit-charts";
import { buildDrilldownHref, paramsToDrillSelection, type BlinkitDrillSelection } from "@/components/blinkit/drilldown";
import { dayLabel, monthName, plural } from "@/components/blinkit/format";
import { money, shortStore } from "@/components/blinkit/pieces";
import {
  Button, Card, CardSkeleton, CardTitle, DataTable, EmptyState, ErrorCard, Input,
  Segmented, Skeleton, TableCell, TableHead, TableHeadCell, TableRow,
} from "@/components/ui";
import {
  blinkitDrilldownExportUrl, useBlinkitDrilldown, useBlinkitDrilldownSummary,
  useBlinkitProductsInCategory,
} from "@/lib/api";
import type { BlinkitDrilldownOrderRow, BlinkitDrilldownProductRow } from "@/lib/types";

const PAGE_SIZE = 50;
type Tab = "orders" | "products";

const DAYS: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};

/** A heading a person would write: "Oct 2026", "Orders on a Wednesday", "Orders with fees". */
function drillTitle(sel: BlinkitDrillSelection): string {
  const v = sel.value;
  switch (sel.dimension) {
    case "month": return v && /^\d{4}-\d{2}$/.test(v) ? monthName(v) : v ?? "One month";
    case "weekday": return v ? `Orders on a ${DAYS[v] ?? v}` : "Orders by day";
    case "store": return v ? shortStore(v) : "Stores";
    case "has_delivery": case "has_handling": case "has_convenience": return "Orders with fees";
    case "has_discount": return "Orders with a discount";
    case "has_tax": return "Orders with tax";
    case "all": return "Every order";
    default: return v ?? sel.source ?? "Every order";
  }
}

function BackLink() {
  return (
    <Link href="/blinkit/analytics" className="btn ghost xs">
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      Groceries
    </Link>
  );
}

function DrilldownContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { dr } = useDateRange();
  const selection = useMemo(() => paramsToDrillSelection(searchParams), [searchParams]);

  const [tab, setTab] = useState<Tab>("orders");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState("invoice_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (!selection) return;
    const t = searchParams.get("tab");
    setTab(t === "products" ? "products" : "orders");
    setPage(Math.max(0, Number(searchParams.get("page") ?? 0) || 0));
    setQ(searchParams.get("q") ?? "");
    setSearch(searchParams.get("q") ?? "");
    setSortBy(searchParams.get("sort_by") ?? "invoice_date");
    setSortDir(searchParams.get("sort_dir") === "asc" ? "asc" : "desc");
  }, [selection, searchParams]);

  const drillParams = useMemo(() => {
    if (!selection) return null;
    return {
      dimension: selection.dimension, value: selection.value, tab,
      charge_type: selection.charge_type, discounted_only: selection.discounted_only,
      tax_only: selection.tax_only, category_filter: selection.category_filter,
      q: q || undefined, sort_by: sortBy, sort_dir: sortDir,
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    };
  }, [selection, tab, q, sortBy, sortDir, page]);

  const summaryParams = useMemo(() => {
    if (!selection) return null;
    return {
      dimension: selection.dimension, value: selection.value,
      charge_type: selection.charge_type, discounted_only: selection.discounted_only,
      tax_only: selection.tax_only, category_filter: selection.category_filter,
    };
  }, [selection]);

  const { data, error, isLoading, mutate } = useBlinkitDrilldown(dr, drillParams);
  const { data: summary } = useBlinkitDrilldownSummary(dr, summaryParams);
  const categoryValue = selection?.dimension === "category" ? selection.value ?? null : null;
  const { data: topProducts } = useBlinkitProductsInCategory(dr, categoryValue);

  const syncUrl = useCallback((patch: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") sp.delete(k);
      else sp.set(k, String(v));
    }
    router.replace(`/blinkit/analytics/drilldown?${sp.toString()}`);
  }, [searchParams, router]);

  if (!selection) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Card>
          <EmptyState
            illustration="receipt"
            title="Nothing picked to look into"
            hint="Open this page by clicking a chart or a number on the overview."
            action={<Link href="/blinkit/analytics" className="btn ghost sm">Back to overview</Link>}
          />
        </Card>
      </div>
    );
  }

  const rows = tab === "orders" ? (data?.orders ?? []) : (data?.products ?? []);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const exportUrl = drillParams ? blinkitDrilldownExportUrl(dr, { ...drillParams, tab }) : "#";
  const title = drillTitle(selection);
  const products = (topProducts ?? []).slice(0, 5);
  const runSearch = () => { setQ(search); syncUrl({ q: search, page: 0 }); };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <BackLink />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1 basis-[360px]">
          <h2 className="text-[24px] font-black leading-[1.15] text-ink md:text-h2">{title}</h2>
          <p className="mt-2 text-base text-ink-2">
            {summary
              ? `${inr(summary.total_spend ?? 0)} across ${plural(summary.total_orders ?? 0, "order")}${summary.total_orders ? `, about ${inr(summary.avg_order_value ?? 0)} each` : ""}.`
              : data?.label ?? "\u00a0"}
          </p>
        </div>
        <GlobalDateFilter />
      </div>

      {categoryValue && products.length > 0 && (
        <Card>
          <CardTitle subtitle="What you spent most on in this category">Top products</CardTitle>
          <ul className="mt-3">
            {products.map(p => (
              <li key={p.product_name} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  className="-mx-3 flex w-[calc(100%+24px)] items-center gap-4 rounded-s px-3 py-3 text-left transition-colors hover:bg-surface"
                  onClick={() => router.push(buildDrilldownHref({ dimension: "product", value: p.product_name, source: categoryValue }))}
                >
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{p.product_name}</span>
                  <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{inr(p.total_spend)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-6 pb-4 pt-6">
          <Segmented<Tab>
            size="sm"
            ariaLabel="Show orders or products"
            options={[{ value: "orders", label: "Orders" }, { value: "products", label: "Products" }]}
            value={tab}
            onChange={(t) => { setTab(t); syncUrl({ tab: t, page: 0 }); }}
          />
          <form className="order-last flex w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search these records" aria-label="Search these records" className="pl-11" />
            </div>
            <Button type="submit" variant="ghost" size="sm">Search</Button>
          </form>
          <a href={exportUrl} download className="btn ghost xs ml-auto">Download CSV ↓</a>
        </div>

        {error && !data ? (
          <div className="px-6 pb-6">
            <ErrorCard message="These records didn't load. Check that the backend is running, then try again." onRetry={() => mutate()} />
          </div>
        ) : isLoading && !data ? (
          <div className="space-y-2 px-6 pb-6">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-11 w-full" />)}</div>
        ) : !rows.length ? (
          <EmptyState compact title="No records here" hint={q ? `Nothing matches "${q}".` : "Try a wider date range."} />
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <DataTable>
              <TableHead>
                {tab === "orders" ? (
                  <tr>
                    <TableHeadCell className="pl-6">Date</TableHeadCell>
                    <TableHeadCell>Store</TableHeadCell>
                    <TableHeadCell className="hidden md:table-cell">Categories</TableHeadCell>
                    <TableHeadCell align="right" className="pr-6">Total</TableHeadCell>
                  </tr>
                ) : (
                  <tr>
                    <TableHeadCell className="pl-6">Product</TableHeadCell>
                    <TableHeadCell className="hidden md:table-cell">Category</TableHeadCell>
                    <TableHeadCell>Date</TableHeadCell>
                    <TableHeadCell align="right" className="pr-6">Total</TableHeadCell>
                  </tr>
                )}
              </TableHead>
              <tbody>
                {tab === "orders"
                  ? (rows as BlinkitDrilldownOrderRow[]).map(r => (
                    <TableRow key={r.id} onClick={() => router.push(`/blinkit/orders/${r.id}`)}>
                      <TableCell className="whitespace-nowrap pl-6">{dayLabel(r.invoice_date)}</TableCell>
                      <TableCell className="max-w-[180px] truncate">{shortStore(r.store_name) || "—"}</TableCell>
                      <TableCell className="hidden max-w-[240px] truncate text-ink-2 md:table-cell">{r.category_summary ?? "—"}</TableCell>
                      <TableCell align="right" className="pr-6 font-semibold">{money(r.grand_total)}</TableCell>
                    </TableRow>
                  ))
                  : (rows as BlinkitDrilldownProductRow[]).map(r => (
                    <TableRow key={r.id} onClick={() => router.push(`/blinkit/orders/${r.order_row_id}`)}>
                      <TableCell className="max-w-[260px] truncate pl-6" title={r.product_name}>{r.product_name}</TableCell>
                      <TableCell className="hidden text-ink-2 md:table-cell">{[r.category, r.subcategory].filter(Boolean).join(" · ") || "Uncategorised"}</TableCell>
                      <TableCell className="whitespace-nowrap">{dayLabel(r.invoice_date)}</TableCell>
                      <TableCell align="right" className="pr-6 font-semibold">{money(r.total_amount)}</TableCell>
                    </TableRow>
                  ))}
              </tbody>
            </DataTable>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-4">
            <p className="text-sm text-muted">Page {page + 1} of {totalPages}</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => syncUrl({ page: page - 1 })}>
                <ChevronLeft className="h-4 w-4" strokeWidth={1.75} /> Previous
              </Button>
              <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => syncUrl({ page: page + 1 })}>
                Next <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function DrilldownPage() {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-8 w-64" /><CardSkeleton height={420} /></div>}>
      <DrilldownContent />
    </Suspense>
  );
}

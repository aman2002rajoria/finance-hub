"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import GlobalDateFilter from "@/components/analytics/GlobalDateFilter";
import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { dayLabel, plural } from "@/components/blinkit/format";
import ExploreCharts from "@/components/blinkit/ExploreCharts";
import {
  Button, Card, DataTable, EmptyState, ErrorCard, Input, Segmented, Skeleton, TableCell,
  TableHead, TableHeadCell, TableRow,
} from "@/components/ui";
import { blinkitExplorerExportUrl, useBlinkitExplorer } from "@/lib/api";
import { inr2 } from "@/lib/format";

const PAGE_SIZE = 50;

export default function BlinkitExplorerPage() {
  const router = useRouter();
  const { dr } = useDateRange();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [sortBy, setSortBy] = useState("invoice_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [view, setView] = useState<"charts" | "orders">("charts");

  const { data, error, isLoading, mutate } = useBlinkitExplorer(dr, view === "orders" ? {
    q: q || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  } : { limit: 1, offset: 0 });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("desc"); }
    setPage(0);
  };

  const runSearch = () => { setQ(search.trim()); setPage(0); };

  const SortTh = ({ col, label, align = "left", className }: { col: string; label: string; align?: "left" | "right"; className?: string }) => {
    const active = sortBy === col;
    const Arrow = sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHeadCell align={align} onClick={() => toggleSort(col)} className={className}>
        <span className={`inline-flex items-center gap-1 ${active ? "text-ink" : ""}`} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
          {label}
          {active && <Arrow className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </span>
      </TableHeadCell>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Segmented
          ariaLabel="Explore view"
          options={[{ value: "charts", label: "Charts" }, { value: "orders", label: "Every order" }]}
          value={view}
          onChange={setView}
        />
        <GlobalDateFilter />
      </div>

      {view === "charts" ? <ExploreCharts /> : (
      <>

      <div className="flex flex-wrap items-center justify-between gap-3">
      <form
        className="flex w-full max-w-xl items-start gap-3"
        onSubmit={(e) => { e.preventDefault(); runSearch(); }}
        role="search"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Order ID, seller, address or pincode"
            aria-label="Search orders"
            className="pl-11"
          />
        </div>
        <Button type="submit" variant="secondary" size="lg" className="!py-[14px]">Search</Button>
      </form>
        <a href={blinkitExplorerExportUrl(dr, q || undefined)} download className="btn ghost sm">
          Download CSV ↓
        </a>
      </div>

      <Card padded={false} className="overflow-hidden">
        {error && !data ? (
          <div className="p-6">
            <ErrorCard message="The orders didn't load. Check that the backend is running, then try again." onRetry={() => mutate()} />
          </div>
        ) : isLoading && !data ? (
          <div className="space-y-2 p-6" aria-busy="true" aria-label="Loading orders">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : !rows.length ? (
          <EmptyState
            illustration="receipt"
            title={q ? "No orders match that search" : "No orders in this range"}
            hint={q ? `Nothing found for "${q}". Try a seller, a pincode or part of an order ID.` : "Pick a wider date range, or add invoices on the Orders tab."}
            action={q ? <Button variant="ghost" size="md" onClick={() => { setSearch(""); setQ(""); setPage(0); }}>Clear search</Button> : undefined}
          />
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <DataTable className="min-w-[1100px]" compact>
              <TableHead>
                <tr>
                  <SortTh col="invoice_date" label="Date" className="pl-6" />
                  <SortTh col="order_id" label="Order ID" />
                  <SortTh col="store_name" label="Store" />
                  <SortTh col="seller_name" label="Seller" />
                  <TableHeadCell>Address</TableHeadCell>
                  <SortTh col="delivery_state" label="State" />
                  <SortTh col="delivery_pincode" label="Pincode" />
                  <SortTh col="grand_total" label="Total" align="right" />
                  <SortTh col="discount_total" label="Discount" align="right" />
                  <SortTh col="delivery_fee" label="Delivery" align="right" />
                  <SortTh col="handling_charge" label="Handling" align="right" />
                  <SortTh col="tax_total" label="Tax" align="right" />
                  <SortTh col="invoice_number" label="Invoice" className="pr-6" />
                </tr>
              </TableHead>
              <tbody>
                {rows.map(r => (
                  <TableRow key={r.id} onClick={() => router.push(`/blinkit/orders/${r.id}`)}>
                    <TableCell compact className="whitespace-nowrap pl-6">{dayLabel(r.invoice_date)}</TableCell>
                    <TableCell compact className="font-mono text-[12px] text-ink-2">{r.order_id ?? "—"}</TableCell>
                    <TableCell compact className="max-w-[150px] truncate" title={r.store_name ?? ""}>{r.store_name ?? "—"}</TableCell>
                    <TableCell compact className="max-w-[150px] truncate text-ink-2" title={r.seller_name ?? ""}>{r.seller_name ?? "—"}</TableCell>
                    <TableCell compact className="max-w-[200px] truncate text-ink-2" title={r.delivery_address ?? ""}>{r.delivery_address ?? "—"}</TableCell>
                    <TableCell compact className="text-ink-2">{r.delivery_state ?? "—"}</TableCell>
                    <TableCell compact className="text-ink-2">{r.delivery_pincode ?? "—"}</TableCell>
                    <TableCell compact align="right" className="font-semibold">{inr2(r.grand_total)}</TableCell>
                    <TableCell compact align="right" className="text-ink-2">{r.discount_total ? inr2(r.discount_total) : "—"}</TableCell>
                    <TableCell compact align="right" className="text-ink-2">{r.delivery_fee ? inr2(r.delivery_fee) : "—"}</TableCell>
                    <TableCell compact align="right" className="text-ink-2">{r.handling_charge ? inr2(r.handling_charge) : "—"}</TableCell>
                    <TableCell compact align="right" className="text-ink-2">{inr2(r.tax_total)}</TableCell>
                    <TableCell compact className="pr-6 font-mono text-[12px] text-muted">{r.invoice_number}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-4">
            <p className="text-sm text-muted">
              {totalPages > 1 ? `Page ${page + 1} of ${totalPages} · ` : ""}{plural(total, "order")}
            </p>
            {totalPages > 1 && (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.75} /> Previous
                </Button>
                <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                  Next <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
      </>
      )}
    </div>
  );
}

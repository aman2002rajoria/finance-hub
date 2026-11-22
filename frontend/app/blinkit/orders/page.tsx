"use client";

/*
 * Groceries > Orders. One job: see every order and bring new invoices in.
 * One sentence of context, the actions, then orders grouped by month with
 * a month total. Totals and charts live on the Overview.
 */

import { Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dayLabel, monthName, plural } from "@/components/blinkit/format";
import { money, shortProduct, shortStore } from "@/components/blinkit/pieces";
import {
  AiWorking, AlertBanner, Button, Card, Chip, EmptyState, ErrorCard, IconButton, Input, Modal, Skeleton,
} from "@/components/ui";
import {
  blinkitReprocessAll, blinkitScan, blinkitUpload,
  useBlinkitErrors, useBlinkitItems, useBlinkitOrders, useBlinkitSpendingOverTime, useBlinkitStats,
} from "@/lib/api";
import { useDataMode } from "@/lib/dataMode";
import type { BlinkitIngestResult, BlinkitOrder } from "@/lib/types";

const PAGE = 100;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Busy = null | "scan" | "upload" | "reprocess";

const BUSY_WORDS: Record<Exclude<Busy, null>, string> = {
  scan: "Looking for new invoices in your folder and reading them…",
  upload: "Reading your invoices…",
  reprocess: "Reading every invoice again from scratch…",
};

const EMPTY_RESULT: BlinkitIngestResult = {
  files_processed: 0, orders_new: 0, orders_skipped: 0, items_new: 0, errors: [], warnings: [],
};

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Hide the home folder in paths shown on screen. */
function displayPath(p: string): string {
  return p.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function weekday(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
}

/** "Shimla Apple, Amul Taaza Milk and 4 more" */
function basketLine(names: string[]): string {
  if (!names.length) return "";
  const shown = names.slice(0, 2).map(shortProduct);
  const more = names.length - shown.length;
  if (more <= 0) return shown.join(" and ");
  return `${shown.join(", ")} and ${more} more`;
}

function ListSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading orders">
      {[0, 1].map(g => (
        <div key={g} className="rounded-l bg-card p-6 shadow-flat">
          <Skeleton className="h-6 w-40" />
          <div className="mt-5 space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
        </div>
      ))}
    </div>
  );
}

export default function GroceriesOrdersPage() {
  const mode = useDataMode();
  const [busy, setBusy] = useState<Busy>(null);
  const [lastResult, setLastResult] = useState<BlinkitIngestResult | null>(null);
  const [requestError, setRequestError] = useState<{ what: Exclude<Busy, null>; message: string } | null>(null);
  const [confirmReprocess, setConfirmReprocess] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [pages, setPages] = useState(1);
  const fileRef = useRef<HTMLInputElement>(null);

  const search = useDebounced(searchInput.trim(), 300);
  useEffect(() => setPages(1), [search]);

  const { data: stats, error: statsError, mutate: refetchStats } = useBlinkitStats();
  const { data: orderData, error: ordersError, mutate: refetchOrders, isLoading: ordersLoading } = useBlinkitOrders({
    q: search || undefined,
    limit: PAGE * pages,
    offset: 0,
  });
  const { data: items, mutate: refetchItems } = useBlinkitItems(2000);
  const { data: months } = useBlinkitSpendingOverTime(undefined, "month");
  const { data: errors, mutate: refetchErrors } = useBlinkitErrors();

  const orders = useMemo(() => orderData?.orders ?? [], [orderData]);
  const total = orderData?.total ?? 0;

  const refreshAll = useCallback(() => {
    refetchStats();
    refetchOrders();
    refetchItems();
    refetchErrors();
  }, [refetchStats, refetchOrders, refetchItems, refetchErrors]);

  // Product names per order, for the "what was in it" line.
  const basketByOrder = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const it of items ?? []) {
      if (it.line_type !== "product") continue;
      const list = m.get(it.order_row_id) ?? [];
      list.push(it.product_name);
      m.set(it.order_row_id, list);
    }
    return m;
  }, [items]);

  // Month totals: from all orders when not searching, from the matches when searching.
  const monthTotals = useMemo(() => {
    const m = new Map<string, { spend: number; count: number }>();
    for (const r of months ?? []) m.set(r.period, { spend: r.spend ?? 0, count: r.order_count ?? 0 });
    return m;
  }, [months]);

  const groups = useMemo(() => {
    const out: { key: string; orders: BlinkitOrder[] }[] = [];
    for (const o of orders) {
      const key = (o.invoice_date ?? "").slice(0, 7) || "undated";
      const g = out[out.length - 1];
      if (g && g.key === key) g.orders.push(o);
      else out.push({ key, orders: [o] });
    }
    return out;
  }, [orders]);

  const run = async (what: Exclude<Busy, null>, fn: () => Promise<BlinkitIngestResult>) => {
    setBusy(what);
    setLastResult(null);
    setRequestError(null);
    try {
      setLastResult(await fn());
      refreshAll();
    } catch (e) {
      setRequestError({ what, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const handleScan = () => run("scan", () => blinkitScan());

  const handleReprocess = () => {
    setConfirmReprocess(false);
    run("reprocess", () => blinkitReprocessAll());
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    await run("upload", async () => {
      let combined = { ...EMPTY_RESULT };
      for (const f of list) {
        const r = await blinkitUpload(f);
        combined = {
          files_processed: combined.files_processed + r.files_processed,
          orders_new: combined.orders_new + r.orders_new,
          orders_skipped: combined.orders_skipped + r.orders_skipped,
          items_new: combined.items_new + r.items_new,
          errors: [...combined.errors, ...r.errors],
          warnings: [...combined.warnings, ...r.warnings],
        };
      }
      return combined;
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const resultSentence = (r: BlinkitIngestResult) => {
    if (r.files_processed === 0 && r.errors.length === 0) return "No new invoices found. Everything in the folder is already here.";
    const parts = [`Read ${plural(r.files_processed, "invoice")}`];
    parts.push(`${plural(r.orders_new, "new order")} with ${plural(r.items_new, "item")}`);
    if (r.orders_skipped) parts.push(`${r.orders_skipped} already here`);
    return `${parts.join(", ")}.`;
  };

  const errorCount = stats?.error_count ?? errors?.length ?? 0;
  const folder = stats?.invoice_directory ? displayPath(stats.invoice_directory) : null;

  return (
    <div className="space-y-6">
      {/* Context + actions */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-[360px]">
          {statsError && !stats ? (
            <p className="text-[15px] text-ink-2">Order totals didn&apos;t load. <button type="button" className="text-link" onClick={() => refetchStats()}>Try again</button></p>
          ) : !stats ? (
            <Skeleton className="h-6 w-80" />
          ) : (
            <>
              <p className="text-h3 font-black text-ink">
                {plural(stats.order_count, "order")}, {money(Math.round(stats.total_spend ?? 0))} in all
              </p>
              <p className="mt-1 text-sm text-muted">
                {folder ? <>Scan reads new PDFs from <span className="font-mono text-[12px] text-ink-2">{folder}</span>. </> : null}
                {mode === "test" ? "In test mode, uploads go to the sample data. " : ""}
                <button type="button" className="text-link" onClick={() => setConfirmReprocess(true)} disabled={!!busy}>
                  Read all again…
                </button>
              </p>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={handleScan} disabled={!!busy}>Scan folder</Button>
          <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>Upload invoices</Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>
      </div>

      {busy && (
        <div className="rounded-m bg-accent-50 px-5 py-4">
          <AiWorking>{BUSY_WORDS[busy]}</AiWorking>
        </div>
      )}

      {requestError && (
        <ErrorCard
          title={requestError.what === "upload" ? "Those invoices didn't upload" : "The scan didn't finish"}
          message={`The server said: ${requestError.message}. Check that the backend is running, then try again.`}
          onRetry={() => {
            if (requestError.what === "scan") handleScan();
            else if (requestError.what === "reprocess") handleReprocess();
            else fileRef.current?.click();
          }}
        />
      )}

      {lastResult && (
        <AlertBanner variant={lastResult.errors.length ? "warning" : "success"} onDismiss={() => setLastResult(null)}>
          <p>{resultSentence(lastResult)}</p>
          {lastResult.errors.length > 0 && (
            <p className="mt-1">
              {plural(lastResult.errors.length, "invoice")} couldn&apos;t be read. They&apos;re listed at the bottom of this page.
            </p>
          )}
        </AlertBanner>
      )}

      {errorCount > 0 && !lastResult && (
        <AlertBanner variant="warning">
          {plural(errorCount, "invoice")} couldn&apos;t be read.{" "}
          <a href="#unread-invoices" className="font-semibold underline underline-offset-2">See which ↓</a>
        </AlertBanner>
      )}

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by product, store or order ID"
          aria-label="Search orders"
          className="pl-11 pr-12"
        />
        {searchInput && (
          <IconButton
            size="sm"
            aria-label="Clear search"
            onClick={() => setSearchInput("")}
            className="!absolute right-1.5 top-1/2 !mb-0 -translate-y-1/2"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {/* Orders by month */}
      {ordersError && !orderData ? (
        <ErrorCard message="Your orders didn't load. Check that the backend is running." onRetry={() => refetchOrders()} />
      ) : ordersLoading && !orderData ? (
        <ListSkeleton />
      ) : !orders.length ? (
        <Card>
          {search ? (
            <EmptyState
              compact
              title="No orders match that search"
              hint={`Nothing found for "${search}". Try a product, a store or part of an order ID.`}
              action={<Button variant="ghost" size="md" onClick={() => setSearchInput("")}>Clear search</Button>}
            />
          ) : (
            <EmptyState
              illustration="receipt"
              title="No grocery orders yet"
              hint="Upload your Blinkit invoice PDFs, or save them to your invoice folder and scan it."
            />
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {search && (
            <p className="text-sm text-muted">{plural(total, "order")} match &ldquo;{search}&rdquo;</p>
          )}
          {groups.map((g) => {
            const shownSpend = g.orders.reduce((s, o) => s + (o.grand_total ?? 0), 0);
            const all = monthTotals.get(g.key);
            const spend = !search && all ? all.spend : shownSpend;
            const count = !search && all ? all.count : g.orders.length;
            return (
              <Card key={g.key} padded={false}>
                <div className="flex items-baseline justify-between gap-4 px-5 pb-2 pt-5 md:px-6 md:pt-6">
                  <h3 className="text-h3 font-black text-ink">
                    {g.key === "undated" ? "No date" : monthName(g.key, { short: false })}
                    <span className="ml-2 text-sm font-semibold text-muted">{plural(count, "order")}</span>
                  </h3>
                  <span className="text-h3 font-black tabular-nums text-ink">{money(Math.round(spend))}</span>
                </div>
                <ul className="px-2 pb-2 md:px-3 md:pb-3">
                  {g.orders.map((o) => {
                    const basket = basketByOrder.get(o.id) ?? [];
                    return (
                      <li key={o.id}>
                        <Link
                          href={`/blinkit/orders/${o.id}`}
                          className="flex items-center gap-4 rounded-m px-3 py-3 transition-colors hover:bg-surface"
                        >
                          <span className="w-12 shrink-0 text-center">
                            <span className="block text-[17px] font-black leading-none tabular-nums text-ink">
                              {o.invoice_date ? dayLabel(o.invoice_date).split(" ")[0] : "–"}
                            </span>
                            <span className="mt-1 block text-[12px] font-semibold text-muted">{weekday(o.invoice_date)}</span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 text-[15px] font-semibold text-ink">
                              {basket.length ? basketLine(basket) : shortStore(o.store_name) || "Order"}
                            </span>
                            <span className="block truncate text-sm text-muted">
                              {basket.length ? `${plural(basket.length, "item")} · ${shortStore(o.store_name) || "Blinkit"}` : `Order ${o.order_id ?? o.invoice_number}`}
                            </span>
                          </span>
                          <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{money(o.grand_total)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}
          {orders.length < total && (
            <div className="flex justify-center pt-2">
              <Button variant="ghost" onClick={() => setPages(p => p + 1)}>
                Show older orders ↓
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Invoices that couldn't be read */}
      {errors && errors.length > 0 && (
        <Card>
          <div id="unread-invoices" className="scroll-mt-24" />
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-h3 font-black text-ink">Invoices we couldn&apos;t read</h3>
              <p className="mt-1 text-sm font-medium text-muted">Re-download them from Blinkit, or check they are tax invoices, not order summaries.</p>
            </div>
            <Chip size="sm" tone="warning">{plural(errors.length, "file")}</Chip>
          </div>
          <ul className="mt-4 max-h-96 space-y-2 overflow-y-auto">
            {errors.map((err) => (
              <li key={err.id} className="rounded-m bg-surface px-4 py-3">
                <p className="truncate font-mono text-[12px] text-ink-2" title={err.source_file}>
                  {displayPath(err.source_file)}{err.page != null ? ` · page ${err.page}` : ""}
                </p>
                <p className="mt-1 text-sm text-ink-2">{err.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={confirmReprocess}
        onClose={() => setConfirmReprocess(false)}
        title="Read every invoice again?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReprocess(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleReprocess}>Clear and re-read all</Button>
          </>
        }
      >
        <div className="space-y-3 text-[15px] text-ink-2">
          <p>
            This clears the {stats ? plural(stats.order_count, "order") : "orders"} read so far and reads every PDF in the
            invoice folder again from scratch.
          </p>
          <p>Use it after a parser update to fill in fields that older runs missed. Invoices that were only uploaded, and aren&apos;t in the folder, won&apos;t come back.</p>
        </div>
      </Modal>
    </div>
  );
}

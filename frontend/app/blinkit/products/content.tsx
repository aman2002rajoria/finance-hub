"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import GlobalDateFilter from "@/components/analytics/GlobalDateFilter";
import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { dayLabel, plural } from "@/components/blinkit/format";
import { money, ProductTile, shortProduct, shortStore } from "@/components/blinkit/pieces";
import {
  Badge, Card, CardSkeleton, CardTitle, DataTable, EmptyState, ErrorCard, Skeleton,
  TableCell, TableHead, TableHeadCell, TableRow,
} from "@/components/ui";
import { useBlinkitProductDetail } from "@/lib/api";
import { inr2 } from "@/lib/format";

function BackLink() {
  return (
    <Link href="/blinkit/analytics" className="btn ghost xs">
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      Groceries
    </Link>
  );
}

export default function BlinkitProductContent() {
  const params = useSearchParams();
  const name = params.get("name");
  const { dr } = useDateRange();
  const { data, error, isLoading, mutate } = useBlinkitProductDetail(name, dr);

  if (!name) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Card><EmptyState illustration="receipt" title="No product picked" hint="Open a product from the overview or an order." /></Card>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading product">
        <BackLink />
        <Skeleton className="h-8 w-72" />
        <CardSkeleton height={360} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorCard message="This product didn't load. Check that the backend is running, then try again." onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data?.times_purchased) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Card><EmptyState illustration="receipt" title="No purchases of this product here" hint={`Nothing found for "${name}" in this date range.`} /></Card>
      </div>
    );
  }

  const history = data.purchase_history ?? [];
  const stores = data.stores ?? [];
  const totalQty = data.total_quantity ?? 0;
  const qty = totalQty === 1 ? "one" : `${Math.round(totalQty).toLocaleString("en-IN")}`;
  const unitPrice = totalQty ? (data.total_spend ?? 0) / totalQty : (data.total_spend ?? 0);
  const source = data.ai_categorized ? "ai" : data.categorization_source === "manual" ? "manual" : "rules";

  return (
    <div className="space-y-6">
      <BackLink />

      <header className="flex items-start gap-4">
        <ProductTile name={data.product_name} category={data.category} size={56} className="mt-1" />
        <div className="min-w-0">
          <h2 className="text-[24px] font-black leading-[1.15] text-ink md:text-h2">{shortProduct(data.product_name)}</h2>
          <p className="mt-2 max-w-[68ch] text-base text-ink-2">
            {money(Math.round(data.total_spend ?? 0))} across {plural(data.times_purchased, "order")}
            {Math.round(totalQty) !== data.times_purchased ? `, ${qty} in all` : ""}, about {money(Math.round(unitPrice))} each.
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{data.subcategory ? `${data.category} · ${data.subcategory}` : data.category || "Uncategorised"}</span>
            <span aria-hidden>·</span>
            {source === "ai" && (
              <>
                <Badge tone="accent">AI</Badge>
                <span>
                  Category suggested by {data.ai_model ?? "Gemini"}
                  {data.ai_categorized_at ? ` on ${dayLabel(data.ai_categorized_at)}` : ""}
                </span>
              </>
            )}
            {source === "manual" && <span>Category set by you</span>}
            {source === "rules" && <span>Category from your keyword rules</span>}
          </p>
        </div>
      </header>

      <GlobalDateFilter />

      <Card padded={false}>
        <div className="px-6 pb-3 pt-6">
          <CardTitle>Every time you bought it</CardTitle>
        </div>
        <DataTable>
          <TableHead>
            <tr>
              <TableHeadCell className="pl-6">Date</TableHeadCell>
              <TableHeadCell className="hidden sm:table-cell">Store</TableHeadCell>
              <TableHeadCell align="right">Qty</TableHeadCell>
              <TableHeadCell align="right" className="hidden md:table-cell">Discount</TableHeadCell>
              <TableHeadCell align="right" className="pr-6">Paid</TableHeadCell>
            </tr>
          </TableHead>
          <tbody>
            {history.map((h, i) => {
              return (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap pl-6">{h.invoice_date ? dayLabel(String(h.invoice_date)) : "—"}</TableCell>
                  <TableCell className="hidden max-w-[180px] truncate text-ink-2 sm:table-cell">{shortStore(String(h.store_name ?? "")) || "—"}</TableCell>
                  <TableCell align="right" className="text-ink-2">{String(h.quantity ?? "—")}</TableCell>
                  <TableCell align="right" className="hidden text-ink-2 md:table-cell">{h.discount ? inr2(h.discount as number) : "—"}</TableCell>
                  <TableCell align="right" className="pr-6 font-semibold">{inr2(h.total_amount as number)}</TableCell>
                </TableRow>
              );
            })}
          </tbody>
        </DataTable>
      </Card>
    </div>
  );
}

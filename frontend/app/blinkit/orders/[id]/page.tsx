"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { dayLabel, plural } from "@/components/blinkit/format";
import { money, ProductTile, shortStore } from "@/components/blinkit/pieces";
import {
  Card, CardSkeleton, CardTitle, DataTable, EmptyState, ErrorCard, Skeleton, TableCell,
  TableHead, TableHeadCell, TableRow,
} from "@/components/ui";
import { useBlinkitOrderDetail } from "@/lib/api";
import { inr2 } from "@/lib/format";
import type { BlinkitLineType } from "@/lib/types";

const FEE_LABEL: Partial<Record<BlinkitLineType, string>> = {
  delivery_charge: "Delivery fee",
  handling_charge: "Handling fee",
  convenience_charge: "Convenience fee",
  packaging_charge: "Packaging fee",
  other_charge: "Other charge",
};

function BackLink() {
  return (
    <Link href="/blinkit/orders" className="btn ghost xs">
      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
      All orders
    </Link>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className={mono ? "mt-0.5 break-all font-mono text-[12px] text-ink-2" : "mt-0.5 text-[15px] text-ink"}>{value || "—"}</dd>
    </div>
  );
}

function MoneyRow({ label, value, strong, hideZero }: { label: string; value: number | null | undefined; strong?: boolean; hideZero?: boolean }) {
  if (hideZero && !value) return null;
  return (
    <div className={strong ? "flex items-baseline justify-between gap-4 pt-3" : "flex items-baseline justify-between gap-4 py-1.5"}>
      <span className={strong ? "font-extrabold text-ink" : "text-[15px] text-ink-2"}>{label}</span>
      <span className={strong ? "text-h3 font-black tabular-nums text-ink" : "text-[15px] tabular-nums text-ink"}>{inr2(value)}</span>
    </div>
  );
}

export default function BlinkitOrderDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const { data: order, error, isLoading, mutate } = useBlinkitOrderDetail(Number.isFinite(id) ? id : null);

  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading order">
        <BackLink />
        <div className="space-y-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-5 w-80" />
        </div>
        <div className="grid gap-4 lg:grid-cols-12">
          <CardSkeleton height={520} className="lg:col-span-8" />
          <CardSkeleton height={360} className="lg:col-span-4" />
        </div>
      </div>
    );
  }

  if (error && !order) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorCard
          title="This order didn't load"
          message="The app couldn't reach the server. Check that the backend is running, then try again."
          onRetry={() => mutate()}
        />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Card>
          <EmptyState
            illustration="receipt"
            title="We couldn't find this order"
            hint="It may have been removed when invoices were read again. Pick it from the list instead."
            action={<Link href="/blinkit/orders" className="btn ghost sm">See all orders</Link>}
          />
        </Card>
      </div>
    );
  }

  const products = (order.items ?? []).filter(i => i.line_type === "product");
  const feeLines = (order.items ?? []).filter(i => i.line_type !== "product");
  const date = dayLabel(order.invoice_date);
  const savedTotal = order.discount_total ?? 0;
  const details: { label: string; value: string | null | undefined; mono?: boolean }[] = [
    { label: "Packed by", value: [shortStore(order.store_name), order.seller_name].filter(Boolean).join(", ") },
    { label: "Delivered to", value: order.delivery_address || [order.delivery_city, order.delivery_pincode].filter(Boolean).join(" ") },
    { label: "Paid with", value: order.payment_method },
    { label: "Order ID", value: order.order_id, mono: true },
    { label: "Invoice", value: order.invoice_number, mono: true },
    { label: "Seller GSTIN", value: order.seller_gstin, mono: true },
    { label: "Read from", value: order.source_file ? `${order.source_file.split("/").pop()}${order.page_number ? `, page ${order.page_number}` : ""}` : null, mono: true },
  ].filter(d => d.value);

  return (
    <div className="space-y-6">
      <BackLink />

      <header>
        <h2 className="text-[28px] font-black leading-[1.1] tracking-[-0.01em] text-ink md:text-[36px]">
          {money(order.grand_total)} on {date}
        </h2>
        <p className="mt-2 text-base text-ink-2">
          {plural(products.length, "item")}{order.store_name ? ` from ${shortStore(order.store_name)}` : ""}
          {savedTotal > 0 ? `. Discounts saved you ${money(savedTotal)}.` : "."}
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        {/* The order itself: items, then the bill */}
        <Card className="lg:col-span-8">
          <CardTitle>What was in it</CardTitle>
          <ul className="mt-3">
            {products.map(item => {
              const qty = item.quantity ?? 1;
              const unit = item.selling_price ?? (item.total_amount != null && qty ? item.total_amount / qty : null);
              return (
                <li key={item.id} className="flex items-center gap-4 border-b border-line py-3 last:border-b-0">
                  <ProductTile name={item.product_name} category={item.category} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-ink" title={item.product_name}>{item.product_name}</p>
                    <p className="mt-0.5 text-sm tabular-nums text-muted">
                      {qty} × {inr2(unit)}{item.discount ? ` · ${inr2(item.discount)} off` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{inr2(item.total_amount)}</span>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 rounded-m bg-surface px-5 py-4">
            <MoneyRow label="Items" value={order.item_total} />
            <MoneyRow label="Delivery fee" value={order.delivery_fee} hideZero />
            <MoneyRow label="Handling fee" value={order.handling_charge} hideZero />
            <MoneyRow label="Convenience fee" value={order.convenience_fee} hideZero />
            <MoneyRow label="Packaging fee" value={order.packaging_charge} hideZero />
            <MoneyRow label="Other charges" value={order.other_charges} hideZero />
            {feeLines.length > 0 && !order.delivery_fee && !order.handling_charge && !order.convenience_fee && feeLines.map(f => (
              <MoneyRow key={f.id} label={FEE_LABEL[f.line_type] ?? f.product_name} value={f.total_amount} />
            ))}
            {!!order.discount_total && (
              <div className="flex items-baseline justify-between gap-4 py-1.5">
                <span className="text-[15px] text-ink-2">Discount</span>
                <span className="text-[15px] tabular-nums text-success-text">−{inr2(order.discount_total)}</span>
              </div>
            )}
            <MoneyRow label="Taxes (CGST + SGST)" value={order.tax_total ?? ((order.cgst_total ?? 0) + (order.sgst_total ?? 0))} hideZero />
            <div className="mt-2 h-px bg-line" />
            <MoneyRow label="Total" value={order.grand_total} strong />
          </div>
        </Card>

        <Card className="lg:col-span-4">
          <CardTitle>Details</CardTitle>
          <dl className="mt-2">
            {details.map(d => <Row key={d.label} label={d.label} value={d.value} mono={d.mono} />)}
          </dl>
        </Card>
      </div>

      {order.annexure_charges.length > 0 && (
        <Card padded={false}>
          <div className="px-6 pb-3 pt-6">
            <CardTitle subtitle="The tax breakdown Blinkit attaches for fees">Charges annexure</CardTitle>
          </div>
          <DataTable>
            <TableHead>
              <tr>
                <TableHeadCell className="pl-6">Charge</TableHeadCell>
                <TableHeadCell align="right">Tax rate</TableHeadCell>
                <TableHeadCell align="right">Taxable</TableHeadCell>
                <TableHeadCell align="right">CGST</TableHeadCell>
                <TableHeadCell align="right" className="pr-6">SGST</TableHeadCell>
              </tr>
            </TableHead>
            <tbody>
              {order.annexure_charges.map(a => (
                <TableRow key={a.id}>
                  <TableCell className="pl-6">{a.nature_of_charge}</TableCell>
                  <TableCell align="right" className="text-ink-2">{a.tax_rate ?? "—"}</TableCell>
                  <TableCell align="right">{inr2(a.taxable_value)}</TableCell>
                  <TableCell align="right" className="text-ink-2">{inr2(a.cgst)}</TableCell>
                  <TableCell align="right" className="pr-6 text-ink-2">{inr2(a.sgst)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </div>
  );
}

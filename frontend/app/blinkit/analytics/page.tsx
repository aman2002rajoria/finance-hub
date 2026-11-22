"use client";

/*
 * Groceries overview. It reads top-down as answers:
 *   1. How much a month?            (the headline)
 *   2. Where does it go?            (subcategories, focus + context)
 *   3. Is this month normal?        (month bars, the latest in accent)
 *   4. What did fees cost?          (the one insight card)
 *   5. What do I buy most?          (products with tiles)
 * Narrower questions live on Explore.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import GlobalDateFilter from "@/components/analytics/GlobalDateFilter";
import { useDateRange } from "@/components/analytics/DateRangeProvider";
import { buildDrilldownHref, type BlinkitDrillSelection } from "@/components/blinkit/drilldown";
import CategorizationProgressBanner from "@/components/blinkit/CategorizationProgressBanner";
import CategorizationProgressDialog from "@/components/blinkit/CategorizationProgressDialog";
import { monthName, plural } from "@/components/blinkit/format";
import {
  cadence, ColumnBars, inSentence, money, ProductTile, RankList, shortProduct, type RankRow,
} from "@/components/blinkit/pieces";
import { useCategorizationJob } from "@/hooks/useCategorizationJob";
import {
  AlertBanner, Badge, Button, Card, CardTitle, EmptyState, ErrorCard, InsightCard, Modal, Skeleton,
} from "@/components/ui";
import {
  blinkitCategorize, useAppConfig, useBlinkitAnalyticsSummary, useBlinkitProductRankings,
  useBlinkitSpendingOverTime, useBlinkitSubcategoryAnalytics,
} from "@/lib/api";

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function OverviewSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading your grocery spending">
      <div className="space-y-3">
        <Skeleton className="h-10 w-[min(460px,100%)]" />
        <Skeleton className="h-5 w-[min(560px,100%)]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="rounded-l bg-card p-6 shadow-flat lg:col-span-7">
          <Skeleton className="h-6 w-72" />
          <div className="mt-6 space-y-5">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div>
        </div>
        <div className="rounded-l bg-card p-6 shadow-flat lg:col-span-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-6 h-[240px] w-full" />
        </div>
      </div>
    </div>
  );
}

export default function GroceriesOverviewPage() {
  const router = useRouter();
  const { dr } = useDateRange();
  const [catMsg, setCatMsg] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  const [confirmReclassify, setConfirmReclassify] = useState(false);
  const { data: appConfig } = useAppConfig();

  const openDrill = useCallback((sel: BlinkitDrillSelection) => {
    router.push(buildDrilldownHref(sel));
  }, [router]);

  const { data: summary, error: summaryError, mutate: refetchSummary } = useBlinkitAnalyticsSummary(dr);
  const { data: spending } = useBlinkitSpendingOverTime(dr, "month");
  const { data: subcats, mutate: refetchSubcats } = useBlinkitSubcategoryAnalytics(dr);
  const { data: productsSpend } = useBlinkitProductRankings(dr, "spend");

  const cat = useCategorizationJob({
    onFinished: (job) => {
      refetchSummary();
      refetchSubcats();
      const s = job?.summary;
      if (job?.status === "completed" && s) {
        const tail = s.failed ? ` ${plural(s.failed, "product")} couldn't be placed and stay uncategorised.` : "";
        setCatMsg({
          tone: s.failed ? "warning" : "success",
          text: `Sorted ${plural(s.newly_categorized ?? 0, "new product")}${s.recategorized ? ` and re-sorted ${s.recategorized}` : ""}.${tail}`,
        });
      } else if (job?.status === "cancelled") {
        setCatMsg({ tone: "warning", text: `Stopped. ${plural(job.completed_products ?? 0, "product")} sorted before it stopped are saved.` });
      } else if (job?.status === "failed") {
        setCatMsg({ tone: "danger", text: job.error ?? "Sorting stopped because of an error. Check your Gemini key in Settings, then try again." });
      }
    },
  });

  // Refresh keyword-rule categories quietly on load (no AI calls).
  useEffect(() => {
    blinkitCategorize({ refresh: false }).catch(() => {});
  }, []);

  const months = useMemo(() => (spending ?? []).filter(m => (m.spend ?? 0) > 0), [spending]);

  // Where it goes: six biggest subcategories, the rest folded into one grey row.
  const whereRows = useMemo<RankRow[]>(() => {
    const all = [...(subcats ?? [])].sort((a, b) => (b.total_spend ?? 0) - (a.total_spend ?? 0));
    const top: RankRow[] = all.slice(0, 6).map(r => ({
      key: `${r.category ?? ""}|${r.subcategory ?? ""}`,
      label: r.subcategory || "Uncategorised",
      value: r.total_spend ?? 0,
    }));
    const rest = all.slice(6).reduce((s, r) => s + (r.total_spend ?? 0), 0);
    return rest > 0 ? [...top, { key: "other", label: `${all.length - 6} smaller groups`, value: rest, other: true }] : top;
  }, [subcats]);

  const aiEnabled = !!appConfig?.ai_categorization_enabled;
  const busy = cat.running || cat.starting;

  const startJob = async (mode: "unclassified" | "reclassify_all") => {
    setCatMsg(null);
    try {
      await cat.startJob(mode);
    } catch (e) {
      setCatMsg({
        tone: "danger",
        text: `Sorting didn't start (${e instanceof Error ? e.message : String(e)}). Check your Gemini key in Settings, then try again.`,
      });
    }
  };

  if (summaryError && !summary) {
    return (
      <ErrorCard
        title="Your grocery spending didn't load"
        message="The app couldn't reach the server. Check that the backend is running, then try again."
        onRetry={() => refetchSummary()}
      />
    );
  }

  if (!summary) return <OverviewSkeleton />;

  if (!summary.total_orders) {
    return (
      <div className="space-y-6">
        <GlobalDateFilter />
        <Card>
          <EmptyState
            illustration="receipt"
            title="No grocery orders in this range"
            hint="Add your Blinkit invoices, or pick a wider date range above."
            action={<Link href="/blinkit/orders" className="btn primary sm">Add invoices →</Link>}
          />
        </Card>
      </div>
    );
  }

  // 1. The headline
  const monthCount = Math.max(1, months.length);
  const orders = summary.distinct_order_ids || summary.total_orders || 0;
  const monthly = (summary.total_spend ?? 0) / monthCount;
  const first = months[0]?.period;
  const last = months[months.length - 1]?.period;
  const thisYear = String(new Date().getFullYear());
  const span = first && last && first !== last
    ? `from ${monthName(first, { short: first.slice(0, 4) === last.slice(0, 4) })} to ${monthName(last, { short: last.slice(0, 4) === thisYear })}`
    : first ? `in ${monthName(first, { short: first.slice(0, 4) === thisYear })}` : "";

  // 2. Where it goes
  const totalSub = whereRows.reduce((s, r) => s + r.value, 0);
  const lead = whereRows[0];
  const leadShare = lead && totalSub > 0 ? Math.round((lead.value / totalSub) * 100) : 0;
  const runnersUp = whereRows.slice(1, 3).filter(r => !r.other).map(r => inSentence(r.label));
  const whereTitle = !lead ? "Where it goes"
    : leadShare >= 20 ? `Most of it goes on ${inSentence(lead.label)}`
    : `${lead.label} tops the list`;

  // 3. Month by month
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const shownMonths = months.slice(-8);
  const lastMonth = shownMonths[shownMonths.length - 1];
  const isCurrent = lastMonth?.period === nowKey;
  const lastName = lastMonth ? MONTHS_LONG[Number(lastMonth.period.slice(5, 7)) - 1] ?? "" : "";
  const vsAvg = lastMonth && monthly > 0 ? (lastMonth.spend ?? 0) / monthly : 1;
  const monthTitle = !lastMonth || months.length < 2 ? "Month by month"
    : isCurrent ? `${lastName} so far: ${money(Math.round(lastMonth.spend ?? 0))}`
    : vsAvg > 1.15 ? `${lastName} cost more than usual`
    : vsAvg < 0.85 ? `${lastName} was a lighter month`
    : `${lastName} was a typical month`;

  // 4. Fees
  const delivery = summary.total_delivery_charges ?? 0;
  const handling = summary.total_handling_charges ?? 0;
  const convenience = summary.total_convenience_charges ?? 0;
  const fees = delivery + handling + convenience;
  const feeParts = [
    { label: "handling", v: handling },
    { label: "delivery", v: delivery },
    { label: "small-cart and convenience", v: convenience },
  ].filter(p => p.v > 0).sort((a, b) => b.v - a.v);
  const discount = summary.total_discount ?? 0;
  const feeRest = feeParts.slice(1).map(p => `${money(Math.round(p.v))} ${p.label}`);

  // 5. Products
  const topProducts = (productsSpend ?? []).slice(0, 6);

  return (
    <div className="space-y-8">
      {/* 1. How much a month */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h2 className="text-[28px] font-black leading-[1.1] tracking-[-0.01em] text-ink md:text-[36px]">
            <span className="tabular-nums text-accent-700">{money(Math.round(monthly))}</span> a month on groceries
          </h2>
          <p className="mt-2 max-w-[80ch] text-base text-ink-2">
            {money(Math.round(summary.total_spend ?? 0))} across {plural(orders, "order")} {span}. That&apos;s {cadence(orders / monthCount)}, {money(Math.round(summary.avg_order_value ?? 0))} a basket.
          </p>
        </div>
        <GlobalDateFilter />
      </div>

      {cat.job && cat.running && <CategorizationProgressBanner job={cat.job} onClick={cat.openDialog} />}
      {catMsg && (
        <AlertBanner variant={catMsg.tone} onDismiss={() => setCatMsg(null)}>
          {catMsg.text}{" "}
          {cat.job && !cat.running && (
            <button type="button" onClick={cat.openDialog} className="font-semibold underline underline-offset-2">See details</button>
          )}
        </AlertBanner>
      )}

      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
        {/* 2. Where it goes */}
        <div className="lg:col-span-7">
        <Card className="flex h-full flex-col">
          <CardTitle
            subtitle={lead
              ? `${leadShare}% of what you spent${runnersUp.length ? `, then ${runnersUp.join(" and ")}` : ""}.`
              : undefined}
          >
            {whereTitle}
          </CardTitle>
          {subcats ? (
            whereRows.length ? (
              <RankList
                className="mb-5 mt-4"
                rows={whereRows}
                format={(v) => money(Math.round(v))}
                onPick={(r) => {
                  const [category, subcategory] = r.key.split("|");
                  openDrill({ dimension: "subcategory", value: subcategory, category_filter: category, source: "Where it goes" });
                }}
              />
            ) : (
              <EmptyState compact title="Nothing sorted yet" hint="Products get a category as soon as invoices are read." />
            )
          ) : (
            <div className="my-6 space-y-5">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-sm text-muted">
            <Badge tone="accent">AI</Badge>
            {aiEnabled ? (
              <>
                <span className="min-w-0 flex-1">Sorted by Gemini and your keyword rules. Your own edits stay.</span>
                <span className="flex flex-wrap items-center gap-3">
                  <button type="button" className="text-link" onClick={() => setConfirmReclassify(true)} disabled={busy}>
                    Re-check all
                  </button>
                  <Button variant="ghost" size="sm" onClick={() => startJob("unclassified")} disabled={busy} loading={cat.starting}>
                    Sort new products
                  </Button>
                </span>
              </>
            ) : appConfig ? (
              <span>
                Sorted by your keyword rules.{" "}
                <Link href="/settings" className="text-link">Add a Gemini key for sharper categories →</Link>
              </span>
            ) : (
              <span>Sorted by your keyword rules.</span>
            )}
          </div>
        </Card>
        </div>

        {/* 3. Month by month */}
        <div className="lg:col-span-5">
        <Card className="flex h-full flex-col">
          <CardTitle subtitle={months.length > 1 ? `Your average month is ${money(Math.round(monthly))}.` : undefined}>
            {monthTitle}
          </CardTitle>
          {spending ? (
            shownMonths.length ? (
              <ColumnBars
                className="mt-auto pt-6"
                height={260}
                focusIndex={shownMonths.length - 1}
                bars={shownMonths.map(m => ({
                  key: m.period,
                  value: m.spend ?? 0,
                  label: monthName(m.period, { short: true }),
                  caption: money(Math.round(m.spend ?? 0)),
                  ariaLabel: `${monthName(m.period)}: ${money(Math.round(m.spend ?? 0))}. See its orders`,
                }))}
                onPick={(b) => openDrill({ dimension: "month", value: b.key, source: "Month by month" })}
              />
            ) : (
              <EmptyState compact title="No months to show" hint="Months appear once invoices are in." />
            )
          ) : (
            <Skeleton className="mt-6 h-[240px] w-full" />
          )}
        </Card>
        </div>
      </div>

      {/* 4. The one insight: fees */}
      {fees > 0 && (
        <InsightCard
          title={`${money(Math.round(fees))} went on fees, not food`}
          action={
            <button type="button" className="text-link text-sm" onClick={() => openDrill({ dimension: "has_delivery", source: "Fees" })}>
              See orders with fees →
            </button>
          }
        >
          <p className="max-w-[68ch] text-[15px] text-ink-2">
            {feeParts.length > 1
              ? `Mostly ${feeParts[0].label} fees (${money(Math.round(feeParts[0].v))}), plus ${feeRest.join(" and ")}.`
              : `All of it ${feeParts[0]?.label} fees.`}
            {discount > fees
              ? ` Discounts took ${money(Math.round(discount))} off, more than the fees cost.`
              : discount > 0
                ? ` Discounts took ${money(Math.round(discount))} off.`
                : ""}
          </p>
        </InsightCard>
      )}

      {/* 5. What you buy most */}
      <Card>
        <CardTitle subtitle="Ranked by what you spent on each">What you buy most</CardTitle>
        {productsSpend ? (
          topProducts.length ? (
            <ul className="mt-3 grid gap-x-10 md:grid-cols-2">
              {topProducts.map((p, i) => {
                const name = p.product_name ?? "";
                return (
                  <li key={name || i}>
                    <button
                      type="button"
                      onClick={() => router.push(`/blinkit/products?name=${encodeURIComponent(name)}`)}
                      className="-mx-3 flex w-[calc(100%+24px)] items-center gap-4 rounded-s px-3 py-3 text-left transition-colors hover:bg-surface"
                    >
                      <ProductTile name={name} category={p.category} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-ink" title={name}>{shortProduct(name)}</span>
                        <span className="block text-sm text-muted">
                          {p.times_purchased === 1 ? "Bought once" : `Bought ${p.times_purchased ?? 0} times`}
                        </span>
                      </span>
                      <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{money(Math.round(p.total_spend ?? 0))}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact title="No products yet" hint="Products show up once invoices are read." />
          )
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
        )}
      </Card>

      <CategorizationProgressDialog
        job={cat.job}
        open={cat.dialogOpen}
        onClose={cat.closeDialog}
        onTerminate={cat.cancelJob}
        terminating={cat.terminating}
      />

      <Modal
        open={confirmReclassify}
        onClose={() => setConfirmReclassify(false)}
        title="Re-check every product?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReclassify(false)}>Cancel</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmReclassify(false);
                startJob("reclassify_all");
              }}
            >
              Re-check {plural(summary.unique_products ?? 0, "product")}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[15px] text-ink-2">
          <p>Gemini looks at every product again and may move some to a different category.</p>
          <p>Categories you set by hand stay as they are. This uses your Gemini quota and can take a few minutes.</p>
        </div>
      </Modal>
    </div>
  );
}

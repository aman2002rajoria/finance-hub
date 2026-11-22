"use client";

import { useRouter } from "next/navigation";

import { KpiCard, Skeleton } from "@/components/ui";
import { useProgress } from "@/lib/api";
import { inr } from "@/lib/format";
import type { FinancialSnapshot as Snapshot } from "@/lib/types";

import { useDateRange } from "./DateRangeProvider";

/**
 * Three KPI cards (design.md §7): Real spend (the focus number, in accent),
 * what was saved, and what still needs a tag. The savings rate lives in the
 * headline sentence, so it isn't repeated here.
 *
 * Values count up on first view (§14); NumberTicker formats in en-IN, so
 * lakh grouping (₹12,43,415) holds while it counts.
 */
export default function FinancialSnapshot({ data }: { data?: Snapshot | null }) {
  const router = useRouter();
  const { dr } = useDateRange();
  const { data: prog, isLoading: progLoading } = useProgress(dr);
  const pe = data?.personal_economics;
  if (!pe) return null;

  const untagged = prog?.uncategorized_transactions ?? 0;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      <div className="col-span-2 lg:col-span-1">
        <KpiCard
          label="Real spend"
          value={inr(pe.net_personal_spend)}
          focus
          motionIndex={0}
          sub="card bills and transfers left out"
        />
      </div>
      <KpiCard
        label={pe.savings >= 0 ? "Saved" : "Spent beyond income"}
        value={inr(Math.abs(pe.savings ?? 0))}
        motionIndex={1}
        sub={`of ${inr(pe.true_income)} income`}
      />
      {progLoading && !prog ? (
        <div className="flex h-full flex-col rounded-m bg-card p-5 shadow-flat" aria-busy="true">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-8 w-16" />
          <Skeleton className="mt-3 h-4 w-40" />
        </div>
      ) : (
        <KpiCard
          label="Needs a tag"
          value={untagged.toLocaleString("en-IN")}
          tone={untagged > 0 ? "warning" : undefined}
          animate={false}
          motionIndex={2}
          onClick={() => router.push("/categorize")}
          sub={untagged > 0 ? "transactions with no category · tag them →" : "every transaction has a category"}
        />
      )}
    </div>
  );
}

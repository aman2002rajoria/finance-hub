"use client";

import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Button, EmptyState, ErrorCard, Modal, Skeleton,
} from "@/components/ui";
import { useExpenseDrilldown } from "@/lib/api";
import { inr } from "@/lib/format";
import type { DateRange } from "@/lib/types";

import { errorMessage } from "./cardStates";
import { useDateRange } from "./DateRangeProvider";
import { categoryLabel, dayMonth, plural } from "./fmt";

interface Props {
  open: boolean;
  onClose: () => void;
  category: string | null;
  /** Overrides the page date range (e.g. one month on the focused-month view). */
  dr?: DateRange;
  /** Words for that range, e.g. "November 2026". */
  rangeLabel?: string;
}

const LEVEL_NOUN: Record<string, string> = {
  subcategory: "sub-category",
  counterparty: "merchant",
  transactions: "transaction",
};

/** Category → sub-category → merchant → transactions, in the Modal look (§7). */
export default function ExpenseDrilldownDialog({ open, onClose, category, dr: drProp, rangeLabel }: Props) {
  const ctx = useDateRange();
  const dr = drProp ?? ctx.dr;
  const subtitle = rangeLabel ?? ctx.subtitle;
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [counterparty, setCounterparty] = useState<string | null>(null);

  const params = useMemo(() => {
    if (!category || !open) return null;
    return {
      category,
      subcategory: subcategory ?? undefined,
      counterparty: counterparty ?? undefined,
    };
  }, [category, subcategory, counterparty, open]);

  const { data, error, isLoading, mutate } = useExpenseDrilldown(dr, params);

  function handleClose() {
    setSubcategory(null);
    setCounterparty(null);
    onClose();
  }

  function drillRow(label: string) {
    if (!data) return;
    if (data.level === "subcategory") setSubcategory(label);
    else if (data.level === "counterparty") setCounterparty(label);
  }

  function up() {
    if (counterparty) setCounterparty(null);
    else setSubcategory(null);
  }

  const crumbs = [category, subcategory, counterparty].filter(Boolean) as string[];
  const title = crumbs.length ? categoryLabel(crumbs[crumbs.length - 1]) : "Spend breakdown";
  const canDrill = data ? data.level !== "transactions" : false;
  const noun = data ? LEVEL_NOUN[data.level] ?? "item" : "item";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      width="max-w-[640px]"
      footer={
        (subcategory || counterparty) ? (
          <Button variant="ghost" size="md" onClick={up}>Back to {categoryLabel(crumbs[crumbs.length - 2])}</Button>
        ) : undefined
      }
    >
      {crumbs.length > 1 && (
        <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm font-medium text-muted">
          {crumbs.map((c, i) => (
            <span key={c + i} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-4 w-4 text-faint" strokeWidth={1.75} aria-hidden />}
              <span className={i === crumbs.length - 1 ? "text-ink" : undefined}>{categoryLabel(c)}</span>
            </span>
          ))}
        </nav>
      )}

      {error && !isLoading ? (
        <ErrorCard
          title="This breakdown didn't load"
          message={errorMessage(error, "this breakdown")}
          onRetry={() => mutate()}
        />
      ) : !data ? (
        <div aria-busy="true" aria-label="Loading breakdown" className="space-y-3">
          <Skeleton className="h-5 w-56" />
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : (
        <>
          <p className="text-base text-ink-2">
            <span className="font-extrabold tabular-nums text-ink">{inr(data.total)}</span> of real spend in{" "}
            {subtitle}, across {plural((data.rows ?? []).length, noun)}.
          </p>

          {(data.rows ?? []).length === 0 ? (
            <EmptyState
              compact
              illustration="receipt"
              title="No spend here"
              hint="Nothing in this range landed in this bucket."
            />
          ) : (
            <ul className="mt-4 max-h-[52vh] space-y-1 overflow-y-auto pr-1">
              {(data.rows ?? []).map(row => {
                const inner = (
                  <>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-base font-medium text-ink" title={row.label}>
                        {categoryLabel(row.label)}
                      </span>
                      <span className="block text-sm font-medium tabular-nums text-muted">
                        {row.date ? dayMonth(row.date, true) : row.txn_count != null ? plural(row.txn_count, "charge") : null}
                      </span>
                    </span>
                    <span className="shrink-0 text-base font-semibold tabular-nums text-ink">{inr(row.amount)}</span>
                    {canDrill && <ChevronRight className="h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />}
                  </>
                );
                return (
                  <li key={row.id ?? row.label}>
                    {canDrill ? (
                      <button
                        type="button"
                        onClick={() => drillRow(row.label)}
                        className="flex w-full items-center gap-3 rounded-s px-3 py-2.5 transition-colors hover:bg-surface"
                      >
                        {inner}
                      </button>
                    ) : (
                      <div className="flex items-center gap-3 rounded-s px-3 py-2.5">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

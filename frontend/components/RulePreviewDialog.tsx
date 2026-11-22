"use client";

// Shows which transactions a rule would match before anything changes.
// Opened from Categorise ("Preview matches") and the rule editor
// ("Preview and tag"). Nothing is written until the named apply button.

import { useEffect, useState } from "react";

import { categoryPath, dayMonth, errorText, plural } from "@/components/ledger/format";
import { Amount, TableSkeleton } from "@/components/ledger/primitives";
import { conditionsText } from "@/components/ledger/ruleText";
import { TxnTable, type TxnColumn } from "@/components/ledger/TxnTable";
import { TransactionDescriptionCell } from "@/components/TransactionDescriptionCell";
import { AiWorking, AlertBanner, Button, ErrorCard, Modal } from "@/components/ui";
import { previewRule } from "@/lib/api";
import { inr } from "@/lib/format";
import { serializeTree } from "@/lib/ruleBuilder";
import type { ConditionTree, RulePreviewResult, RulePreviewTxn } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  conditions: ConditionTree;
  proposedCategory?: string | null;
  proposedSubcategory?: string | null;
  /** Default false so already-tagged rows are visible for checking. */
  defaultOnlyUncategorized?: boolean;
  /** Called with the "untagged only" choice when the user approves. */
  onApply?: (onlyUncategorized: boolean) => void;
  applyBusy?: boolean;
  /** Override the generated "Tag 12 charges as Food" label. */
  applyLabel?: string;
  title?: string;
}

export function RulePreviewDialog({
  open,
  onClose,
  conditions,
  proposedCategory,
  proposedSubcategory,
  defaultOnlyUncategorized = false,
  onApply,
  applyBusy,
  applyLabel,
  title = "What this rule matches",
}: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RulePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyUncategorized, setOnlyUncategorized] = useState(defaultOnlyUncategorized);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (open) setOnlyUncategorized(defaultOnlyUncategorized);
  }, [open, defaultOnlyUncategorized]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await previewRule({
          conditions: serializeTree(conditions),
          limit: 200,
          only_uncategorized: onlyUncategorized,
          proposed_category: proposedCategory,
          proposed_subcategory: proposedSubcategory,
        });
        if (!cancelled) setResult(r);
      } catch (e: unknown) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, conditions, proposedCategory, proposedSubcategory, onlyUncategorized, attempt]);

  const matchText = conditionsText(conditions);
  const n = result?.match_count ?? 0;
  const target = categoryPath(proposedCategory, proposedSubcategory);

  const columns: TxnColumn<RulePreviewTxn & { date: string | null }>[] = [
    { key: "date", header: "Date", className: "whitespace-nowrap text-sm font-medium text-ink-2", cell: t => dayMonth(t.date) },
    {
      key: "desc",
      header: "Description",
      className: "min-w-[200px] max-w-[300px]",
      cell: t => <TransactionDescriptionCell description={t.description} lead={t.merchant_name} />,
    },
    {
      key: "now",
      header: "Category now",
      className: "whitespace-nowrap text-sm",
      cell: t => t.category
        ? <span className="text-ink-2">{categoryPath(t.category, t.subcategory)}</span>
        : <span className="text-muted">No tag</span>,
    },
    ...(proposedCategory ? [{
      key: "next",
      header: "Becomes",
      className: "whitespace-nowrap text-sm font-semibold text-ink",
      cell: (t: RulePreviewTxn) => categoryPath(t.proposed_category, t.proposed_subcategory) || "No change",
    }] : []),
    { key: "amount", header: "Amount", align: "right" as const, cell: t => <Amount amount={t.amount} type={t.type} /> },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-[920px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{onApply ? "Cancel" : "Close"}</Button>
          {onApply && (
            <Button
              variant="primary"
              onClick={() => onApply(onlyUncategorized)}
              loading={applyBusy}
              disabled={loading || !n || !proposedCategory}
            >
              {applyLabel ?? (n ? `Save rule and tag ${plural(n, "charge")}` : "Save rule and tag")}
            </Button>
          )}
          {onApply && (
            <p className="w-full text-right text-sm font-medium text-muted">
              {target ? `Matches become ${target}. ` : ""}Charges you tagged by hand are never changed.
            </p>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {matchText && (
          <p className="text-[15px] leading-relaxed text-ink-2">
            Matches when {matchText}.
          </p>
        )}

        <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink-2">
          <input
            type="checkbox"
            checked={onlyUncategorized}
            onChange={e => setOnlyUncategorized(e.target.checked)}
            className="h-4 w-4 accent-accent-600"
          />
          {onApply ? "Only tag charges that have no tag yet" : "Only show charges with no tag yet"}
        </label>

        {error && (
          <ErrorCard
            message={`The preview didn't load: ${error}`}
            onRetry={() => setAttempt(a => a + 1)}
          />
        )}

        {loading && (
          <div className="space-y-4">
            <AiWorking>
              Checking {result?.rows_total ? plural(result.rows_total, "transaction") : "your transactions"} against this rule…
            </AiWorking>
            <TableSkeleton rows={5} cols={4} />
          </div>
        )}

        {result && !loading && !error && (
          <div className="space-y-5">
            {result.match_count === 0 && onlyUncategorized && (result.rows_skipped_tagged ?? 0) > 0 && (
              <AlertBanner variant="warning">
                Nothing untagged matches. {plural(result.rows_skipped_tagged ?? 0, "tagged charge")} would match;
                untick the box above to see them.
              </AlertBanner>
            )}

            <p className="text-[15px] leading-relaxed text-ink-2">
              <span className="font-black text-ink">{plural(result.match_count, "match", "matches")}</span>
              {" "}out of {(result.rows_evaluated ?? 0).toLocaleString("en-IN")} checked
              {result.match_count > 0 && <>: {inr(result.expense_amount)} out, {inr(result.income_amount)} in</>}.
              <span className="text-muted"> Transfers, card bills and EMI lump sums are left out.</span>
            </p>

            {result.transactions.length === 0 ? (
              <p className="rounded-m bg-surface px-5 py-8 text-center text-[15px] text-muted">
                No transactions match these conditions.
              </p>
            ) : (
              <div className="overflow-hidden rounded-m shadow-flat">
                <TxnTable
                  label="Matching transactions"
                  rows={result.transactions}
                  columns={columns}
                  maxHeight="max-h-[360px]"
                />
              </div>
            )}
            {result.match_count > result.transactions.length && (
              <p className="text-sm text-muted">
                Showing the first {result.transactions.length} of {result.match_count.toLocaleString("en-IN")} matches.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

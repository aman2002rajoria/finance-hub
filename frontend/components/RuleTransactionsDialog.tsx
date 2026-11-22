"use client";

// The transactions a rule has tagged, so you can check its work.

import { useEffect, useState } from "react";

import { categoryPath, dayMonth, plural } from "@/components/ledger/format";
import { Amount, TableSkeleton } from "@/components/ledger/primitives";
import { ruleMatchText, ruleTitle } from "@/components/ledger/ruleText";
import { TxnTable, type TxnColumn } from "@/components/ledger/TxnTable";
import { TransactionDescriptionCell } from "@/components/TransactionDescriptionCell";
import { TransactionDetailDrawer } from "@/components/TransactionDetailDrawer";
import { Button, ErrorCard, Modal } from "@/components/ui";
import { useTransactions } from "@/lib/api";
import type { CategorizationRule, Transaction, TransactionSortKey } from "@/lib/types";

const PAGE = 100;

interface Props {
  rule: CategorizationRule | null;
  onClose: () => void;
}

export function RuleTransactionsDialog({ rule, onClose }: Props) {
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState<TransactionSortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useTransactions(
    rule ? { categorized_by_rule_id: rule.id, limit: PAGE, offset, sort_by: sortBy, sort_dir: sortDir } : null,
  );

  useEffect(() => { setOffset(0); }, [rule?.id, sortBy, sortDir]);

  const total = data?.total ?? rule?.transactions_categorized ?? 0;
  const txns = data?.transactions ?? [];

  function sort(col: TransactionSortKey) {
    if (sortBy === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir(col === "description" ? "asc" : "desc"); }
  }

  const columns: TxnColumn<Transaction>[] = [
    {
      key: "date", header: "Date", onSort: () => sort("date"), sortDir: sortBy === "date" ? sortDir : null,
      className: "whitespace-nowrap text-sm font-medium text-ink-2", cell: t => dayMonth(t.date),
    },
    {
      key: "desc", header: "Description", className: "min-w-[200px] max-w-[320px]",
      cell: t => (
        <TransactionDescriptionCell
          description={t.description}
          rawText={t.raw_text}
          lead={t.merchant_name}
          onOpenDetails={() => setDetailId(t.id)}
        />
      ),
    },
    {
      key: "amount", header: "Amount", align: "right", onSort: () => sort("amount"),
      sortDir: sortBy === "amount" ? sortDir : null, cell: t => <Amount amount={t.amount} type={t.type} />,
    },
  ];

  return (
    <>
      <Modal
        open={!!rule && !detailId}
        onClose={onClose}
        title={rule ? ruleTitle(rule) : "Rule"}
        width="max-w-[760px]"
        footer={
          <>
            {total > PAGE && (
              <div className="mr-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>
                  Previous
                </Button>
                <span className="text-sm tabular-nums text-muted">
                  {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
                </span>
                <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(o => o + PAGE)}>
                  Next
                </Button>
              </div>
            )}
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </>
        }
      >
        {rule && (
          <div className="space-y-4">
            <p className="text-[15px] leading-relaxed text-ink-2">
              {ruleMatchText(rule)}, so it tags{" "}
              <span className="font-semibold text-ink">{categoryPath(rule.category, rule.subcategory, rule.sub_subcategory)}</span>.
              {data && <> It has tagged {plural(total, "transaction")}. Click one to change it.</>}
            </p>

            {error && !data ? (
              <ErrorCard message="These transactions didn't load. Try again in a moment." onRetry={() => mutate()} />
            ) : isLoading && !data ? (
              <TableSkeleton rows={5} cols={3} />
            ) : total === 0 ? (
              <p className="rounded-m bg-surface px-5 py-8 text-center text-[15px] text-muted">
                Nothing carries this rule&apos;s tag right now. You may have changed them by hand, or a
                higher-priority rule got there first.
              </p>
            ) : (
              <div className="overflow-hidden rounded-m shadow-flat">
                <TxnTable label="Transactions tagged by this rule" rows={txns} columns={columns} onRowOpen={t => setDetailId(t.id)} maxHeight="max-h-[420px]" />
              </div>
            )}
          </div>
        )}
      </Modal>

      <TransactionDetailDrawer txnId={detailId} onClose={() => { setDetailId(null); mutate(); }} />
    </>
  );
}

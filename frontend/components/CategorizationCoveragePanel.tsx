"use client";

/**
 * Categorize-tab coverage dashboard.
 * Data: GET /api/analytics/categorization-progress
 * See docs/CATEGORIZATION.md § Coverage metrics.
 */

import { MetricTile } from "@/components/ui";
import type { CategorizationProgress } from "@/lib/types";
import { inr } from "@/lib/format";

export function CategorizationCoveragePanel({
  data,
}: {
  data: CategorizationProgress | undefined;
}) {
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-muted">
          Transaction coverage
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricTile animate={false} label="Total transactions" value={data.total_transactions} />
          <MetricTile animate={false} label="Tagged" value={data.categorized_transactions} focus={false} />
          <MetricTile animate={false} label="Untagged" value={data.uncategorized_transactions} tone="amber" />
          <MetricTile animate={false}
            label="Coverage"
            value={`${data.coverage_pct}%`}
            hint={`${data.categorized_transactions} ÷ ${data.total_transactions}`}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-muted">
          UPI IDs <span className="font-medium text-faint">(bank handles left out)</span>
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricTile animate={false} label="UPI IDs" value={data.total_vpas} />
          <MetricTile animate={false} label="Fully tagged" value={data.categorized_vpas} focus={false} />
          <MetricTile animate={false} label="Need review" value={data.uncategorized_vpas} tone="amber" />
          <MetricTile animate={false} label="UPI IDs untagged" value={`${data.uncat_vpa_pct}%`} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-muted">
          Merchants and people
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-3">
          <MetricTile animate={false} label="Merchants and people" value={data.total_counterparties} />
          <MetricTile animate={false} label="Fully tagged" value={data.categorized_counterparties} focus={false} />
          <MetricTile animate={false} label="Need review" value={data.uncategorized_counterparties} tone="amber" />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-muted">
          What untagged items add up to
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricTile animate={false} label="Untagged spend" value={inr(data.uncat_expense_amount)} tone="amber" />
          <MetricTile animate={false} label="Untagged income" value={inr(data.uncat_income_amount)} />
          <MetricTile animate={false} label="Untagged, net" value={inr(data.uncat_net_amount)} />
          <MetricTile animate={false}
            label="Share of spend untagged"
            value={`${data.uncat_expense_pct}%`}
            hint={`${inr(data.uncat_expense_amount)} of ${inr(data.total_expense_amount)}`}
          />
        </div>
      </div>

      <p className="text-sm font-medium text-muted">
        Check: tagged ({data.categorized_transactions}) + untagged ({data.uncategorized_transactions}) = total ({data.total_transactions}).
        UPI IDs: {data.categorized_vpas} + {data.uncategorized_vpas} = {data.total_vpas}.
        Merchants and people: {data.categorized_counterparties} + {data.uncategorized_counterparties} = {data.total_counterparties}.
        {data.transactions_no_vpa > 0 && (
          <> {data.transactions_no_vpa.toLocaleString("en-IN")} transactions have no usable UPI ID.</>
        )}
      </p>
    </div>
  );
}

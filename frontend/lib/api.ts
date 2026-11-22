// Thin fetch wrappers + SWR hooks. We hit `/api/*` via the Next rewrite
// configured in next.config.js, so this code works the same in dev and
// behind a reverse proxy in prod.

import useSWR, { SWRResponse, mutate as globalMutate } from "swr";
import { apiPrefix, directApiRoot } from "./dataMode";
import type {
  Account, BalancePoint,   BlinkitAnalyticsSummary, BlinkitBrandRow, BlinkitCategoryRow, BlinkitChargesPeriod,
  BlinkitDiscountAnalytics, BlinkitDrilldownResult, BlinkitExplorerList, BlinkitIngestResult, BlinkitLocationBreakdown,
  BlinkitOrder, BlinkitOrderItem, BlinkitOrderListResp, BlinkitParseError, BlinkitProductRank,
  BlinkitSellerRow, BlinkitShoppingBehavior, BlinkitSpendingPeriod, BlinkitStats, BlinkitStoreRow,
  BlinkitTaxAnalytics,
  CCBillLink, CCPaymentCandidate, CCReconciliationRow,
  CategorizationProgress, CategorizationRule, CategoryInsights, CategoryKind, CategoryNode,
  CategoryRow, CategoryTrendSeries, ConditionTree, CounterpartyGroup, CounterpartyRow, CounterpartySortKey,
  CounterpartySummary, DateRange, EMIPlan, EMIWithSchedule, EnrichedGroup,
  FinancialSnapshot, HeadlineMetrics, IncomeBreakdownRow, IncomeDetail,
  MonthlyCategoryCell, MonthlyRow, MonthlySubcategoryCell, MonthlySummaryRow,
  NetWorthPoint, ReviewQueues, RuleAnalytics,
  RuleApplyTreeResult, RuleConditions, RulePreviewResult, RunEngineResult,
  SankeyData, ExpenseDrilldown, SankeyMode, SavingsDrivers, TagStatusFilter, Taxonomy, Transaction, TransactionDetail, TransactionFilters,
  TransactionListResp, TransferCandidate, UploadHistoryRow, UploadResp,
} from "./types";

export type { DateRange };

// "/api" for your own data, "/demo-api" in test data mode (see lib/dataMode.ts).
// Read at call time so it always follows the current mode.
function base(): string {
  return apiPrefix();
}

/** Direct backend URL for long-running requests (bypasses Next.js dev proxy timeout). */
function directApiBase(): string {
  return `${directApiRoot().replace(/\/$/, "")}/api`;
}

// ---------------------------------------------------------------------------
// Core fetch helpers
// ---------------------------------------------------------------------------

async function http<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(base() + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      detail = j.detail || JSON.stringify(j);
    } catch { /* keep statusText */ }
    throw new Error(`${r.status}: ${detail}`);
  }
  if (r.status === 204) return undefined as unknown as T;
  return (await r.json()) as T;
}

/** Like ``http`` but hits the backend directly with a longer timeout (LLM calls). */
async function httpLongRunning<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 180_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(directApiBase() + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!r.ok) {
      let detail = r.statusText;
      try {
        const j = await r.json();
        detail = j.detail || JSON.stringify(j);
      } catch { /* keep statusText */ }
      throw new Error(`${r.status}: ${detail}`);
    }
    if (r.status === 204) return undefined as unknown as T;
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s — categorization may still be running on the server`);
    }
    if (e instanceof TypeError && String(e.message).includes("fetch")) {
      throw new Error("Could not reach the backend — is uvicorn running on port 8000?");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const fetcher = <T>(p: string) => http<T>(p);

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFiles(
  files: File[],
  options: { password?: string; force_bank?: string } = {},
): Promise<UploadResp> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name);
  if (options.password)   fd.append("password", options.password);
  if (options.force_bank) fd.append("force_bank", options.force_bank);

  const r = await fetch(base() + "/upload", { method: "POST", body: fd });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail; } catch {}
    throw new Error(`${r.status}: ${detail}`);
  }
  return (await r.json()) as UploadResp;
}

export function useUploadHistory(): SWRResponse<UploadHistoryRow[]> {
  return useSWR<UploadHistoryRow[]>("/upload/history", fetcher);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function useTransactions(filters?: TransactionFilters | null) {
  const key = filters
    ? "/transactions" + qs(filters as Record<string, unknown>)
    : null;
  return useSWR<TransactionListResp>(key, fetcher);
}

export function useCounterparties(opts?: {
  /** @deprecated use tag_status */
  only_uncategorized?: boolean;
  tag_status?: TagStatusFilter;
  sort_by?: CounterpartySortKey;
  sort_dir?: "asc" | "desc";
}) {
  const tagStatus = opts?.tag_status
    ?? (opts?.only_uncategorized ? "untagged" : "all");
  const params = qs({
    tag_status: tagStatus === "all" ? undefined : tagStatus,
    sort_by:    opts?.sort_by,
    sort_dir:   opts?.sort_dir,
  });
  return useSWR<CounterpartyGroup[]>(
    "/transactions/counterparties" + params,
    fetcher,
  );
}

// ---------------------------------------------------------------------------
// Bulk "apply to all similar" + Excel categorisation workflow
// ---------------------------------------------------------------------------

export async function bulkApplyCategory(body: {
  kind: "vpa" | "merchant" | "description" | "combined";
  value?: string;
  vpa_value?: string | null;
  merchant_value?: string | null;
  category: string;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  save_rule?: boolean;
}): Promise<{ transactions_updated: number; rule_id: number | null }> {
  return http<{ transactions_updated: number; rule_id: number | null }>(
    "/transactions/bulk-apply",
    {
      method: "POST",
      body: JSON.stringify({ save_rule: true, ...body }),
    },
  );
}

export async function recanonicalizeMerchants(): Promise<{
  transactions_scanned: number;
  merchant_changed: number;
}> {
  return http<{ transactions_scanned: number; merchant_changed: number }>(
    "/rules/recanonicalize",
    { method: "POST" },
  );
}

/** Triggers a browser download of the uncategorised-VPAs workbook. */
export async function downloadUncategorizedExcel(): Promise<void> {
  const r = await fetch(base() + "/rules/export-uncategorized?only_uncategorized=true");
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail; } catch {}
    throw new Error(`${r.status}: ${detail}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "finance-hub-uncategorized.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface CategoryImportError {
  row: number;
  label: string | null;
  error: string;
}

export interface CategoryImportResult {
  rows_read: number;
  rows_applied: number;
  transactions_updated: number;
  rules_created: number;
  errors: CategoryImportError[];
}

export async function importCategorizationSheet(file: File): Promise<CategoryImportResult> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const r = await fetch(base() + "/rules/import", { method: "POST", body: fd });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail; } catch {}
    throw new Error(`${r.status}: ${detail}`);
  }
  return (await r.json()) as CategoryImportResult;
}

export async function patchTransaction(
  id: string,
  body: Partial<{
    category: string | null;
    subcategory: string | null;
    sub_subcategory: string | null;
    is_refund: boolean;
    refund_category: string | null;
    is_internal_transfer: boolean;
    is_credit_card_payment: boolean;
    propagate_via: "vpa" | "merchant" | null;
  }>,
): Promise<Transaction> {
  return http<Transaction>(`/transactions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// VPA / merchant aggregate summary (Categorize-page top panel)
// ---------------------------------------------------------------------------

export function useCounterpartySummary(
  vpa: string | null,
  merchant: string | null,
) {
  const key =
    vpa     ? `/transactions/vpa-summary?vpa=${encodeURIComponent(vpa)}` :
    merchant ? `/transactions/vpa-summary?merchant_name=${encodeURIComponent(merchant)}` :
    null;
  return useSWR<CounterpartySummary>(key, fetcher);
}

// ---------------------------------------------------------------------------
// Single transaction detail (right-hand drawer)
// ---------------------------------------------------------------------------

export function useTransactionDetail(id: string | null) {
  return useSWR<TransactionDetail>(
    id ? `/transactions/${id}/detail` : null,
    fetcher,
  );
}

// ---------------------------------------------------------------------------
// Internal-transfer manual linking
// ---------------------------------------------------------------------------

export async function getTransferCandidates(id: string): Promise<TransferCandidate[]> {
  return http<TransferCandidate[]>(`/transactions/${id}/transfer-candidates`);
}

export async function linkInternalTransfer(id: string, partner_id: string) {
  return http<{ status: string }>(`/transactions/${id}/link-internal-transfer`, {
    method: "POST",
    body: JSON.stringify({ partner_id }),
  });
}

export async function unlinkInternalTransfer(id: string) {
  return http<{ status: string }>(`/transactions/${id}/unlink-internal-transfer`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// CC bill payment mapping
// ---------------------------------------------------------------------------

export async function getCCPaymentCandidates(id: string): Promise<CCPaymentCandidate[]> {
  return http<CCPaymentCandidate[]>(`/transactions/${id}/cc-payment-candidates`);
}

export async function markCCPayment(
  id: string,
  cc_account_name: string,
  billing_month: string,
): Promise<CCBillLink> {
  return http<CCBillLink>(`/transactions/${id}/mark-cc-payment`, {
    method: "POST",
    body: JSON.stringify({ cc_account_name, billing_month }),
  });
}

export async function unlinkCCPayment(id: string) {
  return http<{ status: string }>(`/transactions/${id}/unlink-cc-payment`, {
    method: "POST",
  });
}

export function useCCReconciliation(dr?: DateRange) {
  return useSWR<CCReconciliationRow[]>(
    `/analytics/cc-reconciliation${analyticsQS(dr)}`,
    fetcher,
  );
}

export function useIncomeBreakdown(dr?: DateRange) {
  return useSWR<IncomeBreakdownRow[]>(
    `/analytics/income-breakdown${analyticsQS(dr)}`,
    fetcher,
  );
}

export function useIncomeDetail(dr?: DateRange) {
  return useSWR<IncomeDetail>(
    `/analytics/income-detail${analyticsQS(dr)}`,
    fetcher,
  );
}

export function useMonthlyByCategory(topN = 5, dr?: DateRange) {
  return useSWR<MonthlyCategoryCell[]>(
    `/analytics/monthly-by-category${qs({ top_n: topN, date_from: dr?.date_from, date_to: dr?.date_to })}`,
    fetcher,
  );
}

// ---------------------------------------------------------------------------
// Category taxonomy (3-level)
// ---------------------------------------------------------------------------

export function useTaxonomy(): SWRResponse<Taxonomy> {
  return useSWR<Taxonomy>("/categories", fetcher);
}

export async function createCategoryNode(body: {
  name: string;
  parent_id?: number | null;
  kind?: CategoryKind;
}): Promise<CategoryNode> {
  return http<CategoryNode>("/categories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function renameCategoryNode(
  id: number,
  new_name: string,
): Promise<{ status: string; transactions_updated: number }> {
  return http<{ status: string; transactions_updated: number }>(
    `/categories/${id}/rename`,
    { method: "PATCH", body: JSON.stringify({ new_name }) },
  );
}

export async function archiveCategoryNode(id: number) {
  return http<{ status: string }>(`/categories/${id}/archive`, {
    method: "POST",
  });
}

export async function restoreCategoryNode(id: number) {
  return http<{ status: string }>(`/categories/${id}/restore`, {
    method: "POST",
  });
}

// Triggers SWR refresh after a taxonomy mutation.
export function refreshTaxonomy() {
  globalMutate("/categories");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function useRules(): SWRResponse<CategorizationRule[]> {
  return useSWR<CategorizationRule[]>("/rules", fetcher);
}

export async function upsertRule(body: {
  rule_type: "vpa" | "keyword" | "merchant" | "heuristic";
  rule_value?: string | null;
  category: string;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  name?: string | null;
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  conditions?: RuleConditions | ConditionTree | null;
  propagate?: boolean;
}): Promise<CategorizationRule> {
  return http<CategorizationRule>("/rules", {
    method: "POST",
    body: JSON.stringify({ propagate: true, enabled: true, ...body }),
  });
}

export async function toggleRule(
  id: number,
  enabled: boolean,
): Promise<CategorizationRule> {
  return http<CategorizationRule>(`/rules/${id}/toggle`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteRule(id: number, clear_transactions = false) {
  return http<{ deleted: number; rows_cleared: number }>(
    `/rules/${id}?clear_transactions=${clear_transactions}`,
    { method: "DELETE" },
  );
}

export async function reapplyRules(): Promise<{ rows_updated: number }> {
  return http<{ rows_updated: number }>("/rules/reapply", { method: "POST" });
}

export async function runRuleEngine(): Promise<RunEngineResult> {
  return http<RunEngineResult>("/rules/run-engine", { method: "POST" });
}

export async function reorderRules(ruleIds: number[]): Promise<{ updated: number }> {
  return http<{ updated: number }>("/rules/reorder", {
    method: "POST",
    body: JSON.stringify({ rule_ids: ruleIds }),
  });
}

export async function applyRuleTree(body: {
  name: string;
  conditions: ConditionTree | RuleConditions;
  category: string;
  subcategory?: string | null;
  sub_subcategory?: string | null;
  priority?: number;
  only_uncategorized?: boolean;
  save_rule?: boolean;
}): Promise<RuleApplyTreeResult> {
  return http<RuleApplyTreeResult>("/rules/apply-tree", {
    method: "POST",
    body: JSON.stringify({
      only_uncategorized: true,
      save_rule: true,
      ...body,
    }),
  });
}

export async function previewRule(body: {
  conditions: ConditionTree | RuleConditions;
  limit?: number;
  only_uncategorized?: boolean;
  proposed_category?: string | null;
  proposed_subcategory?: string | null;
}): Promise<RulePreviewResult> {
  return http<RulePreviewResult>("/categorize/preview-rule", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Categorize UI (groups, review queues, analytics)
// ---------------------------------------------------------------------------

export function useCategorizeGroups(kind: "vpa" | "merchant" | "combined") {
  return useSWR<EnrichedGroup[]>(`/categorize/groups?kind=${kind}`, fetcher);
}

export function useReviewQueues(limit = 20) {
  return useSWR<ReviewQueues>(`/categorize/review-queues?limit=${limit}`, fetcher);
}

export function useRuleAnalytics() {
  return useSWR<RuleAnalytics>("/categorize/rule-analytics", fetcher);
}

// ---------------------------------------------------------------------------
// System (admin)
// ---------------------------------------------------------------------------

export interface ResetSummary {
  transactions_deleted: number;
  accounts_deleted:     number;
  emi_records_deleted:  number;
  uploads_deleted:      number;
  rules_preserved:      number;
}

export async function resetSystem(): Promise<ResetSummary> {
  return http<ResetSummary>("/system/reset", { method: "POST" });
}

// ---------------------------------------------------------------------------
// EMI
// ---------------------------------------------------------------------------

export function useEMIPlans(): SWRResponse<EMIPlan[]> {
  return useSWR<EMIPlan[]>("/emi", fetcher);
}

export async function createEMI(body: {
  txn_id: string;
  tenure_months: number;
  start_date?: string;
  note?: string;
}): Promise<EMIWithSchedule> {
  return http<EMIWithSchedule>("/emi", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteEMI(txn_id: string) {
  return http<{ deleted: number }>(`/emi/${txn_id}`, { method: "DELETE" });
}

export function useEMISchedule(txn_id: string | null) {
  return useSWR<EMIWithSchedule>(
    txn_id ? `/emi/${txn_id}/schedule` : null,
    fetcher,
  );
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const analyticsQS = (dr?: DateRange) =>
  qs({ date_from: dr?.date_from, date_to: dr?.date_to });

export const useAccounts     = () => useSWR<Account[]>("/analytics/accounts", fetcher);
export const useHeadline     = (dr?: DateRange) =>
  useSWR<HeadlineMetrics>(`/analytics/headline${analyticsQS(dr)}`, fetcher);
export const useFinancialSnapshot = (dr?: DateRange) =>
  useSWR<FinancialSnapshot>(`/analytics/snapshot${analyticsQS(dr)}`, fetcher);
export const useMonthly      = (dr?: DateRange) =>
  useSWR<MonthlyRow[]>(`/analytics/monthly${analyticsQS(dr)}`, fetcher);
export const useCategories   = (dr?: DateRange) =>
  useSWR<CategoryRow[]>(`/analytics/categories${analyticsQS(dr)}`, fetcher);
export const useBalanceTrend = (dr?: DateRange) =>
  useSWR<BalancePoint[]>(`/analytics/balance-trend${analyticsQS(dr)}`, fetcher);
export const useNetWorth     = (dr?: DateRange) =>
  useSWR<NetWorthPoint[]>(`/analytics/net-worth${analyticsQS(dr)}`, fetcher);
export const useTopCounterparties = (limit = 20, dr?: DateRange) =>
  useSWR<CounterpartyRow[]>(
    `/analytics/counterparties${qs({ limit, date_from: dr?.date_from, date_to: dr?.date_to })}`,
    fetcher,
  );
export const useProgress = (dr?: DateRange) =>
  useSWR<CategorizationProgress>(
    `/analytics/categorization-progress${analyticsQS(dr)}`,
    fetcher,
  );

export const useSankey = (
  dr?: DateRange,
  opts?: { mode?: SankeyMode; expanded?: string[] },
) =>
  useSWR<SankeyData>(
    `/analytics/sankey${qs({
      date_from: dr?.date_from,
      date_to: dr?.date_to,
      mode: opts?.mode ?? "timeline",
      expanded: opts?.expanded?.length ? opts.expanded.join(",") : undefined,
    })}`,
    fetcher,
  );

export function useMonthlySummary(dr?: DateRange) {
  return useSWR<MonthlySummaryRow[]>(
    `/analytics/monthly-summary${analyticsQS(dr)}`,
    fetcher,
  );
}

export function useCategoryTrends(topN = 15, dr?: DateRange) {
  return useSWR<CategoryTrendSeries>(
    `/analytics/category-trends${qs({ top_n: topN, date_from: dr?.date_from, date_to: dr?.date_to })}`,
    fetcher,
  );
}

export function useMonthlyBySubcategory(category: string | null, dr?: DateRange) {
  return useSWR<MonthlySubcategoryCell[]>(
    category
      ? `/analytics/monthly-by-subcategory${qs({ category, date_from: dr?.date_from, date_to: dr?.date_to })}`
      : null,
    fetcher,
  );
}

export function useCategoryInsights(dr?: DateRange) {
  return useSWR<CategoryInsights>(
    `/analytics/category-insights${analyticsQS(dr)}`,
    fetcher,
  );
}

export function useSavingsDrivers(dr?: DateRange, period?: string | null) {
  return useSWR<SavingsDrivers>(
    `/analytics/savings-drivers${qs({ period: period ?? undefined, date_from: dr?.date_from, date_to: dr?.date_to })}`,
    fetcher,
  );
}

export function useExpenseDrilldown(
  dr: DateRange | undefined,
  params: { category: string; subcategory?: string; counterparty?: string } | null,
) {
  const key = params
    ? `/analytics/expense-drilldown${qs({
        category: params.category,
        subcategory: params.subcategory,
        counterparty: params.counterparty,
        date_from: dr?.date_from,
        date_to: dr?.date_to,
      })}`
    : null;
  return useSWR<ExpenseDrilldown>(key, fetcher);
}

export const useAnalyticsReviewQueues = (limit = 15, dr?: DateRange) =>
  useSWR<ReviewQueues>(
    `/analytics/review-queues${qs({ limit, date_from: dr?.date_from, date_to: dr?.date_to })}`,
    fetcher,
  );

// ---------------------------------------------------------------------------
// Cache invalidation helpers — call after a mutation
// ---------------------------------------------------------------------------

export function invalidateAll() {
  // SWR matches keys by exact string by default; ours all start with '/'.
  // Trigger a global revalidation by re-fetching everything cached.
  globalMutate(
    (key) => typeof key === "string" && key.startsWith("/"),
    undefined,
    { revalidate: true },
  );
}

// ---------------------------------------------------------------------------
// Blinkit order invoices
// ---------------------------------------------------------------------------

export async function blinkitScan(directory?: string): Promise<BlinkitIngestResult> {
  const q = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  return http<BlinkitIngestResult>(`/blinkit/scan${q}`, { method: "POST" });
}

export async function blinkitReprocessAll(directory?: string): Promise<BlinkitIngestResult> {
  const q = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  return http<BlinkitIngestResult>(`/blinkit/reprocess${q}`, { method: "POST" });
}

export async function blinkitUpload(file: File): Promise<BlinkitIngestResult> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const r = await fetch(base() + "/blinkit/upload", { method: "POST", body: fd });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail; } catch {}
    throw new Error(`${r.status}: ${detail}`);
  }
  return (await r.json()) as BlinkitIngestResult;
}

export function useBlinkitStats() {
  return useSWR<BlinkitStats>("/blinkit/stats", fetcher);
}

export function useBlinkitOrders(opts?: { q?: string; limit?: number; offset?: number }) {
  const key = `/blinkit/orders${qs({
    q: opts?.q,
    limit: opts?.limit ?? 200,
    offset: opts?.offset ?? 0,
  })}`;
  return useSWR<BlinkitOrderListResp>(key, fetcher);
}

export function useBlinkitItems(limit = 500) {
  return useSWR<BlinkitOrderItem[]>(`/blinkit/items?limit=${limit}`, fetcher);
}

export function useBlinkitErrors() {
  return useSWR<BlinkitParseError[]>("/blinkit/errors", fetcher);
}

const blinkitQS = (dr?: DateRange, extra?: Record<string, unknown>) =>
  qs({ date_from: dr?.date_from, date_to: dr?.date_to, ...extra });

export async function blinkitCategorize(opts?: { refresh?: boolean; force_reclassify?: boolean }) {
  return httpLongRunning<{
    products_processed: number; products_new: number; items_updated: number;
    llm_used: number; skipped_manual: number; ai_enabled: boolean;
  }>(`/blinkit/categorize${qs({
    refresh: opts?.refresh,
    force_reclassify: opts?.force_reclassify,
  })}`, { method: "POST" });
}

export interface CategorizationJobMetrics {
  requests_sent: number;
  requests_ok: number;
  requests_failed: number;
  retries: number;
  rate_limit_waits: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tokens_estimated: boolean;
}

export interface CategorizationJobSummary {
  total_processed: number;
  newly_categorized: number;
  already_skipped: number;
  recategorized: number;
  failed: number;
  items_updated: number;
  rules_categorized: number;
}

export interface ApiErrorEntry {
  batch: number;
  code: number | null;
  message: string;
  timestamp: string;
  products_affected: number;
}

export interface CategorizationJob {
  job_id: string;
  mode: string;
  status: string;
  phase: string;
  cancel_requested: boolean;
  total_products: number;
  completed_products: number;
  progress_pct: number;
  current_batch: number;
  total_batches: number;
  activity_log: string[];
  metrics: CategorizationJobMetrics;
  summary: CategorizationJobSummary;
  failed_products: string[];
  failure_reason: string | null;
  last_api_error: string | null;
  last_api_error_code: number | null;
  api_errors: ApiErrorEntry[];
  error: string | null;
  elapsed_s: number;
  eta_s: number | null;
  throughput_per_min: number;
  avg_s_per_product: number;
  ai_model: string | null;
}

export async function startCategorizationJob(
  mode: "unclassified" | "reclassify_all",
): Promise<CategorizationJob> {
  return httpLongRunning<CategorizationJob>("/blinkit/categorize/jobs", {
    method: "POST",
    body: JSON.stringify({ mode }),
  }, 15_000);
}

export async function getCategorizationJob(jobId: string): Promise<CategorizationJob> {
  return http<CategorizationJob>(`/blinkit/categorize/jobs/${jobId}`);
}

export async function getActiveCategorizationJob(): Promise<CategorizationJob | null> {
  return http<CategorizationJob | null>("/blinkit/categorize/jobs/active");
}

export async function cancelCategorizationJob(jobId?: string): Promise<CategorizationJob | null> {
  if (jobId) {
    return http<CategorizationJob>(`/blinkit/categorize/jobs/${jobId}/cancel`, { method: "POST" });
  }
  return http<CategorizationJob | null>("/blinkit/categorize/jobs/cancel", { method: "POST" });
}

// ---------------------------------------------------------------------------
// App configuration (API keys)
// ---------------------------------------------------------------------------

export interface GeminiModelOption {
  id: string;
  label: string;
  hint: string;
}

export interface AppConfig {
  gemini: {
    configured: boolean;
    masked: string | null;
    model: string;
    source: "db" | "env" | "none";
  };
  ai_categorization_enabled: boolean;
  gemini_models: GeminiModelOption[];
  default_gemini_model: string;
  gemini_llm?: {
    model: string;
    requests_per_minute: number;
    tokens_per_minute: number;
    delay_between_requests_ms: number;
    max_retries: number;
    retry_backoff_base_s: number;
    batch_size: number;
    temperature: number;
    max_output_tokens: number;
    prompt_version: string;
    category_version: string;
  };
}

export function useAppConfig() {
  return useSWR<AppConfig>("/config", fetcher);
}

export async function updateAppConfig(body: {
  gemini_api_key?: string;
  gemini_model?: string;
  clear_gemini_api_key?: boolean;
  gemini_rpm?: number;
  gemini_tpm?: number;
  gemini_delay_ms?: number;
  gemini_max_retries?: number;
  gemini_retry_backoff_s?: number;
  gemini_batch_size?: number;
  gemini_temperature?: number;
  gemini_max_output_tokens?: number;
}): Promise<AppConfig> {
  return http<AppConfig>("/config", { method: "PUT", body: JSON.stringify(body) });
}

export async function testGeminiConnection(opts?: {
  api_key?: string;
  model?: string;
}): Promise<{ ok: boolean; message: string; model?: string }> {
  return http("/config/test-gemini", {
    method: "POST",
    body: JSON.stringify(opts ?? {}),
  });
}

export function useBlinkitAnalyticsSummary(dr?: DateRange) {
  return useSWR<BlinkitAnalyticsSummary>(`/blinkit/analytics/summary${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitSpendingOverTime(dr?: DateRange, granularity = "month") {
  return useSWR<BlinkitSpendingPeriod[]>(
    `/blinkit/analytics/spending-over-time${blinkitQS(dr, { granularity })}`, fetcher,
  );
}

export function useBlinkitCategoryAnalytics(dr?: DateRange) {
  return useSWR<BlinkitCategoryRow[]>(`/blinkit/analytics/categories${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitSubcategoryAnalytics(dr?: DateRange, category?: string | null) {
  const key = category
    ? `/blinkit/analytics/subcategories${blinkitQS(dr, { category })}`
    : `/blinkit/analytics/subcategories${blinkitQS(dr)}`;
  return useSWR<Array<{
    subcategory: string; category: string; total_spend: number;
    order_count: number; product_count: number; pct_of_category?: number;
  }>>(key, fetcher);
}

export function useBlinkitCategoryTrend(dr?: DateRange) {
  return useSWR<Array<{ period: string; category: string; spend: number }>>(
    `/blinkit/analytics/category-trend${blinkitQS(dr)}`, fetcher,
  );
}

export function useBlinkitStackedMonthly(dr?: DateRange) {
  return useSWR<Array<Record<string, number | string>>>(
    `/blinkit/analytics/stacked-monthly${blinkitQS(dr)}`, fetcher,
  );
}

export function useBlinkitDrilldownSummary(
  dr: DateRange | undefined,
  params: Omit<BlinkitDrilldownParams, "tab" | "q" | "sort_by" | "sort_dir" | "limit" | "offset"> | null,
) {
  const key = params
    ? `/blinkit/analytics/drilldown/summary${blinkitQS(dr, params as Record<string, unknown>)}`
    : null;
  return useSWR<{
    dimension: string; value: string | null; total_spend: number; item_spend: number;
    total_orders: number; total_products: number; total_items: number; avg_order_value: number;
  }>(key, fetcher);
}

export function useBlinkitProductsInCategory(dr?: DateRange, category?: string | null, subcategory?: string | null) {
  const key = category
    ? `/blinkit/analytics/drilldown/products-in-category${blinkitQS(dr, { category, subcategory })}`
    : null;
  return useSWR<Array<{
    product_name: string; category: string; subcategory: string;
    total_spend: number; total_quantity: number; times_purchased: number;
  }>>(key, fetcher);
}

export function useBlinkitProductRankings(dr?: DateRange, sortBy = "spend") {
  return useSWR<BlinkitProductRank[]>(
    `/blinkit/analytics/products${blinkitQS(dr, { limit: 20, sort_by: sortBy })}`, fetcher,
  );
}

export function useBlinkitStoreAnalytics(dr?: DateRange) {
  return useSWR<BlinkitStoreRow[]>(`/blinkit/analytics/stores${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitSellerAnalytics(dr?: DateRange) {
  return useSWR<BlinkitSellerRow[]>(`/blinkit/analytics/sellers${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitLocationAnalytics(dr?: DateRange) {
  return useSWR<BlinkitLocationBreakdown>(`/blinkit/analytics/locations${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitChargesOverTime(dr?: DateRange) {
  return useSWR<BlinkitChargesPeriod[]>(`/blinkit/analytics/charges-over-time${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitDiscountAnalytics(dr?: DateRange) {
  return useSWR<BlinkitDiscountAnalytics>(`/blinkit/analytics/discounts${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitTaxAnalytics(dr?: DateRange) {
  return useSWR<BlinkitTaxAnalytics>(`/blinkit/analytics/taxes${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitBrandAnalytics(dr?: DateRange) {
  return useSWR<BlinkitBrandRow[]>(`/blinkit/analytics/brands${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitInsights(dr?: DateRange) {
  return useSWR<{ insights: string[] }>(`/blinkit/analytics/insights${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitBehavior(dr?: DateRange) {
  return useSWR<BlinkitShoppingBehavior>(`/blinkit/analytics/behavior${blinkitQS(dr)}`, fetcher);
}

export function useBlinkitOrderBuckets(dr?: DateRange) {
  return useSWR<{ bucket: string; count: number }[]>(
    `/blinkit/analytics/order-buckets${blinkitQS(dr)}`, fetcher,
  );
}

export function useBlinkitExplorer(
  dr?: DateRange,
  opts?: { q?: string; sort_by?: string; sort_dir?: string; limit?: number; offset?: number },
) {
  const key = `/blinkit/explorer${blinkitQS(dr, {
    q: opts?.q, sort_by: opts?.sort_by ?? "invoice_date",
    sort_dir: opts?.sort_dir ?? "desc", limit: opts?.limit ?? 50, offset: opts?.offset ?? 0,
  })}`;
  return useSWR<BlinkitExplorerList>(key, fetcher);
}

export function blinkitExplorerExportUrl(dr?: DateRange, q?: string) {
  return `${base()}/blinkit/explorer/export${blinkitQS(dr, { q })}`;
}

export function useBlinkitOrderDetail(id: number | null) {
  return useSWR<BlinkitOrder>(id ? `/blinkit/orders/${id}` : null, fetcher);
}

export function useBlinkitProductDetail(name: string | null, dr?: DateRange) {
  const key = name
    ? `/blinkit/analytics/products/detail${blinkitQS(dr, { name })}`
    : null;
  return useSWR<{
    product_name: string; category: string; subcategory?: string | null;
    categorization_source?: string; ai_categorized?: boolean;
    ai_model?: string | null; ai_categorized_at?: string | null;
    total_spend: number; total_quantity: number; times_purchased: number;
    purchase_history: Array<Record<string, unknown>>;
    stores: Array<{ store_name: string; spend: number }>;
  }>(key, fetcher);
}

export interface BlinkitDrilldownParams {
  dimension: string;
  value?: string;
  tab?: "orders" | "products";
  charge_type?: string;
  discounted_only?: boolean;
  tax_only?: boolean;
  category_filter?: string;
  q?: string;
  sort_by?: string;
  sort_dir?: string;
  limit?: number;
  offset?: number;
}

export function useBlinkitDrilldown(
  dr: DateRange | undefined,
  params: BlinkitDrilldownParams | null,
) {
  const key = params
    ? `/blinkit/analytics/drilldown${blinkitQS(dr, {
        dimension: params.dimension,
        value: params.value,
        tab: params.tab ?? "orders",
        charge_type: params.charge_type,
        discounted_only: params.discounted_only || undefined,
        tax_only: params.tax_only || undefined,
        category_filter: params.category_filter,
        q: params.q,
        sort_by: params.sort_by ?? "invoice_date",
        sort_dir: params.sort_dir ?? "desc",
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      })}`
    : null;
  return useSWR<BlinkitDrilldownResult>(key, fetcher);
}

export function blinkitDrilldownExportUrl(
  dr: DateRange | undefined,
  params: BlinkitDrilldownParams,
) {
  return `${base()}/blinkit/analytics/drilldown/export${blinkitQS(dr, {
    dimension: params.dimension,
    value: params.value,
    tab: params.tab ?? "orders",
    charge_type: params.charge_type,
    discounted_only: params.discounted_only || undefined,
    tax_only: params.tax_only || undefined,
    q: params.q,
  })}`;
}

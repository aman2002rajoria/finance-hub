// Mirror of the Pydantic schemas in backend/api/schemas.py.
// Kept in sync manually — when you change a schema there, update here.

export type AccountType = "savings" | "credit_card";
export type TxnType = "debit" | "credit";
export type RuleType = "vpa" | "keyword" | "merchant" | "heuristic";

// `categorization_source` values stamped on every transaction by the
// rule engine / manual flow. Drives the small audit chip in the UI.
export type CategorizationSource =
  | "manual"
  | "excel_import"
  | "vpa_mapping"
  | "merchant_mapping"
  | "keyword_rule"
  | "rule_engine"
  | "auto_income"
  | "ai";

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  display_name: string;
}

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  type: TxnType;
  balance: number | null;
  account_type: AccountType;
  account_name: string;
  reference_id: string | null;
  raw_text: string | null;
  vpa: string | null;
  merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
  is_refund: boolean;
  refund_category: string | null;
  is_internal_transfer: boolean;
  is_credit_card_payment: boolean;
  is_emi: boolean;
  linked_transaction_id: string | null;
  emi_id: number | null;
  txn_mode: string | null;
  txn_time: string | null;
  categorization_source: CategorizationSource | null;
  categorized_by_rule_id: number | null;
  categorized_by_rule_name: string | null;
  source_file: string | null;
}

export interface TransactionListResp {
  transactions: Transaction[];
  total: number;
}

export interface CategorizationRule {
  id: number;
  rule_type: RuleType;
  rule_value: string;
  category: string;
  subcategory: string | null;
  sub_subcategory: string | null;
  name: string | null;
  description: string | null;
  enabled: boolean;
  is_system: boolean;
  priority: number;
  conditions: RuleConditions | null;
  transactions_categorized?: number;
  created_at: string;
  updated_at: string;
}

// JSON-shape of CategorizationRule.conditions_json for heuristic rules.
// Legacy flat format (no version) OR v2 condition tree — see docs/RULE_ENGINE.md.
export interface RuleConditions {
  version?: 2;
  logic?: "and" | "or";
  items?: (RuleCondition | RuleConditionGroup)[];
  type?: TxnType;
  txn_mode?: string | string[];
  account_type?: AccountType;
  amount?: { min?: number; max?: number };
  day_of_week?: string[];
  time_of_day?: { start?: string; end?: string; strict?: boolean };
  description_contains?: string;
  vpa_contains?: string;
  merchant_contains?: string;
}

export interface RuleCondition {
  type: "condition";
  id?: string;
  field: string;
  op: string;
  value?: string | number;
  value2?: string | number;
}

export interface RuleConditionGroup {
  type: "group";
  id?: string;
  logic: "and" | "or";
  items: (RuleCondition | RuleConditionGroup)[];
}

export type ConditionTree = {
  version: 2;
  logic: "and" | "or";
  items: (RuleCondition | RuleConditionGroup)[];
};

export interface EnrichedGroup {
  key: string;
  label: string;
  kind: "vpa" | "merchant" | "combined";
  txn_count: number;
  total_amount: number;
  expense_amount: number;
  income_amount: number;
  uncategorized_count: number;
  has_category: boolean;
  top_category: string | null;
}

/** Sort keys for Categorize tab group tables (By VPA / Counterparty / Combined). */
export type GroupSortKey =
  | "label"
  | "txn_count"
  | "total_amount"
  | "expense_amount"
  | "income_amount"
  | "uncategorized_count";

/** Filter groups by dominant cash-flow direction. */
export type GroupFlowFilter = "all" | "expense" | "income";

export interface ReviewQueueItem {
  label: string;
  amount: number;
  txn_count: number;
}

export interface ReviewQueues {
  top_vpas: ReviewQueueItem[];
  top_counterparties: ReviewQueueItem[];
  top_descriptions: ReviewQueueItem[];
}

export interface RulePreviewTxn {
  id: string;
  date: string | null;
  description: string;
  amount: number;
  type: TxnType;
  merchant_name: string | null;
  vpa: string | null;
  category: string | null;
  subcategory: string | null;
  proposed_category?: string | null;
  proposed_subcategory?: string | null;
}

export interface RulePreviewResult {
  match_count: number;
  total_amount: number;
  expense_amount: number;
  income_amount: number;
  transactions: RulePreviewTxn[];
  rows_evaluated?: number;
  rows_skipped_tagged?: number;
  rows_total?: number;
  only_uncategorized?: boolean;
  dataset_scope?: string;
}

export interface RuleAnalytics {
  total_rules: number;
  active_rules: number;
  disabled_rules: number;
  transactions_by_rules: number;
  transactions_manual: number;
  transactions_auto_other: number;
}

export interface RuleApplyTreeResult {
  rule_id: number | null;
  transactions_updated: number;
  skipped_manual: number;
}

export interface RunEngineResult {
  scanned: number;
  matched: number;
  cleared?: number;
  by_source: Record<string, number>;
}

export interface EMIPlan {
  id: number;
  original_transaction_id: string;
  total_amount: number;
  tenure_months: number;
  monthly_amount: number;
  start_date: string;
  note: string | null;
}

export interface EMIInstalment {
  period: string;
  amount: number;
  emi_id: number;
  original_transaction_id: string;
}

export interface EMIWithSchedule {
  plan: EMIPlan;
  schedule: EMIInstalment[];
}

export interface UploadResult {
  filename: string;
  bank: string | null;
  account_name: string | null;
  pages_parsed: number;
  parsed_count: number;
  new_count: number;
  duplicate_count: number;
  cc_payments_tagged: number;
  rules_applied: number;
  income_autotagged: number;
  skipped_already_uploaded: boolean;
  errors: string[];
  warnings: string[];
}

export interface UploadResp {
  results: UploadResult[];
}

export interface UploadHistoryRow {
  id: number;
  filename: string;
  bank: string;
  txn_count: number;
  new_txn_count: number;
  pages_parsed: number;
  uploaded_at: string;
  notes: string | null;
}

export interface HeadlineMetrics {
  total_txns: number;
  total_spend: number;
  total_income: number;
  net: number;
  savings_rate_pct: number;
  spend_excluding_emi: number;
  spend_from_emi: number;
  internal_transfers: number;
  credit_card_payments: number;
  emi_transactions: number;
}

/** Shared date window for all analytics (ISO yyyy-mm-dd). */
export interface DateRange {
  date_from?: string;
  date_to?: string;
}

export interface CashFlowSnapshot {
  money_in: number;
  money_out: number;
  net: number;
}

export interface PersonalEconomicsSnapshot {
  true_income: number;
  income_by_source: IncomeDetailRow[];
  refunds_recoveries: number;
  gross_expenses: number;
  refunds_applied: number;
  net_personal_spend: number;
  savings: number;
  savings_rate_pct: number;
}

export interface MonthlyAveragesSnapshot {
  months: number;
  avg_income: number;
  avg_spend: number;
  avg_saving: number;
  avg_saving_rate_pct: number;
}

export interface ExcludedFlowsSnapshot {
  internal_transfers: number;
  credit_card_payments: number;
  emi_transactions: number;
}

export interface FinancialSnapshot {
  total_txns: number;
  cash_flow: CashFlowSnapshot;
  personal_economics: PersonalEconomicsSnapshot;
  monthly_averages: MonthlyAveragesSnapshot;
  excluded: ExcludedFlowsSnapshot;
}

export interface MonthlyRow {
  period: string;
  spend: number;
  income: number;
  net: number;
}

export interface CategoryRow {
  category: string;
  amount: number;
  txn_count: number;
}

export interface BalancePoint {
  date: string;
  account_name: string;
  balance: number;
}

export interface NetWorthPoint {
  date: string;
  net_worth: number;
}

export interface CounterpartyRow {
  counterparty: string;
  amount: number;
  txn_count: number;
}

export interface CategorizationProgress {
  total_transactions: number;
  categorized_transactions: number;
  uncategorized_transactions: number;
  coverage_pct: number;
  total_vpas: number;
  categorized_vpas: number;
  uncategorized_vpas: number;
  uncat_vpa_pct: number;
  total_counterparties: number;
  categorized_counterparties: number;
  uncategorized_counterparties: number;
  uncat_expense_amount: number;
  uncat_income_amount: number;
  uncat_net_amount: number;
  total_expense_amount: number;
  uncat_expense_pct: number;
  /** @deprecated use uncategorized_transactions */
  uncategorized_txns: number;
  transactions_no_vpa: number;
}

export interface CounterpartyGroup {
  key: string;
  label: string;
  kind: "vpa" | "merchant" | "unmatched";
  txn_count: number;
  total_amount: number;
  total_debit: number;
  total_credit: number;
  net_amount: number;
  uncategorized_count: number;
  has_category: boolean;
  last_date: string | null;
}

export type CounterpartySortKey =
  | "txn_count"
  | "total_debit"
  | "total_credit"
  | "net_amount"
  | "uncategorized_count"
  | "total_amount"
  | "label"
  | "last_date";

/** Filter counterparties or drill-down transactions by category tag state. */
export type TagStatusFilter = "all" | "tagged" | "untagged";

export type TransactionSortKey = "date" | "amount" | "description" | "category" | "account";

// ---------- New v3 types (advanced linking + reconciliation) ----------

export interface CounterpartySummary {
  label: string;
  kind: "vpa" | "merchant";
  total_credit: number;
  total_debit: number;
  net: number;
  transaction_count: number;
  first_date: string | null;
  last_date: string | null;
}

export interface TransferCandidate {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: TxnType;
  account_name: string;
  amount_diff: number;
  day_diff: number;
}

export interface CCPaymentCandidate {
  cc_account_name: string;
  billing_month: string;
  total_amount: number;
}

export interface CCBillLink {
  id: number;
  savings_txn_id: string;
  cc_account_name: string;
  billing_month: string;
  total_amount: number;
}

export interface TransactionDetail {
  transaction: Transaction;
  linked_transaction: Transaction | null;
  cc_bill_link: CCBillLink | null;
}

export interface CCReconciliationRow {
  cc_account_name: string;
  billing_month: string;
  spend: number;
  paid: number;
  difference: number;
  txn_count: number;
  paid_known: boolean;
}

// ---------- Category taxonomy (v3) ----------

export type CategoryKind = "expense" | "income";

export interface CategoryNode {
  id: number;
  name: string;
  level: 1 | 2 | 3;
  kind: CategoryKind;
  archived: boolean;
  sort_order: number;
  children: CategoryNode[];
}

export interface Taxonomy {
  expense: CategoryNode[];
  income: CategoryNode[];
}

// ---------- Analytics v3 ----------

export interface IncomeBreakdownRow {
  category: string;
  subcategory: string | null;
  amount: number;
  txn_count: number;
}

export interface MonthlyCategoryCell {
  period: string;
  category: string;
  amount: number;
  pct_of_month: number;
}

// Rich income dashboard payload (GET /api/analytics/income-detail).
export interface IncomeDetailRow {
  subcategory: string;
  amount: number;
  txn_count: number;
}
export interface RefundDetailRow {
  category: string;
  amount: number;
  txn_count: number;
}

export interface RefundTypeRow {
  refund_type: string;
  amount: number;
  txn_count: number;
}

export interface IncomeMonthlyPoint {
  period: string;
  subcategory: string;
  amount: number;
}

export interface IncomeDetail {
  total_income: number;
  total_refunds: number;
  by_subcategory: IncomeDetailRow[];
  refunds_by_category: RefundDetailRow[];
  refunds_by_type: RefundTypeRow[];
  monthly_trend: IncomeMonthlyPoint[];
}

export const REFUND_SUBTYPES = [
  "Shared Expense Recovery",
  "Merchant Refund",
  "Reimbursement",
  "Other",
] as const;

export interface SankeyNode {
  id: string;
  label: string;
  layer: number;
  amount: number;
  parent_id?: string | null;
  depth?: number;
  expandable?: boolean;
  expanded?: boolean;
  period?: string | null;
  node_type?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  link_type?: "flow" | "carry" | "tree" | string;
  balance_amount?: number;
  period_from?: string;
  period_to?: string;
}

export interface SankeyMonthlyReconciliation {
  period: string;
  opening_balance: number;
  closing_balance: number;
  cash_in: number;
  cash_out: number;
  total_income?: number;
  total_expense?: number;
  true_income?: number;
  gross_expenses?: number;
  savings: number;
  carry_forward?: number;
  conservation_error: number;
  carry_forward_error?: number;
}

export interface SankeyReconciliation {
  opening_balance: number;
  closing_balance: number;
  cash_in?: number;
  cash_out?: number;
  total_income?: number;
  total_expense?: number;
  true_income: number;
  refunds_recoveries: number;
  net_personal_spend: number;
  gross_expenses: number;
  savings: number;
  inflow_to_available: number;
  outflow_from_available: number;
  conservation_error: number;
  flow_conservation_error?: number;
  balance_delta: number;
  balance_reconciliation_error?: number;
  max_carry_forward_error?: number;
}

export type SankeyMode = "period" | "monthly" | "timeline";

export interface SankeyData {
  mode: SankeyMode;
  nodes: SankeyNode[];
  links: SankeyLink[];
  expanded: string[];
  periods: string[];
  savings_definition: string;
  expand_path?: string[];
  reconciliation: SankeyReconciliation;
  monthly_reconciliation?: SankeyMonthlyReconciliation[];
}

export interface ExpenseDrilldownRow {
  label: string;
  amount: number;
  txn_count?: number;
  id?: string;
  date?: string;
}

export interface ExpenseDrilldown {
  level: "subcategory" | "counterparty" | "transactions" | string;
  category: string;
  subcategory?: string | null;
  counterparty?: string | null;
  total: number;
  rows: ExpenseDrilldownRow[];
}

export interface MonthlySummaryRow {
  period: string;
  opening_balance: number;
  total_income: number;
  total_expense: number;
  net_savings: number;
  savings_rate_pct: number;
  closing_balance: number;
  mom_savings_change: number | null;
  mom_savings_change_pct: number | null;
  is_best_savings_month: boolean;
  is_worst_savings_month: boolean;
}

export interface MonthlySubcategoryCell {
  period: string;
  subcategory: string;
  amount: number;
}

export interface CategoryInsightItem {
  kind: string;
  title: string;
  label: string;
  value: number;
  unit: "percent" | "amount" | string;
  amount_delta?: number | null;
}

export interface CategoryInsights {
  insights: CategoryInsightItem[];
  periods: string[];
}

export interface SavingsDriverItem {
  label: string;
  category: string;
  spend_delta: number;
  current_spend: number;
  previous_spend: number;
  driver_type?: "income" | "expense" | string;
}

export interface SavingsDrivers {
  period: string | null;
  comparison_period: string | null;
  delta_savings: number;
  current_savings: number;
  previous_savings: number;
  income_delta: number;
  direction: "improved" | "declined" | "flat" | string;
  drivers: SavingsDriverItem[];
}

export interface CategoryTrendSeries {
  categories: string[];
  cells: MonthlyCategoryCell[];
}

export interface TransactionFilters {
  account_name?: string;
  account_type?: AccountType;
  type?: TxnType;
  category?: string;
  subcategory?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  is_internal?: boolean;
  is_cc_payment?: boolean;
  is_emi?: boolean;
  uncategorized?: boolean;
  tag_status?: TagStatusFilter;
  vpa?: string;
  merchant_name?: string;
  categorized_by_rule_id?: number;
  sort_by?: TransactionSortKey;
  sort_dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Blinkit order invoices (v2 — normalized orders / order-items schema)
// ---------------------------------------------------------------------------

export interface BlinkitIngestResult {
  files_processed: number;
  orders_new: number;
  orders_skipped: number;
  items_new: number;
  errors: string[];
  warnings: string[];
}

export interface BlinkitStats {
  order_count: number;
  item_count: number;
  distinct_order_ids: number;
  error_count: number;
  files_scanned: number;
  total_spend: number;
  total_item_spend: number;
  total_fees: number;
  invoice_directory: string;
}

export type BlinkitLineType =
  | "product"
  | "delivery_charge"
  | "handling_charge"
  | "convenience_charge"
  | "packaging_charge"
  | "other_charge";

export interface BlinkitOrderItem {
  id: number;
  order_row_id: number;
  order_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  sr_no: number | null;
  upc: string | null;
  hsn_code: string | null;
  product_name: string;
  brand: string | null;
  variant: string | null;
  size_weight: string | null;
  packaging: string | null;
  category: string | null;
  mrp: number | null;
  selling_price: number | null;
  discount: number | null;
  quantity: number | null;
  taxable_value: number | null;
  cgst_pct: number | null;
  cgst_inr: number | null;
  sgst_pct: number | null;
  sgst_inr: number | null;
  igst_pct: number | null;
  igst_inr: number | null;
  cess_pct: number | null;
  additional_cess_val: number | null;
  total_amount: number | null;
  line_type: BlinkitLineType;
}

export interface BlinkitAnnexureCharge {
  id: number;
  sr_no: number | null;
  nature_of_charge: string;
  tax_rate: number | null;
  cess_rate: number | null;
  taxable_value: number | null;
  cgst: number | null;
  sgst: number | null;
  cess: number | null;
}

export interface BlinkitOrder {
  id: number;
  invoice_number: string;
  order_id: string | null;
  invoice_date: string | null;
  order_date: string | null;
  delivery_date: string | null;
  place_of_supply: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_city: string | null;
  delivery_state: string | null;
  delivery_pincode: string | null;
  seller_name: string | null;
  seller_gstin: string | null;
  seller_fssai: string | null;
  store_name: string | null;
  store_address: string | null;
  store_state: string | null;
  store_pincode: string | null;
  store_gstin: string | null;
  item_total: number | null;
  delivery_fee: number | null;
  handling_charge: number | null;
  convenience_fee: number | null;
  packaging_charge: number | null;
  other_charges: number | null;
  discount_total: number | null;
  cgst_total: number | null;
  sgst_total: number | null;
  tax_total: number | null;
  grand_total: number | null;
  amount_paid: number | null;
  amount_in_words: string | null;
  payment_method: string | null;
  has_annexure: boolean;
  is_continuation_merged: boolean;
  source_file: string | null;
  page_number: number | null;
  items: BlinkitOrderItem[];
  annexure_charges: BlinkitAnnexureCharge[];
}

export interface BlinkitOrderListResp {
  orders: BlinkitOrder[];
  total: number;
}

export interface BlinkitParseError {
  id: number;
  source_file: string;
  page: number | null;
  stage: string;
  reason: string;
  snippet: string | null;
  created_at: string;
}

// Blinkit analytics
export interface BlinkitAnalyticsSummary {
  total_spend: number;
  total_orders: number;
  distinct_order_ids: number;
  total_items: number;
  total_quantity: number;
  avg_order_value: number;
  max_order_value: number;
  min_order_value: number;
  total_discount: number;
  avg_discount_per_order: number;
  discount_pct: number;
  total_delivery_charges: number;
  total_handling_charges: number;
  total_convenience_charges: number;
  total_taxes: number;
  charges_pct_of_spend: number;
  unique_products: number;
  unique_categories: number;
  unique_stores: number;
  unique_sellers: number;
  unique_locations: number;
}

export interface BlinkitSpendingPeriod {
  period: string;
  spend: number;
  discount: number;
  delivery: number;
  handling: number;
  convenience: number;
  order_count: number;
  avg_order_value: number;
}

export interface BlinkitCategoryRow {
  category: string;
  total_spend: number;
  order_count: number;
  product_count: number;
  total_quantity: number;
  avg_spend: number;
  pct_of_total: number;
}

export interface BlinkitProductRank {
  product_name: string;
  category: string;
  times_purchased: number;
  total_quantity: number;
  total_spend: number;
  avg_price: number;
  avg_discount: number;
}

export interface BlinkitStoreRow {
  store_name: string;
  order_count: number;
  total_spend: number;
  avg_basket_size: number;
  avg_order_value: number;
}

export interface BlinkitSellerRow {
  seller_name: string;
  order_count: number;
  total_spend: number;
  avg_order_value: number;
}

export interface BlinkitBrandRow {
  brand: string;
  total_spend: number;
  total_quantity: number;
  order_count: number;
}

export interface BlinkitLocationRow {
  name: string;
  spend: number;
  orders: number;
  avg_order_value: number;
}

export interface BlinkitLocationBreakdown {
  by_state: BlinkitLocationRow[];
  by_address: BlinkitLocationRow[];
}

export interface BlinkitChargesPeriod extends BlinkitSpendingPeriod {
  delivery_pct: number;
  handling_pct: number;
}

export interface BlinkitDiscountAnalytics {
  monthly: { period: string; discount: number }[];
  by_category: BlinkitCategoryRow[];
  top_discounted_products: BlinkitProductRank[];
}

export interface BlinkitTaxAnalytics {
  total_cgst: number;
  total_sgst: number;
  tax_pct: number;
  monthly: { period: string; cgst: number; sgst: number; tax: number }[];
  by_category: { category: string; tax: number }[];
}

export interface BlinkitExplorerRow {
  id: number;
  order_id: string | null;
  invoice_number: string;
  invoice_date: string | null;
  customer_name: string | null;
  delivery_address: string | null;
  delivery_state: string | null;
  delivery_pincode: string | null;
  store_name: string | null;
  seller_name: string | null;
  item_total: number | null;
  discount_total: number | null;
  delivery_fee: number | null;
  handling_charge: number | null;
  convenience_fee: number | null;
  tax_total: number | null;
  grand_total: number | null;
  total_quantity: number | null;
  payment_method: string | null;
  source_file: string | null;
  total_fees: number;
}

export interface BlinkitExplorerList {
  rows: BlinkitExplorerRow[];
  total: number;
}

export interface BlinkitDrilldownOrderRow extends BlinkitExplorerRow {
  category_summary?: string | null;
}

export interface BlinkitDrilldownProductRow {
  id: number;
  product_name: string;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  quantity: number | null;
  mrp: number | null;
  selling_price: number | null;
  discount: number | null;
  tax: number | null;
  total_amount: number | null;
  order_row_id: number;
  order_id: string | null;
  invoice_number: string;
  invoice_date: string | null;
  seller_name: string | null;
  store_name: string | null;
}

export interface BlinkitDrilldownResult {
  tab: "orders" | "products";
  dimension: string;
  value: string | null;
  label: string;
  total: number;
  orders: BlinkitDrilldownOrderRow[];
  products: BlinkitDrilldownProductRow[];
}

export interface BlinkitShoppingBehavior {
  avg_basket_size?: number;
  avg_quantity_per_order?: number;
  orders_per_weekday?: { weekday: string; count: number }[];
  orders_by_day_of_month?: { day: number; count: number }[];
  orders_per_month?: { period: string; count: number; spend: number }[];
  avg_gap_days?: number;
  max_gap_days?: number;
  most_active_month?: string;
}

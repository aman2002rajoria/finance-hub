"""Pydantic v2 request / response schemas shared across the API."""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Generic
# ---------------------------------------------------------------------------


class ErrorOut(BaseModel):
    detail: str


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    type: str
    display_name: str


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    date: date
    description: str
    amount: float
    type: str
    balance: Optional[float] = None
    account_type: str
    account_name: str
    reference_id: Optional[str] = None
    raw_text: Optional[str] = None
    vpa: Optional[str] = None
    merchant_name: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    is_refund: bool = False
    refund_category: Optional[str] = None
    is_internal_transfer: bool
    is_credit_card_payment: bool
    is_emi: bool
    linked_transaction_id: Optional[str] = None
    emi_id: Optional[int] = None
    txn_mode: Optional[str] = None
    txn_time: Optional[time] = None
    categorization_source: Optional[str] = None
    categorized_by_rule_id: Optional[int] = None
    categorized_by_rule_name: Optional[str] = None
    source_file: Optional[str] = None


class TransactionPatch(BaseModel):
    """Partial update — fields the user can edit from the UI.

    ``None`` means "leave alone"; explicit ``null`` JSON value vs.
    field-absent is collapsed by Pydantic, so to **clear** a category we
    accept the sentinel ``""`` (empty string) and translate it to NULL
    in the handler.
    """
    category: Optional[str] = None
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    is_refund: Optional[bool] = None
    refund_category: Optional[str] = None
    is_internal_transfer: Optional[bool] = None
    is_credit_card_payment: Optional[bool] = None
    propagate_via: Optional[str] = Field(
        default=None, description="If set ('vpa' | 'merchant'), saves a rule too."
    )


class TransactionListOut(BaseModel):
    transactions: List[TransactionOut]
    total: int


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


class RuleIn(BaseModel):
    """Create / upsert payload for a categorisation rule.

    Heuristic rules need a ``conditions`` JSON object (see
    :mod:`services.rule_engine`); the other rule types use ``rule_value``
    as the literal to match. ``rule_value`` is auto-derived from ``name``
    for heuristic rules so the unique-index continues to dedupe.
    """
    rule_type: str = Field(description="vpa | keyword | merchant | heuristic")
    rule_value: Optional[str] = None
    category: str
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    enabled: bool = True
    conditions: Optional[Dict[str, Any]] = None
    propagate: bool = True


class RuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    rule_type: str
    rule_value: str
    category: str
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: bool = True
    is_system: bool = False
    priority: int
    conditions: Optional[Dict[str, Any]] = None
    transactions_categorized: int = 0
    created_at: datetime
    updated_at: datetime


class RuleToggleIn(BaseModel):
    enabled: bool


class RuleReorderIn(BaseModel):
    rule_ids: List[int] = Field(description="Ordered — first = highest priority (lowest number)")


class RuleApplyTreeIn(BaseModel):
    """Apply a v2 condition tree to matching transactions (skips manual tags)."""
    name: str
    conditions: Dict[str, Any]
    category: str
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    priority: Optional[int] = 300
    only_uncategorized: bool = True
    save_rule: bool = True


class RuleApplyTreeResult(BaseModel):
    rule_id: Optional[int] = None
    transactions_updated: int
    skipped_manual: int


class RunEngineResult(BaseModel):
    scanned: int
    matched: int
    cleared: int = 0
    by_source: Dict[str, int] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# EMI
# ---------------------------------------------------------------------------


class EMIIn(BaseModel):
    txn_id: str
    tenure_months: int = Field(ge=2, le=60)
    start_date: Optional[date] = None
    note: Optional[str] = None


class EMIOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    original_transaction_id: str
    total_amount: float
    tenure_months: int
    monthly_amount: float
    start_date: date
    note: Optional[str] = None


class EMIInstalmentOut(BaseModel):
    period: str
    amount: float
    emi_id: int
    original_transaction_id: str


class EMIWithSchedule(BaseModel):
    plan: EMIOut
    schedule: List[EMIInstalmentOut]


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------


class UploadResult(BaseModel):
    filename: str
    bank: Optional[str] = None
    account_name: Optional[str] = None
    pages_parsed: int = 0
    parsed_count: int = 0
    new_count: int = 0
    duplicate_count: int = 0
    parse_failure_count: int = 0
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    cc_payments_tagged: int = 0
    rules_applied: int = 0
    income_autotagged: int = 0
    skipped_already_uploaded: bool = False
    force_reparsed: bool = False
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class UploadOut(BaseModel):
    results: List[UploadResult]


class UploadHistoryRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    bank: str
    txn_count: int
    new_txn_count: int
    pages_parsed: int
    uploaded_at: datetime
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------


class HeadlineMetrics(BaseModel):
    total_txns: int
    total_spend: float
    total_income: float
    net: float
    savings_rate_pct: float
    spend_excluding_emi: float
    spend_from_emi: float
    internal_transfers: int
    credit_card_payments: int
    emi_transactions: int


class CashFlowSnapshot(BaseModel):
    """All money movement — refunds count as money in."""
    money_in: float
    money_out: float
    net: float


class PersonalEconomicsSnapshot(BaseModel):
    """True earnings vs consumption — refunds excluded from income."""
    true_income: float
    income_by_source: List[IncomeDetailRow] = Field(default_factory=list)
    refunds_recoveries: float
    gross_expenses: float
    refunds_applied: float
    net_personal_spend: float
    savings: float
    savings_rate_pct: float


class MonthlyAveragesSnapshot(BaseModel):
    """Per-month averages over months present in the active date range."""
    months: int
    avg_income: float
    avg_spend: float
    avg_saving: float
    avg_saving_rate_pct: float


class ExcludedFlowsSnapshot(BaseModel):
    internal_transfers: int
    credit_card_payments: int
    emi_transactions: int


class FinancialSnapshotOut(BaseModel):
    """§1 dashboard payload — cash flow + personal economics."""
    total_txns: int
    cash_flow: CashFlowSnapshot
    personal_economics: PersonalEconomicsSnapshot
    monthly_averages: MonthlyAveragesSnapshot
    excluded: ExcludedFlowsSnapshot


class MonthlyOut(BaseModel):
    period: str
    spend: float
    income: float
    net: float


class CategoryOut(BaseModel):
    category: str
    amount: float
    txn_count: int


class BalancePoint(BaseModel):
    date: str
    account_name: str
    balance: float


class NetWorthPoint(BaseModel):
    date: str
    net_worth: float


class CounterpartyOut(BaseModel):
    counterparty: str
    amount: float
    txn_count: int


class CategorizationProgress(BaseModel):
    """Categorization coverage metrics for the Categorize tab header.

    All transaction counts use the *real-flow* predicate (excludes internal
    transfers, CC bill payments, EMI lump-sums) — same scope as
    ``GET /transactions/counterparties``. See ``utils/tagging.py``.
    """
    # --- Transaction coverage ---
    total_transactions: int
    categorized_transactions: int
    uncategorized_transactions: int
    coverage_pct: float = Field(description="categorized / total × 100")

    # --- VPA buckets (usable VPAs only; bank handles excluded) ---
    total_vpas: int
    categorized_vpas: int
    uncategorized_vpas: int
    uncat_vpa_pct: float = Field(description="uncategorized_vpas / total_vpas × 100")

    # --- Counterparty (merchant) buckets ---
    total_counterparties: int
    categorized_counterparties: int
    uncategorized_counterparties: int

    # --- Financial impact (real-flow amounts, INR) ---
    uncat_expense_amount: float
    uncat_income_amount: float
    uncat_net_amount: float
    total_expense_amount: float
    uncat_expense_pct: float = Field(description="uncat expense / total expense × 100")

    # --- Legacy aliases (dashboard + older UI) ---
    uncategorized_txns: int
    transactions_no_vpa: int


# ---------------------------------------------------------------------------
# Counterparty list (for the Categorize page left-pane)
# ---------------------------------------------------------------------------


class CounterpartyGroup(BaseModel):
    """One row in the Categorize-page summary table.

    Excludes internal transfers + CC bill payments + EMI lump-sums so
    the credit / debit / net columns reflect the *real* economic flow
    (which is what the user cares about when deciding what to tag).
    """
    key: str               # 'vpa:foo@okhdfc' or 'merchant:Zomato' or 'unmatched'
    label: str
    kind: str              # 'vpa' | 'merchant' | 'unmatched'
    txn_count: int
    total_amount: float    # legacy: sum(amount) without sign — kept for compat
    total_debit: float = 0.0
    total_credit: float = 0.0
    net_amount: float = 0.0      # credit - debit (negative = net out-flow)
    uncategorized_count: int = 0
    has_category: bool
    last_date: Optional[str] = None


# ---------------------------------------------------------------------------
# VPA / merchant aggregate panel
# ---------------------------------------------------------------------------


class CounterpartySummary(BaseModel):
    label: str
    kind: str               # 'vpa' | 'merchant'
    total_credit: float
    total_debit: float
    net: float
    transaction_count: int
    first_date: Optional[str] = None
    last_date: Optional[str] = None


# ---------------------------------------------------------------------------
# Internal-transfer manual linking
# ---------------------------------------------------------------------------


class TransferCandidate(BaseModel):
    """A possible counter-leg suggested by the linker."""
    model_config = ConfigDict(from_attributes=True)
    id: str
    date: date
    description: str
    amount: float
    type: str
    account_name: str
    amount_diff: float
    day_diff: int


class LinkTransferIn(BaseModel):
    partner_id: str


# ---------------------------------------------------------------------------
# CC bill-payment mapping
# ---------------------------------------------------------------------------


class CCPaymentCandidate(BaseModel):
    cc_account_name: str
    billing_month: str       # 'YYYY-MM'
    total_amount: float


class MarkCCPaymentIn(BaseModel):
    cc_account_name: str
    billing_month: str


class CCBillLinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    savings_txn_id: str
    cc_account_name: str
    billing_month: str
    total_amount: float


class CCReconciliationRow(BaseModel):
    cc_account_name: str
    billing_month: str
    spend: float
    paid: float
    difference: float
    txn_count: int
    paid_known: bool


# ---------------------------------------------------------------------------
# Category taxonomy
# ---------------------------------------------------------------------------


class CategoryNode(BaseModel):
    id: int
    name: str
    level: int           # 1, 2, 3
    kind: str            # 'expense' | 'income'
    archived: bool = False
    sort_order: int = 100
    children: List["CategoryNode"] = Field(default_factory=list)


CategoryNode.model_rebuild()


class TaxonomyOut(BaseModel):
    expense: List[CategoryNode]
    income:  List[CategoryNode]


# ---------------------------------------------------------------------------
# Analytics — v3 (income breakdown + monthly-by-category)
# ---------------------------------------------------------------------------


class IncomeBreakdownRow(BaseModel):
    # ``category`` is always "Income" today (auto-tag + manual flow both
    # point there) but is included explicitly to keep the UI label honest
    # if the user later introduces a second income root.
    category: str
    subcategory: Optional[str] = None
    amount: float
    txn_count: int


class MonthlyCategoryCell(BaseModel):
    period: str
    category: str
    amount: float
    pct_of_month: float = 0.0


# ---------------------------------------------------------------------------
# Transaction detail (for the right-hand drawer)
# ---------------------------------------------------------------------------


class TransactionDetail(BaseModel):
    """The full single-transaction view including link state."""
    transaction: TransactionOut
    linked_transaction: Optional[TransactionOut] = None
    cc_bill_link: Optional[CCBillLinkOut] = None


# ---------------------------------------------------------------------------
# Bulk "apply to all similar" + Excel categorisation workflow
# ---------------------------------------------------------------------------


class BulkApplyIn(BaseModel):
    """Apply a (category, subcategory, sub_subcategory) to every transaction
    that matches the given logical group.

    ``kind`` controls the matcher:
      * ``vpa``         — exact (case-insensitive) match on ``Transaction.vpa``.
      * ``merchant``    — exact match on ``Transaction.merchant_name``.
      * ``description`` — substring match on ``Transaction.description``.
      * ``combined``    — exact VPA AND merchant (requires ``vpa_value`` +
                          ``merchant_value``); saves a heuristic rule.
    """
    kind: str = Field(description="vpa | merchant | description | combined")
    value: str = ""
    vpa_value: Optional[str] = None
    merchant_value: Optional[str] = None
    category: str
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None
    save_rule: bool = True


class BulkApplyResult(BaseModel):
    transactions_updated: int
    rule_id: Optional[int] = None


class RecanonicalizeResult(BaseModel):
    transactions_scanned: int
    merchant_changed: int


class CategoryImportRow(BaseModel):
    """One row of the bulk-categorisation Excel."""
    label: str
    kind: str                     # 'vpa' | 'merchant' | 'description'
    category: str
    subcategory: Optional[str] = None
    sub_subcategory: Optional[str] = None


class CategoryImportError(BaseModel):
    row: int
    label: Optional[str] = None
    error: str


class CategoryImportResult(BaseModel):
    rows_read: int
    rows_applied: int
    transactions_updated: int
    rules_created: int
    errors: List[CategoryImportError] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Rich income dashboard
# ---------------------------------------------------------------------------


class IncomeDetailRow(BaseModel):
    """One bucket on the income dashboard.

    ``subcategory`` is the income sub-bucket the user sees (Salary,
    Interest Income, Pocket Money, …) plus an "Uncategorized Income"
    pseudo-bucket for credits whose subcategory is null.
    """
    subcategory: str
    amount: float
    txn_count: int


class RefundDetailRow(BaseModel):
    """One bucket on the refunds card. ``category`` reflects the spend
    bucket the refund offsets (Food, Shopping, …) — credits with
    ``refund_category`` IS NULL collapse into "Uncategorized"."""
    category: str
    amount: float
    txn_count: int


class IncomeMonthlyPoint(BaseModel):
    period: str        # 'YYYY-MM'
    subcategory: str
    amount: float


class IncomeDetailOut(BaseModel):
    """Full payload for the rebuilt income dashboard."""
    total_income: float
    total_refunds: float
    by_subcategory: List[IncomeDetailRow] = Field(default_factory=list)
    refunds_by_category: List[RefundDetailRow] = Field(default_factory=list)
    refunds_by_type: List["RefundTypeRow"] = Field(default_factory=list)
    monthly_trend: List[IncomeMonthlyPoint] = Field(default_factory=list)


class RefundTypeRow(BaseModel):
    refund_type: str
    amount: float
    txn_count: int


class SankeyNode(BaseModel):
    id: str
    label: str
    layer: int
    amount: float = 0.0
    parent_id: Optional[str] = None
    depth: int = 0
    expandable: bool = False
    expanded: bool = False
    period: Optional[str] = None
    node_type: str = "generic"


class SankeyLink(BaseModel):
    source: str
    target: str
    value: float
    link_type: str = "flow"
    balance_amount: Optional[float] = None
    period_from: Optional[str] = None
    period_to: Optional[str] = None


class SankeyMonthlyReconciliation(BaseModel):
    period: str
    opening_balance: float
    closing_balance: float
    cash_in: float
    cash_out: float
    total_income: float = 0.0
    total_expense: float = 0.0
    true_income: float = 0.0
    gross_expenses: float = 0.0
    savings: float
    carry_forward: float = 0.0
    conservation_error: float
    carry_forward_error: float = 0.0


class SankeyReconciliation(BaseModel):
    opening_balance: float = 0.0
    closing_balance: float = 0.0
    cash_in: float = 0.0
    cash_out: float = 0.0
    total_income: float = 0.0
    total_expense: float = 0.0
    savings: float = 0.0
    true_income: float = 0.0
    refunds_recoveries: float = 0.0
    conservation_error: float = 0.0
    flow_conservation_error: float = 0.0
    max_carry_forward_error: float = 0.0
    # Legacy fields (optional for backward compat)
    net_personal_spend: float = 0.0
    gross_expenses: float = 0.0
    inflow_to_available: float = 0.0
    outflow_from_available: float = 0.0
    balance_delta: float = 0.0
    balance_reconciliation_error: float = 0.0


class SankeyOut(BaseModel):
    mode: str = "period"
    nodes: List[SankeyNode]
    links: List[SankeyLink]
    expanded: List[str] = Field(default_factory=list)
    periods: List[str] = Field(default_factory=list)
    savings_definition: str = "closing_balance − opening_balance"
    reconciliation: SankeyReconciliation
    monthly_reconciliation: List[SankeyMonthlyReconciliation] = Field(default_factory=list)
    expand_path: List[str] = Field(default_factory=list)


class ExpenseDrilldownRow(BaseModel):
    label: str
    amount: float
    txn_count: int = 0
    id: Optional[str] = None
    date: Optional[str] = None


class ExpenseDrilldownOut(BaseModel):
    level: str
    category: str
    subcategory: Optional[str] = None
    counterparty: Optional[str] = None
    total: float
    rows: List[ExpenseDrilldownRow] = Field(default_factory=list)


class MonthlySummaryRow(BaseModel):
    period: str
    opening_balance: float
    total_income: float
    total_expense: float
    net_savings: float
    savings_rate_pct: float
    closing_balance: float
    mom_savings_change: Optional[float] = None
    mom_savings_change_pct: Optional[float] = None
    is_best_savings_month: bool = False
    is_worst_savings_month: bool = False


class MonthlySubcategoryCell(BaseModel):
    period: str
    subcategory: str
    amount: float


class CategoryInsightItem(BaseModel):
    kind: str
    title: str
    label: str
    value: float
    unit: str
    amount_delta: Optional[float] = None


class CategoryInsightsOut(BaseModel):
    insights: List[CategoryInsightItem] = Field(default_factory=list)
    periods: List[str] = Field(default_factory=list)


class SavingsDriverItem(BaseModel):
    label: str
    category: str
    spend_delta: float
    current_spend: float
    previous_spend: float
    driver_type: Optional[str] = None


class SavingsDriversOut(BaseModel):
    period: Optional[str] = None
    comparison_period: Optional[str] = None
    delta_savings: float = 0.0
    current_savings: float = 0.0
    previous_savings: float = 0.0
    income_delta: float = 0.0
    direction: str = "flat"
    drivers: List[SavingsDriverItem] = Field(default_factory=list)


class CategoryTrendSeriesOut(BaseModel):
    categories: List[str] = Field(default_factory=list)
    cells: List[MonthlyCategoryCell] = Field(default_factory=list)


class ReviewQueueItemOut(BaseModel):
    label: str
    amount: float
    txn_count: int


class AnalyticsReviewQueuesOut(BaseModel):
    top_vpas: List[ReviewQueueItemOut]
    top_counterparties: List[ReviewQueueItemOut]
    top_descriptions: List[ReviewQueueItemOut]


# ---------------------------------------------------------------------------
# Blinkit order invoices
# ---------------------------------------------------------------------------


class BlinkitIngestOut(BaseModel):
    files_processed: int = 0
    orders_new: int = 0
    orders_skipped: int = 0
    items_new: int = 0
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class BlinkitStatsOut(BaseModel):
    order_count: int = 0
    item_count: int = 0
    distinct_order_ids: int = 0
    error_count: int = 0
    files_scanned: int = 0
    total_spend: float = 0.0
    total_item_spend: float = 0.0
    total_fees: float = 0.0
    invoice_directory: str = ""


class BlinkitOrderItemOut(BaseModel):
    id: int
    order_row_id: int
    order_id: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    sr_no: Optional[int] = None
    upc: Optional[str] = None
    hsn_code: Optional[str] = None
    product_name: str
    brand: Optional[str] = None
    variant: Optional[str] = None
    size_weight: Optional[str] = None
    packaging: Optional[str] = None
    category: Optional[str] = None
    mrp: Optional[float] = None
    selling_price: Optional[float] = None
    discount: Optional[float] = None
    quantity: Optional[float] = None
    taxable_value: Optional[float] = None
    cgst_pct: Optional[float] = None
    cgst_inr: Optional[float] = None
    sgst_pct: Optional[float] = None
    sgst_inr: Optional[float] = None
    igst_pct: Optional[float] = None
    igst_inr: Optional[float] = None
    cess_pct: Optional[float] = None
    additional_cess_val: Optional[float] = None
    total_amount: Optional[float] = None
    line_type: str = "product"


class BlinkitAnnexureOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sr_no: Optional[int] = None
    nature_of_charge: str
    tax_rate: Optional[float] = None
    cess_rate: Optional[float] = None
    taxable_value: Optional[float] = None
    cgst: Optional[float] = None
    sgst: Optional[float] = None
    cess: Optional[float] = None


class BlinkitOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    invoice_number: str
    order_id: Optional[str] = None
    invoice_date: Optional[date] = None
    order_date: Optional[date] = None
    delivery_date: Optional[date] = None
    place_of_supply: Optional[str] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_city: Optional[str] = None
    delivery_state: Optional[str] = None
    delivery_pincode: Optional[str] = None
    seller_name: Optional[str] = None
    seller_gstin: Optional[str] = None
    seller_fssai: Optional[str] = None
    store_name: Optional[str] = None
    store_address: Optional[str] = None
    store_state: Optional[str] = None
    store_pincode: Optional[str] = None
    store_gstin: Optional[str] = None
    item_total: Optional[float] = None
    delivery_fee: Optional[float] = None
    handling_charge: Optional[float] = None
    convenience_fee: Optional[float] = None
    packaging_charge: Optional[float] = None
    other_charges: Optional[float] = None
    discount_total: Optional[float] = None
    cgst_total: Optional[float] = None
    sgst_total: Optional[float] = None
    tax_total: Optional[float] = None
    grand_total: Optional[float] = None
    amount_paid: Optional[float] = None
    amount_in_words: Optional[str] = None
    payment_method: Optional[str] = None
    has_annexure: bool = False
    is_continuation_merged: bool = False
    source_file: Optional[str] = None
    page_number: Optional[int] = None
    items: List[BlinkitOrderItemOut] = Field(default_factory=list)
    annexure_charges: List[BlinkitAnnexureOut] = Field(default_factory=list)


class BlinkitOrderListOut(BaseModel):
    orders: List[BlinkitOrderOut] = Field(default_factory=list)
    total: int = 0


class BlinkitParseErrorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    source_file: str
    page: Optional[int] = None
    stage: str = "extract"
    reason: str
    snippet: Optional[str] = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Blinkit analytics
# ---------------------------------------------------------------------------


class BlinkitAnalyticsSummaryOut(BaseModel):
    total_spend: float = 0
    total_orders: int = 0
    distinct_order_ids: int = 0
    total_items: int = 0
    total_quantity: float = 0
    avg_order_value: float = 0
    max_order_value: float = 0
    min_order_value: float = 0
    total_discount: float = 0
    avg_discount_per_order: float = 0
    discount_pct: float = 0
    total_delivery_charges: float = 0
    total_handling_charges: float = 0
    total_convenience_charges: float = 0
    total_taxes: float = 0
    charges_pct_of_spend: float = 0
    unique_products: int = 0
    unique_categories: int = 0
    unique_stores: int = 0
    unique_sellers: int = 0
    unique_locations: int = 0


class BlinkitSpendingPeriodOut(BaseModel):
    period: str
    spend: float = 0
    discount: float = 0
    delivery: float = 0
    handling: float = 0
    convenience: float = 0
    order_count: int = 0
    avg_order_value: float = 0


class BlinkitCategoryRowOut(BaseModel):
    category: str
    total_spend: float = 0
    order_count: int = 0
    product_count: int = 0
    total_quantity: float = 0
    avg_spend: float = 0
    pct_of_total: float = 0


class BlinkitSubcategoryRowOut(BaseModel):
    subcategory: str
    category: str
    total_spend: float = 0
    order_count: int = 0
    product_count: int = 0
    total_quantity: float = 0
    pct_of_category: float = 0


class BlinkitCategoryTrendRowOut(BaseModel):
    period: str
    category: str
    spend: float = 0


class BlinkitDrilldownSummaryOut(BaseModel):
    dimension: str
    value: Optional[str] = None
    total_spend: float = 0
    item_spend: float = 0
    total_orders: int = 0
    total_products: int = 0
    total_items: int = 0
    avg_order_value: float = 0


class BlinkitProductRankOut(BaseModel):
    product_name: str
    category: str = "Others"
    times_purchased: int = 0
    total_quantity: float = 0
    total_spend: float = 0
    avg_price: float = 0
    avg_discount: float = 0


class BlinkitStoreRowOut(BaseModel):
    store_name: str
    order_count: int = 0
    total_spend: float = 0
    avg_basket_size: float = 0
    avg_order_value: float = 0


class BlinkitSellerRowOut(BaseModel):
    seller_name: str
    order_count: int = 0
    total_spend: float = 0
    avg_order_value: float = 0


class BlinkitLocationRowOut(BaseModel):
    name: str
    spend: float = 0
    orders: int = 0
    avg_order_value: float = 0


class BlinkitLocationBreakdownOut(BaseModel):
    by_state: List[BlinkitLocationRowOut] = Field(default_factory=list)
    by_address: List[BlinkitLocationRowOut] = Field(default_factory=list)


class BlinkitOrderBucketOut(BaseModel):
    bucket: str
    count: int = 0


class BlinkitBrandRowOut(BaseModel):
    brand: str
    total_spend: float = 0
    total_quantity: float = 0
    order_count: int = 0


class BlinkitInsightsOut(BaseModel):
    insights: List[str] = Field(default_factory=list)


class BlinkitExplorerRowOut(BaseModel):
    id: int
    order_id: Optional[str] = None
    invoice_number: str
    invoice_date: Optional[str] = None
    customer_name: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_state: Optional[str] = None
    delivery_pincode: Optional[str] = None
    store_name: Optional[str] = None
    seller_name: Optional[str] = None
    item_total: Optional[float] = None
    discount_total: Optional[float] = None
    delivery_fee: Optional[float] = None
    handling_charge: Optional[float] = None
    convenience_fee: Optional[float] = None
    tax_total: Optional[float] = None
    grand_total: Optional[float] = None
    total_quantity: Optional[float] = None
    payment_method: Optional[str] = None
    source_file: Optional[str] = None
    total_fees: float = 0


class BlinkitExplorerListOut(BaseModel):
    rows: List[BlinkitExplorerRowOut] = Field(default_factory=list)
    total: int = 0


class BlinkitDrilldownOrderRowOut(BlinkitExplorerRowOut):
    category_summary: Optional[str] = None


class BlinkitDrilldownProductRowOut(BaseModel):
    id: int
    product_name: str
    category: Optional[str] = None
    subcategory: Optional[str] = None
    brand: Optional[str] = None
    quantity: Optional[float] = None
    mrp: Optional[float] = None
    selling_price: Optional[float] = None
    discount: Optional[float] = None
    tax: Optional[float] = None
    total_amount: Optional[float] = None
    order_row_id: int
    order_id: Optional[str] = None
    invoice_number: str
    invoice_date: Optional[str] = None
    seller_name: Optional[str] = None
    store_name: Optional[str] = None


class BlinkitDrilldownOut(BaseModel):
    tab: str
    dimension: str
    value: Optional[str] = None
    label: str
    total: int = 0
    orders: List[BlinkitDrilldownOrderRowOut] = Field(default_factory=list)
    products: List[BlinkitDrilldownProductRowOut] = Field(default_factory=list)


class BlinkitCategorizeOut(BaseModel):
    products_processed: int = 0
    products_new: int = 0
    items_updated: int = 0
    llm_used: int = 0
    skipped_manual: int = 0
    ai_enabled: bool = False


class CategorizationJobStartIn(BaseModel):
    mode: str = Field(
        default="unclassified",
        description="unclassified: rules first, AI for unmatched | reclassify_all: AI for all non-manual",
    )


class CategorizationJobMetricsOut(BaseModel):
    requests_sent: int = 0
    requests_ok: int = 0
    requests_failed: int = 0
    retries: int = 0
    rate_limit_waits: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    tokens_estimated: bool = False


class CategorizationJobSummaryOut(BaseModel):
    total_processed: int = 0
    newly_categorized: int = 0
    already_skipped: int = 0
    recategorized: int = 0
    failed: int = 0
    items_updated: int = 0
    rules_categorized: int = 0


class ApiErrorEntryOut(BaseModel):
    batch: int
    code: Optional[int] = None
    message: str
    timestamp: str
    products_affected: int = 0


class CategorizationJobOut(BaseModel):
    job_id: str
    mode: str
    status: str
    phase: str = "preparing"
    cancel_requested: bool = False
    total_products: int = 0
    completed_products: int = 0
    progress_pct: float = 0.0
    current_batch: int = 0
    total_batches: int = 0
    activity_log: List[str] = Field(default_factory=list)
    metrics: CategorizationJobMetricsOut = Field(default_factory=CategorizationJobMetricsOut)
    summary: CategorizationJobSummaryOut = Field(default_factory=CategorizationJobSummaryOut)
    failed_products: List[str] = Field(default_factory=list)
    failure_reason: Optional[str] = None
    last_api_error: Optional[str] = None
    last_api_error_code: Optional[int] = None
    api_errors: List[ApiErrorEntryOut] = Field(default_factory=list)
    error: Optional[str] = None
    elapsed_s: float = 0.0
    eta_s: Optional[float] = None
    throughput_per_min: float = 0.0
    avg_s_per_product: float = 0.0
    ai_model: Optional[str] = None


class BlinkitProductDetailOut(BaseModel):
    product_name: str
    category: str = "Others"
    subcategory: Optional[str] = None
    categorization_source: str = "rules"
    ai_categorized: bool = False
    ai_model: Optional[str] = None
    ai_categorized_at: Optional[str] = None
    total_spend: float = 0
    total_quantity: float = 0
    times_purchased: int = 0
    purchase_history: List[dict] = Field(default_factory=list)
    stores: List[dict] = Field(default_factory=list)

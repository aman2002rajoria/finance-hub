"""Normalized ORM models for the personal finance app.

Schema overview
---------------

* ``accounts``                — one row per source account (SBI, SBI_CC, …).
* ``transactions``            — every parsed transaction (the heart of the system).
* ``categorization_rules``    — VPA / keyword / merchant → (category, subcategory).
* ``emi_records``             — split-EMI metadata for transactions that were
                                converted to instalments after the fact.
* ``uploads``                 — audit trail of parsed PDF files.

Design choices documented inline next to each column.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import List, Optional

from sqlalchemy import (
    Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, Time,
    UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.database import Base


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Account-type vocab. Kept as strings (not enums) so the API can serialise
# without custom encoders.
ACCOUNT_TYPE_SAVINGS = "savings"
ACCOUNT_TYPE_CREDIT_CARD = "credit_card"

TXN_TYPE_DEBIT = "debit"
TXN_TYPE_CREDIT = "credit"

# Rule types supported by the rule engine. Order also determines the
# default priority band used when a rule is created without an explicit
# ``priority`` (lower number = evaluated first).
RULE_TYPE_VPA       = "vpa"        # exact match on the txn's vpa column
RULE_TYPE_MERCHANT  = "merchant"   # exact match on merchant_name (post-normalize)
RULE_TYPE_KEYWORD   = "keyword"    # case-insensitive substring on description
RULE_TYPE_HEURISTIC = "heuristic"  # JSON conditions (time, amount, mode, …)


# Where a transaction's category came from. Used for both UI hints
# ("how did I tag this?") and analytics audit trails.
CATEGORIZATION_SOURCE_MANUAL          = "manual"
CATEGORIZATION_SOURCE_EXCEL_IMPORT    = "excel_import"
CATEGORIZATION_SOURCE_VPA_MAPPING     = "vpa_mapping"
CATEGORIZATION_SOURCE_MERCHANT_MAPPING = "merchant_mapping"
CATEGORIZATION_SOURCE_KEYWORD_RULE    = "keyword_rule"
CATEGORIZATION_SOURCE_RULE_ENGINE     = "rule_engine"
CATEGORIZATION_SOURCE_AUTO_INCOME     = "auto_income"
CATEGORIZATION_SOURCE_AI              = "ai"

# Map rule-type → default categorization_source label, so the rule
# engine picks the right tag without explicit per-rule configuration.
RULE_TYPE_TO_SOURCE = {
    RULE_TYPE_VPA:       CATEGORIZATION_SOURCE_VPA_MAPPING,
    RULE_TYPE_MERCHANT:  CATEGORIZATION_SOURCE_MERCHANT_MAPPING,
    RULE_TYPE_KEYWORD:   CATEGORIZATION_SOURCE_KEYWORD_RULE,
    RULE_TYPE_HEURISTIC: CATEGORIZATION_SOURCE_RULE_ENGINE,
}


# ---------------------------------------------------------------------------
# accounts
# ---------------------------------------------------------------------------


class Account(Base):
    """A bank or card account the user owns.

    Account names are canonical strings (``SBI``, ``SLICE``, ``CANARA``,
    ``SBI_CC``, ``SLICE_CC``). The ingestion pipeline auto-creates an
    Account row on first sight of a new ``account_name``.
    """

    __tablename__ = "accounts"

    id:        Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    name:      Mapped[str]  = mapped_column(String, nullable=False, unique=True)
    type:      Mapped[str]  = mapped_column(String, nullable=False)   # 'savings' | 'credit_card'
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )

    transactions: Mapped[List["Transaction"]] = relationship(
        back_populates="account", cascade="save-update",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Account {self.name} ({self.type})>"


# ---------------------------------------------------------------------------
# transactions
# ---------------------------------------------------------------------------


class Transaction(Base):
    """A single parsed transaction.

    The ``id`` is a deterministic SHA-1 hash of
    ``(date | amount | description | account_name)`` — see
    :func:`services.dedup_service.txn_id`. The same PDF re-uploaded
    produces the same IDs, so ``INSERT OR IGNORE`` transparently
    deduplicates without any extra bookkeeping.
    """

    __tablename__ = "transactions"

    id:                    Mapped[str]   = mapped_column(String, primary_key=True)
    date:                  Mapped[date]  = mapped_column(Date, nullable=False)
    description:           Mapped[str]   = mapped_column(String, nullable=False)
    amount:                Mapped[float] = mapped_column(Float, nullable=False)   # always positive
    type:                  Mapped[str]   = mapped_column(String, nullable=False)  # 'debit' | 'credit'
    balance:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Account provenance — denormalised onto every row to make analytics
    # queries cheap (we run far more reads than writes).
    account_type:          Mapped[str] = mapped_column(String, nullable=False)
    account_id:            Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True,
    )
    account_name:          Mapped[str] = mapped_column(String, nullable=False)

    reference_id:          Mapped[Optional[str]] = mapped_column(String, nullable=True)
    raw_text:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    vpa:                   Mapped[Optional[str]] = mapped_column(String, nullable=True)
    merchant_name:         Mapped[Optional[str]] = mapped_column(String, nullable=True)
    txn_mode:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Wall-clock time the bank stamped on the row (when the parser can
    # extract it). Most savings PDFs don't include time; UPI rows often
    # do. Used by heuristic rules with a ``time_of_day`` condition.
    txn_time:              Mapped[Optional[time]] = mapped_column(Time, nullable=True)

    category:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    subcategory:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Optional third level of the category hierarchy
    # (e.g. Travel → Travel to Home → Flight).
    sub_subcategory:       Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- audit trail: how was this transaction categorised? -----------
    # Free-form string from the CATEGORIZATION_SOURCE_* constants. ``None``
    # means "uncategorised" (no source). The value drives a small chip in
    # the UI ("Manual" / "Rule-Based: Rapido" / "VPA Mapping" / "Excel
    # Import" / …) so the user can audit every tag.
    categorization_source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Pointer to the rule that won — null for manual / Excel-import rows.
    # Kept nullable so the FK survives rule deletion (we use SET NULL).
    categorized_by_rule_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("categorization_rules.id", ondelete="SET NULL"), nullable=True,
    )

    # Refund accounting.
    # A "refund" is a CREDIT that should NOT be counted as income — instead
    # it should *subtract* from spend in some other category. Examples:
    #   * A friend pays you back for dinner → refund against "Food".
    #   * Cashback from Amazon            → refund against "Shopping".
    # ``refund_category`` is the category whose spend it offsets. We keep
    # this distinct from ``category`` (which is what the row *looks* like
    # on the bank side, e.g. "Income/Refund" auto-tag) so the analytics
    # math is deterministic.
    is_refund:             Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    refund_category:       Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # Flags for double-counting prevention + EMI handling. All three
    # default to False so analytics can `WHERE NOT is_internal_transfer`
    # without having to handle NULLs.
    is_internal_transfer:  Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_credit_card_payment: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_emi:                Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Links
    linked_transaction_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("transactions.id", ondelete="SET NULL"), nullable=True,
    )
    emi_id:                Mapped[Optional[int]] = mapped_column(
        ForeignKey("emi_records.id", ondelete="SET NULL"), nullable=True,
    )

    source_file:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at:            Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )
    updated_at:            Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    # -------- relationships --------
    # NOTE: There are TWO independent FKs between Transaction and EMIRecord
    # (``emi_id`` here, and ``original_transaction_id`` on EMIRecord).
    # We deliberately do NOT use ``back_populates`` between them — that
    # would imply they're two ends of a single relationship, but they
    # point at different columns. Each side just navigates one direction.
    account: Mapped[Optional[Account]] = relationship(
        back_populates="transactions", foreign_keys=[account_id],
    )
    linked_transaction: Mapped[Optional["Transaction"]] = relationship(
        remote_side="Transaction.id", foreign_keys=[linked_transaction_id],
    )
    emi_record: Mapped[Optional["EMIRecord"]] = relationship(
        foreign_keys=[emi_id],
    )

    __table_args__ = (
        Index("idx_txn_date",            "date"),
        Index("idx_txn_vpa",             "vpa"),
        Index("idx_txn_merchant",        "merchant_name"),
        Index("idx_txn_category",        "category"),
        Index("idx_txn_subcategory",     "subcategory"),
        Index("idx_txn_account_type",    "account_type"),
        Index("idx_txn_account_name",    "account_name"),
        Index("idx_txn_internal",        "is_internal_transfer"),
        Index("idx_txn_ccpay",           "is_credit_card_payment"),
        Index("idx_txn_emi",             "is_emi"),
        Index("idx_txn_refund",          "is_refund"),
        Index("idx_txn_refund_cat",      "refund_category"),
        Index("idx_txn_cat_source",      "categorization_source"),
    )


# ---------------------------------------------------------------------------
# categorization_rules
# ---------------------------------------------------------------------------


class CategorizationRule(Base):
    """A persistent categorisation rule. Survives across uploads.

    Every rule produces a (category, subcategory, sub_subcategory) tuple
    when its predicate matches a transaction. Predicate evaluation is
    delegated to :class:`services.rule_engine.RuleEngine`.

    ``rule_type`` selects the predicate family:

    * ``vpa`` / ``merchant`` – exact (case-insensitive, trimmed) match
      against the corresponding transaction column. ``rule_value`` holds
      the literal to match.
    * ``keyword`` – substring search on description.
    * ``heuristic`` – evaluates :attr:`conditions_json` against the row
      (time-of-day, day-of-week, amount band, txn type, txn mode, …).
      ``rule_value`` is repurposed as the rule identifier (so the unique
      index continues to dedupe).

    ``is_system`` distinguishes built-in rules (Rapido, Salary detection,
    …) from user-defined ones; system rules can be disabled but not
    deleted from the UI. ``priority`` is evaluated **lower-first**.
    """

    __tablename__ = "categorization_rules"

    id:              Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_type:       Mapped[str]  = mapped_column(String, nullable=False)
    rule_value:      Mapped[str]  = mapped_column(String, nullable=False)
    category:        Mapped[str]  = mapped_column(String, nullable=False)
    subcategory:     Mapped[Optional[str]] = mapped_column(String, nullable=True)
    sub_subcategory: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Friendly name shown in the UI ("Rapido Commute"). Defaults to
    # ``"<rule_type>: <rule_value>"`` when omitted.
    name:            Mapped[Optional[str]] = mapped_column(String, nullable=True)
    description:     Mapped[Optional[str]] = mapped_column(String, nullable=True)
    enabled:         Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_system:       Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # JSON blob for heuristic rules – ignored for vpa/merchant/keyword.
    # Stored as TEXT so callers can use json.loads/dumps; keeps schema
    # simple on SQLite without adding a JSON1 dependency.
    conditions_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    priority:        Mapped[int]  = mapped_column(Integer, nullable=False, default=100)
    created_at:      Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )
    updated_at:      Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    __table_args__ = (
        UniqueConstraint("rule_type", "rule_value", name="uq_rule_type_value"),
        Index("idx_rule_type", "rule_type"),
        Index("idx_rule_value", "rule_value"),
        Index("idx_rule_enabled", "enabled"),
    )


# ---------------------------------------------------------------------------
# emi_records
# ---------------------------------------------------------------------------


class EMIRecord(Base):
    """An EMI plan associated with one *original* transaction.

    The original transaction is kept with ``is_emi=True``; analytics use
    a virtual monthly-amount projection (in :mod:`services.analytics_service`)
    so the lump-sum doesn't dominate the month it was charged.
    """

    __tablename__ = "emi_records"

    id:                       Mapped[int]   = mapped_column(Integer, primary_key=True, autoincrement=True)
    original_transaction_id:  Mapped[str]   = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False, unique=True,
    )
    total_amount:             Mapped[float] = mapped_column(Float, nullable=False)
    tenure_months:            Mapped[int]   = mapped_column(Integer, nullable=False)
    monthly_amount:           Mapped[float] = mapped_column(Float, nullable=False)
    start_date:               Mapped[date]  = mapped_column(Date, nullable=False)
    note:                     Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at:               Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )

    original_transaction: Mapped["Transaction"] = relationship(
        foreign_keys=[original_transaction_id],
    )


# ---------------------------------------------------------------------------
# uploads
# ---------------------------------------------------------------------------


class Upload(Base):
    """Audit-trail row per uploaded PDF.

    ``file_hash`` is the SHA-256 of the file contents so the same PDF
    re-uploaded under a different filename is recognised and skipped.
    """

    __tablename__ = "uploads"

    id:            Mapped[int]    = mapped_column(Integer, primary_key=True, autoincrement=True)
    filename:      Mapped[str]    = mapped_column(String, nullable=False)
    file_hash:     Mapped[str]    = mapped_column(String, nullable=False, unique=True)
    bank:          Mapped[str]    = mapped_column(String, nullable=False)
    txn_count:     Mapped[int]    = mapped_column(Integer, nullable=False)
    new_txn_count: Mapped[int]    = mapped_column(Integer, nullable=False)
    pages_parsed:  Mapped[int]    = mapped_column(Integer, nullable=False)
    notes:         Mapped[Optional[str]] = mapped_column(String, nullable=True)
    uploaded_at:   Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )


# ---------------------------------------------------------------------------
# cc_bill_links
# ---------------------------------------------------------------------------


class CCBillLink(Base):
    """A user-confirmed mapping between a savings-side bill-payment debit
    and the CC statement it settled.

    Why a dedicated table (instead of just relying on the boolean flag +
    ``linked_transaction_id`` on ``Transaction``)? Because a single
    bill-payment row often pays for a whole month's worth of CC purchases,
    not a single CC transaction — so the link is "savings row → (CC
    account, billing month)" rather than "savings row → one CC row". This
    lets the reconciliation view show "spend this month vs amount paid".

    The savings-side ``Transaction.is_credit_card_payment`` flag is still
    the source of truth for *exclusion from spend* — this table augments
    it with the explicit (account, period) the user attributed it to.
    """

    __tablename__ = "cc_bill_links"

    id:              Mapped[int]   = mapped_column(Integer, primary_key=True, autoincrement=True)
    savings_txn_id:  Mapped[str]   = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False, unique=True,
    )
    cc_account_name: Mapped[str]   = mapped_column(String, nullable=False)
    # ``YYYY-MM`` of the CC statement period this payment covers.
    billing_month:   Mapped[str]   = mapped_column(String, nullable=False)
    total_amount:    Mapped[float] = mapped_column(Float, nullable=False)
    created_at:      Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )

    savings_txn: Mapped["Transaction"] = relationship(
        foreign_keys=[savings_txn_id],
    )

    __table_args__ = (
        Index("idx_ccpay_account", "cc_account_name"),
        Index("idx_ccpay_month",   "billing_month"),
    )


# ---------------------------------------------------------------------------
# category_definitions  (user-editable 3-level taxonomy)
# ---------------------------------------------------------------------------


# Allowed values of ``CategoryDefinition.kind``.
CATEGORY_KIND_EXPENSE = "expense"
CATEGORY_KIND_INCOME  = "income"


class CategoryDefinition(Base):
    """The taxonomy that drives the category dropdowns.

    A self-referencing 3-level tree:

        level=1 (root)       parent_id IS NULL
          └─ level=2 (sub)   parent_id = a level-1 row
              └─ level=3     parent_id = a level-2 row

    Why a separate table (vs. embedding strings everywhere):

      * Allows the user to add / rename / archive categories without
        touching transactions.
      * Enforces "subcategory must belong to its parent" by traversal.
      * Powers UI dropdowns with one round-trip (``GET /api/categories``).

    Why we still store the *name* strings denormalised on Transaction:

      * Renaming a category should not silently rewrite history.
      * Transactions stay queryable with cheap string equality.

    Names are case-folded for dedup but the displayed casing is preserved
    via the ``name`` column (so you can have "Food" as the display name
    but "food" == "FOOD" for dedup).
    """

    __tablename__ = "category_definitions"

    id:         Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    name:       Mapped[str]  = mapped_column(String, nullable=False)
    level:      Mapped[int]  = mapped_column(Integer, nullable=False)   # 1, 2, 3
    parent_id:  Mapped[Optional[int]] = mapped_column(
        ForeignKey("category_definitions.id", ondelete="CASCADE"),
        nullable=True,
    )
    # 'expense' | 'income' — propagates from the root down. Stored on
    # every level so we can filter without a recursive CTE.
    kind:       Mapped[str]  = mapped_column(String, nullable=False, default=CATEGORY_KIND_EXPENSE)
    # Soft-delete flag — preserves history and rule references but hides
    # the row from dropdowns. Avoids the awkwardness of a hard delete on
    # a category that still has transactions.
    archived:   Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int]  = mapped_column(Integer, nullable=False, default=100)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )

    parent: Mapped[Optional["CategoryDefinition"]] = relationship(
        remote_side="CategoryDefinition.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[List["CategoryDefinition"]] = relationship(
        back_populates="parent", foreign_keys=[parent_id],
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        # Same name + same parent → blocked at the app layer (case-folded).
        # We don't add a UNIQUE here because SQLite treats NULL as distinct,
        # so root-level "Food" and "food" wouldn't be caught.
        Index("idx_catdef_parent", "parent_id"),
        Index("idx_catdef_level",  "level"),
        Index("idx_catdef_kind",   "kind"),
    )


# ---------------------------------------------------------------------------
# blinkit_orders  (Blinkit order-invoice extraction — v2 normalized schema)
# ---------------------------------------------------------------------------
#
# One PDF can contain several "Tax Invoice" pages (one per seller fulfilling
# part of the order, plus a logistics/handling-charge invoice from Blink
# Commerce itself). Each such page becomes one ``BlinkitOrder`` row, keyed
# by its own ``invoice_number``. Pages that are pure continuations (e.g. an
# "Annexure" charges table with no "Sold By" / "Invoice To" header) are
# *not* separate orders — the parser folds them into the preceding page's
# annexure_charges instead of fabricating a row with a null invoice number.
#
# Every monetary component Blinkit prints is broken out into its own
# column (rather than a single grand-total) so downstream analytics can
# separate "what I paid for goods" from "what I paid in fees" without
# re-parsing line items every time.

# Line-item classification — lets analytics distinguish real products from
# platform fees that happen to ride along as "line items" on some invoices.
BLINKIT_LINE_PRODUCT           = "product"
BLINKIT_LINE_DELIVERY_CHARGE   = "delivery_charge"
BLINKIT_LINE_HANDLING_CHARGE   = "handling_charge"
BLINKIT_LINE_CONVENIENCE_CHARGE = "convenience_charge"
BLINKIT_LINE_PACKAGING_CHARGE  = "packaging_charge"
BLINKIT_LINE_OTHER_CHARGE      = "other_charge"


class BlinkitOrder(Base):
    """One tax-invoice page extracted from a Blinkit order PDF.

    Dedup key is ``invoice_number`` — each seller invoice within an order
    has a unique number. A single PDF may contain multiple invoices/orders
    rows (one per seller + one logistics page from Blink Commerce).
    """

    __tablename__ = "blinkit_orders"

    id:                       Mapped[int]   = mapped_column(Integer, primary_key=True, autoincrement=True)
    invoice_number:           Mapped[str]   = mapped_column(String, nullable=False, unique=True)
    order_id:                 Mapped[Optional[str]] = mapped_column(String, nullable=True)
    invoice_date:             Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    order_date:               Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    delivery_date:            Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    place_of_supply:          Mapped[Optional[str]] = mapped_column(String, nullable=True)
    order_status:             Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- customer / delivery ----
    customer_name:            Mapped[Optional[str]] = mapped_column(String, nullable=True)
    customer_phone:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    delivery_address:         Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    delivery_city:            Mapped[Optional[str]] = mapped_column(String, nullable=True)
    delivery_state:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    delivery_pincode:         Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- seller (who fulfilled the items on this page) ----
    seller_name:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    seller_gstin:             Mapped[Optional[str]] = mapped_column(String, nullable=True)
    seller_fssai:             Mapped[Optional[str]] = mapped_column(String, nullable=True)
    seller_cin:               Mapped[Optional[str]] = mapped_column(String, nullable=True)
    seller_pan:               Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- store (dark-store / fulfillment center) ----
    store_name:               Mapped[Optional[str]] = mapped_column(String, nullable=True)
    store_address:            Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    store_city:               Mapped[Optional[str]] = mapped_column(String, nullable=True)
    store_state:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    store_pincode:            Mapped[Optional[str]] = mapped_column(String, nullable=True)
    store_gstin:              Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- platform (Blink Commerce footer — usually a different GSTIN) ----
    platform_company:         Mapped[Optional[str]] = mapped_column(String, nullable=True)
    platform_gstin:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    platform_fssai:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    platform_cin:             Mapped[Optional[str]] = mapped_column(String, nullable=True)
    platform_pan:             Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- charges breakdown (derived from item + annexure classification) ----
    item_total:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    delivery_fee:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    handling_charge:          Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    convenience_fee:          Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    packaging_charge:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    other_charges:            Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    discount_total:           Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    coupon_discount:          Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    taxable_value_total:      Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cgst_total:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sgst_total:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    igst_total:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cess_total:               Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    tax_total:                Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    round_off:                Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    grand_total:              Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    amount_paid:              Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    total_quantity:           Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    amount_in_words:          Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- payment (kept for forward-compatibility; Blinkit tax invoices
    # don't currently print these, so they stay NULL until a layout adds
    # them — the parser is written to populate them the moment it can) ----
    payment_method:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    payment_transaction_id:   Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # ---- other metadata ----
    reverse_charge:           Mapped[Optional[str]] = mapped_column(String, nullable=True)
    delivery_confirmation_otp: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    terms_and_conditions:     Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    has_annexure:             Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_continuation_merged:   Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ---- provenance ----
    source_file:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source_file_hash:         Mapped[Optional[str]] = mapped_column(String, nullable=True)
    page_number:              Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    pdf_metadata_json:        Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_text:                 Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at:               Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )
    updated_at:               Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    items: Mapped[List["BlinkitOrderItem"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
    )
    annexure_charges: Mapped[List["BlinkitAnnexureChargeRecord"]] = relationship(
        back_populates="order", cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_blinkit_order_id", "order_id"),
        Index("idx_blinkit_invoice_date", "invoice_date"),
        Index("idx_blinkit_source_file", "source_file"),
        Index("idx_blinkit_customer_name", "customer_name"),
        Index("idx_blinkit_seller_name", "seller_name"),
        Index("idx_blinkit_store_name", "store_name"),
        Index("idx_blinkit_pincode", "delivery_pincode"),
        Index("idx_blinkit_state", "delivery_state"),
    )


class BlinkitOrderItem(Base):
    """One line item from a Blinkit tax invoice.

    ``line_type`` distinguishes actual purchased products from platform
    fees that Blinkit sometimes prints as rows in the same item table
    (e.g. "Handling charge", "Late night convenience charge"). This lets
    analytics sum "real spend on goods" separately from fees without
    string-matching descriptions again.
    """

    __tablename__ = "blinkit_order_items"

    id:                   Mapped[int]   = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id:             Mapped[int]   = mapped_column(
        ForeignKey("blinkit_orders.id", ondelete="CASCADE"), nullable=False,
    )
    sr_no:                Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    upc:                  Mapped[Optional[str]] = mapped_column(String, nullable=True)
    hsn_code:             Mapped[Optional[str]] = mapped_column(String, nullable=True)
    product_name:         Mapped[str]   = mapped_column(String, nullable=False)
    brand:                Mapped[Optional[str]] = mapped_column(String, nullable=True)
    variant:              Mapped[Optional[str]] = mapped_column(String, nullable=True)
    size_weight:          Mapped[Optional[str]] = mapped_column(String, nullable=True)
    packaging:            Mapped[Optional[str]] = mapped_column(String, nullable=True)
    category:             Mapped[Optional[str]] = mapped_column(String, nullable=True)
    subcategory:          Mapped[Optional[str]] = mapped_column(String, nullable=True)
    mrp:                  Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    selling_price:        Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    discount:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    quantity:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    taxable_value:        Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cgst_pct:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cgst_inr:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sgst_pct:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sgst_inr:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    igst_pct:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    igst_inr:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cess_pct:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cess_inr:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    additional_cess_val:  Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    total_amount:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    line_type:            Mapped[str] = mapped_column(String, nullable=False, default=BLINKIT_LINE_PRODUCT)
    raw_description:      Mapped[Optional[str]] = mapped_column(String, nullable=True)

    order: Mapped["BlinkitOrder"] = relationship(back_populates="items")

    __table_args__ = (
        Index("idx_blinkit_item_order", "order_id"),
        Index("idx_blinkit_item_product", "product_name"),
        Index("idx_blinkit_item_upc", "upc"),
        Index("idx_blinkit_item_line_type", "line_type"),
    )


class BlinkitAnnexureChargeRecord(Base):
    """Delivery / handling charge breakdown from invoice annexure."""

    __tablename__ = "blinkit_annexure_charges"

    id:               Mapped[int]   = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id:         Mapped[int]   = mapped_column(
        ForeignKey("blinkit_orders.id", ondelete="CASCADE"), nullable=False,
    )
    sr_no:            Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    nature_of_charge: Mapped[str]   = mapped_column(String, nullable=False)
    tax_rate:         Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cess_rate:        Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    taxable_value:    Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cgst:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sgst:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cess:             Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    order: Mapped["BlinkitOrder"] = relationship(back_populates="annexure_charges")


class BlinkitProductCategoryRecord(Base):
    """Cached LLM/rule-based category for a normalized product key.

    ``product_key`` is derived from UPC (preferred) or normalized product
    name so the same SKU always maps to one category across orders.
    """

    __tablename__ = "blinkit_product_categories"

    id:           Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_key:  Mapped[str]  = mapped_column(String, nullable=False, unique=True)
    product_name: Mapped[str]  = mapped_column(String, nullable=False)
    category:     Mapped[str]  = mapped_column(String, nullable=False, default="Others")
    subcategory:  Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source:       Mapped[str]  = mapped_column(String, nullable=False, default="rules")
    ai_categorized: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ai_model:     Mapped[Optional[str]] = mapped_column(String, nullable=True)
    ai_categorized_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    prompt_version: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    category_version: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    confidence_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_at:   Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )
    updated_at:   Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    __table_args__ = (
        Index("idx_blinkit_prod_cat_category", "category"),
    )


class BlinkitParseErrorRecord(Base):
    """Log of PDF pages/files that failed to parse or persist.

    ``stage`` distinguishes where the failure happened (``extract`` — could
    not pull text/tables off the page; ``persist`` — parsed fine but the DB
    write failed, e.g. a constraint violation) so the UI/log can tell
    "bad PDF" apart from "bad data going into the DB".
    """

    __tablename__ = "blinkit_parse_errors"

    id:           Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_file:  Mapped[str]  = mapped_column(String, nullable=False)
    page:         Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    stage:        Mapped[str]  = mapped_column(String, nullable=False, default="extract")
    reason:       Mapped[str]  = mapped_column(String, nullable=False)
    snippet:      Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at:   Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )


class AppSetting(Base):
    """Key-value application settings (API keys, feature flags, etc.)."""

    __tablename__ = "app_settings"

    key:        Mapped[str]  = mapped_column(String, primary_key=True)
    value:      Mapped[str]  = mapped_column(String, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )


class BlinkitScannedFileRecord(Base):
    """Audit trail of every PDF file processed by the scanner."""

    __tablename__ = "blinkit_scanned_files"

    id:              Mapped[int]  = mapped_column(Integer, primary_key=True, autoincrement=True)
    filename:        Mapped[str]  = mapped_column(String, nullable=False)
    file_hash:       Mapped[str]  = mapped_column(String, nullable=False, unique=True)
    pages_found:     Mapped[int]  = mapped_column(Integer, nullable=False, default=0)
    orders_extracted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    scan_count:      Mapped[int]  = mapped_column(Integer, nullable=False, default=1)
    last_scanned_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )
    created_at:      Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp(),
    )

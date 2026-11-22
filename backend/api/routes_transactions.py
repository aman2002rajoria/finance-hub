"""Transaction CRUD + filtering + flag toggles."""

from __future__ import annotations

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from api.schemas import (
    BulkApplyIn, BulkApplyResult,
    CCBillLinkOut, CCPaymentCandidate, CounterpartyGroup, CounterpartySummary,
    LinkTransferIn, MarkCCPaymentIn, TransactionDetail, TransactionListOut,
    TransactionOut, TransactionPatch, TransferCandidate,
)
from db.database import fastapi_session
from db.models import (
    ACCOUNT_TYPE_SAVINGS, CATEGORIZATION_SOURCE_MANUAL,
    RULE_TYPE_MERCHANT, RULE_TYPE_VPA,
    TXN_TYPE_CREDIT, TXN_TYPE_DEBIT, CategorizationRule, CCBillLink, Transaction,
)
from services import (
    AnalyticsService, CategorizationService, CategoryTaxonomyService,
    LinkingService,
)
from utils.tagging import (
    category_tagged_predicate, category_untagged_predicate, normalize_category_value,
)
from utils.grouping import bank_handle_vpa_sql, usable_vpa_sql


router = APIRouter(prefix="/api/transactions", tags=["transactions"])


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------


def _hydrate_rule_name(db: Session, txns: List[Transaction]) -> dict[int, str]:
    """Resolve rule_id → friendly name for a list of rows in one query."""
    ids = {t.categorized_by_rule_id for t in txns if t.categorized_by_rule_id}
    if not ids:
        return {}
    rows = db.execute(
        select(CategorizationRule.id, CategorizationRule.name, CategorizationRule.rule_type, CategorizationRule.rule_value)
        .where(CategorizationRule.id.in_(ids))
    ).all()
    out: dict[int, str] = {}
    for r in rows:
        out[r.id] = r.name or f"{r.rule_type.title()}: {r.rule_value}"
    return out


def _txn_to_out(t: Transaction, rule_name_lookup: Optional[dict[int, str]] = None) -> TransactionOut:
    out = TransactionOut.model_validate(t)
    if rule_name_lookup is not None and t.categorized_by_rule_id:
        out.categorized_by_rule_name = rule_name_lookup.get(t.categorized_by_rule_id)
    return out


# ---------------------------------------------------------------------------
# List + filter
# ---------------------------------------------------------------------------


_TXN_SORT_KEYS = {
    "date":        Transaction.date,
    "amount":      Transaction.amount,
    "description": Transaction.description,
    "category":    Transaction.category,
    "account":     Transaction.account_name,
}


@router.get("", response_model=TransactionListOut)
def list_transactions(
    account_name:        Optional[str]  = Query(None),
    account_type:        Optional[str]  = Query(None),
    type_:               Optional[str]  = Query(None, alias="type"),
    category:            Optional[str]  = Query(None),
    subcategory:         Optional[str]  = Query(None),
    search:              Optional[str]  = Query(None),
    date_from:           Optional[date] = Query(None),
    date_to:             Optional[date] = Query(None),
    is_internal:         Optional[bool] = Query(None),
    is_cc_payment:       Optional[bool] = Query(None),
    is_emi:              Optional[bool] = Query(None),
    uncategorized:       Optional[bool] = Query(None),
    tag_status:          Optional[str]  = Query(
        None,
        description="Filter by category tag: all | tagged | untagged",
    ),
    vpa:                 Optional[str]  = Query(None),
    merchant_name:       Optional[str]  = Query(None),
    categorized_by_rule_id: Optional[int] = Query(None, description="Filter by rule that categorized the row"),
    sort_by:             str = Query("date", description="date | amount | description | category | account"),
    sort_dir:            str = Query("desc", description="asc | desc"),
    limit:               int = Query(500, ge=1, le=5000),
    offset:              int = Query(0, ge=0),
    db: Session = Depends(fastapi_session),
) -> TransactionListOut:
    """Filter and paginate the ledger.

    All query params are AND-ed together. ``search`` is a free-text
    case-insensitive substring match on description + merchant + VPA.
    """
    conds = []
    if account_name:    conds.append(Transaction.account_name == account_name)
    if account_type:    conds.append(Transaction.account_type == account_type)
    if type_:           conds.append(Transaction.type == type_)
    if category:
        if category.lower() == "uncategorized":
            conds.append(category_untagged_predicate())
        else:
            conds.append(Transaction.category == category)
    if subcategory:
        if subcategory.lower() == "uncategorized":
            conds.append(or_(Transaction.subcategory.is_(None), Transaction.subcategory == ""))
        else:
            conds.append(Transaction.subcategory == subcategory)
    if date_from:       conds.append(Transaction.date >= date_from)
    if date_to:         conds.append(Transaction.date <= date_to)
    if is_internal is not None:    conds.append(Transaction.is_internal_transfer.is_(is_internal))
    if is_cc_payment is not None:  conds.append(Transaction.is_credit_card_payment.is_(is_cc_payment))
    if is_emi is not None:         conds.append(Transaction.is_emi.is_(is_emi))
    if uncategorized:
        conds.append(category_untagged_predicate())
    tag = (tag_status or "").strip().lower()
    # Tagged/untagged semantics: see utils/tagging.py and docs/CATEGORIZATION.md
    if tag == "untagged":
        conds.append(category_untagged_predicate())
    elif tag == "tagged":
        conds.append(category_tagged_predicate())
    if vpa:                        conds.append(func.lower(Transaction.vpa) == vpa.lower())
    if merchant_name:              conds.append(func.lower(Transaction.merchant_name) == merchant_name.lower())
    if categorized_by_rule_id is not None:
        conds.append(Transaction.categorized_by_rule_id == categorized_by_rule_id)
    if search:
        like = f"%{search.lower()}%"
        conds.append(or_(
            func.lower(Transaction.description).like(like),
            func.lower(Transaction.merchant_name).like(like),
            func.lower(Transaction.vpa).like(like),
        ))

    base_q = select(Transaction).where(and_(*conds)) if conds else select(Transaction)
    total = db.scalar(
        select(func.count()).select_from(base_q.subquery())
    ) or 0

    sort_col = _TXN_SORT_KEYS.get((sort_by or "date").lower(), Transaction.date)
    desc = (sort_dir or "desc").lower() != "asc"
    order_cols = [sort_col.desc() if desc else sort_col.asc(), Transaction.id.desc()]
    rows = list(db.scalars(
        base_q.order_by(*order_cols).limit(limit).offset(offset)
    ))
    rule_names = _hydrate_rule_name(db, rows)
    return TransactionListOut(
        transactions=[_txn_to_out(r, rule_names) for r in rows],
        total=int(total),
    )


# ---------------------------------------------------------------------------
# Single row patch
# ---------------------------------------------------------------------------


@router.patch("/{txn_id}", response_model=TransactionOut)
def patch_transaction(
    txn_id: str,
    body: TransactionPatch,
    db: Session = Depends(fastapi_session),
) -> TransactionOut:
    """Partial update — categories, refund toggle, internal/CC flags.

    Validation rules (mirrors PART 9 of the spec):
      * A refund can only be set on a CREDIT row.
      * A refund must reference a category that absorbs it.
      * The (cat, sub, sub-sub) triple must be internally consistent with
        the taxonomy whenever the path is known to it.
    """
    t = db.get(Transaction, txn_id)
    if not t:
        raise HTTPException(404, f"Transaction {txn_id} not found")

    cat_svc = CategorizationService(db)
    link_svc = LinkingService(db)
    taxonomy = CategoryTaxonomyService(db)

    # Treat ``""`` as "clear this field" so the UI can wipe a value
    # without using the absent/present distinction.
    def _clean(s):
        if s is None:
            return None
        s = s.strip()
        return s or ""   # "" means explicit clear

    cat       = _clean(body.category)
    sub       = _clean(body.subcategory)
    subsub    = _clean(body.sub_subcategory)
    refund_cat = _clean(body.refund_category)

    # --- 1. Category fields (any of the three present?) -----------------
    cat_changed = any(x is not None for x in (cat, sub, subsub))
    if cat_changed:
        new_cat    = cat    if cat    is not None else t.category
        new_sub    = sub    if sub    is not None else t.subcategory
        new_subsub = subsub if subsub is not None else t.sub_subcategory
        # Convert empty-string sentinels back to NULL for the DB.
        new_cat    = normalize_category_value(new_cat)
        new_sub    = new_sub    or None
        new_subsub = new_subsub or None

        err = taxonomy.validate_path(new_cat, new_sub, new_subsub)
        if err:
            raise HTTPException(status_code=400, detail=err)

        # The category service stamps categorization_source="manual" and
        # clears the rule pointer so the audit chip says "Manual" after
        # the user touches the row.
        cat_svc.set_transaction_category(
            txn_id=txn_id,
            category=new_cat,
            subcategory=new_sub,
            sub_subcategory=new_subsub,
            propagate_via=body.propagate_via,
            source=CATEGORIZATION_SOURCE_MANUAL,
        )
        t = db.get(Transaction, txn_id)  # re-fetch post-commit

    # --- 2. Refund toggle ---------------------------------------------
    if body.is_refund is not None or refund_cat is not None:
        new_is_refund = body.is_refund if body.is_refund is not None else t.is_refund
        new_refund_cat = refund_cat if refund_cat is not None else t.refund_category
        new_refund_cat = (new_refund_cat or None)

        if new_is_refund:
            if t.type != TXN_TYPE_CREDIT:
                raise HTTPException(400, "Refund can only be set on a credit row.")
            if not new_refund_cat and not t.category:
                raise HTTPException(
                    400, "Refund requires a category to offset (set 'refund_category' "
                         "or 'category' first).",
                )
            # If user didn't pass refund_category, fall back to the row's
            # own category — the spec calls these out as functionally
            # equivalent when only one is set.
            if not new_refund_cat:
                new_refund_cat = t.category
        else:
            # Clearing the refund flag clears the offset category too,
            # so the row goes back to behaving like income.
            new_refund_cat = None

        t.is_refund = bool(new_is_refund)
        t.refund_category = new_refund_cat
        db.commit()

    # --- 3. Linking flags ----------------------------------------------
    if body.is_internal_transfer is not None:
        link_svc.toggle_internal_transfer(txn_id, body.is_internal_transfer)
    if body.is_credit_card_payment is not None:
        link_svc.toggle_cc_payment(txn_id, body.is_credit_card_payment)

    db.refresh(t)
    rule_names = _hydrate_rule_name(db, [t])
    return _txn_to_out(t, rule_names)


# ---------------------------------------------------------------------------
# Counterparty groups (left pane on the Categorize screen)
# ---------------------------------------------------------------------------


# Sort keys accepted by the /counterparties endpoint. Mapped here (not
# inline in the handler) so any change is documented + validated.
_COUNTERPARTY_SORT_KEYS = {
    "txn_count":           ("txn_count",            True),
    "total_debit":         ("total_debit",          True),
    "total_credit":        ("total_credit",         True),
    "net_amount":          ("net_amount",           False),  # negative = bigger out-flow at top
    "uncategorized_count": ("uncategorized_count",  True),
    "total_amount":        ("total_amount",         True),
    "label":               ("label",                False),
    "last_date":           ("last_date",            True),
}


def _summary_columns():
    """Aggregate columns used by the counterparties endpoint.

    Centralising the expressions here means the same definition is used
    for VPA-keyed and merchant-keyed groups, and matches what
    AnalyticsService.counterparty_summary returns.
    """
    debit_amt  = case((Transaction.type == TXN_TYPE_DEBIT,  Transaction.amount), else_=0.0)
    credit_amt = case((Transaction.type == TXN_TYPE_CREDIT, Transaction.amount), else_=0.0)
    # Tagged = non-null, non-empty category (see utils/tagging.py).
    uncat = case(
        (or_(Transaction.category.is_(None), Transaction.category == ""), 1),
        else_=0,
    )
    return {
        "n":           func.count(Transaction.id),
        "total_amt":   func.coalesce(func.sum(Transaction.amount), 0.0),
        "debit_amt":   func.coalesce(func.sum(debit_amt), 0.0),
        "credit_amt":  func.coalesce(func.sum(credit_amt), 0.0),
        "uncat_n":     func.coalesce(func.sum(uncat), 0),
        "last_date":   func.max(Transaction.date),
    }


def _real_flow_predicate():
    """Same exclusion as AnalyticsService — drops internal transfers, CC
    bill payments and EMI lump-sums so the panel reflects real flow."""
    return and_(
        Transaction.is_internal_transfer.is_(False),
        Transaction.is_credit_card_payment.is_(False),
        Transaction.is_emi.is_(False),
    )


@router.get("/counterparties", response_model=List[CounterpartyGroup])
def list_counterparties(
    only_uncategorized: bool = Query(
        False,
        description="Deprecated — use tag_status=untagged instead.",
    ),
    tag_status: Optional[str] = Query(
        None,
        description="Filter groups: all | tagged (fully categorised) | untagged (has gaps)",
    ),
    sort_by: str = Query(
        "uncategorized_count",
        description=(
            "One of: txn_count | total_debit | total_credit | net_amount | "
            "uncategorized_count | total_amount | label | last_date"
        ),
    ),
    sort_dir: str = Query("desc", description="asc | desc"),
    limit: int = Query(500, ge=1, le=5000),
    db: Session = Depends(fastapi_session),
) -> List[CounterpartyGroup]:
    """Group transactions for the Categorize tab.

    Grouping strategy (``utils/grouping.py``):
      * Usable VPA (not a bank PSP handle) → VPA group.
      * Bank-handle VPA or no VPA → merchant/counterparty group.
      * Neither → unmatched bucket.
    """
    cols = _summary_columns()
    flow = _real_flow_predicate()

    # ---- Usable-VPA groups (excludes axisbank/icici/sbi rails) -----------
    vpa_q = (
        select(
            Transaction.vpa.label("label"),
            cols["n"].label("n"),
            cols["total_amt"].label("total_amt"),
            cols["debit_amt"].label("debit_amt"),
            cols["credit_amt"].label("credit_amt"),
            cols["uncat_n"].label("uncat_n"),
            cols["last_date"].label("last_date"),
        )
        .where(usable_vpa_sql(), flow)
        .group_by(Transaction.vpa)
    )

    # ---- Merchant groups (no usable VPA — includes bank-handle VPAs) ----
    mch_q = (
        select(
            Transaction.merchant_name.label("label"),
            cols["n"].label("n"),
            cols["total_amt"].label("total_amt"),
            cols["debit_amt"].label("debit_amt"),
            cols["credit_amt"].label("credit_amt"),
            cols["uncat_n"].label("uncat_n"),
            cols["last_date"].label("last_date"),
        )
        .where(
            Transaction.merchant_name.is_not(None),
            or_(Transaction.vpa.is_(None), bank_handle_vpa_sql()),
            flow,
        )
        .group_by(Transaction.merchant_name)
    )

    tag = (tag_status or "").strip().lower()
    if not tag and only_uncategorized:
        tag = "untagged"

    def _passes_tag_filter(g: CounterpartyGroup) -> bool:
        if tag in ("", "all"):
            return True
        if tag == "untagged":
            return g.uncategorized_count > 0
        if tag == "tagged":
            return g.uncategorized_count == 0
        return True

    out: List[CounterpartyGroup] = []
    for row in db.execute(vpa_q).all():
        g = _row_to_group(row, kind="vpa")
        if not _passes_tag_filter(g):
            continue
        out.append(g)
    for row in db.execute(mch_q).all():
        g = _row_to_group(row, kind="merchant")
        if not _passes_tag_filter(g):
            continue
        out.append(g)

    # ---- Unmatched (no VPA, no merchant) --------------------------------
    unmatched = db.execute(
        select(
            cols["n"].label("n"),
            cols["total_amt"].label("total_amt"),
            cols["debit_amt"].label("debit_amt"),
            cols["credit_amt"].label("credit_amt"),
            cols["uncat_n"].label("uncat_n"),
            cols["last_date"].label("last_date"),
        ).where(
            Transaction.vpa.is_(None),
            Transaction.merchant_name.is_(None),
            flow,
        )
    ).one()
    n_um         = int(unmatched.n or 0)
    uncat_um     = int(unmatched.uncat_n or 0)
    debit_um     = float(unmatched.debit_amt or 0.0)
    credit_um    = float(unmatched.credit_amt or 0.0)
    um_group = CounterpartyGroup(
        key="unmatched",
        label="(no VPA / merchant)",
        kind="unmatched",
        txn_count=n_um,
        total_amount=round(float(unmatched.total_amt or 0.0), 2),
        total_debit=round(debit_um, 2),
        total_credit=round(credit_um, 2),
        net_amount=round(credit_um - debit_um, 2),
        uncategorized_count=uncat_um,
        has_category=(n_um > 0 and uncat_um == 0),
        last_date=unmatched.last_date.isoformat() if unmatched.last_date else None,
    )
    if n_um > 0 and _passes_tag_filter(um_group):
        out.append(um_group)

    # ---- Sort + cap -----------------------------------------------------
    key, default_desc = _COUNTERPARTY_SORT_KEYS.get(
        sort_by, _COUNTERPARTY_SORT_KEYS["uncategorized_count"],
    )
    desc = (sort_dir.lower() != "asc") if sort_dir else default_desc

    def _sort_key(g: CounterpartyGroup):
        v = getattr(g, key)
        if v is None:
            # Keep None at the bottom regardless of direction.
            return (1, 0) if desc else (1, 0)
        return (0, v if not isinstance(v, str) else v.lower())

    out.sort(key=_sort_key, reverse=desc)
    return out[:limit]


def _row_to_group(row, kind: str) -> CounterpartyGroup:
    label = row.label
    n     = int(row.n or 0)
    total = float(row.total_amt or 0.0)
    deb   = float(row.debit_amt or 0.0)
    cre   = float(row.credit_amt or 0.0)
    uncat = int(row.uncat_n or 0)
    return CounterpartyGroup(
        key=f"{kind}:{label}",
        label=label,
        kind=kind,
        txn_count=n,
        total_amount=round(total, 2),
        total_debit=round(deb, 2),
        total_credit=round(cre, 2),
        net_amount=round(cre - deb, 2),
        uncategorized_count=uncat,
        has_category=(n > 0 and uncat == 0),
        last_date=row.last_date.isoformat() if row.last_date else None,
    )


# ---------------------------------------------------------------------------
# Bulk "apply to all similar" — robust grouping behind a single endpoint.
# ---------------------------------------------------------------------------


@router.post("/bulk-apply", response_model=BulkApplyResult)
def bulk_apply_category(
    body: BulkApplyIn,
    db: Session = Depends(fastapi_session),
) -> BulkApplyResult:
    """Apply a category triple to every transaction in a logical group.

    Why this endpoint exists (in addition to ``POST /api/rules``):

    * The rule-only flow only matched VPA-equality or merchant-equality —
      so bank-side flows like "Interest Credit" / "SB Interest" / "SAV INT
      paid" landed in different groups and required N separate clicks.
    * This endpoint accepts a single grouping ``kind`` (``vpa`` |
      ``merchant`` | ``description``) plus a value, applies the category
      to every match in one transaction, and (optionally) saves the rule.

    Validation: the (cat, sub, sub-sub) triple must be consistent with the
    taxonomy whenever the path is recognised.
    """
    err = CategoryTaxonomyService(db).validate_path(
        body.category, body.subcategory, body.sub_subcategory,
    )
    if err:
        raise HTTPException(400, err)

    try:
        result = CategorizationService(db).apply_category_to_group(
            kind=body.kind,
            value=body.value,
            category=body.category,
            subcategory=body.subcategory,
            sub_subcategory=body.sub_subcategory,
            save_rule=body.save_rule,
            source=CATEGORIZATION_SOURCE_MANUAL,
            vpa_value=body.vpa_value,
            merchant_value=body.merchant_value,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return BulkApplyResult(**result)


# ---------------------------------------------------------------------------
# VPA / merchant aggregate summary  (top panel on Categorize page)
# ---------------------------------------------------------------------------


@router.get("/vpa-summary", response_model=CounterpartySummary)
def vpa_summary(
    vpa:           Optional[str] = Query(None),
    merchant_name: Optional[str] = Query(None),
    db: Session = Depends(fastapi_session),
) -> CounterpartySummary:
    """Aggregate credit / debit / net for a single counterparty.

    Exactly one of ``vpa`` or ``merchant_name`` must be provided.
    Internal transfers and CC bill payments are excluded so the user
    sees the genuine economic flow.
    """
    if not vpa and not merchant_name:
        raise HTTPException(400, "Pass either 'vpa' or 'merchant_name'.")
    summary = AnalyticsService(db).counterparty_summary(
        vpa=vpa, merchant_name=merchant_name,
    )
    return CounterpartySummary(**summary)


# ---------------------------------------------------------------------------
# Single-transaction detail (right-hand drawer in the UI)
# ---------------------------------------------------------------------------


@router.get("/{txn_id}/detail", response_model=TransactionDetail)
def transaction_detail(
    txn_id: str,
    db: Session = Depends(fastapi_session),
) -> TransactionDetail:
    t = db.get(Transaction, txn_id)
    if not t:
        raise HTTPException(404, f"Transaction {txn_id} not found")

    linked = None
    if t.linked_transaction_id:
        other = db.get(Transaction, t.linked_transaction_id)
        if other:
            rule_names_other = _hydrate_rule_name(db, [other])
            linked = _txn_to_out(other, rule_names_other)

    cc_link = db.scalar(
        select(CCBillLink).where(CCBillLink.savings_txn_id == txn_id)
    )
    cc_link_out = CCBillLinkOut.model_validate(cc_link) if cc_link else None

    rule_names = _hydrate_rule_name(db, [t])
    return TransactionDetail(
        transaction=_txn_to_out(t, rule_names),
        linked_transaction=linked,
        cc_bill_link=cc_link_out,
    )


# ---------------------------------------------------------------------------
# Manual internal-transfer linking
# ---------------------------------------------------------------------------


@router.get("/{txn_id}/transfer-candidates", response_model=List[TransferCandidate])
def transfer_candidates(
    txn_id: str,
    db: Session = Depends(fastapi_session),
) -> List[TransferCandidate]:
    t = db.get(Transaction, txn_id)
    if not t:
        raise HTTPException(404, f"Transaction {txn_id} not found")
    candidates = LinkingService(db).find_transfer_candidates(txn_id)
    out: List[TransferCandidate] = []
    for c in candidates:
        out.append(TransferCandidate(
            id=c.id,
            date=c.date,
            description=c.description,
            amount=c.amount,
            type=c.type,
            account_name=c.account_name,
            amount_diff=round(abs(c.amount - t.amount), 2),
            day_diff=abs((c.date - t.date).days),
        ))
    return out


@router.post("/{txn_id}/link-internal-transfer")
def link_internal_transfer(
    txn_id: str,
    body: LinkTransferIn,
    db: Session = Depends(fastapi_session),
):
    if not LinkingService(db).link_internal_transfer(txn_id, body.partner_id):
        raise HTTPException(400, "Could not link these two transactions.")
    return {"status": "ok", "txn_id": txn_id, "partner_id": body.partner_id}


@router.post("/{txn_id}/unlink-internal-transfer")
def unlink_internal_transfer(
    txn_id: str,
    db: Session = Depends(fastapi_session),
):
    """Clears the flag on this row AND its mirror partner if present."""
    if not LinkingService(db).toggle_internal_transfer(txn_id, False):
        raise HTTPException(404, "Transaction not found.")
    return {"status": "ok", "txn_id": txn_id}


# ---------------------------------------------------------------------------
# Manual CC bill mapping
# ---------------------------------------------------------------------------


@router.get("/{txn_id}/cc-payment-candidates", response_model=List[CCPaymentCandidate])
def cc_payment_candidates(
    txn_id: str,
    db: Session = Depends(fastapi_session),
) -> List[CCPaymentCandidate]:
    t = db.get(Transaction, txn_id)
    if not t:
        raise HTTPException(404, f"Transaction {txn_id} not found")
    rows = LinkingService(db).find_cc_payment_candidates(txn_id)
    return [CCPaymentCandidate(**r) for r in rows]


@router.post("/{txn_id}/mark-cc-payment", response_model=CCBillLinkOut)
def mark_cc_payment(
    txn_id: str,
    body: MarkCCPaymentIn,
    db: Session = Depends(fastapi_session),
) -> CCBillLinkOut:
    link = LinkingService(db).mark_cc_bill_payment(
        txn_id=txn_id,
        cc_account_name=body.cc_account_name,
        billing_month=body.billing_month,
    )
    if link is None:
        raise HTTPException(404, "Transaction not found.")
    return CCBillLinkOut.model_validate(link)


@router.post("/{txn_id}/unlink-cc-payment")
def unlink_cc_payment(
    txn_id: str,
    db: Session = Depends(fastapi_session),
):
    LinkingService(db).unlink_cc_bill_payment(txn_id)
    return {"status": "ok", "txn_id": txn_id}

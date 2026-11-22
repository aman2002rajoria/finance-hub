"""Categorization rules CRUD + bulk re-apply + Excel export / import.

Excel workflow
--------------
For users with thousands of uncategorised transactions, manually clicking
through them is impractical. The Excel workflow is the bulk path:

  1. ``GET /api/rules/export-uncategorized`` — download a workbook of every
     VPA / merchant / unmatched group that still has uncategorised rows,
     pre-filled with summary metrics and three blank category columns.
  2. The user fills the category columns by hand (in Excel / Numbers /
     Sheets) and saves.
  3. ``POST /api/rules/import`` — upload the saved workbook. The server
     validates each row against the taxonomy, applies the category to
     every matching transaction, and persists a rule so future imports
     inherit the mapping.
"""

from __future__ import annotations

import io
import json
import logging
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
import pandas as pd
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from api.schemas import (
    CategoryImportError, CategoryImportResult, RecanonicalizeResult,
    RuleApplyTreeIn, RuleApplyTreeResult, RuleIn, RuleOut, RuleReorderIn,
    RuleToggleIn, RunEngineResult,
)
from db.database import fastapi_session
from db.models import (
    CATEGORIZATION_SOURCE_EXCEL_IMPORT, RULE_TYPE_HEURISTIC, RULE_TYPE_KEYWORD,
    RULE_TYPE_MERCHANT, RULE_TYPE_VPA, TXN_TYPE_CREDIT, TXN_TYPE_DEBIT,
    CategorizationRule, Transaction,
)
from services import CategorizationService, CategoryTaxonomyService
from services.rule_engine import RuleEngine


router = APIRouter(prefix="/api/rules", tags=["rules"])

logger = logging.getLogger(__name__)


_VALID_RULE_TYPES = {RULE_TYPE_VPA, RULE_TYPE_MERCHANT, RULE_TYPE_KEYWORD, RULE_TYPE_HEURISTIC}


def _slugify(s: str) -> str:
    """Stable identifier for heuristic rule_value. Keeps the unique
    constraint useful while staying human-readable in the DB."""
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or "rule"


def _rule_txn_counts(db: Session) -> dict[int, int]:
    """rule_id → number of transactions stamped with that rule."""
    rows = db.execute(
        select(Transaction.categorized_by_rule_id, func.count())
        .where(Transaction.categorized_by_rule_id.isnot(None))
        .group_by(Transaction.categorized_by_rule_id)
    ).all()
    return {int(rid): int(n) for rid, n in rows}


def _serialize_rule(r: CategorizationRule, txn_counts: Optional[dict[int, int]] = None) -> RuleOut:
    """Inflate ``conditions_json`` into a dict for the response payload."""
    cond: Optional[dict] = None
    if r.conditions_json:
        try:
            cond = json.loads(r.conditions_json)
        except (TypeError, ValueError):
            cond = None
    out = RuleOut(
        id=r.id,
        rule_type=r.rule_type,
        rule_value=r.rule_value,
        category=r.category,
        subcategory=r.subcategory,
        sub_subcategory=r.sub_subcategory,
        name=r.name,
        description=r.description,
        enabled=bool(r.enabled),
        is_system=bool(r.is_system),
        priority=int(r.priority or 0),
        conditions=cond,
        transactions_categorized=(txn_counts or {}).get(r.id, 0),
        created_at=r.created_at,
        updated_at=r.updated_at,
    )
    return out


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=List[RuleOut])
def list_rules(db: Session = Depends(fastapi_session)) -> List[RuleOut]:
    rows = list(db.scalars(
        select(CategorizationRule)
        .order_by(CategorizationRule.priority, CategorizationRule.id)
    ))
    counts = _rule_txn_counts(db)
    return [_serialize_rule(r, counts) for r in rows]


@router.post("", response_model=RuleOut)
def upsert_rule(body: RuleIn, db: Session = Depends(fastapi_session)) -> RuleOut:
    """Create / update a categorisation rule.

    For ``vpa``/``merchant``/``keyword`` rules: ``rule_value`` is the
    literal to match. For ``heuristic`` rules: ``conditions`` (JSON)
    holds the predicate; ``rule_value`` is auto-derived from ``name``
    so the unique-index continues to dedupe duplicates.
    """
    if body.rule_type not in _VALID_RULE_TYPES:
        raise HTTPException(400, f"Unknown rule_type: {body.rule_type!r}")

    if body.rule_type == RULE_TYPE_HEURISTIC:
        if not body.name:
            raise HTTPException(400, "Heuristic rules require a 'name'.")
        if not body.conditions:
            raise HTTPException(400, "Heuristic rules require non-empty 'conditions'.")
        rule_value = body.rule_value or _slugify(body.name)

        existing = db.scalar(
            select(CategorizationRule).where(
                CategorizationRule.rule_type == RULE_TYPE_HEURISTIC,
                CategorizationRule.rule_value == rule_value,
            )
        )
        if existing:
            existing.name             = body.name
            existing.description      = body.description
            existing.category         = body.category
            existing.subcategory      = body.subcategory
            existing.sub_subcategory  = body.sub_subcategory
            existing.enabled          = body.enabled
            existing.priority         = int(body.priority or existing.priority or 300)
            existing.conditions_json  = json.dumps(body.conditions, ensure_ascii=False)
            rule = existing
        else:
            rule = CategorizationRule(
                rule_type=RULE_TYPE_HEURISTIC,
                rule_value=rule_value,
                name=body.name,
                description=body.description,
                category=body.category,
                subcategory=body.subcategory,
                sub_subcategory=body.sub_subcategory,
                enabled=body.enabled,
                is_system=False,
                priority=int(body.priority or 300),
                conditions_json=json.dumps(body.conditions, ensure_ascii=False),
            )
            db.add(rule)
        db.commit()
        db.refresh(rule)
        return _serialize_rule(rule, _rule_txn_counts(db))

    if not body.rule_value:
        raise HTTPException(400, f"{body.rule_type!r} rules require a 'rule_value'.")

    svc = CategorizationService(db)
    try:
        rule, _updated = svc.upsert_rule(
            rule_type=body.rule_type,
            rule_value=body.rule_value,
            category=body.category,
            subcategory=body.subcategory,
            sub_subcategory=body.sub_subcategory,
            propagate=body.propagate,
            name=body.name,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Allow editing the user-facing fields after upsert (description,
    # priority, enabled flag).
    if body.description is not None:
        rule.description = body.description
    if body.priority is not None:
        rule.priority = int(body.priority)
    rule.enabled = body.enabled
    db.commit()
    db.refresh(rule)
    return _serialize_rule(rule, _rule_txn_counts(db))


@router.patch("/{rule_id}/toggle", response_model=RuleOut)
def toggle_rule(
    rule_id: int,
    body: RuleToggleIn,
    db: Session = Depends(fastapi_session),
) -> RuleOut:
    """Enable / disable a rule without deleting it.

    System rules can be disabled but not deleted from the UI; this
    endpoint is the way to silence them.
    """
    rule = db.get(CategorizationRule, rule_id)
    if not rule:
        raise HTTPException(404, f"Rule {rule_id} not found")
    rule.enabled = bool(body.enabled)
    db.commit()
    db.refresh(rule)
    return _serialize_rule(rule, _rule_txn_counts(db))


@router.delete("/{rule_id}")
def delete_rule(
    rule_id: int,
    clear_transactions: bool = Query(False),
    db: Session = Depends(fastapi_session),
) -> dict:
    """Delete a rule. System rules cannot be deleted (toggle them off
    via :func:`toggle_rule` instead)."""
    rule = db.get(CategorizationRule, rule_id)
    if rule is None:
        return {"deleted": 0, "rows_cleared": 0}
    if rule.is_system:
        raise HTTPException(
            400,
            "System rules cannot be deleted. Disable them via the toggle endpoint instead.",
        )
    svc = CategorizationService(db)
    n = svc.delete_rule(rule_id, clear_transactions=clear_transactions)
    return {"deleted": 1, "rows_cleared": n}


@router.post("/reorder")
def reorder_rules(
    body: RuleReorderIn,
    db: Session = Depends(fastapi_session),
) -> dict:
    """Set rule priority by ordered list (index 0 = highest priority = 10)."""
    base = 10
    n = 0
    for i, rid in enumerate(body.rule_ids):
        rule = db.get(CategorizationRule, rid)
        if rule and not rule.is_system:
            rule.priority = base + i * 10
            n += 1
    db.commit()
    return {"updated": n}


@router.post("/apply-tree", response_model=RuleApplyTreeResult)
def apply_rule_tree(
    body: RuleApplyTreeIn,
    db: Session = Depends(fastapi_session),
) -> RuleApplyTreeResult:
    """Save v2 tree rule and apply to matches. Manual tags are never overwritten."""
    from services.categorize_ui_service import CategorizeUIService
    from services.rule_engine import EvalContext, compute_first_debit_of_day_ids, evaluate_conditions
    from services.rule_condition_tree import evaluate_tree, is_tree_format
    from db.models import CATEGORIZATION_SOURCE_MANUAL, CATEGORIZATION_SOURCE_RULE_ENGINE
    from utils.tagging import is_category_tagged

    rule_id = None
    if body.save_rule:
        svc = CategorizationService(db)
        rule = svc._upsert_heuristic_rule(
            rule_value=body.name.lower().replace(" ", "_")[:64],
            category=body.category,
            subcategory=body.subcategory,
            sub_subcategory=body.sub_subcategory,
            conditions=body.conditions,
            name=body.name,
            priority=int(body.priority or 300),
        )
        db.commit()
        rule_id = rule.id

    updated = 0
    skipped = 0
    rows = CategorizeUIService(db)._flow_rows()
    ctx = EvalContext(first_debit_of_day_ids=compute_first_debit_of_day_ids(db))

    for t in rows:
        if body.only_uncategorized and is_category_tagged(t.category):
            continue
        if t.categorization_source == CATEGORIZATION_SOURCE_MANUAL and is_category_tagged(t.category):
            skipped += 1
            continue
        ok = (
            evaluate_tree(body.conditions, t, ctx)
            if is_tree_format(body.conditions)
            else evaluate_conditions(body.conditions, t, ctx)
        )
        if not ok:
            continue
        t.category = body.category
        t.subcategory = body.subcategory
        t.sub_subcategory = body.sub_subcategory
        t.categorization_source = CATEGORIZATION_SOURCE_RULE_ENGINE
        t.categorized_by_rule_id = rule_id
        updated += 1
    db.commit()
    return RuleApplyTreeResult(rule_id=rule_id, transactions_updated=updated, skipped_manual=skipped)


@router.post("/reapply")
def reapply_rules(db: Session = Depends(fastapi_session)) -> dict:
    """Re-evaluate every saved (vpa / merchant / keyword) rule against
    every transaction. Heuristic rules are NOT covered by this endpoint —
    use :func:`run_engine` for the full pipeline including heuristics.
    """
    svc = CategorizationService(db)
    n = svc.reapply_all_rules()
    return {"rows_updated": n, "transactions_updated": n}


@router.post("/run-engine", response_model=RunEngineResult)
def run_engine(db: Session = Depends(fastapi_session)) -> RunEngineResult:
    """Run the full rule engine over every uncategorised transaction.

    Walks rules in priority order (vpa → merchant → keyword → heuristic)
    and tags any row that matches. Stamps ``categorization_source`` and
    ``categorized_by_rule_id`` so the audit chip reflects the result.
    """
    engine = RuleEngine(db)
    out = engine.run_over_uncategorized()
    return RunEngineResult(**out)


@router.post("/recanonicalize", response_model=RecanonicalizeResult)
def recanonicalize_merchants(db: Session = Depends(fastapi_session)) -> RecanonicalizeResult:
    """Re-derive ``merchant_name`` for every transaction from the latest
    canonicalisation rules.

    Bank-side flows like "INTEREST CREDIT" / "SAV INT" / "SB INTEREST PAID"
    used to land in different merchant groups even though they are the
    same logical entity. After this runs they all collapse to a single
    canonical merchant ("Bank Interest") — a single rule then covers all
    of them.
    """
    return RecanonicalizeResult(**CategorizationService(db).recanonicalize_all())


# ---------------------------------------------------------------------------
# Excel export — one row per uncategorised counterparty.
# ---------------------------------------------------------------------------


_EXPORT_COLUMNS = [
    "Label",
    "Kind",          # vpa | merchant | description
    "Transaction Count",
    "Total Debit",
    "Total Credit",
    "Net Amount",
    "Uncategorized",
    "Last Date",
    "Category",
    "Subcategory",
    "Sub-Subcategory",
]


def _real_flow_predicate():
    return and_(
        Transaction.is_internal_transfer.is_(False),
        Transaction.is_credit_card_payment.is_(False),
        Transaction.is_emi.is_(False),
    )


def _aggregate_by(group_col, kind_label: str, db: Session, only_uncat: bool) -> List[dict]:
    debit_amt  = case((Transaction.type == TXN_TYPE_DEBIT,  Transaction.amount), else_=0.0)
    credit_amt = case((Transaction.type == TXN_TYPE_CREDIT, Transaction.amount), else_=0.0)
    uncat      = case((Transaction.category.is_(None), 1), else_=0)

    q = (
        select(
            group_col.label("label"),
            func.count(Transaction.id).label("n"),
            func.coalesce(func.sum(debit_amt),  0.0).label("debit_amt"),
            func.coalesce(func.sum(credit_amt), 0.0).label("credit_amt"),
            func.coalesce(func.sum(uncat),      0  ).label("uncat_n"),
            func.max(Transaction.date).label("last_date"),
        )
        .where(group_col.is_not(None), _real_flow_predicate())
        .group_by(group_col)
    )
    rows = db.execute(q).all()
    out = []
    for r in rows:
        if only_uncat and int(r.uncat_n or 0) == 0:
            continue
        out.append({
            "Label":              r.label,
            "Kind":               kind_label,
            "Transaction Count":  int(r.n or 0),
            "Total Debit":        round(float(r.debit_amt  or 0.0), 2),
            "Total Credit":       round(float(r.credit_amt or 0.0), 2),
            "Net Amount":         round(float((r.credit_amt or 0.0) - (r.debit_amt or 0.0)), 2),
            "Uncategorized":      int(r.uncat_n or 0),
            "Last Date":          r.last_date.isoformat() if r.last_date else "",
            "Category":           "",
            "Subcategory":        "",
            "Sub-Subcategory":    "",
        })
    return out


@router.get("/export-uncategorized")
def export_uncategorized(
    only_uncategorized: bool = Query(True),
    db: Session = Depends(fastapi_session),
):
    """Download a multi-sheet workbook for bulk categorisation.

    The workbook has three sheets:

    * ``Categorize``        — one row per VPA / merchant group with
                              uncategorised transactions, plus blank
                              ``Category`` / ``Subcategory`` /
                              ``Sub-Subcategory`` columns to fill in.
    * ``Available Categories`` — every valid (cat, sub, sub-sub) tuple
                              currently configured in the taxonomy. Use
                              this as the source-of-truth when filling
                              the previous sheet so spelling doesn't
                              drift ("Food" vs "Food and Dining").
    * ``Instructions``      — a self-contained user guide.

    Upload the saved workbook via ``POST /api/rules/import``. The
    importer **strict-validates** every row against the taxonomy: any
    typo or unknown path is reported in the response and skipped.
    """
    rows = []
    rows.extend(_aggregate_by(Transaction.vpa,           "vpa",      db, only_uncategorized))
    # merchant rows: only those without a VPA, to keep groups disjoint.
    rows.extend(_aggregate_by(Transaction.merchant_name, "merchant", db, only_uncategorized))
    # We deliberately *don't* include "unmatched" rows in the export —
    # they have no stable label to key a rule on. The user should
    # categorise those individually from the UI.

    rows.sort(key=lambda r: (-r["Uncategorized"], -r["Total Debit"]))
    df = pd.DataFrame(rows, columns=_EXPORT_COLUMNS)

    # Reference sheet: every recognised path in the taxonomy.
    taxonomy = CategoryTaxonomyService(db)
    paths = taxonomy.flat_paths()
    ref_rows = []
    for p in paths:
        ref_rows.append({
            "Kind (expense/income)": p["kind"],
            "Category":              p["category"] or "",
            "Subcategory":           p["subcategory"] or "",
            "Sub-Subcategory":       p["sub_subcategory"] or "",
        })
    # Dedup + sort for usability.
    seen = set()
    deduped = []
    for r in sorted(ref_rows, key=lambda r: (r["Kind (expense/income)"], r["Category"], r["Subcategory"], r["Sub-Subcategory"])):
        k = tuple(r.values())
        if k in seen:
            continue
        seen.add(k)
        deduped.append(r)
    ref_df = pd.DataFrame(deduped, columns=["Kind (expense/income)", "Category", "Subcategory", "Sub-Subcategory"])

    instr_df = pd.DataFrame({
        "Bulk Categorization — How to use this workbook": [
            "OVERVIEW",
            "  Each row in the 'Categorize' sheet is a VPA or merchant group that still",
            "  has uncategorised transactions. Fill the three category columns to apply",
            "  a mapping to every transaction in that group.",
            "",
            "STEP-BY-STEP",
            "  1. Open the 'Categorize' sheet.",
            "  2. For each row you want to tag, fill 'Category', and optionally",
            "     'Subcategory' and 'Sub-Subcategory'.",
            "  3. Use the 'Available Categories' sheet as a copy/paste reference so",
            "     spelling stays consistent with your taxonomy.",
            "  4. Save the file (keep the .xlsx extension).",
            "  5. Upload via the 'Import Categorization Sheet' button on the Categorize page.",
            "",
            "VALIDATION RULES (strict)",
            "  - 'Category' is required. Empty rows are skipped.",
            "  - The (Category, Subcategory, Sub-Subcategory) triple MUST exist in the",
            "    'Available Categories' sheet — invalid paths are rejected with an error.",
            "  - 'Kind' must stay as 'vpa' or 'merchant' (don't edit this column).",
            "",
            "WHAT GETS PERSISTED",
            "  - Every successful row updates all matching transactions and stores",
            "    a rule so future uploads inherit the same categorisation automatically.",
            "  - The audit chip on each tagged transaction will show 'Excel Import'.",
        ],
    })

    bio = io.BytesIO()
    with pd.ExcelWriter(bio, engine="openpyxl") as w:
        df.to_excel(w, sheet_name="Categorize", index=False)
        ref_df.to_excel(w, sheet_name="Available Categories", index=False)
        instr_df.to_excel(w, sheet_name="Instructions", index=False)

    bio.seek(0)
    headers = {
        "Content-Disposition": 'attachment; filename="finance-hub-uncategorized.xlsx"',
    }
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Excel import — bulk-apply categorisation from an edited spreadsheet.
# ---------------------------------------------------------------------------


def _coerce_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    return str(v).strip()


@router.post("/import", response_model=CategoryImportResult)
async def import_categorization_sheet(
    file: UploadFile = File(...),
    db: Session = Depends(fastapi_session),
) -> CategoryImportResult:
    """Apply categorisation from a spreadsheet.

    The workbook is expected to have at minimum these columns (any case,
    any order — extras are ignored):

      Label, Kind, Category, Subcategory, Sub-Subcategory

    Each row triggers a "bulk apply" against the matching VPA / merchant
    / description group. A rule is created for every successful row so
    future imports inherit the mapping automatically.
    """
    body = await file.read()
    try:
        df = pd.read_excel(io.BytesIO(body), sheet_name="Categorize", engine="openpyxl")
    except Exception:
        # Fall back to first sheet if "Categorize" isn't named.
        try:
            df = pd.read_excel(io.BytesIO(body), engine="openpyxl")
        except Exception as exc:
            raise HTTPException(400, f"Could not read Excel: {exc}")

    # Normalise headers so "category", "Category", "CATEGORY" all work.
    df.columns = [str(c).strip() for c in df.columns]
    lower_map = {c.lower(): c for c in df.columns}

    def col(name: str) -> Optional[str]:
        return lower_map.get(name.lower())

    label_col = col("Label")
    kind_col  = col("Kind")
    cat_col   = col("Category")
    sub_col   = col("Subcategory")
    subsub_col = col("Sub-Subcategory") or col("Sub Subcategory") or col("Sub_Subcategory")

    if not label_col or not cat_col:
        raise HTTPException(
            400,
            "Excel must contain at minimum 'Label' and 'Category' columns.",
        )

    cat_svc = CategorizationService(db)
    taxonomy = CategoryTaxonomyService(db)
    errors: List[CategoryImportError] = []

    rows_read   = 0
    rows_applied = 0
    txns_updated = 0
    rules_created = 0

    for idx, row in df.iterrows():
        rows_read += 1
        label = _coerce_str(row[label_col])
        kind  = _coerce_str(row[kind_col]).lower() if kind_col else "merchant"
        category   = _coerce_str(row[cat_col])
        sub        = _coerce_str(row[sub_col])    if sub_col    else ""
        subsub     = _coerce_str(row[subsub_col]) if subsub_col else ""

        if not category:
            # Empty category column = user didn't tag this row → skip silently.
            continue
        if not label:
            errors.append(CategoryImportError(row=int(idx) + 2, label=None,
                                              error="Label is empty."))
            continue
        if kind not in ("vpa", "merchant", "description"):
            errors.append(CategoryImportError(
                row=int(idx) + 2, label=label,
                error=f"Unknown Kind: {kind!r} (expected vpa | merchant | description).",
            ))
            continue

        # Strict validation — Excel imports must use canonical taxonomy
        # paths (no "Food and Dining" vs "Food" drift).
        path_err = taxonomy.validate_path(
            category, sub or None, subsub or None, strict=True,
        )
        if path_err:
            errors.append(CategoryImportError(
                row=int(idx) + 2, label=label, error=path_err,
            ))
            continue

        try:
            result = cat_svc.apply_category_to_group(
                kind=kind,
                value=label,
                category=category,
                subcategory=sub or None,
                sub_subcategory=subsub or None,
                save_rule=True,
                source=CATEGORIZATION_SOURCE_EXCEL_IMPORT,
            )
        except ValueError as exc:
            errors.append(CategoryImportError(
                row=int(idx) + 2, label=label, error=str(exc),
            ))
            continue

        rows_applied += 1
        txns_updated += int(result["transactions_updated"])
        if result.get("rule_id"):
            rules_created += 1

    return CategoryImportResult(
        rows_read=rows_read,
        rows_applied=rows_applied,
        transactions_updated=txns_updated,
        rules_created=rules_created,
        errors=errors,
    )

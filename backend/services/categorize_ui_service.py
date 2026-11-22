"""Categorization UI services — review queues, combined groups, rule preview.

See ``docs/RULE_ENGINE.md`` for architecture.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import (
    CATEGORIZATION_SOURCE_MANUAL, Transaction, TXN_TYPE_CREDIT, TXN_TYPE_DEBIT,
    CategorizationRule,
)
from services.rule_condition_tree import evaluate_tree, is_tree_format
from services.rule_engine import EvalContext, evaluate_conditions, compute_first_debit_of_day_ids
from utils.grouping import is_usable_vpa, resolve_group_key
from utils.tagging import is_category_tagged


def _real_flow():
    return (
        Transaction.is_internal_transfer.is_(False),
        Transaction.is_credit_card_payment.is_(False),
        Transaction.is_emi.is_(False),
    )


class CategorizeUIService:
    def __init__(self, session: Session) -> None:
        self.s = session

    def _flow_rows(self) -> List[Transaction]:
        return list(self.s.scalars(
            select(Transaction).where(*_real_flow())
        ))

    def preview_conditions(
        self,
        conditions: Dict[str, Any],
        *,
        limit: int = 100,
        only_uncategorized: bool = False,
    ) -> Dict[str, Any]:
        """Return matching transactions for rule preview (no writes)."""
        rows = self._flow_rows()
        ctx = EvalContext(first_debit_of_day_ids=compute_first_debit_of_day_ids(self.s))
        matched: List[Transaction] = []
        skipped_tagged = 0
        evaluated = 0
        for t in rows:
            if only_uncategorized and is_category_tagged(t.category):
                skipped_tagged += 1
                continue
            evaluated += 1
            ok = (
                evaluate_tree(conditions, t, ctx)
                if is_tree_format(conditions)
                else evaluate_conditions(conditions, t, ctx)
            )
            if ok:
                matched.append(t)
        total_amt = sum(t.amount for t in matched)
        expense = sum(t.amount for t in matched if t.type == TXN_TYPE_DEBIT)
        income = sum(t.amount for t in matched if t.type == TXN_TYPE_CREDIT)
        return {
            "match_count": len(matched),
            "total_amount": round(total_amt, 2),
            "expense_amount": round(expense, 2),
            "income_amount": round(income, 2),
            "transactions": [_txn_dict(t) for t in matched[:limit]],
            "rows_evaluated": evaluated,
            "rows_skipped_tagged": skipped_tagged,
            "rows_total": len(rows),
            "only_uncategorized": only_uncategorized,
            "dataset_scope": "real_flow",
        }

    def groups_by_kind(self, kind: str) -> List[Dict[str, Any]]:
        """Enriched groups for By VPA / Counterparty / Combined tabs."""
        rows = self._flow_rows()
        buckets: Dict[str, Dict[str, Any]] = {}

        for t in rows:
            gkind, key, label = resolve_group_key(t.vpa, t.merchant_name)
            if kind == "vpa" and gkind != "vpa":
                continue
            if kind == "merchant" and gkind != "merchant":
                continue
            if kind == "combined":
                if gkind == "unmatched":
                    continue
                vpa = (t.vpa or "").strip().lower()
                mch = (t.merchant_name or "").strip()
                if not vpa or not mch:
                    continue
                key = f"combined:{mch.lower()}|{vpa}"
                label = f"{mch} · {vpa}"
                gkind = "combined"
            elif gkind == "unmatched":
                continue

            if key not in buckets:
                buckets[key] = {
                    "key": key, "label": label, "kind": gkind,
                    "txn_count": 0, "total_amount": 0.0, "expense_amount": 0.0,
                    "income_amount": 0.0, "uncategorized_count": 0,
                    "categories": defaultdict(int),
                }
            b = buckets[key]
            b["txn_count"] += 1
            b["total_amount"] += t.amount
            if t.type == TXN_TYPE_DEBIT:
                b["expense_amount"] += t.amount
            else:
                b["income_amount"] += t.amount
            if not is_category_tagged(t.category):
                b["uncategorized_count"] += 1
            if t.category:
                b["categories"][t.category] += 1

        out: List[Dict[str, Any]] = []
        for b in buckets.values():
            top_cat = max(b["categories"], key=b["categories"].get) if b["categories"] else None
            out.append({
                "key": b["key"],
                "label": b["label"],
                "kind": b["kind"],
                "txn_count": b["txn_count"],
                "total_amount": round(b["total_amount"], 2),
                "expense_amount": round(b["expense_amount"], 2),
                "income_amount": round(b["income_amount"], 2),
                "uncategorized_count": b["uncategorized_count"],
                "has_category": b["uncategorized_count"] == 0 and b["txn_count"] > 0,
                "top_category": top_cat,
            })
        out.sort(key=lambda g: (-g["uncategorized_count"], -g["total_amount"]))
        return out

    def review_queues(self, limit: int = 20) -> Dict[str, Any]:
        rows = [t for t in self._flow_rows() if not is_category_tagged(t.category)]

        def _agg(key_fn, label_fn):
            m: Dict[str, Dict] = defaultdict(lambda: {"amount": 0.0, "count": 0, "label": ""})
            for t in rows:
                k = key_fn(t)
                if not k:
                    continue
                m[k]["amount"] += t.amount
                m[k]["count"] += 1
                m[k]["label"] = label_fn(t)
            items = sorted(m.values(), key=lambda x: -x["amount"])[:limit]
            return [{"label": i["label"], "amount": round(i["amount"], 2), "txn_count": i["count"]} for i in items]

        return {
            "top_vpas": _agg(
                lambda t: (t.vpa or "").lower() if is_usable_vpa(t.vpa) else "",
                lambda t: t.vpa or "",
            ),
            "top_counterparties": _agg(
                lambda t: (t.merchant_name or "").lower(),
                lambda t: t.merchant_name or "",
            ),
            "top_descriptions": _agg(
                lambda t: (t.description or "")[:80].lower(),
                lambda t: (t.description or "")[:80],
            ),
        }

    def rule_analytics(self) -> Dict[str, Any]:
        rules = list(self.s.scalars(select(CategorizationRule)))
        flow = self._flow_rows()
        manual = sum(
            1 for t in flow
            if t.categorization_source == CATEGORIZATION_SOURCE_MANUAL and is_category_tagged(t.category)
        )
        by_rule = sum(1 for t in flow if t.categorized_by_rule_id and is_category_tagged(t.category))
        tagged = sum(1 for t in flow if is_category_tagged(t.category))
        return {
            "total_rules": len(rules),
            "active_rules": sum(1 for r in rules if r.enabled),
            "disabled_rules": sum(1 for r in rules if not r.enabled),
            "transactions_by_rules": by_rule,
            "transactions_manual": manual,
            "transactions_auto_other": max(0, tagged - manual - by_rule),
        }


def _txn_dict(t: Transaction) -> Dict[str, Any]:
    return {
        "id": t.id,
        "date": t.date.isoformat() if t.date else None,
        "description": t.description,
        "amount": t.amount,
        "type": t.type,
        "merchant_name": t.merchant_name,
        "vpa": t.vpa,
        "category": t.category,
        "subcategory": t.subcategory,
    }

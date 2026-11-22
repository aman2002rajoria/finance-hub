#!/usr/bin/env python3
"""Validate categorization tagging logic and rule modes.

Run from backend/:
    python scripts/validate_categorization.py

Uses a temp DB — does not touch finance.db.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import date

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Point at temp DB before importing app modules.
_tmp = tempfile.mkdtemp(prefix="finance_hub_validate_")
os.environ["FINANCE_DB_PATH"] = os.path.join(_tmp, "test.db")

from db.database import init_db, SessionLocal  # noqa: E402
from db.models import Transaction  # noqa: E402
from services.categorization_service import CategorizationService  # noqa: E402
from utils.tagging import is_category_tagged  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402


def _seed_txns(db) -> None:
    rows = [
        Transaction(
            id="t1", date=date(2025, 1, 1), description="UPI SWIGGY",
            amount=500, type="debit", account_type="savings", account_name="SBI",
            vpa="swiggy@upi", merchant_name="Swiggy",
            is_internal_transfer=False, is_credit_card_payment=False, is_emi=False,
        ),
        Transaction(
            id="t2", date=date(2025, 1, 2), description="UPI SWIGGY",
            amount=300, type="debit", account_type="savings", account_name="SBI",
            vpa="swiggy@upi", merchant_name="Swiggy",
            category="Food", subcategory="Restaurants",
            is_internal_transfer=False, is_credit_card_payment=False, is_emi=False,
        ),
        Transaction(
            id="t3", date=date(2025, 1, 3), description="AMAZON",
            amount=1000, type="debit", account_type="savings", account_name="SBI",
            vpa="amazon@apl", merchant_name="AMAZON",
            is_internal_transfer=False, is_credit_card_payment=False, is_emi=False,
        ),
        Transaction(
            id="t4", date=date(2025, 1, 4), description="empty cat",
            amount=50, type="debit", account_type="savings", account_name="SBI",
            category="", is_internal_transfer=False, is_credit_card_payment=False, is_emi=False,
        ),
    ]
    for r in rows:
        db.add(r)
    db.commit()


def main() -> None:
    init_db()
    db = SessionLocal()
    _seed_txns(db)
    client = TestClient(app)

    print("=== Tagging helper ===")
    assert not is_category_tagged(None)
    assert not is_category_tagged("")
    assert not is_category_tagged("   ")
    assert is_category_tagged("Food")
    print("  is_category_tagged: OK")

    print("=== Transaction list tag_status filters ===")
    all_r = client.get("/api/transactions", params={"limit": 100}).json()
    tagged_r = client.get("/api/transactions", params={"tag_status": "tagged", "limit": 100}).json()
    untagged_r = client.get("/api/transactions", params={"tag_status": "untagged", "limit": 100}).json()
    total = all_r["total"]
    n_tagged = tagged_r["total"]
    n_untagged = untagged_r["total"]
    assert n_tagged + n_untagged == total, f"{n_tagged}+{n_untagged}!={total}"
    tagged_ids = {t["id"] for t in tagged_r["transactions"]}
    untagged_ids = {t["id"] for t in untagged_r["transactions"]}
    assert not tagged_ids & untagged_ids, "overlap between tagged and untagged"
    assert "t2" in tagged_ids and "t1" in untagged_ids and "t4" in untagged_ids
    print(f"  tagged={n_tagged} untagged={n_untagged} total={total} — reconciles")

    print("=== v2 rule tree: AND preview ===")
    tree_and = {
        "version": 2, "logic": "and",
        "items": [
            {"type": "condition", "field": "counterparty", "op": "equals", "value": "Swiggy"},
            {"type": "condition", "field": "amount", "op": "gt", "value": 400},
        ],
    }
    prev = client.post("/api/categorize/preview-rule", json={"conditions": tree_and}).json()
    assert prev["match_count"] == 1, f"expected 1 match (t1), got {prev['match_count']}"
    print(f"  AND preview: {prev['match_count']} match")

    print("=== v2 rule tree: OR preview ===")
    tree_or = {
        "version": 2, "logic": "or",
        "items": [
            {"type": "condition", "field": "vpa", "op": "equals", "value": "amazon@apl"},
            {"type": "condition", "field": "description", "op": "contains", "value": "empty cat"},
        ],
    }
    prev_or = client.post("/api/categorize/preview-rule", json={"conditions": tree_or}).json()
    assert prev_or["match_count"] >= 2
    print(f"  OR preview: {prev_or['match_count']} matches")

    print("=== v2 rule: preview debug + uncategorized filter ===")
    interest_tree = {
        "version": 2, "logic": "and",
        "items": [{"type": "condition", "field": "description", "op": "contains", "value": "SWIGGY"}],
    }
    prev_all = client.post("/api/categorize/preview-rule", json={"conditions": interest_tree}).json()
    assert prev_all["match_count"] >= 2
    assert prev_all["rows_total"] == 4
    assert prev_all["rows_evaluated"] == 4
    prev_uncat = client.post("/api/categorize/preview-rule", json={
        "conditions": interest_tree, "only_uncategorized": True,
    }).json()
    assert prev_uncat["match_count"] == 1  # only t1 before bulk apply... wait bulk apply hasn't run yet
    assert prev_uncat["rows_skipped_tagged"] == 1  # t2 tagged in seed
    print(f"  preview debug: all={prev_all['match_count']} uncat={prev_uncat['match_count']} skipped={prev_uncat['rows_skipped_tagged']}")

    print("=== v2 rule tree: nested group ===")
    tree_nested = {
        "version": 2, "logic": "and",
        "items": [
            {
                "type": "group", "logic": "or",
                "items": [
                    {"type": "condition", "field": "counterparty", "op": "equals", "value": "AMAZON"},
                    {"type": "condition", "field": "description", "op": "contains", "value": "AMAZON"},
                ],
            },
            {"type": "condition", "field": "amount", "op": "gte", "value": 500},
        ],
    }
    prev_n = client.post("/api/categorize/preview-rule", json={"conditions": tree_nested}).json()
    assert prev_n["match_count"] == 1
    print("  nested group preview: OK")

    print("=== VPA bulk apply + subcategory ===")
    r = client.post("/api/transactions/bulk-apply", json={
        "kind": "vpa", "value": "swiggy@upi",
        "category": "Food", "subcategory": "Online Ordering", "save_rule": True,
    }).json()
    assert r["transactions_updated"] >= 1
    t1 = client.get("/api/transactions/t1/detail").json()["transaction"]
    assert t1["category"] == "Food" and t1["subcategory"] == "Online Ordering"
    print(f"  VPA rule applied to {r['transactions_updated']} txns with subcategory")

    print("=== Merchant bulk apply ===")
    r = client.post("/api/transactions/bulk-apply", json={
        "kind": "merchant", "value": "AMAZON",
        "category": "Shopping", "save_rule": True,
    }).json()
    assert r["transactions_updated"] == 1
    print("  Merchant rule: OK")

    print("=== Combined bulk apply ===")
    r = client.post("/api/transactions/bulk-apply", json={
        "kind": "combined",
        "vpa_value": "amazon@apl", "merchant_value": "AMAZON",
        "category": "Shopping", "save_rule": True,
    }).json()
    assert r["transactions_updated"] == 1
    t3 = client.get("/api/transactions/t3/detail").json()["transaction"]
    assert t3["category"] == "Shopping"
    print("  Combined rule: OK")

    print("=== PATCH category from Transactions tab ===")
    client.patch("/api/transactions/t4", json={"category": "Misc"})
    t4 = client.get("/api/transactions/t4/detail").json()["transaction"]
    assert t4["category"] == "Misc"
    print("  PATCH persist: OK")

    print("=== Coverage analytics reconciliation ===")
    cov = client.get("/api/analytics/categorization-progress").json()
    assert cov["categorized_transactions"] + cov["uncategorized_transactions"] == cov["total_transactions"]
    assert cov["categorized_vpas"] + cov["uncategorized_vpas"] == cov["total_vpas"]
    assert cov["categorized_counterparties"] + cov["uncategorized_counterparties"] == cov["total_counterparties"]
    assert abs(cov["uncat_expense_amount"] + 0) <= cov["total_expense_amount"] + 0.01
    print(f"  coverage={cov['coverage_pct']}% uncat_expense={cov['uncat_expense_amount']}")

    print("=== Grouping: bank-handle VPA detection ===")
    from utils.grouping import is_bank_handle_vpa, is_usable_vpa, resolve_group_key
    assert is_bank_handle_vpa("paytm@icici")
    assert is_bank_handle_vpa("foo@axisbank")
    assert not is_usable_vpa("paytm@icici")
    assert is_usable_vpa("swiggy@upi")
    kind, _, _ = resolve_group_key("paytm@icici", "Swiggy")
    assert kind == "merchant", "bank-handle VPA should fall back to merchant group"
    kind2, _, _ = resolve_group_key("swiggy@upi", "Swiggy")
    assert kind2 == "vpa"
    print("  bank-handle fallback: OK")

    print("=== Subcategory filter ===")
    r = client.get("/api/transactions", params={"subcategory": "Online Ordering", "limit": 10}).json()
    for t in r["transactions"]:
        assert t.get("subcategory") == "Online Ordering"
    print(f"  subcategory filter returned {r['total']} rows")

    print("=== apply-tree + manual override ===")
    client.patch("/api/transactions/t2", json={"category": "ManualCat", "subcategory": None})
    from db.models import CATEGORIZATION_SOURCE_MANUAL
    t2m = db.get(Transaction, "t2")
    t2m.categorization_source = CATEGORIZATION_SOURCE_MANUAL
    db.commit()
    apply_r = client.post("/api/rules/apply-tree", json={
        "name": "Swiggy All",
        "conditions": {"version": 2, "logic": "and", "items": [
            {"type": "condition", "field": "vpa", "op": "equals", "value": "swiggy@upi"},
        ]},
        "category": "Food", "subcategory": "Delivery",
        "only_uncategorized": True, "save_rule": True,
    }).json()
    t2_after = client.get("/api/transactions/t2/detail").json()["transaction"]
    assert t2_after["category"] == "ManualCat", "manual override must not be overwritten"
    print(f"  apply-tree updated {apply_r['transactions_updated']}, manual preserved")

    print("=== Categorize groups API ===")
    groups = client.get("/api/categorize/groups", params={"kind": "vpa"}).json()
    assert isinstance(groups, list) and len(groups) >= 1
    queues = client.get("/api/categorize/review-queues").json()
    assert "top_vpas" in queues
    print(f"  groups={len(groups)} review_queues OK")

    print("\nAll validations passed.")
    db.close()


if __name__ == "__main__":
    main()

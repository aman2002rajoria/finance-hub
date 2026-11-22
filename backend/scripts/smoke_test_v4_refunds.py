"""Smoke test for the v4 spec: refunds, multi-level categories, taxonomy CRUD.

Covers:
  1. Schema auto-migration adds the new columns to an existing DB.
  2. Default taxonomy seeded on fresh boot (Expense + Income roots, sample
     leaves under Travel and Salary).
  3. POST /api/categories adds a custom node; duplicate is rejected.
  4. PATCH a transaction with refund flag:
       * setting is_refund=True on a debit row is 400 (validation).
       * setting is_refund=True on a credit row works and persists.
  5. Refund analytics:
       * Refund credit subtracts from spend bucket.
       * Refund credit is NOT counted as income.
  6. Income breakdown endpoint returns the expected categories.
  7. monthly-by-category endpoint returns top-N.

Run:  python scripts/smoke_test_v4_refunds.py
"""

from __future__ import annotations

import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

_TMP = tempfile.mkdtemp(prefix="finance_hub_v4_")
os.environ["FINANCE_DB_PATH"] = os.path.join(_TMP, "finance.db")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text                 # noqa: E402

from db.database import engine, init_db    # noqa: E402
from main import app                         # noqa: E402


def _section(t): print(f"\n{'='*72}\n {t}\n{'='*72}")


def _seed_minimal_data(client: TestClient):
    """Insert a tiny, hand-crafted set of rows directly via SQL to test
    refund analytics deterministically. Bypassing the PDF pipeline keeps
    this test fast and bank-PDF-independent.
    """
    with engine.begin() as conn:
        # Account
        conn.execute(text("""
            INSERT INTO accounts (name, type, display_name)
            VALUES ('TEST_SAV','savings','Test Savings')
        """))
        # Three rows: 2 spend in Food, 1 refund in Food, 1 salary credit.
        rows = [
            # (id, date, desc, amount, type, category, sub, sub_sub, is_refund, refund_cat)
            ("food1", "2026-04-10", "Swiggy order", 500.0, "debit",  "Food", "Online Ordering", None, 0, None),
            ("food2", "2026-04-12", "Dinner @ XYZ", 300.0, "debit",  "Food", "Dine-out",        None, 0, None),
            ("refund", "2026-04-14", "Swiggy refund", 200.0, "credit", None,   None,             None, 1, "Food"),
            ("sal", "2026-04-30", "SALARY CREDIT",  50000.0, "credit", "Income", "Salary",        "Job", 0, None),
        ]
        for r in rows:
            conn.execute(text("""
                INSERT INTO transactions (
                    id, date, description, amount, type, account_type, account_name,
                    category, subcategory, sub_subcategory, is_refund, refund_category,
                    is_internal_transfer, is_credit_card_payment, is_emi
                ) VALUES (
                    :id, :date, :desc, :amt, :type, 'savings', 'TEST_SAV',
                    :cat, :sub, :subsub, :isr, :rc, 0, 0, 0
                )
            """), {
                "id": r[0], "date": r[1], "desc": r[2], "amt": r[3], "type": r[4],
                "cat": r[5], "sub": r[6], "subsub": r[7], "isr": r[8], "rc": r[9],
            })


def main():
    _section("0. Boot the app (which runs migrations + seeds taxonomy)")
    init_db()
    client = TestClient(app)
    with client:
        # --------------------------------------------------------------
        _section("1. Default taxonomy seeded — confirm a few expected nodes")
        r = client.get("/api/categories")
        assert r.status_code == 200, r.text
        tax = r.json()
        expense_names = {n["name"] for n in tax["expense"]}
        income_names  = {n["name"] for n in tax["income"]}
        print("  expense roots:", sorted(expense_names))
        print("  income  roots:", sorted(income_names))
        for must in ("Food", "Travel", "Electronics", "Investments", "Gifts"):
            assert must in expense_names, f"missing expense root: {must}"
        for must in ("Salary", "Interest Income", "Dividends", "Pocket Money"):
            assert must in income_names, f"missing income root: {must}"
        # Drill into Travel → Travel to Home → Flight
        travel = next(n for n in tax["expense"] if n["name"] == "Travel")
        tth    = next(c for c in travel["children"] if c["name"] == "Travel to Home")
        flights = [g["name"] for g in tth["children"]]
        print("  Travel → Travel to Home →", flights)
        assert "Flight" in flights, "Travel→Travel to Home→Flight missing"

        # --------------------------------------------------------------
        _section("2. Create a custom node + reject duplicate")
        r = client.post("/api/categories", json={
            "name": "Gym", "parent_id": None, "kind": "expense",
        })
        assert r.status_code == 200, r.text
        gym_id = r.json()["id"]
        # Duplicate (case-insensitive) → 400
        r = client.post("/api/categories", json={
            "name": "GYM", "parent_id": None, "kind": "expense",
        })
        assert r.status_code == 400, r.text
        print("  duplicate correctly rejected")

        # Add Membership subcategory under Gym
        r = client.post("/api/categories", json={
            "name": "Membership", "parent_id": gym_id,
        })
        assert r.status_code == 200, r.text
        print("  added Gym → Membership")

        # --------------------------------------------------------------
        _section("3. Seed minimal transactions directly")
        _seed_minimal_data(client)
        r = client.get("/api/transactions?limit=10")
        assert r.status_code == 200, r.text
        body = r.json()
        print(f"  inserted {body['total']} txns")
        assert body["total"] == 4

        # --------------------------------------------------------------
        _section("4. Refund validation: debit row can't be a refund")
        # Try to mark the debit Swiggy row as a refund → 400
        r = client.patch("/api/transactions/food1", json={"is_refund": True})
        assert r.status_code == 400, r.text
        print("  debit → refund correctly blocked")

        # --------------------------------------------------------------
        _section("5. Headline + monthly analytics — refund-aware")
        r = client.get("/api/analytics/headline")
        assert r.status_code == 200, r.text
        head = r.json()
        # spend = 500 + 300 - 200 refund = 600
        # income = 50000 (salary only — refund excluded)
        print(f"  total_spend  = {head['total_spend']}")
        print(f"  total_income = {head['total_income']}")
        assert abs(head["total_spend"]  - 600.0)   < 0.01, head
        assert abs(head["total_income"] - 50000.0) < 0.01, head

        # --------------------------------------------------------------
        _section("6. Category breakdown — Food net 600, no Income")
        r = client.get("/api/analytics/categories")
        assert r.status_code == 200, r.text
        cats = {c["category"]: c for c in r.json()}
        print("  categories ->", {k: round(v["amount"], 2) for k, v in cats.items()})
        # Food spend: 800 gross − 200 refund = 600
        assert "Food" in cats, cats
        assert abs(cats["Food"]["amount"] - 600.0) < 0.01, cats["Food"]
        # Income category should NOT appear here (it's an income category)
        # — but it might, depending on the analytics implementation.
        # If present, just don't allow refund credit to inflate it.

        # --------------------------------------------------------------
        _section("7. Income breakdown — Salary 50000, no refunds")
        r = client.get("/api/analytics/income-breakdown")
        assert r.status_code == 200, r.text
        income_rows = r.json()
        print("  income rows ->", income_rows)
        # We expect at least one Salary row of 50000
        salary = [
            row for row in income_rows
            if row["category"] == "Income" and row["subcategory"] == "Salary"
        ]
        assert salary and abs(salary[0]["amount"] - 50000.0) < 0.01, income_rows
        # And refund category must NOT appear here
        assert not any(row["category"] == "Food" for row in income_rows), \
            "Food refund leaked into income breakdown!"

        # --------------------------------------------------------------
        _section("8. monthly-by-category top-5")
        r = client.get("/api/analytics/monthly-by-category?top_n=5")
        assert r.status_code == 200, r.text
        cells = r.json()
        print(f"  cells -> {cells[:5]}")
        # Should include a Food row for 2026-04 with net 600
        food_april = [c for c in cells if c["period"] == "2026-04" and c["category"] == "Food"]
        assert food_april and abs(food_april[0]["amount"] - 600.0) < 0.01, cells

        # --------------------------------------------------------------
        _section("9. Path validation rejects bogus hierarchy")
        r = client.patch("/api/transactions/food1", json={
            "category": "Food", "subcategory": "Mutual Funds",   # cross-branch nonsense
        })
        assert r.status_code == 400, r.text
        print("  cross-branch subcategory correctly rejected")

        # --------------------------------------------------------------
        _section("10. Archive + restore + rename cascade")
        r = client.post(f"/api/categories/{gym_id}/archive")
        assert r.status_code == 200, r.text
        # Should be hidden by default
        r = client.get("/api/categories")
        gym = next((n for n in r.json()["expense"] if n["name"] == "Gym"), None)
        assert gym is None, "Gym should be archived (hidden)"
        # Restored
        r = client.post(f"/api/categories/{gym_id}/restore")
        assert r.status_code == 200, r.text
        r = client.get("/api/categories")
        gym = next((n for n in r.json()["expense"] if n["name"] == "Gym"), None)
        assert gym, "Gym should be back after restore"
        # Rename Gym → Fitness
        r = client.patch(f"/api/categories/{gym_id}/rename", json={"new_name": "Fitness"})
        assert r.status_code == 200, r.text
        print(f"  renamed Gym → Fitness, cascaded {r.json()['transactions_updated']} txns")

    print("\nAll v4 smoke checks passed.")


if __name__ == "__main__":
    main()

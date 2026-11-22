#!/usr/bin/env python3
"""Validate analytics metric reconciliation.

Run from backend/:
    python scripts/validate_analytics.py
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from db.database import SessionLocal, init_db
from services.analytics_service import AnalyticsService

TOL = 0.02


def _assert_close(label: str, a: float, b: float) -> None:
    if abs(a - b) > TOL:
        raise AssertionError(f"{label}: {a:.2f} != {b:.2f} (Δ {abs(a - b):.2f})")


def validate_window(svc: AnalyticsService, label: str) -> None:
    snap = svc.financial_snapshot()
    head = svc.headline()
    cf = snap["cash_flow"]
    pe = snap["personal_economics"]

    # Cash flow identity
    _assert_close(f"[{label}] cash_flow.net", cf["net"], cf["money_in"] - cf["money_out"])

    # Personal economics identity
    _assert_close(
        f"[{label}] savings",
        pe["savings"],
        pe["true_income"] - pe["net_personal_spend"],
    )
    _assert_close(
        f"[{label}] net_personal_spend",
        pe["net_personal_spend"],
        pe["gross_expenses"] - pe["refunds_applied"],
    )

    # Snapshot savings == headline net (true income − net spend)
    _assert_close(f"[{label}] snapshot vs headline net", pe["savings"], head["net"])

    # Refunds in cash in but not true income
    _assert_close(
        f"[{label}] money_in",
        cf["money_in"],
        pe["true_income"] + pe["refunds_recoveries"],
    )

    # Monthly series
    for row in svc.monthly_series():
        _assert_close(
            f"[{label}] monthly {row.period}",
            row.net,
            row.income - row.spend,
        )

    # Sankey period summary — flows balance after bridge node
    sk = svc.sankey(mode="period")
    rec = sk["reconciliation"]
    _assert_close(
        f"[{label}] sankey period balance",
        rec["opening_balance"] + rec["cash_in"] - rec["cash_out"],
        rec["closing_balance"] + rec["conservation_error"],
    )

    # Carry-forward savings should be non-zero when wealth changed
    sk_m = svc.sankey(mode="monthly")
    months_with_savings = [
        r for r in sk_m.get("monthly_reconciliation", [])
        if abs(r.get("carry_forward", r.get("savings", 0))) >= 1.0
    ]
    if not months_with_savings and sk_m.get("monthly_reconciliation"):
        print(f"  ⚠ [{label}] no non-zero carry_forward months (flat balances?)")

    for row in sk_m.get("monthly_reconciliation", []):
        _assert_close(
            f"[{label}] sankey month {row['period']}",
            row["opening_balance"] + row["cash_in"] - row["cash_out"],
            row["closing_balance"] + row["conservation_error"],
        )
        if abs(row.get("carry_forward_error", 0)) >= 1.0:
            raise AssertionError(
                f"[{label}] carry-forward {row['period']}: {row['carry_forward_error']}",
            )

    # Hierarchical expansion keeps parents visible
    if sk["nodes"]:
        cat = next((n for n in sk["nodes"] if n.get("expandable")), None)
        if cat:
            sk_exp = svc.sankey(mode="period", expanded=[cat["id"]])
            parent_ids = {n["id"] for n in sk_exp["nodes"]}
            if cat["id"] not in parent_ids:
                raise AssertionError(f"[{label}] expanded sankey removed parent {cat['id']}")

    print(f"  ✓ {label}")


def main() -> int:
    init_db()
    db = SessionLocal()
    try:
        print("Analytics validation")
        validate_window(AnalyticsService(db), "all-time")

        to = date.today()
        fr = to - timedelta(days=90)
        validate_window(AnalyticsService(db, date_from=fr, date_to=to), "last-90d")

        print("\nAll checks passed.")
        return 0
    except AssertionError as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())

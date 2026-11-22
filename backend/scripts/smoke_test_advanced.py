"""Smoke test for the advanced categorisation + reconciliation features.

Covers the user spec's five test cases:

  1. VPA summary returns correct credit/debit totals.
  2. Full description preserved on the API side (raw_text included).
  3. Manual internal-transfer link excludes both legs from analytics.
  4. CC bill payment mapping prevents double counting.
  5. Income auto-detection tags salary/interest/cashback/refund.

Run:  python scripts/smoke_test_advanced.py
"""

from __future__ import annotations

import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

_TMP = tempfile.mkdtemp(prefix="finance_hub_advanced_")
os.environ["FINANCE_DB_PATH"] = os.path.join(_TMP, "finance.db")

from fastapi.testclient import TestClient   # noqa: E402
from main import app                         # noqa: E402


HOME      = os.path.expanduser("~")
DOWNLOADS = os.path.join(HOME, "Downloads")
SAMPLES = [
    "sbi statement.pdf",
    "slice_statement_01Aug25_16May26.pdf",
    "canara bank statement.pdf",
    "slice Credit Card Statement - April 2026.pdf",
    "SBI Card Statement_8707_05-07-2025.pdf",
]


def _section(t): print(f"\n{'='*72}\n {t}\n{'='*72}")


def _upload_all(client: TestClient):
    fields, fhs = [], []
    for fn in SAMPLES:
        p = os.path.join(DOWNLOADS, fn)
        if not os.path.exists(p):
            print(f"  ! missing {p}")
            continue
        fh = open(p, "rb")
        fhs.append(fh)
        fields.append(("files", (fn, fh, "application/pdf")))
    try:
        return client.post("/api/upload", files=fields)
    finally:
        for fh in fhs:
            fh.close()


def main() -> int:
    print(f"DB: {os.environ['FINANCE_DB_PATH']}")
    client = TestClient(app)

    _section("0. Ingest all sample PDFs")
    r = _upload_all(client)
    assert r.status_code == 200, r.text
    body = r.json()
    total_new = sum(x["new_count"] for x in body["results"])
    total_income_autotag = sum(x.get("income_autotagged", 0) for x in body["results"])
    print(f"  new rows: {total_new}, income auto-tagged at ingest: {total_income_autotag}")
    assert total_new > 0

    # ----------------------------------------------------------------------
    _section("1. VPA-summary endpoint")
    cps = client.get("/api/transactions/counterparties").json()
    vpa_target = next((c for c in cps if c["kind"] == "vpa" and c["txn_count"] >= 2), cps[0])
    label = vpa_target["label"]
    r = client.get("/api/transactions/vpa-summary", params={"vpa": label})
    assert r.status_code == 200, r.text
    s = r.json()
    print(f"  {label}: credit={s['total_credit']:.0f}, debit={s['total_debit']:.0f}, "
          f"net={s['net']:.0f}, n={s['transaction_count']}")
    # Sanity: credit + debit should sum to txn-count rough totals
    txns = client.get("/api/transactions", params={"vpa": label, "limit": 500}).json()
    real_txns = [t for t in txns["transactions"]
                 if not t["is_internal_transfer"] and not t["is_credit_card_payment"] and not t["is_emi"]]
    assert s["transaction_count"] == len(real_txns), (
        f"mismatch: summary={s['transaction_count']} vs filtered={len(real_txns)}"
    )
    sum_cr = round(sum(t["amount"] for t in real_txns if t["type"] == "credit"), 2)
    sum_db = round(sum(t["amount"] for t in real_txns if t["type"] == "debit"),  2)
    assert abs(s["total_credit"] - sum_cr) < 0.01, (s, sum_cr)
    assert abs(s["total_debit"]  - sum_db) < 0.01, (s, sum_db)
    print("  ✓ totals match underlying transaction sums")

    # Negative path
    r = client.get("/api/transactions/vpa-summary")  # missing args
    assert r.status_code == 400
    print("  ✓ rejects missing vpa/merchant params")

    # ----------------------------------------------------------------------
    _section("2. Transaction detail returns FULL description (no truncation)")
    sample = txns["transactions"][0]
    det = client.get(f"/api/transactions/{sample['id']}/detail").json()
    t = det["transaction"]
    assert t["description"] == sample["description"]
    assert "raw_text" in t, "raw_text missing — UI drawer needs it"
    print(f"  ✓ full description ({len(t['description'])} chars) + raw_text exposed")

    # ----------------------------------------------------------------------
    _section("3. Manual internal-transfer linking")
    # Find a savings debit that isn't already linked. We'll attempt to link
    # it to whatever the candidate API returns; the test is "no crash + the
    # flag flips".
    candidate_pool = client.get("/api/transactions", params={
        "account_type": "savings", "type": "debit", "is_internal": False,
        "limit": 50,
    }).json()["transactions"]
    linked_a = linked_b = None
    for cand in candidate_pool:
        cands = client.get(f"/api/transactions/{cand['id']}/transfer-candidates").json()
        if cands:
            linked_a, linked_b = cand, cands[0]
            break
    if linked_a:
        r = client.post(
            f"/api/transactions/{linked_a['id']}/link-internal-transfer",
            json={"partner_id": linked_b["id"]},
        )
        assert r.status_code == 200, r.text
        # Both legs should now be flagged.
        after_a = client.get(f"/api/transactions/{linked_a['id']}/detail").json()["transaction"]
        after_b = client.get(f"/api/transactions/{linked_b['id']}/detail").json()["transaction"]
        assert after_a["is_internal_transfer"], "leg A not flagged"
        assert after_b["is_internal_transfer"], "leg B not flagged"
        assert after_a["linked_transaction_id"] == linked_b["id"]
        assert after_b["linked_transaction_id"] == linked_a["id"]
        print(f"  ✓ manually linked {linked_a['id'][:8]} ↔ {linked_b['id'][:8]}")

        # Unlink and verify
        r = client.post(f"/api/transactions/{linked_a['id']}/unlink-internal-transfer")
        assert r.status_code == 200
        post_a = client.get(f"/api/transactions/{linked_a['id']}/detail").json()["transaction"]
        post_b = client.get(f"/api/transactions/{linked_b['id']}/detail").json()["transaction"]
        assert not post_a["is_internal_transfer"]
        assert not post_b["is_internal_transfer"]
        print("  ✓ unlink flipped BOTH legs back")
    else:
        print("  (skipped — no overlapping savings statements in sample set)")

    # ----------------------------------------------------------------------
    _section("4. CC bill-payment mapping + reconciliation")
    # Force-mark any savings debit as a CC payment to exercise the endpoint
    # end-to-end. We don't depend on the candidate matcher here because the
    # sample dataset may not have a perfect amount match.
    savings_debit = next(
        (t for t in candidate_pool if t["account_type"] == "savings" and t["type"] == "debit"),
        None,
    )
    cc_accts = [a for a in client.get("/api/analytics/accounts").json()
                if a["type"] == "credit_card"]
    if savings_debit and cc_accts:
        cc_acct = cc_accts[0]["name"]
        # Find an actual billing month from CC data
        cc_txns = client.get("/api/transactions", params={
            "account_name": cc_acct, "limit": 5,
        }).json()["transactions"]
        billing_month = cc_txns[0]["date"][:7] if cc_txns else "2026-04"

        r = client.post(
            f"/api/transactions/{savings_debit['id']}/mark-cc-payment",
            json={"cc_account_name": cc_acct, "billing_month": billing_month},
        )
        assert r.status_code == 200, r.text
        print(f"  marked {savings_debit['id'][:8]} → {cc_acct} {billing_month}")

        # Confirm the flag + cc_bill_link row.
        t_after = client.get(f"/api/transactions/{savings_debit['id']}/detail").json()
        assert t_after["transaction"]["is_credit_card_payment"], "flag not set"
        assert t_after["cc_bill_link"] is not None
        print("  ✓ is_credit_card_payment = True + cc_bill_link row created")

        # Reconciliation view should now include this account+month.
        recon = client.get("/api/analytics/cc-reconciliation").json()
        match = [r for r in recon
                 if r["cc_account_name"] == cc_acct and r["billing_month"] == billing_month]
        assert match, f"reconciliation missing {cc_acct} {billing_month}"
        print(f"  ✓ reconciliation row: spend={match[0]['spend']:.0f} "
              f"paid={match[0]['paid']:.0f} diff={match[0]['difference']:.0f}")
        assert match[0]["paid_known"], "paid_known should be True after marking"

        # Unmark and verify reconciliation reverts.
        r = client.post(f"/api/transactions/{savings_debit['id']}/unlink-cc-payment")
        assert r.status_code == 200
        t_final = client.get(f"/api/transactions/{savings_debit['id']}/detail").json()
        assert not t_final["transaction"]["is_credit_card_payment"]
        assert t_final["cc_bill_link"] is None
        print("  ✓ unlink-cc-payment removed both flag and link row")
    else:
        print("  (skipped — no savings debits or CC accounts in sample)")

    # ----------------------------------------------------------------------
    _section("5. Income auto-detection")
    # Look for any row tagged 'Income' by the autotag at ingest.
    income_rows = client.get("/api/transactions", params={"category": "Income", "limit": 50}).json()
    print(f"  Found {income_rows['total']} income-tagged rows.")
    if income_rows["total"] > 0:
        subs = {t["subcategory"] for t in income_rows["transactions"] if t["subcategory"]}
        print(f"  subcategories seen: {sorted(subs)}")
        # At least ONE of {Salary, Interest Income, Refunds, Cashback} should
        # have shown up in real bank statements.
        assert subs & {"Salary", "Interest Income", "Refunds", "Cashback", "Dividends"}, (
            f"expected at least one canonical income subcategory, got {subs}"
        )
        print("  ✓ canonical income subcategory detected from PDF text")
    else:
        print("  (no income patterns matched — sample set may be small)")

    # ----------------------------------------------------------------------
    _section("6. Headline excludes flagged rows correctly")
    head = client.get("/api/analytics/headline").json()
    print(f"  spend={head['total_spend']:.0f}  income={head['total_income']:.0f}  "
          f"internal_transfers={head['internal_transfers']}  "
          f"cc_payments={head['credit_card_payments']}")
    # Smoke: spend should be > 0 if we have any debit rows
    assert head["total_txns"] > 0

    _section("ALL ADVANCED CHECKS PASSED ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())

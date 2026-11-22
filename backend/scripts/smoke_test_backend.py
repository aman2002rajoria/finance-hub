"""End-to-end smoke test for the FastAPI backend.

Spins up the app via TestClient (no real server needed), uploads all
five sample PDFs, then exercises every major endpoint family.

Run::

    python scripts/smoke_test_backend.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

# Force a temp DB so the test is hermetic.
_TMP = tempfile.mkdtemp(prefix="finance_hub_test_")
os.environ["FINANCE_DB_PATH"] = os.path.join(_TMP, "finance.db")

from fastapi.testclient import TestClient   # noqa: E402

from main import app                         # noqa: E402


HOME = os.path.expanduser("~")
DOWNLOADS = os.path.join(HOME, "Downloads")
TEST_FILES = [
    "sbi statement.pdf",
    "slice_statement_01Aug25_16May26.pdf",
    "canara bank statement.pdf",
    "slice Credit Card Statement - April 2026.pdf",
    "SBI Card Statement_8707_05-07-2025.pdf",
]


def _section(t): print(f"\n{'='*72}\n {t}\n{'='*72}")


def main() -> int:
    print(f"DB: {os.environ['FINANCE_DB_PATH']}")
    client = TestClient(app)

    _section("1. Health + root")
    for path in ("/health", "/"):
        r = client.get(path)
        print(f"  {path:<10} → {r.status_code} {r.json()}")
        assert r.status_code == 200

    # ----------------------------------------------------------------
    _section("2. Multi-PDF upload (one request, multiple files)")
    files = []
    file_handles = []
    for fn in TEST_FILES:
        path = os.path.join(DOWNLOADS, fn)
        if not os.path.exists(path):
            print(f"  [skip] missing: {fn}")
            continue
        fh = open(path, "rb")
        file_handles.append(fh)
        files.append(("files", (fn, fh, "application/pdf")))
    r = client.post("/api/upload", files=files)
    for fh in file_handles:
        fh.close()
    assert r.status_code == 200, r.text
    payload = r.json()
    for row in payload["results"]:
        print(
            f"  {row['filename']:<50} bank={row['bank']:<10} "
            f"parsed={row['parsed_count']:<4} new={row['new_count']:<4} "
            f"dup={row['duplicate_count']:<3} cc_pay={row['cc_payments_tagged']}"
        )

    # ----------------------------------------------------------------
    _section("3. Re-upload (file-hash dedup)")
    files2 = []
    fhs2 = []
    for fn in TEST_FILES:
        path = os.path.join(DOWNLOADS, fn)
        if not os.path.exists(path):
            continue
        fh = open(path, "rb"); fhs2.append(fh)
        files2.append(("files", (fn, fh, "application/pdf")))
    r = client.post("/api/upload", files=files2)
    for fh in fhs2:
        fh.close()
    assert r.status_code == 200
    payload = r.json()
    skipped = sum(1 for x in payload["results"] if x["skipped_already_uploaded"])
    new = sum(x["new_count"] for x in payload["results"])
    print(f"  Skipped: {skipped}/{len(payload['results'])}, new rows: {new}")
    assert skipped == len(payload["results"])
    assert new == 0

    # ----------------------------------------------------------------
    _section("4. Upload history")
    r = client.get("/api/upload/history")
    assert r.status_code == 200
    hist = r.json()
    print(f"  Rows in history: {len(hist)}")
    for h in hist[:5]:
        print(f"    {h['filename']:<50} bank={h['bank']:<10} new={h['new_txn_count']}")

    # ----------------------------------------------------------------
    _section("5. Transaction list (paginated, filtered)")
    r = client.get("/api/transactions", params={"limit": 5})
    assert r.status_code == 200
    payload = r.json()
    print(f"  total={payload['total']}, returned={len(payload['transactions'])}")
    for t in payload["transactions"][:3]:
        print(f"    {t['date']} {t['account_name']:<10} {t['type']:<6} ₹{t['amount']:>10.2f} {t['merchant_name'] or t['vpa'] or '—'}")

    # Filter: only CC accounts
    r = client.get("/api/transactions", params={"account_type": "credit_card", "limit": 1})
    cc_total = r.json()["total"]
    print(f"  credit_card total: {cc_total}")

    # ----------------------------------------------------------------
    _section("6. Counterparty groups")
    r = client.get("/api/transactions/counterparties", params={"limit": 5})
    assert r.status_code == 200
    cps = r.json()
    print(f"  counterparty groups: {len(cps)}")
    for cp in cps[:5]:
        print(f"    [{cp['kind']:<10}] {cp['label']:<30} n={cp['txn_count']:<4} ₹{cp['total_amount']:.2f}")

    # ----------------------------------------------------------------
    _section("7. Create a rule + verify propagation")
    if cps:
        first = next((c for c in cps if c["kind"] in ("vpa", "merchant")), None)
        if first:
            rule_type, rule_value = first["key"].split(":", 1)
            r = client.post("/api/rules", json={
                "rule_type": rule_type,
                "rule_value": rule_value,
                "category": "Test Category",
                "subcategory": "Test Sub",
                "propagate": True,
            })
            assert r.status_code == 200, r.text
            print(f"  Saved rule: {r.json()['rule_type']}={r.json()['rule_value']} → {r.json()['category']}")
            r2 = client.get("/api/transactions", params={"category": "Test Category", "limit": 1})
            print(f"  Transactions in 'Test Category': {r2.json()['total']}")
            assert r2.json()["total"] > 0

    # ----------------------------------------------------------------
    _section("8. Convert a transaction to EMI")
    r = client.get("/api/transactions", params={"type": "debit", "limit": 1})
    debit = r.json()["transactions"][0]
    print(f"  Picking txn {debit['id'][:12]} ₹{debit['amount']:.2f} for EMI conversion")
    r = client.post("/api/emi", json={"txn_id": debit["id"], "tenure_months": 3})
    assert r.status_code == 200, r.text
    payload = r.json()
    print(f"  Plan: {payload['plan']['tenure_months']} months × ₹{payload['plan']['monthly_amount']:.2f}")
    print(f"  Schedule: {[(i['period'], i['amount']) for i in payload['schedule']]}")

    # ----------------------------------------------------------------
    _section("9. Analytics endpoints")
    r = client.get("/api/analytics/headline"); assert r.status_code == 200
    print("  headline:", r.json())
    r = client.get("/api/analytics/monthly"); assert r.status_code == 200
    print(f"  monthly rows: {len(r.json())} (sample: {r.json()[:2]})")
    r = client.get("/api/analytics/categories"); assert r.status_code == 200
    print(f"  category rows: {len(r.json())} (top: {r.json()[:3]})")
    r = client.get("/api/analytics/balance-trend"); assert r.status_code == 200
    print(f"  balance-trend points: {len(r.json())}")
    r = client.get("/api/analytics/net-worth"); assert r.status_code == 200
    print(f"  net-worth points: {len(r.json())} (last: {r.json()[-1] if r.json() else '—'})")
    r = client.get("/api/analytics/counterparties", params={"limit": 5}); assert r.status_code == 200
    print(f"  top counterparties: {[c['counterparty'] for c in r.json()]}")
    r = client.get("/api/analytics/categorization-progress"); assert r.status_code == 200
    print(f"  progress: {r.json()}")
    r = client.get("/api/analytics/accounts"); assert r.status_code == 200
    print(f"  accounts: {[a['name'] for a in r.json()]}")

    # ----------------------------------------------------------------
    _section("10. PATCH transaction (manual category)")
    txn = client.get("/api/transactions", params={"limit": 1}).json()["transactions"][0]
    r = client.patch(f"/api/transactions/{txn['id']}", json={
        "category": "Manual Override", "subcategory": "smoke-test",
    })
    assert r.status_code == 200, r.text
    print(f"  Patched {txn['id'][:12]} → category={r.json()['category']}")

    shutil.rmtree(_TMP, ignore_errors=True)
    print("\nALL SMOKE TESTS PASSED ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())

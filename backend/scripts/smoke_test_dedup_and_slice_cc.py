"""Smoke checks for Slice CC dual-layout + txn dedupe.

Uses a temp DB — does not touch finance.db.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND))

_TMP = tempfile.mkdtemp(prefix="finance_hub_smoke_")
os.environ["FINANCE_DB_PATH"] = os.path.join(_TMP, "finance.db")

from db.database import SessionLocal, init_db  # noqa: E402
from parsers.slice_cc_parser import SliceCCParser  # noqa: E402
from services.dedup_service import deterministic_txn_id, is_real_bank_reference  # noqa: E402
from services.ingestion_service import IngestionService  # noqa: E402


SLICE_DIR = Path.home() / "Downloads" / "Bank Statements" / "Slie Credit Card Statements"
APR = SLICE_DIR / "slice Credit Card Statement - April 2026.pdf"
MAR = SLICE_DIR / "slice Credit Card Statement - March 2026.pdf"
CANARA = Path.home() / "Downloads" / "canara_epassbook_2026-07-30 21_36_28.411179.pdf"


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def test_slice_cc_layouts() -> None:
    _assert(APR.exists() and MAR.exists(), "Slice CC sample PDFs missing in Downloads")
    apr = SliceCCParser(str(APR)).parse()
    mar = SliceCCParser(str(MAR)).parse()
    _assert(len(apr.transactions) == 39, f"April expected 39, got {len(apr.transactions)}")
    _assert(
        abs(sum(t.debit for t in apr.transactions) - 19379.44) < 0.02,
        "April spends mismatch",
    )
    _assert(len(mar.transactions) == 33, f"March expected 33, got {len(mar.transactions)}")
    _assert(
        abs(sum(t.debit for t in mar.transactions) - 10915.50) < 0.02,
        "March spends mismatch",
    )


def test_dedupe_reupload_and_overlap() -> None:
    init_db()
    s = SessionLocal()
    try:
        svc = IngestionService(s)
        b = APR.read_bytes()
        r1 = svc.ingest_pdf_bytes(b, APR.name, force_bank="slice_cc")
        _assert(r1.new_count == 39, f"first insert new={r1.new_count}")
        r2 = svc.ingest_pdf_bytes(b, APR.name, force_bank="slice_cc")
        _assert(r2.skipped_already_uploaded, "exact re-upload should skip at file hash")
        r3 = svc.ingest_pdf_bytes(b, APR.name, force_bank="slice_cc", force_reparse=True)
        _assert(r3.new_count == 0, f"force reparse must insert 0, got {r3.new_count}")
        _assert(r3.duplicate_count == 39, f"force reparse dups={r3.duplicate_count}")

        if CANARA.exists():
            cb = CANARA.read_bytes()
            c1 = svc.ingest_pdf_bytes(cb, CANARA.name, force_bank="canara")
            _assert(c1.new_count > 0, "canara should insert something on empty DB")
            c2 = svc.ingest_pdf_bytes(cb, CANARA.name, force_bank="canara")
            _assert(c2.skipped_already_uploaded, "canara re-upload skipped")
            c3 = svc.ingest_pdf_bytes(cb, CANARA.name, force_bank="canara", force_reparse=True)
            _assert(c3.new_count == 0, "canara overlap force_reparse inserts 0")
    finally:
        s.close()


def test_fingerprint_stable_and_ref_helper() -> None:
    a = deterministic_txn_id("2026-04-01", 100.0, "Blinkit (UPI)", "SLICE_CC")
    b = deterministic_txn_id("2026-04-01", 100.0, "Blinkit (UPI)", "SLICE_CC", occurrence=0)
    c = deterministic_txn_id("2026-04-01", 100.0, "Blinkit (UPI)", "SLICE_CC", occurrence=1)
    _assert(a == b, "occurrence 0 must match legacy fingerprint")
    _assert(a != c, "occurrence 1 must differ")
    _assert(is_real_bank_reference("123456789012"), "upi ref should be real")
    _assert(not is_real_bank_reference("CC-ABCDEF1234"), "synthetic CC ref")
    _assert(not is_real_bank_reference("0"), "placeholder ref")


if __name__ == "__main__":
    test_fingerprint_stable_and_ref_helper()
    test_slice_cc_layouts()
    test_dedupe_reupload_and_overlap()
    print("PASS smoke_test_dedup_and_slice_cc")

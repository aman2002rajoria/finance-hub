"""System-wide admin endpoints.

Right now this exposes a single destructive operation, but it's the
right module to grow over time (backups, exports, status, etc.).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from db.database import fastapi_session
from db.models import (
    Account, CategorizationRule, EMIRecord, Transaction, Upload,
)


router = APIRouter(prefix="/api/system", tags=["system"])


# ---------------------------------------------------------------------------
# Test data mode: rebuild the synthetic demo DB ("Reset test data" in the UI)
# ---------------------------------------------------------------------------
#
# Only exists when the server was started with FINANCE_DEMO=1 (dev.sh does
# this for the :8001 demo backend). It also refuses unless the active DB
# file is demo.db, so it can never touch the real finance.db.

import os
import subprocess
import sys
import threading

from fastapi import HTTPException

from db.database import DB_PATH, engine

_reset_lock = threading.Lock()
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class DemoResetOut(BaseModel):
    ok: bool
    seconds: float


@router.post("/reset-demo", response_model=DemoResetOut)
def reset_demo() -> DemoResetOut:
    if os.environ.get("FINANCE_DEMO") != "1":
        raise HTTPException(status_code=404, detail="Not found")
    if os.path.basename(DB_PATH) != "demo.db":
        raise HTTPException(status_code=403, detail="Reset only works on the test data database.")
    if not _reset_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A reset is already running.")
    try:
        import time
        t0 = time.monotonic()
        # Close pooled connections so nothing holds the old file while it is replaced.
        engine.dispose()
        env = {**os.environ, "FINANCE_DB_PATH": DB_PATH}
        result = subprocess.run(
            [sys.executable, os.path.join(_BACKEND_DIR, "scripts", "seed_demo_data.py")],
            cwd=_BACKEND_DIR, env=env, capture_output=True, text=True, timeout=600,
        )
        # New connections open the freshly built file.
        engine.dispose()
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip().splitlines()[-5:]
            raise HTTPException(status_code=500, detail="Seeding failed: " + " | ".join(tail))
        return DemoResetOut(ok=True, seconds=round(time.monotonic() - t0, 1))
    finally:
        _reset_lock.release()


class ResetSummary(BaseModel):
    transactions_deleted: int
    accounts_deleted: int
    emi_records_deleted: int
    uploads_deleted: int
    rules_preserved: int


@router.post("/reset", response_model=ResetSummary)
def reset_system(db: Session = Depends(fastapi_session)) -> ResetSummary:
    """Wipe ledger + audit trail + accounts; KEEP categorization rules.

    This is the "start fresh" button on the Upload page. We intentionally
    preserve ``categorization_rules`` so the system retains everything it
    has learned about the user's spending. Re-uploaded statements get
    re-tagged automatically because the rule engine runs on insert.

    Implementation note: ``transactions`` has a self-FK
    (``linked_transaction_id``) and an FK to ``emi_records``. We disable
    foreign-key checks for the duration of the wipe so order-of-deletion
    doesn't matter, then re-enable them at the end. SQLite's
    ``PRAGMA foreign_keys`` is per-connection so this is safe.
    """
    # Snapshot counts before deletion for the response.
    counts = {
        "transactions": db.scalar(select(Transaction).with_only_columns(Transaction.id).limit(1)),
    }
    txn_count   = int(db.scalar(text("SELECT COUNT(*) FROM transactions"))   or 0)
    acct_count  = int(db.scalar(text("SELECT COUNT(*) FROM accounts"))       or 0)
    emi_count   = int(db.scalar(text("SELECT COUNT(*) FROM emi_records"))    or 0)
    upl_count   = int(db.scalar(text("SELECT COUNT(*) FROM uploads"))        or 0)
    rule_count  = int(db.scalar(text("SELECT COUNT(*) FROM categorization_rules")) or 0)

    # Run the wipe in a single transaction with FK enforcement off so we
    # don't have to think about cascade order on a 5-table graph.
    db.execute(text("PRAGMA foreign_keys = OFF"))
    try:
        db.execute(delete(Transaction))
        db.execute(delete(EMIRecord))
        db.execute(delete(Account))
        db.execute(delete(Upload))
        # NOTE: categorization_rules is DELIBERATELY left untouched.
        db.commit()
    finally:
        db.execute(text("PRAGMA foreign_keys = ON"))

    return ResetSummary(
        transactions_deleted=txn_count,
        accounts_deleted=acct_count,
        emi_records_deleted=emi_count,
        uploads_deleted=upl_count,
        rules_preserved=rule_count,
    )

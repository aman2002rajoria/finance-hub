"""EMI plans on top of existing transactions.

Model
-----
We do *not* materialise a row per instalment. Instead an ``emi_records``
row stores the plan (``tenure_months``, ``monthly_amount``,
``start_date``) attached to a single "original" transaction with
``is_emi=True``. The analytics engine queries this table and projects
the synthetic monthly instalments at read time.

Why? Because (a) the parser already wrote the lump-sum row, (b) editing
the user-visible ledger to "delete the lump and insert 12 splits" is
destructive and confusing, and (c) the projection is trivially cheap
at the volumes we deal with.

The user can convert *any* debit transaction (savings or CC) into an
EMI. The analytics service excludes the lump-sum and uses the monthly
projection from ``start_date`` instead.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import EMIRecord, Transaction


@dataclass
class EMIInstalment:
    """One projected monthly instalment."""
    period: str          # 'YYYY-MM'
    amount: float
    emi_id: int
    original_transaction_id: str


def _add_months(d: date, months: int) -> date:
    """Add ``months`` calendar months to ``d`` clamping to month end."""
    m_total = (d.month - 1) + months
    year    = d.year + m_total // 12
    month   = m_total % 12 + 1
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(d.day, last_day))


class EMIService:
    def __init__(self, session: Session) -> None:
        self.s = session

    # ------------------------------------------------------------------
    # Convert a transaction to an EMI plan
    # ------------------------------------------------------------------

    def convert_to_emi(
        self,
        txn_id: str,
        tenure_months: int,
        start_date: Optional[date] = None,
        note: Optional[str] = None,
    ) -> EMIRecord:
        """Attach an EMI plan to ``txn_id`` (must be a debit).

        The monthly amount is ``round(total/tenure, 2)``; small rounding
        residual is absorbed in the last instalment via the analytics
        projection.
        """
        if tenure_months < 2:
            raise ValueError("tenure_months must be >= 2")

        t = self.s.get(Transaction, txn_id)
        if t is None:
            raise ValueError(f"transaction {txn_id} not found")
        if t.type != "debit":
            raise ValueError("only debit transactions can be EMI-converted")

        start = start_date or t.date
        monthly = round(t.amount / tenure_months, 2)

        existing = self.s.scalar(
            select(EMIRecord).where(EMIRecord.original_transaction_id == txn_id)
        )
        if existing:
            existing.total_amount   = t.amount
            existing.tenure_months  = tenure_months
            existing.monthly_amount = monthly
            existing.start_date     = start
            existing.note           = note
            emi = existing
        else:
            emi = EMIRecord(
                original_transaction_id=txn_id,
                total_amount=t.amount,
                tenure_months=tenure_months,
                monthly_amount=monthly,
                start_date=start,
                note=note,
            )
            self.s.add(emi)
            self.s.flush()
        t.is_emi = True
        t.emi_id = emi.id
        self.s.commit()
        return emi

    def remove_emi(self, txn_id: str) -> bool:
        emi = self.s.scalar(
            select(EMIRecord).where(EMIRecord.original_transaction_id == txn_id)
        )
        if not emi:
            return False
        t = self.s.get(Transaction, txn_id)
        if t:
            t.is_emi = False
            t.emi_id = None
        self.s.delete(emi)
        self.s.commit()
        return True

    def list_emis(self) -> List[EMIRecord]:
        return list(self.s.scalars(
            select(EMIRecord).order_by(EMIRecord.start_date.desc())
        ))

    # ------------------------------------------------------------------
    # Instalment projection (used by analytics)
    # ------------------------------------------------------------------

    @staticmethod
    def project_instalments(emi: EMIRecord) -> List[EMIInstalment]:
        """Expand an EMI plan into per-month instalments.

        The first instalment lands in ``start_date``'s month; subsequent
        ones in successive calendar months. The last instalment absorbs
        the rounding residual so the sum exactly equals ``total_amount``.
        """
        out: List[EMIInstalment] = []
        running = 0.0
        for i in range(emi.tenure_months):
            d = _add_months(emi.start_date, i)
            if i == emi.tenure_months - 1:
                amount = round(emi.total_amount - running, 2)
            else:
                amount = emi.monthly_amount
                running += amount
            out.append(EMIInstalment(
                period=f"{d.year:04d}-{d.month:02d}",
                amount=amount,
                emi_id=emi.id,
                original_transaction_id=emi.original_transaction_id,
            ))
        return out

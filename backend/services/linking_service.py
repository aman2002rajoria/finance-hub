"""Double-counting prevention.

We have TWO independent flags:

* ``is_credit_card_payment`` — a savings-account debit whose purpose is
  paying a credit-card bill. The matching CC-side credit lands on the
  ``credit_card`` account (and is automatically excluded from spend
  because it's a *credit*, not a debit).

* ``is_internal_transfer`` — a savings ↔ savings move where the same
  amount appears once as a debit on account A and once as a credit on
  account B within a tight time window. Both legs are flagged.

A single transaction can hold both flags in theory but in practice CC
payments are tagged with the first flag and *not* the second.
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from db.models import (
    ACCOUNT_TYPE_CREDIT_CARD, ACCOUNT_TYPE_SAVINGS,
    TXN_TYPE_CREDIT, TXN_TYPE_DEBIT, CCBillLink, Transaction,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CC payment description heuristics
# ---------------------------------------------------------------------------

_CC_PAYMENT_PATTERNS: List[re.Pattern] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bsbi\s*card(s)?\b",
        r"\bcredit\s*card\s*pay(ment)?\b",
        r"\bcard\s*bill\b",
        r"\bcc\s*pay(ment)?\b",
        r"\bccpay\b",
        r"\bbillpay\s*-\s*sbic\b",
        r"\bslicepay\b",
        r"\bslicepe\b",
        # SBI Card SI debit on savings
        r"\bsbic\b.*\bpay\b",
        r"\bslice\b.*\b(payment|bill|cc)\b",
        r"\b(payment|bill)\b.*\bslice\b",
    ]
]


def description_looks_like_cc_payment(description: Optional[str]) -> bool:
    if not description:
        return False
    return any(p.search(description) for p in _CC_PAYMENT_PATTERNS)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class LinkingService:
    """Detect + link CC payments and savings↔savings internal transfers."""

    # Match window defaults
    AMOUNT_TOLERANCE = 1.0    # rupees
    DAY_WINDOW       = 5      # days between leg A and leg B

    def __init__(self, session: Session) -> None:
        self.s = session

    # ------------------------------------------------------------------
    # 1. CC-payment flagging on freshly-parsed dicts (pre-insert)
    # ------------------------------------------------------------------

    def flag_cc_payments_in_dicts(self, rows: List[dict]) -> int:
        """Set ``is_credit_card_payment`` on dicts before they hit the DB.

        We only flag savings-side debits — the CC-side credit is a
        *receipt* on the card and is excluded from spend automatically
        by being a credit.
        """
        n = 0
        for r in rows:
            if r.get("account_type") != ACCOUNT_TYPE_SAVINGS:
                continue
            if r.get("type") != TXN_TYPE_DEBIT:
                continue
            if description_looks_like_cc_payment(r.get("description")):
                r["is_credit_card_payment"] = True
                n += 1
        return n

    # ------------------------------------------------------------------
    # 2. Re-link existing DB rows (idempotent)
    # ------------------------------------------------------------------

    def link_cc_payments(
        self,
        amount_tolerance: float = AMOUNT_TOLERANCE,
        day_window: int = DAY_WINDOW,
    ) -> int:
        """Match each unlinked savings CC-payment debit to its CC-side credit."""
        # Pull unlinked savings rows flagged as CC payments
        savings = list(self.s.scalars(
            select(Transaction)
            .where(
                Transaction.is_credit_card_payment.is_(True),
                Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
                Transaction.linked_transaction_id.is_(None),
            )
            .order_by(Transaction.date)
        ))
        if not savings:
            return 0

        # And all CC-side credits that aren't already targeted by a link
        cc_credits = list(self.s.scalars(
            select(Transaction)
            .where(
                Transaction.account_type == ACCOUNT_TYPE_CREDIT_CARD,
                Transaction.type == TXN_TYPE_CREDIT,
            )
            .order_by(Transaction.date)
        ))
        if not cc_credits:
            return 0

        # Build a list of already-linked CC ids so we don't double-claim
        already_linked = {
            r for r in self.s.scalars(
                select(Transaction.linked_transaction_id)
                .where(Transaction.linked_transaction_id.is_not(None))
            )
        }
        cc_pool: List[Transaction] = [c for c in cc_credits if c.id not in already_linked]

        used: set = set()
        links = 0
        for s in savings:
            best: Optional[Tuple[Transaction, int]] = None
            for c in cc_pool:
                if c.id in used:
                    continue
                if abs(c.amount - s.amount) > amount_tolerance:
                    continue
                day_diff = abs((c.date - s.date).days)
                if day_diff > day_window:
                    continue
                if best is None or day_diff < best[1]:
                    best = (c, day_diff)
            if best:
                s.linked_transaction_id = best[0].id
                used.add(best[0].id)
                links += 1
        self.s.commit()
        return links

    # ------------------------------------------------------------------
    # 3. Internal savings ↔ savings transfers
    # ------------------------------------------------------------------

    def detect_internal_transfers(
        self,
        amount_tolerance: float = AMOUNT_TOLERANCE,
        day_window: int = DAY_WINDOW,
    ) -> int:
        """Tag savings↔savings pairs (equal amount, opposite direction).

        Returns the number of *pairs* tagged (so total flagged rows = 2× this).
        Both legs get ``is_internal_transfer = True`` and each one's
        ``linked_transaction_id`` is set to the other.
        """
        debits = list(self.s.scalars(
            select(Transaction)
            .where(
                Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
                Transaction.type == TXN_TYPE_DEBIT,
                Transaction.is_credit_card_payment.is_(False),  # don't double-tag CC payments
                Transaction.is_internal_transfer.is_(False),
            )
            .order_by(Transaction.date)
        ))
        credits = list(self.s.scalars(
            select(Transaction)
            .where(
                Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
                Transaction.type == TXN_TYPE_CREDIT,
                Transaction.is_internal_transfer.is_(False),
            )
            .order_by(Transaction.date)
        ))
        if not debits or not credits:
            return 0

        used_credits: set = set()
        pairs = 0
        for d in debits:
            best: Optional[Tuple[Transaction, int]] = None
            for c in credits:
                if c.id in used_credits:
                    continue
                if c.account_name == d.account_name:
                    # Same account → not a transfer between accounts.
                    continue
                if abs(c.amount - d.amount) > amount_tolerance:
                    continue
                day_diff = abs((c.date - d.date).days)
                if day_diff > day_window:
                    continue
                if best is None or day_diff < best[1]:
                    best = (c, day_diff)
            if best:
                c = best[0]
                d.is_internal_transfer = True
                c.is_internal_transfer = True
                d.linked_transaction_id = c.id
                c.linked_transaction_id = d.id
                used_credits.add(c.id)
                pairs += 1
        self.s.commit()
        return pairs

    # ------------------------------------------------------------------
    # 4. Toggle helpers used by the UI
    # ------------------------------------------------------------------

    def toggle_cc_payment(self, txn_id: str, value: bool) -> int:
        return self._toggle_flag(txn_id, "is_credit_card_payment", value)

    def toggle_internal_transfer(self, txn_id: str, value: bool) -> int:
        return self._toggle_flag(txn_id, "is_internal_transfer", value)

    def _toggle_flag(self, txn_id: str, attr: str, value: bool) -> int:
        t = self.s.get(Transaction, txn_id)
        if not t:
            return 0
        setattr(t, attr, value)
        if not value and attr == "is_internal_transfer":
            # Also break the other leg's mirror flag, if any.
            if t.linked_transaction_id:
                other = self.s.get(Transaction, t.linked_transaction_id)
                if other is not None:
                    other.is_internal_transfer = False
                    other.linked_transaction_id = None
                t.linked_transaction_id = None
        self.s.commit()
        return 1

    # ------------------------------------------------------------------
    # 5. Manual internal-transfer linking (UI fallback when auto-detect
    #    misses the pair — slightly different amounts, >5-day gap, etc.)
    # ------------------------------------------------------------------

    def find_transfer_candidates(
        self,
        txn_id: str,
        amount_tolerance: float = 10.0,
        day_window: int = 7,
    ) -> List[Transaction]:
        """Return possible counter-legs for a savings ↔ savings transfer.

        Looser than the auto-detector on purpose: this is the human's
        fallback when the strict matcher misses (e.g. an IMPS fee of ₹2
        broke the equality check). We sort by closeness on (amount, days)
        so the obvious match is first.
        """
        t = self.s.get(Transaction, txn_id)
        if t is None:
            return []
        opposite = TXN_TYPE_CREDIT if t.type == TXN_TYPE_DEBIT else TXN_TYPE_DEBIT
        candidates = list(self.s.scalars(
            select(Transaction).where(
                Transaction.id != t.id,
                Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
                Transaction.account_name != t.account_name,
                Transaction.type == opposite,
                Transaction.is_internal_transfer.is_(False),
            )
        ))
        scored: List[Tuple[Transaction, float, int]] = []
        for c in candidates:
            amt_diff = abs(c.amount - t.amount)
            day_diff = abs((c.date - t.date).days)
            if amt_diff > amount_tolerance or day_diff > day_window:
                continue
            scored.append((c, amt_diff, day_diff))
        # Sort by (days, amount-diff) so the cleanest match wins.
        scored.sort(key=lambda r: (r[2], r[1]))
        return [c for c, _, _ in scored]

    def link_internal_transfer(self, txn_id: str, partner_id: str) -> bool:
        """User-confirmed internal-transfer pairing. Flags both legs."""
        a = self.s.get(Transaction, txn_id)
        b = self.s.get(Transaction, partner_id)
        if a is None or b is None:
            return False
        if a.id == b.id:
            return False
        # Break any previous links these two might have held.
        for x in (a, b):
            if x.linked_transaction_id and x.linked_transaction_id not in (a.id, b.id):
                old = self.s.get(Transaction, x.linked_transaction_id)
                if old is not None:
                    old.is_internal_transfer = False
                    old.linked_transaction_id = None
        a.is_internal_transfer = True
        b.is_internal_transfer = True
        a.linked_transaction_id = b.id
        b.linked_transaction_id = a.id
        self.s.commit()
        return True

    # ------------------------------------------------------------------
    # 6. Manual credit-card bill mapping
    # ------------------------------------------------------------------

    def find_cc_payment_candidates(
        self,
        txn_id: str,
        amount_tolerance: float = 50.0,
    ) -> List[dict]:
        """Suggest ``{cc_account_name, billing_month, total_amount}`` rows
        that this savings debit might have settled.

        We sum CC-side debits per (account, month) and rank by closeness
        to the savings debit amount. The user picks one in the UI.
        """
        t = self.s.get(Transaction, txn_id)
        if t is None or t.type != TXN_TYPE_DEBIT or t.account_type != ACCOUNT_TYPE_SAVINGS:
            return []
        rows = self.s.execute(
            select(
                Transaction.account_name,
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.sum(Transaction.amount),
            )
            .where(
                Transaction.account_type == ACCOUNT_TYPE_CREDIT_CARD,
                Transaction.type == TXN_TYPE_DEBIT,
            )
            .group_by(Transaction.account_name, "period")
        ).all()
        scored: List[Tuple[dict, float]] = []
        for an, period, total in rows:
            total = float(total or 0.0)
            diff = abs(total - t.amount)
            if diff > max(amount_tolerance, t.amount * 0.05):
                continue
            scored.append((
                {"cc_account_name": an, "billing_month": period, "total_amount": round(total, 2)},
                diff,
            ))
        scored.sort(key=lambda r: r[1])
        return [x for x, _ in scored]

    def mark_cc_bill_payment(
        self,
        txn_id: str,
        cc_account_name: str,
        billing_month: str,
    ) -> Optional[CCBillLink]:
        """Mark a savings debit as a CC bill payment + record the mapping.

        Side effects:
          * sets ``is_credit_card_payment = True`` on the savings row
          * upserts a ``cc_bill_links`` row capturing the attribution
          * computes ``total_amount`` from the matching CC statement so
            the reconciliation view doesn't have to recompute on the fly
        """
        t = self.s.get(Transaction, txn_id)
        if t is None:
            return None

        # Compute the CC-side total for the period so reconciliation is
        # cheap. If there are no CC rows in that month, we fall back to
        # the savings-side amount — better than 0.
        cc_total = self.s.scalar(
            select(func.coalesce(func.sum(Transaction.amount), 0.0))
            .where(
                Transaction.account_name == cc_account_name,
                Transaction.account_type == ACCOUNT_TYPE_CREDIT_CARD,
                Transaction.type == TXN_TYPE_DEBIT,
                func.strftime("%Y-%m", Transaction.date) == billing_month,
            )
        ) or 0.0
        cc_total = float(cc_total) or float(t.amount)

        # Upsert.
        existing = self.s.scalar(
            select(CCBillLink).where(CCBillLink.savings_txn_id == txn_id)
        )
        if existing:
            existing.cc_account_name = cc_account_name
            existing.billing_month   = billing_month
            existing.total_amount    = cc_total
            link = existing
        else:
            link = CCBillLink(
                savings_txn_id=txn_id,
                cc_account_name=cc_account_name,
                billing_month=billing_month,
                total_amount=cc_total,
            )
            self.s.add(link)

        t.is_credit_card_payment = True
        # If this savings debit was previously flagged as an internal
        # transfer, unflag it — a row can't be both.
        if t.is_internal_transfer:
            t.is_internal_transfer = False
            if t.linked_transaction_id:
                other = self.s.get(Transaction, t.linked_transaction_id)
                if other:
                    other.is_internal_transfer = False
                    other.linked_transaction_id = None
                t.linked_transaction_id = None

        self.s.commit()
        return link

    def unlink_cc_bill_payment(self, txn_id: str) -> bool:
        """Reverse of :meth:`mark_cc_bill_payment`."""
        existing = self.s.scalar(
            select(CCBillLink).where(CCBillLink.savings_txn_id == txn_id)
        )
        if existing:
            self.s.delete(existing)
        t = self.s.get(Transaction, txn_id)
        if t is not None:
            t.is_credit_card_payment = False
        self.s.commit()
        return True

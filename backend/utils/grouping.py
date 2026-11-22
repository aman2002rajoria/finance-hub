"""Counterparty grouping — deterministic VPA vs merchant resolution.

Problem
-------
Many UPI rows store a *bank PSP handle* (``paytm@icici``, ``foo@axisbank``)
rather than a merchant-specific VPA. Grouping by these handles merges
unrelated payments into one bucket.

Strategy (Option 2 + Option 1 fallback)
---------------------------------------
1. **High confidence** — usable VPA (not a bank handle) → group by VPA.
2. **Medium confidence** — merchant/counterparty when VPA absent OR VPA is
   a bank handle → group by ``merchant_name``.
3. **Low confidence** — no VPA and no merchant → ``unmatched`` bucket.

See ``docs/CATEGORIZATION.md`` for rationale.

Used by
-------
* ``api/routes_transactions.py`` — ``GET /counterparties``
* ``services/analytics_service.py`` — coverage metrics
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

from sqlalchemy import ColumnElement, func, or_

from db.models import Transaction

# UPI domains that are payment rails, not merchants (lowercase).
_BANK_VPA_DOMAINS = frozenset({
    "axisbank", "axl", "ibl", "icici", "hdfcbank", "okhdfcbank", "okaxis",
    "okicici", "oksbi", "sbi", "ybl", "paytm", "ptyes", "kmbl",
    "cnrb", "barodampay", "aubank", "fbl", "indus", "rbl", "idbi",
    "unionbank", "centralbank", "pnb", "yesbank", "kotak", "jupiteraxis",
    "okbizaxis", "abfspay", "rapl", "waicici", "waaxis", "wahdfcbank",
})

# Handle prefixes that are never merchant identifiers (before @).
_BANK_HANDLE_PREFIXES = frozenset({
    "axisbank", "icici", "hdfcbank", "hdfcbankltd", "sbi", "paytm",
    "phonepe", "gpay", "googlepay", "bharatpe",
})

_VPA_RE = re.compile(r"^[^@\s]+@[^@\s]+$", re.IGNORECASE)


def is_bank_handle_vpa(vpa: Optional[str]) -> bool:
    """Return True when ``vpa`` is a PSP/bank rail, not a merchant handle."""
    if not vpa:
        return False
    v = vpa.strip().lower()
    if "@" not in v:
        return v in _BANK_HANDLE_PREFIXES
    handle, domain = v.rsplit("@", 1)
    if domain in _BANK_VPA_DOMAINS:
        return True
    if handle in _BANK_HANDLE_PREFIXES:
        return True
    # Domains ending in bank names, e.g. @okaxis is axis rail
    for token in ("axis", "icici", "hdfc", "sbi", "yesbank"):
        if token in domain and len(domain) < 20:
            return True
    return False


def is_usable_vpa(vpa: Optional[str]) -> bool:
    """True VPA suitable for merchant-level grouping."""
    if not vpa or not _VPA_RE.match(vpa.strip()):
        return False
    return not is_bank_handle_vpa(vpa)


def resolve_group_key(
    vpa: Optional[str],
    merchant_name: Optional[str],
) -> Tuple[str, str, str]:
    """Return ``(kind, key, label)`` for grouping one transaction.

    * kind — ``vpa`` | ``merchant`` | ``unmatched``
    * key  — stable id e.g. ``vpa:swiggy@upi``
    * label — display string
    """
    if is_usable_vpa(vpa):
        label = vpa.strip().lower()
        return "vpa", f"vpa:{label}", label
    m = (merchant_name or "").strip()
    if m:
        return "merchant", f"merchant:{m.lower()}", m
    return "unmatched", "unmatched", "(no VPA / merchant)"


def bank_handle_vpa_sql(col=Transaction.vpa) -> ColumnElement[bool]:
    """SQL OR-clause: ``vpa`` matches a known bank/PSP handle pattern."""
    v = func.lower(col)
    domain_clauses = [v.like(f"%@{d}") for d in sorted(_BANK_VPA_DOMAINS)]
    prefix_clauses = [v.like(f"{p}@%") for p in sorted(_BANK_HANDLE_PREFIXES)]
    return or_(*domain_clauses, *prefix_clauses)


def usable_vpa_sql(col=Transaction.vpa) -> ColumnElement[bool]:
    """SQL: VPA present and not a bank handle."""
    return col.isnot(None) & ~bank_handle_vpa_sql(col)

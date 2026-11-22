"""Deterministic IDs for transactions and uploaded files.

Why deterministic? The same PDF re-uploaded produces identical rows;
hashing the canonical fields means we can use ``INSERT OR IGNORE`` for
dedup with no extra bookkeeping.
"""

from __future__ import annotations

import hashlib
from typing import Optional


def _normalise(value: Optional[str]) -> str:
    """Trim + lower-case + collapse whitespace.

    Two descriptions differing only in case or whitespace must produce
    the same ID so PDF re-renders don't fragment our deduplication.
    """
    if value is None:
        return ""
    return " ".join(str(value).strip().lower().split())


def deterministic_txn_id(
    date_iso: str,
    amount: float,
    description: str,
    account_name: str,
    occurrence: int = 0,
) -> str:
    """16-char SHA-1 hex digest — collision-safe at personal-ledger scale.

    Truncated to 16 hex chars = 64 bits = ~1.8×10^19 distinct buckets.

    ``occurrence`` disambiguates two genuine same-day / same-amount /
    same-description rows inside one statement. Default ``0`` keeps the
    historical fingerprint stable so existing DB rows still match.
    """
    seed = "|".join([
        _normalise(date_iso),
        f"{round(float(amount), 2):.2f}",
        _normalise(description),
        _normalise(account_name),
    ])
    if occurrence:
        seed = f"{seed}|{int(occurrence)}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


# Synthetic refs are description-derived hashes — useful within a file,
# but not a bank-issued identity. Strong-ref dedupe ignores these.
_SYNTHETIC_REF_PREFIXES = ("CC-", "SBICC-", "HASH-")


def is_real_bank_reference(reference_id: Optional[str]) -> bool:
    """True when ``reference_id`` looks like a bank-issued identity.

    Rejects synthetic parser hashes and trivial placeholders like ``0``
    that Canara prints on some NEFT/interest rows (not unique).
    """
    if not reference_id:
        return False
    ref = str(reference_id).strip()
    if not ref or ref in {"0", "000000"}:
        return False
    if any(ref.startswith(p) for p in _SYNTHETIC_REF_PREFIXES):
        return False
    # UPI/NEFT/Chq refs are long enough; short tokens are too collision-prone
    # for account-scoped uniqueness without date/amount.
    return len(ref) >= 6


def file_sha256(file_bytes: bytes) -> str:
    """Full SHA-256 of a file's contents.

    Used to short-circuit re-uploads of the same PDF.
    """
    return hashlib.sha256(file_bytes).hexdigest()

"""Bank-agnostic regex primitives shared by every concrete parser.

Why a separate module?
----------------------
The SBI parser owns its own (positional) regex set inside ``helpers.py``
because those are tightly coupled to its column-layout assumptions. Slice
(and any future bank) is purely *text-based*, so it needs a small set of
generic patterns that recognise:

* dates in several common Indian formats,
* rupee-prefixed amounts (with or without a sign),
* long numeric reference numbers,
* the IFSC / VPA / phone fragments that appear inside descriptions.

Keeping these here lets the Slice parser stay readable and prevents
copy-pasted regex drift across files.
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# DATE patterns
# ---------------------------------------------------------------------------

# Slice format: ``01 Aug '25`` or ``9 Apr '26`` — i.e. ``D[D] Mon 'YY``.
# Anchored at start of string with a hard word-boundary on the year so we
# don't match e.g. ``01 Aug '255``. Day part allows 1 OR 2 digits so it
# matches both the zero-padded savings statements (``01 Aug``) and the
# unpadded credit-card statements (``9 Apr``).
SLICE_DATE_REGEX = re.compile(
    r"^(\d{1,2})\s+([A-Za-z]{3})\s+'(\d{2})\b"
)

# SBI / generic fallback: ``DD-MM-YY``, ``DD/MM/YYYY`` etc.
GENERIC_DATE_REGEX = re.compile(
    r"\b(\d{1,2}[-/](?:[A-Za-z]{3,9}|\d{1,2})[-/]\d{2,4})\b"
)

# Canara format: ``DD-MM-YYYY`` (always 4-digit year, dash-separated). The
# parser uses this *anchored at start of line* to find the date column of
# the multi-line transaction block.
CANARA_DATE_REGEX = re.compile(r"^(\d{2})-(\d{2})-(\d{4})\b")

# A comma-formatted Indian-style decimal amount, e.g. ``1,84,120.50`` or
# ``25,000.00`` or ``8,000.00``. Canara always prints with exactly 2
# decimal places — we anchor on ``\.\d{2}`` so we don't accidentally
# capture year-like tokens (``2025``) as amounts.
INR_AMOUNT_REGEX = re.compile(r"-?\d{1,3}(?:,\d{2,3})*\.\d{2}")

# Month-name → number (case-insensitive). Three-letter abbreviations only;
# the Slice statements never use full month names.
MONTH_NUM = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


# ---------------------------------------------------------------------------
# AMOUNT patterns
# ---------------------------------------------------------------------------

# Match a rupee-prefixed amount with an *optional* leading minus sign.
# Captures: (sign?, amount-with-commas-and-decimals).
# Examples matched:
#   "₹0.08"   -> sign='', value='0.08'
#   "₹500"    -> sign='', value='500'
#   "₹1,000"  -> sign='', value='1,000'
#   "-₹210"   -> sign='-', value='210'
#   "-₹2,345.67" -> sign='-', value='2,345.67'
RUPEE_AMOUNT_REGEX = re.compile(
    r"(-)?\s*₹\s*([0-9][0-9,]*(?:\.\d{1,2})?)"
)

# Pure number (no currency symbol). Used to count "ends with N numbers" in
# the SBI text-accumulation fallback; Slice always has ₹ so it isn't used
# there, but keeping it here means both parsers share one definition.
PLAIN_NUMBER_REGEX = re.compile(r"-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?")


# ---------------------------------------------------------------------------
# REFERENCE / VPA / PHONE patterns
# ---------------------------------------------------------------------------

# Long numeric reference. Slice references are 12-15 digits, SBI UPI refs
# are typically 10-12. We require 10+ to avoid accidentally matching short
# numbers embedded in descriptions (e.g. "31-Jul-2025" wouldn't match).
REFERENCE_NUM_REGEX = re.compile(r"\d{10,}")

# Virtual Payment Address (UPI handle) — ``handle@provider``.
VPA_REGEX = re.compile(r"[A-Za-z0-9._\-]+@[A-Za-z0-9._\-]+")

# IFSC code — 4 letters + 0 + 6 alphanumerics (RBI standard).
IFSC_REGEX = re.compile(r"\b([A-Z]{4}0[A-Z0-9]{6})\b")

# Indian mobile number (10 digits starting with 6-9). Used only for the
# structured-decomposition step, never for transaction boundary detection.
PHONE_REGEX = re.compile(r"\b([6-9]\d{9})\b")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def find_rupee_amounts(text: str) -> List[Tuple[int, int, float, bool]]:
    """Return every rupee-amount in ``text`` as ``(start, end, value, is_negative)``.

    The returned list is in left-to-right order. Commas are stripped before
    conversion. A leading ``-`` (with optional whitespace) marks the amount
    as negative — Slice uses this for debits (``-₹210``).
    """
    out: List[Tuple[int, int, float, bool]] = []
    for m in RUPEE_AMOUNT_REGEX.finditer(text):
        sign, val = m.group(1), m.group(2)
        try:
            num = float(val.replace(",", ""))
        except ValueError:
            continue
        out.append((m.start(), m.end(), num, sign == "-"))
    return out


def slice_date_to_iso(day: str, mon: str, yy: str) -> Optional[str]:
    """Convert ``("01", "Aug", "25")`` -> ``"2025-08-01"`` (or ``None``).

    Assumes 21st-century dates (``'25`` → 2025). Slice was founded post-2019
    so this is safe for the lifetime of the product.
    """
    month_num = MONTH_NUM.get(mon.lower())
    if month_num is None:
        return None
    try:
        d = int(day)
        y = 2000 + int(yy)
    except ValueError:
        return None
    if not (1 <= d <= 31 and 1 <= month_num <= 12):
        return None
    return f"{y:04d}-{month_num:02d}-{d:02d}"


def line_starts_with_slice_date(line: str) -> bool:
    """``True`` iff ``line`` begins with a Slice-format transaction date."""
    return bool(SLICE_DATE_REGEX.match(line.lstrip()))


def line_starts_with_canara_date(line: str) -> bool:
    """``True`` iff ``line`` begins with a Canara-format date (``DD-MM-YYYY``)."""
    return bool(CANARA_DATE_REGEX.match(line.lstrip()))


def canara_date_to_iso(day: str, month: str, year: str) -> Optional[str]:
    """Convert ``("18", "06", "2025")`` -> ``"2025-06-18"`` (or ``None``)."""
    try:
        d, m, y = int(day), int(month), int(year)
    except (TypeError, ValueError):
        return None
    if not (1 <= d <= 31 and 1 <= m <= 12 and 1900 <= y <= 2999):
        return None
    return f"{y:04d}-{m:02d}-{d:02d}"


def find_inr_amounts(text: str) -> List[Tuple[int, int, float]]:
    """Return every Indian-formatted decimal amount in ``text``.

    Each item is ``(start, end, value)`` in left-to-right order. Used by
    the Canara parser to slice the date-anchor line into (amount, balance)
    from the right, regardless of how many description tokens precede
    them.
    """
    out: List[Tuple[int, int, float]] = []
    for m in INR_AMOUNT_REGEX.finditer(text):
        try:
            num = float(m.group(0).replace(",", ""))
        except ValueError:
            continue
        out.append((m.start(), m.end(), num))
    return out
